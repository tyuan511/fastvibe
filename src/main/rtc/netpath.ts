import { createSocket } from "node:dgram";
import { getServers, promises as dns } from "node:dns";
import { isIPv4 } from "node:net";
import { networkInterfaces } from "node:os";
import type { IceServerConfig } from "./ice.ts";
import { bindingRequest, mappedAddress, type MappedAddress } from "./stun.ts";

/**
 * How this computer reaches the internet right now, asked before a phone calls.
 *
 * A call's socket is the WebRTC library's own, and the library gives it one STUN server
 * and whatever route the system hands out. Three things about that route decide whether a
 * phone on another network gets a direct path, and none of them can be learned from
 * inside a call:
 *
 * - **A tunnel may own the default route.** A proxy or VPN running as a network interface
 *   carries the STUN request away with everything else, so the "public address" the call
 *   then offers is the tunnel's far end — an address that is not this computer's router,
 *   and usually a continent from the phone. Binding the socket to the real interface's
 *   address keeps it off the tunnel; whether that works is the system's business, so it is
 *   tried rather than assumed: a bound socket that gets an answer naming a *different*
 *   public address is one that got past.
 * - **Which server answers.** The library picks one from the list at random and has no
 *   second try, so a call is handed the one that answered here.
 * - **What the router does with a second destination.** One that keeps the public port
 *   needs nothing more. One that hands out the next port along can be met by telling the
 *   phone the ports to expect (`predictedCandidates`); one that picks at random cannot.
 *
 * Electron-free, and everything that touches the network is a dependency, so the decision
 * is tested without one.
 */

export type NatMapping = "independent" | "sequential" | "random" | "unknown";

export type PathPlan = {
  /** The one STUN server a call gathers with, or null when the service listed none. */
  stun: IceServerConfig | null;
  /** Bind the call's socket to this local address: a tunnel owns the default route and this gets past it. */
  bindAddress: string | null;
  /** The local address the call's socket sends from, when that is a real interface. A port mapping forwards here. */
  localAddress: string | null;
  /** The public IPv4 address STUN reported on that path. */
  publicAddress: string | null;
  mapping: NatMapping;
  /** The default route leaves by something that is not a real interface. */
  tunnel: boolean;
  /** A global IPv6 address that the default IPv6 route actually uses. */
  nativeV6: boolean;
};

export type InterfaceAddress = { name: string; address: string; family: "IPv4" | "IPv6"; internal: boolean };

export type PathDeps = {
  interfaces: () => InterfaceAddress[];
  /** The system resolver's IPv4 answer, which behind some proxies is a made-up address. */
  lookup: (hostname: string) => Promise<string | null>;
  /** The same question asked from `localAddress`, so the answer is one that address can reach. */
  resolveFrom: (hostname: string, localAddress: string) => Promise<string | null>;
  /** The local address the system would send from to reach `address`. Sends nothing. */
  routeLocal: (address: string, family: 4 | 6) => Promise<string | null>;
  /** One socket (bound to `bind`, or to nothing), a STUN request to each target in order. */
  query: (targets: Array<{ address: string; port: number }>, bind: string | null) => Promise<Array<MappedAddress | null>>;
};

/** Enough destinations to tell the mappings apart; each one is a packet and a wait. */
const MAX_TARGETS = 3;
/** A machine with more real interfaces than this is tried on the first few. */
const MAX_BOUND_PROBES = 3;
/** How far apart two allocations may land and still be called "the next port along". */
const SEQUENTIAL_MAX_STEP = 64;
const RESOLVE_TIMEOUT_MS = 1500;
const QUERY_TIMEOUT_MS = 1200;
const QUERY_RETRY_MS = 400;
/** A global address to ask the routing table about. Nothing is sent to it. */
const ROUTE_PROBE_V6 = "2606:4700:4700::1111";
/** Asked from the real interface when the system resolver only hands out made-up addresses. */
const PUBLIC_RESOLVERS = ["223.5.5.5", "1.1.1.1", "119.29.29.29", "8.8.8.8"];
/**
 * Interfaces that are never the way out: tunnels, bridges to virtual machines and
 * containers, and Apple's peer-to-peer radios. A name that slips through costs one probe
 * that gets no answer.
 */
const VIRTUAL_INTERFACE = /^(lo|utun|tun|tap|ipsec|ppp|wg|tailscale|zt|docker|br-|veth|virbr|vmnet|vboxnet|bridge|awdl|llw|anpi|gif|stf)/i;

