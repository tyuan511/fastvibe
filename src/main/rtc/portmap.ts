import { createSocket } from "node:dgram";
import { request } from "node:http";
import { isIPv4 } from "node:net";
import { networkInterfaces } from "node:os";
import { isPublicV4 } from "./netpath.ts";

/**
 * Asks the router to forward one UDP port to a call's socket, for as long as the call lasts.
 *
 * A home router lets a packet in only from an address this computer has already sent to,
 * and a phone behind a carrier's NAT sends from a port nobody can know in advance — so the
 * two never meet and the call falls back to the relay. A forwarded port takes a packet from
 * anywhere, which is the one thing that pairing needs. What arrives on it is still only
 * answered when it carries the call's own ICE credentials, and the mapping is taken down
 * with the call.
 *
 * Two protocols, because routers split between them: NAT-PMP (RFC 6886, one small datagram
 * to the gateway) and UPnP's Internet Gateway Device (found by multicast, driven by SOAP).
 * Nothing here is required to work — a router that offers neither, refuses, or sits behind
 * the provider's own NAT simply yields no mapping, and the call goes on as before.
 */

export type PortMapping = {
  protocol: "nat-pmp" | "upnp";
  externalAddress: string;
  externalPort: number;
  /** Take the mapping down. Safe to call twice; never throws. */
  release: () => Promise<void>;
};

type Gateway =
  | { kind: "nat-pmp"; address: string; externalAddress: string }
  | { kind: "upnp"; control: URL; service: string; externalAddress: string };

export type PortMapperOptions = {
  log?: { info(message: string): void; warn(message: string): void };
  /** How long the router is asked to keep a mapping; renewed at half of it while the call lives. */
  leaseSeconds?: number;
  timeoutMs?: number;
  /** Where the search for a UPnP gateway is sent. The multicast group, except in tests. */
  ssdp?: { address: string; port: number };
  natPmpPort?: number;
  /** The gateways to try NAT-PMP on. Guessed from the interface, except in tests. */
  natPmpGateways?: (localAddress: string) => string[];
};

const SSDP = { address: "239.255.255.250", port: 1900 };
const NAT_PMP_PORT = 5351;
const DEFAULT_LEASE_S = 1800;
const DEFAULT_TIMEOUT_MS = 1500;
const MAX_DESCRIPTION_BYTES = 512 * 1024;
/** A gateway that was not there is looked for again after this long; one that was is kept. */
const ABSENT_RECHECK_MS = 10 * 60_000;
const SEARCH_TARGETS = [
  "urn:schemas-upnp-org:device:InternetGatewayDevice:1",
  "urn:schemas-upnp-org:device:InternetGatewayDevice:2",
  "urn:schemas-upnp-org:service:WANIPConnection:1",
  "urn:schemas-upnp-org:service:WANPPPConnection:1",
];
const WAN_SERVICE = /^urn:schemas-upnp-org:service:WAN(?:IP|PPP)Connection:[12]$/;
/** UPnP's «the port is taken» and «only permanent mappings», the two refusals that change what is tried next. */
const UPNP_CONFLICT = 718;
const UPNP_PERMANENT_ONLY = 725;

function ipv4Number(address: string): number {
  return address.split(".").reduce((sum, part) => sum * 256 + Number(part), 0);
}

function ipv4Text(value: number): string {
  return [value >>> 24, (value >>> 16) & 255, (value >>> 8) & 255, value & 255].join(".");
}

/**
 * Where the gateway probably is: the first address of the interface's network. Node has no
 * view of the routing table, and a wrong guess costs one datagram nobody answers.
 */
export function guessGateways(localAddress: string): string[] {
  for (const entries of Object.values(networkInterfaces())) {
    for (const entry of entries ?? []) {
      if (entry.family !== "IPv4" || entry.address !== localAddress || !isIPv4(entry.netmask)) continue;
      const network = (ipv4Number(entry.address) & ipv4Number(entry.netmask)) >>> 0;
      const first = ipv4Text((network + 1) >>> 0);
      return first === localAddress ? [] : [first];
    }
  }
  return [];
}

