import { randomUUID } from "node:crypto";
import { readFileSync, renameSync, writeFileSync } from "node:fs";
import type {
  ScheduleRule,
  ScheduledRunStatus,
  ScheduledTask,
  ScheduledTaskDraft,
  ScheduledTaskPatch,
  ScheduledTaskRun,
  ScheduledTaskSnapshot,
} from "@shared/schedules";

type ScheduleFile = { version: 1; revision: number; tasks: ScheduledTask[]; runs: ScheduledTaskRun[] };
const MAX_RUNS = 500;
const TIME = /^([01]\d|2[0-3]):[0-5]\d$/;
const ABSOLUTE = /T\d\d:\d\d(?::\d\d(?:\.\d+)?)?(?:Z|[+-]\d\d:\d\d)$/i;
const DAY_MS = 86_400_000;
const DAY_SET = new Set([0, 1, 2, 3, 4, 5, 6]);

type Wall = { year: number; month: number; day: number; hour: number; minute: number; second: number };
const wallFormatters = new Map<string, Intl.DateTimeFormat>();

function zoned(timeZone: string, instant: number): Wall {
  let formatter = wallFormatters.get(timeZone);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat("en-US", {
      timeZone, year: "numeric", month: "2-digit", day: "2-digit",
      hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23",
    });
    wallFormatters.set(timeZone, formatter);
  }
  const parts = Object.fromEntries(formatter.formatToParts(new Date(instant)).map((part) => [part.type, part.value]));
  return {
    year: Number(parts.year), month: Number(parts.month), day: Number(parts.day),
    hour: Number(parts.hour), minute: Number(parts.minute), second: Number(parts.second),
  };
}

function offsetAt(timeZone: string, instant: number): number {
  const local = zoned(timeZone, instant);
  return Date.UTC(local.year, local.month - 1, local.day, local.hour, local.minute, local.second) - Math.floor(instant / 1000) * 1000;
}

function sameDate(wall: Wall, year: number, month: number, day: number): boolean {
  return wall.year === year && wall.month === month && wall.day === day;
}

/** One local wall-clock time, including the two DST edges. A repeated time runs once
 * (its first occurrence); a nonexistent time runs at the first valid minute after it. */
function wallInstant(timeZone: string, year: number, month: number, day: number, time: string): number {
  const [hour, minute] = time.split(":").map(Number);
  const wallUtc = Date.UTC(year, month - 1, day, hour, minute);
  const offsets = new Set([-36, -12, 0, 12, 36].map((hours) => offsetAt(timeZone, wallUtc + hours * 3_600_000)));
  const matches = [...offsets].map((offset) => wallUtc - offset).filter((instant) => {
    const actual = zoned(timeZone, instant);
    return sameDate(actual, year, month, day) && actual.hour === hour && actual.minute === minute;
  });
  if (matches.length) return Math.min(...matches);
  // Spring-forward gap: choose the earliest real local minute after the requested time.
  for (let instant = wallUtc - 18 * 3_600_000; instant <= wallUtc + 18 * 3_600_000; instant += 60_000) {
    const actual = zoned(timeZone, instant);
    if (sameDate(actual, year, month, day) && actual.hour * 60 + actual.minute >= hour * 60 + minute) return instant;
  }
  throw new Error("无法计算指定时区的下次执行时间");
}

/** First occurrence strictly after `now`. The absolute time, not an interval timer,
 * is the source of truth after suspend, a clock change, or a process restart. */
export function nextScheduleAt(rule: ScheduleRule, now = Date.now()): number | undefined {
  if (rule.kind === "once") {
    const at = Date.parse(rule.at);
    return Number.isFinite(at) && at > now ? at : undefined;
  }
  const days = rule.kind === "daily" ? DAY_SET : new Set(rule.days);
  const local = zoned(rule.timeZone, now);
  for (let offset = 0; offset <= 8; offset++) {
    const date = new Date(Date.UTC(local.year, local.month - 1, local.day + offset));
    if (!days.has(date.getUTCDay())) continue;
    const instant = wallInstant(rule.timeZone, date.getUTCFullYear(), date.getUTCMonth() + 1, date.getUTCDate(), rule.time);
    if (instant > now) return instant;
  }
  return undefined;
}

