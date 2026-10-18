import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  closeDatabases,
  importLegacyJson,
  openDatabase,
  openDatabaseConnection,
  RowWriter,
  type Db,
  type LegacyImport,
  type SqlParam,
} from "../src/main/engine/db.ts";
import { MIGRATIONS, SCHEMA_VERSION } from "../src/main/engine/db-schema.ts";
import { spyDb } from "./test-db.ts";

/**
 * The database layer is what every migrated store now stands on, and each case here pins a
 * rule that would fail quietly: a PRAGMA that is accepted and then ignored, a migration that
 * runs twice and breaks startup, a transaction that half-commits, a file that is
 * world-readable, an import that lands halfway and renames the only copy of the data.
 *
 * `docs/sqlite-storage.md` §8 is the list this file is written against.
 */

function tempDir(): string {
  return mkdtempSync(join(tmpdir(), "fastvibe-db-"));
}

function mode(file: string): string {
  return (statSync(file).mode & 0o777).toString(8);
}

function withRows(db: Db): void {
  db.exec("CREATE TABLE IF NOT EXISTS widget (id TEXT PRIMARY KEY, position INTEGER, data TEXT NOT NULL)");
}

test("the PRAGMAs the design promises are actually in effect", () => {
  const dir = tempDir();
  const file = join(dir, "fastvibe.db");
  const db = openDatabase(file);
  // `journal_mode` is persistent, and `auto_vacuum` is the header field that is silently
  // dropped when it is set after WAL — which is why db.ts sets it first.
  assert.equal(db.get<{ journal_mode: string }>("PRAGMA journal_mode")?.journal_mode.toLowerCase(), "wal");
  assert.equal(db.get<{ auto_vacuum: number }>("PRAGMA auto_vacuum")?.auto_vacuum, 2, "INCREMENTAL");
  assert.equal(db.get<{ synchronous: number }>("PRAGMA synchronous")?.synchronous, 1, "NORMAL");
  assert.equal(db.get<{ timeout: number }>("PRAGMA busy_timeout")?.timeout, 5000);
  assert.equal(db.get<{ foreign_keys: number }>("PRAGMA foreign_keys")?.foreign_keys, 1);
  db.close();
});

test("the database and its -wal / -shm sidecars are 0600", () => {
  const dir = tempDir();
  const file = join(dir, "fastvibe.db");
  const db = openDatabase(file);
  withRows(db);
  db.run("INSERT INTO widget (id, data) VALUES (?, ?)", "a", "{}");
  // The sidecars exist only while a connection is open, and this is the moment they are
  // created — checkpoints carry workspace source, so nothing may be group-readable.
  assert.equal(mode(file), "600");
  assert.equal(mode(join(dir, "fastvibe.db-wal")), "600");
  assert.equal(mode(join(dir, "fastvibe.db-shm")), "600");
  db.close();
});

test("one path means one connection; :memory: is never shared", () => {
  const dir = tempDir();
  const file = join(dir, "fastvibe.db");
  const a = openDatabase(file);
  assert.equal(openDatabase(file), a, "cached by absolute path");
  a.close();

  const first = openDatabase(":memory:");
  const second = openDatabase(":memory:");
  assert.notEqual(first, second);
  withRows(first);
  withRows(second);
  first.run("INSERT INTO widget (id, data) VALUES (?, ?)", "a", "{}");
  assert.equal(second.countRows("widget"), 0, "two in-memory databases are two databases");
  first.close();
  second.close();
});

test("openDatabaseConnection is a second process over the same file", () => {
  const dir = tempDir();
  const file = join(dir, "fastvibe.db");
  const a = openDatabase(file);
  withRows(a);
  a.run("INSERT INTO widget (id, data) VALUES (?, ?)", "x", "{}");
  const b = openDatabaseConnection(file);
  assert.notEqual(b, a);
  assert.equal(b.countRows("widget"), 1, "a fresh connection sees the committed rows");
  b.run("INSERT INTO widget (id, data) VALUES (?, ?)", "y", "{}");
  assert.equal(a.countRows("widget"), 2, "and so does the first one, WAL or no WAL");
  b.close();
  a.close();
});

