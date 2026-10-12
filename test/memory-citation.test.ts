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

test("the conversations a reply cites are read from its block, once each", () => {
  assert.deepEqual(memoryCitationIds(`The answer.\n\n${BLOCK}`), ["019c6e27-e55b-73d1-87d8-4e01f1f75043", "019c7714-3b77-74d1-9866-e1f484aae2ab"]);
  assert.deepEqual(memoryCitationIds("no block here"), []);
  assert.deepEqual(memoryCitationIds("<oai-mem-citation><rollout_ids>\n</rollout_ids></oai-mem-citation>"), []);
  assert.deepEqual(memoryCitationIds("<oai-mem-citation>\n<rollout_ids>\nunclosed"), []);
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
