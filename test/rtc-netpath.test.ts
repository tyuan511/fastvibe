import assert from "node:assert/strict";
import { test } from "node:test";
import {
  classifyMapping,
  isFakeIp,
  isGlobalV6,
  isPublicV4,
  networkSignature,
  physicalAddresses,
  probePath,
  probeTargets,
  type InterfaceAddress,
  type PathDeps,
} from "../src/main/rtc/netpath.ts";
import { bindingRequest, mappedAddress } from "../src/main/rtc/stun.ts";

const CLOUDFLARE = [
  { hostname: "stun.example.com", port: 3478 },
  { hostname: "stun.example.com", port: 443 },
  { hostname: "turn.example.com", port: 3478 },
  { hostname: "turn.example.com", port: 443 },
];

const WIFI: InterfaceAddress = { name: "en0", address: "192.168.22.7", family: "IPv4", internal: false };
const TUNNEL: InterfaceAddress = { name: "utun4", address: "198.18.0.1", family: "IPv4", internal: false };
const LOOPBACK: InterfaceAddress = { name: "lo0", address: "127.0.0.1", family: "IPv4", internal: true };

/** A network described by what each kind of socket sees, with a record of what was asked of it. */
function network(options: {
  interfaces: InterfaceAddress[];
  /** What the system resolver says. */
  system: Record<string, string | null>;
  /** What a resolver asked from a real interface says. */
  real?: Record<string, string>;
  routeLocal: string | null;
  routeLocalV6?: string | null;
  /** The public address and first port an unbound socket gets, and the step to the next destination. */
  open: { address: string; port: number; step: number } | null;
  bound?: Record<string, { address: string; port: number; step: number } | null>;
  /** Destinations (`address:port`) that never answer. */
  dead?: string[];
}): { deps: PathDeps; queries: Array<{ bind: string | null; targets: string[] }>; resolved: string[] } {
  const queries: Array<{ bind: string | null; targets: string[] }> = [];
  const resolved: string[] = [];
  const deps: PathDeps = {
    interfaces: () => options.interfaces,
    lookup: async (hostname) => options.system[hostname] ?? null,
    resolveFrom: async (hostname, local) => {
      resolved.push(`${hostname}@${local}`);
      return options.real?.[hostname] ?? null;
    },
    routeLocal: async (_address, family) => (family === 4 ? options.routeLocal : options.routeLocalV6 ?? null),
    query: async (targets, bind) => {
      queries.push({ bind, targets: targets.map((target) => `${target.address}:${target.port}`) });
      const nat = bind === null ? options.open : options.bound?.[bind] ?? null;
      return targets.map((target, index) => {
        if (!nat || options.dead?.includes(`${target.address}:${target.port}`)) return null;
        return { address: nat.address, port: nat.port + index * nat.step };
      });
    },
  };
  return { deps, queries, resolved };
}

test("a Binding answer gives back the address it was sent for, and nobody else's", () => {
  const { id, packet } = bindingRequest();
  assert.equal(packet.length, 20);
  const reply = (transaction: Buffer, attribute: Buffer): Buffer => {
    const header = Buffer.alloc(8);
    header.writeUInt16BE(0x0101, 0);
    header.writeUInt16BE(attribute.length, 2);
    Buffer.from([0x21, 0x12, 0xa4, 0x42]).copy(header, 4);
    return Buffer.concat([header, transaction, attribute]);
  };
  // XOR-MAPPED-ADDRESS for 203.0.113.9:40000
  const xored = Buffer.from([0x00, 0x20, 0x00, 0x08, 0x00, 0x01, (40000 >> 8) ^ 0x21, (40000 & 255) ^ 0x12, 203 ^ 0x21, 0 ^ 0x12, 113 ^ 0xa4, 9 ^ 0x42]);
  assert.deepEqual(mappedAddress(reply(id, xored), id), { address: "203.0.113.9", port: 40000 });
  // The plain form is read when it is all there is.
  const plain = Buffer.from([0x00, 0x01, 0x00, 0x08, 0x00, 0x01, 40000 >> 8, 40000 & 255, 203, 0, 113, 9]);
  assert.deepEqual(mappedAddress(reply(id, plain), id), { address: "203.0.113.9", port: 40000 });
  assert.equal(mappedAddress(reply(Buffer.alloc(12, 7), xored), id), null);
  assert.equal(mappedAddress(Buffer.from("not stun at all, just bytes"), id), null);
});

