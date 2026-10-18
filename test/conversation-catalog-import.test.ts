import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ConversationCatalog } from "../src/main/engine/conversation-catalog.ts";
import { openTestDb, testDir } from "./test-db.ts";

/**
 * The one-time import of `conversations.json` (§8: 「正常文件；v0 / v1 的会话目录」).
 *
 * The import deliberately runs the catalog's *existing* migration code, so these cases are
 * the migrations themselves — and they are what an install from before the database will hit
 * on its first start. Three file shapes were ever written: a bare array (v0, where `cwd` was
 * the project binding), `{ version: 1 }` (same binding, plus projects), and `{ version: 2 }`.
 * Two of them also predate `createdAt`, whose absence changes how projects are ordered.
 */

type Seeded = { dir: string; file: string; scratch: string };

function seed(value: unknown): Seeded {
  const dir = testDir("fastvibe-catalog-import-");
  const scratch = join(dir, "scratch");
  mkdirSync(scratch);
  const file = join(dir, "conversations.json");
  writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  return { dir, file, scratch };
}

const open = (seeded: Seeded): ConversationCatalog =>
  new ConversationCatalog(openTestDb(seeded.dir), { scratchRoot: seeded.scratch, legacyFile: seeded.file });

const chat = (id: string, extra: Record<string, unknown> = {}): Record<string, unknown> => ({
  id,
  title: `Chat ${id}`,
  cwd: "/work/app",
  project: "/work/app",
  createdAt: 1_000 + Number(id.slice(1)),
  updatedAt: 2_000,
  ...extra,
});

test("a v2 catalog is taken in as it stands", () => {
  const seeded = seed({
    version: 2,
    activeId: "c2",
    projects: [{ cwd: "/work/app", name: "app", createdAt: 900, updatedAt: 2_000 }],
    conversations: [chat("c2"), chat("c1", { preview: "hello" })],
  });
  const cat = open(seeded);

  assert.equal(cat.activeId, "c2");
  assert.deepEqual(
    cat.list().map((item) => item.id),
    ["c2", "c1"],
    "newest created first, as the sidebar had it",
  );
  assert.equal(cat.get("c1")?.preview, "hello");
  assert.deepEqual(cat.listProjects().map((project) => project.cwd), ["/work/app"]);

  const db = openTestDb(seeded.dir);
  assert.equal(db.countRows("conversations"), 2);
  assert.equal(db.countRows("projects"), 1);
  assert.equal(db.get<{ value: string }>("SELECT value FROM catalog_meta WHERE key = 'activeId'")?.value, "c2");
  // The stored order is the user's drag order, so it must arrive as it was.
  assert.deepEqual(
    db.all<{ cwd: string; position: number }>("SELECT cwd, position FROM projects ORDER BY position").map((row) => row.position),
    [0],
  );
});

test("a v0 bare array derives its projects from the chats' cwd", () => {
  const seeded = seed([
    { id: "a", title: "A", cwd: "/work/one", createdAt: 10, updatedAt: 10 },
    { id: "b", title: "B", cwd: "/work/one", createdAt: 20, updatedAt: 30 },
    { id: "c", title: "C", cwd: "/work/two", createdAt: 5, updatedAt: 5 },
    // Unbound: v0 had no project field, so an empty cwd is the only way to say it.
    { id: "d", title: "D", cwd: "", createdAt: 1, updatedAt: 1 },
  ]);
  const cat = open(seeded);

  assert.deepEqual(cat.listProjects().map((project) => project.cwd), ["/work/one", "/work/two"]);
  assert.equal(cat.get("a")?.project, "/work/one", "cwd became the binding");
  assert.equal(cat.get("d")?.project, undefined);
  assert.equal(cat.get("d")?.cwd.startsWith(seeded.scratch), true, "and it got a scratch directory of its own");
  // The oldest chat in a project is the best available proxy for when it was added.
  assert.equal(cat.listProjects().find((project) => project.cwd === "/work/one")?.createdAt, 10);
  assert.equal(cat.activeId, "a", "v0 stored no active id, so the first entry of the file is what opened");
  assert.equal(openTestDb(seeded.dir).countRows("projects"), 2);
});

test("a v1 catalog splits project from cwd and restores newest-added-first", () => {
  const seeded = seed({
    version: 1,
    // No `createdAt` on the projects: they were displayed by activity, so the stored order
    // is not a drag order and has to be re-derived once.
    projects: [{ cwd: "/work/old", name: "old", updatedAt: 5 }, { cwd: "/work/new", name: "new", updatedAt: 9 }],
    conversations: [chat("c1", { cwd: "/work/old", project: "/work/old", createdAt: 100, updatedAt: 100 }), chat("c2", { cwd: "/work/new", project: "/work/new", createdAt: 500, updatedAt: 500 })],
  });
  const cat = open(seeded);

  assert.deepEqual(cat.listProjects().map((project) => project.cwd), ["/work/new", "/work/old"]);
  assert.equal(cat.listProjects()[0].createdAt, 500, "backfilled from the earliest chat in it");
  assert.equal(cat.get("c2")?.project, "/work/new");
});

