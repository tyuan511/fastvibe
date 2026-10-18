import assert from "node:assert/strict";
import { existsSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { ScheduledTaskStore, nextScheduleAt, validateScheduleDraft } from "../src/main/engine/scheduled-tasks.ts";
import { ScheduledTaskManager } from "../src/main/pi/scheduled-task-manager.ts";
import { openTestDb, testDir } from "./test-db.ts";
import type { Db } from "../src/main/engine/db.ts";

/** One directory per test: the store and the manager read the same `fastvibe.db`. */
function temporary(t: { after(fn: () => void): void }): { dir: string; db: Db } {
  const dir = testDir("fastvibe-schedules-");
  t.after(() => { openTestDb(dir).close(); });
  return { dir, db: openTestDb(dir) };
}

/** Turn a stored record back in time, which is how these cases reach 过期 without waiting. */
function patchTask(db: Db, id: string, patch: Record<string, unknown>): void {
  const current = JSON.parse(db.get<{ data: string }>("SELECT data FROM scheduled_tasks WHERE id = ?", id)!.data) as Record<string, unknown>;
  db.run("UPDATE scheduled_tasks SET data = ? WHERE id = ?", JSON.stringify({ ...current, ...patch }), id);
}

function patchRun(db: Db, taskId: string, patch: Record<string, unknown>): void {
  const row = db.get<{ id: string; data: string }>("SELECT id, data FROM scheduled_runs WHERE task_id = ? ORDER BY position", taskId)!;
  const current = JSON.parse(row.data) as Record<string, unknown>;
  db.run("UPDATE scheduled_runs SET data = ? WHERE id = ?", JSON.stringify({ ...current, ...patch }), row.id);
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
  const { dir, db } = temporary(t);
  const store = new ScheduledTaskStore(db);
  const task = store.create({ name: "Daily", prompt: "work", project: "/tmp/work", schedule: daily });
  const scheduledAt = task.nextRunAt!;
  const run = store.claim(task.id, scheduledAt);
  assert.equal(store.get(task.id)?.nextRunAt, nextScheduleAt(daily, Math.max(run.startedAt!, scheduledAt)));
  assert.equal(store.due(scheduledAt).length, 0);
  assert.throws(() => store.claim(task.id, scheduledAt));
  // Durable before the runner starts, and not only in this process's memory.
  assert.equal(db.get<{ status: string }>("SELECT status FROM scheduled_runs WHERE id = ?", run.id)?.status, "running");
  assert.equal(readdirSync(dir).filter((name) => name.endsWith(".tmp")).length, 0, "a row write leaves no scratch file");
  const reloaded = new ScheduledTaskStore(openTestDb(dir));
  assert.equal(reloaded.listRuns(task.id)[0]?.status, "interrupted");
  assert.equal(reloaded.due(scheduledAt).length, 0);
});

test("the old scheduled-tasks.json is imported once, runs and all", (t) => {
  const dir = testDir("fastvibe-schedules-");
  t.after(() => openTestDb(dir).close());
  const file = join(dir, "scheduled-tasks.json");
  const schedule = { kind: "daily" as const, time: "09:00", timeZone: "Asia/Shanghai" };
  const task = {
    id: "t-1", name: "Daily", prompt: "work", project: "/tmp/work", enabled: true,
    schedule, createdAt: 1, updatedAt: 2, nextRunAt: 3, lastRunAt: 4, lastStatus: "completed" as const,
  };
  const runs = [
    { id: "r-2", taskId: "t-1", scheduledAt: 20, status: "running" as const, startedAt: 21 },
    { id: "r-1", taskId: "t-1", scheduledAt: 10, status: "completed" as const, startedAt: 11, endedAt: 12 },
    // History of a task that is gone: the file reader dropped it, so the import must too.
    { id: "r-0", taskId: "ghost", scheduledAt: 5, status: "failed" as const },
  ];
  writeFileSync(file, JSON.stringify({ version: 1, revision: 9, tasks: [task], runs }), "utf8");

  const store = new ScheduledTaskStore(openTestDb(dir), { legacyFile: file });
  assert.equal(store.get("t-1")?.nextRunAt, 3);
  assert.deepEqual(store.listRuns("t-1").map((run) => run.id), ["r-2", "r-1"], "the stored order is the list order");
  assert.equal(store.listRuns("t-1")[0]?.status, "interrupted", "a running row is a run the process died on");
  assert.equal(store.snapshot().revision, 10, "and marking it interrupted is itself a change");

  const db = openTestDb(dir);
  assert.equal(db.countRows("scheduled_tasks"), 1);
  assert.equal(db.countRows("scheduled_runs"), 2);
  assert.equal(db.get<{ value: string }>("SELECT value FROM schedule_meta WHERE key = 'revision'")?.value, "10");
  assert.equal(db.get<{ status: string }>("SELECT status FROM scheduled_runs WHERE id = 'r-2'")?.status, "interrupted");
  assert.ok(!existsSync(file));
  assert.equal(readdirSync(dir).filter((name) => name.startsWith("scheduled-tasks.json.migrated-")).length, 1);
});

