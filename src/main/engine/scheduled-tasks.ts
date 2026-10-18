import { randomUUID } from "node:crypto";
import { importLegacyJson, RowWriter, type Db } from "./db.ts";
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

/** A run row: the record, its place in the list, and the columns that carry meaning alone. */
type RunRow = { run: ScheduledTaskRun; position: number };
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
  if (draft.notifyConversationId !== undefined && (typeof draft.notifyConversationId !== "string" || !draft.notifyConversationId.trim())) throw new Error("通知的会话无效");
  if (draft.maxRunSeconds !== undefined && (!Number.isInteger(draft.maxRunSeconds) || draft.maxRunSeconds < 1 || draft.maxRunSeconds > 86400)) throw new Error("执行时限需要在 1–86400 秒之间");
  if (draft.missedPolicy !== undefined && draft.missedPolicy !== "run-latest" && draft.missedPolicy !== "skip") throw new Error("错过时间后的处理方式无效");
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
  return value === "queued" || value === "running" || value === "completed" || value === "failed" || value === "stopped" || value === "interrupted" || value === "missed";
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
  const notify = typeof raw.notifyConversationId === "string" && raw.notifyConversationId.trim() ? raw.notifyConversationId : undefined;
  const task: ScheduledTask = {
    maxRunSeconds: typeof raw.maxRunSeconds === "number" && Number.isInteger(raw.maxRunSeconds) && raw.maxRunSeconds >= 1 && raw.maxRunSeconds <= 86400 ? raw.maxRunSeconds : 3600,
    missedPolicy: raw.missedPolicy === "skip" ? "skip" : "run-latest",
    id: raw.id, name: raw.name.trim(), prompt: raw.prompt.trim(), schedule, enabled: raw.enabled,
    createdAt, updatedAt, ...(project ? { project } : {}), ...(notify ? { notifyConversationId: notify } : {}),
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

/** Every mutation is committed *before* it is published. A claimed occurrence must be
 * durable before its Agent runs or a crash could run it twice. */
export class ScheduledTaskStore {
  readonly #db: Db;
  #tasks = new Map<string, ScheduledTask>();
  #runs: ScheduledTaskRun[] = [];
  #revision = 0;
  #taskRows: RowWriter<ScheduledTask>;
  #runRows: RowWriter<RunRow>;
  /** What `schedule_meta` holds, so a flush that changes nothing writes nothing. */
  #storedRevision: string | null = null;
  onChange: ((snapshot: ScheduledTaskSnapshot) => void) | null = null;

  constructor(db: Db, options: { legacyFile?: string } = {}) {
    this.#db = db;
    this.#taskRows = new RowWriter<ScheduledTask>(db, {
      table: "scheduled_tasks",
      identity: (task) => ({ id: task.id }),
      data: (task) => JSON.stringify(task),
    });
    this.#runRows = new RowWriter<RunRow>(db, {
      table: "scheduled_runs",
      identity: (row) => ({ id: row.run.id }),
      columns: (row) => ({
        task_id: row.run.taskId,
        position: row.position,
        started_at: row.run.startedAt,
        status: row.run.status,
      }),
      data: (row) => JSON.stringify(row.run),
    });
    if (options.legacyFile) {
      importLegacyJson(db, {
        name: "scheduled-tasks",
        file: options.legacyFile,
        // The structural read only: what a `running` row means after a restart is decided by
        // `#read`, which runs on the rows themselves, imported or not.
        load: (value) => readScheduleShape(value),
        save: (shape) => {
          this.#writeRows(shape.tasks, shape.runs, shape.revision);
          return shape.tasks.length + shape.runs.length + (shape.revision === null ? 0 : 1);
        },
        count: () => db.countRows("scheduled_tasks") + db.countRows("scheduled_runs") + db.countRows("schedule_meta"),
      });
    }
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
      notifyConversationId: patch.notifyConversationId === "" ? undefined : patch.notifyConversationId ?? current.notifyConversationId,
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
  claim(taskId: string, scheduledAt: number, status: "queued" | "running" | "missed" = "running", manual = false, error?: string): ScheduledTaskRun {
    const task = this.#tasks.get(taskId);
    if (!task) throw new Error("定时任务不存在");
    if (!manual && (!task.enabled || task.nextRunAt !== scheduledAt)) throw new Error("任务的执行时间已变更");
    const now = Date.now();
    const run: ScheduledTaskRun = {
      id: randomUUID(), taskId, scheduledAt,
      status, startedAt: status === "running" ? now : undefined,
      endedAt: status === "missed" ? now : undefined,
      ...(manual ? { manual: true } : {}),
      ...(error ? { error } : {}),
    };
    this.#change(() => {
      const retained = [run, ...this.#runs];
      this.#runs = retained.filter((item, index) => index < MAX_RUNS || item.status === "queued" || item.status === "running");
      if (!manual || task.schedule.kind === "once") {
        if (task.schedule.kind === "once") {
          task.enabled = false;
          task.nextRunAt = undefined;
        } else {
          task.nextRunAt = nextScheduleAt(task.schedule, Math.max(now, scheduledAt));
        }
      }
      task.lastRunAt = now;
      task.lastStatus = this.#runs.some((item) => item.taskId === taskId && item.status === "running") ? "running"
        : this.#runs.some((item) => item.taskId === taskId && item.status === "queued") ? "queued" : status;
      task.updatedAt = now;
    });
    return { ...run };
  }

  queued(): ScheduledTaskRun[] {
    return this.#runs.filter((run) => run.status === "queued").reverse().map((run) => ({ ...run }));
  }

  startRun(id: string): ScheduledTaskRun | undefined {
    const run = this.#runs.find((item) => item.id === id && item.status === "queued");
    if (!run) return undefined;
    this.#change(() => {
      run.status = "running";
      run.startedAt = Date.now();
      const task = this.#tasks.get(run.taskId);
      if (task) { task.lastStatus = "running"; task.lastRunAt = run.startedAt; }
    });
    return { ...run };
  }

  setConversation(runId: string, conversationId: string): void {
    const run = this.#runs.find((item) => item.id === runId);
    if (run && run.status === "running") this.#change(() => { run.conversationId = conversationId; });
  }

  finish(runId: string, status: Exclude<ScheduledRunStatus, "queued" | "running">, error?: string): ScheduledTaskRun | undefined {
    const run = this.#runs.find((item) => item.id === runId);
    if (!run || (run.status !== "running" && run.status !== "queued")) return undefined;
    const now = Date.now();
    this.#change(() => {
      run.status = status;
      run.endedAt = now;
      if (error) run.error = error;
      const task = this.#tasks.get(run.taskId);
      if (task) {
        task.lastStatus = this.#runs.some((item) => item.taskId === run.taskId && item.status === "running") ? "running"
          : this.#runs.some((item) => item.taskId === run.taskId && item.status === "queued") ? "queued" : status;
        task.updatedAt = now;
      }
    });
    return { ...run };
  }

  /** The whole store, in one transaction: what changed, what is gone. */
  flush(): void {
    this.#db.transaction(() => this.#writeRows([...this.#tasks.values()], this.#runs, this.#revision));
  }

  #writeRows(tasks: ScheduledTask[], runs: ScheduledTaskRun[], revision: number | null): void {
    this.#taskRows.write(tasks);
    this.#runRows.write(runs.map((run, position) => ({ run, position })));
    if (revision === null) return;
    const text = String(revision);
    if (this.#storedRevision === text) return;
    this.#db.run(
      "INSERT INTO schedule_meta (key, value) VALUES ('revision', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
      text,
    );
    this.#storedRevision = text;
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

  /**
   * The rows, into the shape the manager works with — then the restart rules.
   *
   * `validStoredTask` / `validStoredRun` are the same guards the file reader had: a row that
   * does not describe a task is dropped rather than trusted, because these two writers are
   * the installed app and a `pnpm dev` of the next version.
   */
  #read(): void {
    const shape = readScheduleShape(this.#rows());
    for (const task of shape.tasks) this.#tasks.set(task.id, task);
    this.#runs = shape.runs;
    this.#revision = shape.revision ?? 0;
    {
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
    }
  }

  /** The three tables, in the shape the JSON file had. */
  #rows(): unknown {
    const tasks = this.#db
      .all<{ data: string }>("SELECT data FROM scheduled_tasks")
      .map((row) => parse(row.data))
      .filter((task) => task !== undefined);
    const runs = this.#db
      .all<{ data: string }>("SELECT data FROM scheduled_runs ORDER BY position, id")
      .map((row) => parse(row.data))
      .filter((run) => run !== undefined);
    const revision = this.#db.get<{ value: string }>("SELECT value FROM schedule_meta WHERE key = 'revision'")?.value;
    if (revision !== undefined) this.#storedRevision = revision;
    const ids = new Set(tasks.map((task) => (task as { id?: unknown }).id));
    return {
      version: 1,
      revision: revision === undefined ? 0 : Number(revision),
      tasks,
      // A run whose task is gone is history nobody can open: `remove()` deletes both, so an
      // orphan means the other process deleted the task, and the same rule as the file reader
      // drops it rather than showing a run under no task.
      runs: runs.filter((run) => ids.has((run as { taskId?: unknown }).taskId)),
    };
  }
}

function parse(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

/**
 * The file's shape, validated: the legacy import and the row reader both come through here,
 * so the two cannot disagree about what a stored task is.
 */
function readScheduleShape(value: unknown): { tasks: ScheduledTask[]; runs: ScheduledTaskRun[]; revision: number | null } {
  const data = value as { tasks?: unknown; runs?: unknown; revision?: unknown } | null;
  const now = Date.now();
  if (!data || !Array.isArray(data.tasks)) return { tasks: [], runs: [], revision: null };
  const tasks = (data.tasks as unknown[])
    .map((raw) => validStoredTask(raw, now))
    .filter((task): task is ScheduledTask => task !== undefined);
  const ids = new Set(tasks.map((task) => task.id));
  const runs = ((data.runs as unknown[]) ?? [])
    .filter((run): run is ScheduledTaskRun => validStoredRun(run) && ids.has(run.taskId))
    .filter((run, index) => index < MAX_RUNS || run.status === "queued" || run.status === "running");
  const revision = Number.isSafeInteger(data.revision as number) && (data.revision as number) >= 0 ? (data.revision as number) : null;
  return { tasks, runs, revision };
}
