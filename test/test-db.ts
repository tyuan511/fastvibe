import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDatabase, openDatabaseConnection, type Db } from "../src/main/engine/db.ts";
import { DagStore } from "../src/main/engine/dag-store.ts";

/**
 * The fixture every migrated store test shares.
 *
 * These tests used to build a store over a JSON file and prove persistence by building a
 * second store over the same path — 「重新打开同一个文件」. The stores now take a `Db`, so
 * the same idea is 「在同一个库上再建一个 store」: `openTestDb(dir)` is cached per directory,
 * which is exactly what production does with `<userData>/fastvibe.db`.
 *
 * A test that needs a *second process* — one that does not share the first's memory of the
 * table — asks for `openSecondTestDb`, because the whole point of the migration is what two
 * of them do to the same rows.
 */
export function testDir(prefix = "fastvibe-test-"): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

/** This process's connection to `<dir>/fastvibe.db`, created on the first call. */
export function openTestDb(dir: string): Db {
  return openDatabase(join(dir, "fastvibe.db"));
}

/** A second, independent connection to the same file: the other process. */
export function openSecondTestDb(dir: string): Db {
  return openDatabaseConnection(join(dir, "fastvibe.db"));
}

/**
 * A `Db` that records the `run()` statements it was asked to execute, and can be told to
 * fail them.
 *
 * The point of the row storage is that a flush writes only what changed, and the only way to
 * show that from outside is to count the statements — the table looks the same either way.
 * `failWith` stands in for the disk that filled up mid-write, which is what the durable
 * queue's 「commit before it becomes visible」 rule is about.
 */
export function spyDb(db: Db): {
  proxy: Db;
  statements: string[];
  failWith: (message: string | null) => void;
} {
  const statements: string[] = [];
  let failure: string | null = null;
  return {
    statements,
    failWith: (message) => {
      failure = message;
    },
    proxy: {
      file: db.file,
      get closed() {
        return db.closed;
      },
      run: (sql, ...params) => {
        statements.push(sql);
        if (failure !== null) throw new Error(failure);
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

/**
 * A DAG store over `<dir>/fastvibe.db`, with its node outputs in `<dir>/dag.json.results`.
 *
 * The results directory is not in the database on purpose (§5.6): a run's full output can be
 * megabytes, and the order that matters is «write the artifact, then publish the completion».
 * Tests read and write real files there, so the path stays a parameter.
 */
export function openDagStore(dir: string): DagStore {
  return new DagStore(openTestDb(dir), { resultsDir: join(dir, "dag.json.results") });
}
