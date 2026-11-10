import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync, symlinkSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { openDatabase, type Db, type DbRow } from "../src/main/engine/db.ts";
import { LEGACY_TABLES, planLegacyMigration, readLegacySnapshot, type LegacySnapshot } from "../src/main/bot/shadow/legacy.ts";

function conversation(db: Db, paused = false): void {
  const data = { conversationId: "worker", role: "worker", owner: "vivi", creationKey: "worker-key", epoch: 2, paused, createdAt: 1, updatedAt: 1 };
  db.run("INSERT INTO bot_conversations VALUES (?,?,?,?,?,?,?,?,?)", "worker", "worker", "vivi", "worker-key", 2, paused, 1, 1, JSON.stringify(data));
}
function input(db: Db, id: string, status: string): void {
  const data = { id, conversationId: "worker", epoch: 2, source: "user", text: "please work", status, createdAt: 1, memoryBranch: { beforeEntryId: "before", afterEntryId: "after" } };
  db.run("INSERT INTO bot_v2_inputs VALUES (?,?,?,?,?,?,?,?)", id, "worker", 2, "user", "please work", status, 1, JSON.stringify(data));
}
const plan = (snapshot: LegacySnapshot, snapshotId = "fixture") => planLegacyMigration({ ...snapshot, snapshotId });
function pure(tables: LegacySnapshot["tables"]) { return plan({ schemaVersion: 12, tables, missingTables: LEGACY_TABLES.filter((table) => !tables[table]) }); }
function row(id: string, status: string, extra: DbRow = {}): DbRow { return { id, status, data: JSON.stringify({ id, status }), ...extra }; }

test("default migrated database: complete evidence, stable repeat, no source changes", () => {
  const db = openDatabase(":memory:");
  try {
    conversation(db);
    input(db, "input", "accepted");
    db.run("INSERT INTO bot_meta VALUES (?,?)", "routerConversationId", "worker");
    db.run("INSERT INTO bot_results VALUES (?,?,?,?,?,?,?)", "result", "worker", "input", 2, "ready", 1, JSON.stringify({ id: "result", conversationId: "worker", inputId: "input", epoch: 2, status: "ready", artifacts: ["/must/not/read"] }));
    db.run("INSERT INTO bot_attention VALUES (?,?,?,?,?,?,?)", "question", "worker", "input", 2, "pending", 1, JSON.stringify({ id: "question", status: "pending" }));
    db.run("INSERT INTO bot_outbox VALUES (?,?,?,?,?,?)", "delivery", "worker", "worker", "injected", 1, JSON.stringify({ id: "delivery", status: "injected", resultId: "result" }));
    db.run("INSERT INTO bot_chat_messages VALUES (?,?,?,?,?,?)", "message", "worker", "assistant", "input", 1, JSON.stringify({ id: "message", text: "done", role: "assistant" }));
    const before = readLegacySnapshot(db);
    const first = plan(before);
    assert.deepEqual(plan(readLegacySnapshot(db)), first);
    assert.deepEqual(readLegacySnapshot(db), before);
    assert.equal(db.get("SELECT status FROM bot_v2_inputs")?.status, "accepted");
    assert.equal(first.counts.total, 7);
    assert.equal(first.counts.mappings, 7);
    assert.equal(first.missingTables.length, 0);
    assert.equal(Object.values(first.counts.byTable).reduce((a, b) => a + b), 7);
    assert.equal(Object.values(first.counts.byClassification).reduce((a, b) => a + b), 7);
    assert.ok(first.records.every((record) => record.authorized === false));
    assert.equal(first.records.find((record) => record.table === "bot_outbox")?.classification, "needs-reconciliation");
    assert.equal(first.records.find((record) => record.table === "bot_chat_messages")?.classification, "archived");
    assert.ok(first.records.find((record) => record.table === "bot_v2_inputs")?.reasons.includes("session-branch-reference-not-read-proof"));
    assert.ok(first.records.every((record) => !["Mandate", "Effect"].includes(record.suggestedEntityType)));
  } finally { db.close(); }
});

