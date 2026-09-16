export function formatRelativeTime(timestamp: number): string {
  const delta = Date.now() - timestamp;
  if (delta < 60_000) return "刚刚";
  if (delta < 3_600_000) return `${Math.floor(delta / 60_000)} 分钟前`;
  if (delta < 86_400_000) return `${Math.floor(delta / 3_600_000)} 小时前`;
  return new Date(timestamp).toLocaleDateString();
}

/**
 * A millisecond span as a spoken duration: `41秒`, `3分钟 41秒`, `1小时 2分钟 3秒`.
 *
 * The app's only duration format. It is used by the transcript's 折叠运行过程 header, by each
 * reply's footer, and by the turn-statistics popover — three surfaces that sit next to each
 * other and read the same turns, so a compact `1m05s` beside a `1分钟 5秒` was two notations
 * for one number.
 *
 * `null`/negative spans return an empty string, leaving the caller to pick its own placeholder
 * (the popover's `—`) or to fall back to a start time, as the footer does.
 */
export function formatDuration(ms: number | null | undefined): string {
  if (ms == null || !Number.isFinite(ms) || ms < 0) return "";
  const total = Math.round(ms / 1000);
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const seconds = total % 60;
  const parts: string[] = [];
  if (hours > 0) parts.push(`${hours}小时`);
  if (minutes > 0) parts.push(`${minutes}分钟`);
  // Sub-minute spans must still say something, and a 1h00m00s run does not need the
  // zero seconds spelled out — but once a smaller unit is present it stays readable.
  if (seconds > 0 || parts.length === 0) parts.push(`${seconds}秒`);
  return parts.join(" ");
}