/* ------------------------------------------------------------ NAT-PMP */

function natPmpAsk(gateway: string, port: number, payload: Buffer, localAddress: string, timeoutMs: number): Promise<Buffer | null> {
  return new Promise((resolve) => {
    const socket = createSocket("udp4");
    const timers: NodeJS.Timeout[] = [];
    let done = false;
    const finish = (value: Buffer | null): void => {
      if (done) return;
      done = true;
      for (const timer of timers) clearTimeout(timer);
      socket.removeAllListeners();
      socket.on("error", () => undefined);
      try {
        socket.close();
      } catch {
        // never opened
      }
      resolve(value);
    };
    socket.on("error", () => finish(null));
    socket.on("message", (packet, from) => {
      // Only the gateway that was asked may answer; anything else on the network is noise.
      if (from.address === gateway && from.port === port) finish(packet);
    });
    socket.bind(0, localAddress, () => {
      const send = (): void => {
        if (!done) socket.send(payload, port, gateway, () => undefined);
      };
      send();
      timers.push(setTimeout(send, 250), setTimeout(send, 750), setTimeout(() => finish(null), timeoutMs));
    });
  });
}

async function natPmpExternal(gateway: string, port: number, localAddress: string, timeoutMs: number): Promise<string | null> {
  const reply = await natPmpAsk(gateway, port, Buffer.from([0, 0]), localAddress, timeoutMs);
  if (!reply || reply.length < 12 || reply[0] !== 0 || reply[1] !== 128 || reply.readUInt16BE(2) !== 0) return null;
  return [...reply.subarray(8, 12)].join(".");
}

/** Map (or, with a zero lifetime, unmap) `internal`. Returns the external port the gateway chose. */
async function natPmpMap(gateway: string, port: number, localAddress: string, internal: number, lifetime: number, timeoutMs: number): Promise<number | null> {
  const payload = Buffer.alloc(12);
  payload[1] = 1; // UDP
  payload.writeUInt16BE(internal, 4);
  payload.writeUInt16BE(lifetime === 0 ? 0 : internal, 6);
  payload.writeUInt32BE(lifetime, 8);
  const reply = await natPmpAsk(gateway, port, payload, localAddress, timeoutMs);
  if (!reply || reply.length < 16 || reply[0] !== 0 || reply[1] !== 129 || reply.readUInt16BE(2) !== 0) return null;
  if (reply.readUInt16BE(8) !== internal) return null;
  return reply.readUInt16BE(10);
}

/* ------------------------------------------------------------ UPnP */

/** Search for gateways. Each answer's description address must be the machine that answered. */
function ssdpSearch(localAddress: string, target: { address: string; port: number }, timeoutMs: number): Promise<URL[]> {
  return new Promise((resolve) => {
    const socket = createSocket("udp4");
    const found = new Map<string, URL>();
    const timers: NodeJS.Timeout[] = [];
    let done = false;
    const finish = (): void => {
      if (done) return;
      done = true;
      for (const timer of timers) clearTimeout(timer);
      socket.removeAllListeners();
      socket.on("error", () => undefined);
      try {
        socket.close();
      } catch {
        // never opened
      }
      resolve([...found.values()]);
    };
    socket.on("error", finish);
    socket.on("message", (packet, from) => {
      const location = /^location:\s*(\S+)/im.exec(packet.toString("latin1"))?.[1];
      if (!location) return;
      let url: URL;
      try {
        url = new URL(location);
      } catch {
        return;
      }
      // A description hosted somewhere else is another device speaking for the router.
      if (url.protocol !== "http:" || url.hostname !== from.address) return;
      if (found.size === 0) timers.push(setTimeout(finish, 250));
      found.set(url.href, url);
    });
    socket.bind(0, localAddress, () => {
      try {
        socket.setMulticastInterface(localAddress);
      } catch {
        // not a multicast-capable address (a test's loopback); the send below still goes out
      }
      for (const st of SEARCH_TARGETS) {
        const message = `M-SEARCH * HTTP/1.1\r\nHOST: ${SSDP.address}:${SSDP.port}\r\nMAN: "ssdp:discover"\r\nMX: 1\r\nST: ${st}\r\n\r\n`;
        socket.send(message, target.port, target.address, () => undefined);
      }
      timers.push(setTimeout(finish, timeoutMs));
    });
  });
}

