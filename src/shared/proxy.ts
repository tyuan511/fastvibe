/** One preference for Chromium, Node, and managed package downloads. No credentials
 * are accepted here: settings are shared with renderers and remote clients. */
export type ProxySettings = {
  proxyEnabled: boolean;
  proxyMode: "system" | "custom";
  proxyProtocol: "http" | "socks5";
  proxyHost: string;
  proxyPort: number;
};

export const DEFAULT_PROXY_SETTINGS: ProxySettings = {
  proxyEnabled: false,
  proxyMode: "system",
  proxyProtocol: "http",
  proxyHost: "127.0.0.1",
  proxyPort: 7890,
};

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

export function proxySettingsOf(settings: Record<string, unknown>): ProxySettings {
  return {
    proxyEnabled: settings.proxyEnabled === true,
    proxyMode: settings.proxyMode === "custom" ? "custom" : "system",
    proxyProtocol: settings.proxyProtocol === "socks5" ? "socks5" : "http",
    proxyHost: validProxyHost(settings.proxyHost) ? settings.proxyHost : DEFAULT_PROXY_SETTINGS.proxyHost,
    proxyPort: validProxyPort(settings.proxyPort) ? settings.proxyPort : DEFAULT_PROXY_SETTINGS.proxyPort,
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
  if (!validProxyHost(settings.proxyHost) || !validProxyPort(settings.proxyPort)
    || (settings.proxyProtocol !== "http" && settings.proxyProtocol !== "socks5")) {
    throw new Error("Invalid proxy configuration");
  }
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
    proxyRules: `${settings.proxyProtocol}://${settings.proxyHost}:${settings.proxyPort}`,
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
