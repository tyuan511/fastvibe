// SPDX-License-Identifier: MIT
// Repository/receipt semantics adapted from deepseek-ai/dsh-superagent-prototype
// at 8c32a9dc5d72c033816c6a8110b37f40cf94fba4; see ../core/NOTICE.md and LICENSE.
import { createHash } from "node:crypto";
import { openDatabaseConnection, type Db, type DbRow } from "../../engine/db.ts";
import { threadKey, type Decision, type Thread, type Ticket, type Trigger, type TriggerDisposition } from "../core/model.ts";
import type { OutboundMessage, Repositories, ReplyStatus } from "../core/ports.ts";
import type { LegacyMigrationPlan, LegacyRecord } from "./legacy.ts";
import { assertShadowPath, SHADOW_MIGRATIONS, SHADOW_SCHEMA_VERSION } from "./schema.ts";

type JsonRow = { data: string };
const decode = <T>(row: JsonRow | undefined): T | undefined => row ? JSON.parse(row.data) as T : undefined;
const many = <T>(rows: JsonRow[]): T[] => rows.map(row => JSON.parse(row.data) as T);
const json = (value: unknown): string => {
  const result = JSON.stringify(value);
  if (result === undefined) throw new Error("Shadow 记录必须能序列化为 JSON");
  return result;
};
function synchronous<T>(value: T): T {
  if (value !== null && (typeof value === "object" || typeof value === "function") && "then" in value) {
    throw new Error("Shadow 事务只允许同步回调");
  }
  return value;
}
function duration(now: number, ttl: number): number {
  if (!Number.isSafeInteger(now) || !Number.isSafeInteger(ttl) || ttl <= 0 || !Number.isSafeInteger(now + ttl)) throw new Error("租约时间必须为安全整数且有效期大于零");
  return now + ttl;
}
export type EffectKind = "assessment" | "launch" | "delivery" | "relay" | "notice" | "reply" | "source-operation" | "source-reconcile";
export interface EffectRecord {
  kind: EffectKind; key: string; payload: unknown; seq: number; generation: number; attempts: number;
  error: string; due: number; since: number; status: "pending" | "running" | "uncertain" | "done" | "cancelled";
  leaseOwner?: string; leaseUntil?: number; claimedGeneration?: number; claimToken: number;
}
export interface Lease { resource: string; owner: string; generation: number; expiresAt: number }
export interface Receipt extends OutboundMessage { status: ReplyStatus; dropped?: { at: string; reason: "channelGone" | "channelIgnored" } }
export interface Operation {
  id: string; source: string; instance: string; key: string;
  status: "planned" | "uncertain" | "confirmed" | "failed" | "cancelled";
  revision: number; payload: unknown; receipt?: unknown;
}
export interface MigrationProgress {
  snapshotId: string; digest: string; total: number; nextRow: number;
  status: "pending" | "completed"; plan: LegacyMigrationPlan;
}
export interface SessionReceipt {
  sessionKey: string; requestId: string; stage: "accepted" | "persisted" | "read" | "reported";
  [field: string]: unknown;
}

/** No model, timers, source registry or production factory references this disposable store. */
export function openShadowStore(file = ":memory:", report: (error: unknown) => void = () => {}): ShadowStore {
  assertShadowPath(file);
  const db = openDatabaseConnection(file, { migrations: SHADOW_MIGRATIONS });
  try { return new ShadowStore(db, report); }
  catch (error) { db.close(); throw error; }
}

/** Synchronous repositories with DB-owned state; there is no stale mutable aggregate cache. */
export class ShadowStore implements Repositories {
  readonly db: Db;
  private readonly report: (error: unknown) => void;
  private callbacks: (() => void)[][] = [];
  private savepoint = 0;
  constructor(db: Db, report: (error: unknown) => void = () => {}) {
    assertShadowPath(db.file);
    if (db.userVersion() !== SHADOW_SCHEMA_VERSION || db.get<{ value: string }>("SELECT value FROM dsh_shadow_meta WHERE key='purpose'")?.value !== "isolated-m2") {
      throw new Error("必须使用已完成独立迁移的 Shadow 数据库");
    }
    this.db = db;
    this.report = report;
  }
  close(): void { this.db.close(); }

