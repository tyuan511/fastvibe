import type { ScheduleRule, ScheduledTask, ScheduledTaskDraft } from "@shared/schedules";

/** Monday-first display order. Values stay Sunday=0 … Saturday=6, matching the schedule rule. */
export const WEEKDAY_ORDER = [1, 2, 3, 4, 5, 6, 0] as const;

const HM = /^([01]\d|2[0-3]):([0-5]\d)$/;

export type ScheduleKind = ScheduleRule["kind"];

export type ScheduleFormState = {
  name: string;
  prompt: string;
  /** Empty means a fresh scratch chat. */
  project: string;
  kind: ScheduleKind;
  /** `datetime-local` value, local wall time. */
  at: string;
  /** `HH:mm`. */
  time: string;
  timeZone: string;
  days: number[];
};

export type ScheduleFormError = "name" | "prompt" | "at" | "atPast" | "time" | "timeZone" | "days";

export function localTimeZone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  } catch {
    return "UTC";
  }
}

/** IANA zones, with the machine's zone (and any saved zone) first. */
export function timeZoneOptions(current = localTimeZone()): string[] {
  const intl = Intl as typeof Intl & { supportedValuesOf?: (key: "timeZone") => string[] };
  const zones = intl.supportedValuesOf?.("timeZone") ?? [];
  const preferred = [current, localTimeZone()].filter((zone) => zone.length > 0);
  return [...new Set([...preferred, ...zones])];
}

export function normalizeHm(value: string): string {
  const match = /^([01]\d|2[0-3]):([0-5]\d)/.exec(value);
  return match ? `${match[1]}:${match[2]}` : value;
}

export function isHm(value: string): boolean {
  return HM.test(value);
}

/** `datetime-local` (`YYYY-MM-DDTHH:mm`, local) → absolute ISO-8601. */
export function datetimeLocalToIso(value: string): string | undefined {
  if (!value.trim()) return undefined;
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return undefined;
  return parsed.toISOString();
}

/** Absolute ISO → `datetime-local` in the viewer's zone. */
export function isoToDatetimeLocal(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "";
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

export function emptyScheduleForm(now = Date.now()): ScheduleFormState {
  return {
    name: "",
    prompt: "",
    project: "",
    kind: "daily",
    at: isoToDatetimeLocal(new Date(now + 60 * 60 * 1000).toISOString()),
    time: "09:00",
    timeZone: localTimeZone(),
    days: [1, 2, 3, 4, 5],
  };
}

export function formFromTask(task: ScheduledTask, now = Date.now()): ScheduleFormState {
  const base = emptyScheduleForm(now);
  const rule = task.schedule;
  return {
    name: task.name,
    prompt: task.prompt,
    project: task.project ?? "",
    kind: rule.kind,
    at: rule.kind === "once" ? isoToDatetimeLocal(rule.at) : base.at,
    time: rule.kind === "once" ? base.time : rule.time,
    timeZone: rule.kind === "once" ? base.timeZone : rule.timeZone || base.timeZone,
    days: rule.kind === "weekly" ? [...rule.days] : base.days,
  };
}

export function validateScheduleForm(form: ScheduleFormState, now = Date.now()): ScheduleFormError | null {
  if (!form.name.trim()) return "name";
  if (!form.prompt.trim()) return "prompt";
  if (form.kind === "once") {
    const at = datetimeLocalToIso(form.at);
    if (!at) return "at";
    // The store requires a future instant too: do not show a saveable form it will reject.
    if (Date.parse(at) <= now) return "atPast";
    return null;
  }
  if (!isHm(normalizeHm(form.time))) return "time";
  if (!form.timeZone.trim()) return "timeZone";
  if (form.kind === "weekly" && form.days.length === 0) return "days";
  return null;
}

export function ruleFromForm(form: ScheduleFormState, now = Date.now()): ScheduleRule | undefined {
  if (validateScheduleForm(form, now)) return undefined;
  if (form.kind === "once") {
    const at = datetimeLocalToIso(form.at);
    return at ? { kind: "once", at } : undefined;
  }
  const time = normalizeHm(form.time);
  const timeZone = form.timeZone.trim();
  if (form.kind === "daily") return { kind: "daily", time, timeZone };
  const days = [...new Set(form.days.filter((day) => day >= 0 && day <= 6))].sort((a, b) => a - b);
  return { kind: "weekly", time, timeZone, days };
}

/**
 * Create payload. An empty project is omitted — scratch chat — rather than sent as `""`.
 * Updates that must clear a project send `""` themselves, because JSON drops `undefined`.
 */
export function draftFromForm(form: ScheduleFormState, now = Date.now()): ScheduledTaskDraft | undefined {
  const schedule = ruleFromForm(form, now);
  if (!schedule) return undefined;
  const project = form.project.trim();
  return {
    name: form.name.trim(),
    prompt: form.prompt.trim(),
    ...(project ? { project } : {}),
    schedule,
  };
}

export function sortTasks(tasks: ScheduledTask[]): ScheduledTask[] {
  return [...tasks].sort((a, b) => {
    if (a.enabled !== b.enabled) return a.enabled ? -1 : 1;
    const nextA = a.nextRunAt ?? Number.POSITIVE_INFINITY;
    const nextB = b.nextRunAt ?? Number.POSITIVE_INFINITY;
    if (nextA !== nextB) return nextA - nextB;
    return a.name.localeCompare(b.name) || a.id.localeCompare(b.id);
  });
}