test("undefined binds as NULL and booleans as 0/1", () => {
  const db = openDatabase(":memory:");
  db.exec("CREATE TABLE t (a TEXT, b INTEGER)");
  db.run("INSERT INTO t VALUES (?, ?)", undefined, true);
  db.run("INSERT INTO t VALUES (?, ?)", "x", false);
  const rows = db.all<{ a: string | null; b: number }>("SELECT a, b FROM t ORDER BY rowid");
  assert.deepEqual(
    rows.map((row) => [row.a, row.b]),
    [
      [null, 1],
      ["x", 0],
    ],
  );
  db.close();
});

test("a transaction that throws leaves nothing behind", () => {
  const db = openDatabase(":memory:");
  withRows(db);
  db.run("INSERT INTO widget (id, data) VALUES (?, ?)", "keep", "{}");
  assert.throws(
    () =>
      db.transaction(() => {
        db.run("INSERT INTO widget (id, data) VALUES (?, ?)", "gone", "{}");
        throw new Error("boom");
      }),
    /boom/,
  );
  assert.deepEqual(
    db.all<{ id: string }>("SELECT id FROM widget").map((row) => row.id),
    ["keep"],
  );
  db.close();
});

test("transactions are not reentrant", () => {
  const db = openDatabase(":memory:");
  assert.throws(() => db.transaction(() => db.transaction(() => 1)), /不能嵌套/);
  // And the guard is left behind: the outer failure must not poison the connection.
  db.run("SELECT 1");
  db.close();
});

test("foreign keys cascade, so a child table cannot outlive its owner", () => {
  const db = openDatabase(":memory:");
  db.exec("CREATE TABLE parent (id TEXT PRIMARY KEY)");
  db.exec(
    "CREATE TABLE child (parent_id TEXT REFERENCES parent(id) ON DELETE CASCADE, seq INTEGER, PRIMARY KEY (parent_id, seq))",
  );
  db.run("INSERT INTO parent VALUES (?)", "p");
  db.run("INSERT INTO child VALUES (?, ?)", "p", 1);
  db.run("DELETE FROM parent WHERE id = ?", "p");
  assert.equal(db.countRows("child"), 0);
  assert.throws(() => db.run("INSERT INTO child VALUES (?, ?)", "missing", 2), /FOREIGN KEY constraint failed/);
  db.close();
});

test("the schema is applied in order and the version records it", () => {
  const dir = tempDir();
  const file = join(dir, "fastvibe.db");
  const db = openDatabase(file);
  assert.equal(db.userVersion(), SCHEMA_VERSION);
  assert.equal(SCHEMA_VERSION, MIGRATIONS.length);
  assert.equal(db.countRows("legacy_imports"), 0);
  db.close();

  // Reopening does not run a step a second time — that would fail on `CREATE TABLE`.
  const again = openDatabase(file);
  assert.equal(again.userVersion(), SCHEMA_VERSION);
  assert.equal(again.countRows("legacy_imports"), 0);
  again.close();
});

test("a database written by a newer build is refused, not downgraded", () => {
  const dir = tempDir();
  const file = join(dir, "fastvibe.db");
  const db = openDatabase(file);
  withRows(db);
  db.run("INSERT INTO widget (id, data) VALUES (?, ?)", "a", "{}");
  db.userVersion(SCHEMA_VERSION + 7);
  db.close();

  assert.throws(() => openDatabase(file), /更新的版本/);
  assert.throws(() => openDatabase(file), new RegExp(String(SCHEMA_VERSION + 7)));
  // Refusing must not touch the file: it is the newer build's database, and a retry says
  // the same thing rather than having quietly rebuilt it.
  assert.ok(existsSync(file));
  assert.equal(readFileSync(file, "utf8").length > 0, true);
});

test("a damaged database is moved aside with a readable error, not rebuilt in silence", () => {
  const dir = tempDir();
  const file = join(dir, "broken.db");
  writeFileSync(file, "this is not a database".repeat(64));
  assert.throws(() => openDatabase(file), (error: Error) => {
    assert.match(error.message, /已损坏/);
    assert.match(error.message, /会话正文/);
    return true;
  });
  assert.ok(
    readdirSync(dir).some((name) => name.startsWith("broken.db.corrupt-")),
    readdirSync(dir).join(","),
  );
  assert.ok(!existsSync(file), "the damaged file is not left where the next startup would half-trust it");
});