for (const [status, expected] of [
  ["queued", "needs-reconciliation"], ["running", "needs-reconciliation"], ["accepted", "needs-reconciliation"],
  ["uncertain", "needs-reconciliation"], ["completed", "archived"], ["failed", "blocked"], ["canceled", "archived"],
  ["stopped", "blocked"], ["paused", "blocked"], ["future-status", "invalid"],
] as const) {
  test(`input ${status} remains conservative (${expected})`, () => {
    const db = openDatabase(":memory:");
    try {
      conversation(db); input(db, "input", status);
      const record = plan(readLegacySnapshot(db)).records.find((record) => record.table === "bot_v2_inputs")!;
      assert.equal(record.classification, expected);
      assert.equal(record.authorized, false);
      assert.equal(record.raw.status, status);
      assert.deepEqual(readLegacySnapshot(db).tables.bot_v2_inputs?.[0]?.status, status);
    } finally { db.close(); }
  });
}
for (const [table, status, expected] of [
  ["bot_results", "idle", "needs-reconciliation"], ["bot_results", "ready", "needs-reconciliation"],
  ["bot_results", "blocked", "blocked"], ["bot_results", "failed", "blocked"], ["bot_results", "uncertain", "needs-reconciliation"],
  ["bot_outbox", "pending", "needs-reconciliation"], ["bot_outbox", "injected", "needs-reconciliation"],
  ["bot_outbox", "delivered", "archived"], ["bot_outbox", "failed", "blocked"],
  ["bot_attention", "pending", "needs-reconciliation"], ["bot_attention", "resolved", "archived"], ["bot_attention", "withdrawn", "archived"],
] as const) {
  test(`${table}/${status} is evidence only`, () => {
    const result = pure({ [table]: [row("record", status)] });
    assert.equal(result.records[0].classification, expected);
    assert.equal(result.records[0].authorized, false);
  });
}

test("paused conversation blocks completed inputs and never resumes them", () => {
  const db = openDatabase(":memory:");
  try {
    conversation(db, true); input(db, "input", "completed");
    const result = plan(readLegacySnapshot(db));
    assert.ok(result.records.every((record) => record.classification === "blocked"));
    assert.ok(result.records.find((record) => record.table === "bot_v2_inputs")?.reasons.includes("owning-conversation-paused"));
    assert.equal(db.get("SELECT paused FROM bot_conversations")?.paused, 1);
  } finally { db.close(); }
});

test("malformed JSON, nonobject payload, missing key and conflicting projections are retained", () => {
  const rows = [
    { id: "broken", status: "ready", data: "{broken" },
    { id: "array", status: "ready", data: "[]" },
    { id: "conflict", status: "ready", data: '{"id":"different","status":"failed"}' },
    { status: "ready", data: "{}" },
  ];
  const result = pure({ bot_results: rows });
  assert.equal(result.counts.byClassification.invalid, 4);
  assert.equal(result.records.find((record) => record.legacyKey === "broken")?.rawJSON, "{broken");
  assert.equal(result.counts.byReason["malformed-json"], 1);
  assert.equal(result.counts.byReason["payload-not-object"], 1);
  assert.equal(result.counts.byReason["payload-key-conflict"], 1);
  assert.deepEqual(rows[0], { id: "broken", status: "ready", data: "{broken" });
});

test("duplicate identities have one mapping and preserve every conflicting row", () => {
  const result = pure({ bot_v2_inputs: [row("a", "completed"), row("a", "running"), row("b", "completed"), row("b", "completed")] });
  assert.equal(result.counts.total, 4);
  assert.equal(result.mappings.length, 2);
  assert.equal(result.counts.byReason["duplicate-key-conflict"], 2);
  assert.equal(result.counts.byReason["duplicate-key"], 2);
  assert.equal(result.counts.byClassification.invalid, 4);
});

test("orphan conversation, input, result, root and router references are reported", () => {
  const result = pure({
    bot_results: [row("result", "ready", { conversation_id: "missing", input_id: "missing" })],
    bot_outbox: [{ id: "out", status: "delivered", target_conversation_id: "missing", data: '{"resultId":"missing"}' }],
    bot_v2_inputs: [{ id: "input", status: "completed", data: '{"rootInputId":"missing","recoveryOf":"missing"}' }],
    bot_meta: [{ key: "routerConversationId", value: "missing" }],
  });
  for (const field of ["conversationId", "inputId", "resultId", "targetConversationId", "rootInputId", "recoveryOf", "routerConversationId"]) assert.equal(result.counts.byReason[`orphan-reference:${field}`], 1);
  assert.equal(result.counts.byClassification.invalid, 4);
});

