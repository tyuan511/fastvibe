import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { ConversationCatalog } from "../src/main/engine/conversation-catalog.ts";
import {
  buildProjectFoldersPrompt,
  displayProjectPath,
  extraFolders,
  projectFolderPaths,
  rekeyProjectSettings,
} from "../src/shared/project-folders.ts";

test("a single folder produces no prompt", () => {
  assert.equal(buildProjectFoldersPrompt("/repo", [{ path: "/repo", primary: true, repository: true, branch: "main" }]), undefined);
});

test("extra folders are listed with the working directory called out", () => {
  const prompt = buildProjectFoldersPrompt("/repo-a", [
    { path: "/repo-a", primary: true, repository: true, branch: "main" },
    { path: "/repo-b", primary: false, repository: false },
  ], { worktree: true });
  assert.ok(prompt);
  assert.match(prompt!, /Current working directory: \/repo-a/);
  assert.match(prompt!, /\/repo-b \(additional folder; not a git repository\)/);
  assert.match(prompt!, /worktree/);
});

test("paths outside the working directory are prefixed with the folder name", () => {
  assert.equal(displayProjectPath("/repo-a/src/a.ts", "/repo-a", ["/repo-a", "/repo-b"]), "src/a.ts");
  assert.equal(displayProjectPath("/repo-b/README.md", "/repo-a", ["/repo-a", "/repo-b"]), "repo-b/README.md");
});

test("extra folders drop the primary path and duplicates", () => {
  assert.equal(extraFolders("/a", ["/a", "/b", "/b", "  "])?.join(","), "/b");
  assert.deepEqual(projectFolderPaths({ cwd: "/a" }), ["/a"]);
});

test("setting a primary folder rekeys conversations and follows an untouched name", () => {
  const dir = mkdtempSync(join(tmpdir(), "fastvibe-folders-"));
  const catalog = new ConversationCatalog(join(dir, "conversations.json"), join(dir, "scratch"));
  const created = catalog.createProject(["/repo-a", "/repo-b"]);
  assert.equal(created?.cwd, "/repo-a");
  assert.equal(created?.name, "repo-a");
  const chat = catalog.create("/repo-a", { cwd: "/repo-a" });
  const moved = catalog.setProjectPrimary("/repo-a", "/repo-b");
  assert.equal(moved?.project.cwd, "/repo-b");
  assert.equal(moved?.project.name, "repo-b");
  assert.deepEqual(moved?.project.folders, ["/repo-a"]);
  assert.equal(catalog.get(chat.id)?.project, "/repo-b");
  assert.equal(catalog.get(chat.id)?.cwd, "/repo-a");
});

test("a renamed project keeps its name when the primary folder changes", () => {
  const dir = mkdtempSync(join(tmpdir(), "fastvibe-folders-"));
  const catalog = new ConversationCatalog(join(dir, "conversations.json"), join(dir, "scratch"));
  catalog.createProject(["/repo-a", "/repo-b"], "My app");
  const moved = catalog.setProjectPrimary("/repo-a", "/repo-b");
  assert.equal(moved?.project.name, "My app");
});

test("project settings move with the primary folder", () => {
  const next = rekeyProjectSettings({
    projectDefaults: { "/old": { model: "m" } },
    sidebarCollapsedProjects: ["/old", "/other"],
  }, "/old", "/new");
  assert.deepEqual(next.projectDefaults, { "/new": { model: "m" } });
  assert.deepEqual(next.sidebarCollapsedProjects, ["/new", "/other"]);
});