// ---------------------------------------------------------------------------
// RowWriter: only what changed
// ---------------------------------------------------------------------------

type Widget = { id: string; position: number; note: string };

function widgetWriter(db: Db): RowWriter<Widget> {
  withRows(db);
  return new RowWriter<Widget>(db, {
    table: "widget",
    identity: (row) => ({ id: row.id }),
    columns: (row) => ({ position: row.position }),
    data: (row) => JSON.stringify({ note: row.note }),
  });
}

function readWidgets(db: Db): { id: string; position: number | null; note: string }[] {
  return db
    .all<{ id: string; position: number | null; data: string }>("SELECT id, position, data FROM widget ORDER BY id")
    .map((row) => ({ id: row.id, position: row.position, note: (JSON.parse(row.data) as { note: string }).note }));
}

test("write() skips a row that already matches the table", () => {
  const db = openDatabase(":memory:");
  const writer = widgetWriter(db);
  writer.write([{ id: "a", position: 1, note: "one" }]);
  // Same object, same bytes, same column: nothing to write.
  writer.write([{ id: "a", position: 1, note: "one" }]);
  assert.deepEqual(readWidgets(db), [{ id: "a", position: 1, note: "one" }]);
  const seen = spyDb(db);
  new RowWriter<Widget>(seen.proxy, {
    table: "widget",
    identity: (row) => ({ id: row.id }),
    columns: (row) => ({ position: row.position }),
    data: (row) => JSON.stringify({ note: row.note }),
  })
    .write([{ id: "a", position: 1, note: "one" }]);
  assert.deepEqual(seen.statements.filter((sql) => sql.includes("DELETE")), [], "and no row is mistaken for gone");
  db.close();
});

test("write() upserts changed rows and deletes the ones that left the list", () => {
  const db = openDatabase(":memory:");
  const writer = widgetWriter(db);
  writer.write([
    { id: "a", position: 1, note: "one" },
    { id: "b", position: 2, note: "two" },
  ]);
  writer.write([
    { id: "a", position: 1, note: "edited" },
    { id: "c", position: 3, note: "three" },
  ]);
  assert.deepEqual(readWidgets(db), [
    { id: "a", position: 1, note: "edited" },
    { id: "c", position: 3, note: "three" },
  ]);
  db.close();
});

test("prime() records what the table holds without writing it", () => {
  const db = openDatabase(":memory:");
  withRows(db);
  db.run("INSERT INTO widget (id, position, data) VALUES (?, ?, ?)", "a", 1, '{"note":"one"}');
  const seen = spyDb(db);
  const writer = new RowWriter<Widget>(seen.proxy, {
    table: "widget",
    identity: (row) => ({ id: row.id }),
    columns: (row) => ({ position: row.position }),
    data: (row) => JSON.stringify({ note: row.note }),
  });
  writer.prime({ id: "a", position: 1, note: "one" }, '{"note":"one"}');
  writer.write([{ id: "a", position: 1, note: "one" }]);
  assert.deepEqual(seen.statements, [], "a store that just read the table does not rewrite it");
  db.close();
});

test("writeOne() lands immediately and is remembered", () => {
  const db = openDatabase(":memory:");
  const writer = widgetWriter(db);
  db.transaction(() => writer.writeOne({ id: "a", position: 1, note: "one" }));
  assert.deepEqual(readWidgets(db), [{ id: "a", position: 1, note: "one" }]);
  const seen = spyDb(db);
  const remembering = new RowWriter<Widget>(seen.proxy, {
    table: "widget",
    identity: (row) => ({ id: row.id }),
    columns: (row) => ({ position: row.position }),
    data: (row) => JSON.stringify({ note: row.note }),
  });
  remembering.writeOne({ id: "a", position: 1, note: "one" });
  remembering.write([{ id: "a", position: 1, note: "one" }]);
  assert.equal(seen.statements.length, 1, "the row is written once, then known");
  remembering.deleteOne({ id: "a", position: 1, note: "one" });
  assert.equal(db.countRows("widget"), 0);
  assert.deepEqual(remembering.remembered(), []);
  db.close();
});