function httpExchange(
  url: URL,
  localAddress: string,
  timeoutMs: number,
  post?: { headers: Record<string, string>; body: string },
): Promise<{ status: number; body: string } | null> {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (value: { status: number; body: string } | null): void => {
      if (settled) return;
      settled = true;
      resolve(value);
    };
    // node:http directly, so no proxy the app is configured with stands between this
    // computer and its own router, and the request leaves by the interface the call uses.
    const call = request(url, {
      method: post ? "POST" : "GET",
      localAddress,
      timeout: timeoutMs,
      headers: post ? { ...post.headers, "Content-Length": String(Buffer.byteLength(post.body)), Connection: "close" } : { Connection: "close" },
    }, (response) => {
      const chunks: Buffer[] = [];
      let size = 0;
      response.on("data", (chunk: Buffer) => {
        size += chunk.length;
        if (size > MAX_DESCRIPTION_BYTES) {
          call.destroy();
          finish(null);
          return;
        }
        chunks.push(chunk);
      });
      response.on("end", () => finish({ status: response.statusCode ?? 0, body: Buffer.concat(chunks).toString("utf8") }));
      response.on("error", () => finish(null));
    });
    call.on("timeout", () => call.destroy());
    call.on("error", () => finish(null));
    call.end(post?.body);
  });
}

/** The WAN connection services a gateway's description lists, with where each is controlled. */
export function wanServices(description: string, location: URL): Array<{ service: string; control: URL }> {
  const base = /<URLBase>\s*([^<\s]+)\s*<\/URLBase>/i.exec(description)?.[1];
  const out: Array<{ service: string; control: URL }> = [];
  for (const block of description.matchAll(/<service>([\s\S]*?)<\/service>/gi)) {
    const service = /<serviceType>\s*([^<]+?)\s*<\/serviceType>/i.exec(block[1])?.[1];
    const path = /<controlURL>\s*([^<]+?)\s*<\/controlURL>/i.exec(block[1])?.[1];
    if (!service || !path || !WAN_SERVICE.test(service)) continue;
    let control: URL;
    try {
      control = new URL(path, base ?? location);
    } catch {
      continue;
    }
    // The description came from the router; its control address has to be the router too.
    if (control.protocol !== "http:" || control.hostname !== location.hostname) continue;
    out.push({ service, control });
  }
  return out;
}