  atomic<T>(work: () => T): T {
    if (this.callbacks.length === 0) {
      const actions: (() => void)[] = [];
      const value = this.db.transaction(() => {
        this.callbacks.push(actions);
        try { return synchronous(work()); }
        finally { this.callbacks.pop(); }
      });
      for (const action of actions) this.notify(action);
      return value;
    }
    const name = `dsh_shadow_${++this.savepoint}`;
    this.db.exec(`SAVEPOINT ${name}`);
    const actions: (() => void)[] = [];
    this.callbacks.push(actions);
    try {
      const value = synchronous(work());
      this.db.exec(`RELEASE ${name}`);
      this.callbacks[this.callbacks.length - 2]!.push(...actions);
      return value;
    } catch (error) {
      this.db.exec(`ROLLBACK TO ${name}`);
      this.db.exec(`RELEASE ${name}`);
      throw error;
    } finally { this.callbacks.pop(); }
  }
  /** Wake-ups only: persistent intents must already be in SQL before commit. */
  afterCommit(action: () => void): void {
    if (this.callbacks.length) this.callbacks[this.callbacks.length - 1]!.push(action);
    else this.notify(action);
  }
  private notify(action: () => void): void {
    try { action(); }
    catch (error) { try { this.report(error); } catch { /* A reporting failure cannot undo a commit. */ } }
  }

