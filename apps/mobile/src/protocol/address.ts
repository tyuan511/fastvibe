/**
 * A FastVibe remote address, whether it came from a tunnel QR code or the LAN
 * line in 设置 → 远程访问.
 *
 * The settings pane copies a LAN address as `192.168.x.x:7777` — no scheme.
 * A tunnel QR is a full `https://` URL. Both have to become one origin.
 */

const DEFAULT_LAN_PORT = 7777;

export type AddressKind = "lan" | "public" | "loopback";

export type ServerAddress = {
  /** `http(s)://host[:port]`, no path, no trailing slash. */
  origin: string;
  wsUrl: string;
  /** What the list shows: `192.168.31.45:7777` or `foo.trycloudflare.com`. */
  host: string;
  kind: AddressKind;
};

export function parseServerAddress(raw: string): ServerAddress | null {
  const input = raw.trim().replace(/^['"]+|['"]+$/g, "");
  if (!input || /\s/.test(input)) return null;

  const explicit = /^https?:\/\//i.test(input) || /^wss?:\/\//i.test(input);
  let withScheme = input;
  if (/^wss:\/\//i.test(input)) withScheme = `https://${input.slice("wss://".length)}`;
  else if (/^ws:\/\//i.test(input)) withScheme = `http://${input.slice("ws://".length)}`;
  else if (/^[a-z][a-z0-9+.-]*:\/\//i.test(input)) {
    if (!/^https?:\/\//i.test(input)) return null;
  } else {
    withScheme = `http://${input}`;
  }

  let url: URL;
  try {
    url = new URL(withScheme);
  } catch {
    return null;
  }
  if (url.username || url.password) return null;
  const hostname = url.hostname;
  if (!hostname || !isHost(hostname)) return null;

  const kind = classify(hostname);
  const protocol = inferProtocol(explicit, url.protocol, hostname, kind);
  const port = resolvePort(url.port, protocol, hostname, kind);
  if (port === null) return null;

  const host = formatHost(hostname, port, protocol);
  const origin = `${protocol}//${host}`;
  const wsUrl = `${protocol === "https:" ? "wss:" : "ws:"}//${host}/ws`;
  return { origin, wsUrl, host, kind };
}

export function addressKindLabel(kind: AddressKind): string {
  if (kind === "lan") return "局域网";
  if (kind === "loopback") return "本机";
  return "公网";
}

function inferProtocol(
  explicit: boolean,
  parsed: string,
  hostname: string,
  kind: AddressKind,
): "http:" | "https:" {
  if (explicit) return parsed === "https:" ? "https:" : "http:";
  if (kind !== "public" || isIpv4(hostname)) return "http:";
  return "https:";
}

function resolvePort(raw: string, protocol: "http:" | "https:", hostname: string, kind: AddressKind): string | null {
  if (raw) {
    const port = Number(raw);
    if (!Number.isInteger(port) || port < 1 || port > 65535) return null;
    return String(port);
  }
  if (isIpv4(hostname) || kind !== "public") return protocol === "https:" ? "443" : String(DEFAULT_LAN_PORT);
  return protocol === "https:" ? "443" : "80";
}

function formatHost(hostname: string, port: string, protocol: "http:" | "https:"): string {
  const bare = hostname.includes(":") ? `[${hostname}]` : hostname;
  const omitted = protocol === "https:" ? "443" : "80";
  if (port === omitted) return bare;
  return `${bare}:${port}`;
}

function classify(hostname: string): AddressKind {
  const host = hostname.toLowerCase();
  if (host === "localhost" || host === "::1" || host.startsWith("127.")) return "loopback";
  if (host.endsWith(".local") || host.endsWith(".lan") || isPrivateV4(host)) return "lan";
  return "public";
}

function isPrivateV4(host: string): boolean {
  return (
    /^10\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(host) ||
    /^192\.168\.\d{1,3}\.\d{1,3}$/.test(host) ||
    /^172\.(1[6-9]|2\d|3[01])\.\d{1,3}\.\d{1,3}$/.test(host) ||
    /^169\.254\.\d{1,3}\.\d{1,3}$/.test(host) ||
    /^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\.\d{1,3}\.\d{1,3}$/.test(host)
  );
}

function isIpv4(host: string): boolean {
  return /^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(host);
}

function isHost(hostname: string): boolean {
  if (hostname.length > 253) return false;
  if (hostname.includes("%")) return false;
  return /^[a-z0-9.:_-]+$/i.test(hostname) || hostname.includes(":");
}
