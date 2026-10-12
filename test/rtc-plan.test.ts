import assert from "node:assert/strict";
import { test } from "node:test";
import type { IceServerConfig } from "../src/main/rtc/ice.ts";
import type { PathPlan } from "../src/main/rtc/netpath.ts";
import type { PeerChannel, PeerLike, PeerOptions } from "../src/main/rtc/peer.ts";
import type { PortMapping } from "../src/main/rtc/portmap.ts";
import { Responder, type ResponderDeps } from "../src/main/rtc/responder.ts";

/** What a call does with the network plan: how its socket is opened and what the phone is told. */

const LISTED: IceServerConfig[] = [
  { hostname: "stun.example.com", port: 3478 },
  { hostname: "stun.example.com", port: 443 },
];
const OFFER = { type: "offer", sdp: "v=0\r\nm=application 9 UDP/DTLS/SCTP webrtc-datachannel\r\na=mid:data\r\n" };
const PHONE_HOST = { type: "candidate", candidate: "candidate:1 1 udp 2122260223 10.20.30.40 50000 typ host", mid: "data" };
const PHONE_PUBLIC = { type: "candidate", candidate: "candidate:3 1 udp 1686052607 36.21.7.8 40000 typ srflx raddr 0.0.0.0 rport 0", mid: "data" };
const PHONE_V6 = { type: "candidate", candidate: "candidate:2 1 udp 2122262783 2409:8a00:1::5 50001 typ host", mid: "data" };
const REFLEXIVE = "a=candidate:2 1 UDP 1678769919 183.156.1.2 50947 typ srflx raddr 0.0.0.0 rport 0";

function plan(over: Partial<PathPlan> = {}): PathPlan {
  return {
    stun: { hostname: "162.159.207.1", port: 3478 },
    bindAddress: null,
    localAddress: "192.168.22.7",
    publicAddress: "183.156.1.2",
    mapping: "independent",
    tunnel: false,
    nativeV6: false,
    ...over,
  };
}

class FakePeer implements PeerLike {
  candidate: ((c: string, mid: string) => void) | null = null;
  applied: string[] = [];
  closed = false;
  onLocalDescription() { /* the answer is not what these tests read */ }
  onLocalCandidate(cb: (c: string, mid: string) => void) { this.candidate = cb; }
  onStateChange() { /* never changes */ }
  onGatheringStateChange() { /* never completes: the hold ends on the reflexive candidate */ }
  onDataChannel(_cb: (c: PeerChannel) => void) { /* never opens */ }
  setRemoteDescription() { this.applied.push("offer"); }
  addRemoteCandidate(candidate: string) { this.applied.push(candidate); }
  selectedPath() { return null; }
  close() { this.closed = true; }
}

type Rig = {
  responder: Responder;
  created: Array<{ servers: IceServerConfig[]; options: PeerOptions | undefined }>;
  peers: FakePeer[];
  sent: Array<{ type: string; candidate?: string; candidates?: string[]; mid?: string }>;
  logs: string[];
};

function rig(over: Partial<ResponderDeps> = {}, failFirstPeer = false): Rig {
  const created: Rig["created"] = [];
  const peers: FakePeer[] = [];
  const sent: Rig["sent"] = [];
  const logs: string[] = [];
  const responder = new Responder({
    cid: "c1",
    peer: { name: "Phone" },
    createPeer: (servers, options) => {
      created.push({ servers, options });
      if (failFirstPeer && created.length === 1) throw new Error("address not available");
      const peer = new FakePeer();
      peers.push(peer);
      return peer;
    },
    loadIce: async () => LISTED,
    sendSignal: (data) => { sent.push(data as Rig["sent"][number]); return true; },
    attach: () => undefined,
    onChange: () => undefined,
    onEnd: () => undefined,
    connectTimeoutMs: 5000,
    pathPollMs: 1000,
    log: { info: (message) => logs.push(message), warn: (message) => logs.push(message) },
    ...over,
  });
  return { responder, created, peers, sent, logs };
}

const settle = (ms = 0): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));
/** Every guessed port the phone was sent, whichever message carried it. */
const predicted = (sent: Rig["sent"]): string[] => sent.flatMap((signal) => [signal.candidate ?? "", ...(signal.candidates ?? [])]).filter((line) => line.includes(":fvp"));

test("without a plan a call is set up as it always was", async () => {
  const { responder, created } = rig();
  await responder.start();
  assert.deepEqual(created, [{ servers: LISTED, options: undefined }]);
  responder.close();
});

test("a plan names the one server to gather with, and the address to bind past a tunnel", async () => {
  const { responder, created, logs } = rig({ loadPlan: async () => plan({ bindAddress: "192.168.22.7", tunnel: true }) });
  await responder.start();
  assert.deepEqual(created, [{ servers: [{ hostname: "162.159.207.1", port: 3478 }], options: { bindAddress: "192.168.22.7" } }]);
  assert.match(logs.join("\n"), /bound to 192\.168\.x\.x past a tunnel, public 183\.156\.x\.x/);
  responder.close();
});

