/**
 * Marking the query inside the text the command palette prints.
 *
 * The palette is a search control, and a result line that does not show *why* it
 * matched makes the reader do the matching again by eye — the body hits especially,
 * where the snippet is an excerpt out of a transcript they cannot see. So the query is
 * painted inside the title and inside the snippet, by the same literal, case-insensitive
 * rule the search itself used.
 *
 * Kept out of the component because it is pure text arithmetic with rules worth stating
 * (see `test/search-highlight.test.ts`), and because the palette row is not the only
 * place that could want it.
 */

export type HighlightPart = {
  text: string;
  /** True for a run that equals the query — the caller decides how to paint it. */
  match: boolean;
};

/**
 * How much of a body hit is shown before and after the match, in code units.
 *
 * These mirror `snippetAround` in `src/main/engine/conversation-search.ts` — Main has
 * already clipped the snippet it hands back, and this is what clips a match the palette
 * found in its *own* copy of the transcript (`Conversation.preview`). One shape for both
 * sources, so a row reads the same wherever its hit came from.
 */
export const SNIPPET_HEAD_CHARS = 24;
export const SNIPPET_TAIL_CHARS = 40;

/**
 * How many runs are marked in one snippet.
 *
 * A one-character query is a substring of nearly every line — a query of `e` would paint
 * the whole excerpt — and past the third mark the highlight stops pointing at anything.
 */
const MAX_SNIPPET_MATCHES = 3;

/**
 * Split `text` into runs, marking those equal to `query`.
 *
 * Literal, not a pattern: this is a find control, and `foo.bar` means that string.
 * Case-insensitive for the same reason the search is — a transcript is prose as often as
 * it is code, and case is rarely what is being looked for. `maxMatches` caps how many
 * runs are marked; the text itself is never dropped or reordered, so a caller can render
 * the parts back to back and get the original string.
 */
export function splitHighlight(text: string, query: string, maxMatches = Infinity): HighlightPart[] {
  const needle = query.trim();
  if (!needle) return text ? [{ text, match: false }] : [];
  const haystack = text.toLowerCase();
  const lowered = needle.toLowerCase();
  // `toLowerCase` can change a string's length (Turkish `İ`, `ẞ`), which would put every
  // index it reports one character away from the original. Vanishingly rare in a chat
  // title, and not worth a highlight drawn in the wrong place: fall back to plain text.
  if (haystack.length !== text.length) return [{ text, match: false }];

  const parts: HighlightPart[] = [];
  let cursor = 0;
  let marked = 0;
  while (marked < maxMatches) {
    const index = haystack.indexOf(lowered, cursor);
    if (index < 0) break;
    if (index > cursor) parts.push({ text: text.slice(cursor, index), match: false });
    parts.push({ text: text.slice(index, index + lowered.length), match: true });
    cursor = index + lowered.length;
    marked += 1;
  }
  if (cursor < text.length) parts.push({ text: text.slice(cursor), match: false });
  return parts;
}

/**
 * `splitHighlight` for an excerpt drawn on one line.
 *
 * A snippet comes out of a transcript, so it carries newlines and runs of indentation
 * that would otherwise make a single-line row look ragged or push the match out of
 * sight; whitespace is folded to one space first, which is also what Main does to the
 * snippet it sends.
 */
export function splitSnippetHighlight(
  text: string,
  query: string,
  maxMatches = MAX_SNIPPET_MATCHES,
): HighlightPart[] {
  return splitHighlight(text.replace(/\s+/g, " ").trim(), query, maxMatches);
}

/**
 * The excerpt around one match, in the same shape Main's `snippetAround` returns.
 *
 * Used for a hit the palette found itself (in `Conversation.preview`), so that a match
 * sitting deep inside a long preview is shown *around the match* rather than as the
 * first forty characters of the preview with nothing marked in them.
 */
export function clipSnippet(text: string, index: number, query: string): string {
  const start = Math.max(0, index - SNIPPET_HEAD_CHARS);
  const end = Math.min(text.length, index + query.trim().length + SNIPPET_TAIL_CHARS);
  return `${start > 0 ? "…" : ""}${text.slice(start, end)}${end < text.length ? "…" : ""}`;
}

/**
 * Where `query` first sits in `text`, case-insensitively, or -1.
 *
 * The same rule the search used to decide this conversation is a hit, so the row can
 * always point at the text that put it in the list.
 */
export function findMatch(text: string, query: string): number {
  const needle = query.trim();
  if (!needle) return -1;
  return text.toLowerCase().indexOf(needle.toLowerCase());
}
