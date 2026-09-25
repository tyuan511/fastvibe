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

export function completedTurnFooters(messages: TimedMessage[], running: boolean): Map<string, TurnMeta> {
  const footers = new Map<string, TurnMeta>();
  let index = 0;
  while (index < messages.length) {
    const start = index;
    if (messages[index]?.role === "user") index += 1;
    while (index < messages.length && messages[index].role !== "user") index += 1;
    const isTail = index >= messages.length;
    if (running && isTail) continue;
    const group = messages.slice(start, index);
    const assistants = group.filter((message) => message.role === "assistant");
    if (assistants.length === 0) continue;
    const first = assistants[0];
    const last = assistants[assistants.length - 1];
    const endedAt = last.completedAt ?? last.createdAt ?? first.createdAt;
    if (endedAt === undefined) continue;
    const elapsedMs = last.completedAt !== undefined && first.createdAt !== undefined
      ? Math.max(0, last.completedAt - first.createdAt)
      : undefined;
    footers.set(group[group.length - 1].id, {
      endedAt,
      elapsedMs: elapsedMs !== undefined && elapsedMs > 0 ? elapsedMs : undefined,
    });
  }
  return footers;
}

/** `14:32` today, `9月3日 14:32` otherwise — the same rule as the desktop footer. */
export function formatTurnClock(timestamp: number, now: number = Date.now()): string {
  const date = new Date(timestamp);
  if (Number.isNaN(date.getTime())) return "";
  const time = date.toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit", hourCycle: "h23" });
  const reference = new Date(now);
  const sameDay = date.getFullYear() === reference.getFullYear()
    && date.getMonth() === reference.getMonth()
    && date.getDate() === reference.getDate();
  if (date.getTime() <= now && sameDay) return time;
  const day = date.toLocaleDateString("zh-CN", {
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
  if (hours > 0) parts.push(`${hours}小时`);
  if (minutes > 0) parts.push(`${minutes}分钟`);
  if (seconds > 0 || parts.length === 0) parts.push(`${seconds}秒`);
  return parts.join(" ");
}

export function formatTurnMeta(meta: TurnMeta, now: number = Date.now()): string {
  const clock = formatTurnClock(meta.endedAt, now);
  if (!clock) return "";
  const spent = meta.elapsedMs !== undefined ? formatTurnSpent(meta.elapsedMs) : "";
  return spent ? `${clock} · 用时 ${spent}` : clock;
}