test("a change in a derived column alone is still a change", () => {
  const db = openDatabase(":memory:");
  const writer = widgetWriter(db);
  writer.write([
    { id: "a", position: 1, note: "one" },
    { id: "b", position: 2, note: "two" },
  ]);
  // A project drag: the objects are untouched, only their order moves. Comparing the JSON
  // alone would call that "no change" and lose the reorder.
  writer.write([
    { id: "b", position: 1, note: "two" },
    { id: "a", position: 2, note: "one" },
  ]);
  assert.deepEqual(
    db.all<{ id: string; position: number }>("SELECT id, position FROM widget ORDER BY position").map((row) => row.id),
    ["b", "a"],
  );
  db.close();
});

test("a composite key deletes exactly its own row", () => {
  const db = openDatabase(":memory:");
  db.exec("CREATE TABLE entry (owner TEXT, seq INTEGER, data TEXT, PRIMARY KEY (owner, seq))");
  const writer = new RowWriter<{ owner: string; seq: number; text: string }>(db, {
    table: "entry",
    identity: (row) => ({ owner: row.owner, seq: row.seq }),
    data: (row) => row.text,
  });
  writer.write([
    { owner: "a", seq: 1, text: "one" },
    { owner: "a", seq: 2, text: "two" },
    { owner: "b", seq: 1, text: "one" },
  ]);
  writer.write([{ owner: "a", seq: 2, text: "two" }]);
  assert.deepEqual(
    db.all<{ owner: string; seq: number }>("SELECT owner, seq FROM entry ORDER BY owner, seq").map((row) => `${row.owner}/${row.seq}`),
    ["a/2"],
  );
  db.close();
});

test("an identifier that is not table-safe is refused", () => {
  const db = openDatabase(":memory:");
  assert.throws(
    () =>
      new RowWriter<Widget>(db, {
        table: "widget; DROP TABLE legacy_imports",
        identity: (row) => ({ id: row.id }),
        data: (row) => row.note,
      }),
    /标识符/,
  );
  db.close();
});

// ---------------------------------------------------------------------------
// Legacy JSON import
// ---------------------------------------------------------------------------

type Widgets = { items: string[] };

/** A stand-in store: one table, one JSON file, the same shape every real store has. */
function legacySpec(db: Db, file: string, options: { declare?: number; explode?: boolean } = {}): LegacyImport<Widgets> {
  return {
    name: "widgets",
    file,
    load: (value) => {
      const raw = value as { items?: unknown };
      return { items: Array.isArray(raw?.items) ? (raw.items as string[]) : [] };
    },
    save: (value) => {
      if (options.explode) throw new Error("写入到一半炸了");
      for (const id of value.items) db.run("INSERT INTO widget (id, data) VALUES (?, ?)", id, JSON.stringify({ note: id }));
      return options.declare ?? value.items.length;
    },
    count: () => db.countRows("widget"),
  };
}

function importSetup(): { dir: string; db: Db; file: string } {
  const dir = tempDir();
  const db = openDatabase(join(dir, "fastvibe.db"));
  withRows(db);
  return { dir, db, file: join(dir, "widgets.json") };
}

