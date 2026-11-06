// M8 formal legacy conversion dry-run. This module only records evidence in ShadowStore.
import { createHash } from "node:crypto";
import type { Db } from "../../engine/db.ts";
import { planLegacyMigration, readLegacySnapshot, type LegacyMigrationPlan } from "./legacy.ts";
import type { LegacyRecord } from "./legacy.ts";
import type { MigrationProgress, ShadowStore } from "./store.ts";

export type MigrationSource = {
  db: Db;
  snapshotId: string;
};

export type LegacyMigrationReport = MigrationProgress & {
  mapped: number;
  remaining: number;
  evidenceRows: number;
  classifications: LegacyMigrationPlan["counts"]["byClassification"];
  records: ReturnType<ShadowStore["migrations"]["records"]>;
};

function digest(plan: LegacyMigrationPlan): string {
  return createHash("sha256").update(JSON.stringify(plan)).digest("hex");
}

function sourcePlan(source: MigrationSource): LegacyMigrationPlan {
  if (typeof source.snapshotId !== "string" || !source.snapshotId.trim()) throw new Error("snapshotId must be nonempty");
  return planLegacyMigration({ ...readLegacySnapshot(source.db), snapshotId: source.snapshotId });
}

function assertUnchanged(progress: MigrationProgress, plan: LegacyMigrationPlan): void {
  if (progress.digest !== digest(plan)) {
    throw new Error("同一迁移快照的内容或转换规则已变化，必须使用新的 snapshotId");
  }
}

/** Capture one immutable, read-only legacy snapshot and create its Shadow checkpoint. */
export function beginLegacyMigration(source: MigrationSource, shadow: ShadowStore): MigrationProgress {
  return shadow.migrations.begin(sourcePlan(source));
}

/** Advance one persisted batch. Repeating a completed or already advanced batch is safe. */
export function advanceLegacyMigration(
  shadow: ShadowStore,
  snapshotId: string,
  batchSize = 100,
): MigrationProgress {
  return shadow.migrations.advance(snapshotId, batchSize);
}

/** Re-read the source, reject content/classification drift, then continue from the checkpoint. */
export function resumeLegacyMigration(
  source: MigrationSource,
  shadow: ShadowStore,
  batchSize = 100,
): MigrationProgress {
  const progress = shadow.migrations.get(source.snapshotId);
  if (!progress) throw new Error("迁移快照不存在");
  assertUnchanged(progress, sourcePlan(source));
  return shadow.migrations.advance(source.snapshotId, batchSize);
}

/** Inspect only the Shadow checkpoint; it never reads or mutates legacy/domain data. */
export function inspectLegacyMigration(shadow: ShadowStore, snapshotId: string): MigrationProgress | undefined {
  return shadow.migrations.get(snapshotId);
}

/** Produce an evidence report from Shadow rows. The returned records remain unauthorized. */
export function reportLegacyMigration(shadow: ShadowStore, snapshotId: string): LegacyMigrationReport {
  const progress = shadow.migrations.get(snapshotId);
  if (!progress) throw new Error("迁移快照不存在");
  const records = shadow.migrations.records(snapshotId);
  const classifications: LegacyMigrationPlan["counts"]["byClassification"] = {
    archived: 0,
    "needs-reconciliation": 0,
    blocked: 0,
    invalid: 0,
  };
  for (const row of records) {
    for (const record of row.records as LegacyRecord[]) classifications[record.classification]++;
  }
  const mapped = records.length;
  return {
    ...progress,
    mapped,
    remaining: Math.max(progress.total - mapped, 0),
    evidenceRows: records.reduce((count, row) => count + row.records.length, 0),
    classifications,
    records,
  };
}

// Short aliases keep the formal API convenient for callers that already use the store names.
export const begin = beginLegacyMigration;
export const advance = advanceLegacyMigration;
export const resume = resumeLegacyMigration;
export const inspect = inspectLegacyMigration;
export const report = reportLegacyMigration;
