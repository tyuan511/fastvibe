import type { ChatMessage, ToolCallBlock } from "./types.ts";

/**
 * Tool calls as a small-screen client lists them: what was called and on what, without
 * what it read or printed.
 *
 * A reply's tool calls are folded to one line each on a phone — the file, the command, the
 * query — and the input and output are read only when a line is opened. They are also
 * nearly all of a transcript's bytes: in a session of ordinary coding work the calls'
 * arguments and results were 95% of a twelve-turn snapshot (600 KB of 646), against 17 KB
 * of text anyone reads. Over a relayed connection that is the difference between a chat
 * that opens at once and one that takes twenty seconds, during which every other reply
 * waits behind it on the same ordered channel.
 *
 * So a client that does not show a call's body may ask for the summary form
 * (`toolDetail: "summary"` on a snapshot or a history page): long strings are cut and large
 * results left out, each block saying so in `omitted`. The phone app lists calls and
 * nothing more, so it always asks; a client that wants the bodies does not ask.
 */

/** A result this short is cheaper to send than to mark as left out. */
export const SUMMARY_RESULT_INLINE = 240;

/** How much of a long string argument is kept: enough for the line a call is shown as. */
export const SUMMARY_STRING_HEAD = 200;

/**
 * Calls whose arguments and details *are* what is drawn — a checklist, a question card, a
 * task graph, the roles of a delegation — rather than a line plus a body behind a tap.
 * They are small, and cutting them would cut the card.
 */
const STRUCTURED = /^(todo|question|subagent|dag_)/;

/** What a summary left out of a block; absent when the block is whole. */
export type ToolOmission = {
  /** The result was left out; this is its length in characters. */
  result?: number;
  /** Some argument strings were cut short. */
  args?: true;
  /** Some strings in `details` were cut short. */
  details?: true;
};

function clipStrings(value: unknown, clipped: { any: boolean }, depth = 0): unknown {
  if (typeof value === "string") {
    if (value.length <= SUMMARY_STRING_HEAD) return value;
    clipped.any = true;
    return `${value.slice(0, SUMMARY_STRING_HEAD)}…`;
  }
  // Deep enough to be data nobody summarises a call by; kept as it is rather than walked.
  if (depth > 8 || value === null || typeof value !== "object") return value;
  if (Array.isArray(value)) return value.map((item) => clipStrings(item, clipped, depth + 1));
  const out: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value)) out[key] = clipStrings(item, clipped, depth + 1);
  return out;
}

/** One block in summary form. A block that is already small is returned as it is. */
export function summarizeToolBlock(tool: ToolCallBlock): ToolCallBlock {
  // A call still running is being drawn live: its output is what the reader is watching.
  if (tool.status === "running") return tool;
  const omitted: ToolOmission = {};
  let next = tool;
  const edit = (): ToolCallBlock => (next === tool ? (next = { ...tool }) : next);

  if (typeof tool.result === "string" && tool.result.length > SUMMARY_RESULT_INLINE) {
    omitted.result = tool.result.length;
    delete edit().result;
  }
  if (!STRUCTURED.test(tool.name)) {
    for (const field of ["args", "details"] as const) {
      if (tool[field] === undefined) continue;
      const clipped = { any: false };
      const value = clipStrings(tool[field], clipped);
      if (!clipped.any) continue;
      edit()[field] = value;
      omitted[field] = true;
    }
  }
  if (next === tool) return tool;
  next.omitted = omitted;
  return next;
}

/** A transcript with every settled tool call in summary form. Messages without one are shared, not copied. */
export function summarizeToolCalls(messages: ChatMessage[]): ChatMessage[] {
  return messages.map((message) => {
    if (!message.tools?.length) return message;
    let changed = false;
    const tools = message.tools.map((tool) => {
      const slim = summarizeToolBlock(tool);
      if (slim !== tool) changed = true;
      return slim;
    });
    return changed ? { ...message, tools } : message;
  });
}
