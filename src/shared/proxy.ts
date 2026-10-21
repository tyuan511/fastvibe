/** One preference for Chromium, Node, and managed package downloads: a switch, whether
 * to follow the operating system or an address of the user's own, and that address.
 * No credentials are accepted here: settings are shared with renderers and remote
 * clients, so `http://user:pass@host` is refused rather than stored and shown. */
export type ProxySettings = {
  proxyEnabled: boolean;
  proxyMode: "system" | "custom";
  /** `http://host:port`, `https://…`, `socks5://…` or `socks5h://…`; the port may be left
   * off and Chromium picks the scheme's own. Only read when `proxyMode` is `custom`. */
  proxyUrl: string;
};

/** The schemes Chromium's proxy rules understand. SOCKS4 is deliberately absent: the
 * system path rejects it too, rather than guessing that a SOCKS4 address is SOCKS5. */
export const PROXY_URL_SCHEMES = ["http", "https", "socks5", "socks5h"] as const;

export const DEFAULT_PROXY_SETTINGS: ProxySettings = {
  proxyEnabled: false,
  proxyMode: "system",
  proxyUrl: "http://127.0.0.1:7890",
};

/** What an earlier build wrote in three fields instead of one address. */
export const LEGACY_PROXY_KEYS = ["proxyProtocol", "proxyHost", "proxyPort"] as const;

export function validProxyHost(value: unknown): value is string {
  if (typeof value !== "string" || !value || value !== value.trim()) return false;
  // A host, never a URL, path, credentials or Chromium proxy-rule separator.
  if (/[\s/@?#;,=\\]/.test(value)) return false;
  try {
    const url = new URL(`http://${value}:1`);
    return url.hostname === value.toLowerCase() && url.port === "1";
  } catch { return false; }
}

export function validProxyPort(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 1 && value <= 65535;
}

/**
 * The typed address in its canonical form, or null when it is not one.
 *
 * Parsed by hand rather than with `URL`: WHATWG drops a port that equals its scheme's
 * default (`http://h:80` answers `port === ""`), so rebuilding from its parts would
 * quietly lose the `:80` a person typed. The scheme is the only thing lowercased.
 */
export function normalizeProxyUrl(value: unknown): string | null {
  if (typeof value !== "string" || !value || value !== value.trim()) return null;
  // The scheme may hold digits — `socks5` is the one that matters here.
  const parts = /^([A-Za-z][A-Za-z0-9+.-]*):\/\/(\[[0-9A-Fa-f:.]+\]|[^/:@?#]*)(?::([^/?#]*))?$/.exec(value);
  if (!parts) return null;
  const scheme = parts[1].toLowerCase();
  if (!(PROXY_URL_SCHEMES as readonly string[]).includes(scheme)) return null;
  const host = parts[2];
  if (!validProxyHost(host)) return null;
  const port = parts[3];
  if (port === undefined) return `${scheme}://${host}`;
  if (!/^\d{1,5}$/.test(port) || !validProxyPort(Number(port))) return null;
  return `${scheme}://${host}:${port}`;
}

/**
 * The address a settings object is asking for, canonicalised, or null for none.
 *
 * A file written before this field existed carries the three legacy parts, so those are
 * folded into one URL — an install that already routes through a proxy keeps working
 * through the upgrade. Once `proxyUrl` is present it wins outright, including when it is
 * garbage: a half-typed address must not resurrect the host and port beside it in the
 * same object.
 */
export function proxyUrlOf(settings: Record<string, unknown>): string | null {
  if ("proxyUrl" in settings) return normalizeProxyUrl(settings.proxyUrl);
  const host = validProxyHost(settings.proxyHost) ? settings.proxyHost : null;
  const port = validProxyPort(settings.proxyPort) ? settings.proxyPort : null;
  if (!host || !port) return null;
  return normalizeProxyUrl(`${settings.proxyProtocol === "socks5" ? "socks5" : "http"}://${host}:${port}`);
}

export function proxySettingsOf(settings: Record<string, unknown>): ProxySettings {
  return {
    proxyEnabled: settings.proxyEnabled === true,
    proxyMode: settings.proxyMode === "custom" ? "custom" : "system",
    proxyUrl: proxyUrlOf(settings) ?? DEFAULT_PROXY_SETTINGS.proxyUrl,
  };
}

/** Ordinary preference saves carry full snapshots from possibly stale clients.
 * Only the explicit proxy action (or reset) may change network routing. */
export function mergeSettingsPreservingProxy(current: Record<string, unknown>, incoming: Record<string, unknown>): Record<string, unknown> {
  return { ...incoming, ...proxySettingsOf(current) };
}

/** Reject invalid active configuration, rather than silently falling back to direct. */
export function assertProxySettings(settings: Record<string, unknown>): void {
  if (settings.proxyEnabled !== true || settings.proxyMode !== "custom") return;
  if (!proxyUrlOf(settings)) throw new Error("Invalid proxy configuration");
}

export function chromiumProxyConfig(settings: ProxySettings): {
  mode: "direct" | "system" | "fixed_servers";
  proxyRules?: string;
  proxyBypassRules?: string;
} {
  if (!settings.proxyEnabled) return { mode: "direct" };
  if (settings.proxyMode === "system") return { mode: "system" };
  return {
    mode: "fixed_servers",
    proxyRules: settings.proxyUrl,
    proxyBypassRules: "localhost;127.0.0.1;[::1]",
  };
}

/** Only literal loopback IPs bypass: 127.example.com is a public hostname. */
export function isProxyLoopback(url: string): boolean {
  const host = new URL(url).hostname;
  return host === "localhost" || host === "[::1]" || /^127\.\d+\.\d+\.\d+$/.test(host);
}

/** Use Chromium's first decision; never silently use DIRECT after a failed proxy. */
export function proxyUrlFromResolution(resolution: string): string {
  const first = resolution.split(";")[0]?.trim() ?? "";
  if (first === "DIRECT") return "";
  if (first.startsWith("SOCKS ")) throw new Error("System SOCKS4 proxy is unsupported; use HTTP or SOCKS5");
  const match = /^(PROXY|HTTPS|SOCKS5)\s+(\S+)$/.exec(first);
  if (!match) throw new Error("Unsupported system proxy configuration");
  const scheme = match[1] === "PROXY" ? "http" : match[1] === "HTTPS" ? "https" : "socks5h";
  return `${scheme}://${match[2]}`;
}
