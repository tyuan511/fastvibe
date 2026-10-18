/**
 * The citation block Codex's read-path prompt asks an agent to end a reply with when it used
 * memory: file ranges for the reader, and the conversation ids whose recaps helped, which is how
 * the pipeline learns what is worth keeping. The block is for the machine, not the user.
 */

const OPEN = "<oai-mem-citation>";
const CLOSE = "</oai-mem-citation>";

/**
 * A fence line that could open the block: the marker and at most one info-string token. Prose
 * after the marker is not an info string, so a code block that merely *contains* the markup is
 * never mistaken for a wrapper and never eaten.
 */
const WRAPPER_OPEN = /^[ \t]*(`{3,}|~{3,})[ \t]*(?:[\w.+#-]+[ \t]*)?$/;
/** A fence line that could close it: a bare marker of the same character, never shorter. */
const WRAPPER_CLOSE = /^[ \t]*(`{3,}|~{3,})[ \t]*$/;

/** The conversations a reply cites are read from its block, once each. */
export function memoryCitationIds(text: string): string[] {
  const ids: string[] = [];
  for (let from = 0; ;) {
    const start = text.indexOf(OPEN, from);
    if (start < 0) break;
    const end = text.indexOf(CLOSE, start);
    if (end < 0) break;
    from = end + CLOSE.length;
    const block = text.slice(start, end);
    const open = block.indexOf("<rollout_ids>");
    const close = block.indexOf("</rollout_ids>");
    if (open < 0 || close < open) continue;
    for (const line of block.slice(open + "<rollout_ids>".length, close).split("\n")) {
      const id = line.trim();
      if (id && !ids.includes(id)) ids.push(id);
    }
  }
  return ids;
}

/**
 * The reply as the reader should see it: finished blocks removed, and so is a block still
 * being written (an unclosed opening tag, or the first characters of one at the very end), so
 * streaming never flashes the markup.
 *
 * A model that copies the protocol verbatim wraps the block in a code fence, because the format
 * is shown inside one. Removing only the tags would leave that pair standing, and an empty fence
 * is precisely a code block: the reader ends up with a stray box under every reply. So a fence
 * whose entire content *is* the block goes with it, and nothing else does — not a fence holding
 * real text, and not a fence with prose between it and the block's edges.
 */
export function stripMemoryCitation(text: string): string {
  if (!text.includes("<")) return text;
  let out = text;
  let changed = false;
  for (;;) {
    const start = out.indexOf(OPEN);
    if (start < 0) break;
    const end = out.indexOf(CLOSE, start);
    const wrapper = fenceWrapper(out, start);
    const from = wrapper ? wrapper.open : start;
    const blockEnd = end < 0 ? out.length : end + CLOSE.length;
    const to = wrapper && end >= 0 ? closingFence(out, blockEnd, wrapper.marker) : blockEnd;
    out = out.slice(0, from) + out.slice(to);
    changed = true;
  }
  // A tag that has only begun to arrive: `<`, `<oai-m`, … at the very end.
  for (let length = Math.min(OPEN.length - 1, out.length); length > 0; length -= 1) {
    if (OPEN.startsWith(out.slice(out.length - length))) {
      const cut = out.length - length;
      // The opener of the block still being written goes too: half a citation inside a fence
      // would otherwise show as a growing empty code box until the closing tag lands.
      const wrapper = fenceWrapper(out, cut);
      out = out.slice(0, wrapper ? wrapper.open : cut);
      changed = true;
      break;
    }
  }
  // The block follows the answer after a blank line; that gap goes with it.
  return changed ? out.trimEnd() : out;
}

/**
 * The fence wrapping the citation at `at`, if there is one: where its opening line begins, and
 * that line's marker. Null when the text before the tag is not a lone fence line.
 */
function fenceWrapper(text: string, at: number): { open: number; marker: string } | null {
  let i = at;
  while (i > 0 && isBlank(text[i - 1])) i -= 1;
  // The fence line has to sit directly above the block: one line break, nothing else on the
  // line the tag starts on. A blank line between them means that fence closed an *earlier*
  // code block, and eating it would delete the fence the reader asked for.
  if (breaks(text.slice(i, at)) !== 1) return null;
  const lineStart = text.lastIndexOf("\n", i - 1) + 1;
  const match = WRAPPER_OPEN.exec(text.slice(lineStart, i));
  return match ? { open: lineStart, marker: match[1] } : null;
}

/** Past the closing fence of a wrapped block, or `from` when what follows is not that fence. */
function closingFence(text: string, from: number, opener: string): number {
  let i = from;
  while (i < text.length && isBlank(text[i])) i += 1;
  if (breaks(text.slice(from, i)) !== 1) return from;
  const lineEnd = text.indexOf("\n", i);
  const match = WRAPPER_CLOSE.exec(text.slice(i, lineEnd < 0 ? text.length : lineEnd));
  if (!match) return from;
  const marker = match[1];
  if (marker[0] !== opener[0] || marker.length < opener.length) return from;
  return lineEnd < 0 ? text.length : lineEnd;
}

function breaks(run: string): number {
  let count = 0;
  for (const char of run) if (char === "\n") count += 1;
  return count;
}

function isBlank(char: string): boolean {
  return char === " " || char === "\t" || char === "\n" || char === "\r";
}
