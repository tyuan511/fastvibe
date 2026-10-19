/**
 * 回复推荐: after a reply finishes, guess what the user will most likely send next and
 * offer it as the composer's placeholder, accepted with Tab.
 *
 * Everything here is pure — what to show the model, and what to make of its answer — so
 * the decisions that decide whether a suggestion is worth showing can be pinned by tests.
 * Calling the model and publishing the result is `PiProcessManager.#suggestNext`.
 */

/** A suggestion longer than this is the model answering the question, not guessing the next one. */
export const SUGGESTION_MAX_CHARS = 120;
/** How much of each side the model sees. The tail is what the next message answers. */
const USER_CHARS = 600;
const ASSISTANT_CHARS = 1800;

export const SUGGESTION_SYSTEM = [
  "You predict the next message a user will send in a conversation with an AI assistant.",
  "Write it from the user's point of view, as one short, natural message (a task, a follow-up question, or a confirmation).",
  "Write in the same language as the user's last message.",
  "Reply with the message only: no quotes, no label, no explanation.",
  "If there is no obvious next message, reply with exactly NONE.",
].join(" ");

export type SuggestionMaterial = { user: string; assistant: string };

function textOf(message: unknown): string {
  const content = (message as { content?: unknown } | null)?.content;
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((block) => {
      const item = block as { type?: unknown; text?: unknown };
      return item?.type === "text" && typeof item.text === "string" ? item.text : "";
    })
    .join("")
    .trim();
}

function tail(text: string, limit: number): string {
  return text.length <= limit ? text : text.slice(text.length - limit);
}

/**
 * The last exchange, or nothing when it is not worth guessing from.
 *
 * Only a reply that ended its turn in prose qualifies: one that stopped on a tool call,
 * failed or was cut off is not a place the user answers from, and a reply with no text
 * (a turn that only used tools) gives the model nothing to predict against.
 */
export function suggestionMaterial(messages: readonly unknown[]): SuggestionMaterial | undefined {
  const last = messages.at(-1) as { role?: unknown; stopReason?: unknown } | undefined;
  if (last?.role !== "assistant" || last.stopReason !== "stop") return undefined;
  const assistant = textOf(last);
  if (!assistant) return undefined;
  const user = [...messages].reverse().find((message) => (message as { role?: unknown })?.role === "user");
  const userText = user ? textOf(user) : "";
  if (!userText) return undefined;
  return { user: tail(userText, USER_CHARS), assistant: tail(assistant, ASSISTANT_CHARS) };
}

/**
 * The transcript with the reply that just ended on its end. `message_end` is delivered before every
 * reader of the session is guaranteed to hold the message, so an early start must not rely on
 * `session.messages` already containing it — and must not add it twice when it does.
 */
export function withFinalMessage(messages: readonly unknown[], final: unknown): unknown[] {
  const last = messages.at(-1);
  if (last === final) return [...messages];
  const a = last as { role?: unknown; timestamp?: unknown } | undefined;
  const b = final as { role?: unknown; timestamp?: unknown };
  if (a && a.role === b?.role && a.timestamp !== undefined && a.timestamp === b?.timestamp) return [...messages];
  return [...messages, final];
}

export function buildSuggestionPrompt(material: SuggestionMaterial): string {
  return [
    "<user_message>",
    material.user,
    "</user_message>",
    "",
    "<assistant_reply>",
    material.assistant,
    "</assistant_reply>",
    "",
    "The next message the user is most likely to send:",
  ].join("\n");
}

const WRAPPERS: ReadonlyArray<readonly [string, string]> = [
  ['"', '"'],
  ["'", "'"],
  ["`", "`"],
  ["“", "”"],
  ["‘", "’"],
  ["「", "」"],
  ["『", "』"],
];

/**
 * The model's answer as a suggestion, or undefined when it is not one: empty, `NONE`, or
 * too long to be a message someone would send. Takes the first line only — a model that
 * adds an explanation underneath has still put the guess first.
 */
