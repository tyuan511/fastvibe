import assert from "node:assert/strict";
import test from "node:test";
import { selectGitChange, type GitChangeSelection } from "../src/renderer/src/lib/git-change-selection.ts";
const file = (path: string, index = " ", worktree = "M") => ({ path, index, worktree });
const cwd = "/repo";

test("opening changes selects a working change, falling back to staged files", () => {
  const staged = { id: "staged", source: "staged" as const, files: [file("staged.ts", "M", " ")] };
  const working = { id: "unstaged", source: "unstaged" as const, files: [file("working.ts")] };
  assert.equal(selectGitChange([staged, working], undefined, cwd)?.file.path, "working.ts");
  assert.equal(selectGitChange([staged], undefined, cwd)?.source, "staged");
  assert.equal(selectGitChange([], undefined, cwd), undefined);
});

test("conflicts take priority on initial open without replacing the user's existing choice", () => {
  const workingFile = file("working.ts");
  const groups = [
    { id: "unstaged", source: "unstaged" as const, files: [workingFile] },
    { id: "conflicts", source: "unstaged" as const, files: [file("conflict.ts", "U", "U")] },
  ];
  const current: GitChangeSelection = { file: workingFile, source: "unstaged" };
  assert.equal(selectGitChange(groups, undefined, cwd)?.file.path, "conflict.ts");
  assert.equal(selectGitChange(groups, current, cwd), current);
});

test("staging keeps the selected path and switches its diff to the staged source", () => {
  const current: GitChangeSelection = { file: file("selected.ts"), source: "unstaged" };
  const groups = [
    { id: "staged", source: "staged" as const, files: [file("selected.ts", "M", " ")] },
    { id: "unstaged", source: "unstaged" as const, files: [file("other.ts")] },
  ];
  const selected = selectGitChange(groups, current, cwd);
  assert.equal(selected?.file.path, "selected.ts");
  assert.equal(selected?.source, "staged");
});

test("explicit file focus resolves an absolute path, and a different revision starts at its own first file", () => {
  const groups = [{ id: "comparison", source: "branch" as const, files: [file("first.ts"), file("second.ts")] }];
  const focused: GitChangeSelection = { file: file("/repo/second.ts"), source: "branch", revision: "old" };
  assert.equal(selectGitChange(groups, focused, cwd, "old")?.file.path, "second.ts");
  const next = selectGitChange(groups, focused, cwd, "new");
  assert.equal(next?.file.path, "first.ts");
  assert.equal(next?.revision, "new");
});
