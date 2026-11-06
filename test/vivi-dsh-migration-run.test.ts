import test from "node:test";
import assert from "node:assert/strict";
import { openDatabase } from "../src/main/engine/db.ts";
import {
  advanceLegacyMigration,
  beginLegacyMigration,
  inspectLegacyMigration,
  reportLegacyMigration,
  resumeLegacyMigration,
} from "../src/main/bot/shadow/migration.ts";
import { openShadowStore } from "../src/main/bot/shadow/store.ts";

function sourceDb(): ReturnType<typeof openDatabase> {
  const db = openDatabase(":memory:");
  db.run("INSERT INTO bot_conversations VALUES (?,?,?,?,?,?,?,?,?)", "worker", "worker", "vivi", "fixture", 1, 0, 1, 1, JSON.stringify({ conversationId: "worker", role: "worker" }));
  db.run("INSERT INTO bot_v2_inputs VALUES (?,?,?,?,?,?,?,?)", "a", "worker", 1, "user", "one", "ready", 1, JSON.stringify({ id: "a", status: "ready" }));
  db.run("INSERT INTO bot_v2_inputs VALUES (?,?,?,?,?,?,?,?)", "b", "worker", 1, "user", "two", "failed", 1, JSON.stringify({ id: "b", status: "failed" }));
  return db;
}

test("M8 formal dry-run is fixed, batched, resumable, and evidence-only", () => {
  const legacy = sourceDb();
  const shadow = openShadowStore();
  try {
    const source = { db: legacy, snapshotId: "m8-fixture" };
    const started = beginLegacyMigration(source, shadow);
    assert.equal(started.snapshotId, "m8-fixture");
    assert.equal(started.total, 3);
    assert.equal(started.nextRow, 0);
    assert.equal(started.status, "pending");

    const first = advanceLegacyMigration(shadow, source.snapshotId, 1);
    assert.equal(first.nextRow, 1);
    assert.equal(first.status, "pending");
    assert.equal(reportLegacyMigration(shadow, source.snapshotId).mapped, 1);

    const completed = resumeLegacyMigration(source, shadow, 2);
    assert.equal(completed.nextRow, 3);
    assert.equal(completed.status, "completed");
    assert.deepEqual(advanceLegacyMigration(shadow, source.snapshotId, 1), completed);
    assert.deepEqual(inspectLegacyMigration(shadow, source.snapshotId), completed);

    const report = reportLegacyMigration(shadow, source.snapshotId);
    assert.equal(report.evidenceRows, 3);
    assert.equal(report.classifications.archived, 0);
    assert.equal(report.classifications["needs-reconciliation"] + report.classifications.blocked + report.classifications.invalid + report.classifications.archived, 3);
    assert.equal(report.classifications.blocked, 1);
    assert.notEqual(report.records[0]!.mapping.newId, report.records[1]!.mapping.newId);
    assert.ok(report.records.every(({ records }) => records.every((record) => record.authorized === false)));
    assert.equal(shadow.db.countRows("dsh_tickets"), 0);
    assert.equal(shadow.db.countRows("dsh_effects"), 0);
    assert.equal(shadow.db.countRows("dsh_decisions"), 0);
  } finally {
    legacy.close();
    shadow.close();
  }
});

test("same snapshot drift is rejected while a new snapshot gets its own namespace", () => {
  const legacy = sourceDb();
  const shadow = openShadowStore();
  try {
    const source = { db: legacy, snapshotId: "fixed" };
    beginLegacyMigration(source, shadow);
    legacy.run("UPDATE bot_v2_inputs SET data=? WHERE id=?", JSON.stringify({ id: "a", status: "failed", changed: true }), "a");
    assert.throws(() => resumeLegacyMigration(source, shadow), /内容或转换规则已变化/);

    const fresh = beginLegacyMigration({ db: legacy, snapshotId: "fresh" }, shadow);
    assert.equal(fresh.snapshotId, "fresh");
    assert.notEqual(shadow.migrations.get("fixed")!.digest, fresh.digest);
    assert.equal(shadow.db.countRows("dsh_legacy_mappings"), 0);
  } finally {
    legacy.close();
    shadow.close();
  }
});
