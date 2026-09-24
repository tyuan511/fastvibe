import type {
  AgentSession,
  AgentSessionEvent,
} from "@earendil-works/pi-coding-agent";
import type { CompactReason } from "@shared/types";
import { isAbortOutcome } from "@shared/abort";
import { assistantErrorSummary, finalAssistantErrorSummary } from "./assistant-error-summary";

/** Usage accumulated from the assistant messages in a throwaway subagent run. */
export type SubagentHostUsage = {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  cost: number;
  contextTokens: number;
  turns: number;
};

/** The one block of a partial assistant message a tool-call event actually describes. */
function toolCallBlock(inner: Record<string, unknown>): unknown {
  const partial = inner.partial;
  if (typeof partial !== "object" || partial === null) return undefined;
  const content = (partial as Record<string, unknown>).content;
  if (!Array.isArray(content)) return undefined;
  const index = typeof inner.contentIndex === "number" ? inner.contentIndex : undefined;
  return index === undefined ? content.at(-1) : content[index];
}

/**
 * Reduce high-frequency SDK events before they cross the IPC boundary.
 *
 * The SDK includes the entire accumulated assistant message in every
 * `message_update`. The renderer only needs the delta and the current tool block,
 * so keeping this projection separate makes the hot path easy to audit.
 */
export function slimStreamEvent(event: Record<string, unknown>): Record<string, unknown> {
  if (event.type === "message_update") {
    const inner = event.assistantMessageEvent;
    if (typeof inner !== "object" || inner === null) return event;
    const innerRecord = inner as Record<string, unknown>;
    const { message: _message, ...rest } = event;
    if (innerRecord.type === "text_delta" || innerRecord.type === "thinking_delta") {
      const { partial: _partial, ...deltaOnly } = innerRecord;
      return { ...rest, assistantMessageEvent: deltaOnly };
    }
    if (innerRecord.type === "error") {
      const { partial: _partial, error, ...deltaOnly } = innerRecord;
      const summary = assistantErrorSummary(error);
      const reason = isAbortOutcome(innerRecord) ? "aborted" : deltaOnly.reason;
      return { ...rest, assistantMessageEvent: { ...deltaOnly, reason, error: summary } };
    }
    if (
      innerRecord.type === "toolcall_start" ||
      innerRecord.type === "tool_call_start" ||
      innerRecord.type === "toolcall_delta" ||
      innerRecord.type === "tool_call_delta" ||
      innerRecord.type === "toolcall_end" ||
      innerRecord.type === "tool_call_end"
    ) {
      const block = toolCallBlock(innerRecord);
      if (block === undefined) return rest;
      return { ...rest, assistantMessageEvent: { ...innerRecord, partial: { content: [block] }, contentIndex: 0 } };
    }
    return rest;
  }
  if (event.type === "agent_end") {
    const messages = Array.isArray(event.messages) ? event.messages : [];
    const summary = finalAssistantErrorSummary(messages);
    const { messages: _messages, ...rest } = event;
    return summary ? { ...rest, messages: [summary] } : rest;
  }
  if (event.type === "turn_end" || event.type === "message_end") {
    const { message, toolResults: _toolResults, ...rest } = event;
    const summary = assistantErrorSummary(message);
    return summary ? { ...rest, message: summary } : rest;
  }
  return event;
}

/** Keep bookkeeping failures out of the SDK's agent loop. */
export function guardSessionListener(
  owner: string,
  listener: (event: AgentSessionEvent) => void,
): (event: AgentSessionEvent) => void {
  return (event) => {
    try {
      listener(event);
    } catch (error) {
      console.error(`[engine] ${owner}: listener failed on ${event.type}`, error);
    }
  };
}

export function sessionEntryIds(session: AgentSession): Map<unknown, string> {
  const ids = new Map<unknown, string>();
  for (const entry of session.sessionManager.getEntries()) {
    if (entry.type === "message") ids.set(entry.message, entry.id);
  }
  return ids;
}

