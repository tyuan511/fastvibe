/**
 * The database's schema: one ordered step per release that changed it.
 *
 * `PRAGMA user_version` is the version, and a step's number is its index plus one. Each
 * step runs in its own transaction (`db.ts`), so a failed startup migration leaves the
 * database exactly as it was and the next launch retries the same step.
 *
 * Every table follows the same shape (§4.3 of `docs/sqlite-storage.md`): the key, the few
 * columns that exist to be queried, ordered by, or cascaded from, and a `data TEXT`
 * holding the whole object as JSON. Adding a field to `Conversation`, `DagNode` or
 * `ScheduledTask` therefore costs no migration — the columns only earn their place when
 * something reads them. Times are epoch milliseconds in an INTEGER; JS doubles hold every
 * real timestamp, and reading them back as `number` beats unwrapping BigInt everywhere.
 */
import type { Db } from "./db.ts";

/**
 * Step 1: the bookkeeping the one-time JSON imports need.
 *
 * One row per store, so an import that committed but was interrupted before renaming the
 * old file is recognised the next time and *finished* rather than repeated.
 */
function v1(db: Db): void {
  db.exec(`
    CREATE TABLE legacy_imports (
      name        TEXT PRIMARY KEY,
      imported_at INTEGER NOT NULL,
      rows        INTEGER NOT NULL,
      -- 'imported' | 'corrupt': a file that could not be parsed is recorded as done,
      -- because starting from empty *is* the decision that was made about it.
      status      TEXT NOT NULL
    )
  `);
}

/**
 * Step 2: 思考耗时 (`reasoning-store.ts`).
 *
 * `seq` is not the row's identity, it is its age: the map used to be read back in the order
 * it was written, and the cap that keeps 5000 entries needs to know which end is old. A
 * re-`set` of an existing entry takes a new `seq`, which is what「重新插入保持顺序」means
 * once the ordering lives in a table instead of in a Map's insertion order.
 */
function v2(db: Db): void {
  db.exec(`
    CREATE TABLE reasoning_blocks (
      entry_id TEXT PRIMARY KEY,
      seq      INTEGER NOT NULL,
      bounds   TEXT NOT NULL
    )
  `);
  db.exec("CREATE INDEX reasoning_seq ON reasoning_blocks(seq)");
}

/**
 * Step 3: the memory pipeline's bookkeeping (`memory-state.ts`).
 *
 * Three maps keyed by conversation id, because that is what the pipeline holds and what it
 * prunes: `#prune` drops conversations this machine no longer has, and a row per
 * conversation makes that a `DELETE` instead of a 295 KB rewrite.
 */
function v3(db: Db): void {
  db.exec(`
    CREATE TABLE memory_outputs (
      conversation_id TEXT PRIMARY KEY,
      data            TEXT NOT NULL
    );
    CREATE TABLE memory_empty (
      conversation_id TEXT PRIMARY KEY,
      data            TEXT NOT NULL
    );
    CREATE TABLE memory_failures (
      conversation_id TEXT PRIMARY KEY,
      data            TEXT NOT NULL
    );
    CREATE TABLE memory_meta (
      key   TEXT PRIMARY KEY,
      value TEXT NOT NULL
    )
  `);
}

/**
 * Step 4: 检查点 (`checkpoint.ts`).
 *
 * `head` and `repos` are columns because the restore path branches on them (a tracked file
 * is put back from git, an opaque one is skipped), and `created_at` is what the 重试 dialog
 * shows. The file rows hang off the parent with `ON DELETE CASCADE`: a checkpoint is
 * replaced as a unit, and an orphan row would restore content the conversation never had.
 */
function v4(db: Db): void {
  db.exec(`
    CREATE TABLE checkpoints (
      conversation_id TEXT PRIMARY KEY,
      cwd             TEXT NOT NULL,
      created_at      INTEGER NOT NULL,
      head            TEXT,
      repos           TEXT
    );
    CREATE TABLE checkpoint_files (
      conversation_id TEXT NOT NULL REFERENCES checkpoints(conversation_id) ON DELETE CASCADE,
      seq             INTEGER NOT NULL,
      path            TEXT NOT NULL,
      data            TEXT NOT NULL,
      PRIMARY KEY (conversation_id, seq)
    )
  `);
}