  readonly triggers = {
    get: (id: string): Trigger | undefined => decode(this.db.get<JsonRow>("SELECT data FROM dsh_triggers WHERE id=?", id)),
    save: (trigger: Trigger): void => this.atomic(() => {
      this.db.run("INSERT INTO dsh_triggers(id,source,at,data) VALUES(?,?,?,?) ON CONFLICT(id) DO UPDATE SET source=excluded.source,at=excluded.at,data=excluded.data", trigger.id, trigger.source, trigger.at, json(trigger));
      this.db.run("DELETE FROM dsh_trigger_threads WHERE trigger_id=?", trigger.id);
      for (const ref of trigger.threads) this.db.run("INSERT OR IGNORE INTO dsh_trigger_threads VALUES(?,?,?,?)", threadKey(ref), trigger.id, trigger.at, trigger.human);
    }),
    disposition: (id: string): TriggerDisposition | undefined => decode(this.db.get<JsonRow>("SELECT data FROM dsh_dispositions WHERE id=?", id)),
    saveDisposition: (id: string, value: TriggerDisposition): void => {
      this.db.run("INSERT INTO dsh_dispositions(id,data) VALUES(?,?) ON CONFLICT(id) DO UPDATE SET data=excluded.data", id, json(value));
    },
    byThread: (key: string): Trigger[] => many(this.db.all<JsonRow>("SELECT t.data FROM dsh_trigger_threads x JOIN dsh_triggers t ON t.id=x.trigger_id WHERE x.thread_key=? ORDER BY x.at,x.trigger_id", key)),
  };
  readonly threads = {
    get: (key: string): Thread | undefined => decode(this.db.get<JsonRow>("SELECT data FROM dsh_threads WHERE key=?", key)),
    save: (thread: Thread): void => {
      if (thread.key !== threadKey(thread.ref) || (thread.evaluating && thread.evaluating.threadKey !== thread.key)) throw new Error("Thread 与 Evaluation 的归属不一致");
      this.db.run("INSERT INTO dsh_threads(key,source,data) VALUES(?,?,?) ON CONFLICT(key) DO UPDATE SET source=excluded.source,data=excluded.data", thread.key, thread.ref.source, json(thread));
    },
    list: (): Thread[] => many(this.db.all<JsonRow>("SELECT data FROM dsh_threads ORDER BY rowid")),
    active: (): Thread[] => many(this.db.all<JsonRow>("SELECT data FROM dsh_threads WHERE active=1 ORDER BY rowid")),
  };
  readonly tickets = {
    get: (id: string): Ticket | undefined => decode(this.db.get<JsonRow>("SELECT data FROM dsh_tickets WHERE id=?", id)),
    save: (ticket: Ticket): void => this.atomic(() => {
      this.db.run("INSERT INTO dsh_tickets(id,decision_id,data) VALUES(?,?,?) ON CONFLICT(id) DO UPDATE SET decision_id=excluded.decision_id,data=excluded.data", ticket.id, ticket.decisionId, json(ticket));
      this.db.run("DELETE FROM dsh_assignments WHERE ticket_id=?", ticket.id);
      for (const item of ticket.assignments) this.db.run("INSERT INTO dsh_assignments VALUES(?,?,?)", item.id, ticket.id, item.state);
    }),
    list: (): Ticket[] => many(this.db.all<JsonRow>("SELECT data FROM dsh_tickets ORDER BY rowid DESC")),
    open: (): Ticket[] => many(this.db.all<JsonRow>("SELECT data FROM dsh_tickets WHERE open=1 ORDER BY rowid DESC")),
    active: (): Ticket[] => many(this.db.all<JsonRow>("SELECT data FROM dsh_tickets WHERE active=1 ORDER BY rowid DESC")),
  };
  readonly decisions = {
    get: (id: string): Decision | undefined => decode(this.db.get<JsonRow>("SELECT data FROM dsh_decisions WHERE id=?", id)),
    save: (decision: Decision): void => this.atomic(() => {
      const existing = this.decisions.get(decision.id);
      if (existing && (existing.evalId !== decision.evalId || existing.threadKey !== decision.threadKey
        || existing.kind !== decision.kind || json(existing.triggerIds) !== json(decision.triggerIds))) throw new Error("Decision 的归属、结果与批次不可改变");
      this.db.run("INSERT INTO dsh_decisions(id,thread_key,eval_id,kind,at,data) VALUES(?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET data=excluded.data", decision.id, decision.threadKey, decision.evalId, decision.kind, decision.at, json(decision));
      if (decision.kind === "accept") {
        for (const triggerId of new Set(decision.triggerIds)) {
          const current = this.db.get<{ decision_id: string }>("SELECT decision_id FROM dsh_accepted_triggers WHERE trigger_id=?", triggerId);
          if (current && current.decision_id !== decision.id) throw new Error("Trigger 已由其他 Decision 接受");
          this.db.run("INSERT OR IGNORE INTO dsh_accepted_triggers VALUES(?,?)", triggerId, decision.id);
        }
      }
    }),
    byThread: (key: string): Decision[] => many(this.db.all<JsonRow>("SELECT data FROM dsh_decisions WHERE thread_key=? ORDER BY rowid", key)),
  };
  get<T>(key: string): T | undefined { return decode(this.db.get<JsonRow>("SELECT data FROM dsh_kv WHERE key=?", key)); }
  set(key: string, value: unknown): void { this.db.run("INSERT INTO dsh_kv VALUES(?,?) ON CONFLICT(key) DO UPDATE SET data=excluded.data", key, json(value)); }

