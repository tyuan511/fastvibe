import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ReasoningStore } from "../src/main/engine/reasoning-store.ts";
import { openDatabase, type Db } from "../src/main/engine/db.ts";

/**
 * The bounds of every thinking block, kept outside the transcript because the engine does
 * not record them: it stamps one timestamp per assistant message, its request start.
 *
 * The store used to be one 268 KB JSON file rewritten whole every 500 ms. These cases pin
 * what it has to keep doing (reload the bounds, cap the history, take the old file in) and
 * what the row storage is for (a reopen does not rewrite the table).
 */

const MAX_ENTRIES = 5000;

function tempDir(): string {
  return mkdtempSync(join(tmpdir(), "fastvibe-reasoning-"));
}

function database(dir: string): Db {
  return openDatabase(join(dir, "fastvibe.db"));
}

/** Count the statements a store issued, to prove a flush writes only what changed. */
function spy(db: Db): { proxy: Db; runs: string[] } {
  const runs: string[] = [];
  return {
    runs,
    proxy: {
      file: db.file,
      get closed() {
        return db.closed;
      },
      run: (sql, ...params) => {
        runs.push(sql);
        return db.run(sql, ...params);
      },
      get: (sql, ...params) => db.get(sql, ...params),
      all: (sql, ...params) => db.all(sql, ...params),
      exec: (sql) => db.exec(sql),
      transaction: (fn) => db.transaction(fn),
      userVersion: (next?: number) => (next === undefined ? db.userVersion() : db.userVersion(next)),
      countRows: (table) => db.countRows(table),
      close: () => db.close(),
    },
  };
}

test("bounds written by one store are read back by another over the same database", () => {
  const dir = tempDir();
  const store = new ReasoningStore(database(dir));
  store.set("entry-1", [{ startedAt: 100, endedAt: 260 }]);
  store.set("entry-2", [
    { startedAt: 10, endedAt: 20 },
    { startedAt: 30, endedAt: 95 },
  ]);
  // A block still open is not stored: it has no end, so there is nothing to time yet.
  store.set("entry-3", [{ startedAt: 5 }]);
  store.flush();

  const reopened = new ReasoningStore(database(dir));
  assert.deepEqual(reopened.get("entry-1"), [{ startedAt: 100, endedAt: 260 }]);
  assert.deepEqual(reopened.get("entry-2"), [
    { startedAt: 10, endedAt: 20 },
    { startedAt: 30, endedAt: 95 },
  ]);
  assert.equal(reopened.get("entry-3"), undefined);
  assert.equal(reopened.get("no-such-entry"), undefined);
});

test("reopening does not rewrite the rows it just read", () => {
  const dir = tempDir();
  const first = new ReasoningStore(database(dir));
  first.set("entry-1", [{ startedAt: 1, endedAt: 2 }]);
  first.set("entry-2", [{ startedAt: 3, endedAt: 4 }]);
  first.flush();

  const seen = spy(database(dir));
  const reopened = new ReasoningStore(seen.proxy);
  assert.deepEqual(seen.runs, [], "loading primes the writer instead of re-upserting");
  reopened.flush();
  assert.deepEqual(
    seen.runs.filter((sql) => sql.includes("INSERT")),
    [],
    "a flush with nothing changed writes nothing",
  );
});

test("an entry that is written again moves to the young end of the history", () => {
  const dir = tempDir();
  const store = new ReasoningStore(database(dir));
  store.set("old", [{ startedAt: 1, endedAt: 2 }]);
  store.set("new", [{ startedAt: 3, endedAt: 4 }]);
  // Same bytes, re-set: it is now the newest, and eviction has to agree.
  store.set("old", [{ startedAt: 1, endedAt: 2 }]);
  store.flush();

  const rows = database(dir).all<{ entry_id: string }>("SELECT entry_id FROM reasoning_blocks ORDER BY seq");
  assert.deepEqual(rows.map((row) => row.entry_id), ["new", "old"]);
});

test("the history is bounded, oldest first", () => {
  const dir = tempDir();
  const store = new ReasoningStore(database(dir));
  for (let i = 0; i < MAX_ENTRIES + 25; i++) {
    store.set(`entry-${i}`, [{ startedAt: i, endedAt: i + 1 }]);
  }
  store.flush();

  const db = database(dir);
  assert.equal(db.countRows("reasoning_blocks"), MAX_ENTRIES, "the table is capped, not the file");
  assert.equal(db.get<{ n: number }>("SELECT COUNT(*) AS n FROM reasoning_blocks WHERE entry_id = 'entry-0'")?.n, 0);
  assert.equal(db.get<{ n: number }>(`SELECT COUNT(*) AS n FROM reasoning_blocks WHERE entry_id = 'entry-${MAX_ENTRIES + 24}'`)?.n, 1);
  assert.equal(new ReasoningStore(db).get(`entry-${MAX_ENTRIES + 24}`)?.[0].endedAt, MAX_ENTRIES + 25);
});

test("the old reasoning.json is imported once and kept under a new name", () => {
  const dir = tempDir();
  const file = join(dir, "reasoning.json");
  writeFileSync(
    file,
    JSON.stringify({
      version: 1,
      blocks: {
        "entry-1": [[100, 260]],
        // Nonsense the old reader already dropped, so the import must drop it too.
        "bad": [[3, 1], ["x", 2], [4, 5, 6], [7]],
        "kept": [[1, 2], [3, 4]],
      },
    }),
    "utf8",
  );

  const store = new ReasoningStore(database(dir), { legacyFile: file });
  assert.deepEqual(store.get("entry-1"), [{ startedAt: 100, endedAt: 260 }]);
  assert.deepEqual(store.get("kept"), [
    { startedAt: 1, endedAt: 2 },
    { startedAt: 3, endedAt: 4 },
  ]);
  assert.equal(store.get("bad"), undefined);

  assert.ok(!existsSync(file));
  assert.equal(readdirSync(dir).filter((name) => name.startsWith("reasoning.json.migrated-")).length, 1);
  assert.equal(database(dir).countRows("reasoning_blocks"), 2);

  // A file left behind by an interrupted rename must not be imported a second time.
  writeFileSync(file, JSON.stringify({ version: 1, blocks: { "late": [[9, 9]] } }), "utf8");
  const again = new ReasoningStore(database(dir), { legacyFile: file });
  assert.equal(again.get("late"), undefined);
  assert.equal(database(dir).countRows("reasoning_blocks"), 2);
  assert.ok(!existsSync(file), "and it is renamed aside all the same");
});

test("a corrupt reasoning.json is kept for a human and the store starts empty", () => {
  const dir = tempDir();
  const file = join(dir, "reasoning.json");
  writeFileSync(file, "{ nope", "utf8");
  const store = new ReasoningStore(database(dir), { legacyFile: file });
  assert.equal(store.get("anything"), undefined);
  assert.ok(!existsSync(file));
  assert.ok(readdirSync(dir).some((name) => name.startsWith("reasoning.json.corrupt-")), readdirSync(dir).join(","));
  assert.equal(readFileSync(join(dir, readdirSync(dir).find((name) => name.includes("corrupt-")!), ""), "utf8"), "{ nope");
});

test("a store with no legacy file to import simply reads the table", () => {
  const dir = tempDir();
  const store = new ReasoningStore(database(dir));
  store.set("entry-1", [{ startedAt: 1, endedAt: 9 }]);
  store.flush();
  assert.equal(new ReasoningStore(database(dir)).get("entry-1")?.[0].endedAt, 9);
});
