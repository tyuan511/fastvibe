// SPDX-License-Identifier: MIT
// Receipt ordering adapted from deepseek-ai/dsh-superagent-prototype; see ../core/NOTICE.md.
import type { ChannelRef } from "../core/model.ts";
import type { OutboundMessage } from "../core/ports.ts";
import { ownedEffect } from "./claims.ts";
import { effectRequestId, FAILURES_BEFORE_ERROR, Later, Uncertain, type EffectContext, type ShadowEffects } from "./effects.ts";
import { createShadowPorts } from "./ports.ts";
import type { EffectRecord, Receipt, ShadowStore } from "./store.ts";

export interface ShadowMessageSource {
  enabled(channel: ChannelRef): boolean;
  allowed(channel: ChannelRef): boolean;
  /** An opaque exception must be Uncertain; ordinary errors assert that sending did not happen. */
  send(message: OutboundMessage, context: EffectContext): Promise<"sent" | "gone" | "waiting">;
}
export type MessageResolution = "sent" | "gone" | "not-sent" | "unknown";
const deliveryKey = (requestId: string): string => `shadow:outbox:attempt:${requestId}`;
const messageIdentity = (message: OutboundMessage): string => JSON.stringify([
  message.id, message.ticketId ?? null, message.kind, message.text, message.channel.source, message.channel.thread,
  Object.entries(message.channel.address).sort(([a], [b]) => a.localeCompare(b)),
]);

/** Pending messages are durable; unresolved sends never become ordinary retries. */
export class ShadowOutbox {
  private readonly store: ShadowStore;
  private readonly effects: ShadowEffects;
  private readonly now: () => number;
  private readonly port: ReturnType<typeof createShadowPorts>["outbox"];
  constructor(store: ShadowStore, effects: ShadowEffects, source: ShadowMessageSource, options: { now?: () => number; paused?: () => boolean } = {}) {
    this.store = store; this.effects = effects; this.now = options.now ?? Date.now;
    this.port = createShadowPorts(store, this.now, () => effects.kick()).outbox;
    effects.handle("reply", async context => {
      const prepared = store.atomic(() => {
        if (!ownedEffect(store, context.claim, this.now())) return;
        if (options.paused?.()) throw new Later("Message processing is paused or not configured");
        const message = store.receipts.get(context.claim.key);
        if (!message || message.status !== "pending") return;
        if (store.get<boolean>(`shadow:withdraw:${message.id}`)) return { message, drop: "withdrawn" as const };
        if (!source.enabled(message.channel)) throw new Later("Source is disabled or missing");
        if (this.behind(message)) throw new Later("An earlier message of this Ticket and conversation is waiting");
        if (!source.allowed(message.channel)) return { message, drop: "channelIgnored" as const };
        store.set(deliveryKey(context.requestId), { claim: context.claim, message });
        return { message };
      });
      if (!prepared) return () => false;
      if (prepared.drop) return () => store.receipts.settle(prepared.message.id, "dropped", { at: new Date(this.now()).toISOString(), reason: prepared.drop! });
      const result = await source.send(structuredClone(prepared.message), context);
      if (result === "waiting") throw new Later("Source is temporarily unavailable");
      if (result !== "sent" && result !== "gone") throw new Uncertain("Invalid Source send result after dispatch");
      return () => store.receipts.settle(prepared.message.id, result === "sent" ? "sent" : "dropped",
        result === "gone" ? { at: new Date(this.now()).toISOString(), reason: "channelGone" } : undefined);
    }, { limit: () => options.paused?.() ? 0 : 1, retry: [5000, 300_000] });
  }
  send(message: OutboundMessage): void { this.port.send(message); }
  status(id: string) { return this.port.status(id); }
  withdraw(id: string): void { this.port.withdraw(id); }
  sent(): Promise<void> { return this.effects.idle("reply"); }
  private behind(message: Receipt): boolean {
    for (const earlier of this.store.receipts.waiting()) {
      if (earlier.id === message.id) return false;
      if (earlier.ticketId === message.ticketId && earlier.channel.source === message.channel.source
        && earlier.channel.thread === message.channel.thread) {
        const effect = this.store.effects.get("reply", earlier.id);
        if (effect?.status === "running" || effect?.status === "uncertain"
          || this.effects.failures("reply", earlier.id) < FAILURES_BEFORE_ERROR) return true;
      }
    }
    return false;
  }
  /** Caller supplies an explicit inspected fact. This method itself never sends or guesses. */
  reconcile(expected: EffectRecord, result: MessageResolution): boolean {
    if (result === "unknown") return false;
    if (!["sent", "gone", "not-sent"].includes(result)) throw new Error("Invalid message reconciliation");
    return this.store.atomic(() => {
      const current = this.store.effects.get("reply", expected.key);
      if (expected.kind !== "reply" || expected.status !== "uncertain" || current?.status !== "uncertain"
        || current.seq !== expected.seq || current.generation !== expected.generation || current.claimToken !== expected.claimToken
        || current.claimedGeneration !== expected.claimedGeneration) return false;
      const attempt = this.effects.attempt(current); if (!attempt) return false;
      const requestId = effectRequestId(attempt);
      const record = this.store.get<{ claim: EffectRecord; message: Receipt }>(deliveryKey(requestId));
      const receipt = this.store.receipts.get(expected.key);
      // An abort before source dispatch has no delivery snapshot and needs explicit not-sent evidence.
      if (!receipt || (record && messageIdentity(record.message) !== messageIdentity(receipt))) return false;
      if (!record && result !== "not-sent") return false;
      let outcome: "retry" | "done" | "cancelled" = result === "not-sent" ? "retry" : "done";
      if (receipt.status === "pending") {
        if (result === "sent") this.store.receipts.settle(receipt.id, "sent");
        if (result === "gone") this.store.receipts.settle(receipt.id, "dropped", { at: new Date(this.now()).toISOString(), reason: "channelGone" });
        if (result === "not-sent" && this.store.get<boolean>(`shadow:withdraw:${receipt.id}`)) {
          this.store.receipts.settle(receipt.id, "dropped", { at: new Date(this.now()).toISOString(), reason: "withdrawn" });
          outcome = "cancelled";
        }
      } else outcome = "done";
      if (!this.effects.reconcile(current, outcome)) throw new Error("Message reconciliation ownership changed");
      return true;
    });
  }
}