test("a bound call keeps only the phone's IPv4 addresses; an unbound one keeps both", async () => {
  const bound = rig({ loadPlan: async () => plan({ bindAddress: "192.168.22.7", tunnel: true }) });
  await bound.responder.start();
  for (const signal of [OFFER, PHONE_HOST, PHONE_V6]) bound.responder.signal(signal);
  bound.peers[0].candidate?.(REFLEXIVE, "data");
  assert.deepEqual(bound.peers[0].applied, ["offer", PHONE_HOST.candidate]);
  bound.responder.close();

  const open = rig({ loadPlan: async () => plan() });
  await open.responder.start();
  for (const signal of [OFFER, PHONE_HOST, PHONE_V6]) open.responder.signal(signal);
  open.peers[0].candidate?.(REFLEXIVE, "data");
  assert.deepEqual(open.peers[0].applied, ["offer", PHONE_HOST.candidate, PHONE_V6.candidate]);
  open.responder.close();
});

test("a socket that cannot be opened as planned falls back to the plain one", async () => {
  const { responder, created, peers, sent } = rig({ loadPlan: async () => plan({ bindAddress: "192.168.22.7", tunnel: true, mapping: "sequential" }) }, true);
  await responder.start();
  assert.equal(created.length, 2);
  assert.deepEqual(created[1], { servers: LISTED, options: undefined });
  // What the plan measured belongs to the socket that did not open.
  responder.signal(OFFER);
  peers[0].candidate?.(REFLEXIVE, "data");
  assert.deepEqual(predicted(sent), []);
  responder.close();
});

test("a router that hands out ports in order: gathering waits for the phone's public address, then the next ports are offered", async () => {
  const { responder, peers, sent, logs } = rig({ loadPlan: async () => plan({ mapping: "sequential" }) });
  await responder.start();
  responder.signal(OFFER);
  responder.signal(PHONE_HOST);
  // Not applied yet: applying it sends the STUN request, and the port that request gets
  // should be as close as it can be to the one the phone's address is about to get.
  assert.deepEqual(peers[0].applied, []);
  responder.signal(PHONE_PUBLIC);
  assert.deepEqual(peers[0].applied, ["offer"]);
  // The phone's candidates follow the STUN request by a moment, not by its round trip.
  await settle(60);
  assert.deepEqual(peers[0].applied, ["offer", PHONE_HOST.candidate, PHONE_PUBLIC.candidate]);

  peers[0].candidate?.("a=candidate:1 1 UDP 2114977791 192.168.22.7 51282 typ host", "data");
  assert.deepEqual(predicted(sent), []);
  peers[0].candidate?.(REFLEXIVE, "data");
  const lines = predicted(sent);
  assert.equal(lines.length, 20);
  assert.match(lines[0], / 183\.156\.1\.2 50948 typ srflx/);
  assert.match(lines[19], / 183\.156\.1\.2 50967 typ srflx/);
  // One message for all of them, under the offer's mid.
  const batches = sent.filter((signal) => signal.type === "candidates");
  assert.equal(batches.length, 1);
  assert.equal(batches[0].mid, "data");
  // Once only, however many reflexive lines the library reports.
  peers[0].candidate?.(REFLEXIVE.replace("50947", "50999"), "data");
  assert.equal(predicted(sent).length, 20);
  assert.match(logs.join("\n"), /next 20 offered/);
  responder.close();
});

test("a phone with no public address of its own does not keep the offer waiting for long", async () => {
  const { responder, peers } = rig({ loadPlan: async () => plan({ mapping: "sequential" }) });
  await responder.start();
  responder.signal(OFFER);
  responder.signal(PHONE_HOST);
  await settle(300);
  assert.deepEqual(peers[0].applied, []);
  await settle(520);
  assert.deepEqual(peers[0].applied, ["offer", PHONE_HOST.candidate]);
  responder.close();
});

test("a call that ends while its offer is kept back applies nothing", async () => {
  const { responder, peers } = rig({ loadPlan: async () => plan({ mapping: "sequential" }) });
  await responder.start();
  responder.signal(OFFER);
  responder.close();
  await settle(760);
  assert.deepEqual(peers[0].applied, []);
});

test("a router that keeps the port, or picks at random, gets no guesses", async () => {
  for (const mapping of ["independent", "random", "unknown"] as const) {
    const { responder, peers, sent } = rig({ loadPlan: async () => plan({ mapping }) });
    await responder.start();
    responder.signal(OFFER);
    // Nothing to line up, so nothing is kept back.
    assert.deepEqual(peers[0].applied, ["offer"], mapping);
    peers[0].candidate?.(REFLEXIVE, "data");
    assert.deepEqual(predicted(sent), [], mapping);
    responder.close();
  }
});