  readonly receipts = {
    get: (id: string): Receipt | undefined => decode(this.db.get<JsonRow>("SELECT data FROM dsh_outbox WHERE id=?", id)),
    add: (message: OutboundMessage): boolean => this.db.run("INSERT INTO dsh_outbox(id,status,ticket_id,thread_key,data) VALUES(?,'pending',?,?,?) ON CONFLICT(id) DO NOTHING", message.id, message.ticketId, message.channel.thread, json({ ...message, status: "pending" })).changes > 0,
    waiting: (): Receipt[] => many(this.db.all<JsonRow>("SELECT data FROM dsh_outbox WHERE status='pending' ORDER BY rowid")),
    /** Withdraw only an unsent message; sent/dropped IDs remain permanent receipts. */
    withdrawPending: (id: string): boolean => this.db.run("DELETE FROM dsh_outbox WHERE id=? AND status='pending'", id).changes > 0,
    settle: (id: string, status: "sent" | "dropped", dropped?: Receipt["dropped"]): boolean => this.atomic(() => {
      const receipt = this.receipts.get(id);
      if (!receipt || receipt.status !== "pending") return false;
      if (status === "dropped" && !dropped) throw new Error("丢弃消息必须记录原因");
      return this.db.run("UPDATE dsh_outbox SET status=?,data=? WHERE id=? AND status='pending'", status, json({ ...receipt, status, ...(dropped ? { dropped } : {}) }), id).changes > 0;
    }),
  };

