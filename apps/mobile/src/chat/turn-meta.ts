import { locale, t } from "../i18n/core.ts";

/**
 * The desktop reply footer, reduced to the two facts a finished turn can state:
 * when it finished, and how long the whole turn took.
 *
 * A turn is one user prompt plus every assistant round-trip that followed it.
 * The footer sits on the last row of that group, and a turn still in flight gets
 * none — the working capsule is already saying that, and a finish time read
 * mid-run would be the previous round-trip's.
 */

export type TimedMessage = {
  id: string;
  role: string;
  kind?: string;
  createdAt?: number;
  completedAt?: number;
};

export type TurnMeta = {
  /** Completion instant, falling back to the request start when the end was not timed. */
  endedAt: number;
  /** Whole turn: first request start to the last entry's completion. Absent when untimed. */
  elapsedMs?: number;
};

export function completedTurnFooters(messages: TimedMessage[], running: boolean, previous?: Map<string, TurnMeta>): Map<string, TurnMeta> {
  const footers = new Map<string, TurnMeta>();
  let unchanged = previous !== undefined;
  let index = 0;
  while (index < messages.length) {
    let first: TimedMessage | undefined;
    let last: TimedMessage | undefined;
    do {
      const message = messages[index++];
      if (message.role === "assistant") {
        first ??= message;
        last = message;
      }
    } while (index < messages.length && messages[index].role !== "user");
    const isTail = index >= messages.length;
    if (running && isTail) continue;
    if (!first || !last) continue;
    const endedAt = last.completedAt ?? last.createdAt ?? first.createdAt;
    if (endedAt === undefined) continue;
    const elapsedMs = last.completedAt !== undefined && first.createdAt !== undefined
      ? Math.max(0, last.completedAt - first.createdAt)
      : undefined;
    const id = messages[index - 1].id;
    const value = {
      endedAt,
      elapsedMs: elapsedMs !== undefined && elapsedMs > 0 ? elapsedMs : undefined,
    };
    const cached = previous?.get(id);
    const entry = cached?.endedAt === value.endedAt && cached.elapsedMs === value.elapsedMs ? cached : value;
    if (entry !== cached) unchanged = false;
    footers.set(id, entry);
  }
  if (unchanged && previous?.size === footers.size) return previous;
  return footers;
}

/** `14:32` today, `9月3日 14:32` otherwise — the same rule as the desktop footer. */
export function formatTurnClock(timestamp: number, now: number = Date.now()): string {
  const date = new Date(timestamp);
  if (Number.isNaN(date.getTime())) return "";
  const time = date.toLocaleTimeString(locale(), { hour: "2-digit", minute: "2-digit", hourCycle: "h23" });
  const reference = new Date(now);
  const sameDay = date.getFullYear() === reference.getFullYear()
    && date.getMonth() === reference.getMonth()
    && date.getDate() === reference.getDate();
  if (date.getTime() <= now && sameDay) return time;
  const day = date.toLocaleDateString(locale(), {
    month: "short",
    day: "numeric",
    ...(date.getFullYear() === reference.getFullYear() ? {} : { year: "numeric" }),
  });
  return `${day} ${time}`;
}

/** Spoken duration, matching the desktop footer: `41秒`, `3分钟 41秒`, `1小时 2分钟 3秒`. */
export function formatTurnSpent(milliseconds: number): string {
  if (!Number.isFinite(milliseconds) || milliseconds < 0) return "";
  const total = Math.round(milliseconds / 1000);
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const seconds = total % 60;
  const parts: string[] = [];
  if (hours > 0) parts.push(t("time.hours", { n: hours }));
  if (minutes > 0) parts.push(t("time.minutes", { n: minutes }));
  if (seconds > 0 || parts.length === 0) parts.push(t("time.seconds", { n: seconds }));
  return parts.join(" ");
}

export function formatTurnMeta(meta: TurnMeta, now: number = Date.now()): string {
  const clock = formatTurnClock(meta.endedAt, now);
  if (!clock) return "";
  const spent = meta.elapsedMs !== undefined ? formatTurnSpent(meta.elapsedMs) : "";
  return spent ? t("time.turnSpent", { clock, spent }) : clock;
}