test("a forwarded port is given to the socket, told to the phone, and taken down with the call", async () => {
  let released = 0;
  const asked: Array<[string, number]> = [];
  const mapping: PortMapping = { protocol: "upnp", externalAddress: "183.156.1.2", externalPort: 47811, release: async () => { released += 1; } };
  const { responder, created, peers, sent } = rig({
    loadPlan: async () => plan({ mapping: "sequential" }),
    portMap: {
      reserve: async () => 47811,
      map: async (local, port) => { asked.push([local, port]); await settle(20); return mapping; },
    },
  });
  await responder.start();
  assert.deepEqual(created[0].options, { port: 47811 });
  assert.deepEqual(asked, [["192.168.22.7", 47811]]);
  responder.signal(OFFER);
  // A forwarded port is coming, so there are no guesses to line up and no reason to wait.
  assert.deepEqual(peers[0].applied, ["offer"]);
  peers[0].candidate?.(REFLEXIVE, "data");
  // The router has not answered yet: no guesses while a real port may be coming.
  assert.deepEqual(predicted(sent), []);
  await settle(40);
  const forwarded = sent.filter((signal) => signal.candidate?.includes(":fvmap"));
  assert.equal(forwarded.length, 1);
  assert.match(forwarded[0].candidate!, /candidate:fvmap 1 UDP 1678769920 183\.156\.1\.2 47811 typ srflx/);
  assert.equal(forwarded[0].mid, "data");
  assert.deepEqual(predicted(sent), []);
  responder.close();
  assert.equal(released, 1);
});

test("a router behind another NAT, or one that refuses: the guesses are offered instead", async () => {
  let released = 0;
  const elsewhere: PortMapping = { protocol: "nat-pmp", externalAddress: "198.51.100.9", externalPort: 47811, release: async () => { released += 1; } };
  for (const answer of [elsewhere, null]) {
    const { responder, peers, sent } = rig({
      loadPlan: async () => plan({ mapping: "sequential" }),
      portMap: { reserve: async () => 47811, map: async () => answer },
    });
    await responder.start();
    responder.signal(OFFER);
    peers[0].candidate?.(REFLEXIVE, "data");
    await settle(10);
    assert.equal(sent.filter((signal) => signal.candidate?.includes(":fvmap")).length, 0);
    assert.equal(predicted(sent).length, 20);
    responder.close();
  }
  assert.equal(released, 1);
});

test("no port is asked for when the socket leaves by a tunnel that cannot be got past", async () => {
  let reserved = 0;
  const { responder, created } = rig({
    loadPlan: async () => plan({ tunnel: true, localAddress: null }),
    portMap: { reserve: async () => { reserved += 1; return 47811; }, map: async () => null },
  });
  await responder.start();
  assert.equal(reserved, 0);
  assert.deepEqual(created[0].options, undefined);
  responder.close();
});

test("a mapping that arrives after the call ended is taken straight down", async () => {
  let released = 0;
  const { responder } = rig({
    loadPlan: async () => plan(),
    portMap: {
      reserve: async () => 47811,
      map: async () => { await settle(20); return { protocol: "upnp", externalAddress: "183.156.1.2", externalPort: 47811, release: async () => { released += 1; } }; },
    },
  });
  await responder.start();
  responder.close();
  await settle(40);
  assert.equal(released, 1);
});

test("with IPv6 on both ends the call is left unbound; without the phone's, it is bound", async () => {
  const tunnelled = plan({ bindAddress: "192.168.22.7", tunnel: true, nativeV6: true, mapping: "sequential" });

  const both = rig({ loadPlan: async () => tunnelled });
  const starting = both.responder.start();
  both.responder.signal(OFFER);
  both.responder.signal(PHONE_HOST);
  both.responder.signal(PHONE_V6);
  await starting;
  assert.deepEqual(both.created[0].options, undefined);
  // Unbound, the socket's public port is the tunnel's business: nothing to predict.
  both.peers[0].candidate?.(REFLEXIVE, "data");
  assert.deepEqual(predicted(both.sent), []);
  // The signals that arrived while it waited are applied in order all the same.
  assert.deepEqual(both.peers[0].applied, ["offer", PHONE_HOST.candidate, PHONE_V6.candidate]);
  both.responder.close();

  const phoneV4 = rig({ loadPlan: async () => tunnelled });
  const began = Date.now();
  const waiting = phoneV4.responder.start();
  phoneV4.responder.signal(OFFER);
  phoneV4.responder.signal(PHONE_HOST);
  await waiting;
  assert.deepEqual(phoneV4.created[0].options, { bindAddress: "192.168.22.7" });
  assert.ok(Date.now() - began < 800, "a moment after the offer, not the whole wait");
  phoneV4.responder.close();

  // A phone whose IPv6 was already here needs no wait at all.
  const early = rig({ loadPlan: async () => { await settle(30); return tunnelled; } });
  const run = early.responder.start();
  early.responder.signal(OFFER);
  early.responder.signal(PHONE_V6);
  await run;
  assert.deepEqual(early.created[0].options, undefined);
  early.responder.close();
});
