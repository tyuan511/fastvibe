/**
 * A name a person recognises for a browser session: "Chrome on macOS". Deliberately
 * coarse: it only has to tell "this laptop" from "that phone", and an unknown agent
 * returns null so the caller can say so instead of guessing.
 */
export function describeUserAgent(ua: string | null | undefined): { browser: string | null; os: string | null } {
  if (!ua) return { browser: null, os: null };

  // Order matters: Edge, Opera and Chrome on iOS all also say "Chrome" or "Safari".
  const browser =
    /\b(Edg|EdgA|EdgiOS)\//.test(ua) ? "Edge"
    : /\bOPR\/|\bOpera\b/.test(ua) ? "Opera"
    : /\b(Firefox|FxiOS)\//.test(ua) ? "Firefox"
    : /\b(Chrome|CriOS)\//.test(ua) ? "Chrome"
    : /\bSafari\//.test(ua) && /\bVersion\//.test(ua) ? "Safari"
    : /\b(curl|Go-http-client|python-requests|node)\b/i.test(ua) ? "Command line"
    : null;

  // iPad/iPhone before Mac: iOS agents say "like Mac OS X".
  const os =
    /\b(iPhone|iPod)\b/.test(ua) ? "iOS"
    : /\biPad\b/.test(ua) ? "iPadOS"
    : /\bAndroid\b/.test(ua) ? "Android"
    : /\bWindows\b/.test(ua) ? "Windows"
    : /\bMac OS X\b|\bMacintosh\b/.test(ua) ? "macOS"
    : /\bCrOS\b/.test(ua) ? "ChromeOS"
    : /\bLinux\b|\bX11\b/.test(ua) ? "Linux"
    : null;

  return { browser, os };
}

/** Intl units, largest first. */
const STEPS: [Intl.RelativeTimeFormatUnit, number][] = [
  ["year", 365 * 86400],
  ["month", 30 * 86400],
  ["day", 86400],
  ["hour", 3600],
  ["minute", 60],
];

/** "5 minutes ago", "yesterday", "just now" (under a minute), in the given locale. */
export function relativeTime(from: Date | string, locale: string, now: Date = new Date(), justNow = "just now"): string {
  const seconds = Math.round((new Date(from).getTime() - now.getTime()) / 1000);
  const abs = Math.abs(seconds);
  if (abs < 60) return justNow;
  const format = new Intl.RelativeTimeFormat(locale, { numeric: "auto" });
  for (const [unit, size] of STEPS) {
    if (abs >= size) return format.format(Math.trunc(seconds / size), unit);
  }
  return justNow;
}
