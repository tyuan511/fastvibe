import type {
  ScheduledTask, ScheduledTaskDraft, ScheduledTaskPatch, ScheduledTaskRun, ScheduledTaskSnapshot,
} from "@shared/schedules";
import { ScheduledTaskStore } from "../engine/scheduled-tasks.ts";
import type { Db } from "../engine/db.ts";
import { uiText } from "../engine/ui-text.ts";

type ActiveRun = { taskId: string; runId: string; abort: AbortController; stopRequested: boolean; timedOut: boolean; timer?: ReturnType<typeof setTimeout> };

const MAX_MISSED_AGE_MS = 24 * 60 * 60 * 1000;
const MAX_TIMER_MS = 60_000;

export type ScheduledTaskRunner = (
  task: ScheduledTask,
  signal: AbortSignal,
  onConversation: (id: string) => void,
) => Promise<void>;

/** Called once a run has ended on its own (not when the app quits under it). */
export type ScheduledTaskSettled = (task: ScheduledTask, run: ScheduledTaskRun) => void;

/** Engine-owned: a window can disappear without taking the next occurrence with it.
 * Claiming an occurrence is synchronous and durable; a crash cannot replay a prompt
 * whose tools may already have modified the workspace. */
export class ScheduledTaskManager {
  readonly #store: ScheduledTaskStore;
  readonly #runner: ScheduledTaskRunner;
  readonly #onSettled: ScheduledTaskSettled | undefined;
  readonly #listeners = new Set<(snapshot: ScheduledTaskSnapshot) => void>();
  #timer: ReturnType<typeof setTimeout> | null = null;
  #started = false;
  #active: ActiveRun | null = null;

