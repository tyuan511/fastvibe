// SPDX-License-Identifier: MIT
/**
 * Read-only compatibility for the removed Bot API.
 *
 * This module deliberately depends on ShadowStore and the domain model only. It does
 * not import BotRuntime/BotStore, does not write legacy tables, and does not call IPC.
 */
import { createHash } from "node:crypto";
import type { Assignment, Attention, Thread, Ticket, Trigger, TicketInput } from "../core/model.ts";
import { latestReport } from "../core/model.ts";
import type { ShadowStore, Receipt } from "./store.ts";

const canonical = (value: unknown): string => {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value as Record<string, unknown>).sort().map(key => `${JSON.stringify(key)}:${canonical((value as Record<string, unknown>)[key])}`).join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
};
const digest = (...values: unknown[]): string => createHash("sha256").update(canonical(values)).digest("hex");
const id = (kind: string, ...values: unknown[]): string => `legacy-${kind}-${digest(kind, ...values).slice(0, 32)}`;
const clone = <T>(value: T): T => structuredClone(value);
const timestamp = (value: string | undefined, fallback: number): number => {
  const parsed = value === undefined ? Number.NaN : Date.parse(value);
  return Number.isFinite(parsed) ? parsed : fallback;
};

export type LegacyDeliveryEvidence = {
  id: string;
  ticketId?: string;
  status: "pending" | "delivered" | "failed";
  /** Outbox delivery is intentionally separate from worker read and report. */
  deliveredAt?: string;
  readAt?: string;
  reportedAt?: string;
};
export type LegacyInputEvidence = {
  inputId: string;
  ticketId: string;
  assignmentId?: string;
  deliveredAt?: string;
  readAt?: string;
  reportedAt?: string;
};
export type LegacyShadowEvidence = {
  triggers: Trigger[];
  threads: Thread[];
  tickets: Ticket[];
  assignments: Assignment[];
  attentions: Array<Attention & { ticketId: string }>;
  deliveries: LegacyDeliveryEvidence[];
  inputs: LegacyInputEvidence[];
};
export type LegacyConversation = {
  conversationId: string; role: "router" | "worker"; owner: "vivi"; creationKey: string;
  epoch: number; paused: boolean; createdAt: number; updatedAt: number; title?: string;
};
export type LegacyAttention = { id: string; conversationId: string; epoch: number; question: string; status: "pending"; createdAt: number };
export type LegacyResult = { id: string; conversationId: string; epoch: number; status: "idle" | "ready" | "blocked" | "failed" | "uncertain"; summary?: string; createdAt: number };
export type LegacyDelivery = { id: string; conversationId: string; targetConversationId: string; status: "pending" | "delivered" | "failed"; text: string; createdAt: number };
export type LegacyMessage = { id: string; conversationId: string; role: "user" | "assistant"; text: string; createdAt: number; kind: "message" };
export type LegacyWorkSnapshot = {
  revision: number; routerConversationId?: string; conversations: LegacyConversation[]; attention: LegacyAttention[];
  results: LegacyResult[]; deliveries: LegacyDelivery[]; messages: LegacyMessage[]; shadow: LegacyShadowEvidence;
};

