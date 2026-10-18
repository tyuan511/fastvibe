import { test } from "node:test";
import assert from "node:assert/strict";
import { memoryCitationIds, stripMemoryCitation } from "../src/shared/memory-citation.ts";

const BLOCK = `<oai-mem-citation>
<citation_entries>
MEMORY.md:12-14|note=[build flags]
</citation_entries>
<rollout_ids>
019c6e27-e55b-73d1-87d8-4e01f1f75043
019c7714-3b77-74d1-9866-e1f484aae2ab
019c6e27-e55b-73d1-87d8-4e01f1f75043
</rollout_ids>
</oai-mem-citation>`;

const FENCE = "```";

/** A block wrapped in a fence — the shape a model copies from the protocol's own example. */
function fenced(body = BLOCK, open = FENCE, close = open, info = "", indent = "") {
  return `The answer.\n\n${indent}${open}${info}\n${indent}${body}\n${indent}${close}\n`;
}

test("the conversations a reply cites are read from its block, once each", () => {
  assert.deepEqual(memoryCitationIds(`The answer.\n\n${BLOCK}`), ["019c6e27-e55b-73d1-87d8-4e01f1f75043", "019c7714-3b77-74d1-9866-e1f484aae2ab"]);
  assert.deepEqual(memoryCitationIds("no block here"), []);
  assert.deepEqual(memoryCitationIds("<oai-mem-citation><rollout_ids>\n</rollout_ids></oai-mem-citation>"), []);
  assert.deepEqual(memoryCitationIds("<oai-mem-citation>\n<rollout_ids>\nunclosed"), []);
  // The wrapper does not hide the ids: a cited conversation is still credited.
  assert.deepEqual(memoryCitationIds(fenced()), ["019c6e27-e55b-73d1-87d8-4e01f1f75043", "019c7714-3b77-74d1-9866-e1f484aae2ab"]);
});

test("the block is stripped, including while it is still arriving", () => {
  assert.equal(stripMemoryCitation(`The answer.\n\n${BLOCK}`), "The answer.");
  assert.equal(stripMemoryCitation(`The answer.\n\n${BLOCK.slice(0, 60)}`), "The answer.");
  for (const partial of ["<", "<oai", "<oai-mem-cit", "<oai-mem-citation"]) {
    assert.equal(stripMemoryCitation(`Done.\n\n${partial}`), "Done.", partial);
  }
  assert.equal(stripMemoryCitation("a < b and <div>x</div>"), "a < b and <div>x</div>");
  assert.equal(stripMemoryCitation("plain text with trailing space "), "plain text with trailing space ");
  assert.equal(stripMemoryCitation("1 <"), "1");
});

test("a fence whose whole content is the block goes with it", () => {
  // Leaving the pair standing draws an empty code block under every such reply — a stray box a
  // reader never asked for — so the wrapper is part of the removal.
  assert.equal(stripMemoryCitation(fenced()), "The answer.");
  assert.equal(stripMemoryCitation(fenced(BLOCK, FENCE, FENCE, "markdown")), "The answer.");
  assert.equal(stripMemoryCitation(fenced(BLOCK, "~~~~", "~~~~")), "The answer.");
  assert.equal(stripMemoryCitation(fenced(BLOCK, FENCE, FENCE, "", "  ")), "The answer.");
  assert.equal(stripMemoryCitation(`The answer.\n${FENCE}\n${BLOCK}\n${FENCE}`), "The answer.");
  assert.equal(stripMemoryCitation(fenced(BLOCK.slice(0, 60))), "The answer.");
  assert.equal(stripMemoryCitation(`${FENCE}\n${BLOCK}\n${FENCE}`), "");
  // Half a block inside a fence must not leave a growing empty box while it streams either.
  assert.equal(stripMemoryCitation("The answer.\n\n```\n<oai-mem-cit"), "The answer.");
});

test("a fence the reader asked for is never eaten", () => {
  // The block trails a real code block: that block's fences stay, because a blank line separates
  // them from the tag — a fence directly above the block is the wrapper, an earlier one is not.
  assert.equal(stripMemoryCitation("```\nkeep me\n```\n\n" + BLOCK), "```\nkeep me\n```");
  assert.equal(stripMemoryCitation("```\n<div>x</div>\n```\n\n" + BLOCK), "```\n<div>x</div>\n```");
  assert.equal(stripMemoryCitation("```\nconst a = `<b`;\n```\n\n" + BLOCK), "```\nconst a = `<b`;\n```");
  // Not fence lines at all: a marker inside prose, or one sharing its line with other text.
  assert.equal(stripMemoryCitation("Use ``` to quote.\n\n" + BLOCK), "Use ``` to quote.");
  assert.equal(stripMemoryCitation("x\n``` and prose " + BLOCK), "x\n``` and prose");
  // A wrapper whose closer does not match its opener: the block still goes, and no pair of the
  // reader's own fences is destroyed.
  assert.doesNotMatch(stripMemoryCitation("Ans.\n\n```\n" + BLOCK + "\n``"), /oai-mem-citation/);
});
