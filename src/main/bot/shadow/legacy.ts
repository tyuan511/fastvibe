import { createHash } from "node:crypto";
import type { Db, DbRow } from "../../engine/db.ts";
import { assertShadowPath } from "./schema.ts";

/** Read-only migration evidence. These suggestions never constitute domain commands. */
export const LEGACY_TABLES = [
  "bot_meta", "bot_conversations", "bot_v2_inputs", "bot_attention", "bot_results",
  "bot_outbox", "bot_chat_messages", "bot_runs", "bot_tasks", "bot_attempts",
  "bot_inputs", "bot_questions", "bot_requests", "bot_deliveries",
] as const;
export type LegacyTable = typeof LEGACY_TABLES[number];
export type LegacyClassification = "archived" | "needs-reconciliation" | "blocked" | "invalid";
export type LegacySnapshot = {
  schemaVersion: number;
  tables: Partial<Record<LegacyTable, readonly DbRow[]>>;
  missingTables: readonly LegacyTable[];
};
export type LegacyMapping = {
  table: LegacyTable;
  legacyKey: string;
  newId: string;
};
export type LegacyRecord = LegacyMapping & {
  namespace: string;
  contentHash: string;
  raw: DbRow;
  /** Exact stored payload, including malformed JSON; meta values are plain text. */
  rawJSON: unknown;
  suggestedEntityType: string;
  classification: LegacyClassification;
  reasons: string[];
  authorized: false;
};
export type LegacyMigrationPlan = {
  snapshotId: string;
  namespace: string;
  schemaVersion: number;
  contentHash: string;
  records: LegacyRecord[];
  mappings: LegacyMapping[];
  missingTables: LegacyTable[];
  counts: {
    total: number;
    mappings: number;
    byClassification: Record<LegacyClassification, number>;
    byTable: Record<LegacyTable, number>;
    byReason: Record<string, number>;
  };
};

/** Only SELECTs touch legacy tables. Call outside any existing Db transaction. */
export function readLegacySnapshot(db: Db): LegacySnapshot {
  assertShadowPath(db.file);
  return db.transaction(() => {
    const present = new Set(db.all("SELECT name FROM sqlite_schema WHERE type = 'table'").map((row) => row.name));
    const tables: LegacySnapshot["tables"] = {};
    const missingTables: LegacyTable[] = [];
    for (const table of LEGACY_TABLES) {
      if (present.has(table)) tables[table] = db.all(`SELECT * FROM ${table}`);
      else missingTables.push(table);
    }
    return { schemaVersion: db.userVersion(), tables, missingTables };
  });
}

