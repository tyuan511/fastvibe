import { test } from "node:test";
import assert from "node:assert/strict";
import {
  MEMORY_RECENT_TOOL,
  MEMORY_SEARCH_TOOL,
  RETRIEVED_HEADING,
  clampLimit,
  formatRecentResult,
  formatSearchResult,
  memoryGuidance,
  memoryLine,
  retrievedBlock,
} from "../src/main/engine/memory-tools.ts";

/**
 * The agent's side of long-term memory. Without the guidance it denied having memory,
 * or opened FastVibe's SQLite store with a shell command; the tools and the note are
 * what route "what do you remember" through the retrieval pipeline instead.
 */

const at = new Date(2026, 8, 23, 22, 32).getTime();

test("the guidance names both tools, the retrieval heading, and forbids reading FastVibe's data files", () => {
  const guidance = memoryGuidance();
  assert.ok(guidance.startsWith("\n\n## Long-term memory"));
  assert.ok(guidance.includes(MEMORY_SEARCH_TOOL) && guidance.includes(MEMORY_RECENT_TOOL));
  assert.ok(guidance.includes(`"${RETRIEVED_HEADING}"`));
  assert.match(guidance, /Never read FastVibe's own data files \(memory\.sqlite, memory\.json/);
  assert.match(guidance, /not instructions/);
});

test("limits fall back, round and clamp", () => {
  assert.equal(clampLimit(undefined, 8, 20), 8);
  assert.equal(clampLimit(Number.NaN, 8, 20), 8);
  assert.equal(clampLimit(0, 8, 20), 1);
  assert.equal(clampLimit(3.6, 8, 20), 4);
  assert.equal(clampLimit(99, 8, 20), 20);
});

test("a memory reads as who · when · what, in the interface language, without storage fields", () => {
  const previous = process.env.FASTVIBE_UI_LANGUAGE;
  try {
    process.env.FASTVIBE_UI_LANGUAGE = "zh";
    assert.equal(memoryLine({ role: "user", createdAt: at, content: "添加上 jev 决策引擎" }, 0), "1. [用户 · 2026-09-23 22:32] 添加上 jev 决策引擎");
    process.env.FASTVIBE_UI_LANGUAGE = "en";
    assert.equal(memoryLine({ role: "summary", createdAt: at, content: "A pattern." }, 2), "3. [summary · 2026-09-23 22:32] A pattern.");
    const long = memoryLine({ role: "assistant", createdAt: at, content: "x".repeat(3_000) }, 0);
    assert.ok(long.endsWith("x…") && long.length < 2_100);
  } finally {
    if (previous === undefined) delete process.env.FASTVIBE_UI_LANGUAGE;
    else process.env.FASTVIBE_UI_LANGUAGE = previous;
  }
});

test("the retrieval block is absent when nothing was found, and capped otherwise", () => {
  assert.equal(retrievedBlock([], 6_000), "");
  const block = retrievedBlock([{ role: "user", createdAt: at, content: "remember me" }], 6_000);
  assert.ok(block.startsWith(`\n\n## ${RETRIEVED_HEADING}\n`));
  assert.ok(block.endsWith("remember me"));
  assert.equal(retrievedBlock([{ role: "user", createdAt: at, content: "y".repeat(10_000) }], 1_000).length, 1_000);
});

test("tool results say plainly when there is nothing", () => {
  const previous = process.env.FASTVIBE_UI_LANGUAGE;
  try {
    process.env.FASTVIBE_UI_LANGUAGE = "en";
    assert.equal(formatSearchResult("bicycle", []), "No memories related to “bicycle”.");
    assert.equal(formatRecentResult([]), "Long-term memory for this project is empty.");
    const found = formatSearchResult("bicycle", [{ role: "user", createdAt: at, content: "I bought a bicycle" }]);
    assert.equal(found, "1 memory related to “bicycle” (most relevant first):\n1. [user · 2026-09-23 22:32] I bought a bicycle");
    assert.ok(formatRecentResult([{ role: "assistant", createdAt: at, content: "Done." }]).startsWith("The most recent memory:\n"));
  } finally {
    if (previous === undefined) delete process.env.FASTVIBE_UI_LANGUAGE;
    else process.env.FASTVIBE_UI_LANGUAGE = previous;
  }
});