test("v11 compatibility tables remain read-only and do not manufacture active tickets", () => {
  const db = openDatabase(":memory:");
  try {
    db.run("INSERT INTO bot_runs VALUES (?,?,?,?,?)", "run", "stopped", 1, 1, '{"id":"run","status":"stopped"}');
    db.run("INSERT INTO bot_tasks VALUES (?,?,?,?,?,?)", "task", "run", "completed", 1, 1, '{"id":"task","status":"completed"}');
    db.run("INSERT INTO bot_attempts VALUES (?,?,?,?,?,?)", "attempt", "task", 1, "running", 1, '{"id":"attempt","status":"running"}');
    db.run("INSERT INTO bot_inputs VALUES (?,?,?,?,?)", "input", "run", "accepted", 1, '{"id":"input","status":"accepted"}');
    db.run("INSERT INTO bot_questions VALUES (?,?,?,?,?)", "question", "task", "pending", 1, '{"id":"question","status":"pending"}');
    db.run("INSERT INTO bot_requests VALUES (?,?,?)", "request", "fingerprint", "run");
    db.run("INSERT INTO bot_deliveries VALUES (?,?,?)", "delivery", "run", '{"id":"delivery","status":"injected"}');
    const before = readLegacySnapshot(db);
    const result = plan(before);
    assert.equal(result.counts.total, 7);
    assert.equal(result.counts.byClassification.invalid, 0);
    assert.equal(result.records.find((record) => record.table === "bot_runs")?.classification, "blocked");
    assert.ok(result.records.every((record) => !record.authorized));
    assert.deepEqual(readLegacySnapshot(db), before);
  } finally { db.close(); }
});

test("ID tuple hashing, content hashing, namespace and row-order determinism", () => {
  const tables = { bot_v2_inputs: [row("a\u0000b", "completed"), row("b", "running")] };
  const snapshot: LegacySnapshot = { schemaVersion: 12, tables, missingTables: [] };
  const first = plan(snapshot, "copy-1");
  const reversed = plan({ ...snapshot, tables: { bot_v2_inputs: [...tables.bot_v2_inputs].reverse() } }, "copy-1");
  assert.deepEqual(first, reversed);
  const otherNamespace = plan(snapshot, "copy-2");
  assert.deepEqual(first.mappings, otherNamespace.mappings);
  assert.equal(first.contentHash, otherNamespace.contentHash);
  assert.equal(otherNamespace.records[0].namespace, "copy-2");
  const record = first.records.find((record) => record.legacyKey === "a\u0000b")!;
  assert.equal(record.newId, `legacy-${createHash("sha256").update(JSON.stringify(["bot_v2_inputs", "a\u0000b"])).digest("hex")}`);
  const changed = pure({ bot_v2_inputs: [row("a\u0000b", "completed", { data: '{"text":"changed"}' }), row("b", "running")] });
  assert.deepEqual(changed.mappings, first.mappings);
  assert.notEqual(changed.contentHash, first.contentHash);
  assert.notEqual(changed.records[0].contentHash, first.records[0].contentHash);
  assert.throws(() => plan(snapshot, " "), /snapshotId/);
});

test("missing tables are readable and explicitly counted as zero", () => {
  const db = openDatabase(":memory:");
  try {
    for (const table of [...LEGACY_TABLES].reverse()) db.exec(`DROP TABLE ${table}`);
    const snapshot = readLegacySnapshot(db);
    assert.deepEqual(snapshot.missingTables, LEGACY_TABLES);
    const result = plan(snapshot);
    assert.equal(result.counts.total, 0);
    assert.deepEqual(result.missingTables, LEGACY_TABLES);
    assert.ok(Object.values(result.counts.byTable).every((count) => count === 0));
  } finally { db.close(); }
});

test("reader uses a single transaction and SELECTs only for legacy facts", () => {
  const db = openDatabase(":memory:");
  try {
    const calls: string[] = [];
    let inside = false;
    const wrapped = new Proxy(db, { get(target, property) {
      if (property === "transaction") return (fn: () => unknown) => { calls.push("transaction"); return target.transaction(() => { inside = true; try { return fn(); } finally { inside = false; } }); };
      if (["all", "get", "userVersion"].includes(String(property))) return (...args: unknown[]) => {
        assert.equal(inside, true);
        if (property !== "userVersion") { assert.match(String(args[0]), /^SELECT /); calls.push(String(args[0])); }
        return (Reflect.get(target, property) as (...args: unknown[]) => unknown).apply(target, args);
      };
      if (["run", "exec"].includes(String(property))) return () => { assert.fail("reader must not mutate"); };
      const value = Reflect.get(target, property); return typeof value === "function" ? value.bind(target) : value;
    } });
    readLegacySnapshot(wrapped);
    assert.equal(calls.filter((call) => call === "transaction").length, 1);
    assert.equal(calls.filter((call) => call.startsWith("SELECT * FROM bot_")).length, LEGACY_TABLES.length);
  } finally { db.close(); }
});

