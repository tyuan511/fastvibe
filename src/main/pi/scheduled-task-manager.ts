import type {
  ScheduledTask, ScheduledTaskDraft, ScheduledTaskPatch, ScheduledTaskRun, ScheduledTaskSnapshot,
} from "@shared/schedules";
import { ScheduledTaskStore } from "../engine/scheduled-tasks.ts";

const MAX_MISSED_AGE_MS = 24 * 60 * 60 * 1000;
const MAX_TIMER_MS = 60_000;

export type ScheduledTaskRunner = (
  task: ScheduledTask,
  signal: AbortSignal,
  onConversation: (id: string) => void,
) => Promise<void>;

/** Engine-owned: a window can disappear without taking the next occurrence with it.
 * Claiming an occurrence is synchronous and durable; a crash cannot replay a prompt
 * whose tools may already have modified the workspace. */
export class ScheduledTaskManager {
  readonly #store: ScheduledTaskStore;
  readonly #runner: ScheduledTaskRunner;
  readonly #listeners = new Set<(snapshot: ScheduledTaskSnapshot) => void>();
  #timer: ReturnType<typeof setTimeout> | null = null;
  #started = false;
  #active: { taskId: string; runId: string; abort: AbortController; stopRequested: boolean } | null = null;

  constructor(file: string, runner: ScheduledTaskRunner) {
    this.#store = new ScheduledTaskStore(file);
    this.#runner = runner;
    this.#store.onChange = (snapshot) => {
      this.#notify(snapshot);
      this.#arm();
    };
  }

  onChange(listener: (snapshot: ScheduledTaskSnapshot) => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  list(): ScheduledTaskSnapshot { return this.#store.snapshot(); }
  history(id: string): ScheduledTaskRun[] { return this.#store.listRuns(id); }
  hasEnabledTasks(): boolean { return this.#store.hasEnabledTasks() || this.#active !== null; }
  flush(): void { this.#store.flush(); }

  create(draft: ScheduledTaskDraft): ScheduledTask {
    const task = this.#store.create(draft);
    this.#wake();
    return task;
  }

  update(id: string, patch: ScheduledTaskPatch): ScheduledTask {
    const task = this.#store.update(id, patch);
    if (!task) throw new Error("定时任务不存在");
    this.#wake();
    return task;
  }

  remove(id: string): boolean {
    if (this.#active?.taskId === id) throw new Error("任务正在执行，请先停止后再删除");
    return this.#store.remove(id);
  }

  runNow(id: string): ScheduledTaskRun {
    const task = this.#store.get(id);
    if (!task) throw new Error("定时任务不存在");
    if (!this.#started) throw new Error("引擎未启动，无法立即执行");
    if (this.#active) throw new Error("已有定时任务正在执行，请等待其结束");
    const run = this.#store.claim(id, Date.now(), "running", true);
    this.#launch(task, run);
    return run;
  }

  stopRun(id: string): boolean {
    const active = this.#active;
    if (!active || active.taskId !== id) return false;
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
    if (!this.#active) {
      const now = Date.now();
      for (const task of this.#store.due(now).sort((a, b) => (a.nextRunAt ?? 0) - (b.nextRunAt ?? 0))) {
        const due = task.nextRunAt!;
        if (now - due > MAX_MISSED_AGE_MS) {
          this.#store.claim(task.id, due, "missed");
          continue;
        }
        const run = this.#store.claim(task.id, due);
        this.#launch(task, run);
        break;
      }
    }
    this.#arm();
  }

  #launch(task: ScheduledTask, run: ScheduledTaskRun): void {
    const active = { taskId: task.id, runId: run.id, abort: new AbortController(), stopRequested: false };
    this.#active = active;
    this.#arm(); // No zero-delay retry loop while another occurrence is in flight.
    this.#notify(); // A consumed one-off still needs the tray until this run ends.
    void Promise.resolve().then(() => this.#runner(task, active.abort.signal, (id) => this.#store.setConversation(run.id, id)))
      .then(() => this.#store.finish(run.id, active.stopRequested ? "stopped" : "completed"))
      .catch((error: unknown) => this.#store.finish(run.id, active.stopRequested ? "stopped" : "failed", String(error instanceof Error ? error.message : error)))
      .finally(() => {
        if (this.#active === active) this.#active = null;
        this.#wake();
        this.#notify();
      })
      .catch((error: unknown) => console.error("[schedules] could not persist run outcome:", error));
  }

  #notify(snapshot = this.#store.snapshot()): void {
    for (const listener of this.#listeners) {
      try { listener(snapshot); }
      catch (error) { console.error("[schedules] subscriber failed:", error); }
    }
  }

  #arm(): void {
    if (!this.#started) return;
    if (this.#timer) clearTimeout(this.#timer);
    if (this.#active) { this.#timer = null; return; }
    const next = this.#store.snapshot().tasks.filter((task) => task.enabled && task.nextRunAt !== undefined)
      .reduce<number | undefined>((earliest, task) => earliest === undefined ? task.nextRunAt : Math.min(earliest, task.nextRunAt!), undefined);
    if (next === undefined) { this.#timer = null; return; }
    this.#timer = setTimeout(() => {
      this.#timer = null;
      this.#pump();
    }, Math.max(0, Math.min(MAX_TIMER_MS, next - Date.now())));
  }
}
