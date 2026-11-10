// SPDX-License-Identifier: MIT
// Isolated, model-driven assessment for automatic Source intake. No production Runtime, IPC or
// settings references this module.
//
// Why this exists: DSH keeps semantic judgement outside the domain. Intake stores a Trigger,
// the policy gate decides whether it may be evaluated at all, and then *someone* has to read it
// and decide accept / ignore. Until now that someone was the host operator (manual `decide`) or
// a test double. This adapter makes the assessor a real model in its own isolated Session, which
// is what "automatic intake" means end to end:
//
//   Source poll -> Trigger -> policy gate -> Candidate -> this assessor -> Decision -> Ticket
//                                                                         -> launch -> Worker
//
// The model never authors identity. Ticket `title` and `scope` come from the host `describe`
// callback, so a compromised or confused assessment cannot widen the repository it acts on.
import { createHash } from "node:crypto";
import type { AgentSession, ExtensionFactory, ModelRuntime } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import type { Candidate } from "../core/ports.ts";
import type { Outcome } from "../core/evals.ts";
import { ScratchPiSession } from "./pi-session.ts";
import type { ShadowStore } from "./store.ts";

export interface ManagedPiAssessorOptions {
  store: ShadowStore;
  root: string;
  allowedRoot?: string;
  modelRuntime: ModelRuntime;
  model: NonNullable<AgentSession["model"]>;
  /** Host-derived identity for an accepted candidate; never taken from model output. */
  describe: (candidate: Candidate) => { title: string; scope: string };
  /** Applied exactly as the assessor decided; the caller owns the domain transaction. */
  decide: (triggerId: string, outcome: Outcome) => void;
  now?: () => number;
}

export interface PiAssessRecord {
  evalId: string;
  triggerId: string;
  status: "completed" | "failed" | "cancelled";
  outcome?: { kind: "accept" | "ignore" | "unavailable"; reason: string; note?: string };
}

const hash = (value: unknown): string => createHash("sha256").update(JSON.stringify(value)).digest("hex");

/** Only what the assessor is allowed to see. No tokens, no paths, no other tickets' internals. */
export function assessorInput(candidate: Candidate): Record<string, unknown> {
  return {
    evalId: candidate.evalId,
    strength: candidate.strength,
    messages: candidate.triggers.map(trigger => ({
      id: trigger.id,
      source: trigger.source,
      human: trigger.human,
      addressed: trigger.addressed ?? null,
      text: trigger.text,
      ...(trigger.url ? { url: trigger.url } : {}),
    })),
    openTicketsOnThread: candidate.tickets.filter(ticket => ticket.ended === undefined)
      .map(ticket => ({ id: ticket.id, title: ticket.title, scope: ticket.mandate.scope })),
    endedTicketsOnThread: candidate.tickets.filter(ticket => ticket.ended !== undefined)
      .map(ticket => ({ id: ticket.id, title: ticket.title, outcome: ticket.ended!.outcome })),
  };
}

const outcomeSchema = Type.Object({
  kind: Type.Union([Type.Literal("accept"), Type.Literal("ignore"), Type.Literal("unavailable")]),
  reason: Type.String({ minLength: 1 }),
  /** Optional routing note carried to the worker of an accepted candidate. */
  note: Type.Optional(Type.String({ minLength: 1 })),
}, { additionalProperties: false });

export class ManagedPiAssessor {
  private readonly options: ManagedPiAssessorOptions;
  private stopped = false;
  private readonly sessions = new Map<string, ScratchPiSession>();

  private constructor(options: ManagedPiAssessorOptions) { this.options = { ...options }; }
  static async open(options: ManagedPiAssessorOptions): Promise<ManagedPiAssessor> {
    if (typeof options.describe !== "function" || typeof options.decide !== "function") throw new Error("Assessor requires host describe and decide");
    return new ManagedPiAssessor(options);
  }

  private identity(candidate: Candidate): string { return hash(["assessor", candidate.evalId]); }

