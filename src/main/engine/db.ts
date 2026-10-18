/**
 * The database layer every data-class store shares.
 *
 * FastVibe used to keep its mutable state in a dozen JSON / JSONL files. Three problems
 * pushed them into one SQLite database (`docs/sqlite-storage.md`): whole-file rewrites
 * meant two processes over the same data directory (the installed app plus `pnpm dev`,
 * which skips the single-instance lock) could overwrite each other; the checkpoint store
 * only wrote on quit, so a crash lost every「重试前回退文件」snapshot; and anything that
 * wanted a slice of the data — the usage window, one conversation's queue — had to read
 * the whole file. Configuration stays in JSON: `settings.json` is handed whole to every
 * renderer, and credentials keep their own 0600 files.
 *
 * `node:sqlite` is still development status, and its API has moved between releases. So
 * **this module is the only place that imports it** — swapping in `better-sqlite3` would
 * be a change here and nowhere else. Stores take a `Db` and never see `DatabaseSync`.
 *
 * One connection per process per file, cached by absolute path: the stores all live in
 * Main's process and there is no reason for eight of them to hold eight cursors over the
 * same file. That is also why transactions are non-reentrant — a store's flush is a
 * synchronous stretch of work with nothing else running, and an accidental nested `BEGIN`
 * would otherwise be answered by SQLite with a confusing error.
 */