test("stale epochs stay blocked even when an old input says completed", () => {
  const db = openDatabase(":memory:");
  try {
    conversation(db); input(db, "input", "completed");
    const stored = db.get("SELECT data FROM bot_v2_inputs")!;
    db.run("UPDATE bot_v2_inputs SET epoch = 1, data = ?", JSON.stringify({ ...JSON.parse(stored.data as string), epoch: 1 }));
    const result = plan(readLegacySnapshot(db));
    const record = result.records.find((record) => record.table === "bot_v2_inputs")!;
    assert.equal(record.classification, "blocked");
    assert.ok(record.reasons.includes("stale-conversation-epoch-no-auto-resume"));
  } finally { db.close(); }
});

test("invalid dependency chains propagate independently of source ordering", () => {
  const inputs = [
    { id: "first", status: "completed", data: '{"rootInputId":"second"}' },
    { id: "second", status: "completed", data: '{"rootInputId":"third"}' },
    { id: "third", status: "completed", data: '{"rootInputId":"missing"}' },
  ];
  const first = pure({ bot_v2_inputs: inputs });
  const reverse = pure({ bot_v2_inputs: [...inputs].reverse() });
  assert.deepEqual(first, reverse);
  assert.equal(first.counts.byClassification.invalid, 3);
  assert.equal(first.counts.byReason["invalid-reference-target:rootInputId"], 2);
});

test("recovery and delivery array references remain evidence and expose orphans", () => {
  const result = pure({
    bot_conversations: [{ conversation_id: "worker", data: '{"conversationId":"worker","restartRecovery":{"inputId":"missing"}}' }],
    bot_v2_inputs: [{ id: "input", status: "completed", data: '{"deliveryIds":["missing"],"restartTargets":[{"conversationId":"missing","inputId":"missing"}]}' }],
  });
  assert.equal(result.counts.byClassification.invalid, 2);
  for (const field of ["restartRecovery.inputId", "deliveryIds", "restartTargets.conversationId", "restartTargets.inputId"]) assert.equal(result.counts.byReason[`orphan-reference:${field}`], 1);
  assert.equal(result.counts.byReason["recovery-marker-not-authorization"], 1);
});

for (const [table, field, allowed] of [
  ["bot_v2_inputs", "source", ["user", "router", "answer", "resume", "report"]],
  ["bot_conversations", "role", ["router", "worker"]],
  ["bot_chat_messages", "role", ["user", "assistant"]],
] as const) {
  for (const location of ["column", "payload"] as const) {
    test(`${table}.${field}: validate present ${location} values and preserve missing fields`, () => {
      const make = (value: unknown, present = true) => {
        const fields = present ? { [field]: value } : {};
        return {
          [table === "bot_conversations" ? "conversation_id" : "id"]: "record",
          ...(table === "bot_v2_inputs" ? { status: "completed" } : {}),
          ...(location === "column" ? fields : {}),
          data: JSON.stringify(location === "payload" ? fields : {}),
        };
      };
      const expected = table === "bot_conversations" ? "needs-reconciliation" : "archived";
      assert.equal(pure({ [table]: [make(undefined, false)] }).records[0].classification, expected);
      for (const value of allowed) assert.equal(pure({ [table]: [make(value)] }).records[0].classification, expected);
      for (const value of ["future", "", null, 3, true, {}]) {
        const result = pure({ [table]: [make(value)] });
        assert.equal(result.records[0].classification, "invalid");
        assert.equal(result.counts.byReason[`unknown-${field}`], 1);
        assert.equal(result.records[0].authorized, false);
      }
    });
  }
}

test("valid but conflicting source projections are invalid", () => {
  const result = pure({ bot_v2_inputs: [row("input", "completed", { source: "user", data: '{"source":"router"}' })] });
  assert.equal(result.records[0].classification, "invalid");
  assert.equal(result.counts.byReason["column-payload-conflict:source"], 1);
});

for (const field of ["recoveryOf", "rootInputId"] as const) {
  test(`${field} cycles and their dependents are invalid regardless of row order`, () => {
    const inputs = [
      row("a", "completed", { data: JSON.stringify({ [field]: "b" }) }),
      row("b", "completed", { data: JSON.stringify({ [field]: "a" }) }),
      row("dependent", "completed", { data: JSON.stringify({ [field]: "a" }) }),
    ];
    const result = pure({ bot_v2_inputs: inputs });
    assert.deepEqual(result, pure({ bot_v2_inputs: [...inputs].reverse() }));
    assert.equal(result.counts.byClassification.invalid, 3);
    assert.equal(result.counts.byReason["cyclic-input-lineage"], 2);
    assert.ok(result.records.every((record) => !record.authorized));
  });
}

