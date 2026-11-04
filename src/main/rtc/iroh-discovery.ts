import { randomUUID } from "node:crypto";
import { isIP } from "node:net";
import { hostname } from "node:os";
import { Bonjour } from "bonjour-service";
import { discoveryNameWithSuffix } from "../../shared/discovery-name.ts";
import { mdnsInstanceName } from "../server/mdns.ts";

export const IROH_DISCOVERY_SERVICE = "fastvibe-iroh";
const MAX_ADDRESSES = 8;
const MAX_TXT_BYTES = 255;
const MAX_NAME_ATTEMPTS = 5;
const PROBE_TIMEOUT_MS = 2_000;

export type IrohDiscoveryEndpoint = {
  deviceId: string;
  endpointId: string;
  name?: string;
  directAddresses: readonly string[];
};

type Address = { socket: string; ip: string; port: number; family: 4 | 6; rank: number };
type RecordData = { type: string; data: unknown };
export interface DiscoveryService {
  activated: boolean;
  published: boolean;
  records(): RecordData[];
  on(event: string, listener: (...args: unknown[]) => void): unknown;
}
export type DiscoveryPublishConfig = {
  name: string; host: string; type: string; protocol: "udp"; port: number;
  txt: Record<string, string>; disableIPv6: boolean;
};
export interface DiscoveryBonjour {
  publish(config: DiscoveryPublishConfig): DiscoveryService;
  unpublishAll(callback?: () => void): void;
  destroy(callback?: () => void): void;
}
export interface IrohDiscoveryPublisher {
  publish(endpoint: IrohDiscoveryEndpoint): void;
  stop(): void;
}
export type IrohDiscoveryDeps = {
  log: { info(message: string): void; warn(message: string): void };
  create?: (onError: (error: unknown) => void) => DiscoveryBonjour;
};

function canonicalIp(ip: string): string {
  return isIP(ip) === 6 ? new URL(`http://[${ip}]/`).hostname.slice(1, -1) : ip;
}

function localAddress(raw: string): Address | null {
  const match = /^(?:\[([^\]]+)\]|([^:]+)):(\d{1,5})$/.exec(raw);
  if (!match) return null;
  const ip = match[1] ?? match[2];
  const family = isIP(ip);
  const port = Number(match[3]);
  if ((family !== 4 && family !== 6) || ip.includes("%") || port < 1 || port > 65535) return null;
  if (family === 4) {
    const [a, b] = ip.split(".").map(Number);
    // A public address obtained through STUN is not evidence of a local interface.
    if (!(a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168))) return null;
    return { socket: `${ip}:${port}`, ip, port, family, rank: 0 };
  }
  const normalized = canonicalIp(ip);
  if (normalized.includes("%") || normalized === "::" || normalized === "::1"
    || normalized.startsWith("ff") || /^fe[89ab]/.test(normalized)
    || normalized.startsWith("::ffff:")) return null;
  const uniqueLocal = /^f[cd]/.test(normalized);
  // IPv6 global unicast or ULA, never unspecified, mapped IPv4, or link-local.
  if (!uniqueLocal && !/^[23]/.test(normalized)) return null;
  return { socket: `[${normalized}]:${port}`, ip: normalized, port, family, rank: uniqueLocal ? 1 : 2 };
}

export function irohLanAdvertisement(endpoint: IrohDiscoveryEndpoint): {
  port: number; txt: Record<string, string>; addresses: Address[];
} | null {
  if (!/^[a-f0-9]{64}$/i.test(endpoint.endpointId)
    || !endpoint.deviceId || Buffer.byteLength(endpoint.deviceId) > 128
    || /[\x00-\x1f\x7f]/.test(endpoint.deviceId)) return null;
  const candidates = [...new Map(endpoint.directAddresses
    .map(localAddress).filter((address): address is Address => address !== null)
    .map((address) => [address.socket, address])).values()]
    .sort((a, b) => a.rank - b.rank || a.socket.localeCompare(b.socket));
  const addresses: Address[] = [];
  for (const candidate of candidates) {
    if (addresses.length >= MAX_ADDRESSES) break;
    const next = [...addresses, candidate].map((address) => address.socket).join(",");
    // DNS-SD TXT's length byte includes the key and '=' as well as the value.
    if (Buffer.byteLength(`addrs=${next}`) <= MAX_TXT_BYTES) addresses.push(candidate);
  }
  if (!addresses.length) return null;
  return {
    port: addresses[0].port,
    txt: {
      v: "1", device_id: endpoint.deviceId,
      endpoint_id: endpoint.endpointId.toLowerCase(),
      addrs: addresses.map((address) => address.socket).join(","),
    },
    addresses,
  };
}

