/**
 * Output that takes up room and says nothing.
 *
 * A remote model sometimes pads a reply with a long run of *blank* content — dozens of
 * `<br>`s, lines made of non-breaking or ideographic spaces, zero-width characters. The
 * transcript then shows a wall of vertical nothing between two real paragraphs, and the
 * reader has to scroll past it to find out whether something is loading.
 *
 * Plain newlines were never the problem: `remark-parse` calls only ASCII space/tab/line
 * terminators whitespace, so a run of `\n\n\n\n` is one empty block and renders nothing at
 * all. What survives into a tall gap is content the parser cannot see and the browser can:
 * markup that breaks a line, and the Unicode spaces that are *not* blank to it. So the two
 * rules here are about those, and nothing else:
 *
 * 1. a part with nothing to read takes no row (`isBlankOutput`), and
 * 2. a pathological run of line breaks or invisible characters is shortened, not deleted
 *    (`collapseBlankRuns`) — one `<br>` between two lines is what the model wrote, forty is
 *    the degenerate case, and a README that really does use a couple of them must keep them.
 *
 * Both are pure and shared, because the live stream, a re-read transcript, a tool card and
 * the file pane all render through one `MarkdownView`, and a rule that lives in two of them
 * is a rule that disagrees with itself mid-reply.
 */

/**
 * Code points that hold no ink but are *not* whitespace to `remark-parse`: NBSP, the
 * zero-width family, the BOM, and the ideographic space. `String.prototype.trim` drops the
 * Zs ones and keeps the Cf ones, which is why blankness is decided here rather than by it.
 */
const INVISIBLE = "\\u00a0\\u200b\\u200c\\u200d\\u2060\\ufeff\\u3000";

/** A line break written as markup — the shape a model reaches for when it wants space. */
const HTML_BREAK = /<(?:br|wbr)\s*\/?>/gi;

/** The same space as an entity, which is what a model copies out of HTML it was shown. */
const SPACE_ENTITY = /&(?:nbsp|#160|#x0*a0);/gi;

/**
 * Three or more `&nbsp;` in a row. A single one is a word processor's habit and means
 * “do not break the line here”, so only the run is a symptom — and it becomes one space,
 * not nothing, so the words on either side stay words.
 */
const SPACE_ENTITY_RUN = /&(?:nbsp|#160|#x0*a0);(?:[ \t\r\n]*&(?:nbsp|#160|#x0*a0);){2,}/gi;

const BLANK_CHARS = new RegExp(`[\\s${INVISIBLE}]+`, "g");

/** Three or more `<br>`s with only spaces and newlines between them. */
const BREAK_RUN = /<(?:br|wbr)\s*\/?>(?:[ \t\r\n]*<(?:br|wbr)\s*\/?>){2,}/gi;

/** A line whose only content is invisible characters. */
const INVISIBLE_ONLY_LINE = new RegExp(`^[ \\t]*(?:[${INVISIBLE}][ \\t\\r]*)+[ \\t\\r]*$`, "gm");

/** A long run of invisible characters on one line, which wraps into many blank lines. */
const INVISIBLE_RUN = new RegExp(`[${INVISIBLE}]{3,}`, "g");

/** Is there anything in this text for a reader to see? */
export function isBlankOutput(text: string): boolean {
  return text.replace(HTML_BREAK, "").replace(SPACE_ENTITY, "").replace(BLANK_CHARS, "") === "";
}

/**
 * Blank output still takes a row while it is the reply's live tail.
 *
 * A model opening its answer with newlines is the normal case, not a defect, and the blinking
 * caret sitting on that empty bubble is the reader's sign that the run is still writing. Once
 * the part has ended there is nothing left for the row to say.
 */
export function blankTakesRow(text: string, live: boolean): boolean {
  return live || !isBlankOutput(text);
}

/**
 * Shorten the pathological runs, keeping one gap where there were many.
 *
 * Deliberately conservative: it never removes a line break that stands alone, never touches
 * ASCII blank lines (the parser already collapses those), and never rewrites a paragraph
 * break — an invisible-only line becomes an ordinary blank one, so the prose on either side
 * of a collapsed run is still two paragraphs.
 */
export function collapseBlankRuns(text: string): string {
  if (!text) return text;
  // The entity first: `&nbsp;&nbsp;&nbsp;` is three invisible characters written as text, and
  // after it becomes a space the ordinary rules below see it.
  let out = text.replace(SPACE_ENTITY_RUN, " ").replace(INVISIBLE_RUN, " ");
  // A line of invisible characters is a paragraph to `remark-parse`, so twenty of them are
  // twenty blank lines. Making them ASCII-blank instead hands them to the parser's own rule,
  // which is why the paragraph break on either side survives without this having to reason
  // about it. Three is the floor: one or two are spacing someone meant.
  if ((out.match(INVISIBLE_ONLY_LINE) ?? []).length >= 3) out = out.replace(INVISIBLE_ONLY_LINE, "");
  return out.replace(BREAK_RUN, "<br><br>");
}
