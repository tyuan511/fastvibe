import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

/**
 * A user prompt is the person's own words, so the transcript draws it as text.
 *
 * The bubble used to run through the same markdown pipeline as a reply, and that is
 * actively wrong here rather than merely unnecessary: GFM's bare-URL autolink ends at
 * whitespace, and a Chinese sentence has none, so
 * 「https://github.com/owner/repo的实现，给我一个可行性分析」 rendered as one link over
 * the entire tail of the prompt — the reader could not tell where the address stopped,
 * and clicking it asked for a host that does not exist. Replies keep markdown; prompts
 * do not go near it, so nothing here is a transformer away from the bug coming back.
 *
 * The fold is pinned in the same pass because it is part of the same row: prompts over two
 * rendered lines stay compact, while the expanded body shares the transcript's height cap and
 * scrolls internally instead of covering the reply.
 */

const SOURCE = readFileSync(
  new URL("../src/renderer/src/components/chat/message-row.tsx", import.meta.url),
  "utf8",
);

const CLAMP_SOURCE = readFileSync(
  new URL("../src/renderer/src/lib/use-two-line-clamp.ts", import.meta.url),
  "utf8",
);

/** Everything from `UserPromptBubble` to the next top-level function. */
function promptBubble(): string {
  const start = SOURCE.indexOf("function UserPromptBubble");
  assert.ok(start >= 0, "UserPromptBubble must exist");
  const end = SOURCE.indexOf("\nfunction ", start + 1);
  return SOURCE.slice(start, end < 0 ? SOURCE.length : end);
}

test("the prompt bubble renders text, not markdown", () => {
  const bubble = promptBubble();

  assert.ok(!/MarkdownView/.test(bubble), "a user prompt must not be run through the markdown pipeline");
  // Line breaks the person typed are part of the message, and a URL or a Windows path
  // has no break opportunity of its own — without these two the bubble either flattens
  // the prompt or widens the whole transcript column.
  assert.match(bubble, /whitespace-pre-wrap/);
  assert.match(bubble, /wrap-anywhere/);
  assert.match(bubble, /\{text\}/, "the prompt is handed over as a single text node");
});

test("a prompt over two rendered lines folds and the expanded body stays scrollable", () => {
  const bubble = promptBubble();

  assert.match(bubble, /: "line-clamp-2"/, "every prompt is measured against the two-line cap");
  assert.match(bubble, /PROCESS_BODY_CAP/, "expanded prompts use the shared transcript height cap");
  assert.match(bubble, /useTwoLineClamp\(text\)/, "prompts share the measured folding rule with pasted previews");
  assert.match(CLAMP_SOURCE, /const observer = new ResizeObserver\(measure\)/, "the cap is remeasured when the layout changes");
  assert.match(bubble, /overflows \? toggle : null/, "the expand control follows actual rendered overflow");
  assert.match(bubble, /expanded \? cn\(PROCESS_BODY_CAP, "px-3 py-2"\)/);
});