function ipv4Number(address: string): number | null {
  if (!isIPv4(address)) return null;
  return address.split(".").reduce((sum, part) => sum * 256 + Number(part), 0);
}

function within(address: string, base: string, bits: number): boolean {
  const value = ipv4Number(address);
  const start = ipv4Number(base);
  if (value === null || start === null) return false;
  const size = 2 ** (32 - bits);
  return value >= start && value < start + size;
}

/** 198.18.0.0/15: reserved for benchmarking, and what a fake-IP resolver answers with. */
export function isFakeIp(address: string): boolean {
  return within(address, "198.18.0.0", 15);
}

/** An IPv4 address the open internet can route to. */
export function isPublicV4(address: string): boolean {
  if (ipv4Number(address) === null) return false;
  const reserved: Array<[string, number]> = [
    ["0.0.0.0", 8], ["10.0.0.0", 8], ["100.64.0.0", 10], ["127.0.0.0", 8], ["169.254.0.0", 16],
    ["172.16.0.0", 12], ["192.0.0.0", 24], ["192.168.0.0", 16], ["198.18.0.0", 15], ["224.0.0.0", 3],
  ];
  return !reserved.some(([base, bits]) => within(address, base, bits));
}

/** 2000::/3, the global unicast block. */
export function isGlobalV6(address: string): boolean {
  const first = Number.parseInt(address.split(":")[0] || "0", 16);
  return Number.isFinite(first) && (first & 0xe000) === 0x2000;
}

/** `183.156.x.x` — enough to tell two paths apart in a log without writing the address down. */
export function maskAddress(address: string | null): string {
  if (!address) return "none";
  const parts = address.split(".");
  if (parts.length === 4) return `${parts[0]}.${parts[1]}.x.x`;
  return `${address.split(":").slice(0, 2).join(":")}:…`;
}

/** The IPv4 addresses a call could be bound to, likeliest way out first. */
export function physicalAddresses(interfaces: InterfaceAddress[]): string[] {
  const wired = (name: string): number => (/^(en|eth|wl|wi-?fi|ethernet|以太网|无线)/i.test(name) ? 0 : 1);
  return interfaces
    .filter((entry) => entry.family === "IPv4" && !entry.internal && !VIRTUAL_INTERFACE.test(entry.name))
    .filter((entry) => !isFakeIp(entry.address) && !within(entry.address, "169.254.0.0", 16))
    .map((entry, index) => ({ entry, index }))
    .sort((a, b) => wired(a.entry.name) - wired(b.entry.name) || a.index - b.index)
    .map(({ entry }) => entry.address);
}

/** Changes when an interface comes, goes or is renumbered — which is when a plan stops being true. */
export function networkSignature(interfaces: InterfaceAddress[]): string {
  return interfaces
    .filter((entry) => !entry.internal && !entry.address.toLowerCase().startsWith("fe80:"))
    .map((entry) => `${entry.name}/${entry.address}`)
    .sort()
    .join(",");
}

/**
 * What a NAT did with one socket's requests to several destinations, in the order sent.
 * An unanswered one still took its port, so the gaps between the answers are what is read.
 */
export function classifyMapping(answers: Array<MappedAddress | null>): NatMapping {
  const got = answers.filter((answer): answer is MappedAddress => answer !== null);
  if (got.length < 2) return "unknown";
  if (got.some((answer) => answer.address !== got[0].address)) return "random";
  if (got.every((answer) => answer.port === got[0].port)) return "independent";
  for (let i = 1; i < got.length; i += 1) {
    const step = got[i].port - got[i - 1].port;
    if (step < 1 || step > SEQUENTIAL_MAX_STEP) return "random";
  }
  return "sequential";
}

