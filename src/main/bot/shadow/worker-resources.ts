// SPDX-License-Identifier: MIT
// M6 background resource lifecycle; adapters are explicit fake/sandbox ports.
import { randomUUID } from "node:crypto";
import type { WorkerToken } from "./engine.ts";
import { WorkerSlots, type SlotReservation } from "./worker-slots.ts";
import type { ShadowStore } from "./store.ts";

export type ResourceKind = "job" | "subagent";
export type ResourceState = "running" | "handed-off" | "stopping" | "stopped" | "uncertain";
export interface ResourceRecord {
  id: string; ticketId: string; kind: ResourceKind; owner: string; state: ResourceState; name: string; createdAt: number; revision: number;
}
export interface ResourceAdapter {
  start(kind: ResourceKind, record: ResourceRecord, signal: AbortSignal): Promise<void>;
  stop(kind: ResourceKind, record: ResourceRecord, signal: AbortSignal): Promise<void>;
}
const key = (id: string): string => `shadow:resource:${id}`;
const sameBinding = (a: WorkerToken, b: WorkerToken): boolean => a.ticketId === b.ticketId && a.assignmentId === b.assignmentId && a.generation === b.generation && a.claimToken === b.claimToken;
const ticketKey = (ticketId: string): string => `shadow:resource-ticket:${ticketId}`;
const copy = <T>(v: T): T => structuredClone(v);

/**
 * Keeps resource ownership separate from AgentSession idle. A handed-off job is
 * collected later but does not wake the worker or retain a settling slot.
 */
export class WorkerResources {
  private readonly store: ShadowStore; private readonly slots: WorkerSlots; private readonly adapter: ResourceAdapter;
  private readonly now: () => number; private readonly owner: string; private readonly running = new Map<string, AbortController>();
  constructor(store: ShadowStore, slots: WorkerSlots, adapter: ResourceAdapter, options: { now?: () => number; owner?: string } = {}) {
    this.store = store; this.slots = slots; this.adapter = adapter; this.now = options.now ?? Date.now; this.owner = options.owner ?? randomUUID();
  }
  get(id: string): ResourceRecord | undefined { return this.store.get<ResourceRecord>(key(id)); }
  list(ticketId: string): ResourceRecord[] { return this.store.db.all<{ data: string }>("SELECT data FROM vivi_kv WHERE key LIKE 'shadow:resource:%' ORDER BY key").map(row => JSON.parse(row.data) as ResourceRecord).filter(row => row.ticketId === ticketId); }
  async start(ticketId: string, binding: WorkerToken, kind: ResourceKind, name: string, by: "launch" | "wake" | "person" = "wake"): Promise<ResourceRecord> {
    const existing = this.list(ticketId).find(r => r.kind === kind && r.name === name && ["running", "handed-off", "stopping"].includes(r.state));
    if (existing) return copy(existing);
    const slot = this.slots.reserve(ticketId, by, binding);
    const record = this.store.atomic(() => { const value: ResourceRecord = { id: randomUUID(), ticketId, kind, owner: this.owner, state: "running", name, createdAt: this.now(), revision: 1 }; this.store.set(key(value.id), value); this.store.set(ticketKey(ticketId), value.id); return value; });
    if (record.state !== "running") return copy(record);
    const controller = new AbortController(); this.running.set(record.id, controller);
    try { await this.adapter.start(kind, copy(record), controller.signal); this.slots.phase(slot, "running"); return copy(record); }
    catch (error) { this.running.delete(record.id); this.store.atomic(() => this.store.set(key(record.id), { ...record, state: "uncertain", revision: record.revision + 1 })); throw error; }
  }
  handoff(ticketId: string): ResourceRecord[] {
    return this.store.atomic(() => this.list(ticketId).filter(r => r.kind === "job" && r.state === "running").map(r => { const next = { ...r, state: "handed-off" as const, revision: r.revision + 1 }; this.store.set(key(r.id), next); return copy(next); }));
  }
  async stop(ticketId: string, binding: WorkerToken, reason = "stopped"): Promise<void> {
    const resources = this.list(ticketId).filter(r => r.state === "running" || r.state === "stopping");
    const slot = this.slots.get(ticketId);
    if (slot && (!this.slots.valid(slot) || !sameBinding(slot.binding, binding))) throw new Error("Worker slot is not owned by this binding");
    const controllers = resources.map(resource => this.stopOne(resource, reason));
    await Promise.allSettled(controllers);
    const current = this.slots.get(ticketId);
    const remaining = this.list(ticketId).some(resource => ["running", "stopping", "uncertain"].includes(resource.state));
    if (current && this.slots.valid(current) && !remaining) this.slots.release(current);
    void binding;
  }
  private async stopOne(record: ResourceRecord, reason: string): Promise<void> {
    const controller = this.running.get(record.id) ?? new AbortController();
    this.store.atomic(() => this.store.set(key(record.id), { ...record, state: "stopping", revision: record.revision + 1 }));
    try { await this.adapter.stop(record.kind, { ...record, state: "stopping" }, controller.signal); this.store.atomic(() => this.store.set(key(record.id), { ...record, state: "stopped", revision: record.revision + 2 })); }
    catch (error) { this.store.atomic(() => this.store.set(key(record.id), { ...record, state: "uncertain", revision: record.revision + 2 })); throw new Error(`${reason}: ${String(error)}`); }
    finally { this.running.delete(record.id); }
  }
  async shutdown(): Promise<void> {
    const records = this.store.db.all<{ data: string }>("SELECT data FROM vivi_kv WHERE key LIKE 'shadow:resource:%'").map(row => JSON.parse(row.data) as ResourceRecord).filter(r => ["running", "stopping"].includes(r.state));
    await Promise.allSettled(records.map(record => this.stopOne(record, "shutdown")));
    for (const slot of this.slots.records()) if (slot.phase !== "uncertain" && ["settling", "stopping", "running"].includes(slot.phase)) {
      const remaining = this.list(slot.ticketId).some(resource => ["running", "stopping", "uncertain"].includes(resource.state));
      if (!remaining && this.slots.valid(slot)) this.slots.release(slot);
    }
  }
  recover(ticketId: string): ResourceRecord[] { return this.list(ticketId).filter(r => r.state === "running" || r.state === "stopping").map(r => ({ ...r, state: "uncertain", revision: r.revision + 1 })); }
}