export function validateScheduleDraft(draft: ScheduledTaskDraft, now = Date.now()): void {
  if (typeof draft?.name !== "string" || !draft.name.trim() || draft.name.length > 120) throw new Error("任务名称需要在 1–120 字之间");
  if (typeof draft.prompt !== "string" || !draft.prompt.trim() || draft.prompt.length > 20_000) throw new Error("任务指令需要在 1–20000 字之间");
  if (draft.project !== undefined && (typeof draft.project !== "string" || !draft.project.trim())) throw new Error("项目路径无效");
  const rule = draft.schedule;
  if (!rule || !["once", "daily", "weekly"].includes(rule.kind)) throw new Error("任务时间规则无效");
  if (rule.kind === "once") {
    if (typeof rule.at !== "string" || !ABSOLUTE.test(rule.at) || !Number.isFinite(Date.parse(rule.at))) throw new Error("一次性任务需要带时区的时间");
    if (Date.parse(rule.at) <= now) throw new Error("一次性任务必须安排在未来");
    return;
  }
  if (typeof rule.time !== "string" || !TIME.test(rule.time) || typeof rule.timeZone !== "string") throw new Error("重复任务需要有效的时间和时区");
  try { zoned(rule.timeZone, now); } catch { throw new Error("时区无效，请使用 IANA 时区名称"); }
  if (rule.kind === "weekly" && (!Array.isArray(rule.days) || rule.days.length === 0 || rule.days.some((day) => !DAY_SET.has(day)))) {
    throw new Error("每周任务至少需要选择一天");
  }
}

function isStatus(value: unknown): value is ScheduledRunStatus {
  return value === "running" || value === "completed" || value === "failed" || value === "stopped" || value === "interrupted" || value === "missed";
}

function validRule(value: unknown, now: number): ScheduleRule | undefined {
  if (!value || typeof value !== "object") return undefined;
  const rule = value as Record<string, unknown>;
  if (rule.kind === "once") {
    if (typeof rule.at !== "string" || !ABSOLUTE.test(rule.at) || !Number.isFinite(Date.parse(rule.at))) return undefined;
    return { kind: "once", at: rule.at };
  }
  if ((rule.kind !== "daily" && rule.kind !== "weekly") || typeof rule.time !== "string" || !TIME.test(rule.time) || typeof rule.timeZone !== "string") return undefined;
  try { zoned(rule.timeZone, now); } catch { return undefined; }
  if (rule.kind === "daily") return { kind: "daily", time: rule.time, timeZone: rule.timeZone };
  if (!Array.isArray(rule.days) || rule.days.length === 0 || rule.days.some((day) => !Number.isInteger(day) || !DAY_SET.has(day as number))) return undefined;
  return { kind: "weekly", time: rule.time, timeZone: rule.timeZone, days: [...new Set(rule.days as number[])].sort((a, b) => a - b) };
}

function validStoredTask(value: unknown, now: number): ScheduledTask | undefined {
  if (!value || typeof value !== "object") return undefined;
  const raw = value as Record<string, unknown>;
  if (typeof raw.id !== "string" || !raw.id || typeof raw.name !== "string" || !raw.name.trim() || raw.name.length > 120 || typeof raw.prompt !== "string" || !raw.prompt.trim() || raw.prompt.length > 20_000 || typeof raw.enabled !== "boolean") return undefined;
  const schedule = validRule(raw.schedule, now);
  if (!schedule) return undefined;
  const createdAt = typeof raw.createdAt === "number" && Number.isFinite(raw.createdAt) ? raw.createdAt : now;
  const updatedAt = typeof raw.updatedAt === "number" && Number.isFinite(raw.updatedAt) ? raw.updatedAt : createdAt;
  const project = typeof raw.project === "string" && raw.project.trim() ? raw.project : undefined;
  const task: ScheduledTask = {
    id: raw.id, name: raw.name.trim(), prompt: raw.prompt.trim(), schedule, enabled: raw.enabled,
    createdAt, updatedAt, ...(project ? { project } : {}),
    ...(typeof raw.lastRunAt === "number" && Number.isFinite(raw.lastRunAt) ? { lastRunAt: raw.lastRunAt } : {}),
    ...(isStatus(raw.lastStatus) ? { lastStatus: raw.lastStatus } : {}),
  };
  const storedNext = typeof raw.nextRunAt === "number" && Number.isFinite(raw.nextRunAt) && raw.nextRunAt > 0 ? raw.nextRunAt : undefined;
  if (task.enabled) {
    // Preserve an overdue claim after restart/sleep: the manager decides whether it
    // runs now or is too old and must be marked missed, never this decoder.
    task.nextRunAt = schedule.kind === "once" ? Date.parse(schedule.at) : storedNext ?? nextScheduleAt(schedule, now);
    if (task.nextRunAt === undefined) task.enabled = false;
  }
  return task;
}

