import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, mkdir, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { promisify } from "node:util";
import { readGitStatus } from "../src/main/workspace-git.ts";
import { fileTreeGit } from "../src/renderer/src/lib/file-tree-git.ts";

const exec = promisify(execFile);

test("real Git status decorates literal paths, renames and every untracked descendant", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "fastvibe-tree-git-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const git = (...args: string[]) => exec("git", ["-C", root, ...args]);
  await git("init", "-b", "main");
  await mkdir(join(root, "src"));
  for (const path of ["src/中文.ts", "old.ts", "outside.ts", ".gitignore"]) {
    await writeFile(join(root, path), path === ".gitignore" ? "ignored/\n" : "original\n");
  }
  await git("add", ".");
  await git("-c", "user.name=Test", "-c", "user.email=test@example.com", "commit", "-m", "Initial");
  await git("config", "status.relativePaths", "false");
  await writeFile(join(root, "src/中文.ts"), "changed\n");
  await writeFile(join(root, "outside.ts"), "changed\n");
  await rename(join(root, "old.ts"), join(root, "新 名称.ts"));
  await git("add", "old.ts", "新 名称.ts");
  await mkdir(join(root, "src/new/deep"), { recursive: true });
  await writeFile(join(root, "src/new/deep/ file -> name.ts "), "new\n");
  await writeFile(join(root, "src/new/line\nbreak.ts"), "new\n");
  await mkdir(join(root, "ignored"));
  await writeFile(join(root, "ignored/skip.ts"), "ignored\n");

  const status = await readGitStatus(root);
  assert.equal(status.isRepository, true);
  assert.equal(status.branch, "main");
  assert.equal(status.changed, 5);
  assert.equal(status.staged, 1);
  assert.equal(status.additions, 2);
  assert.equal(status.deletions, 2);
  assert.ok(status.files.some((file) => file.path === "新 名称.ts" && file.index === "R"));
  assert.ok(status.files.some((file) => file.path === "src/new/deep/ file -> name.ts " && file.index === "?"));
  assert.ok(status.files.some((file) => file.path === "src/new/line\nbreak.ts"));
  const tree = fileTreeGit(status);
  assert.equal(tree.files.get("src/中文.ts")?.badge, "M");
  assert.equal(tree.files.get("新 名称.ts")?.badge, "R");
  assert.equal(tree.directories.get("src/new/deep")?.badge, "U");
  assert.equal(tree.directories.get("src")?.badge, "M");

  const nested = await readGitStatus(join(root, "src"));
  assert.ok(nested.files.some((file) => file.path === "中文.ts"));
  const nestedTree = fileTreeGit(nested);
  assert.equal(nestedTree.files.get("中文.ts")?.badge, "M");
  assert.equal(nestedTree.directories.get("new/deep")?.badge, "U");
  assert.equal(nestedTree.files.has("../outside.ts"), false);

  await git("add", ".");
  await git("-c", "user.name=Test", "-c", "user.email=test@example.com", "commit", "-m", "Changes");
  assert.equal(fileTreeGit(await readGitStatus(root)).files.size, 0);
});

test("a new repository has a branch and staged decorations before its first commit", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "fastvibe-tree-unborn-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  assert.equal((await readGitStatus(root)).isRepository, false);
  await exec("git", ["-C", root, "init", "-b", "main"]);
  await writeFile(join(root, "new.ts"), "new\n");
  await exec("git", ["-C", root, "add", "new.ts"]);
  const status = await readGitStatus(root);
  assert.equal(status.branch, "main");
  assert.equal(status.additions, 1);
  assert.equal(status.staged, 1);
  assert.equal(fileTreeGit(status).files.get("new.ts")?.badge, "A");
});