  constructor(
    db: Db,
    runner: ScheduledTaskRunner,
    onSettled?: ScheduledTaskSettled,
    options: { legacyFile?: string } = {},
  ) {
    this.#store = new ScheduledTaskStore(db, options);
    this.#runner = runner;
    this.#onSettled = onSettled;
    this.#store.onChange = () => {
      this.#notify();
      this.#arm();
    };
  }

  onChange(listener: (snapshot: ScheduledTaskSnapshot) => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  list(): ScheduledTaskSnapshot { return { ...this.#store.snapshot(), runningTaskId: this.#active?.taskId, queuedTaskIds: this.#store.queued().map((run) => run.taskId) }; }
  history(id: string): ScheduledTaskRun[] { return this.#store.listRuns(id); }
  hasEnabledTasks(): boolean { return this.#store.hasEnabledTasks() || this.#active !== null || this.#store.queued().length > 0; }
  flush(): void { this.#store.flush(); }

  create(draft: ScheduledTaskDraft): ScheduledTask {
    const task = this.#store.create(draft);
    this.#wake();
    return task;
  }

  update(id: string, patch: ScheduledTaskPatch): ScheduledTask {
    const task = this.#store.update(id, patch);
    if (!task) throw new Error("定时任务不存在");
    if (patch.enabled === false) {
      for (const run of this.#store.queued().filter((run) => run.taskId === id)) this.#store.finish(run.id, "stopped");
    }
    this.#wake();
    return this.#store.get(id)!;
  }

  remove(id: string): boolean {
    if (this.#active?.taskId === id) throw new Error("任务正在执行，请先停止后再删除");
    return this.#store.remove(id);
  }

  runNow(id: string): ScheduledTaskRun {
    const task = this.#store.get(id);
    if (!task) throw new Error("定时任务不存在");
    if (!this.#started) throw new Error("引擎未启动，无法立即执行");
    if (this.#active?.taskId === id) throw new Error(uiText("该任务正在执行", "This task is already running"));
    const queued = this.#store.queued().find((run) => run.taskId === id);
    if (queued) return queued;
    const run = this.#store.claim(id, Date.now(), "queued", true);
    this.#wake();
    return this.#store.listRuns(id).find((item) => item.id === run.id) ?? run;
  }

  stopRun(id: string): boolean {
    const active = this.#active;
    if (!active || active.taskId !== id) {
      const queued = this.#store.queued().find((run) => run.taskId === id);
      if (!queued) return false;
      this.#store.finish(queued.id, "stopped");
      this.#wake();
      return true;
    }
    active.stopRequested = true;
    active.abort.abort();
    return true;
  }

  start(): void {
    if (this.#started) return;
    this.#started = true;
    this.#wake();
  }

  /** Call after the machine wakes or its clock changes. It never replays an already
   * claimed occurrence, and collapses multiple missed repeats into at most one run. */
  wake(): void { this.#wake(); }

  stop(): void {
    this.#started = false;
    if (this.#timer) clearTimeout(this.#timer);
    this.#timer = null;
    const active = this.#active;
    if (active) {
      clearTimeout(active.timer);
      this.#store.finish(active.runId, "interrupted", "应用已退出");
      active.abort.abort();
      // Keep the slot occupied until the runner's finally settles. A quick stop/start
      // must never overlap a new occurrence with the old Agent still winding down.
    }
    this.#store.flush();
  }

  #wake(): void {
    if (!this.#started) return;
    if (this.#timer) clearTimeout(this.#timer);
    this.#timer = null;
    this.#pump();
  }

  #pump(): void {
    if (!this.#started) return;
    const now = Date.now();
    for (const task of this.#store.due(now).sort((a, b) => (a.nextRunAt ?? 0) - (b.nextRunAt ?? 0))) {
      const due = task.nextRunAt!;
      if (this.#store.queued().some((run) => run.taskId === task.id)) {
        const missed = this.#store.claim(task.id, due, "missed", false,
          uiText("已有待执行任务，本次触发已跳过", "Skipped because an earlier occurrence is still queued"));
        this.#report(task, missed);
        continue;
      }
      const tooLate = now - due > (task.missedPolicy === "skip" ? 60_000 : MAX_MISSED_AGE_MS);
      const run = this.#store.claim(task.id, due, tooLate ? "missed" : "queued");
      if (tooLate) this.#report(task, run);
    }
    if (!this.#active) {
      for (const queued of this.#store.queued()) {
        const task = this.#store.get(queued.taskId);
        if (!task) continue;
        if (!queued.manual && now - queued.scheduledAt > (task.missedPolicy === "skip" ? 60_000 : MAX_MISSED_AGE_MS)) {
          const skipped = this.#store.finish(queued.id, "missed");
          if (skipped) this.#report(task, skipped);
          continue;
        }
        const run = this.#store.startRun(queued.id);
        if (run) this.#launch(task, run);
        break;
      }
    }
    this.#arm();
  }

  #launch(task: ScheduledTask, run: ScheduledTaskRun): void {
    const active: ActiveRun = { taskId: task.id, runId: run.id, abort: new AbortController(), stopRequested: false, timedOut: false };
    this.#active = active;
    active.timer = setTimeout(() => {
      active.timedOut = true;
      active.abort.abort();
      // Keep the slot until the runner settles: abort is not proof that tools stopped.
      this.#notify();
    }, (task.maxRunSeconds ?? 3600) * 1000);
    this.#arm(); // No zero-delay retry loop while another occurrence is in flight.
    this.#notify(); // A consumed one-off still needs the tray until this run ends.
    void Promise.resolve().then(() => this.#runner(task, active.abort.signal, (id) => this.#store.setConversation(run.id, id)))
      .then(() => this.#store.finish(run.id, active.stopRequested ? "stopped" : active.timedOut ? "failed" : "completed", active.timedOut ? uiText("已超过执行时限", "Execution time limit exceeded") : undefined))
      .catch((error: unknown) => this.#store.finish(run.id, active.stopRequested ? "stopped" : "failed", active.timedOut ? uiText("已超过执行时限", "Execution time limit exceeded") : String(error instanceof Error ? error.message : error)))
      .then((finished) => {
        // Only the call that moved the run out of `running` reports it: stop() has
        // already marked a quit-time run interrupted, and that is nobody's news.
        if (!finished) return;
        this.#report(this.#store.get(task.id) ?? task, finished);
      })
      .finally(() => {
        clearTimeout(active.timer);
        if (this.#active === active) this.#active = null;
        this.#wake();
        this.#notify();
      })
      .catch((error: unknown) => console.error("[schedules] could not persist run outcome:", error));
  }

  #report(task: ScheduledTask, run: ScheduledTaskRun): void {
    try { this.#onSettled?.(task, run); }
    catch (error) { console.error("[schedules] settle listener failed:", error); }
  }

  #notify(): void {
    const snapshot = this.list();
    for (const listener of this.#listeners) {
      try { listener(snapshot); }
      catch (error) { console.error("[schedules] subscriber failed:", error); }
    }
  }

  #arm(): void {
    if (!this.#started) return;
    if (this.#timer) clearTimeout(this.#timer);
    const next = this.#store.snapshot().tasks.filter((task) => task.enabled && task.nextRunAt !== undefined)
      .reduce<number | undefined>((earliest, task) => earliest === undefined ? task.nextRunAt : Math.min(earliest, task.nextRunAt!), undefined);
    if (next === undefined) { this.#timer = null; return; }
    this.#timer = setTimeout(() => {
      this.#timer = null;
      this.#pump();
    }, Math.max(0, Math.min(MAX_TIMER_MS, next - Date.now())));
  }
}