import { existsSync, chmodSync, mkdirSync, readFileSync, renameSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { DatabaseSync, type StatementSync } from "node:sqlite";
import { MIGRATIONS } from "./db-schema.ts";

/** What may be bound to a `?`. `undefined` is accepted and stored as NULL. */
export type SqlParam = string | number | bigint | Uint8Array | null | undefined | boolean;
/** What comes back. Rows are SQLite's own objects, with NULL as `null`. */
export type DbRow = Record<string, unknown>;
export type RunResult = { changes: number; lastInsertRowid: number };

/**
 * A connection. Everything is synchronous, like the stores that use it.
 *
 * Rows are null-prototype objects, so read named fields off them; do not compare one to a
 * `{ … }` literal with `deepStrictEqual`.
 */
export type Db = {
  /** Absolute path, or `:memory:`. */
  readonly file: string;
  run(sql: string, ...params: SqlParam[]): RunResult;
  get<T extends DbRow = DbRow>(sql: string, ...params: SqlParam[]): T | undefined;
  all<T extends DbRow = DbRow>(sql: string, ...params: SqlParam[]): T[];
  /** One or more statements, no parameters. */
  exec(sql: string): void;
  /**
   * `BEGIN IMMEDIATE` … `COMMIT`, with a `ROLLBACK` if `fn` throws. Not reentrant.
   * `IMMEDIATE` takes the write lock up front, so a transaction that read nothing does not
   * have to fail halfway because another process wrote in between.
   */
  transaction<T>(fn: () => T): T;
  /** `PRAGMA user_version`: read with no argument, set with one. */
  userVersion(): number;
  userVersion(next: number): void;
  /** Rows a table holds — the import guard and the tests both read this. */
  countRows(table: string): number;
  close(): void;
  readonly closed: boolean;
};

const MEMORY = ":memory:";
const SQLITE_CORRUPT = 11;
const SQLITE_NOTADB = 26;

class Connection implements Db {
  readonly file: string;
  #db: DatabaseSync;
  #statements = new Map<string, StatementSync>();
  #inTransaction = false;
  #closed = false;

  constructor(file: string, db: DatabaseSync) {
    this.file = file;
    this.#db = db;
  }

  get closed(): boolean {
    return this.#closed;
  }

  run(sql: string, ...params: SqlParam[]): RunResult {
    const result = this.#prepare(sql).run(...params.map(bind));
    return { changes: Number(result.changes), lastInsertRowid: Number(result.lastInsertRowid) };
  }

  get<T extends DbRow = DbRow>(sql: string, ...params: SqlParam[]): T | undefined {
    return this.#prepare(sql).get(...params.map(bind)) as T | undefined;
  }

  all<T extends DbRow = DbRow>(sql: string, ...params: SqlParam[]): T[] {
    return this.#prepare(sql).all(...params.map(bind)) as T[];
  }

  exec(sql: string): void {
    this.#db.exec(sql);
  }

  transaction<T>(fn: () => T): T {
    if (this.#inTransaction) {
      throw new Error("SQLite 事务不能嵌套（db.transaction 里不要再调 db.transaction）");
    }
    this.exec("BEGIN IMMEDIATE");
    this.#inTransaction = true;
    let committed = false;
    try {
      const value = fn();
      this.exec("COMMIT");
      committed = true;
      return value;
    } finally {
      if (!committed) {
        try {
          this.exec("ROLLBACK");
        } catch {
          // The transaction is already gone (SQLite aborted it when the statement failed).
        }
      }
      this.#inTransaction = false;
    }
  }

  userVersion(): number;
  userVersion(next: number): void;
  userVersion(next?: number): number | void {
    if (next === undefined) {
      const row = this.#prepare("PRAGMA user_version").get() as { user_version?: number } | undefined;
      return Number(row?.user_version ?? 0);
    }
    // A literal, never a bound `?`: PRAGMA takes no parameters.
    this.exec(`PRAGMA user_version = ${Math.trunc(next)}`);
  }

  countRows(table: string): number {
    assertIdentifier(table);
    const row = this.#prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n?: number } | undefined;
    return Number(row?.n ?? 0);
  }

  close(): void {
    if (this.#closed) return;
    try {
      this.#db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
    } catch {
      // Another process still holds the write lock; the log is folded in on its next
      // checkpoint. Nothing here depends on this one having happened.
    }
    try {
      this.#db.close();
    } finally {
      this.#closed = true;
      this.#statements.clear();
    }
  }

  #prepare(sql: string): StatementSync {
    if (this.#closed) throw new Error(`SQLite 连接已关闭：${this.file}`);
    let statement = this.#statements.get(sql);
    if (!statement) {
      statement = this.#db.prepare(sql);
      this.#statements.set(sql, statement);
    }
    return statement;
  }
}

/**
 * `node:sqlite` refuses `undefined` and has no boolean affinity, and every store would
 * otherwise have to remember that. NULL is the absence a column means, and 0/1 is what the
 * schema's INTEGER columns hold.
 */
function bind(value: SqlParam): null | number | bigint | string | Uint8Array {
  if (value === undefined) return null;
  if (typeof value === "boolean") return value ? 1 : 0;
  return value;
}

function assertIdentifier(name: string): void {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) throw new Error(`不是合法的 SQLite 标识符：${name}`);
}

// ---------------------------------------------------------------------------
// Opening
// ---------------------------------------------------------------------------

const cache = new Map<string, Db>();

/**
 * Open (and prepare) the database, or return the connection this process already has.
 *
 * `:memory:` is never cached: two callers asking for an in-memory database mean two
 * separate databases, which is what makes one usable as a single-store fixture.
 */
export function openDatabase(file: string): Db {
  if (file === MEMORY) return openPrepared(file);
  const key = resolve(file);
  const existing = cache.get(key);
  if (existing && !existing.closed) return existing;
  const db = openPrepared(key);
  cache.set(key, db);
  return db;
}

/**
 * A second, independent connection to the same file, outside the cache.
 *
 * Production code uses `openDatabase`. This exists for the tests that need a *second
 * process* — two of them sharing one database is the whole point of the migration — and the
 * caller owns closing it.
 */
export function openDatabaseConnection(file: string): Db {
  return openPrepared(file === MEMORY ? MEMORY : resolve(file));
}

function openPrepared(file: string): Db {
  if (file !== MEMORY) mkdirSync(dirname(file), { recursive: true });
  const db = new Connection(file, new DatabaseSync(file));
  try {
    return prepare(db);
  } catch (error) {
    // A half-prepared connection must not keep the file open, and must not be cached.
    db.close();
    if (file !== MEMORY && existsSync(file) && isCorruption(error)) {
      throw new Error(quarantine(file), { cause: error });
    }
    throw error;
  }
}

/** PRAGMAs, permissions, schema migrations, one incremental vacuum. */
function prepare(db: Connection): Db {
  // `auto_vacuum` must be set *before* anything else initialises the file: measured on a
  // fresh database, setting it after `journal_mode = WAL` is accepted and then silently
  // ignored (`PRAGMA auto_vacuum` keeps reading 0). It is a header field, and the WAL
  // pragma is what writes that header first.
  if (db.file !== MEMORY) db.exec("PRAGMA auto_vacuum = INCREMENTAL");
  db.exec("PRAGMA journal_mode = WAL");
  db.exec("PRAGMA synchronous = NORMAL");
  // Another process writing while we start: wait rather than throw SQLITE_BUSY.
  db.exec("PRAGMA busy_timeout = 5000");
  // The checkpoint and DAG child tables hang off `ON DELETE CASCADE`.
  db.exec("PRAGMA foreign_keys = ON");
  // Checkpoints hold workspace source, so the file is private from the first byte. The
  // `-wal` / `-shm` sidecars take the main file's mode, which is why this runs before
  // anything is written — but do not rely on it: `test/db.test.ts` asserts all three, and
  // this runs again after the migration for a file created by an older build.
  harden(db.file);
  migrate(db);
  harden(db.file);
  try {
    // Deleted checkpoints leave free pages behind, and the file would otherwise only
    // shrink on a full VACUUM. Cheap when the freelist is empty.
    db.exec("PRAGMA incremental_vacuum");
  } catch {
    // Never fail a startup over a shrink.
  }
  return db;
}

function harden(file: string): void {
  if (file === MEMORY) return;
  for (const suffix of ["", "-wal", "-shm"]) {
    try {
      chmodSync(file + suffix, 0o600);
    } catch {
      // A missing sidecar is normal; an unchangeable one is the filesystem's answer.
    }
  }
}

/**
 * Bring the schema up to date, one transaction per step.
 *
 * The version is re-read *inside* each transaction: two processes can open a brand new
 * database at the same moment (an installed app and a dev instance), the second waits out
 * `busy_timeout` behind the first, and without the re-read it would run the same
 * `CREATE TABLE` again and fail startup with `table … already exists`.
 */
function migrate(db: Connection): void {
  const target = MIGRATIONS.length;
  const at = db.userVersion();
  if (at > target) {
    // A newer FastVibe already wrote this database. Downgrading a schema is not something
    // to guess at, so say so instead of half-reading tables we do not know.
    throw new Error(
      `FastVibe 数据库（${db.file}）由更新的版本写过（schema ${at}，这个版本只认到 ${target}）。` +
        `请升级到写入它的那个版本；确实要退回这个版本，就退出应用后把它连同 -wal / -shm 改名备份再启动。`,
    );
  }
  for (let step = at; step < target; step++) {
    db.transaction(() => {
      const now = db.userVersion();
      if (now >= step + 1) return;
      MIGRATIONS[step](db);
      db.userVersion(step + 1);
    });
  }
}

// ---------------------------------------------------------------------------
// Corruption
// ---------------------------------------------------------------------------

function isCorruption(error: unknown): boolean {
  const code = (error as { errcode?: number } | undefined)?.errcode;
  if (code === SQLITE_CORRUPT || code === SQLITE_NOTADB) return true;
  const text = message(error).toLowerCase();
  return text.includes("malformed") || text.includes("not a database");
}

/**
 * Move a damaged database aside rather than beginning again quietly.
 *
 * One database now carries what a dozen files used to, so losing it is not something to
 * truncate and rebuild without telling anyone: the catalog and the checkpoints are
 * metadata, and a silent fresh start would read as「我的会话全没了」. Transcripts stay in
 * their own JSONL files, so the conversations themselves survive either way.
 */
function quarantine(file: string): string {
  const target = uniqueName(dirname(file), `${basename(file)}.corrupt-${Date.now()}`);
  try {
    renameSync(file, target);
  } catch {
    return `FastVibe 数据库已损坏（${file}），并且无法把它改名备份。请手动处理这个文件后重试。`;
  }
  for (const suffix of ["-wal", "-shm"]) {
    try {
      renameSync(file + suffix, target + suffix);
    } catch {
      // No sidecar belongs to this generation of the file.
    }
  }
  return (
    `FastVibe 数据库已损坏，已连同 -wal / -shm 改名为 ${target}。重启 FastVibe 会新建一个空数据库：` +
    `会话正文不在数据库里，所以对话本身不会丢，丢的是目录、检查点这类元数据。`
  );
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

// ---------------------------------------------------------------------------
// Closing
// ---------------------------------------------------------------------------

/** Fold each WAL into its file and close every cached connection. Called from the quit path. */
export function closeDatabases(): void {
  for (const db of cache.values()) {
    try {
      db.close();
    } catch {
      // A connection that will not close is not worth holding a quit over.
    }
  }
  cache.clear();
}

/** Cached connections this process still holds open — for the shutdown check and for tests. */
export function openDatabaseCount(): number {
  return [...cache.values()].filter((db) => !db.closed).length;
}

// ---------------------------------------------------------------------------
// Legacy JSON import
// ---------------------------------------------------------------------------

/**
 * One-time import of the JSON file a store used to own.
 *
 * §4.4: each store imports on **its own** first open rather than in one sweep at startup,
 * so a store that is never constructed (the memory bookkeeping, on a headless Agent) never
 * touches its old file. The store's *existing* read/normalise code parses the JSON, which
 * is why the catalog's v0 / v1 migrations are reused instead of being written a second
 * time.
 */
export type LegacyImport<T> = {
  /** Stable key in `legacy_imports`; the import runs at most once per name. */
  name: string;
  /** The JSON file this store used to own. */
  file: string;
  /** The store's existing read + normalise code, handed the parsed JSON. */
  load: (value: unknown) => T;
  /**
   * What an unreadable file means. The default moves it aside and starts empty, which is
   * right for data that can be re-derived — and wrong for the prompt queue, where an empty
   * start is followed by a write, and the write replaces the file nobody could read.
   */
  unreadable?: "quarantine" | "throw";
  /** Write the rows inside the import transaction; return how many rows were written. */
  save: (value: T) => number;
  /** Count what is actually in the tables this store owns, in the same transaction. */
  count: () => number;
};

export type LegacyImportOutcome = "imported" | "already" | "absent" | "corrupt" | "failed";

export function importLegacyJson<T>(db: Db, spec: LegacyImport<T>): LegacyImportOutcome {
  const record = db.get<{ imported_at: number }>("SELECT imported_at FROM legacy_imports WHERE name = ?", spec.name);
  const fileIsThere = existsSync(spec.file);

  if (record) {
    // Committed but never renamed — finish the rename, and never import twice.
    if (fileIsThere) renameAside(spec.file, "migrated");
    return "already";
  }
  if (!fileIsThere) return "absent";

  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(spec.file, "utf8"));
  } catch (error) {
    if (spec.unreadable === "throw") {
      throw new Error(`无法读取 ${spec.name} 的旧数据（${spec.file}）：${message(error)}`, { cause: error });
    }
    // Unreadable or unparseable: the rule the conversation catalog already used — keep the
    // bytes for a human, start empty, and record that the import is done.
    renameAside(spec.file, "corrupt");
    db.run(
      "INSERT INTO legacy_imports (name, imported_at, rows, status) VALUES (?, ?, ?, ?) ON CONFLICT(name) DO NOTHING",
      spec.name,
      Date.now(),
      0,
      "corrupt",
    );
    console.error(`[db] ${spec.name} 旧文件读不出来，已改名保留并从空状态开始：${message(error)}`);
    return "corrupt";
  }

  try {
    const rows = db.transaction(() => {
      const declared = spec.save(spec.load(parsed));
      // 「要么全进去，要么都没进去」: the writer says how many rows it wrote and the tables
      // have to agree before the COMMIT, so a half-imported store cannot land.
      const actual = spec.count();
      if (actual !== declared) {
        throw new Error(`${spec.name} 导入校验失败：写入声明 ${declared} 行，表里实际 ${actual} 行`);
      }
      db.run(
        `INSERT INTO legacy_imports (name, imported_at, rows, status) VALUES (?, ?, ?, ?)
         ON CONFLICT(name) DO UPDATE SET imported_at = excluded.imported_at, rows = excluded.rows, status = excluded.status`,
        spec.name,
        Date.now(),
        declared,
        "imported",
      );
      return declared;
    });
    // After the commit: leaving the file in place would let an older version of the app
    // keep writing JSON the new one has already imported, and the next upgrade would
    // ignore those changes because the import is recorded. Renamed, a rollback sees an
    // empty state instead — recoverable, and honest about it.
    renameAside(spec.file, "migrated");
    console.log(`[db] 已导入 ${spec.name} 旧数据：${rows} 行`);
    return "imported";
  } catch (error) {
    // Rolled back, nothing recorded, file untouched: the next startup tries again.
    console.error(`[db] ${spec.name} 旧数据导入失败，旧文件保持不变：${message(error)}`);
    return "failed";
  }
}

