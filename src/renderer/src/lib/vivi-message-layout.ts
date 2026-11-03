import { isSameDay } from "./message-time.ts";

const TIME_SEPARATOR_GAP_MS = 5 * 60_000;

type TimedMessage = { id: string; role: string; createdAt: number };

/** Messages remain independent; grouping only controls spacing and repeated avatars. */
export function viviMessageLayout<T extends TimedMessage>(messages: readonly T[]): Array<{
  message: T;
  showTime: boolean;
  groupStart: boolean;
  showDay: boolean;
}> {
  return messages.map((message, index) => {
    const previous = messages[index - 1];
    const showDay = !previous || !isSameDay(new Date(previous.createdAt), new Date(message.createdAt));
    const showTime = showDay || Boolean(previous && message.createdAt - previous.createdAt >= TIME_SEPARATOR_GAP_MS);
    const groupStart = showTime || message.role !== previous?.role || message.role === "system" || previous?.role === "system";
    return { message, showTime, groupStart, showDay };
  });
}

/**
 * Chat separators use local calendar dates, including across daylight-saving changes.
 * A day's first separator names the day; later separators today need only the clock.
 */
export function formatViviMessageTime(timestamp: number, locale: string, now = Date.now(), includeDay = false): string {
  const date = new Date(timestamp);
  const reference = new Date(now);
  if (Number.isNaN(date.getTime()) || Number.isNaN(reference.getTime())) return "";

  const time = date.toLocaleTimeString(locale, { hour: "2-digit", minute: "2-digit", hourCycle: "h23" });
  const today = isSameDay(date, reference);
  if (today && !includeDay) return time;

  const yesterday = new Date(reference);
  yesterday.setDate(yesterday.getDate() - 1);
  if (today || isSameDay(date, yesterday)) {
    const day = new Intl.RelativeTimeFormat(locale, { numeric: "auto" }).format(today ? 0 : -1, "day");
    return `${day.charAt(0).toLocaleUpperCase(locale)}${day.slice(1)} ${time}`;
  }

  const day = date.toLocaleDateString(locale, {
    month: "short",
    day: "numeric",
    ...(date.getFullYear() === reference.getFullYear() ? {} : { year: "numeric" }),
  });
  return `${day} ${time}`;
}
