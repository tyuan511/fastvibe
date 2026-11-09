import { lstatSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { MIGRATIONS } from "../../engine/db-schema.ts";
import type { Db } from "../../engine/db.ts";

// This fork is never registered in db-schema.ts. Production stays at schema 14.
// Changing the production base requires an explicit rebase, never implicit renumbering.
export const SHADOW_BASE_SCHEMA_VERSION = 14;
export const SHADOW_SCHEMA_VERSION = 15;

export type ShadowPathOptions = { allowedRoot?: string };

/** M2 may touch only memory databases and disposable files beneath the real OS temp directory.
 * Production DSH opens use an explicit userData sub-root; callers must opt into that root. */
export function assertShadowPath(file: string, options: ShadowPathOptions = {}): void {
  if (file === ":memory:") return;
  const root = options.allowedRoot === undefined ? realpathSync(tmpdir()) : realpathSync(options.allowedRoot);
  let ancestor = resolve(file);
  const tail: string[] = [];
  for (;;) {
    try { lstatSync(ancestor); break; }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      tail.unshift(basename(ancestor));
      const parent = dirname(ancestor);
      if (parent === ancestor) throw new Error("Shadow 数据库路径无法解析");
      ancestor = parent;
    }
  }
  const actual = join(realpathSync(ancestor), ...tail);
  const fromRoot = relative(root, actual);
  if (!fromRoot || fromRoot === ".." || fromRoot.startsWith(`..${sep}`) || isAbsolute(fromRoot)) {
    throw new Error(options.allowedRoot === undefined
      ? "Shadow 数据库只允许内存库或系统临时目录，不得连接真实 userData"
      : "Shadow 数据库必须位于显式授权的 DSH 数据目录");
  }
}