function validStoredRun(value: unknown): value is ScheduledTaskRun {
  if (!value || typeof value !== "object") return false;
  const run = value as Record<string, unknown>;
  return typeof run.id === "string" && Boolean(run.id) && typeof run.taskId === "string" && Boolean(run.taskId)
    && typeof run.scheduledAt === "number" && Number.isFinite(run.scheduledAt) && isStatus(run.status)
    && (run.startedAt === undefined || (typeof run.startedAt === "number" && Number.isFinite(run.startedAt)))
    && (run.endedAt === undefined || (typeof run.endedAt === "number" && Number.isFinite(run.endedAt)))
    && (run.conversationId === undefined || typeof run.conversationId === "string")
    && (run.error === undefined || typeof run.error === "string")
    && (run.manual === undefined || typeof run.manual === "boolean");
}

/** Every mutation is committed with an atomic rename *before* it is published. A
 * claimed occurrence must be durable before its Agent runs or a crash could run it twice. */
export class ScheduledTaskStore {
  readonly #file: string;
  #tasks = new Map<string, ScheduledTask>();
  #runs: ScheduledTaskRun[] = [];
  #revision = 0;
  onChange: ((snapshot: ScheduledTaskSnapshot) => void) | null = null;

  constructor(file: string) {
    this.#file = file;
    this.#read();
  }

  snapshot(): ScheduledTaskSnapshot {
    return { revision: this.#revision, tasks: [...this.#tasks.values()].map((task) => structuredClone(task)) };
  }

  listRuns(taskId: string): ScheduledTaskRun[] {
    return this.#runs.filter((run) => run.taskId === taskId).map((run) => ({ ...run }));
  }

  get(id: string): ScheduledTask | undefined {
    const task = this.#tasks.get(id);
    return task ? structuredClone(task) : undefined;
  }

  hasEnabledTasks(): boolean {
    return [...this.#tasks.values()].some((task) => task.enabled);
  }

  create(draft: ScheduledTaskDraft): ScheduledTask {
    validateScheduleDraft(draft);
    const now = Date.now();
    const task: ScheduledTask = {
      ...structuredClone(draft), name: draft.name.trim(), prompt: draft.prompt.trim(),
      id: randomUUID(), enabled: true, createdAt: now, updatedAt: now,
      nextRunAt: nextScheduleAt(draft.schedule, now),
    };
    this.#change(() => { this.#tasks.set(task.id, task); });
    return structuredClone(task);
  }

  update(id: string, patch: ScheduledTaskPatch): ScheduledTask | undefined {
    const current = this.#tasks.get(id);
    if (!current) return undefined;
    const now = Date.now();
    const next: ScheduledTask = {
      ...current, ...structuredClone(patch),
      project: patch.project === "" ? undefined : patch.project ?? current.project,
      updatedAt: now,
    };
    // Pausing a one-shot task after its date is allowed; editing/resuming it is not.
    if (next.schedule.kind === "once" && !next.enabled && patch.enabled !== true && !patch.schedule) {
      validateScheduleDraft({ ...next, schedule: { kind: "once", at: new Date(now + 1000).toISOString() } }, now);
    } else {
      validateScheduleDraft(next, now);
    }
    if (patch.schedule || patch.enabled !== undefined) next.nextRunAt = next.enabled ? nextScheduleAt(next.schedule, now) : undefined;
    this.#change(() => { this.#tasks.set(id, next); });
    return structuredClone(next);
  }

  remove(id: string): boolean {
    if (!this.#tasks.has(id)) return false;
    this.#change(() => {
      this.#tasks.delete(id);
      this.#runs = this.#runs.filter((run) => run.taskId !== id);
    });
    return true;
  }

  due(now = Date.now()): ScheduledTask[] {
    return [...this.#tasks.values()].filter((task) => task.enabled && task.nextRunAt !== undefined && task.nextRunAt <= now).map((task) => structuredClone(task));
  }

  /** Claim one occurrence at most. `missed` consumes it without sending a prompt. */
  claim(taskId: string, scheduledAt: number, status: "running" | "missed" = "running", manual = false): ScheduledTaskRun {
    const task = this.#tasks.get(taskId);
    if (!task) throw new Error("定时任务不存在");
    if (!manual && (!task.enabled || task.nextRunAt !== scheduledAt)) throw new Error("任务的执行时间已变更");
    const now = Date.now();
    const run: ScheduledTaskRun = {
      id: randomUUID(), taskId, scheduledAt,
      status, startedAt: status === "running" ? now : undefined,
      endedAt: status === "missed" ? now : undefined,
      ...(manual ? { manual: true } : {}),
    };
    this.#change(() => {
      this.#runs = [run, ...this.#runs].slice(0, MAX_RUNS);
      if (!manual || task.schedule.kind === "once") {
        if (task.schedule.kind === "once") {
          task.enabled = false;
          task.nextRunAt = undefined;
        } else {
          task.nextRunAt = nextScheduleAt(task.schedule, Math.max(now, scheduledAt));
        }
      }
      task.lastRunAt = now;
      task.lastStatus = status;
      task.updatedAt = now;
    });
    return { ...run };
  }

