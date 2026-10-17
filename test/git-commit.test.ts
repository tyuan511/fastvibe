import assert from "node:assert/strict";
import test from "node:test";
import { performGitCommit } from "../src/renderer/src/lib/git-commit.ts";
import type { GitStatus } from "../src/shared/ipc.ts";
const status: GitStatus = { cwd: "/repo", isRepository: true, changed: 1, staged: 0, additions: 1, deletions: 0, files: [] };

test("commit and sync reports local success before pulling and pushing", async () => {
  const order: string[] = [];
  const result = await performGitCommit("commit-sync", "Update", {
    commit: async () => { order.push("commit"); return status; },
    pull: async () => { order.push("pull"); return status; },
    push: async () => { order.push("push"); return status; },
  }, () => order.push("committed"));
  assert.deepEqual(order, ["commit", "committed", "pull", "push"]);
  assert.equal(result.ok, true);
});

test("push failure preserves the successful commit outcome and clears its draft once", async () => {
  let completed = 0;
  let commits = 0;
  const failure = new Error("push rejected");
  const result = await performGitCommit("commit-push", "Update", {
    commit: async () => { commits++; return status; },
    pull: async () => { assert.fail("push action must not pull"); },
    push: async () => { throw failure; },
  }, () => completed++);
  assert.equal(commits, 1);
  assert.equal(completed, 1);
  assert.deepEqual(result, { ok: false, phase: "push", status, error: failure });
});

test("a failed pull stops sync before push, while a failed commit keeps the draft", async () => {
  for (const failAt of ["commit", "pull"] as const) {
    let committed = false;
    const failure = new Error(failAt);
    const result = await performGitCommit("commit-sync", "Update", {
      commit: async () => { if (failAt === "commit") throw failure; return status; },
      pull: async () => { throw failure; },
      push: async () => { assert.fail("must not push after a failed preceding step"); },
    }, () => { committed = true; });
    assert.equal(committed, failAt !== "commit");
    assert.deepEqual(result, { ok: false, phase: failAt, status: failAt === "commit" ? undefined : status, error: failure });
  }
});

test("amend forwards the option and never invokes a network follow-up", async () => {
  const result = await performGitCommit("amend", "", {
    commit: async (message, options) => { assert.equal(message, ""); assert.deepEqual(options, { amend: true }); return status; },
    pull: async () => { assert.fail("amend must not pull"); },
    push: async () => { assert.fail("amend must not push"); },
  }, () => {});
  assert.equal(result.ok, true);
});
