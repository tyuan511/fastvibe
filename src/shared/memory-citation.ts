/**
 * The citation block Codex's read-path prompt asks an agent to end a reply with when it used
 * memory: file ranges for the reader, and the conversation ids whose recaps helped, which is how
 * the pipeline learns what is worth keeping. The block is for the machine, not the user.
 */

const OPEN = "<oai-mem-citation>";
const CLOSE = "</oai-mem-citation>";

/** The conversation ids a reply's citation block names, in order, once each. */
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
 */
export function stripMemoryCitation(text: string): string {
  if (!text.includes("<")) return text;
  let out = text;
  let changed = false;
  for (;;) {
    const start = out.indexOf(OPEN);
    if (start < 0) break;
    const end = out.indexOf(CLOSE, start);
    out = end < 0 ? out.slice(0, start) : out.slice(0, start) + out.slice(end + CLOSE.length);
    changed = true;
  }
  // A tag that has only begun to arrive: `<`, `<oai-m`, … at the very end.
  for (let length = Math.min(OPEN.length - 1, out.length); length > 0; length -= 1) {
    if (OPEN.startsWith(out.slice(out.length - length))) {
      out = out.slice(0, out.length - length);
      changed = true;
      break;
    }
  }
  // The block follows the answer after a blank line; that gap goes with it.
  return changed ? out.trimEnd() : out;
}
