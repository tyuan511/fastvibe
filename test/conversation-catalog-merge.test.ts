import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { ConversationCatalog } from "../src/main/engine/conversation-catalog.ts";

/**
 * Two processes on one data directory — the installed app next to a `pnpm dev`, which is
 * allowed to skip the single-instance lock. Each holds the catalog in memory and every
 * flush writes the whole file, so before the merge the later writer kept only the chats
 * it knew about and the rest vanished from the sidebar while their transcripts stayed on
 * disk. A second `ConversationCatalog` over the same file stands in for the second process.
 */

function setup(): { dir: string; file: string; open: () => ConversationCatalog } {
  const dir = mkdtempSync(join(tmpdir(), "fastvibe-catalog-merge-"));
  const file = join(dir, "conversations.json");
  return { dir, file, open: () => new ConversationCatalog(file, join(dir, "scratch")) };
}

const ids = (file: string): string[] =>
  (JSON.parse(readFileSync(file, "utf8")) as { conversations: { id: string }[] }).conversations.map((item) => item.id).sort();

test("a stale writer does not drop chats another process created after it started", () => {
  const { file, open } = setup();
  const first = open();
  const old = first.create("/tmp/proj");
  first.flush();

  // The long-running process starts, reads the catalog, and keeps it in memory.
  const stale = open();
  // Meanwhile the other process adds a chat.
  const fresh = first.create("/tmp/proj");
  first.flush();
  assert.deepEqual(ids(file), [old.id, fresh.id].sort());

  // The stale process changes something unrelated and flushes its whole in-memory view.
  stale.update(old.id, { title: "renamed" });
  stale.flush();

  assert.deepEqual(ids(file), [old.id, fresh.id].sort(), "the chat created elsewhere must survive");
  assert.ok(
    stale.list().some((item) => item.id === fresh.id),
    "and the stale process now lists it",
  );
});

test("both processes keep each other's chats, in either flush order", () => {
  const { file, open } = setup();
  const a = open();
  const b = open();
  const fromA = a.create("/tmp/proj");
  const fromB = b.create("/tmp/proj");
  a.flush();
  b.flush();
  a.flush();
  assert.deepEqual(ids(file), [fromA.id, fromB.id].sort());
});

test("a project folder added by the other process is kept too", () => {
  const { file, open } = setup();
  const a = open();
  const b = open();
  a.ensureProject("/tmp/from-a");
  a.flush();
  b.ensureProject("/tmp/from-b");
  b.flush();
  const stored = JSON.parse(readFileSync(file, "utf8")) as { projects: { cwd: string }[] };
  assert.deepEqual(stored.projects.map((project) => project.cwd).sort(), ["/tmp/from-a", "/tmp/from-b"]);
});

test("a chat this process deleted is not adopted back from the file", () => {
  const { file, open } = setup();
  const cat = open();
  const gone = cat.create("/tmp/proj");
  const kept = cat.create("/tmp/proj");
  cat.flush();
  cat.remove(gone.id);
  cat.flush();
  assert.deepEqual(ids(file), [kept.id]);
});

test("a deleted chat stays deleted when the file still lists it from an earlier flush", () => {
  const { file, open } = setup();
  const cat = open();
  const gone = cat.create("/tmp/proj");
  cat.flush();
  // The file still has it; removing it in memory and flushing again must drop it.
  cat.remove(gone.id);
  cat.flush();
  cat.flush();
  assert.deepEqual(ids(file), []);
});

test("an unreadable catalog is copied aside before it can be overwritten", () => {
  const { dir, file, open } = setup();
  writeFileSync(file, '{"version":2,"conversations":[{"id":"x","title":"cut off');
  const cat = open();
  cat.create("/tmp/proj");
  cat.flush();
  const kept = readdirSync(dir).filter((name) => name.startsWith(`${basename(file)}.corrupt-`));
  assert.equal(kept.length, 1);
  assert.match(readFileSync(join(dir, kept[0]), "utf8"), /cut off/);
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
  assert.deepEqual(
    readdirSync(dir).filter((name) => name.endsWith(".tmp")),
    [],
  );
});
