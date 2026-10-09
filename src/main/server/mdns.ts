import { hostname } from "node:os";
import { randomUUID } from "node:crypto";
import { Bonjour, type Service } from "bonjour-service";
import { discoveryNameSetting, discoveryNameWithSuffix } from "../../shared/discovery-name.ts";
import type { RemoteLanAddressFamily } from "../../shared/ipc.ts";

/**
 * Announce the remote server on the local network (mDNS / Bonjour), so the phone's 添加设备
 * page can list this machine instead of asking for an IP address that DHCP will change.
 *
 * The service is `_fastvibe._tcp` and its instance name defaults to the machine's host name — that
 * is the name the phone shows and saves the connection under. Nothing secret travels: the
 * password is still what lets a device in, and the record only says «something on this
 * port speaks FastVibe».
 */

export const MDNS_SERVICE_TYPE = "fastvibe";

/** What a phone needs to find out from the record before it asks for a password. */
export const MDNS_TXT = { v: "1" } as const;

/**
 * The name this machine is announced as.
 *
 * `os.hostname()` on macOS is `Yuans-MacBook-Pro.local`; the `.local` is the mDNS domain,
 * not part of the name a person would call the machine, and showing it on every row
 * would be noise. A blank host name falls back to a fixed label rather than publishing
 * an empty instance, which Bonjour rejects.
 */
export function mdnsInstanceName(host: string = hostname()): string {
  const name = host.trim().replace(/\.local\.?$/i, "").replace(/[.\\\x00-\x1f\x7f]/g, "-");
  return discoveryNameWithSuffix(name || "FastVibe");
}

type PublishedService = {
  activated: boolean;
  published: boolean;
  records: Service["records"];
  on(event: string, listener: (...args: unknown[]) => void): unknown;
};

type PublishConfig = { name: string; host: string; type: string; port: number; txt: Record<string, string>; disableIPv6: boolean };

// Three probes take at most one second after the socket binds. A bounded watchdog also
// catches bonjour-service's silent conflict path: it stops the service without an event.
const PROBE_TIMEOUT_MS = 2_000;
const MAX_NAME_ATTEMPTS = 5;

/** The slice of `bonjour-service` used here, so a test does not need a multicast socket. */
export interface BonjourLike {
  publish(config: PublishConfig): PublishedService;
  unpublishAll(callback?: () => void): void;
  destroy(callback?: () => void): void;
}

export type MdnsLog = { info(message: string): void; warn(message: string): void };

export type MdnsAdvertiserDeps = {
  log: MdnsLog;
  /** Only a test replaces these. */
  create?: (onError: (error: unknown) => void) => BonjourLike;
  hostName?: () => string;
};

function createBonjour(onError: (error: unknown) => void): BonjourLike {
  const bonjour = new Bonjour({}, onError);
  // bonjour-service 1.4.x only passes its error callback to query responses. Bind errors
  // belong to the underlying multicast emitter, NOT to the published service.
  const { server } = bonjour as unknown as { server: { mdns: Pick<PublishedService, "on"> } };
  server.mdns.on("error", onError);
  return bonjour;
}

export class MdnsAdvertiser {
  #deps: MdnsAdvertiserDeps;
  #bonjour: BonjourLike | null = null;
  #port: number | null = null;
  #name: string | null = null;
  #requestedPort: number | null = null;
  #requestedName: string | null = null;
  #requestedFamily: RemoteLanAddressFamily | null = null;
  #probeTimer: ReturnType<typeof setTimeout> | null = null;
  // Never claim os.hostname()'s A/AAAA records: macOS already owns those and advertises
  // different addresses on each interface. Publishing all interfaces under that same
  // name makes mDNSResponder rename the computer. This target belongs only to FastVibe;
  // the human-facing service name still comes from the computer's name.
  #host = `fastvibe-${randomUUID()}.local`;

  constructor(deps: MdnsAdvertiserDeps) {
    this.#deps = deps;
  }

  /** The port currently announced, or null when nothing is. */
  get port(): number | null {
    return this.#port;
  }

  /** The confirmed instance name, including a suffix if the original was occupied. */
  get name(): string | null {
    return this.#name;
  }