test("the legacy file is imported once, then kept under a new name", () => {
  const { dir, db, file } = importSetup();
  writeFileSync(file, JSON.stringify({ items: ["a", "b"] }), "utf8");
  assert.equal(importLegacyJson(db, legacySpec(db, file)), "imported");

  assert.equal(db.countRows("widget"), 2);
  assert.equal(
    db.get<{ status: string; rows: number }>("SELECT status, rows FROM legacy_imports WHERE name = 'widgets'")?.status,
    "imported",
  );
  // Renamed, not deleted — it is the only recovery point there is (§4.4, decision 2).
  assert.ok(!existsSync(file));
  const kept = readdirSync(dir).filter((name) => name.startsWith("widgets.json.migrated-"));
  assert.equal(kept.length, 1, readdirSync(dir).join(","));
  assert.equal(readFileSync(join(dir, kept[0]), "utf8"), JSON.stringify({ items: ["a", "b"] }));

  // A crash between the commit and the rename: the record exists and the file is still
  // where it was, so the next open finishes the rename and does not import again.
  writeFileSync(file, JSON.stringify({ items: ["a", "b", "c"] }), "utf8");
  assert.equal(importLegacyJson(db, legacySpec(db, file, { declare: 99 })), "already", "the writer is not even called");
  assert.equal(db.countRows("widget"), 2, "no second import");
  assert.ok(!existsSync(file), "the orphaned file was renamed aside");
  assert.equal(readdirSync(dir).filter((name) => name.startsWith("widgets.json.migrated-")).length, 2);
  db.close();
});

test("an unreadable legacy file becomes .corrupt-* and the store starts empty", () => {
  const { dir, db, file } = importSetup();
  writeFileSync(file, "{ nope", "utf8");
  assert.equal(importLegacyJson(db, legacySpec(db, file)), "corrupt");
  assert.equal(db.countRows("widget"), 0);
  assert.ok(!existsSync(file));
  assert.ok(readdirSync(dir).some((name) => name.startsWith("widgets.json.corrupt-")), readdirSync(dir).join(","));
  assert.equal(
    db.get<{ status: string }>("SELECT status FROM legacy_imports WHERE name = 'widgets'")?.status,
    "corrupt",
  );
  // Recorded as done: the next open does not go hunting for a file already answered.
  assert.equal(importLegacyJson(db, legacySpec(db, file)), "already");
  db.close();
});

test("a legacy file that is simply absent imports nothing and is looked for again", () => {
  const { db, file } = importSetup();
  assert.equal(importLegacyJson(db, legacySpec(db, file)), "absent");
  assert.equal(db.countRows("legacy_imports"), 0);
  writeFileSync(file, JSON.stringify({ items: ["a"] }), "utf8");
  assert.equal(importLegacyJson(db, legacySpec(db, file)), "imported", "a file that appears later is still taken in");
  db.close();
});

test("a row-count mismatch rolls the import back and leaves the file alone", () => {
  const { db, file } = importSetup();
  writeFileSync(file, JSON.stringify({ items: ["a", "b"] }), "utf8");
  // The writer claims a number the tables do not agree with: nothing may land.
  assert.equal(importLegacyJson(db, legacySpec(db, file, { declare: 3 })), "failed");
  assert.equal(db.countRows("widget"), 0, "the transaction rolled back, not half of it");
  assert.equal(db.countRows("legacy_imports"), 0, "nothing recorded, so the next start retries");
  assert.ok(existsSync(file), "the only copy of the data is untouched");
  assert.equal(readFileSync(file, "utf8"), JSON.stringify({ items: ["a", "b"] }));
  db.close();
});

test("an import that throws part-way leaves no rows and no record", () => {
  const { db, file } = importSetup();
  writeFileSync(file, JSON.stringify({ items: ["a"] }), "utf8");
  assert.equal(importLegacyJson(db, legacySpec(db, file, { explode: true })), "failed");
  assert.equal(db.countRows("widget"), 0);
  assert.equal(db.countRows("legacy_imports"), 0);
  assert.ok(existsSync(file));
  db.close();
});

test("closing folds the wal into the file and no cached connection is left open", () => {
  const dir = tempDir();
  const file = join(dir, "fastvibe.db");
  const db = openDatabase(file);
  withRows(db);
  db.run("INSERT INTO widget (id, data) VALUES (?, ?)", "a", "{}");
  assert.ok(existsSync(join(dir, "fastvibe.db-wal")));
  closeDatabases();
  assert.ok(!existsSync(join(dir, "fastvibe.db-wal")), "wal_checkpoint(TRUNCATE) then close");
  const reopened = openDatabase(file);
  assert.notEqual(reopened, db, "the cache was cleared, so this is a new connection");
  assert.equal(reopened.countRows("widget"), 1);
  reopened.close();
});