  setConversation(runId: string, conversationId: string): void {
    const run = this.#runs.find((item) => item.id === runId);
    if (run && run.status === "running") this.#change(() => { run.conversationId = conversationId; });
  }

  finish(runId: string, status: Exclude<ScheduledRunStatus, "running" | "missed">, error?: string): ScheduledTaskRun | undefined {
    const run = this.#runs.find((item) => item.id === runId);
    if (!run || run.status !== "running") return undefined;
    const now = Date.now();
    this.#change(() => {
      run.status = status;
      run.endedAt = now;
      if (error) run.error = error;
      const task = this.#tasks.get(run.taskId);
      if (task) { task.lastStatus = status; task.updatedAt = now; }
    });
    return { ...run };
  }

  flush(): void {
    const payload: ScheduleFile = { version: 1, revision: this.#revision, tasks: [...this.#tasks.values()], runs: this.#runs };
    const tmp = `${this.#file}.${process.pid}.tmp`;
    writeFileSync(tmp, `${JSON.stringify(payload)}\n`, { mode: 0o600 });
    renameSync(tmp, this.#file);
  }

  #change(fn: () => void): void {
    const before = { tasks: structuredClone([...this.#tasks]), runs: structuredClone(this.#runs), revision: this.#revision };
    fn();
    this.#revision++;
    try { this.flush(); }
    catch (error) {
      this.#tasks = new Map(before.tasks);
      this.#runs = before.runs;
      this.#revision = before.revision;
      throw error;
    }
    // The file is already durable. A UI/transport subscriber must not make the
    // mutation fail after the claim has been committed.
    try { this.onChange?.(this.snapshot()); }
    catch (error) { console.error("[schedules] change listener failed:", error); }
  }

  #read(): void {
    try {
      const data = JSON.parse(readFileSync(this.#file, "utf8")) as Partial<ScheduleFile>;
      if (data.version !== 1 || !Array.isArray(data.tasks)) return;
      const now = Date.now();
      for (const raw of data.tasks as unknown[]) {
        const task = validStoredTask(raw, now);
        if (task) this.#tasks.set(task.id, task);
      }
      this.#runs = Array.isArray(data.runs)
        ? data.runs.filter((run): run is ScheduledTaskRun => validStoredRun(run) && this.#tasks.has(run.taskId)).slice(0, MAX_RUNS)
        : [];
      this.#revision = Number.isSafeInteger(data.revision) && data.revision! >= 0 ? data.revision! : 0;
      let changed = false;
      for (const run of this.#runs) {
        if (run.status === "running") {
          run.status = "interrupted";
          run.endedAt = Date.now();
          run.error = "应用退出时被中断";
          const task = this.#tasks.get(run.taskId);
          if (task) task.lastStatus = "interrupted";
          changed = true;
        }
      }
      if (changed) { this.#revision++; this.flush(); }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
}
