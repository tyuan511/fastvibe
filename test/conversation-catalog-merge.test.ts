import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { ConversationCatalog } from "../src/main/engine/conversation-catalog.ts";
import { openSecondTestDb, openTestDb, testDir } from "./test-db.ts";
import type { Db } from "../src/main/engine/db.ts";

/**
 * Two processes on one data directory — the installed app next to a `pnpm dev`, which is
 * allowed to skip the single-instance lock.
 *
 * Each holds the catalog in memory. Every flush used to serialize the whole `conversations
 * .json`, so the later writer kept only the chats it knew about and the rest vanished from
 * the sidebar while their transcripts stayed on disk; the merge that fixed that was a
 * hand-built transaction on top of a file format. Now the rows are compared one at a time,
 * so these cases are about what *is* still true: a chat created elsewhere is adopted, a chat
 * deleted elsewhere is not written back, and a chat both hold is last-writer-wins on that
 * row.
 *
 * A second `ConversationCatalog` over the same connection is one process holding two
 * catalogs; `openSecondTestDb` is the real thing — a second connection, with its own memory.
 */

function setup(): { dir: string; db: Db; open: () => ConversationCatalog } {
  const dir = testDir("fastvibe-catalog-merge-");
  const db = openTestDb(dir);
  return {
    dir,
    db,
    open: () => new ConversationCatalog(db, { scratchRoot: join(dir, "scratch") }),
  };
}

const ids = (db: Db): string[] => db.all<{ id: string }>("SELECT id FROM conversations").map((row) => row.id).sort();
const projectPaths = (db: Db): string[] =>
  db.all<{ cwd: string }>("SELECT cwd FROM projects").map((row) => row.cwd).sort();

test("a stale writer does not drop chats another process created after it started", () => {
  const { db, open } = setup();
  const first = open();
  const old = first.create("/tmp/proj");
  first.flush();

  // The long-running process starts, reads the catalog, and keeps it in memory.
  const stale = open();
  // Meanwhile the other process adds a chat.
  const fresh = first.create("/tmp/proj");
  first.flush();
  assert.deepEqual(ids(db), [old.id, fresh.id].sort());

  // The stale process changes something unrelated and flushes its whole in-memory view.
  stale.update(old.id, { title: "renamed" });
  stale.flush();

  assert.deepEqual(ids(db), [old.id, fresh.id].sort(), "the chat created elsewhere must survive");
  assert.ok(
    stale.list().some((item) => item.id === fresh.id),
    "and the stale process now lists it",
  );
  assert.equal(
    (JSON.parse(db.get<{ data: string }>("SELECT data FROM conversations WHERE id = ?", old.id)!.data) as { title: string }).title,
    "renamed",
  );
});

test("both processes keep each other's chats, in either flush order", () => {
  const { db, open } = setup();
  const a = open();
  const b = open();
  const fromA = a.create("/tmp/proj");
  const fromB = b.create("/tmp/proj");
  a.flush();
  b.flush();
  a.flush();
  assert.deepEqual(ids(db), [fromA.id, fromB.id].sort());
});

test("a project folder added by the other process is kept too", () => {
  const { db, open } = setup();
  const a = open();
  const b = open();
  a.ensureProject("/tmp/from-a");
  a.flush();
  b.ensureProject("/tmp/from-b");
  b.flush();
  assert.deepEqual(projectPaths(db), ["/tmp/from-a", "/tmp/from-b"]);
  assert.deepEqual(b.listProjects().map((project) => project.cwd).sort(), ["/tmp/from-a", "/tmp/from-b"]);
});

test("a chat this process deleted is not adopted back from the table", () => {
  const { db, open } = setup();
  const cat = open();
  const gone = cat.create("/tmp/proj");
  const kept = cat.create("/tmp/proj");
  cat.flush();
  cat.remove(gone.id);
  cat.flush();
  assert.deepEqual(ids(db), [kept.id]);
});