  /**
   * One evaluation. Idempotent per Eval: a second call for the same `evalId` reuses the recorded
   * outcome instead of asking the model again, so a redelivered Trigger cannot double-decide.
   */
  async assess(candidate: Candidate): Promise<PiAssessRecord> {
    if (this.stopped) throw new Error("Assessor is stopped");
    const key = this.identity(candidate);
    const existing = this.options.store.cursors.get<PiAssessRecord>("pi-assessor", "sdk", key)?.value;
    if (existing?.status === "completed") return existing;
    const triggerId = candidate.thread.evaluating?.primary ?? candidate.triggers[0]?.id;
    if (triggerId === undefined) throw new Error("Assessment requires a primary trigger");
    const identity = this.options.describe(candidate);
    if (!identity.title.trim() || !identity.scope.trim()) throw new Error("Host must describe the accepted candidate");

    const sessionKey = `assessor-${key.slice(0, 32)}`;
    const binding = { ticketId: `assessor-${key.slice(0, 16)}`, assignmentId: candidate.evalId, generation: 0, claimToken: 0 };
    let decided: PiAssessRecord["outcome"];
    let adapter: ScratchPiSession | undefined;
    const validate = (): void => {
      if (this.stopped) throw new Error("Assessor stopped before the decision");
      const current = this.options.store.cursors.get<PiAssessRecord>("pi-assessor", "sdk", key)?.value;
      if (current && current.status !== "completed" && current.evalId !== candidate.evalId) throw new Error("Assessor eval identity drift");
    };
    const extension: ExtensionFactory = pi => {
      pi.registerTool({
        name: "dsh_assess",
        label: "Record the intake decision",
        description: "Decide whether this message asks you to do work. accept starts a ticket in the host-provided scope; ignore records why it is not your work; unavailable says the message cannot be judged. Call exactly once.",
        parameters: outcomeSchema,
        execute: async (_toolCallId, args) => {
          validate();
          const choice = args as { kind: "accept" | "ignore" | "unavailable"; reason: string; note?: string };
          if (!choice.reason.trim()) throw new Error("Assessment reason must be non-empty");
          if (decided) throw new Error("Assessment already recorded");
          this.options.decide(triggerId, {
            ...(choice.kind === "accept"
              ? { kind: "accept" as const, title: identity.title, scope: identity.scope, reason: choice.reason, audit: { assessor: "model" }, ...(choice.note ? { note: choice.note } : {}) }
              : { kind: choice.kind, reason: choice.reason, audit: { assessor: "model" } }),
            evalId: candidate.evalId,
          });
          decided = choice;
          validate();
          this.save(key, { evalId: candidate.evalId, triggerId, status: "completed", outcome: choice });
          return { content: [{ type: "text", text: "Intake decision recorded" }], details: { kind: choice.kind }, terminate: true };
        },
      });
    };

    this.save(key, { evalId: candidate.evalId, triggerId, status: "failed" });
    try {
      adapter = await ScratchPiSession.open({ store: this.options.store, root: this.options.root, ...(this.options.allowedRoot ? { allowedRoot: this.options.allowedRoot } : {}),
        binding, sessionKey, modelRuntime: this.options.modelRuntime, model: this.options.model,
        extensions: [extension], activeTools: ["dsh_assess"], validate,
        context: () => ({ assessor: true, evalId: candidate.evalId, strength: candidate.strength }) });
      this.sessions.set(key, adapter);
      if (adapter.session.getActiveToolNames().slice().sort().join(",") !== "dsh_assess") throw new Error("Assessor tool set mismatch");
      const requestId = `assess-${candidate.evalId}`;
      adapter.prepare({ requestId, text: JSON.stringify({
        instruction: "Decide whether these messages ask you to do work in the repository you serve. "
          + "accept only when a person is clearly requesting work; ignore chatter, status notes, and anything already handled by an open ticket; "
          + "unavailable when the message is genuinely unjudgeable. Answer with dsh_assess exactly once. "
          + "You cannot write files, run commands, or reach the network.",
        candidate: assessorInput(candidate),
      }) });
      await adapter.activate(requestId).then(result => result.completion).catch(() => undefined);
    } finally {
      if (adapter) { await adapter.dispose().catch(() => undefined); this.sessions.delete(key); }
    }
    const record = this.options.store.cursors.get<PiAssessRecord>("pi-assessor", "sdk", key)?.value;
    if (record?.status === "completed") return record;
    // No decision is a real outcome: the Eval keeps working and the host sees a failed assessment.
    const failed: PiAssessRecord = { evalId: candidate.evalId, triggerId, status: "failed" };
    this.save(key, failed);
    return failed;
  }

  async dispose(): Promise<void> {
    this.stopped = true;
    const sessions = [...this.sessions.values()]; this.sessions.clear();
    for (const session of sessions) await session.dispose().catch(() => undefined);
  }

  private save(key: string, record: PiAssessRecord): void {
    this.options.store.atomic(() => {
      const row = this.options.store.cursors.get<PiAssessRecord>("pi-assessor", "sdk", key);
      this.options.store.cursors.save("pi-assessor", "sdk", key, record, row?.revision ?? 0);
    });
  }
}