function ticketConversation(ticket: Ticket, updatedAt: number): LegacyConversation {
  const createdAt = Date.parse(ticket.createdAt);
  const updated = Date.parse(ticket.updatedAt);
  return {
    conversationId: ticket.id, role: "worker", owner: "vivi", creationKey: `shadow-ticket:${ticket.id}`,
    epoch: 0, paused: ticket.ended?.outcome === "stopped", createdAt: Number.isFinite(createdAt) ? createdAt : updatedAt,
    updatedAt: Number.isFinite(updated) ? updated : updatedAt, title: ticket.title,
  };
}
function reportResult(ticket: Ticket, report: NonNullable<ReturnType<typeof latestReport>>, now: number): LegacyResult {
  const status: LegacyResult["status"] = report.state === "ready" ? "ready" : report.state === "failed" ? "failed"
    : report.state === "blocked" ? "blocked" : report.state === "dropped" ? "idle" : "uncertain";
  return { id: id("result", ticket.id, report.at, report.state, report.summary), conversationId: ticket.id,
    epoch: 0, status, summary: report.summary, createdAt: timestamp(report.at, now) };
}
function inputEvidence(ticket: Ticket, input: TicketInput, assignment?: Assignment): LegacyInputEvidence {
  const trigger = input.kind === "trigger" ? input : undefined;
  const deliveredAt = trigger?.deliveredAt ?? (trigger?.deliveredTo ? assignment?.deliveredAt : undefined);
  const readAt = trigger?.readAt === null ? undefined : trigger?.readAt;
  return { inputId: input.id, ticketId: ticket.id, ...(trigger?.deliveredTo ? { assignmentId: trigger.deliveredTo } : {}),
    ...(deliveredAt ? { deliveredAt } : {}), ...(readAt ? { readAt } : {}) };
}
function receiptRows(store: ShadowStore): Receipt[] {
  return store.db.all<{ data: string }>("SELECT data FROM dsh_outbox ORDER BY rowid").map(row => JSON.parse(row.data) as Receipt);
}

/** Build a detached old-shaped snapshot from Shadow facts. This function performs no writes. */
export function projectLegacyWorkSnapshot(store: ShadowStore, now = Date.now(), routerConversationId = "legacy-router"): LegacyWorkSnapshot {
  const threads = store.threads.list();
  const tickets = store.tickets.list();
  const assignments = tickets.flatMap(ticket => ticket.assignments.map(clone));
  const attentions = tickets.flatMap(ticket => ticket.attention ? [{ ...clone(ticket.attention), ticketId: ticket.id }] : []);
  const triggerMap = new Map<string, Trigger>();
  for (const thread of threads) for (const trigger of store.triggers.byThread(thread.key)) triggerMap.set(trigger.id, trigger);
  const triggers = [...triggerMap.values()].map(clone);
  const results = tickets.flatMap(ticket => { const report = latestReport(ticket); return report ? [reportResult(ticket, report, now)] : []; });
  const messages: LegacyMessage[] = triggers.filter(trigger => trigger.human).map(trigger => ({
    id: id("message", trigger.id), conversationId: trigger.threads[0] ? `${trigger.source}:${trigger.threads[0].id}` : routerConversationId,
    role: "user", text: trigger.text, createdAt: timestamp(trigger.at, now), kind: "message",
  }));
  const receipts = receiptRows(store);
  const deliveries: LegacyDelivery[] = receipts.map(receipt => ({ id: receipt.id, conversationId: receipt.ticketId ?? routerConversationId,
    targetConversationId: receipt.ticketId ?? routerConversationId, status: receipt.status === "sent" ? "delivered" : receipt.status === "dropped" ? "failed" : "pending",
    text: receipt.text, createdAt: now }));
  const deliveryEvidence: LegacyDeliveryEvidence[] = receipts.map(receipt => ({ id: receipt.id, ...(receipt.ticketId ? { ticketId: receipt.ticketId } : {}),
    status: receipt.status === "sent" ? "delivered" : receipt.status === "dropped" ? "failed" : "pending" }));
  const inputs = tickets.flatMap(ticket => ticket.inputs.map(input => inputEvidence(ticket, input,
    ticket.assignments.find(assignment => input.kind === "trigger" && assignment.id === input.deliveredTo))));
  const conversations = tickets.map(ticket => ticketConversation(ticket, now));
  const attentionRows: LegacyAttention[] = attentions.map(item => ({ id: item.id, conversationId: item.ticketId, epoch: 0, question: item.question, status: "pending", createdAt: now }));
  const revision = Number.parseInt(digest(triggers, threads, tickets, receipts).slice(0, 12), 16) % Number.MAX_SAFE_INTEGER;
  return clone({ revision, routerConversationId, conversations, attention: attentionRows, results, deliveries, messages,
    shadow: { triggers, threads: threads.map(clone), tickets: tickets.map(clone), assignments, attentions, deliveries: deliveryEvidence, inputs } });
}