  /**
   * Announce `port`. The same port/name/family is a no-op; changing any replaces the record.
   * Never throws — a network where multicast is filtered must not
   * stop remote access from starting, so a failure is logged and the machine is simply
   * not discoverable (the address and the QR code still work).
   */
  publish(port: number, name?: string, family: RemoteLanAddressFamily = "ipv4"): void {
    const baseName = discoveryNameSetting(name) || mdnsInstanceName(this.#deps.hostName?.());
    if (this.#requestedPort === port && this.#requestedName === baseName && this.#requestedFamily === family && this.#bonjour) return;
    this.#close();
    this.#publish(port, baseName, family, 1);
  }

  #publish(port: number, baseName: string, family: RemoteLanAddressFamily, attempt: number): void {
    try {
      const bonjour = (this.#deps.create ?? createBonjour)((error) => {
        if (this.#bonjour !== bonjour) return;
        this.#deps.log.warn(`mDNS: ${String(error)}`);
        this.#close();
      });
      // Retain the socket before publishing, so a synchronous failure closes it too.
      this.#bonjour = bonjour;
      this.#requestedPort = port;
      this.#requestedName = baseName;
      this.#requestedFamily = family;
      const name = discoveryNameWithSuffix(baseName, attempt === 1 ? "" : ` (${attempt})`);
      // Android's nsd plugin hands Dart only NsdServiceInfo.host, not the whole address
      // set. An AAAA record can win even for an IPv4-only listener, then be filtered
      // out as link-local on the phone. The service was found but the list stays empty.
      const service = bonjour.publish({
        name, host: this.#host, type: MDNS_SERVICE_TYPE, port, txt: { ...MDNS_TXT },
        disableIPv6: family === "ipv4",
      });
      if (family === "ipv6") {
        // The library has disableIPv6 but no disableIPv4. Probing is asynchronous, so
        // install the record filter before the first announcement. Its registry uses
        // these same records for query replies, re-announcements and goodbye packets.
        const records = service.records.bind(service);
        service.records = () => records().filter((record) => record.type !== "A");
      }
      const confirmed = () => {
        if (this.#bonjour !== bonjour) return;
        this.#clearProbeTimer();
        this.#port = port;
        this.#name = name;
        this.#deps.log.info(`mDNS: announcing "${name}" on port ${port}`);
      };
      service.on("up", confirmed);
      service.on("error", (error) => {
        if (this.#bonjour !== bonjour) return;
        this.#deps.log.warn(`mDNS: ${String(error)}`);
        this.#close();
      });
      if (service.published) {
        confirmed();
        return;
      }
      this.#probeTimer = setTimeout(() => {
        if (this.#bonjour !== bonjour) return;
        const conflict = !service.activated;
        this.#close();
        if (conflict && attempt < MAX_NAME_ATTEMPTS) {
          this.#deps.log.warn(`mDNS: service name "${name}" is occupied; trying another name`);
          this.#publish(port, baseName, family, attempt + 1);
        } else {
          this.#deps.log.warn(`mDNS: could not announce "${name}" (${conflict ? "service names occupied" : "probe timed out"})`);
        }
      }, PROBE_TIMEOUT_MS);
      this.#probeTimer.unref();
    } catch (error) {
      this.#deps.log.warn(`mDNS: could not announce (${error instanceof Error ? error.message : String(error)})`);
      this.#close();
    }
  }

  /** Withdraw the announcement. Safe to call when nothing is published. */
  unpublish(): void {
    if (!this.#bonjour) return;
    this.#close();
    this.#deps.log.info("mDNS: announcement withdrawn");
  }

  #close(): void {
    const bonjour = this.#bonjour;
    this.#bonjour = null;
    this.#port = null;
    this.#name = null;
    this.#requestedPort = null;
    this.#requestedName = null;
    this.#requestedFamily = null;
    this.#clearProbeTimer();
    if (!bonjour) return;
    const destroy = () => {
      try {
        bonjour.destroy();
      } catch {
        // Already gone, or the socket never bound. The goodbye callback can be async.
      }
    };
    try {
      // `unpublishAll` sends the goodbye packets, so phones drop the row at once rather
      // than waiting out the record's TTL; `destroy` then closes the socket.
      bonjour.unpublishAll(destroy);
    } catch {
      destroy();
    }
  }

  #clearProbeTimer(): void {
    if (this.#probeTimer) clearTimeout(this.#probeTimer);
    this.#probeTimer = null;
  }
}