/**
 * Step 5: the conversation catalog (§5.1).
 *
 * The columns are the whole reason this table is not a blob: `project` is what a per-project
 * list asks for, `session_id` is what the engine's own lookup goes by, and `created_at` is
 * the order the sidebar shows — which is the array order the JSON file happened to keep.
 * `projects.position` is the one column that carries meaning the object does not: the order
 * the user dragged the sidebar into.
 */
function v5(db: Db): void {
  db.exec(`
    CREATE TABLE projects (
      cwd      TEXT PRIMARY KEY,
      position INTEGER NOT NULL,
      data     TEXT NOT NULL
    );
    CREATE TABLE conversations (
      id         TEXT PRIMARY KEY,
      project    TEXT,
      kind       TEXT,
      parent_id  TEXT,
      session_id TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      data       TEXT NOT NULL
    );
    CREATE INDEX conversations_project ON conversations(project);
    CREATE INDEX conversations_session ON conversations(session_id);
    CREATE TABLE catalog_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)
  `);
}

/**
 * Step 6: the durable prompt queue (§5.5).
 *
 * `position` is the queue's whole point — a follow-up must drain in the order the user put
 * them in, and a drag has to survive a restart — so it is a column, not a detail inside the
 * JSON. One `queue_state` row per conversation carries the revision clients compare against
 * and the pause that keeps the drain from sending.
 */
function v6(db: Db): void {
  db.exec(`
    CREATE TABLE queue_items (
      id              TEXT PRIMARY KEY,
      conversation_id TEXT NOT NULL,
      position        INTEGER NOT NULL,
      data            TEXT NOT NULL
    );
    CREATE INDEX queue_conv ON queue_items(conversation_id, position);
    CREATE TABLE queue_state (
      conversation_id TEXT PRIMARY KEY,
      revision        INTEGER NOT NULL,
      pause           TEXT
    )
  `);
}

/**
 * Step 7: the scheduled Agent tasks and their runs (§5.7).
 *
 * `position` is the run list's order, which is observable: `queued()` reads it backwards, so
 * a restart must not drain the queue in a different order. `task_id` / `status` /
 * `started_at` are what the history panel and the 500-run trim ask for.
 */
function v7(db: Db): void {
  db.exec(`
    CREATE TABLE scheduled_tasks (
      id   TEXT PRIMARY KEY,
      data TEXT NOT NULL
    );
    CREATE TABLE scheduled_runs (
      id         TEXT PRIMARY KEY,
      task_id    TEXT NOT NULL,
      position   INTEGER NOT NULL,
      started_at INTEGER,
      status     TEXT NOT NULL,
      data       TEXT NOT NULL
    );
    CREATE INDEX scheduled_runs_task ON scheduled_runs(task_id, position);
    CREATE TABLE schedule_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)
  `);
}

/**
 * Step 8: the sub-agent task graphs (§5.6).
 *
 * `dag_meta.seq` is the node-number counter, and it is the row that makes the table more
 * than a store: deriving the next number from the nodes that happen to exist would hand out
 * a number that a deleted node already used, and that number is a sub-agent run id too. So it
 * is bumped in the same transaction that inserts the nodes it names.
 *
 * A node's `position` is its place in the graph's own array — the order the panel draws.
 */
function v8(db: Db): void {
  db.exec(`
    CREATE TABLE dag_graphs (
      conversation_id TEXT PRIMARY KEY,
      revision        INTEGER NOT NULL,
      paused          INTEGER NOT NULL,
      created_at      INTEGER NOT NULL,
      updated_at      INTEGER NOT NULL,
      data            TEXT NOT NULL
    );
    CREATE TABLE dag_nodes (
      conversation_id TEXT NOT NULL REFERENCES dag_graphs(conversation_id) ON DELETE CASCADE,
      id              TEXT NOT NULL,
      position        INTEGER NOT NULL,
      data            TEXT NOT NULL,
      PRIMARY KEY (conversation_id, id)
    );
    CREATE TABLE dag_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)
  `);
}

/**
 * Step 9: intentionally empty.
 *
 * A development build created `drafts` / `drafts_meta` here for a feature that was then
 * removed. Databases that already ran the step are at version 9 and a build that does not
 * know it refuses to open them, so the number stays taken. Those tables are unused and may be
 * left where they are.
 */
function v9(_db: Db): void {}

/** The whole schema, in order. Its length is the version this build of the app knows. */
export const MIGRATIONS: Array<(db: Db) => void> = [v1, v2, v3, v4, v5, v6, v7, v8, v9];

export const SCHEMA_VERSION = MIGRATIONS.length;
