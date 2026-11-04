export type IrohRelayUsage = {
  periodStart: string;
  resetsAt: string;
  usedBytes: number;
  quotaBytes: number;
  remainingBytes: number;
};

export type IrohRelayNode = {
  relayId: string;
  url: string;
  quicPort: number;
  token: string;
};

export type IrohRelayConfig = IrohRelayNode & {
  /** All configured nodes. Absent only in a lease from an older Control. */
  relays?: IrohRelayNode[];
  expiresAt: string;
  usage: IrohRelayUsage;
};

/** Legacy fields remain a compatibility projection, never a preferred-node policy. */
export function irohRelayNodes(config: IrohRelayConfig): readonly IrohRelayNode[] {
  if (config.relays !== undefined) {
    if (!config.relays.length) throw new Error("iroh relay list is empty");
    return config.relays;
  }
  return [{ relayId: config.relayId, url: config.url, quicPort: config.quicPort, token: config.token }];
}

export class IrohRelayQuotaExceeded extends Error {
  constructor() {
    super("relay_quota_exceeded");
    this.name = "IrohRelayQuotaExceeded";
  }
}

export function parseIrohRelayConfig(value: unknown): IrohRelayConfig | null {
  if (!value || typeof value !== "object") return null;
  const raw = value as Record<string, unknown>;
  const usage = parseIrohRelayUsage(raw.usage);
  if (typeof raw.expires_at !== "string" || !Number.isFinite(Date.parse(raw.expires_at)) || !usage) return null;
  const relays: IrohRelayNode[] = [];
  if (raw.relays !== undefined) {
    if (!Array.isArray(raw.relays) || !raw.relays.length) return null;
    const urls = new Set<string>();
    const ids = new Set<string>();
    for (const entry of raw.relays) {
      const node = parseRelayNode(entry);
      if (!node || ids.has(node.relayId) || urls.has(new URL(node.url).href)) return null;
      ids.add(node.relayId);
      urls.add(new URL(node.url).href);
      relays.push(node);
    }
  } else {
    const node = parseRelayNode(raw);
    if (!node) return null;
    relays.push(node);
  }
  return { ...relays[0], relays, expiresAt: raw.expires_at, usage };
}

function parseRelayNode(value: unknown): IrohRelayNode | null {
  if (!value || typeof value !== "object") return null;
  const raw = value as Record<string, unknown>;
  if (
    typeof raw.relay_id !== "string" || !raw.relay_id.trim() ||
    typeof raw.url !== "string" || !raw.url ||
    typeof raw.quic_port !== "number" || !Number.isInteger(raw.quic_port) || raw.quic_port < 1 || raw.quic_port > 65535 ||
    typeof raw.token !== "string" || !raw.token.trim()
  ) return null;
  try {
    const url = new URL(raw.url);
    if (url.protocol !== "https:" || !url.hostname || url.username || url.password || url.pathname !== "/" || url.search || url.hash) return null;
  } catch {
    return null;
  }
  return { relayId: raw.relay_id, url: raw.url, quicPort: raw.quic_port, token: raw.token };
}

export function parseIrohRelayUsage(value: unknown): IrohRelayUsage | null {
  if (!value || typeof value !== "object") return null;
  const raw = value as Record<string, unknown>;
  if (
    typeof raw.period_start !== "string" || typeof raw.resets_at !== "string" ||
    !Number.isFinite(Date.parse(raw.period_start)) || !Number.isFinite(Date.parse(raw.resets_at)) ||
    typeof raw.used_bytes !== "number" || typeof raw.quota_bytes !== "number" || typeof raw.remaining_bytes !== "number" ||
    !Number.isSafeInteger(raw.used_bytes) || !Number.isSafeInteger(raw.quota_bytes) || !Number.isSafeInteger(raw.remaining_bytes) ||
    raw.used_bytes < 0 || raw.quota_bytes < 0 || raw.remaining_bytes < 0
  ) return null;
  return {
    periodStart: raw.period_start,
    resetsAt: raw.resets_at,
    usedBytes: raw.used_bytes,
    quotaBytes: raw.quota_bytes,
    remainingBytes: raw.remaining_bytes,
  };
}
