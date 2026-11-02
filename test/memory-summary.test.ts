import test from "node:test";
import assert from "node:assert/strict";
import { boundedMemorySummary, SUMMARY_PROMPT_MAX_CHARS, summaryBudgetProblem } from "../src/main/engine/memory-summary.ts";

const entry = (name: string, size = 250) => `- ${name}: keyword-${name}\n  - desc: ${"detail ".repeat(Math.ceil(size / 7))}\n  - learnings: end-${name}`;
const scope = (name: string) => `### /projects/${name}\n\n#### 2026-10-29\n\n${Array.from({ length: 25 }, (_, index) => entry(`${name}-${index}`)).join("\n")}`;
const oversized = () => `v1\n\n## User Profile\n\n${"profile ".repeat(1200)}\n\n## User preferences\n\n${Array.from({ length: 40 }, (_, index) => entry(`preference-${index}`)).join("\n")}\n\n## General Tips\n\n${Array.from({ length: 40 }, (_, index) => entry(`tip-${index}`)).join("\n")}\n\n## What's in Memory\n\n${["alpha", "beta", "gamma", "delta"].map(scope).join("\n\n")}\n\n### Older Memory Topics\n\n#### /projects/older\n\n${Array.from({ length: 25 }, (_, index) => entry(`older-${index}`)).join("\n")}`;

test("summaries within budget keep every byte of their trimmed content", () => {
  for (const text of ["v1\nshort", "v1\n" + "中".repeat(SUMMARY_PROMPT_MAX_CHARS - 3)]) {
    assert.equal(boundedMemorySummary(`\n${text}\n`, "/mem"), text);
    assert.equal(summaryBudgetProblem(text), undefined);
  }
  assert.match(summaryBudgetProblem("x".repeat(SUMMARY_PROMPT_MAX_CHARS + 1))!, /20001 characters; maximum is 20000/);
});

test("large preferences cannot crowd out routing scopes or the last older topics", () => {
  const summary = oversized();
  assert.ok(summary.length > SUMMARY_PROMPT_MAX_CHARS * 3);
  assert.ok(summary.indexOf("## What's in Memory") > SUMMARY_PROMPT_MAX_CHARS);
  const result = boundedMemorySummary(summary, "/memory folder");
  assert.ok(result.length <= SUMMARY_PROMPT_MAX_CHARS);
  assert.match(result, /^v1\n/);
  for (const name of ["alpha", "beta", "gamma", "delta", "older"]) {
    assert.ok(result.includes(`/projects/${name}`), `scope ${name} remains reachable`);
    assert.ok(result.includes(`keyword-${name}-0`));
  }
  assert.match(result, /## User preferences/);
  assert.match(result, /## General Tips/);
  assert.match(result, /Memory summary abridged; revision [a-f0-9]{16}/);
  assert.ok(result.includes("/memory folder/memory_summary.md with offset/limit"));
  assert.doesNotMatch(result, /…\(truncated\)/);
  // Every selected multiline topic retains its desc and learnings, never a cut-off prefix.
  const originals = [...summary.matchAll(/^- (.+?): keyword-(.+)\n  - desc: (.+)\n  - learnings: (.+)$/gm)].map((match) => match[0]);
  const selected = [...result.matchAll(/^- (.+?): keyword-(.+)\n  - desc: (.+)\n  - learnings: (.+)$/gm)].map((match) => match[0]);
  assert.ok(selected.length > 10);
  for (const block of selected) assert.ok(originals.includes(block));
  assert.equal((result.match(/^  - desc:/gm) ?? []).length, selected.length);
});

test("legacy multi-kilobyte topics retain complete routing titles in every scope/day", () => {
  const names = ["alpha", "beta", "gamma", "delta", "epsilon", "zeta"];
  const summary = `v1\n\n## User preferences\n${Array.from({ length: 100 }, (_, i) => entry(`pref-${i}`, 350)).join("\n")}\n\n## What's in Memory\n${names.map((name) => `### /projects/${name}\n\n${["2026-10-29", "2026-10-20", "2026-10-19"].map((day) => `#### ${day}\n\n- ${name}-${day}:\n  many-keywords, ${"keyword ".repeat(70)}\n  - desc: ${"long description ".repeat(200)}\n  - learnings: ${"details ".repeat(300)}`).join("\n\n")}`).join("\n\n")}`;
  const result = boundedMemorySummary(summary, "/mem");
  assert.ok(result.length <= SUMMARY_PROMPT_MAX_CHARS);
  for (const name of names) {
    assert.ok(result.includes(`### /projects/${name}`));
    for (const day of ["2026-10-29", "2026-10-20", "2026-10-19"]) {
      assert.ok(result.includes(`- ${name}-${day}\n  - Details: search MEMORY.md for this topic.`));
    }
  }
});

test("uneven sections lend unused space to the routing index", () => {
  const summary = `v1\n\n## User Profile\nsmall profile\n\n## What's in Memory\n${["alpha", "beta", "gamma"].map(scope).join("\n\n")}`;
  const result = boundedMemorySummary(summary, "/mem");
  assert.ok(result.length <= SUMMARY_PROMPT_MAX_CHARS);
  assert.ok(result.length > 16_000, "most budget goes to complete routing entries");
  assert.match(result, /small profile/);
});

test("an omitted-tail edit changes snapshot identity while output remains bounded", () => {
  const summary = oversized();
  const before = boundedMemorySummary(summary, "/mem");
  const after = boundedMemorySummary(summary + "\n\n" + "unselected tail ".repeat(3000), "/mem");
  assert.notEqual(before.match(/revision (\w+)/)?.[1], after.match(/revision (\w+)/)?.[1]);
  assert.equal(before, boundedMemorySummary(summary, "/mem"), "stable input has stable identity");
  assert.ok(after.length <= SUMMARY_PROMPT_MAX_CHARS);
});

test("oversized paragraphs and unknown layouts fall back to an actionable notice", () => {
  for (const text of ["中😀".repeat(25_000), `v1\n\n## Unknown\n${"x".repeat(60_000)}`]) {
    const result = boundedMemorySummary(text, "/mem");
    assert.ok(result.length <= SUMMARY_PROMPT_MAX_CHARS);
    assert.match(result, /Complete entries were omitted/);
    assert.match(result, /Search MEMORY.md/);
    assert.doesNotMatch(result, /\uFFFD/);
  }
});