function renameAside(file: string, kind: "migrated" | "corrupt"): void {
  const target = uniqueName(dirname(file), `${basename(file)}.${kind}-${Date.now()}`);
  try {
    renameSync(file, target);
  } catch (error) {
    console.error(`[db] ${file} 改名为 ${target} 失败：${message(error)}`);
  }
}

/** Never overwrite a previous quarantine — they are the only recovery point there is. */
function uniqueName(dir: string, name: string): string {
  let candidate = join(dir, name);
  for (let n = 1; existsSync(candidate); n++) candidate = join(dir, `${name}-${n}`);
  return candidate;
}

// ---------------------------------------------------------------------------
// Writing only what changed
// ---------------------------------------------------------------------------

/**
 * How one object maps onto one row: the key columns, the JSON payload, and the few extra
 * columns that exist to be queried or ordered by (§4.3).
 */
export type RowSpec<T> = {
  table: string;
  /** PRIMARY KEY column(s) → value. Composite keys are fine. */
  identity: (row: T) => Record<string, SqlParam>;
  /** The whole object as JSON: adding a field to the type costs no migration. */
  data: (row: T) => string;
  /** Columns pulled out of the object for `WHERE` / `ORDER BY` / cascades. */
  columns?: (row: T) => Record<string, SqlParam>;
  /** JSON payload column, `data` unless a table says otherwise. */
  dataColumn?: string;
};