test("a chat one process deleted is not written back by another that changed something else", () => {
  const { dir, db, open } = setup();
  const here = open();
  const doomed = here.create("/tmp/proj");
  const other = here.create("/tmp/proj");
  here.flush();

  // The other process: its own connection, its own memory of every row.
  const there = new ConversationCatalog(openSecondTestDb(dir), { scratchRoot: join(dir, "scratch") });
  assert.ok(there.list().some((item) => item.id === doomed.id), "it started with the same catalog");

  here.remove(doomed.id);
  here.flush();
  assert.deepEqual(ids(db), [other.id].sort());

  // Writing the whole file from memory is what used to resurrect `doomed`; `there` never
  // touched it, so its row is not part of what this flush writes.
  there.update(other.id, { title: "renamed over there" });
  there.flush();
  assert.deepEqual(ids(db), [other.id], "a row the other process deleted stays deleted");
  assert.match(db.get<{ data: string }>("SELECT data FROM conversations WHERE id = ?", other.id)!.data, /renamed over there/);
});

test("a project drag survives because position is a column, not array order", () => {
  const { dir, open } = setup();
  const cat = open();
  cat.ensureProject("/tmp/one");
  cat.ensureProject("/tmp/two");
  cat.flush();
  cat.reorderProjects(["/tmp/one", "/tmp/two"]);
  cat.flush();
  const moved = new ConversationCatalog(openTestDb(dir), { scratchRoot: join(dir, "scratch") });
  assert.deepEqual(moved.listProjects().map((project) => project.cwd), ["/tmp/one", "/tmp/two"]);
  // And the object itself did not change — only its place in the table.
  const other = new ConversationCatalog(openSecondTestDb(dir), { scratchRoot: join(dir, "scratch") });
  other.flush();
  assert.deepEqual(other.listProjects().map((project) => project.cwd), ["/tmp/one", "/tmp/two"]);
});

test("the active conversation is one row, and clearing it clears the row", () => {
  const { dir, db, open } = setup();
  const cat = open();
  const one = cat.create("/tmp/proj");
  cat.flush();
  assert.equal(db.get<{ value: string }>("SELECT value FROM catalog_meta WHERE key = 'activeId'")?.value, one.id);
  cat.setActive(undefined);
  cat.flush();
  assert.equal(db.get<{ value: string }>("SELECT value FROM catalog_meta WHERE key = 'activeId'")?.value, "", "an explicit nothing, not a missing row");
  const reopened = new ConversationCatalog(openTestDb(dir), { scratchRoot: join(dir, "scratch") });
  assert.equal(reopened.activeId, undefined, "and the next process does not fall back to the newest chat");
  assert.equal(reopened.list().length, 1);
});

test("an unreadable legacy catalog is kept where a person can still find it", () => {
  const { dir, db, open } = setup();
  const file = join(dir, "conversations.json");
  writeFileSync(file, '{"version":2,"conversations":[{"id":"x","title":"cut off');
  const cat = new ConversationCatalog(db, { legacyFile: file, scratchRoot: join(dir, "scratch") });
  cat.create("/tmp/proj");
  cat.flush();
  const kept = readdirSync(dir).filter((name) => name.startsWith(`${basename(file)}.corrupt-`));
  assert.equal(kept.length, 1, readdirSync(dir).join(","));
  assert.match(readFileSync(join(dir, kept[0]), "utf8"), /cut off/);
  assert.equal(ids(db).length, 1, "and the store began from empty rather than from a guess");
});

test("a missing catalog is a first run, not a corrupt one", () => {
  const { dir, open } = setup();
  open().create("/tmp/proj");
  assert.deepEqual(
    readdirSync(dir).filter((name) => name.includes(".corrupt-")),
    [],
  );
});

test("a flush leaves no temporary file behind", () => {
  const { dir, open } = setup();
  const cat = open();
  cat.create("/tmp/proj");
  cat.flush();
  cat.remove(cat.list()[0].id);
  cat.flush();
  assert.deepEqual(
    readdirSync(dir).filter((name) => name.endsWith(".tmp")),
    [],
  );
});
