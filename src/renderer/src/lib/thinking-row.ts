/**
 * Whether a thinking block takes a row of its own in the transcript.
 *
 * Providers do emit a reasoning block with nothing in it — a single space is the
 * common shape. It is truthy, so nothing dropped it on the way in, and the row it
 * produced read 「思考 · 3 秒」 and expanded to an empty box: a claim about thinking
 * that was never written, sitting between the real thoughts and the tool calls.
 */

/** Reasoning with nothing to read: no characters, or only whitespace. */
export function thinkingIsBlank(text: string): boolean {
  return text.trim().length === 0;
}

/**
 * A blank block still takes a row while it is the reply's live tail: 「正在思考」 is a
 * true report of work in flight, and it is what tells the reader the model has not
 * stalled before the first token of a thought arrives. Once the block has ended,
 * though, there is nothing left for the row to say.
 */
export function thinkingTakesRow(text: string, live: boolean): boolean {
  return live || !thinkingIsBlank(text);
}

/**
 * The parts that are a run's *process*: what 折叠运行过程 hides behind 「用时 …」, and what
 * the overflow row collects when a long run pushes prose off the top. Prose, a model
 * switch and a compaction divider are results or transcript-level rules, not process.
 */
export function isProcessKind(kind: string): boolean {
  return kind === "thinking" || kind === "tool" || kind === "group";
}
