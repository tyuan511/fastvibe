import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import { performGitCommit, type GitCommitAction } from "../src/renderer/src/lib/git-commit.ts";
import { commitGitChanges, stageGitFiles } from "../src/main/source-control.ts";
import { collectCommitMessageMaterial, readCommitStatusFiles } from "../src/main/workspace-git.ts";
import type { GitStatus } from "../src/shared/ipc.ts";
const exec = promisify(execFile);
const status: GitStatus = { cwd: "/repo", isRepository: true, changed: 1, staged: 0, additions: 1, deletions: 0, files: [] };
const staged: GitStatus = { ...status, staged: 1 };

for (const action of ["commit", "commit-push"] as GitCommitAction[]) {
  test(`${action} stages all changes and generates an empty message before committing`, async () => {
    const order: string[] = [];
    const result = await performGitCommit(action, "  ", {
      stageAll: async () => { order.push("stage"); return staged; },
      generateMessage: async () => { order.push("generate"); return "Generated message"; },
      commit: async (message) => { assert.equal(message, "Generated message"); order.push("commit"); return status; },
      push: async () => { order.push("push"); return status; },
    }, () => order.push("committed"));
    assert.deepEqual(order, ["stage", "generate", "commit", "committed", ...(action === "commit-push" ? ["push"] : [])]);
    assert.deepEqual(result, { ok: true, status, message: "Generated message" });
  });

  test(`${action} uses a manually supplied message and still stages all files`, async () => {
    const order: string[] = [];
    const result = await performGitCommit(action, "  Custom subject\n\nBody  ", {
      stageAll: async () => { order.push("stage"); return staged; },
      generateMessage: async () => { assert.fail("keep the user's message"); },
      commit: async (message) => { assert.equal(message, "Custom subject\n\nBody"); order.push("commit"); return status; },
      push: async () => { order.push("push"); return status; },
    }, () => order.push("committed"));
    assert.deepEqual(order, ["stage", "commit", "committed", ...(action === "commit-push" ? ["push"] : [])]);
    assert.equal(result.ok, true);
  });
}

test("push failure preserves the successful commit outcome and clears its draft once", async () => {
  let completed = 0;
  let commits = 0;
  const failure = new Error("push rejected");
  const result = await performGitCommit("commit-push", "Update", {
    stageAll: async () => staged,
    generateMessage: async () => { assert.fail("message already supplied"); },
    commit: async () => { commits++; return status; },
    push: async () => { throw failure; },
  }, () => completed++);
  assert.equal(commits, 1);
  assert.equal(completed, 1);
  assert.deepEqual(result, { ok: false, phase: "push", status, error: failure });
});

test("staging, generation and commit failures stop before push and keep the draft", async () => {
  for (const failAt of ["stage", "generate", "commit"] as const) {
    const order: string[] = [];
    const failure = new Error(failAt);
    const result = await performGitCommit("commit-push", "", {
      stageAll: async () => { order.push("stage"); if (failAt === "stage") throw failure; return staged; },
      generateMessage: async () => { order.push("generate"); if (failAt === "generate") throw failure; return "Generated"; },
      commit: async () => { order.push("commit"); throw failure; },
      push: async () => { assert.fail("must not push after an earlier failure"); },
    }, () => { assert.fail("must keep draft after an earlier failure"); });
    assert.deepEqual(order, ["stage", "generate", "commit"].slice(0, ["stage", "generate", "commit"].indexOf(failAt) + 1));
    assert.deepEqual(result, { ok: false, phase: failAt, status: failAt === "stage" ? undefined : staged, error: failure });
  }
});

test("one-click commit includes partial staging, untracked files and deletions across the repository", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "fastvibe-one-click-commit-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const git = async (...args: string[]) => (await exec("git", ["-C", root, ...args])).stdout;
  await git("init", "-b", "main");
  await git("config", "user.name", "Test");
  await git("config", "user.email", "test@example.com");
  await mkdir(join(root, "nested"));
  await writeFile(join(root, "nested/tracked.txt"), "base\n");
  await writeFile(join(root, "deleted.txt"), "remove\n");
  await stageGitFiles(root, undefined, true);
  await commitGitChanges(root, "Initial");
  await writeFile(join(root, "nested/tracked.txt"), "partial\n");
  await stageGitFiles(root, ["nested/tracked.txt"]);
  await writeFile(join(root, "nested/tracked.txt"), "latest\n");
  await writeFile(join(root, "new.txt"), "new\n");
  await rm(join(root, "deleted.txt"));
  const cwd = join(root, "nested");
  let completed = 0;
  const result = await performGitCommit("commit", "", {
    stageAll: () => stageGitFiles(cwd, undefined, true),
    generateMessage: async () => {
      const files = await collectCommitMessageMaterial(root, await readCommitStatusFiles(root), true);
      assert.deepEqual(files.map((file) => file.path).sort(), ["deleted.txt", "nested/tracked.txt", "new.txt"]);
      const tracked = files.find((file) => file.path === "nested/tracked.txt")!;
      assert.match(tracked.patch!, /\+latest/);
      assert.doesNotMatch(tracked.patch!, /\+partial/);
      return "Update all changes";
    },
    commit: (message) => commitGitChanges(cwd, message),
    push: async () => { assert.fail("local commit must not push"); },
  }, () => completed++);
  assert.equal(result.ok, true);
  assert.equal(completed, 1);
  assert.equal(await git("status", "--porcelain"), "");
  assert.equal(await git("show", "HEAD:nested/tracked.txt"), "latest\n");
  assert.equal(await git("show", "HEAD:new.txt"), "new\n");
  assert.equal((await git("log", "-1", "--format=%s")).trim(), "Update all changes");
  assert.equal((await git("rev-list", "--count", "HEAD")).trim(), "2");
});