test("addresses are sorted into public, made-up and global", () => {
  assert.equal(isFakeIp("198.18.0.42"), true);
  assert.equal(isFakeIp("198.19.255.255"), true);
  assert.equal(isFakeIp("198.20.0.1"), false);
  for (const address of ["10.1.2.3", "100.64.0.9", "172.16.5.5", "192.168.1.1", "169.254.1.1", "127.0.0.1", "198.18.0.1", "224.0.0.1", "0.0.0.0", "nope"]) {
    assert.equal(isPublicV4(address), false, address);
  }
  assert.equal(isPublicV4("183.156.1.2"), true);
  assert.equal(isPublicV4("172.32.0.1"), true);
  assert.equal(isGlobalV6("2408:8207::1"), true);
  assert.equal(isGlobalV6("fdfe:dcba:9876::1"), false);
  assert.equal(isGlobalV6("fe80::1"), false);
});

test("only real interfaces are offered for binding, wired and wireless first", () => {
  assert.deepEqual(physicalAddresses([
    LOOPBACK,
    TUNNEL,
    { name: "bridge100", address: "192.168.64.1", family: "IPv4", internal: false },
    { name: "vpn-corp", address: "10.8.0.2", family: "IPv4", internal: false },
    { name: "en5", address: "169.254.9.9", family: "IPv4", internal: false },
    WIFI,
    { name: "en0", address: "fe80::1", family: "IPv6", internal: false },
  ]), ["192.168.22.7", "10.8.0.2"]);
});

test("the signature moves with the interfaces and ignores link-local noise", () => {
  const before = networkSignature([WIFI, LOOPBACK, { name: "en0", address: "fe80::1", family: "IPv6", internal: false }]);
  assert.equal(before, networkSignature([LOOPBACK, WIFI]));
  assert.notEqual(before, networkSignature([WIFI, TUNNEL]));
});

test("the standard port is asked first, and no destination twice", () => {
  assert.deepEqual(probeTargets([...CLOUDFLARE, CLOUDFLARE[0]]), [
    { hostname: "stun.example.com", port: 3478 },
    { hostname: "turn.example.com", port: 3478 },
    { hostname: "stun.example.com", port: 443 },
  ]);
});

test("a router's habit is read from the ports it gave one socket", () => {
  const at = (port: number, address = "203.0.113.9") => ({ address, port });
  assert.equal(classifyMapping([at(5000), at(5000), at(5000)]), "independent");
  assert.equal(classifyMapping([at(9787), at(9789), at(9790)]), "sequential");
  // An unanswered request still took its port; the answers either side are what is read.
  assert.equal(classifyMapping([at(9787), null, at(9804)]), "sequential");
  assert.equal(classifyMapping([at(40112), at(12003), at(55310)]), "random");
  assert.equal(classifyMapping([at(9790), at(9787)]), "random");
  assert.equal(classifyMapping([at(5000), at(5000, "203.0.113.77")]), "random");
  assert.equal(classifyMapping([at(5000), null, null]), "unknown");
  assert.equal(classifyMapping([]), "unknown");
});

test("with no tunnel a call keeps the system's route and is handed the server that answered", async () => {
  const { deps, queries, resolved } = network({
    interfaces: [LOOPBACK, WIFI],
    system: { "stun.example.com": "162.159.207.1", "turn.example.com": "141.101.90.1" },
    routeLocal: WIFI.address,
    open: { address: "203.0.113.9", port: 50000, step: 0 },
    dead: ["162.159.207.1:3478"],
  });
  const plan = await probePath(CLOUDFLARE, deps);
  assert.deepEqual(plan, {
    // By name, as the system resolves it; the first one that answered.
    stun: { hostname: "turn.example.com", port: 3478 },
    bindAddress: null,
    localAddress: WIFI.address,
    publicAddress: "203.0.113.9",
    mapping: "independent",
    tunnel: false,
    nativeV6: false,
  });
  assert.deepEqual(queries, [{ bind: null, targets: ["162.159.207.1:3478", "141.101.90.1:3478", "162.159.207.1:443"] }]);
  assert.deepEqual(resolved, []);
});

test("a tunnel with made-up addresses: the call is bound to the real interface and given the real server", async () => {
  const { deps, queries, resolved } = network({
    interfaces: [LOOPBACK, WIFI, TUNNEL],
    system: { "stun.example.com": "198.18.0.60", "turn.example.com": "198.18.0.61" },
    real: { "stun.example.com": "162.159.207.1", "turn.example.com": "141.101.90.1" },
    routeLocal: TUNNEL.address,
    // Through the tunnel: the far end's address, one port for every destination.
    open: { address: "179.255.1.1", port: 33435, step: 0 },
    // Past it: the router's address, and the next port along each time.
    bound: { [WIFI.address]: { address: "183.156.1.1", port: 9787, step: 2 } },
  });
  const plan = await probePath(CLOUDFLARE, deps);
  assert.deepEqual(plan, {
    stun: { hostname: "162.159.207.1", port: 3478 },
    bindAddress: WIFI.address,
    localAddress: WIFI.address,
    publicAddress: "183.156.1.1",
    mapping: "sequential",
    tunnel: true,
    nativeV6: false,
  });
  assert.deepEqual(resolved.sort(), [`stun.example.com@${WIFI.address}`, `turn.example.com@${WIFI.address}`]);
  assert.deepEqual(queries.find((query) => query.bind === WIFI.address)?.targets, ["162.159.207.1:3478", "141.101.90.1:3478", "162.159.207.1:443"]);
});