function createBonjour(onError: (error: unknown) => void): DiscoveryBonjour {
  const bonjour = new Bonjour({}, onError);
  const internal = bonjour as unknown as { server: { mdns: { on(event: string, fn: (error: unknown) => void): void } } };
  internal.server.mdns.on("error", onError);
  return bonjour as unknown as DiscoveryBonjour;
}

/** Public route hints for the account's QUIC endpoint; these never authorize a peer. */
export class IrohDiscoveryAdvertiser implements IrohDiscoveryPublisher {
  #deps: IrohDiscoveryDeps;
  #bonjour: DiscoveryBonjour | null = null;
  #key: string | null = null;
  #generation = 0;
  #timer: ReturnType<typeof setTimeout> | null = null;
  #host = `fastvibe-iroh-${randomUUID()}.local`;

  constructor(deps: IrohDiscoveryDeps) { this.#deps = deps; }

  publish(endpoint: IrohDiscoveryEndpoint): void {
    const advertisement = irohLanAdvertisement(endpoint);
    if (!advertisement) { this.stop(); return; }
    const name = mdnsInstanceName(endpoint.name || hostname());
    const key = JSON.stringify([name, advertisement.port, advertisement.txt]);
    if (this.#key === key && this.#bonjour) return;
    this.stop();
    this.#key = key;
    this.#publish(name, advertisement, this.#generation, 1);
  }

  #publish(baseName: string, advertisement: NonNullable<ReturnType<typeof irohLanAdvertisement>>, generation: number, attempt: number): void {
    let bonjour: DiscoveryBonjour | null = null;
    let creationError: unknown;
    const current = () => generation === this.#generation && bonjour !== null && this.#bonjour === bonjour;
    const onError = (error: unknown) => {
      if (!bonjour) { creationError = error; return; }
      if (!current()) return;
      this.#deps.log.warn(`iroh discovery: ${String(error)}`);
      this.stop();
    };
    try {
      bonjour = (this.#deps.create ?? createBonjour)(onError);
      this.#bonjour = bonjour;
      if (creationError !== undefined) { onError(creationError); return; }
      const name = discoveryNameWithSuffix(baseName, attempt === 1 ? "" : ` (${attempt})`);
      // SRV has one port. Different IPv6 socket ports remain available in TXT,
      // but must not produce an A/AAAA + SRV combination pointing at a wrong socket.
      const serviceAddresses = advertisement.addresses.filter((address) => address.port === advertisement.port);
      const service = bonjour.publish({
        name, host: this.#host, type: IROH_DISCOVERY_SERVICE, protocol: "udp",
        port: advertisement.port, txt: advertisement.txt,
        disableIPv6: serviceAddresses.every((address) => address.family === 4),
      });
      const records = service.records.bind(service);
      const ips = new Set(serviceAddresses.map((address) => address.ip));
      service.records = () => records().filter((record) => {
        if (record.type !== "A" && record.type !== "AAAA") return true;
        return typeof record.data === "string" && isIP(record.data) !== 0 && ips.has(canonicalIp(record.data));
      });
      const confirmed = () => {
        if (!current()) return;
        this.#clearTimer();
        this.#deps.log.info(`iroh discovery: announcing "${name}" on UDP port ${advertisement.port}`);
      };
      service.on("up", confirmed);
      service.on("error", onError);
      if (service.published) { confirmed(); return; }
      this.#timer = setTimeout(() => {
        if (!current()) return;
        const conflict = !service.activated;
        this.#close();
        if (conflict && attempt < MAX_NAME_ATTEMPTS) {
          this.#publish(baseName, advertisement, generation, attempt + 1);
        } else {
          this.#key = null;
          this.#deps.log.warn("iroh discovery: announcement probe failed");
        }
      }, PROBE_TIMEOUT_MS);
      this.#timer.unref();
    } catch (error) {
      if (generation !== this.#generation) return;
      this.#deps.log.warn(`iroh discovery: could not announce (${String(error)})`);
      this.stop();
    }
  }

  stop(): void {
    this.#generation++;
    this.#key = null;
    this.#close();
  }

  #close(): void {
    this.#clearTimer();
    const bonjour = this.#bonjour;
    this.#bonjour = null;
    if (!bonjour) return;
    const destroy = () => { try { bonjour.destroy(); } catch { /* Already closed. */ } };
    try { bonjour.unpublishAll(destroy); } catch { destroy(); }
  }

  #clearTimer(): void {
    if (this.#timer) clearTimeout(this.#timer);
    this.#timer = null;
  }
}