const suggestions: Record<LegacyTable, string> = {
  bot_meta: "LegacyMetadata", bot_conversations: "SessionReference", bot_v2_inputs: "TicketInput",
  bot_attention: "Attention", bot_results: "Report", bot_outbox: "DeliveryEvidence",
  bot_chat_messages: "MessageEvidence", bot_runs: "Ticket", bot_tasks: "Ticket",
  bot_attempts: "Assignment", bot_inputs: "TicketInput", bot_questions: "Attention",
  bot_requests: "Correlation", bot_deliveries: "DeliveryEvidence",
};
const statuses: Partial<Record<LegacyTable, readonly string[]>> = {
  bot_v2_inputs: ["queued", "running", "accepted", "completed", "failed", "canceled", "uncertain"],
  bot_attention: ["pending", "resolved", "withdrawn"],
  bot_results: ["idle", "ready", "blocked", "failed", "uncertain"],
  bot_outbox: ["pending", "injected", "delivered", "failed"],
};
const terminal = new Set(["completed", "resolved", "withdrawn", "canceled", "cancelled", "delivered", "ended", "done", "succeeded"]);
const interrupted = new Set(["running", "accepted", "uncertain", "injected", "ready", "pending", "queued", "idle", "preparing", "starting"]);
const stopped = new Set(["stopped", "paused", "blocked", "failed"]);
const hash = (value: string): string => createHash("sha256").update(value).digest("hex");
const object = (value: unknown): value is DbRow => value !== null && typeof value === "object" && !Array.isArray(value);
/** Stable JSON object order; payload strings retain their original bytes. */
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (object(value)) return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(",")}}`;
  if (typeof value === "bigint") return JSON.stringify({ bigint: String(value) });
  return JSON.stringify(value) ?? "null";
}
function keyOf(table: LegacyTable, row: DbRow): string {
  const key = row[table === "bot_meta" ? "key" : table === "bot_conversations" ? "conversation_id" : "id"];
  return typeof key === "string" && key.length > 0 ? key : `missing-key:${hash(canonical(row))}`;
}
function mapping(table: LegacyTable, legacyKey: string): LegacyMapping {
  return { table, legacyKey, newId: `legacy-${hash(JSON.stringify([table, legacyKey]))}` };
}

/** Pure dry-run: no session reads, recovery, domain authorization, or Effect creation. */
export function planLegacyMigration(snapshot: LegacySnapshot & { snapshotId: string }): LegacyMigrationPlan {
  if (typeof snapshot.snapshotId !== "string" || !snapshot.snapshotId.trim()) throw new Error("snapshotId must be nonempty");
  const namespace = snapshot.snapshotId;
  const records: LegacyRecord[] = [];
  const identities = new Map<string, LegacyRecord[]>();
  const payloads = new Map<LegacyRecord, DbRow>();
  for (const table of LEGACY_TABLES) {
    for (const source of snapshot.tables[table] ?? []) {
      // Detach output from caller-owned data without parsing or normalizing stored JSON.
      const raw = structuredClone(source);
      const legacyKey = keyOf(table, raw);
      const record: LegacyRecord = {
        ...mapping(table, legacyKey), namespace, raw, rawJSON: table === "bot_meta" ? raw.value : raw.data,
        contentHash: hash(canonical(raw)), suggestedEntityType: suggestions[table],
        classification: "archived", reasons: ["evidence-only-no-authorization"], authorized: false,
      };
      const flag = (classification: LegacyClassification, reason: string) => mark(record, classification, reason);
      const keyColumn = table === "bot_meta" ? "key" : table === "bot_conversations" ? "conversation_id" : "id";
      if (typeof raw[keyColumn] !== "string" || !raw[keyColumn]) flag("invalid", "missing-legacy-key");
      let data: DbRow = {};
      if (table !== "bot_meta" && table !== "bot_requests") {
        try {
          const parsed: unknown = JSON.parse(raw.data as string);
          if (!object(parsed)) flag("invalid", "payload-not-object");
          else data = parsed;
        } catch { flag("invalid", "malformed-json"); }
        if (typeof raw.data !== "string") flag("invalid", "payload-not-string");
      }
      payloads.set(record, data);
      const expectedId = table === "bot_conversations" ? data.conversationId : data.id;
      if (expectedId !== undefined && expectedId !== legacyKey) flag("invalid", "payload-key-conflict");
      for (const [column, field] of [["status", "status"], ["conversation_id", "conversationId"], ["input_id", "inputId"], ["epoch", "epoch"], ["source", "source"], ["role", "role"], ["paused", "paused"], ["target_conversation_id", "targetConversationId"], ["run_id", "runId"], ["task_id", "taskId"]]) {
        if (raw[column] != null && data[field] !== undefined && (column === "paused" ? Boolean(raw[column]) !== data[field] : raw[column] !== data[field])) flag("invalid", `column-payload-conflict:${column}`);
      }
      const enumFields: Array<[string, readonly string[]]> = table === "bot_v2_inputs"
        ? [["source", ["user", "router", "answer", "resume", "report"]]]
        : table === "bot_conversations" ? [["role", ["router", "worker"]]]
        : table === "bot_chat_messages" ? [["role", ["user", "assistant"]]] : [];
      for (const [field, allowed] of enumFields) {
        // Missing fields are supported for minimal legacy evidence; present values must be known.
        for (const value of [raw[field], data[field]]) {
          if (value !== undefined && (typeof value !== "string" || !allowed.includes(value))) flag("invalid", `unknown-${field}`);
        }
      }
      const status = raw.status ?? data.status;
      if (status !== undefined) {
        const allowed = statuses[table];
        if (typeof status !== "string" || (allowed ? !allowed.includes(status) && !stopped.has(status) : !terminal.has(status) && !interrupted.has(status) && !stopped.has(status))) flag("invalid", "unknown-status");
        else if (stopped.has(status)) flag("blocked", "stopped-or-failed-no-auto-resume");
        else if (interrupted.has(status)) flag("needs-reconciliation", `legacy-${status}-not-proof-of-completion`);
      } else if (statuses[table]) flag("invalid", "missing-status");
      if (raw.paused === 1 || raw.paused === true || data.paused === true) flag("blocked", "paused-no-auto-resume");
      if (data.restartRecovery !== undefined) flag("needs-reconciliation", "recovery-marker-not-authorization");
      if (data.memoryBranch !== undefined || data.sessionFile !== undefined || data.sessionId !== undefined) mark(record, "archived", "session-branch-reference-not-read-proof");
      if (table === "bot_conversations") flag("needs-reconciliation", "session-reference-scope-unverified");
      if (table === "bot_runs" || table === "bot_tasks" || table === "bot_attempts") flag("needs-reconciliation", "v11-domain-semantics-unverified");
      if (table === "bot_outbox" || table === "bot_deliveries") mark(record, "archived", "delivery-is-not-read-receipt");
      const identity = JSON.stringify([table, legacyKey]);
      identities.set(identity, [...(identities.get(identity) ?? []), record]);
      records.push(record);
    }
  }
  for (const group of identities.values()) {
    if (group.length > 1) {
      const conflict = new Set(group.map((record) => record.contentHash)).size > 1;
      for (const record of group) mark(record, "invalid", conflict ? "duplicate-key-conflict" : "duplicate-key");
    }
  }
  const references: Array<[string, string, LegacyTable]> = [
    ["conversation_id", "conversationId", "bot_conversations"],
    ["target_conversation_id", "targetConversationId", "bot_conversations"],
    ["input_id", "inputId", "bot_v2_inputs"], ["result_id", "resultId", "bot_results"],
    ["run_id", "runId", "bot_runs"], ["task_id", "taskId", "bot_tasks"],
    ["root_input_id", "rootInputId", "bot_v2_inputs"], ["recovery_of", "recoveryOf", "bot_v2_inputs"],
  ];
  // Freeze direct reference edges first, then propagate invalid targets to a fixed point.
  // This makes classification independent of SELECT order, including chains and cycles.
  const edges: Array<{ record: LegacyRecord; targetTable: LegacyTable; value: unknown; field: string }> = [];
  for (const record of records) {
    const data = payloads.get(record)!;
    for (const [column, field, defaultTable] of references) {
      if (record.table === "bot_conversations" && column === "conversation_id") continue;
      const targetTable = record.table === "bot_inputs" && field === "rootInputId" ? "bot_inputs" : defaultTable;
      for (const value of new Set([record.raw[column], data[field]])) {
        if (value !== undefined && value !== null) edges.push({ record, targetTable, value, field });
      }
    }
    if (record.table === "bot_meta" && record.legacyKey === "routerConversationId") edges.push({ record, targetTable: "bot_conversations", value: record.raw.value, field: "routerConversationId" });
    if (object(data.restartRecovery)) edges.push({ record, targetTable: "bot_v2_inputs", value: data.restartRecovery.inputId, field: "restartRecovery.inputId" });
    if (Array.isArray(data.deliveryIds)) for (const value of data.deliveryIds) edges.push({ record, targetTable: "bot_outbox", value, field: "deliveryIds" });
    if (Array.isArray(data.restartTargets)) for (const target of data.restartTargets) {
      if (!object(target)) { mark(record, "invalid", "invalid-reference:restartTargets"); continue; }
      edges.push({ record, targetTable: "bot_conversations", value: target.conversationId, field: "restartTargets.conversationId" });
      edges.push({ record, targetTable: "bot_v2_inputs", value: target.inputId, field: "restartTargets.inputId" });
    }
  }
  for (const { record, targetTable, value, field } of edges) {
    if (typeof value !== "string" || !value) { mark(record, "invalid", `invalid-reference:${field}`); continue; }
    const targets = identities.get(JSON.stringify([targetTable, value]));
    if (!targets) mark(record, "invalid", `orphan-reference:${field}`);
    else if (targets.length !== 1) mark(record, "invalid", `invalid-reference-target:${field}`);
    else if (field === "conversationId") {
      const owner = targets[0];
      if (owner.classification === "blocked") mark(record, "blocked", "owning-conversation-paused");
      const epoch = record.raw.epoch ?? payloads.get(record)?.epoch;
      const ownerEpoch = owner.raw.epoch ?? payloads.get(owner)?.epoch;
      if (epoch !== undefined && ownerEpoch !== undefined && epoch !== ownerEpoch) mark(record, "blocked", "stale-conversation-epoch-no-auto-resume");
    }
  }
  const fieldValue = (record: LegacyRecord, column: string, field = column): unknown => record.raw[column] ?? payloads.get(record)?.[field];
  const lineage = new Map<LegacyRecord, LegacyRecord[]>();
  for (const { record, targetTable, value, field } of edges) {
    if (!["rootInputId", "recoveryOf", "restartRecovery.inputId"].includes(field)) continue;
    const targets = identities.get(JSON.stringify([targetTable, value]));
    if (targets?.length !== 1) continue;
    const target = targets[0];
    const ownerId = record.table === "bot_conversations" ? record.legacyKey : fieldValue(record, "conversation_id", "conversationId");
    const targetOwnerId = fieldValue(target, "conversation_id", "conversationId");
    if (ownerId !== undefined && targetOwnerId !== undefined && ownerId !== targetOwnerId) {
      mark(record, field === "rootInputId" ? "needs-reconciliation" : "invalid", `cross-conversation-reference:${field}`);
    }
    const epoch = fieldValue(record, "epoch");
    const targetEpoch = fieldValue(target, "epoch");
    if (epoch !== undefined && targetEpoch !== undefined && epoch !== targetEpoch) {
      mark(record, "needs-reconciliation", `reference-epoch-mismatch:${field}`);
    }
    // rootInputId may legitimately point to itself. Recovery self-links never do.
    if (field !== "restartRecovery.inputId" && !(field === "rootInputId" && record === target)) {
      lineage.set(record, [...(lineage.get(record) ?? []), target]);
    }
  }
  // Iterative reachability avoids recursion limits on long recovery chains. Mark only
  // cycle members here; the existing invalid-target pass also catches their dependents.
  for (const start of lineage.keys()) {
    const pending = [...lineage.get(start)!];
    const seen = new Set<LegacyRecord>();
    while (pending.length) {
      const target = pending.pop()!;
      if (target === start) { mark(start, "invalid", "cyclic-input-lineage"); break; }
      if (seen.has(target)) continue;
      seen.add(target);
      pending.push(...(lineage.get(target) ?? []));
    }
  }
  for (const record of records) {
    const restartTargets = payloads.get(record)?.restartTargets;
    if (!Array.isArray(restartTargets)) continue;
    for (const target of restartTargets) {
      if (!object(target)) continue;
      const inputs = identities.get(JSON.stringify(["bot_v2_inputs", target.inputId]));
      const owners = identities.get(JSON.stringify(["bot_conversations", target.conversationId]));
      if (inputs?.length === 1) {
        const inputOwner = fieldValue(inputs[0], "conversation_id", "conversationId");
        if (inputOwner !== undefined && inputOwner !== target.conversationId) mark(record, "invalid", "cross-conversation-reference:restartTargets.inputId");
      }
      for (const evidence of [inputs, owners]) {
        if (evidence?.length !== 1) continue;
        const epoch = fieldValue(evidence[0], "epoch");
        if (target.epoch !== undefined && epoch !== undefined && target.epoch !== epoch) mark(record, "blocked", "restart-target-epoch-mismatch-no-auto-resume");
      }
    }
  }
  let changed: boolean;
  do {
    changed = false;
    for (const { record, targetTable, value, field } of edges) {
      const targets = identities.get(JSON.stringify([targetTable, value]));
      if (targets?.some((target) => target.classification === "invalid")) {
        if (record.classification !== "invalid") changed = true;
        mark(record, "invalid", `invalid-reference-target:${field}`);
      }
    }
  } while (changed);
  records.sort((a, b) => compare(a.table, b.table) || compare(a.legacyKey, b.legacyKey) || compare(a.contentHash, b.contentHash));
  for (const record of records) record.reasons.sort(compare);
  const mappings = [...new Map(records.map(({ table, legacyKey, newId }) => [JSON.stringify([table, legacyKey]), { table, legacyKey, newId }])).values()];
  const counts: LegacyMigrationPlan["counts"] = {
    total: records.length, mappings: mappings.length,
    byClassification: { archived: 0, "needs-reconciliation": 0, blocked: 0, invalid: 0 },
    byTable: Object.fromEntries(LEGACY_TABLES.map((table) => [table, 0])) as Record<LegacyTable, number>, byReason: {},
  };
  for (const record of records) {
    counts.byClassification[record.classification]++;
    counts.byTable[record.table]++;
    for (const reason of record.reasons) counts.byReason[reason] = (counts.byReason[reason] ?? 0) + 1;
  }
  const missingTables = LEGACY_TABLES.filter((table) => !snapshot.tables[table]);
  const contentHash = hash(canonical({ schemaVersion: snapshot.schemaVersion, missingTables, records: records.map(({ table, legacyKey, contentHash }) => ({ table, legacyKey, contentHash })) }));
  return { snapshotId: namespace, namespace, schemaVersion: snapshot.schemaVersion, contentHash, records, mappings, missingTables, counts };
}
const severity: Record<LegacyClassification, number> = { archived: 0, "needs-reconciliation": 1, blocked: 2, invalid: 3 };
function mark(record: LegacyRecord, classification: LegacyClassification, reason: string): void {
  if (severity[classification] > severity[record.classification]) record.classification = classification;
  if (!record.reasons.includes(reason)) record.reasons.push(reason);
}
function compare(a: string, b: string): number { return a < b ? -1 : a > b ? 1 : 0; }
