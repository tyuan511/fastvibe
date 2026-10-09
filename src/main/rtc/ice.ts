/**
 * The cloud's `GET /api/rtc/ice` answer, turned into what the WebRTC library is
 * configured with.
 *
 * The reply is `{ ice_servers: [{ urls, username?, credential? }] }` in the shape of the
 * browser's `RTCIceServer`. libdatachannel takes a host, a port and a relay type instead,
 * and takes the credentials as fields so a password with `/`, `+` or `=` in it — and
 * ours is base64 — never has to survive being written into a URL.
 *
 * Only TURN over UDP is kept: libdatachannel's ICE backend (libjuice) has no TURN over TCP
 * or TLS, and answers each such entry with a warning and nothing else. The service lists the
 * TCP form for the phone's stack, which does speak it.
 */

export type IceServerConfig = {
  hostname: string;
  port: number;
  username?: string;
  password?: string;
  relayType?: "TurnUdp" | "TurnTcp" | "TurnTls";
};

type RawServer = { urls?: unknown; username?: unknown; credential?: unknown };

export function toIceServers(reply: unknown): IceServerConfig[] {
  const raw = (reply as { ice_servers?: unknown } | null)?.ice_servers;
  if (!Array.isArray(raw)) return [];
  const out: IceServerConfig[] = [];
  for (const entry of raw as RawServer[]) {
    const urls = Array.isArray(entry?.urls) ? entry.urls : typeof entry?.urls === "string" ? [entry.urls] : [];
    const username = typeof entry?.username === "string" ? entry.username : undefined;
    const password = typeof entry?.credential === "string" ? entry.credential : undefined;
    for (const url of urls) {
      if (typeof url !== "string") continue;
      const parsed = parseIceUrl(url);
      if (!parsed) continue;
      if (parsed.relay) {
        if (parsed.relay !== "TurnUdp") continue;
        // A relay without credentials cannot be used, and would only slow the gathering.
        if (!username || !password) continue;
        out.push({ hostname: parsed.hostname, port: parsed.port, username, password, relayType: parsed.relay });
      } else {
        out.push({ hostname: parsed.hostname, port: parsed.port });
      }
    }
  }
  return out;
}

function parseIceUrl(url: string): { hostname: string; port: number; relay: IceServerConfig["relayType"] | null } | null {
  const match = /^(stun|stuns|turn|turns):(\[[^\]]+\]|[^:?\s]+)(?::(\d{1,5}))?(?:\?transport=(udp|tcp))?$/i.exec(url.trim());
  if (!match) return null;
  const scheme = match[1].toLowerCase();
  const hostname = match[2].replace(/^\[|\]$/g, "");
  const secure = scheme === "stuns" || scheme === "turns";
  const port = match[3] ? Number(match[3]) : secure ? 5349 : 3478;
  if (!Number.isInteger(port) || port < 1 || port > 65_535) return null;
  if (scheme === "stun" || scheme === "stuns") return { hostname, port, relay: null };
  const transport = (match[4] ?? "udp").toLowerCase();
  const relay = scheme === "turns" ? "TurnTls" : transport === "tcp" ? "TurnTcp" : "TurnUdp";
  return { hostname, port, relay };
}