test("a tunnel whose resolver is honest is bypassed without asking anyone else for the address", async () => {
  const { deps, resolved } = network({
    interfaces: [WIFI, { name: "utun7", address: "10.66.0.2", family: "IPv4", internal: false }],
    system: { "stun.example.com": "162.159.207.1", "turn.example.com": "141.101.90.1" },
    routeLocal: "10.66.0.2",
    open: { address: "45.9.9.9", port: 2000, step: 0 },
    bound: { [WIFI.address]: { address: "203.0.113.9", port: 61000, step: 0 } },
  });
  const plan = await probePath(CLOUDFLARE, deps);
  assert.equal(plan.bindAddress, WIFI.address);
  assert.deepEqual(plan.stun, { hostname: "162.159.207.1", port: 3478 });
  assert.equal(plan.mapping, "independent");
  assert.deepEqual(resolved, []);
});

test("binding is not used when it changes nothing or gets no answer", async () => {
  const same = network({
    interfaces: [WIFI, TUNNEL],
    system: { "stun.example.com": "162.159.207.1", "turn.example.com": "141.101.90.1" },
    routeLocal: TUNNEL.address,
    open: { address: "203.0.113.9", port: 50000, step: 0 },
    bound: { [WIFI.address]: { address: "203.0.113.9", port: 50001, step: 0 } },
  });
  const first = await probePath(CLOUDFLARE, same.deps);
  assert.equal(first.bindAddress, null);
  assert.equal(first.tunnel, true);
  // Nothing to forward a port to: the socket leaves by the tunnel.
  assert.equal(first.localAddress, null);
  assert.deepEqual(first.stun, { hostname: "stun.example.com", port: 3478 });

  const silent = network({
    interfaces: [WIFI, TUNNEL],
    system: { "stun.example.com": "198.18.0.60", "turn.example.com": "198.18.0.61" },
    routeLocal: TUNNEL.address,
    open: { address: "179.255.1.1", port: 33435, step: 0 },
    bound: { [WIFI.address]: null },
  });
  const second = await probePath(CLOUDFLARE, silent.deps);
  assert.equal(second.bindAddress, null);
  assert.equal(second.publicAddress, "179.255.1.1");
});

test("a bound socket that only reaches a private answer has not got past anything", async () => {
  const { deps } = network({
    interfaces: [WIFI, TUNNEL],
    system: { "stun.example.com": "162.159.207.1", "turn.example.com": "141.101.90.1" },
    routeLocal: TUNNEL.address,
    open: { address: "179.255.1.1", port: 33435, step: 0 },
    bound: { [WIFI.address]: { address: "10.0.0.5", port: 4000, step: 0 } },
  });
  assert.equal((await probePath(CLOUDFLARE, deps)).bindAddress, null);
});

test("native IPv6 means a global address the default route really uses", async () => {
  const v6: InterfaceAddress = { name: "en0", address: "2408:8207:1::7", family: "IPv6", internal: false };
  const base = {
    system: { "stun.example.com": "162.159.207.1", "turn.example.com": "141.101.90.1" },
    routeLocal: WIFI.address,
    open: { address: "203.0.113.9", port: 50000, step: 0 },
  };
  assert.equal((await probePath(CLOUDFLARE, network({ ...base, interfaces: [WIFI, v6], routeLocalV6: "2408:8207:1::7" }).deps)).nativeV6, true);
  // The tunnel took the IPv6 route too: the address is there and is not the way out.
  assert.equal((await probePath(CLOUDFLARE, network({ ...base, interfaces: [WIFI, v6], routeLocalV6: "fdfe:dcba:9876::1" }).deps)).nativeV6, false);
  assert.equal((await probePath(CLOUDFLARE, network({ ...base, interfaces: [WIFI], routeLocalV6: null }).deps)).nativeV6, false);
});

test("nothing to ask, or nothing answering, still yields a plan", async () => {
  const empty = network({ interfaces: [WIFI], system: {}, routeLocal: WIFI.address, open: null });
  assert.deepEqual(await probePath([], empty.deps), {
    stun: null, bindAddress: null, localAddress: null, publicAddress: null, mapping: "unknown", tunnel: false, nativeV6: false,
  });
  const offline = network({ interfaces: [WIFI], system: { "stun.example.com": null, "turn.example.com": null }, routeLocal: null, open: null });
  const plan = await probePath(CLOUDFLARE, offline.deps);
  assert.deepEqual(plan.stun, { hostname: "stun.example.com", port: 3478 });
  assert.equal(plan.mapping, "unknown");
  assert.equal(plan.bindAddress, null);
});
