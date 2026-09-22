import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { ConversationCatalog } from "../src/main/engine/conversation-catalog.ts";
import {
  defaultWorktreeDir,
  defaultWorktreePath,
  expandUserPath,
  isManagedWorktreePath,
  parseWorktreePorcelain,
  sanitizeSegment,
  worktreeHome,
} from "../src/main/engine/worktree.ts";

test("default worktree paths live under ~/.fastvibe/worktree/<project-name>", () => {
  const home = "/Users/demo";
  assert.equal(worktreeHome(home), join(home, ".fastvibe", "worktree"));
  assert.equal(defaultWorktreeDir("FastVibe", home), join(home, ".fastvibe", "worktree", "fastvibe"));
  assert.equal(
    defaultWorktreePath("FastVibe", "feat auth", home),
    join(home, ".fastvibe", "worktree", "fastvibe", "feat-auth"),
  );
});

test("sanitizeSegment strips junk and keeps a usable folder name", () => {
  assert.equal(sanitizeSegment("Feat: Auth / Login"), "feat-auth-login");
  assert.equal(sanitizeSegment("..."), "");
  assert.equal(sanitizeSegment("A".repeat(80)).length, 64);
});

test("expandUserPath resolves a leading tilde against the given home", () => {
  assert.equal(expandUserPath("~/wt/demo", "/Users/demo"), join("/Users/demo", "wt", "demo"));
  assert.equal(expandUserPath("~", "/Users/demo"), "/Users/demo");
  assert.equal(expandUserPath("/abs/path", "/Users/demo"), "/abs/path");
});

test("isManagedWorktreePath only matches FastVibe-owned roots", () => {
  const home = "/Users/demo";
  const owned = join(home, ".fastvibe", "worktree", "fastvibe", "run-abc");
  const extra = join("/tmp", "app-wt");
  assert.equal(isManagedWorktreePath(owned, [], home), true);
  assert.equal(isManagedWorktreePath(join(extra, "run"), [extra], home), true);
  assert.equal(isManagedWorktreePath("/Users/demo/code/fastvibe", [], home), false);
  assert.equal(isManagedWorktreePath(join(home, ".fastvibe-other", "wt"), [], home), false);
});

test("parseWorktreePorcelain reads path, branch and detached HEAD", () => {
  const parsed = parseWorktreePorcelain(
    [
      "worktree /repo",
      "HEAD abc",
      "branch refs/heads/main",
      "",
      "worktree /repo/.fastvibe/wt/run",
      "HEAD def",
      "detached",
      "",
    ].join("\n"),
  );
  assert.deepEqual(parsed, [
    { path: "/repo", head: "abc", branch: "main" },
    { path: "/repo/.fastvibe/wt/run", head: "def", detached: true },
  ]);
});

test("catalog setWorktree binds cwd to the checkout and keeps the project", async () => {
  const dir = mkdtempSync(join(tmpdir(), "fastvibe-wt-catalog-"));
  const cat = new ConversationCatalog(join(dir, "conversations.json"), join(dir, "scratch"));
  const created = cat.create("/tmp/demo");
  const updated = cat.setWorktree(created.id, { path: "/tmp/wt/demo", branch: "fastvibe/run" });
  assert.equal(updated?.project, "/tmp/demo");
  assert.equal(updated?.cwd, "/tmp/wt/demo");
  assert.deepEqual(updated?.worktree, { path: "/tmp/wt/demo", branch: "fastvibe/run" });

  const restored = cat.setWorktree(created.id, undefined);
  assert.equal(restored?.cwd, "/tmp/demo");
  assert.equal(restored?.worktree, undefined);
});

test("catalog setProject clears a bound worktree and restores cwd", () => {
  const dir = mkdtempSync(join(tmpdir(), "fastvibe-wt-project-"));
  const cat = new ConversationCatalog(join(dir, "conversations.json"), join(dir, "scratch"));
  const created = cat.create("/tmp/demo");
  cat.setWorktree(created.id, { path: "/tmp/wt/demo", branch: "fastvibe/run" });
  const next = cat.setProject(created.id, "/tmp/other");
  assert.equal(next?.project, "/tmp/other");
  assert.equal(next?.cwd, "/tmp/other");
  assert.equal(next?.worktree, undefined);
  assert.equal(resolve(next?.cwd ?? ""), resolve("/tmp/other"));
});