test("self root is normal historical evidence but self recovery is invalid", () => {
  const result = pure({ bot_v2_inputs: [
    row("root", "completed", { data: '{"rootInputId":"root"}' }),
    row("recovery", "completed", { data: '{"recoveryOf":"recovery"}' }),
  ] });
  assert.equal(result.records.find((record) => record.legacyKey === "root")?.classification, "archived");
  assert.equal(result.records.find((record) => record.legacyKey === "recovery")?.classification, "invalid");
});

for (const [field, expected] of [["rootInputId", "needs-reconciliation"], ["recoveryOf", "invalid"], ["restartRecovery.inputId", "invalid"]] as const) {
  test(`cross-conversation ${field} explicitly reports scope without granting authority`, () => {
    const reference = field === "restartRecovery.inputId" ? { restartRecovery: { inputId: "original" } } : { [field]: "original" };
    const result = pure({
      bot_conversations: [
        { conversation_id: "router", data: JSON.stringify({ ...reference, epoch: 2 }) },
        { conversation_id: "worker", data: '{"epoch":1}' },
      ],
      bot_v2_inputs: [
        row("original", "completed", { conversation_id: "worker", epoch: 1 }),
        ...(field === "restartRecovery.inputId" ? [] : [row("next", "completed", { conversation_id: "router", epoch: 2, data: JSON.stringify(reference) })]),
      ],
    });
    const record = result.records.find((record) => record.legacyKey === (field === "restartRecovery.inputId" ? "router" : "next"))!;
    assert.equal(record.classification, expected);
    assert.ok(record.reasons.includes(`cross-conversation-reference:${field}`));
    assert.ok(record.reasons.includes(`reference-epoch-mismatch:${field}`));
    assert.ok(result.records.every((item) => !item.authorized));
  });
}

test("same-conversation recovery across epochs requires reconciliation", () => {
  const result = pure({ bot_v2_inputs: [
    row("original", "completed", { epoch: 1 }),
    row("resume", "completed", { epoch: 2, data: '{"recoveryOf":"original"}' }),
  ] });
  const record = result.records.find((record) => record.legacyKey === "resume")!;
  assert.equal(record.classification, "needs-reconciliation");
  assert.ok(record.reasons.includes("reference-epoch-mismatch:recoveryOf"));
});

for (const mismatch of ["conversation", "input-epoch", "owner-epoch"] as const) {
  test(`restart target ${mismatch} mismatch cannot authorize resumption`, () => {
    const result = pure({
      bot_conversations: [
        { conversation_id: "router", data: "{}" },
        { conversation_id: "worker", data: JSON.stringify({ epoch: mismatch === "owner-epoch" ? 3 : 2 }) },
      ],
      bot_v2_inputs: [
        row("original", "completed", { conversation_id: mismatch === "conversation" ? "router" : "worker", epoch: mismatch === "input-epoch" ? 1 : 2 }),
        row("inspection", "completed", { data: '{"restartTargets":[{"conversationId":"worker","inputId":"original","epoch":2}]}' }),
      ],
    });
    const record = result.records.find((record) => record.legacyKey === "inspection")!;
    assert.equal(record.classification, mismatch === "conversation" ? "invalid" : "blocked");
    assert.ok(record.reasons.includes(mismatch === "conversation" ? "cross-conversation-reference:restartTargets.inputId" : "restart-target-epoch-mismatch-no-auto-resume"));
    assert.equal(record.authorized, false);
  });
}

test("temp file is allowed; path outside temp and escaping symlink rejected before reading", () => {
  const temp = mkdtempSync(join(tmpdir(), "vivi-legacy-"));
  const db = openDatabase(join(temp, "copy.db"));
  try {
    conversation(db);
    assert.equal(plan(readLegacySnapshot(db)).counts.total, 1);
    const fake = (file: string) => ({ file, transaction: () => assert.fail("must reject before any DB access") }) as unknown as Db;
    assert.throws(() => readLegacySnapshot(fake(resolve("never-open-userdata.db"))), /Shadow/);
    symlinkSync(realpathSync(process.cwd()), join(temp, "outside"));
    assert.throws(() => readLegacySnapshot(fake(join(temp, "outside", "never-open.db"))), /Shadow/);
    assert.throws(() => readLegacySnapshot(fake(join(realpathSync(tmpdir()), "..", "never-open.db"))), /Shadow/);
  } finally { db.close(); rmSync(temp, { recursive: true, force: true }); }
});
