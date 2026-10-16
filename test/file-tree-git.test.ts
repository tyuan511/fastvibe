import assert from "node:assert/strict";
import { test } from "node:test";
import type { GitStatus } from "../src/shared/ipc.ts";
import { fileTreeGit } from "../src/renderer/src/lib/file-tree-git.ts";

function status(files: GitStatus["files"]): GitStatus {
  return { cwd: "/repo", isRepository: true, changed: files.length, staged: 0, additions: 0, deletions: 0, files };
}

test("tree decorations cover staged, working-tree and untracked states", () => {
  const git = fileTreeGit(status([
    { path: "modified.ts", index: " ", worktree: "M" },
    { path: "staged.ts", index: "M", worktree: " " },
    { path: "new.ts", index: "?", worktree: "?" },
    { path: "added.ts", index: "A", worktree: " " },
    { path: "renamed.ts", index: "R", worktree: " " },
    { path: "copied.ts", index: "C", worktree: " " },
    { path: "type.ts", index: " ", worktree: "T" },
    { path: "deleted.ts", index: "M", worktree: "D" },
    { path: "added-then-edited.ts", index: "A", worktree: "M" },
  ]));
  assert.deepEqual([...git.files.values()].map((item) => item.badge), ["M", "M", "U", "A", "R", "C", "T", "D", "M"]);
  assert.equal(git.files.get("new.ts")?.label, "git.untracked");
  assert.equal(git.files.has("clean.ts"), false);
});

test("all unmerged combinations are conflicts, including both-added and both-deleted", () => {
  for (const xy of ["DD", "AU", "UD", "UA", "DU", "AA", "UU"]) {
    const git = fileTreeGit(status([{ path: "src/conflict.ts", index: xy[0], worktree: xy[1] }]));
    assert.equal(git.files.get("src/conflict.ts")?.badge, "!", xy);
    assert.equal(git.directories.get("src")?.label, "git.conflict", xy);
  }
});

test("collapsed ancestors include deleted descendants and prefer conflicts over modifications", () => {
  const input = [
    { path: "src/new/file.ts", index: "?", worktree: "?" },
    { path: "src/changed/file.ts", index: " ", worktree: "M" },
    { path: "src/deleted/file.ts", index: " ", worktree: "D" },
    { path: "src/conflict/file.ts", index: "U", worktree: "U" },
  ];
  for (const files of [input, [...input].reverse()]) {
    const git = fileTreeGit(status(files));
    assert.equal(git.directories.get("src")?.label, "git.conflict");
    assert.equal(git.directories.get("src/new")?.label, "git.untracked");
    assert.equal(git.directories.get("src/deleted")?.label, "git.deleted");
    assert.equal(git.directories.has("sr"), false);
    assert.equal(git.directories.has(""), false);
  }
  assert.equal(fileTreeGit(status(input.slice(0, 3))).directories.get("src")?.label, "git.modified");
});

test("subfolder roots exclude sibling changes and keep literal Unicode and whitespace", () => {
  const git = fileTreeGit(status([
    { path: "../sibling/file.ts", index: " ", worktree: "M" },
    { path: " 新目录/中文 -> 文件.ts ", index: "?", worktree: "?" },
  ]));
  assert.deepEqual([...git.files.keys()], [" 新目录/中文 -> 文件.ts "]);
  assert.deepEqual([...git.directories.keys()], [" 新目录"]);
  assert.equal(fileTreeGit(status([])).files.size, 0);
  assert.equal(fileTreeGit(null).files.size, 0);
  assert.equal(fileTreeGit({ ...status([...git.files].map(([path]) => ({ path, index: "?", worktree: "?" }))), isRepository: false }).files.size, 0);
});