export function cleanSuggestion(raw: string): string | undefined {
  let text = raw.split(/\r?\n/).map((line) => line.trim()).find(Boolean) ?? "";
  text = text.replace(/^(?:[-*•]\s+|\d+[.)]\s+)/, "");
  text = text.replace(/^(?:next message|user|suggestion|下一条消息|推荐)\s*[:：]\s*/i, "");
  for (let again = true; again; ) {
    again = false;
    for (const [open, close] of WRAPPERS) {
      if (text.length >= 2 && text.startsWith(open) && text.endsWith(close)) {
        text = text.slice(open.length, text.length - close.length).trim();
        again = true;
      }
    }
  }
  if (!text || /^none\.?$/i.test(text)) return undefined;
  if (text.length > SUGGESTION_MAX_CHARS) return undefined;
  return text;
}

/**
 * The same ask, as the last user turn of the conversation's own request (`cache` mode).
 * The model is already holding the conversation, so nothing is quoted back to it — only
 * told what this turn is for, and that it must not act.
 */
export const SUGGESTION_TURN = [
  "[Not a task. Do not call any tools and do not continue the work.]",
  SUGGESTION_SYSTEM,
].join("\n");

/** `fresh`: a new short request carrying only the last exchange. `cache`: the conversation's own prefix, so the provider's prompt cache can answer. */
export type SuggestionMode = "fresh" | "cache";

export function suggestionModeOf(value: string | undefined): SuggestionMode {
  return value?.trim().toLowerCase() === "cache" ? "cache" : "fresh";
}

type AgentLike = {
  state: { messages: unknown[] };
  transformContext?: (messages: any[], signal?: AbortSignal) => Promise<any[]>;
  convertToLlm: (messages: any[]) => unknown[] | Promise<unknown[]>;
};

/**
 * `cache` mode's request: the conversation as the agent would send it for its own next turn —
 * through the agent's own `transformContext` and `convertToLlm`, so the system message, the tool
 * declarations and every earlier message are the same bytes — with the suggestion ask as one more
 * user turn at the end. Whatever the provider cached for the last real request is this request's
 * prefix; `test/reply-suggestion-context.test.ts` pins that against the real SDK.
 */
export async function buildCacheContext(agent: AgentLike, signal?: AbortSignal): Promise<{ messages: unknown[] }> {
  const messages = agent.state.messages.slice();
  const hooked = agent.transformContext ? await agent.transformContext(messages, signal) : messages;
  const history = await agent.convertToLlm(hooked);
  return { messages: [...history, { role: "user", content: SUGGESTION_TURN, timestamp: Date.now() }] };
}

/** The first line of `text` once it is *finished* (a newline follows some content), else undefined. */
export function completedFirstLine(text: string): string | undefined {
  const match = /^\s*([^\n]+)\n/.exec(text);
  return match ? match[1].trim() : undefined;
}

type StreamedMessage = { stopReason: string; content: Array<{ type: string; text?: string }>; [key: string]: unknown };
type SuggestionStream = {
  [Symbol.asyncIterator](): AsyncIterator<{ type: string; delta?: string }>;
  result(): Promise<StreamedMessage>;
};

/**
 * Read a suggestion from a stream and stop paying for the rest of it. A suggestion is one line, so
 * the moment that line is finished the request is cancelled — a model that goes on to explain
 * itself, or to thinking-aloud past the line, costs nothing more. The answer is returned as an
 * ordinary finished message (`stop`, with just that line) so callers see no difference; every
 * other ending is whatever the stream itself reported.
 */
export async function readSuggestionStream(stream: SuggestionStream, cancel: () => void): Promise<StreamedMessage> {
  let text = "";
  let line: string | undefined;
  for await (const event of stream) {
    if (event.type !== "text_delta" || typeof event.delta !== "string") continue;
    text += event.delta;
    line = completedFirstLine(text);
    if (line !== undefined) {
      cancel();
      break;
    }
  }
  const result = await stream.result();
  if (line === undefined) return result;
  return { ...result, stopReason: "stop", errorMessage: undefined, content: [{ type: "text", text: line }] };
}