test("a corrupt scheduled-tasks.json starts the store empty rather than guessing", (t) => {
  const dir = testDir("fastvibe-schedules-");
  t.after(() => openTestDb(dir).close());
  const file = join(dir, "scheduled-tasks.json");
  writeFileSync(file, "{ nope", "utf8");
  const store = new ScheduledTaskStore(openTestDb(dir), { legacyFile: file });
  assert.deepEqual(store.snapshot().tasks, []);
  assert.ok(readdirSync(dir).some((name) => name.startsWith("scheduled-tasks.json.corrupt-")), readdirSync(dir).join(","));
});

test("manual repeats keep their next occurrence; project binding can be cleared", (t) => {
  const store = new ScheduledTaskStore(temporary(t).db);
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
  const { dir } = temporary(t);
  let finish!: () => void;
  const manager = new ScheduledTaskManager(openTestDb(dir), async (_task, signal, onConversation) => {
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

test("a task remembers the chat that asked for it, and reporting can be switched off", (t) => {
  const store = new ScheduledTaskStore(temporary(t).db);
  const task = store.create({ name: "Daily", prompt: "work", notifyConversationId: "chat-1", schedule: daily });
  assert.equal(store.get(task.id)?.notifyConversationId, "chat-1");
  assert.equal(store.update(task.id, { name: "Renamed" })?.notifyConversationId, "chat-1");
  assert.equal(store.update(task.id, { notifyConversationId: "" })?.notifyConversationId, undefined);
  assert.throws(() => validateScheduleDraft({ name: "x", prompt: "work", notifyConversationId: " ", schedule: daily }));
});

test("the manager reports a run that ended, once, and not one cut short by quitting", async (t) => {
  const { dir } = temporary(t);
  const seen: string[] = [];
  const manager = new ScheduledTaskManager(openTestDb(dir), async () => undefined, (task, run) => seen.push(`${task.id}:${run.status}`));
  const task = manager.create({ name: "Once", prompt: "work", notifyConversationId: "chat-1", schedule: daily });
  manager.start();
  manager.runNow(task.id);
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.deepEqual(seen, [`${task.id}:completed`]);
  manager.stop();
});

test("busy manual runs are durably queued, deduplicated and recovered after restart", async (t) => {
  const { dir } = temporary(t);
  let release!: () => void;
  const manager = new ScheduledTaskManager(openTestDb(dir), async () => new Promise<void>((resolve) => { release = resolve; }));
  const once = { kind: "once" as const, at: new Date(Date.now() + 60_000).toISOString() };
  const a = manager.create({ name: "A", prompt: "work", schedule: once });
  const b = manager.create({ name: "B", prompt: "work", schedule: once });
  manager.start();
  manager.runNow(a.id);
  await new Promise((resolve) => setImmediate(resolve));
  const queued = manager.runNow(b.id);
  assert.equal(queued.status, "queued");
  assert.equal(manager.runNow(b.id).id, queued.id);
  assert.deepEqual(manager.list().queuedTaskIds, [b.id]);
  manager.stop();
  release();
  await new Promise((resolve) => setImmediate(resolve));
  const ran: string[] = [];
  const restored = new ScheduledTaskManager(openTestDb(dir), async (task) => { ran.push(task.id); });
  restored.start();
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(ran, [b.id]);
  assert.equal(restored.history(a.id)[0]?.status, "interrupted");
  assert.equal(restored.history(b.id)[0]?.status, "completed");
  restored.stop();
});

test("time limits abort a run and allow queued work after it has settled", async (t) => {
  const ran: string[] = [];
  const manager = new ScheduledTaskManager(temporary(t).db, async (task, signal) => {
    ran.push(task.name);
    if (task.name === "slow") await new Promise<void>((resolve) => signal.addEventListener("abort", () => resolve(), { once: true }));
  });
  const schedule = { kind: "once" as const, at: new Date(Date.now() + 60_000).toISOString() };
  const slow = manager.create({ name: "slow", prompt: "work", schedule, maxRunSeconds: 1 });
  const next = manager.create({ name: "next", prompt: "work", schedule });
  manager.start();
  manager.runNow(slow.id);
  manager.runNow(next.id);
  await new Promise((resolve) => setTimeout(resolve, 1100));
  assert.equal(manager.history(slow.id)[0]?.status, "failed");
  assert.ok(manager.history(slow.id)[0]?.error);
  assert.equal(manager.history(next.id)[0]?.status, "completed");
  assert.deepEqual(ran, ["slow", "next"]);
  manager.stop();
});

test("overdue tasks honor skip policy without invoking a runner", async (t) => {
  const { dir, db } = temporary(t);
  const store = new ScheduledTaskStore(db);
  const task = store.create({ name: "skip", prompt: "work", schedule: daily, missedPolicy: "skip" });
  patchTask(db, task.id, { nextRunAt: Date.now() - 120_000 });
  let ran = false;
  const manager = new ScheduledTaskManager(openTestDb(dir), async () => { ran = true; });
  manager.start();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(ran, false);
  assert.equal(manager.history(task.id)[0]?.status, "missed");
  manager.stop();
});

test("a recovered automatic queue rechecks lateness before starting", async (t) => {
  const { dir, db } = temporary(t);
  const store = new ScheduledTaskStore(db);
  const task = store.create({ name: "queued", prompt: "work", schedule: daily, missedPolicy: "skip" });
  store.claim(task.id, task.nextRunAt!, "queued");
  patchRun(db, task.id, { scheduledAt: Date.now() - 120_000 });
  let ran = false;
  const manager = new ScheduledTaskManager(openTestDb(dir), async () => { ran = true; });
  manager.start();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(ran, false);
  assert.equal(manager.history(task.id)[0]?.status, "missed");
  manager.stop();
});

test("a due occurrence behind an existing queue gets a missed record without hiding the queue", async (t) => {
  const { dir, db } = temporary(t);
  const store = new ScheduledTaskStore(db);
  const task = store.create({ name: "repeat", prompt: "work", schedule: daily });
  store.claim(task.id, Date.now(), "queued", true);
  const due = Date.now() - 1000;
  patchTask(db, task.id, { nextRunAt: due });
  let finish!: () => void;
  const manager = new ScheduledTaskManager(openTestDb(dir), async () => new Promise<void>((resolve) => { finish = resolve; }));
  manager.start();
  await new Promise((resolve) => setImmediate(resolve));
  const history = manager.history(task.id);
  assert.equal(history.filter((run) => run.status === "missed" && run.scheduledAt === due).length, 1);
  assert.match(history.find((run) => run.status === "missed")?.error ?? "", /queued|待执行/);
  assert.equal(history.filter((run) => run.status === "running").length, 1);
  assert.equal(manager.list().tasks[0].lastStatus, "running");
  manager.wake();
  assert.equal(manager.history(task.id).length, 2);
  manager.stop();
  finish();
  await new Promise((resolve) => setImmediate(resolve));
});