/** The servers to ask, the standard port first: a network that blocks one port usually blocks the odd one. */
export function probeTargets(servers: IceServerConfig[]): Array<{ hostname: string; port: number }> {
  const seen = new Set<string>();
  const out: Array<{ hostname: string; port: number }> = [];
  for (const server of servers) {
    const key = `${server.hostname.toLowerCase()}:${server.port}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ hostname: server.hostname, port: server.port });
  }
  return out
    .map((target, index) => ({ target, index }))
    .sort((a, b) => Number(a.target.port !== 3478) - Number(b.target.port !== 3478) || a.index - b.index)
    .slice(0, MAX_TARGETS)
    .map(({ target }) => target);
}

type Measurement = {
  /** Index into the targets of the first one that answered, or -1. */
  answered: number;
  publicAddress: string | null;
  mapping: NatMapping;
};

async function measure(
  targets: Array<{ hostname: string; port: number }>,
  addresses: Array<string | null>,
  bind: string | null,
  deps: PathDeps,
): Promise<Measurement> {
  // Two names can be one address; asked twice it says nothing about a second destination.
  const seen = new Set<string>();
  const asked: Array<{ index: number; address: string; port: number }> = [];
  targets.forEach((target, index) => {
    const address = addresses[index];
    if (!address || seen.has(`${address}:${target.port}`)) return;
    seen.add(`${address}:${target.port}`);
    asked.push({ index, address, port: target.port });
  });
  if (asked.length === 0) return { answered: -1, publicAddress: null, mapping: "unknown" };
  let answers: Array<MappedAddress | null>;
  try {
    answers = await deps.query(asked.map(({ address, port }) => ({ address, port })), bind);
  } catch {
    answers = asked.map(() => null);
  }
  // An answer that is not a public address came from something other than the internet.
  answers = answers.map((answer) => (answer && isPublicV4(answer.address) ? answer : null));
  const first = answers.findIndex((answer) => answer !== null);
  return {
    answered: first < 0 ? -1 : asked[first].index,
    publicAddress: first < 0 ? null : (answers[first] as MappedAddress).address,
    mapping: classifyMapping(answers),
  };
}

async function hasNativeV6(interfaces: InterfaceAddress[], deps: PathDeps): Promise<boolean> {
  const globals = interfaces
    .filter((entry) => entry.family === "IPv6" && !entry.internal && isGlobalV6(entry.address))
    .map((entry) => entry.address.toLowerCase());
  if (globals.length === 0) return false;
  const local = await deps.routeLocal(ROUTE_PROBE_V6, 6).catch(() => null);
  return local !== null && globals.includes(local.toLowerCase());
}

/** Ask the network how a call should be set up. Never throws; what cannot be learned is `unknown`. */
export async function probePath(servers: IceServerConfig[], deps: PathDeps = nodePathDeps()): Promise<PathPlan> {
  const interfaces = deps.interfaces();
  const targets = probeTargets(servers);
  const nativeV6 = await hasNativeV6(interfaces, deps);
  if (targets.length === 0) {
    return { stun: null, bindAddress: null, localAddress: null, publicAddress: null, mapping: "unknown", tunnel: false, nativeV6 };
  }

  const hostnames = [...new Set(targets.map((target) => target.hostname))];
  const system = new Map<string, string | null>();
  await Promise.all(hostnames.map(async (hostname) => {
    system.set(hostname, await deps.lookup(hostname).catch(() => null));
  }));
  const systemAddresses = targets.map((target) => system.get(target.hostname) ?? null);

  const physical = physicalAddresses(interfaces);
  const reachable = systemAddresses.find((address): address is string => address !== null) ?? null;
  const routeLocal = reachable ? await deps.routeLocal(reachable, 4).catch(() => null) : null;
  const tunnel = routeLocal !== null && !physical.includes(routeLocal);

  const viaDefault = measure(targets, systemAddresses, null, deps);
  const bound = !tunnel ? [] : physical.slice(0, MAX_BOUND_PROBES).map(async (local) => {
    // A made-up address means nothing off the tunnel, so the real one is asked for from
    // the interface the socket will be bound to. An honest answer is used as it is.
    const real = new Map<string, string | null>();
    await Promise.all(hostnames.map(async (hostname) => {
      const known = system.get(hostname) ?? null;
      real.set(hostname, known && !isFakeIp(known) ? known : await deps.resolveFrom(hostname, local).catch(() => null));
    }));
    const addresses = targets.map((target) => real.get(target.hostname) ?? null);
    return { local, addresses, result: await measure(targets, addresses, local, deps) };
  });

  const [open, ...bypasses] = await Promise.all([viaDefault, ...bound]);
  for (const bypass of bypasses) {
    const { result } = bypass;
    if (result.answered < 0 || !result.publicAddress || result.publicAddress === open.publicAddress) continue;
    return {
      stun: { hostname: bypass.addresses[result.answered] as string, port: targets[result.answered].port },
      bindAddress: bypass.local,
      localAddress: bypass.local,
      publicAddress: result.publicAddress,
      mapping: result.mapping,
      tunnel,
      nativeV6,
    };
  }
  // By name: the library resolves it the way the rest of the system does. With no answer
  // at all the first server is still worth handing over — the network may be back by then.
  const chosen = targets[open.answered < 0 ? 0 : open.answered];
  return {
    stun: { hostname: chosen.hostname, port: chosen.port },
    bindAddress: null,
    localAddress: tunnel ? null : routeLocal,
    publicAddress: open.publicAddress,
    mapping: open.mapping,
    tunnel,
    nativeV6,
  };
}

/* ------------------------------------------------------------ the real network */

function withTimeout<T>(work: Promise<T>, ms: number, fallback: T): Promise<T> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(fallback), ms);
    timer.unref();
    work.then((value) => resolve(value), () => resolve(fallback)).finally(() => clearTimeout(timer));
  });
}

async function systemLookup(hostname: string): Promise<string | null> {
  if (isIPv4(hostname)) return hostname;
  return withTimeout(dns.lookup(hostname, { family: 4 }).then((found) => found.address), RESOLVE_TIMEOUT_MS, null);
}

async function resolveFrom(hostname: string, localAddress: string): Promise<string | null> {
  if (isIPv4(hostname)) return hostname;
  // The network's own resolver first: asked from the real interface it is reached
  // directly, whatever the tunnel does to port 53 on the way through.
  const configured = getServers().filter((server) => isIPv4(server) && !isFakeIp(server) && !server.startsWith("127."));
  const servers = [...new Set([...configured, ...PUBLIC_RESOLVERS])];
  const resolvers: dns.Resolver[] = [];
  const asked = servers.map((server) => {
    const resolver = new dns.Resolver({ timeout: RESOLVE_TIMEOUT_MS, tries: 1 });
    resolvers.push(resolver);
    try {
      resolver.setLocalAddress(localAddress);
      resolver.setServers([server]);
    } catch {
      return Promise.reject(new Error("unusable resolver"));
    }
    return resolver.resolve4(hostname).then((found) => {
      const usable = found.find((address) => isPublicV4(address));
      if (!usable) throw new Error("no public address");
      return usable;
    });
  });
  const first = await withTimeout(Promise.any(asked), RESOLVE_TIMEOUT_MS, null);
  for (const resolver of resolvers) resolver.cancel();
  return first;
}

function routeLocal(address: string, family: 4 | 6): Promise<string | null> {
  return new Promise((resolve) => {
    const socket = createSocket(family === 4 ? "udp4" : "udp6");
    const finish = (value: string | null): void => {
      socket.removeAllListeners();
      socket.on("error", () => undefined);
      try {
        socket.close();
      } catch {
        // never opened
      }
      resolve(value);
    };
    socket.once("error", () => finish(null));
    // Connecting a datagram socket only fixes its route; no packet leaves.
    socket.connect(3478, address, () => {
      try {
        finish(socket.address().address);
      } catch {
        finish(null);
      }
    });
  });
}

function query(targets: Array<{ address: string; port: number }>, bind: string | null): Promise<Array<MappedAddress | null>> {
  return new Promise((resolve) => {
    const socket = createSocket("udp4");
    const requests = targets.map(() => bindingRequest());
    const answers: Array<MappedAddress | null> = targets.map(() => null);
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
      resolve(answers);
    };
    const send = (index: number): void => {
      if (done || answers[index]) return;
      const { address, port } = targets[index];
      // An unreachable destination is this target's problem, not the probe's.
      socket.send(requests[index].packet, port, address, () => undefined);
    };
    socket.on("error", finish);
    socket.on("message", (packet) => {
      requests.forEach((request, index) => {
        answers[index] ??= mappedAddress(packet, request.id);
      });
      if (answers.every((answer) => answer !== null)) finish();
    });
    socket.bind(0, bind ?? undefined, () => {
      // In order and a few milliseconds apart: the order is what makes "the next port
      // along" readable, and the gap keeps it.
      targets.forEach((_, index) => {
        timers.push(setTimeout(() => send(index), index * 5));
        // The same destination again reuses its mapping, so a retry costs no port.
        timers.push(setTimeout(() => send(index), QUERY_RETRY_MS + index * 5));
      });
      timers.push(setTimeout(finish, QUERY_TIMEOUT_MS));
    });
  });
}

export function systemInterfaces(): InterfaceAddress[] {
  const out: InterfaceAddress[] = [];
  for (const [name, entries] of Object.entries(networkInterfaces())) {
    for (const entry of entries ?? []) {
      if (entry.family !== "IPv4" && entry.family !== "IPv6") continue;
      out.push({ name, address: entry.address, family: entry.family, internal: entry.internal });
    }
  }
  return out;
}

export function nodePathDeps(): PathDeps {
  return { interfaces: systemInterfaces, lookup: systemLookup, resolveFrom, routeLocal, query };
}
