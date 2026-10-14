import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { ScheduledTaskStore, nextScheduleAt, validateScheduleDraft } from "../src/main/engine/scheduled-tasks.ts";
import { ScheduledTaskManager } from "../src/main/pi/scheduled-task-manager.ts";

function temporary(t: { after(fn: () => void): void }): string {
  const folder = mkdtempSync(join(tmpdir(), "fastvibe-schedules-"));
  t.after(() => rmSync(folder, { recursive: true, force: true }));
  return join(folder, "tasks.json");
}

const daily = { kind: "daily" as const, time: "09:00", timeZone: "Asia/Shanghai" };

test("recurrence follows the named wall clock, not a 24-hour interval", () => {
  assert.equal(nextScheduleAt(daily, Date.parse("2026-01-01T00:59:00Z")), Date.parse("2026-01-01T01:00:00Z"));
  assert.equal(nextScheduleAt(daily, Date.parse("2026-01-01T01:00:00Z")), Date.parse("2026-01-02T01:00:00Z"));
  assert.equal(nextScheduleAt({ kind: "weekly", time: "09:00", timeZone: "Asia/Shanghai", days: [1] }, Date.parse("2026-01-01T00:00:00Z")), Date.parse("2026-01-05T01:00:00Z"));
});

test("DST gaps move to the next real minute and folds run only on their first occurrence", () => {
  const gap = { kind: "daily" as const, time: "02:30", timeZone: "America/New_York" };
  assert.equal(nextScheduleAt(gap, Date.parse("2026-03-08T05:00:00Z")), Date.parse("2026-03-08T07:00:00Z"));
  const fold = { ...gap, time: "01:30" };
  assert.equal(nextScheduleAt(fold, Date.parse("2026-11-01T04:59:00Z")), Date.parse("2026-11-01T05:30:00Z"));
  assert.equal(nextScheduleAt(fold, Date.parse("2026-11-01T05:31:00Z")), Date.parse("2026-11-02T06:30:00Z"));
});

test("only absolute future one-shots and valid IANA repeats can be persisted", () => {
  assert.throws(() => validateScheduleDraft({ name: "x", prompt: "work", schedule: { kind: "once", at: "2027-01-01T10:00" } }));
  assert.throws(() => validateScheduleDraft({ name: "x", prompt: "work", schedule: { kind: "weekly", time: "09:00", timeZone: "Invalid/Zone", days: [2] } }));
  assert.throws(() => validateScheduleDraft({ name: "x", prompt: "work", schedule: { kind: "weekly", time: "09:00", timeZone: "UTC", days: [] } }));
});

test("claim is durable before the runner begins, survives restart and is never replayed", (t) => {
  const file = temporary(t);
  const store = new ScheduledTaskStore(file);
  const task = store.create({ name: "Daily", prompt: "work", project: "/tmp/work", schedule: daily });
  const scheduledAt = task.nextRunAt!;
  const run = store.claim(task.id, scheduledAt);
  assert.equal(store.get(task.id)?.nextRunAt, nextScheduleAt(daily, Math.max(run.startedAt!, scheduledAt)));
  assert.equal(store.due(scheduledAt).length, 0);
  assert.throws(() => store.claim(task.id, scheduledAt));
  const disk = JSON.parse(readFileSync(file, "utf8"));
  assert.equal(disk.runs[0].status, "running");
  assert.equal(disk.runs[0].id, run.id);
  assert.equal(statSync(file).mode & 0o777, 0o600);
  const reloaded = new ScheduledTaskStore(file);
  assert.equal(reloaded.listRuns(task.id)[0]?.status, "interrupted");
  assert.equal(reloaded.due(scheduledAt).length, 0);
});

test("manual repeats keep their next occurrence; project binding can be cleared", (t) => {
  const store = new ScheduledTaskStore(temporary(t));
  const task = store.create({ name: "Daily", prompt: "work", project: "/tmp/work", schedule: daily });
  store.claim(task.id, Date.now(), "running", true);
  assert.equal(store.get(task.id)?.nextRunAt, task.nextRunAt);
  const cleared = store.update(task.id, { project: "", enabled: false });
  assert.equal(cleared?.project, undefined);
  assert.equal(cleared?.nextRunAt, undefined);
  const resumed = store.update(task.id, { enabled: true });
  assert.ok(resumed?.nextRunAt && resumed.nextRunAt > Date.now());
});

test("manager reports a consumed one-shot as background work until its run settles", async (t) => {
  const file = temporary(t);
  let finish!: () => void;
  const manager = new ScheduledTaskManager(file, async (_task, signal, onConversation) => {
    onConversation("chat-one");
    await new Promise<void>((resolve) => { finish = resolve; });
    assert.equal(signal.aborted, false);
  });
  const task = manager.create({ name: "Once", prompt: "work", schedule: { kind: "once", at: new Date(Date.now() + 60_000).toISOString() } });
  manager.start();
  const run = manager.runNow(task.id);
  assert.equal(manager.list().tasks[0]?.enabled, false);
  assert.equal(manager.hasEnabledTasks(), true);
  await new Promise((resolve) => setImmediate(resolve));
  finish();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(manager.history(task.id)[0]?.status, "completed");
  assert.equal(manager.history(task.id)[0]?.conversationId, "chat-one");
  assert.equal(manager.hasEnabledTasks(), false);
  assert.ok(run.id);
  manager.stop();
});