function shadow15(db: Db): void {
  db.exec(`
    CREATE TABLE dsh_shadow_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    INSERT INTO dsh_shadow_meta VALUES ('purpose', 'isolated-m2');
    CREATE TABLE dsh_triggers (
      id TEXT PRIMARY KEY, source TEXT NOT NULL, at TEXT NOT NULL,
      data TEXT NOT NULL CHECK(json_valid(data))
    );
    CREATE INDEX dsh_trigger_at ON dsh_triggers(at,id);
    CREATE INDEX dsh_trigger_source ON dsh_triggers(source,at,id);
    CREATE TABLE dsh_trigger_threads (
      thread_key TEXT NOT NULL, trigger_id TEXT NOT NULL REFERENCES dsh_triggers(id) ON DELETE CASCADE,
      at TEXT NOT NULL, human INTEGER NOT NULL CHECK(human IN (0,1)), PRIMARY KEY(thread_key,trigger_id)
    );
    CREATE INDEX dsh_trigger_thread_at ON dsh_trigger_threads(thread_key,at,trigger_id);
    CREATE TABLE dsh_dispositions (
      id TEXT PRIMARY KEY REFERENCES dsh_triggers(id), data TEXT NOT NULL CHECK(json_valid(data))
    );
    CREATE TABLE dsh_threads (
      key TEXT PRIMARY KEY, source TEXT NOT NULL, data TEXT NOT NULL CHECK(json_valid(data)),
      active INTEGER GENERATED ALWAYS AS (CASE WHEN json_array_length(data,'$.pending') > 0
        OR json_type(data,'$.evaluating') = 'object' THEN 1 ELSE 0 END) VIRTUAL,
      eval_id TEXT GENERATED ALWAYS AS (json_extract(data,'$.evaluating.id')) VIRTUAL,
      subscribed INTEGER GENERATED ALWAYS AS (CASE WHEN json_array_length(data,'$.subscriptions') > 0 THEN 1 ELSE 0 END) VIRTUAL
    );
    CREATE INDEX dsh_thread_active ON dsh_threads(active) WHERE active=1;
    CREATE INDEX dsh_thread_subscribed ON dsh_threads(source,subscribed) WHERE subscribed=1;
    CREATE UNIQUE INDEX dsh_eval_identity ON dsh_threads(eval_id) WHERE eval_id IS NOT NULL;
    CREATE TABLE dsh_decisions (
      id TEXT PRIMARY KEY, thread_key TEXT NOT NULL REFERENCES dsh_threads(key), eval_id TEXT NOT NULL UNIQUE,
      kind TEXT NOT NULL, at TEXT NOT NULL, data TEXT NOT NULL CHECK(json_valid(data))
    );
    CREATE INDEX dsh_decision_thread ON dsh_decisions(thread_key,at,id);
    CREATE TABLE dsh_accepted_triggers (
      trigger_id TEXT PRIMARY KEY REFERENCES dsh_triggers(id), decision_id TEXT NOT NULL REFERENCES dsh_decisions(id)
    );
    CREATE TABLE dsh_tickets (
      id TEXT PRIMARY KEY, decision_id TEXT NOT NULL UNIQUE REFERENCES dsh_decisions(id),
      data TEXT NOT NULL CHECK(json_valid(data)),
      open INTEGER GENERATED ALWAYS AS (CASE WHEN json_type(data,'$.ended') = 'object' THEN 0 ELSE 1 END) VIRTUAL,
      active INTEGER GENERATED ALWAYS AS (CASE WHEN json_array_length(data,'$.undelivered') > 0
        OR json_extract(data,'$.assignments[#-1].state') IN ('pending','running') THEN 1 ELSE 0 END) VIRTUAL
    );
    CREATE INDEX dsh_ticket_open ON dsh_tickets(open) WHERE open=1;
    CREATE INDEX dsh_ticket_active ON dsh_tickets(active) WHERE active=1;
    CREATE TABLE dsh_assignments (
      id TEXT PRIMARY KEY, ticket_id TEXT NOT NULL REFERENCES dsh_tickets(id) ON DELETE CASCADE,
      state TEXT NOT NULL CHECK(state IN ('pending','running','ended'))
    );
    CREATE UNIQUE INDEX dsh_ticket_live_assignment ON dsh_assignments(ticket_id) WHERE state IN ('pending','running');
    CREATE INDEX dsh_assignment_state ON dsh_assignments(state,ticket_id);
    CREATE TABLE dsh_effects (
      kind TEXT NOT NULL, key TEXT NOT NULL, payload TEXT NOT NULL CHECK(json_valid(payload)),
      seq INTEGER NOT NULL UNIQUE, generation INTEGER NOT NULL CHECK(generation>=0),
      attempts INTEGER NOT NULL DEFAULT 0 CHECK(attempts>=0), error TEXT NOT NULL DEFAULT '',
      due INTEGER NOT NULL, since INTEGER NOT NULL,
      status TEXT NOT NULL CHECK(status IN ('pending','running','uncertain','done','cancelled')),
      lease_owner TEXT, lease_until INTEGER, claimed_generation INTEGER, claim_token INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY(kind,key), CHECK((lease_owner IS NULL) = (lease_until IS NULL)),
      CHECK(status != 'running' OR lease_owner IS NOT NULL)
    );
    CREATE INDEX dsh_effect_due ON dsh_effects(kind,status,due,seq);
    CREATE INDEX dsh_effect_lease ON dsh_effects(status,lease_until) WHERE lease_owner IS NOT NULL;
    CREATE TABLE dsh_outbox (
      id TEXT PRIMARY KEY, status TEXT NOT NULL CHECK(status IN ('pending','sent','dropped')),
      ticket_id TEXT, thread_key TEXT NOT NULL, data TEXT NOT NULL CHECK(json_valid(data))
    );
    CREATE INDEX dsh_outbox_waiting ON dsh_outbox(status,ticket_id,thread_key);
    CREATE TABLE dsh_kv (key TEXT PRIMARY KEY, data TEXT NOT NULL CHECK(json_valid(data)));
    CREATE TABLE dsh_source_cursors (
      source TEXT NOT NULL, instance TEXT NOT NULL, cursor_key TEXT NOT NULL,
      revision INTEGER NOT NULL, data TEXT NOT NULL CHECK(json_valid(data)), PRIMARY KEY(source,instance,cursor_key)
    );
    CREATE TABLE dsh_leases (
      resource TEXT PRIMARY KEY, owner TEXT NOT NULL, generation INTEGER NOT NULL CHECK(generation>0), expires_at INTEGER NOT NULL
    );
    CREATE TABLE dsh_operations (
      id TEXT PRIMARY KEY, source TEXT NOT NULL, instance TEXT NOT NULL, operation_key TEXT NOT NULL,
      status TEXT NOT NULL CHECK(status IN ('planned','uncertain','confirmed','failed','cancelled')),
      revision INTEGER NOT NULL DEFAULT 1 CHECK(revision>0), data TEXT NOT NULL CHECK(json_valid(data)), UNIQUE(source,instance,operation_key)
    );
    CREATE INDEX dsh_operation_reconcile ON dsh_operations(status,source,instance);
    CREATE TABLE dsh_session_receipts (
      session_key TEXT NOT NULL, request_id TEXT NOT NULL, stage TEXT NOT NULL CHECK(stage IN ('accepted','persisted','read','reported')),
      data TEXT NOT NULL CHECK(json_valid(data)), PRIMARY KEY(session_key,request_id)
    );
    CREATE TABLE dsh_migration_runs (
      snapshot_id TEXT PRIMARY KEY, digest TEXT NOT NULL, total INTEGER NOT NULL, next_row INTEGER NOT NULL DEFAULT 0,
      status TEXT NOT NULL CHECK(status IN ('pending','completed')), report TEXT NOT NULL CHECK(json_valid(report))
    );
    CREATE TABLE dsh_legacy_mappings (
      snapshot_id TEXT NOT NULL REFERENCES dsh_migration_runs(snapshot_id), legacy_table TEXT NOT NULL, legacy_id TEXT NOT NULL,
      target_id TEXT NOT NULL, classification TEXT NOT NULL, data TEXT NOT NULL CHECK(json_valid(data)),
      PRIMARY KEY(snapshot_id,legacy_table,legacy_id), UNIQUE(snapshot_id,target_id)
    );
  `);
}

// Keep this explicit: a future production schema cannot silently occupy shadow step 15.
export const SHADOW_MIGRATIONS: readonly ((db: Db) => void)[] = [
  ...MIGRATIONS.slice(0, SHADOW_BASE_SCHEMA_VERSION),
  (db: Db) => {
    if (MIGRATIONS.length !== SHADOW_BASE_SCHEMA_VERSION) throw new Error("Shadow 迁移基线已变化，需要显式重建迁移序列");
    shadow15(db);
  },
];
