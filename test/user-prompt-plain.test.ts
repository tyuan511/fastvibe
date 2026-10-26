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
 * The fold is pinned in the same pass because it is the other half of the same row:
 * folding is for a paste, not for a sentence, and the length rule lives with the
 * composer's own paste threshold (`lib/attachments.ts`).
 */

const SOURCE = readFileSync(
  new URL("../src/renderer/src/components/chat/message-row.tsx", import.meta.url),
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

test("only a long prompt folds, and the length rule is shared with the composer", () => {
  const bubble = promptBubble();

  assert.match(bubble, /shouldFoldPastedText\(text\)/, "the fold is decided by the shared 500-character rule");
  assert.match(bubble, /foldable && "line-clamp-2"/, "a short prompt is never clamped");
  assert.match(bubble, /foldable && overflows \? toggle : null/, "and never gets an 展开 control");
  // The clamp must not be left running on a bubble that cannot fold: the measurement
  // that decides 展开 is skipped for those, so a stale clamp would hide text forever.
  assert.match(bubble, /if \(!foldable\) \{\s*setOverflows\(false\);\s*return;/);
});