  readonly effects = {
    get: (kind: EffectKind, key: string): EffectRecord | undefined => this.effectRow(this.db.get("SELECT * FROM dsh_effects WHERE kind=? AND key=?", kind, key)),
    enqueue: (kind: EffectKind, key: string, payload: unknown, now: number): EffectRecord => this.atomic(() => {
      this.db.run(`INSERT INTO dsh_effects(kind,key,payload,seq,generation,due,since,status)
        VALUES(?,?,?,(SELECT COALESCE(MAX(seq),0)+1 FROM dsh_effects),0,?,?,'pending') ON CONFLICT(kind,key) DO UPDATE SET
        payload=excluded.payload,generation=generation+1,
        attempts=CASE WHEN status IN ('running','uncertain') THEN attempts ELSE 0 END,
        error=CASE WHEN status='uncertain' THEN error ELSE '' END,due=excluded.due,
        status=CASE WHEN status IN ('running','uncertain') THEN status ELSE 'pending' END`, kind, key, json(payload), now, now);
      return this.effects.get(kind, key)!;
    }),
    /** Domain cancellation may withdraw queued work, but never pretend an in-flight attempt stopped. */
    cancelPending: (kind: EffectKind, key: string): boolean =>
      this.db.run("UPDATE dsh_effects SET status='cancelled' WHERE kind=? AND key=? AND status='pending' AND lease_owner IS NULL", kind, key).changes > 0,
    due: (kind: EffectKind, now: number, limit = 100): EffectRecord[] => this.db.all("SELECT * FROM dsh_effects WHERE kind=? AND status='pending' AND due<=? ORDER BY seq LIMIT ?", kind, now, limit).map(row => this.effectRow(row)!),
    claim: (kind: EffectKind, key: string, owner: string, now: number, ttl: number): EffectRecord | undefined => this.atomic(() => {
      const until = duration(now, ttl);
      const changed = this.db.run(`UPDATE dsh_effects SET status='running',lease_owner=?,lease_until=?,claimed_generation=generation,claim_token = 1 + claim_token,attempts=attempts+1
        WHERE kind=? AND key=? AND due<=? AND status='pending' AND lease_owner IS NULL`, owner, until, kind, key, now).changes;
      return changed ? this.effects.get(kind, key) : undefined;
    }),
    // Expired attempts become uncertain, never silently reissued after an unknown external write.
    expire: (now: number): number => this.db.run("UPDATE dsh_effects SET status='uncertain',lease_owner=NULL,lease_until=NULL WHERE status='running' AND lease_until<=?", now).changes,
    settle: (claim: EffectRecord, status: "done" | "pending" | "uncertain" | "cancelled", now: number, due = now, error = ""): boolean => this.atomic(() => {
      const current = this.effects.get(claim.kind, claim.key);
      if (!current) return false;
      const changed = this.db.run(`UPDATE dsh_effects SET
        status=CASE WHEN generation!=? AND ? IN ('done','cancelled') THEN 'pending' ELSE ? END,
        due=CASE WHEN generation=? THEN ? ELSE due END,error=?,
        attempts=CASE WHEN generation=? THEN attempts ELSE 0 END,
        lease_owner=NULL,lease_until=NULL,claimed_generation=CASE WHEN ?='uncertain' THEN claimed_generation ELSE NULL END
        WHERE kind=? AND key=? AND claimed_generation=? AND claim_token=? AND status='running' AND lease_owner=? AND lease_until>?`,
      claim.generation, status, status, claim.generation, due, error, claim.generation, status,
      claim.kind, claim.key, claim.generation, claim.claimToken, claim.leaseOwner, now).changes;
      // A valid old attempt may release its own lease; it never settles a newer payload.
      return changed > 0 && current.generation === claim.generation;
    }),
    /** Explicit result of reconciliation; ordinary enqueue can never clear uncertain. */
    reconcile: (expected: EffectRecord, outcome: "retry" | "done" | "cancelled", now: number): boolean =>
      this.db.run(`UPDATE dsh_effects SET status=CASE WHEN ?='retry' OR (? IN ('done','cancelled') AND generation!=claimed_generation) THEN 'pending' ELSE ? END,
        due=?,error='',claimed_generation=NULL WHERE kind=? AND key=? AND status='uncertain' AND generation=? AND claim_token=?`,
      outcome, outcome, outcome, now, expected.kind, expected.key, expected.generation, expected.claimToken).changes > 0,
  };
  private effectRow(row: DbRow | undefined): EffectRecord | undefined {
    if (!row) return undefined;
    return { kind: row.kind as EffectKind, key: String(row.key), payload: JSON.parse(String(row.payload)), seq: Number(row.seq),
      generation: Number(row.generation), attempts: Number(row.attempts), error: String(row.error), due: Number(row.due), since: Number(row.since),
      status: row.status as EffectRecord["status"], claimToken: Number(row.claim_token),
      ...(row.claimed_generation === null ? {} : { claimedGeneration: Number(row.claimed_generation) }),
      ...(row.lease_owner === null ? {} : { leaseOwner: String(row.lease_owner), leaseUntil: Number(row.lease_until) }) };
  }
  readonly leases = {
    get: (resource: string): Lease | undefined => {
      const row = this.db.get("SELECT * FROM dsh_leases WHERE resource=?", resource);
      return row ? { resource, owner: String(row.owner), generation: Number(row.generation), expiresAt: Number(row.expires_at) } : undefined;
    },
    acquire: (resource: string, owner: string, now: number, ttl: number): Lease | undefined => this.atomic(() => {
      const until = duration(now, ttl);
      const changed = this.db.run(`INSERT INTO dsh_leases VALUES(?,?,1,?) ON CONFLICT(resource) DO UPDATE SET
        owner=excluded.owner,generation=generation+1,expires_at=excluded.expires_at WHERE expires_at<=?`, resource, owner, until, now).changes;
      return changed ? this.leases.get(resource) : undefined;
    }),
    renew: (lease: Lease, now: number, ttl: number): boolean => this.db.run("UPDATE dsh_leases SET expires_at=? WHERE resource=? AND owner=? AND generation=? AND expires_at>?", duration(now, ttl), lease.resource, lease.owner, lease.generation, now).changes > 0,
    release: (lease: Lease, now: number): boolean => this.db.run("UPDATE dsh_leases SET expires_at=? WHERE resource=? AND owner=? AND generation=? AND expires_at>?", now, lease.resource, lease.owner, lease.generation, now).changes > 0,
  };
  readonly cursors = {
    get: <T>(source: string, instance: string, key: string): { revision: number; value: T } | undefined => {
      const row = this.db.get<{ revision: number; data: string }>("SELECT revision,data FROM dsh_source_cursors WHERE source=? AND instance=? AND cursor_key=?", source, instance, key);
      return row ? { revision: row.revision, value: JSON.parse(row.data) as T } : undefined;
    },
    // CAS prevents an overlapping poll from overwriting a newer cursor. Instances never share progress.
    save: (source: string, instance: string, key: string, value: unknown, expectedRevision = 0): boolean => this.atomic(() => {
      const current = this.cursors.get(source, instance, key);
      if ((current?.revision ?? 0) !== expectedRevision) return false;
      this.db.run(`INSERT INTO dsh_source_cursors VALUES(?,?,?,1,?) ON CONFLICT(source,instance,cursor_key) DO UPDATE SET
        revision=revision+1,data=excluded.data`, source, instance, key, json(value));
      return true;
    }),
  };
  readonly operations = {
    get: (source: string, instance: string, key: string): Operation | undefined => decode(this.db.get<JsonRow>("SELECT data FROM dsh_operations WHERE source=? AND instance=? AND operation_key=?", source, instance, key)),
    plan: (operation: Omit<Operation, "status" | "revision">): Operation => this.atomic(() => {
      const current = this.operations.get(operation.source, operation.instance, operation.key);
      if (current) {
        if (current.id !== operation.id || json(current.payload) !== json(operation.payload)) throw new Error("外部操作同一身份的意图已变化，必须先对账");
        return current;
      }
      const planned: Operation = { ...operation, status: "planned", revision: 1 };
      this.db.run("INSERT INTO dsh_operations VALUES(?,?,?,?,?,?,?)", operation.id, operation.source, operation.instance, operation.key, planned.status, planned.revision, json(planned));
      return planned;
    }),
    transition: (expected: Operation, next: Operation["status"], receipt?: unknown): boolean => this.atomic(() => {
      const current = this.operations.get(expected.source, expected.instance, expected.key);
      if (!current || current.id !== expected.id || current.status !== expected.status || current.revision !== expected.revision) return false;
      const allowed: Record<Operation["status"], Operation["status"][]> = {
        planned: ["uncertain", "confirmed", "failed", "cancelled"],
        uncertain: ["confirmed", "failed", "cancelled"],
        failed: ["planned", "cancelled"], confirmed: [], cancelled: [],
      };
      if (!allowed[current.status].includes(next)) throw new Error("外部操作不可按此路径重试；未知结果必须先对账，已收束操作不可重新执行");
      const updated: Operation = { ...current, status: next, revision: current.revision + 1, ...(receipt === undefined ? {} : { receipt }) };
      return this.db.run("UPDATE dsh_operations SET status=?,revision=?,data=? WHERE source=? AND instance=? AND operation_key=? AND status=? AND revision=?", next, updated.revision, json(updated), current.source, current.instance, current.key, expected.status, expected.revision).changes > 0;
    }),
  };
  /** Archive-only conversion checkpoints. No row here is consumable by Engine or Effects. */
  readonly migrations = {
    get: (snapshotId: string): MigrationProgress | undefined => {
      const row = this.db.get("SELECT * FROM dsh_migration_runs WHERE snapshot_id=?", snapshotId);
      return row ? { snapshotId, digest: String(row.digest), total: Number(row.total), nextRow: Number(row.next_row),
        status: row.status as MigrationProgress["status"], plan: JSON.parse(String(row.report)) as LegacyMigrationPlan } : undefined;
    },
    begin: (plan: LegacyMigrationPlan): MigrationProgress => this.atomic(() => {
      const serialized = json(plan);
      const digest = createHash("sha256").update(serialized).digest("hex");
      const current = this.migrations.get(plan.snapshotId);
      if (current) {
        if (current.digest !== digest) throw new Error("同一迁移快照的内容或转换规则已变化，必须使用新的 snapshotId");
        return current;
      }
      if (!plan.snapshotId || plan.namespace !== plan.snapshotId || plan.records.some(record => record.authorized !== false
        || record.namespace !== plan.namespace || !["archived", "needs-reconciliation", "blocked", "invalid"].includes(record.classification))
        || plan.counts.total !== plan.records.length || plan.counts.mappings !== plan.mappings.length) throw new Error("迁移报告不完整或包含未经核对的授权");
      const identities = new Map(plan.mappings.map(item => [json([item.table, item.legacyKey]), item.newId]));
      const recordIdentities = new Set(plan.records.map(record => json([record.table, record.legacyKey])));
      if (identities.size !== plan.mappings.length || new Set(identities.values()).size !== identities.size
        || identities.size !== recordIdentities.size || plan.records.some(record => identities.get(json([record.table, record.legacyKey])) !== record.newId)) throw new Error("旧数据映射存在重复身份或遗漏");
      this.db.run("INSERT INTO dsh_migration_runs VALUES(?,?,?,0,?,?)", plan.snapshotId, digest, plan.mappings.length, plan.mappings.length ? "pending" : "completed", serialized);
      return this.migrations.get(plan.snapshotId)!;
    }),
    advance: (snapshotId: string, batchSize = 100): MigrationProgress => this.atomic(() => {
      if (!Number.isSafeInteger(batchSize) || batchSize <= 0) throw new Error("迁移批大小必须为正整数");
      const progress = this.migrations.get(snapshotId);
      if (!progress) throw new Error("迁移快照不存在");
      if (progress.status === "completed") return progress;
      const groups = new Map<string, LegacyRecord[]>();
      for (const record of progress.plan.records) {
        const id = json([record.table, record.legacyKey]);
        groups.set(id, [...(groups.get(id) ?? []), record]);
      }
      const next = Math.min(progress.nextRow + batchSize, progress.total);
      for (const mapping of progress.plan.mappings.slice(progress.nextRow, next)) {
        const records = groups.get(json([mapping.table, mapping.legacyKey]));
        if (!records?.length || records.some(record => record.newId !== mapping.newId || record.authorized !== false)) throw new Error("迁移快照映射与证据不一致");
        const levels = ["archived", "needs-reconciliation", "blocked", "invalid"];
        const classification = levels[Math.max(...records.map(record => levels.indexOf(record.classification)))];
        if (!classification) throw new Error("未知的旧数据分类");
        this.db.run("INSERT INTO dsh_legacy_mappings VALUES(?,?,?,?,?,?)", snapshotId, mapping.table, mapping.legacyKey, mapping.newId, classification, json({ mapping, records }));
      }
      const count = Number(this.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM dsh_legacy_mappings WHERE snapshot_id=?", snapshotId)?.n);
      if (count !== next) throw new Error("迁移映射行数与检查点不一致");
      this.db.run("UPDATE dsh_migration_runs SET next_row=?,status=? WHERE snapshot_id=?", next, next === progress.total ? "completed" : "pending", snapshotId);
      return this.migrations.get(snapshotId)!;
    }),
    records: (snapshotId: string): { mapping: LegacyMigrationPlan["mappings"][number]; records: LegacyRecord[] }[] =>
      many(this.db.all<JsonRow>("SELECT data FROM dsh_legacy_mappings WHERE snapshot_id=? ORDER BY legacy_table,legacy_id", snapshotId)),
  };
  readonly sessionReceipts = {
    get: (sessionKey: string, requestId: string): SessionReceipt | undefined => decode(this.db.get<JsonRow>("SELECT data FROM dsh_session_receipts WHERE session_key=? AND request_id=?", sessionKey, requestId)),
    save: (receipt: SessionReceipt): void => this.atomic(() => {
      const current = this.sessionReceipts.get(receipt.sessionKey, receipt.requestId);
      const stages = ["accepted", "persisted", "read", "reported"];
      if (current && stages.indexOf(receipt.stage) < stages.indexOf(current.stage)) throw new Error("Session 回执不可倒退");
      this.db.run("INSERT INTO dsh_session_receipts VALUES(?,?,?,?) ON CONFLICT(session_key,request_id) DO UPDATE SET stage=excluded.stage,data=excluded.data", receipt.sessionKey, receipt.requestId, receipt.stage, json({ ...current, ...receipt }));
    }),
  };
}
