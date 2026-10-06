import { formatMonthDay, t } from "../i18n";

/** `刚刚` / `5分钟前` / `3小时前` / `昨天` / `9月3日` — a list row's timestamp. */
export function relativeTime(timestamp: number, now: number = Date.now()): string {
  const diff = now - timestamp;
  if (diff < 60_000) return t("time.justNow");
  if (diff < 3_600_000) return t("time.minutesAgo", { n: Math.floor(diff / 60_000) });
  if (diff < 86_400_000) return t("time.hoursAgo", { n: Math.floor(diff / 3_600_000) });
  if (diff < 172_800_000) return t("time.yesterday");
  const date = new Date(timestamp);
  return formatMonthDay(date, date.getFullYear() !== new Date(now).getFullYear());
}