type RowState = { identity: Record<string, SqlParam>; json: string; fingerprint: string };

/**
 * Keeps a table in step with an in-memory list, writing only the rows that changed.
 *
 * The alternative — serialize the whole object, rename — is exactly what this migration
 * removes: it rewrites bytes that did not change, and a second process holding an older
 * copy overwrites whatever the first wrote in between. So the diff is against this writer's
 * memory of the table, and a row that has left the list is a `DELETE`, never a reason to
 * rewrite the others.
 *
 * It does **not** open a transaction: the store owns the atomic unit (the whole flush, or
 * the capture-plus-files of one checkpoint) and wraps the call in `db.transaction`.
 *
 * Call `prime()` with what the table already holds and write nothing, so the first `write()`
 * after startup does not rewrite every row it just read.
 */
export class RowWriter<T> {
  #db: Db;
  #spec: RowSpec<T>;
  #rows = new Map<string, RowState>();

  constructor(db: Db, spec: RowSpec<T>) {
    this.#db = db;
    this.#spec = spec;
    assertIdentifier(spec.table);
  }

  /** The table holds this row with exactly this JSON (and these columns); do not write it again. */
  prime(row: T, json: string): void {
    const identity = this.#spec.identity(row);
    this.#rows.set(keyOf(identity), { identity, json, fingerprint: fingerprintOf(json, this.#extra(row)) });
  }

