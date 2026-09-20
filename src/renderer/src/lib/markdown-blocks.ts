/**
 * Cut markdown into blocks that can be parsed on their own.
 *
 * A reply is re-rendered at the stream's flush cadence, and `react-markdown` re-parses
 * whatever text it is given *in full* every time. Measured with this project's own
 * remark pipeline, one pass costs ~22 ms at 10 KB, ~100 ms at 50 KB and over half a
 * second at 200 KB — so a long uninterrupted answer turns the renderer into a machine
 * that does nothing but re-parse the paragraphs it already parsed. (A reply broken up
 * by tool calls never hit this: each run of prose is its own part, and only the one
 * being written changes.)
 *
 * Splitting at block boundaries fixes the shape of that cost: every settled block keeps
 * its exact text, so its component memoises and never parses again, and only the block
 * being streamed into is re-parsed. The whole answer is then parsed once rather than
 * once per flush.
 *
 * What is *not* split matters as much as what is:
 *
 * - A fenced code block, and a `$$` math block, can contain blank lines. Splitting one
 *   would leave both halves as broken prose.
 * - A list, a blockquote and a table are cut only where the next line starts something
 *   else, so a loose list (blank lines between its items) stays whole — split, its
 *   second half would restart at `1.`.
 * - A link-reference or footnote definition is glued to the block above it for the same
 *   reason. This is where the seam shows: a definition at the *end* of a long answer
 *   cannot be seen by a reference earlier in it, since that block was parsed alone.
 *   Model output puts its links inline, so the trade is worth the two orders of
 *   magnitude.
 *
 * Joining the result with a newline reproduces the input exactly, which is the property
 * the tests pin down.
 */

type Fence = { marker: string; length: number; kind: "code" | "math" };

const CODE_FENCE = /^ {0,3}(`{3,}|~{3,})/;
const CODE_FENCE_CLOSE = /^ {0,3}(`{3,}|~{3,})\s*$/;

/** Does this line open a fence the block cannot be cut inside? */
function openFence(line: string): Fence | null {
  const code = CODE_FENCE.exec(line);
  if (code) return { marker: code[1][0], length: code[1].length, kind: "code" };
  const trimmed = line.trim();
  if (!trimmed.startsWith("$$")) return null;
  // `$$…$$` on one line is already closed.
  if (trimmed.length > 2 && trimmed.endsWith("$$")) return null;
  return { marker: "$", length: 2, kind: "math" };
}

function closesFence(line: string, fence: Fence): boolean {
  if (fence.kind === "math") return line.includes("$$");
  const close = CODE_FENCE_CLOSE.exec(line);
  return close !== null && close[1][0] === fence.marker && close[1].length >= fence.length;
}

/**
 * Can a new block start at this line, or does it continue the structure above it?
 *
 * Only prose, headings, fences and thematic breaks begin one. Everything that a blank
 * line can appear *inside* — list items, quotes, tables, indented code, definitions —
 * answers no, and is therefore kept with what precedes it.
 */
function startsBlock(line: string): boolean {
  if (/^(?: {4,}|\t)/.test(line)) return false;
  const text = line.trimStart();
  if (text.startsWith(">")) return false;
  if (text.startsWith("|")) return false;
  if (/^[-*+][ \t]/.test(text)) return false;
  if (/^\d+[.)][ \t]/.test(text)) return false;
  if (/^\[[^\]]+\]:/.test(text)) return false;
  return true;
}

export function splitMarkdownBlocks(text: string): string[] {
  // No blank line, nothing to cut: the common case (a short answer, a single
  // paragraph, one code fence) keeps its single parse and its single component.
  if (!text.includes("\n\n")) return [text];

  const lines = text.split("\n");
  const blocks: string[] = [];
  let current: string[] = [];
  let content = false;
  let blank = false;
  let fence: Fence | null = null;

  for (const line of lines) {
    if (fence) {
      current.push(line);
      if (closesFence(line, fence)) fence = null;
      continue;
    }
    if (line.trim() === "") {
      current.push(line);
      // Only a blank line that follows real content can end a block; leading blanks
      // belong to the block they introduce.
      blank = content;
      continue;
    }
    if (blank && startsBlock(line)) {
      blocks.push(current.join("\n"));
      current = [];
      content = false;
    }
    blank = false;
    fence = openFence(line);
    current.push(line);
    content = true;
  }
  if (current.length > 0) blocks.push(current.join("\n"));
  return blocks.length > 0 ? blocks : [text];
}
