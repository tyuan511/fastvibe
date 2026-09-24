import {
  sessionEntryToContextMessages,
  type AgentSession,
} from "@earendil-works/pi-coding-agent";
import type { ChatMessage, CompactReason, EngineModel, ThinkingTiming, TuiRun } from "@shared/types";
import { mapEngineMessages } from "../engine/map-messages";
import { renderExtensionMessage } from "./tui-bridge";
import { isRecord, sessionCompletionTimes } from "./process-manager-events";

export type TranscriptProjectionDeps = {
  session: AgentSession;
  conversationId?: string;
  fromEntryId?: string;
  reasoning: { get(entryId: string): ThinkingTiming[] | undefined };
  widgetWidth: number;
  running: ReadonlyMap<string, boolean>;
  compacting: ReadonlyMap<string, CompactReason | undefined>;
};

/**
 * Project an SDK branch into the transcript the renderer reads.
 *
 * The SDK's context projection, FastVibe's persisted reasoning timings and the
 * in-flight cards all meet here. Keeping this pure projection outside the process
 * manager leaves session lifecycle and transcript shaping as separate concerns.
 */
export function projectSessionMessages(
  deps: TranscriptProjectionDeps,
): { messages: ChatMessage[]; anchored: boolean } {
  const { session, conversationId, fromEntryId } = deps;
  const branch = [...session.sessionManager.getBranch()];
  const start = fromEntryId ? branch.findIndex((entry) => entry.id === fromEntryId) : 0;
  const anchored = start >= 0;
  const entries = anchored ? branch.slice(start) : branch;
  const entryIds = new Map<unknown, string>();
  const timings = new Map<string, ThinkingTiming[]>();
  const transcript: unknown[] = [];
  for (const entry of entries) {
    for (const message of sessionEntryToContextMessages(entry)) {
      // The SDK keeps the active system prompt on a compaction entry so the model can
      // rebuild its context. It is not a user-visible transcript message; projecting
      // it here used to put a notice between the reply and the compaction card.
      const role: unknown = isRecord(message) ? message.role : undefined;
      if (entry.type === "compaction" && role === "system") continue;
      entryIds.set(message, entry.id);
      transcript.push(message);
    }
    if (entry.type !== "message") continue;
    const blocks = deps.reasoning.get(entry.id);
    if (blocks) timings.set(entry.id, blocks);
  }

  const runner = session.extensionRunner;
  const renderCustom = (message: Record<string, unknown>): TuiRun[][] | undefined => {
    const customType = typeof message.customType === "string" ? message.customType : undefined;
    if (!customType) return undefined;
    const renderer = runner.getMessageRenderer(customType);
    if (!renderer) return undefined;
    return renderExtensionMessage(renderer, message, deps.widgetWidth);
  };
  const messages = mapEngineMessages(
    transcript,
    (message) => entryIds.get(message),
    timings,
    renderCustom,
    sessionCompletionTimes(session),
  );
  insertModelSwitches(messages, branch, anchored ? start : 0);

  if (conversationId && deps.running.get(conversationId) === true && !deps.compacting.has(conversationId)) {
    const [inFlight] = mapEngineMessages(session.state.streamingMessage ? [session.state.streamingMessage] : []);
    if (inFlight?.role === "assistant") {
      messages.push({
        ...inFlight,
        id: `running:${conversationId}`,
        tools: inFlight.tools.map((tool) => ({ ...tool, status: "running" as const })),
      });
    } else if (messages.at(-1)?.role !== "assistant") {
      messages.push({ id: `running:${conversationId}`, role: "assistant", text: "", tools: [], parts: [], createdAt: Date.now() });
    }
  }
  if (conversationId && deps.compacting.has(conversationId)) {
    const compact = { status: "running" as const, reason: deps.compacting.get(conversationId) };
    const last = messages.at(-1);
    if (last?.role === "assistant") {
      messages[messages.length - 1] = {
        ...last,
        parts: [...(last.parts ?? []), { kind: "compact", text: "", compact }],
      };
    } else {
      messages.push({
        id: `compact:${conversationId}`,
        role: "system",
        text: "",
        tools: [],
        parts: [{ kind: "compact", text: "", compact }],
        createdAt: Date.now(),
        kind: "compact",
        compact,
      });
    }
  }
  return { messages, anchored };
}

function insertModelSwitches(
  messages: ChatMessage[],
  branch: ReturnType<AgentSession["sessionManager"]["getBranch"]>,
  fromIndex: number,
): void {
  if (messages.length === 0) return;
  const indexById = new Map(messages.map((message, index) => [message.id, index]));
  let previous: EngineModel | undefined;
  for (let index = 0; index < fromIndex; index += 1) {
    const entry = branch[index];
    if (entry.type !== "message") continue;
    const raw: unknown = entry.message;
    if (!isRecord(raw) || raw.role !== "assistant") continue;
    if (typeof raw.provider !== "string" || typeof raw.model !== "string") continue;
    previous = { provider: raw.provider, id: raw.model };
  }
  for (const entry of branch.slice(fromIndex)) {
    if (entry.type !== "message") continue;
    const raw: unknown = entry.message;
    if (!isRecord(raw) || raw.role !== "assistant") continue;
    if (typeof raw.provider !== "string" || typeof raw.model !== "string") continue;
    const model: EngineModel = { provider: raw.provider, id: raw.model };
    const from = previous;
    previous = model;
    if (!from || (from.provider === model.provider && from.id === model.id)) continue;
    const index = indexById.get(entry.id);
    if (index === undefined || messages[index].role !== "assistant") continue;
    (messages[index].parts ??= []).unshift({ kind: "model", from, to: model });
  }
}
