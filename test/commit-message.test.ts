import { test } from "node:test";
import assert from "node:assert/strict";
import {
  buildCommitMessagePlan,
  classifyCommitFile,
  countPatchLines,
  parseCommitPorcelain,
  samplePatch,
  type CommitFileMaterial,
} from "../src/main/engine/commit-message.ts";

test("commit context classifies high-noise files without treating every config as generated", () => {
  assert.equal(classifyCommitFile("pnpm-lock.yaml"), "lock");
  assert.equal(classifyCommitFile("dist/app.min.js"), "generated");
  assert.equal(classifyCommitFile("src/generated-client.ts", "// DO NOT EDIT\nexport {}"), "generated");
  assert.equal(classifyCommitFile("package.json"), "config");
  assert.equal(classifyCommitFile("src/auth/login.test.ts"), "test");
  assert.equal(classifyCommitFile("src/auth/login.ts"), "source");
});

test("porcelain paths stay literal and rename records use their NUL-delimited source", () => {
  const parsed = parseCommitPorcelain([
    "?? 中文 -> literal.ts",
    "R  新 名称.ts",
    "旧 名称.ts",
    " M line\nbreak.ts",
    "",
  ].join("\0"));
  assert.deepEqual(parsed, [
    { path: "中文 -> literal.ts", displayPath: "中文 -> literal.ts", index: "?", worktree: "?" },
    { path: "新 名称.ts", displayPath: "旧 名称.ts → 新 名称.ts", index: "R", worktree: " " },
    { path: "line\nbreak.ts", displayPath: "line\nbreak.ts", index: " ", worktree: "M" },
  ]);
});

test("patch line counts ignore unified diff headers", () => {
  const stats = countPatchLines("--- a/a.ts\n+++ b/a.ts\n@@ -1 +1,2 @@\n-old\n+new\n+more");
  assert.deepEqual(stats, { additions: 2, deletions: 1 });
});

test("hunk sampling keeps evidence from the beginning and end", () => {
  const patch = [
    "diff --git a/a.ts b/a.ts",
    "@@ -1 +1 @@ first",
    `-${"a".repeat(500)}`,
    `+${"b".repeat(500)}`,
    "@@ -20 +20 @@ middle",
    `-${"c".repeat(500)}`,
    `+${"d".repeat(500)}`,
    "@@ -40 +40 @@ last",
    `-${"e".repeat(500)}`,
    `+${"f".repeat(500)}`,
  ].join("\n");
  const sampled = samplePatch(patch, 1_400);
  assert.match(sampled, /first/);
  assert.match(sampled, /last/);
  assert.ok(sampled.length <= 1_400);
});

test("a medium plan gives every file metadata and does not let a lockfile consume diff budget", () => {
  const files: CommitFileMaterial[] = [
    { path: "pnpm-lock.yaml", status: " M", patch: "+".repeat(30_000) },
    { path: "src/a.ts", status: " M", patch: "@@ -1 +1 @@\n-old\n+new" },
    { path: "src/b.ts", status: " M", patch: "@@ -1 +1 @@\n-before\n+after" },
  ];
  const plan = buildCommitMessagePlan(files, { directBudget: 2_000 });
  const grouped = plan.groups.join("\n");
  assert.match(grouped, /pnpm-lock\.yaml/);
  assert.match(grouped, /src\/a\.ts/);
  assert.match(grouped, /src\/b\.ts/);
  assert.doesNotMatch(grouped, /\+{100}/);
  assert.match(grouped, /old/);
  assert.match(grouped, /before/);
});

test("large changes use bounded groups while the overview still covers every file", () => {
  const files: CommitFileMaterial[] = Array.from({ length: 96 }, (_, index) => ({
    path: `pkg-${index}/src/file-${index}.ts`,
    status: " M",
    patch: `@@ -1 +1 @@\n-old${index}\n+new${index}\n${"x".repeat(2_000)}`,
  }));
  const plan = buildCommitMessagePlan(files, { directBudget: 8_000, groupBudget: 3_000, maxGroups: 8 });
  assert.equal(plan.mode, "hierarchical");
  assert.ok(plan.groups.length <= 8);
  assert.ok(plan.groups.every((group) => group.length <= 3_000));
  const grouped = plan.groups.join("\n");
  for (const file of files) assert.match(grouped, new RegExp(file.path.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
});