export type LegacyReplayInput =
  | { action: "submit"; requestId?: string; text: string; conversationId?: string }
  | { action: "createWork"; requestId?: string; title: string; text: string; conversationId?: string }
  | { action: "report"; requestId?: string; conversationId: string; summary: string; outcome?: "idle" | "ready" | "blocked" | "failed" | "uncertain" }
  | { action: "stop"; requestId?: string; conversationId: string }
  | { action: "continue"; requestId?: string; conversationId: string; inputId?: string }
  | { action: "answer"; requestId?: string; attentionId: string; answer: string }
  | { action: "writeLegacyTable"; table: string; row: unknown };
export type ShadowReplayCommand =
  | { kind: "local.receive"; requestId: string; idempotencyKey: string; trigger: Trigger }
  | { kind: "local.report"; requestId: string; idempotencyKey: string; ticketId: string; report: { state: "ready" | "blocked" | "failed" | "progress"; summary: string } }
  | { kind: "people.stopTicket"; requestId: string; idempotencyKey: string; ticketId: string }
  | { kind: "people.retryTicket"; requestId: string; idempotencyKey: string; ticketId: string }
  | { kind: "main.reply"; requestId: string; idempotencyKey: string; attentionId: string; text: string };
export type LegacyReplayResult = { status: "mapped"; command: ShadowReplayCommand } | { status: "unsupported" | "needs-reconciliation"; requestId: string; reason: string };

function requestIdentity(input: LegacyReplayInput): { requestId: string; idempotencyKey: string } {
  const requestId = "requestId" in input && input.requestId?.trim() ? input.requestId : id("request", input);
  return { requestId, idempotencyKey: id("idempotency", requestId, input.action, input) };
}
function receive(input: Extract<LegacyReplayInput, { action: "submit" | "createWork" }>, identity: ReturnType<typeof requestIdentity>): ShadowReplayCommand {
  const conversation = input.conversationId ?? "legacy-local";
  const thread = { source: "local", id: conversation } as const;
  return { kind: "local.receive", ...identity, trigger: { id: id("trigger", identity.requestId), source: "local", threads: [thread], actor: { source: "local", id: "legacy-user" }, human: true, addressed: "direct", at: new Date(0).toISOString(), text: input.text,
    meta: { legacyAction: input.action, title: input.action === "createWork" ? input.title : undefined, requestId: identity.requestId } } };
}

/** Convert one old API input into a controlled Local Source/ShadowEngine command. Never executes it. */
export function mapLegacyReplayCommand(input: LegacyReplayInput): LegacyReplayResult {
  const identity = requestIdentity(input);
  if (input.action === "writeLegacyTable") return { status: "unsupported", requestId: identity.requestId, reason: `拒绝直接写旧表: ${input.table}` };
  if (input.action === "submit" || input.action === "createWork") {
    if (!input.text.trim()) return { status: "unsupported", requestId: identity.requestId, reason: "空提示词不能回放" };
    return { status: "mapped", command: receive(input, identity) };
  }
  if (input.action === "report") {
    const state = input.outcome === "ready" || input.outcome === "blocked" || input.outcome === "failed" ? input.outcome : "progress";
    return { status: "mapped", command: { kind: "local.report", ...identity, ticketId: input.conversationId, report: { state, summary: input.summary } } };
  }
  if (input.action === "stop") return { status: "mapped", command: { kind: "people.stopTicket", ...identity, ticketId: input.conversationId } };
  if (input.action === "continue") return { status: "mapped", command: { kind: "people.retryTicket", ...identity, ticketId: input.conversationId } };
  return { status: "mapped", command: { kind: "main.reply", ...identity, attentionId: input.attentionId, text: input.answer } };
}

export const legacyWorkSnapshot = projectLegacyWorkSnapshot;
export const replayLegacyCommand = mapLegacyReplayCommand;
