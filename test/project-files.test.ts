import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, mkdir, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { promisify } from "node:util";
import { rankProjectFiles, searchProjectFiles } from "../src/main/engine/project-files.ts";

const execFileAsync = promisify(execFile);

test("ranking prefers the file name, then a path, and stays case-insensitive", () => {
  const files = [
    "README.md",
    "src/App.tsx",
    "src/components/chat/composer.tsx",
    "src/components/chat/compact-notice.tsx",
    "docs/composer-notes.md",
  ];
  assert.equal(rankProjectFiles(files, "composer", 12)[0], "src/components/chat/composer.tsx");
  assert.equal(rankProjectFiles(files, "APP", 12)[0], "src/App.tsx");
  assert.equal(rankProjectFiles(files, "src/app", 12)[0], "src/App.tsx");
  assert.deepEqual(rankProjectFiles(files, "nope", 12), []);
  assert.equal(rankProjectFiles(files, "", 2)[0], "README.md");
});

test("a non-git project lists real files and skips hidden trees and symlinks", async () => {
  const root = await mkdtemp(join(tmpdir(), "fastvibe-files-"));
  await mkdir(join(root, "src"), { recursive: true });
  await mkdir(join(root, "node_modules", "pkg"), { recursive: true });
  await writeFile(join(root, "src", "main.ts"), "export {};");
  await writeFile(join(root, "node_modules", "pkg", "index.js"), "");
  await symlink(join(root, "src", "main.ts"), join(root, "linked.ts"));

  const hits = await searchProjectFiles(root, "main");
  assert.deepEqual(hits.map((item) => item.relative), ["src/main.ts"]);
  assert.equal(hits[0]?.path, join(root, "src", "main.ts"));
  assert.deepEqual(await searchProjectFiles(join(root, "missing"), ""), []);
});

test("a git work tree lists tracked and untracked files, not ignored ones", async () => {
  const root = await mkdtemp(join(tmpdir(), "fastvibe-git-files-"));
  await mkdir(join(root, "src"), { recursive: true });
  await mkdir(join(root, "node_modules"), { recursive: true });
  await writeFile(join(root, ".gitignore"), "node_modules\n");
  await writeFile(join(root, "src", "kept.ts"), "export {};");
  await writeFile(join(root, "src", "fresh.ts"), "export {};");
  await writeFile(join(root, "node_modules", "skip.js"), "");
  await execFileAsync("git", ["init"], { cwd: root });
  await execFileAsync("git", ["add", "src/kept.ts", ".gitignore"], { cwd: root });

  const hits = await searchProjectFiles(root, "");
  const relative = hits.map((item) => item.relative).sort();
  assert.ok(relative.includes("src/kept.ts"));
  assert.ok(relative.includes("src/fresh.ts"));
  assert.equal(relative.some((item) => item.includes("node_modules")), false);
});