/** Last assistant on the branch with this stop reason, when the projected object is a copy. */
export function interruptedAssistantEntryId(session: AgentSession, stopReason: string): string | undefined {
  const branch = session.sessionManager.getBranch();
  for (let i = branch.length - 1; i >= 0; i -= 1) {
    const entry = branch[i];
    if (entry.type !== "message" || entry.message.role !== "assistant") continue;
    if ((entry.message as { stopReason?: string }).stopReason === stopReason) return entry.id;
  }
  return undefined;
}

export function sessionCompletionTimes(session: AgentSession): Map<string, number> {
  const times = new Map<string, number>();
  for (const entry of session.sessionManager.getEntries()) {
    if (entry.type !== "message") continue;
    const at = Date.parse(entry.timestamp);
    if (Number.isFinite(at)) times.set(entry.id, at);
  }
  return times;
}

/** Every user turn in the session tree, as payload text, for queue reconciliation. */
export function sessionUserTurns(session: AgentSession): Array<{ text: string; timestamp?: number }> {
  const turns: Array<{ text: string; timestamp?: number }> = [];
  for (const entry of session.sessionManager.getEntries()) {
    if (entry.type !== "message" || !isUserEngineMessage(entry.message)) continue;
    const { content, timestamp } = entry.message as { content?: unknown; timestamp?: unknown };
    const text = typeof content === "string"
      ? content
      : Array.isArray(content)
        ? content.map((part) => (part && typeof part === "object" && (part as { type?: unknown }).type === "text" ? String((part as { text?: unknown }).text ?? "") : "")).join("")
        : "";
    turns.push({ text, timestamp: typeof timestamp === "number" ? timestamp : undefined });
  }
  return turns;
}

export function isUserEngineMessage(message: unknown): message is Record<string, unknown> {
  return typeof message === "object" && message !== null && (message as { role?: unknown }).role === "user";
}

export function isAssistantEngineMessage(message: unknown): message is Record<string, unknown> {
  return typeof message === "object" && message !== null && (message as { role?: unknown }).role === "assistant";
}

export function messageText(message: Record<string, unknown>): string {
  const content = message.content;
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((part) => isRecord(part) && part.type === "text" ? String(part.text ?? "") : "")
    .join("")
    .trim();
}

const COMPACT_REASONS: ReadonlySet<string> = new Set<CompactReason>(["manual", "threshold", "overflow"]);

export function compactReasonOf(event: { reason?: unknown }): CompactReason | undefined {
  const reason = typeof event.reason === "string" ? event.reason : undefined;
  return reason && COMPACT_REASONS.has(reason) ? (reason as CompactReason) : undefined;
}

export function summarizeSubagentMessages(messages: unknown[]): {
  usage: SubagentHostUsage;
  stopReason?: string;
  errorMessage?: string;
} {
  const usage: SubagentHostUsage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 0 };
  let stopReason: string | undefined;
  let errorMessage: string | undefined;
  for (const raw of messages) {
    if (!isRecord(raw) || raw.role !== "assistant") continue;
    usage.turns += 1;
    const messageUsage = isRecord(raw.usage) ? raw.usage : undefined;
    if (messageUsage) {
      usage.input += num(messageUsage.input);
      usage.output += num(messageUsage.output);
      usage.cacheRead += num(messageUsage.cacheRead);
      usage.cacheWrite += num(messageUsage.cacheWrite);
      usage.cost += isRecord(messageUsage.cost) ? num(messageUsage.cost.total) : num(messageUsage.cost);
      const total = num(messageUsage.totalTokens);
      if (total) usage.contextTokens = total;
    }
    if (typeof raw.stopReason === "string") stopReason = raw.stopReason;
    if (typeof raw.errorMessage === "string") errorMessage = raw.errorMessage;
  }
  return { usage, stopReason, errorMessage };
}

export function isToolCallPart(type: string): boolean {
  return type === "toolCall" || type === "tool_use" || type === "tool_call" || type === "toolcall";
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

export function num(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}