test("a project only some chats mention is still a project", () => {
  const seeded = seed({
    version: 2,
    conversations: [chat("c1", { project: "/work/ghost" })],
    projects: [],
  });
  const cat = open(seeded);
  assert.deepEqual(cat.listProjects().map((project) => project.cwd), ["/work/ghost"]);
});

test("junk entries are refused and the good ones still arrive", () => {
  const seeded = seed({
    version: 2,
    conversations: [
      chat("c1"),
      { id: "no-title", cwd: "/work/app" },
      { title: "no id", cwd: "/work/app" },
      "not an object",
      chat("c2", { sessionId: "s2", sessionFile: "/sessions/s2.jsonl" }),
    ],
    projects: [{ cwd: "/work/app" }, { name: "no cwd" }, chat("c1")],
  });
  const cat = open(seeded);
  assert.deepEqual(
    cat.list().map((item) => item.id),
    ["c2", "c1"],
  );
  assert.deepEqual(cat.listProjects().map((project) => project.cwd), ["/work/app"]);
  const db = openTestDb(seeded.dir);
  assert.equal(db.countRows("conversations"), 2);
  // The columns are what a query reads, so they must be filled from the object.
  assert.deepEqual(
    Object.keys(db.get<Record<string, unknown>>("SELECT * FROM conversations WHERE id = 'c2'") ?? {}),
    ["id", "project", "kind", "parent_id", "session_id", "created_at", "updated_at", "data"],
  );
  assert.equal(db.get<{ session_id: string }>("SELECT session_id FROM conversations WHERE id = 'c2'")?.session_id, "s2");
  assert.equal(db.get<{ project: string }>("SELECT project FROM conversations WHERE id = 'c1'")?.project, "/work/app");
});

test("a catalog that predates createdAt orders itself by updatedAt", () => {
  const seeded = seed({
    version: 2,
    conversations: [
      { id: "c-old", title: "old", cwd: "/work/app", updatedAt: 100 },
      { id: "c-new", title: "new", cwd: "/work/app", updatedAt: 900 },
    ],
    projects: [],
  });
  const cat = open(seeded);
  assert.deepEqual(
    cat.list().map((item) => item.id),
    ["c-new", "c-old"],
  );
  assert.equal(cat.get("c-old")?.createdAt, 100, "updatedAt is the best available proxy");
});

test("the imported rows equal what the store keeps, so the first flush writes nothing new", () => {
  const seeded = seed({
    version: 2,
    activeId: "c1",
    conversations: [chat("c1", { preview: "p", worktree: { path: "/wt/x", branch: "b" } })],
    projects: [{ cwd: "/work/app", name: "app", createdAt: 1, updatedAt: 2, folders: ["/extra"] }],
  });
  const cat = open(seeded);
  const db = openTestDb(seeded.dir);
  const before = db.get<{ data: string }>("SELECT data FROM conversations")!.data;
  cat.update("c1", { title: "renamed" });
  cat.flush();
  assert.notEqual(db.get<{ data: string }>("SELECT data FROM conversations")!.data, before, "the change is written");
  const untouched = db.get<{ data: string }>("SELECT data FROM projects")!.data;
  cat.flush();
  assert.equal(db.get<{ data: string }>("SELECT data FROM projects")!.data, untouched);
});

test("the legacy file is renamed aside, not deleted, and is not imported twice", () => {
  const seeded = seed({ version: 2, conversations: [chat("c1")], projects: [] });
  const cat = open(seeded);
  cat.flush();
  assert.ok(!existsSync(seeded.file));
  const kept = readdirSync(seeded.dir).filter((name) => name.startsWith("conversations.json.migrated-"));
  assert.equal(kept.length, 1, readdirSync(seeded.dir).join(","));
  assert.match(kept[0], /^conversations\.json\.migrated-\d+$/);

  // An older app put the file back; the import is recorded, so it is set aside untouched.
  writeFileSync(seeded.file, `${JSON.stringify({ version: 2, conversations: [chat("c9"), chat("c1")], projects: [] })}\n`, "utf8");
  const again = open(seeded);
  assert.equal(again.get("c9"), undefined, "no second import");
  assert.equal(again.get("c1")?.title, "Chat c1");
  assert.ok(!existsSync(seeded.file));
  assert.equal(readdirSync(seeded.dir).filter((name) => name.startsWith("conversations.json.migrated-")).length, 2);
});