function escapeXml(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

async function soap(
  control: URL,
  service: string,
  action: string,
  args: Array<[string, string | number]>,
  localAddress: string,
  timeoutMs: number,
): Promise<{ ok: boolean; body: string; error: number | null } | null> {
  const fields = args.map(([name, value]) => `<${name}>${escapeXml(String(value))}</${name}>`).join("");
  const body = `<?xml version="1.0"?>\r\n<s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/" s:encodingStyle="http://schemas.xmlsoap.org/soap/encoding/"><s:Body><u:${action} xmlns:u="${service}">${fields}</u:${action}></s:Body></s:Envelope>\r\n`;
  const reply = await httpExchange(control, localAddress, timeoutMs, {
    headers: { "Content-Type": 'text/xml; charset="utf-8"', SOAPAction: `"${service}#${action}"` },
    body,
  });
  if (!reply) return null;
  const code = /<errorCode>\s*(\d+)\s*<\/errorCode>/i.exec(reply.body)?.[1];
  return { ok: reply.status === 200, body: reply.body, error: code ? Number(code) : null };
}

async function upnpGateway(localAddress: string, ssdp: { address: string; port: number }, timeoutMs: number): Promise<Gateway | null> {
  for (const location of await ssdpSearch(localAddress, ssdp, timeoutMs)) {
    const description = await httpExchange(location, localAddress, timeoutMs);
    if (!description || description.status !== 200) continue;
    // A router can list both an IP and a PPP connection; the live one is the one with an address.
    for (const { service, control } of wanServices(description.body, location)) {
      const reply = await soap(control, service, "GetExternalIPAddress", [], localAddress, timeoutMs);
      const address = reply?.ok ? /<NewExternalIPAddress>\s*([^<\s]*)\s*<\/NewExternalIPAddress>/i.exec(reply.body)?.[1] : undefined;
      if (address && isIPv4(address)) return { kind: "upnp", control, service, externalAddress: address };
    }
  }
  return null;
}

/* ------------------------------------------------------------ the mapper */

export class PortMapper {
  #options: PortMapperOptions;
  #gateways = new Map<string, { found: Promise<Gateway | null>; at: number; gateway?: Gateway | null }>();
  #live = new Set<() => Promise<void>>();

  constructor(options: PortMapperOptions = {}) {
    this.#options = options;
  }

  /** Look for a gateway from this address ahead of a call; the answer is kept. */
  warm(localAddress: string): void {
    void this.#gateway(localAddress);
  }

  /**
   * A free local UDP port for a call that will ask for a mapping, or null when no gateway
   * is known for this address — a call does not wait on the search, it goes without.
   */
  async reserve(localAddress: string): Promise<number | null> {
    const known = this.#gateways.get(localAddress);
    if (!known?.gateway) {
      this.warm(localAddress);
      return null;
    }
    return new Promise((resolve) => {
      const socket = createSocket("udp4");
      socket.once("error", () => resolve(null));
      socket.bind(0, localAddress, () => {
        const { port } = socket.address();
        socket.close(() => resolve(port));
      });
    });
  }

  /** The network changed: what was learned about its gateway is no longer true. */
  forget(): void {
    this.#gateways.clear();
  }

  /**
   * Forward a public UDP port to `localAddress:port`. Null when there is no gateway to ask,
   * it refused, or the address it reports is not the open internet's (a router behind the
   * provider's own NAT, where a forwarded port leads nowhere).
   */
  async map(localAddress: string, port: number): Promise<PortMapping | null> {
    const gateway = await this.#gateway(localAddress);
    if (!gateway) return null;
    const timeoutMs = this.#options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    const lease = this.#options.leaseSeconds ?? DEFAULT_LEASE_S;
    const externalPort = gateway.kind === "nat-pmp"
      ? await natPmpMap(gateway.address, this.#options.natPmpPort ?? NAT_PMP_PORT, localAddress, port, lease, timeoutMs)
      : await this.#upnpAdd(gateway, localAddress, port, lease, timeoutMs);
    if (!externalPort) return null;

    const again = async (): Promise<void> => {
      if (gateway.kind === "nat-pmp") {
        await natPmpMap(gateway.address, this.#options.natPmpPort ?? NAT_PMP_PORT, localAddress, port, lease, timeoutMs);
      } else {
        await soap(gateway.control, gateway.service, "AddPortMapping", upnpArgs(externalPort, port, localAddress, lease), localAddress, timeoutMs);
      }
    };
    const renewal = setInterval(() => void again().catch(() => undefined), (lease * 1000) / 2);
    renewal.unref();
    let released = false;
    const release = async (): Promise<void> => {
      if (released) return;
      released = true;
      clearInterval(renewal);
      this.#live.delete(release);
      try {
        if (gateway.kind === "nat-pmp") {
          await natPmpMap(gateway.address, this.#options.natPmpPort ?? NAT_PMP_PORT, localAddress, port, 0, timeoutMs);
        } else {
          await soap(gateway.control, gateway.service, "DeletePortMapping", [["NewRemoteHost", ""], ["NewExternalPort", externalPort], ["NewProtocol", "UDP"]], localAddress, timeoutMs);
        }
      } catch {
        // the lease runs out by itself
      }
    };
    this.#live.add(release);
    return { protocol: gateway.kind, externalAddress: gateway.externalAddress, externalPort, release };
  }

  /** Take every mapping down, as the app quits. */
  async close(): Promise<void> {
    await Promise.all([...this.#live].map((release) => release()));
  }

  async #upnpAdd(gateway: Extract<Gateway, { kind: "upnp" }>, localAddress: string, port: number, lease: number, timeoutMs: number): Promise<number | null> {
    // The same number outside as inside first: it is what the router gives the socket's
    // ordinary traffic when it can, so one candidate then covers both.
    for (const external of [port, port + 1, port + 2]) {
      if (external > 65_535) break;
      const reply = await soap(gateway.control, gateway.service, "AddPortMapping", upnpArgs(external, port, localAddress, lease), localAddress, timeoutMs);
      if (reply?.ok) return external;
      if (reply?.error === UPNP_CONFLICT) continue;
      // A router that only makes permanent mappings is left alone: one that outlived a
      // crash would stay open on it until somebody found it in the router's settings.
      if (reply?.error === UPNP_PERMANENT_ONLY) this.#options.log?.info("portmap: the router only makes permanent mappings; not asking for one");
      return null;
    }
    return null;
  }

  #gateway(localAddress: string): Promise<Gateway | null> {
    const known = this.#gateways.get(localAddress);
    if (known && (known.gateway !== null || Date.now() - known.at < ABSENT_RECHECK_MS)) return known.found;
    const entry: { found: Promise<Gateway | null>; at: number; gateway?: Gateway | null } = { found: this.#discover(localAddress), at: Date.now() };
    void entry.found.then((gateway) => {
      entry.gateway = gateway;
      entry.at = Date.now();
    });
    this.#gateways.set(localAddress, entry);
    return entry.found;
  }

  async #discover(localAddress: string): Promise<Gateway | null> {
    const timeoutMs = this.#options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    const natPmpPort = this.#options.natPmpPort ?? NAT_PMP_PORT;
    const guesses = (this.#options.natPmpGateways ?? guessGateways)(localAddress);
    const natPmp = (async (): Promise<Gateway | null> => {
      for (const address of guesses) {
        const externalAddress = await natPmpExternal(address, natPmpPort, localAddress, timeoutMs);
        if (externalAddress) return { kind: "nat-pmp", address, externalAddress };
      }
      return null;
    })();
    const upnp = upnpGateway(localAddress, this.#options.ssdp ?? SSDP, timeoutMs);
    // Whichever protocol the router speaks; when it speaks both, the one that answered first.
    const found = await new Promise<Gateway | null>((resolve) => {
      let pending = 2;
      for (const attempt of [natPmp, upnp]) {
        attempt.catch(() => null).then((gateway) => {
          pending -= 1;
          if (gateway) resolve(gateway);
          else if (pending === 0) resolve(null);
        });
      }
    });
    if (!found) return null;
    if (!isPublicV4(found.externalAddress)) {
      this.#options.log?.info(`portmap: the router answers ${found.kind} but is itself behind another NAT; a forwarded port would lead nowhere`);
      return null;
    }
    this.#options.log?.info(`portmap: the router answers ${found.kind}`);
    return found;
  }
}

function upnpArgs(external: number, internal: number, client: string, lease: number): Array<[string, string | number]> {
  return [
    ["NewRemoteHost", ""],
    ["NewExternalPort", external],
    ["NewProtocol", "UDP"],
    ["NewInternalPort", internal],
    ["NewInternalClient", client],
    ["NewEnabled", 1],
    ["NewPortMappingDescription", "FastVibe"],
    ["NewLeaseDuration", lease],
  ];
}