  /** This writer no longer claims anything about the table (after a delete-all). */
  reset(): void {
    this.#rows.clear();
  }

  /** The keys this writer believes are in the table. */
  remembered(): string[] {
    return [...this.#rows.keys()];
  }

  /** Upsert the rows that differ from what is stored, delete the ones that are gone. */
  write(rows: Iterable<T>): void {
    const next = new Map<string, RowState>();
    for (const row of rows) {
      const identity = this.#spec.identity(row);
      const key = keyOf(identity);
      const json = this.#spec.data(row);
      const extra = this.#spec.columns?.(row) ?? {};
      const fingerprint = fingerprintOf(json, extra);
      if (this.#rows.get(key)?.fingerprint !== fingerprint) this.#upsert(identity, json, extra);
      next.set(key, { identity, json, fingerprint });
    }
    for (const [key, state] of this.#rows) {
      if (next.has(key)) continue;
      const where = entriesToWhere(state.identity);
      this.#db.run(`DELETE FROM ${this.#spec.table} WHERE ${where.sql}`, ...where.params);
    }
    this.#rows = next;
  }

  /**
   * One row now, outside the whole-list diff: the checkpoint store writes at capture time
   * and must not wait for a flush to be durable.
   */
  writeOne(row: T): void {
    const identity = this.#spec.identity(row);
    const json = this.#spec.data(row);
    const extra = this.#spec.columns?.(row) ?? {};
    this.#upsert(identity, json, extra);
    this.#rows.set(keyOf(identity), { identity, json, fingerprint: fingerprintOf(json, extra) });
  }

  /** Drop one row from the table and from what this writer remembers. */
  deleteOne(row: T): void {
    const identity = this.#spec.identity(row);
    const where = entriesToWhere(identity);
    this.#db.run(`DELETE FROM ${this.#spec.table} WHERE ${where.sql}`, ...where.params);
    this.#rows.delete(keyOf(identity));
  }

  #extra(row: T): Record<string, SqlParam> {
    return this.#spec.columns?.(row) ?? {};
  }

  #upsert(identity: Record<string, SqlParam>, json: string, extra: Record<string, SqlParam>): void {
    const dataColumn = this.#spec.dataColumn ?? "data";
    const columns = { ...identity, ...extra, [dataColumn]: json };
    const keyColumns = Object.keys(identity);
    const names = Object.keys(columns);
    for (const name of names) assertIdentifier(name);
    const updates = [...keyColumns, ...Object.keys(extra), dataColumn]
      .map((column) => `${column} = excluded.${column}`)
      .join(", ");
    this.#db.run(
      `INSERT INTO ${this.#spec.table} (${names.join(", ")}) VALUES (${names.map(() => "?").join(", ")})` +
        ` ON CONFLICT (${keyColumns.join(", ")}) DO UPDATE SET ${updates}`,
      ...names.map((name) => columns[name]),
    );
  }
}

function keyOf(identity: Record<string, SqlParam>): string {
  return Object.values(identity)
    .map((value) => String(value ?? "\u0000null"))
    .join("\u0000");
}

/**
 * What "this row has not changed" means: the payload *and* the derived columns.
 *
 * The JSON alone would be enough if the columns were only ever there to be read, but a
 * project's `position` is the sidebar's drag order and lives only in a column — comparing
 * the object would silently drop a reorder.
 */
function fingerprintOf(json: string, extra: Record<string, SqlParam>): string {
  const parts = Object.entries(extra).map(([name, value]) => `${name}=${value ?? "\u0000null"}`);
  return parts.length > 0 ? `${json}\u0000${parts.join("\u0000")}` : json;
}

function entriesToWhere(identity: Record<string, SqlParam>): { sql: string; params: SqlParam[] } {
  const entries = Object.entries(identity);
  return {
    sql: entries.map(([column]) => `${column} = ?`).join(" AND "),
    params: entries.map(([, value]) => value),
  };
}
