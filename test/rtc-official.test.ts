import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { OfficialConnection, type OfficialDeps } from "../src/main/rtc/official.ts";
import type { PeerChannel, PeerLike } from "../src/main/rtc/peer.ts";
import type { OfficialState } from "../src/shared/official.ts";
import { FakeChannelPair } from "./rtc-fake-channel.ts";
import { startFakeCloud, type FakeCloud } from "./rtc-fake-cloud.ts";

/** The lifecycle of the official connection: when it registers, retries, stops and restarts. */

const silent = { info: () => undefined, warn: () => undefined };

class FakePeer implements PeerLike {
  description: ((sdp: string, type: string) => void) | null = null;
  candidate: ((c: string, mid: string) => void) | null = null;
  state: ((s: string) => void) | null = null;
  channel: ((c: PeerChannel) => void) | null = null;
  applied: Array<{ kind: string; value: string }> = [];
  closed = false;
  path: "direct" | "relay" | null = null;
  onLocalDescription(cb: (sdp: string, type: string) => void) { this.description = cb; }
  onLocalCandidate(cb: (c: string, mid: string) => void) { this.candidate = cb; }
  onStateChange(cb: (s: string) => void) { this.state = cb; }
  onDataChannel(cb: (c: PeerChannel) => void) { this.channel = cb; }
  setRemoteDescription(sdp: string, type: string) {
    this.applied.push({ kind: type, value: sdp });
    // libdatachannel answers by itself once it has an offer.
    queueMicrotask(() => this.description?.("v=0 answer", "answer"));
  }
  addRemoteCandidate(candidate: string) { this.applied.push({ kind: "candidate", value: candidate }); }
  selectedPath() { return this.path; }
  close() { this.closed = true; }
}

type Rig = {
  cloud: FakeCloud;
  official: OfficialConnection;
  peers: FakePeer[];
  attached: Array<{ id: string; label: string }>;
  states: OfficialState[];
  token: { value: string | null };
  dir: string;
  iceCalls: () => number;
};

async function withRig(fn: (rig: Rig) => Promise<void>, over: Partial<OfficialDeps> = {}, Peer: new () => FakePeer = FakePeer): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), "fastvibe-official-"));
  const cloud = await startFakeCloud();
  const peers: FakePeer[] = [];
  const attached: Array<{ id: string; label: string }> = [];
  const states: OfficialState[] = [];
  const token = { value: "fvs_good" as string | null };
  let ice = 0;
  const realFetch = globalThis.fetch;
  const official = new OfficialConnection({
    account: { token: () => token.value, origin: () => cloud.origin },
    attach: (_socket, peer) => attached.push(peer),
    installFile: join(dir, "rtc-device.json"),
    deviceName: () => "Test Mac",
    platform: "darwin",
    onChange: (state) => states.push(state),
    createPeer: () => { const peer = new Peer(); peers.push(peer); return peer; },
    fetch: (input, init) => {
      if (String(input).endsWith("/api/rtc/ice")) ice += 1;
      return realFetch(input, init);
    },
    log: silent,
    connectTimeoutMs: 200,
    pathPollMs: 20,
    registerRetryMs: [30],
    signalingBackoffMs: [20],
    ...over,
  });
  try {
    await fn({ cloud, official, peers, attached, states, token, dir, iceCalls: () => ice });
  } finally {
    official.shutdown();
    await cloud.close();
    await rm(dir, { recursive: true, force: true });
  }
}

async function until(condition: () => boolean, what: string, ms = 3000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((settle) => setTimeout(settle, 5));
  }
}

test("off by default; switching on registers the device and goes online", async () => {
  await withRig(async ({ official, cloud, dir }) => {
    assert.equal(official.state().status, "off");
    official.setEnabled(true);
    await until(() => official.state().status === "online", "online");
    assert.equal(official.state().deviceName, "Test Mac");
    assert.ok(official.state().deviceId);
    assert.equal(cloud.registrations.length, 1);
    assert.equal(cloud.registrations[0].platform, "darwin");

    // The install id is kept (0600), so signing in again finds the same device.
    const file = join(dir, "rtc-device.json");
    assert.equal((await stat(file)).mode & 0o777, 0o600);
    const { installId } = JSON.parse(await readFile(file, "utf8")) as { installId: string };
    assert.equal(cloud.registrations[0].installId, installId);
    official.setEnabled(false);
    official.setEnabled(true);
    await until(() => official.state().status === "online", "online again");
    assert.equal(cloud.registrations[1].installId, installId);
  });
});

test("a new computer name is registered under the same device, without restarting the connection", async () => {
  const name = { value: "Test Mac" };
  await withRig(async ({ official, cloud }) => {
    official.setEnabled(true);
    await until(() => official.state().status === "online", "online");
    const deviceId = official.state().deviceId;

    name.value = "Desk";
    await official.renamed();
    assert.equal(cloud.registrations.length, 2);
    assert.deepEqual(cloud.registrations.map((r) => r.name), ["Test Mac", "Desk"]);
    assert.equal(cloud.registrations[1].installId, cloud.registrations[0].installId, "the same install, so the same device");
    assert.equal(official.state().deviceName, "Desk");
    assert.equal(official.state().deviceId, deviceId);
    assert.equal(official.state().status, "online");
  }, { deviceName: () => name.value });
});

test("renaming while the connection is off or signed out tells the cloud nothing", async () => {
  await withRig(async ({ official, cloud, token }) => {
    await official.renamed();
    official.setEnabled(true);
    await until(() => official.state().status === "online", "online");
    token.value = null;
    official.accountChanged();
    const before = cloud.registrations.length;
    await official.renamed();
    assert.equal(cloud.registrations.length, before);
  });
});

test("with the switch on but nobody signed in it waits, then starts when someone is", async () => {
  await withRig(async ({ official, token, cloud }) => {
    token.value = null;
    official.setEnabled(true);
    assert.equal(official.state().status, "signed-out");
    assert.equal(cloud.registrations.length, 0);

    token.value = "fvs_good";
    official.accountChanged();
    await until(() => official.state().status === "online", "online");
  });
});

test("signing out takes it offline and drops the phones", async () => {
  await withRig(async ({ official, token, cloud }) => {
    official.setEnabled(true);
    await until(() => official.state().status === "online", "online");
    const deviceId = official.state().deviceId!;
    token.value = null;
    official.accountChanged();
    assert.equal(official.state().status, "signed-out");
    assert.equal(official.state().deviceId, null);
    await until(() => !cloud.deviceSockets.has(deviceId), "signaling to close");
  });
});

test("another account signing in restarts it as that account", async () => {
  await withRig(async ({ official, token, cloud }) => {
    cloud.tokens.add("fvs_other");
    official.setEnabled(true);
    await until(() => official.state().status === "online", "online");
    token.value = "fvs_other";
    official.accountChanged();
    await until(() => cloud.registrations.length === 2, "re-registration");
    assert.equal(cloud.registrations[1].token, "fvs_other");
    await until(() => official.state().status === "online", "online as the other account");
  });
});

test("a refused token is signed-out, not an error to retry forever", async () => {
  await withRig(async ({ official, cloud }) => {
    cloud.registration = { status: 401, body: { error: { code: "unauthorized" } } };
    official.setEnabled(true);
    await until(() => official.state().status === "signed-out", "signed-out");
    await new Promise((settle) => setTimeout(settle, 120));
    assert.equal(cloud.registrations.length, 1, "no retries with a token the service refused");
  });
});

test("the device limit is reported and not retried", async () => {
  await withRig(async ({ official, cloud }) => {
    cloud.registration = { status: 409, body: { error: { code: "too_many_devices" } } };
    official.setEnabled(true);
    await until(() => official.state().status === "error", "error");
    assert.match(official.state().error ?? "", /上限|limit/);
    await new Promise((settle) => setTimeout(settle, 120));
    assert.equal(cloud.registrations.length, 1);
  });
});

test("a server error is retried until it clears", async () => {
  await withRig(async ({ official, cloud }) => {
    cloud.registration = { status: 503, body: { error: { code: "unavailable" } } };
    official.setEnabled(true);
    // The status is «connecting» while a retry is in the air and «error» once it is
    // refused, so wait for the refusal rather than read the status mid-request.
    await until(() => cloud.registrations.length >= 2 && official.state().status === "error", "a refused retry");
    cloud.registration = null;
    await until(() => official.state().status === "online", "online after recovery");
  });
});

test("turning it off during registration does not leave it half-started", async () => {
  await withRig(async ({ official, cloud }) => {
    official.setEnabled(true);
    official.setEnabled(false);
    await new Promise((settle) => setTimeout(settle, 150));
    assert.equal(official.state().status, "off");
    assert.equal(cloud.deviceSockets.size, 0, "a registration that finished late must not start signaling");
  });
});

test("being replaced elsewhere is an error that explains itself, not a reconnect fight", async () => {
  await withRig(async ({ official, cloud }) => {
    official.setEnabled(true);
    await until(() => official.state().status === "online", "online");
    cloud.closeDeviceSocket(official.state().deviceId!, 4001);
    await until(() => official.state().status === "error", "error");
    assert.match(official.state().error ?? "", /另一个|another/);
    await new Promise((settle) => setTimeout(settle, 100));
    assert.equal(cloud.registrations.length, 1);
  });
});

test("a call: answers the offer, relays the answer and candidates, and attaches on open", async () => {
  await withRig(async ({ official, cloud, peers, attached, iceCalls }) => {
    official.setEnabled(true);
    await until(() => official.state().status === "online", "online");
    const phone = await cloud.phone("fvs_good");
    const cid = await phone.connect(official.state().deviceId!);
    await until(() => peers.length === 1, "a peer connection");
    assert.equal(iceCalls(), 1, "the server list is fetched once, when signaling comes up, not for the call");

    phone.signal(cid, { type: "offer", sdp: "v=0 offer" });
    phone.signal(cid, { type: "candidate", candidate: "candidate:1 1 UDP 1 10.0.0.2 5000 typ host", mid: "0" });
    await until(() => peers[0].applied.length === 2, "the offer and candidate to be applied");
    assert.deepEqual(peers[0].applied.map((a) => a.kind), ["offer", "candidate"]);
    const answer = await new Promise<{ type: string; sdp: string }>((settle) => {
      phone.onSignal((_c, data) => { if ((data as { type: string }).type === "answer") settle(data as { type: string; sdp: string }); });
      void until(() => phone.messages.some((m) => m.type === "signal"), "answer").then(() => {
        const m = phone.messages.find((x) => x.type === "signal" && (x.data as { type: string }).type === "answer");
        if (m) settle(m.data as { type: string; sdp: string });
      });
    });
    assert.equal(answer.sdp, "v=0 answer");
    peers[0].candidate?.("candidate:9 1 UDP 1 192.168.1.5 6000 typ host", "0");
    await until(() => phone.messages.some((m) => m.type === "signal" && (m.data as { type: string }).type === "candidate"), "our candidate");

    const { a } = FakeChannelPair.create();
    (a as unknown as { getLabel(): string }).getLabel = () => "fastvibe";
    (a as unknown as { onOpen(cb: () => void): void }).onOpen = (cb) => cb();
    peers[0].path = "relay";
    peers[0].channel?.(a as unknown as PeerChannel);
    assert.deepEqual(attached, [{ id: `rtc:${cid}`, label: "Test phone" }]);
    await until(() => official.state().peers[0]?.path === "relay", "the path to be reported");
    assert.deepEqual(official.state().peers.map((p) => ({ name: p.name, platform: p.platform })), [{ name: "Test phone", platform: "ios" }]);
  });
});

test("a phone that reconnects is listed once, as its newest connection", async () => {
  await withRig(async ({ official, cloud, peers }) => {
    official.setEnabled(true);
    await until(() => official.state().status === "online", "online");
    const open = async (index: number): Promise<void> => {
      const { a } = FakeChannelPair.create();
      (a as unknown as { getLabel(): string }).getLabel = () => "fastvibe";
      (a as unknown as { onOpen(cb: () => void): void }).onOpen = (cb) => cb();
      peers[index].channel?.(a as unknown as PeerChannel);
    };
    const first = await cloud.phone("fvs_good");
    const firstCid = await first.connect(official.state().deviceId!);
    await until(() => peers.length === 1, "the first call");
    await open(0);
    const second = await cloud.phone("fvs_good");
    const secondCid = await second.connect(official.state().deviceId!);
    await until(() => peers.length === 2, "the second call");
    await new Promise((settle) => setTimeout(settle, 5));
    await open(1);
    assert.notEqual(firstCid, secondCid);
    assert.deepEqual(official.state().peers.map((p) => p.id), [secondCid]);
  });
});

test("a phone that calls again with the same id replaces its old connection", async () => {
  await withRig(async ({ official, cloud, peers }) => {
    official.setEnabled(true);
    await until(() => official.state().status === "online", "online");
    const open = (index: number): void => {
      const { a } = FakeChannelPair.create();
      (a as unknown as { getLabel(): string }).getLabel = () => "fastvibe";
      (a as unknown as { onOpen(cb: () => void): void }).onOpen = (cb) => cb();
      peers[index].channel?.(a as unknown as PeerChannel);
    };
    const call = async (index: number, id: string) => {
      const phone = await cloud.phone("fvs_good");
      const cid = await phone.connect(official.state().deviceId!);
      await until(() => peers.length === index + 1, `call ${index}`);
      phone.signal(cid, { type: "offer", sdp: "v=0 offer", client_id: id });
      await until(() => peers[index].applied.length === 1, "the offer");
      open(index);
      return cid;
    };
    await call(0, "phone-a");
    await call(1, "phone-b");
    assert.equal(official.state().peers.length, 2, "two ids, two phones, even with one name");
    const again = await call(2, "phone-a");
    await until(() => peers[0].closed, "the old connection of phone-a to be closed");
    assert.equal(peers[1].closed, false);
    assert.deepEqual(official.state().peers.map((p) => p.id).includes(again), true);
    assert.equal(official.state().peers.length, 2);
  });
});

test("compression is agreed in the answer only when the offer asked for it", async () => {
  await withRig(async ({ official, cloud, peers }) => {
    official.setEnabled(true);
    await until(() => official.state().status === "online", "online");
    const answerTo = async (index: number, offer: Record<string, unknown>): Promise<Record<string, unknown>> => {
      const phone = await cloud.phone("fvs_good");
      const cid = await phone.connect(official.state().deviceId!);
      await until(() => peers.length === index + 1, `call ${index}`);
      phone.signal(cid, { type: "offer", sdp: "v=0 offer", ...offer });
      await until(() => phone.messages.some((m) => m.type === "signal" && (m.data as { type: string }).type === "answer"), "the answer");
      return phone.messages.find((m) => m.type === "signal" && (m.data as { type: string }).type === "answer")!.data as Record<string, unknown>;
    };
    assert.equal((await answerTo(0, { deflate: true })).deflate, true);
    assert.equal((await answerTo(1, {})).deflate, undefined, "an older phone is never told to expect compressed frames");
  });
});

test("the server list is asked for once and reused by the calls that follow", async () => {
  await withRig(async ({ official, cloud, peers, iceCalls }) => {
    cloud.ice = { ice_servers: [{ urls: ["stun:turn.example.com:3478"] }, { urls: ["turn:turn.example.com:3478?transport=udp"], username: "u", credential: "p" }], expires_at: new Date(Date.now() + 3_600_000).toISOString() };
    official.setEnabled(true);
    await until(() => official.state().status === "online", "online");
    for (let index = 0; index < 3; index += 1) {
      const phone = await cloud.phone("fvs_good");
      await phone.connect(official.state().deviceId!);
      await until(() => peers.length === index + 1, `call ${index}`);
    }
    assert.equal(iceCalls(), 1);
  });
});

/** A peer that reports its gathering, as the real one does. */
class GatheringPeer extends FakePeer {
  gathering: ((state: string) => void) | null = null;
  onGatheringStateChange(cb: (state: string) => void) { this.gathering = cb; }
}

test("the phone's candidates wait for this side's own gathering, then go in together", async () => {
  await withRig(async ({ official, cloud, peers }) => {
    official.setEnabled(true);
    await until(() => official.state().status === "online", "online");
    const phone = await cloud.phone("fvs_good");
    const cid = await phone.connect(official.state().deviceId!);
    await until(() => peers.length === 1, "a peer connection");
    phone.signal(cid, { type: "offer", sdp: "v=0 offer" });
    phone.signal(cid, { type: "candidate", candidate: "candidate:1 1 udp 2122260223 10.3.126.7 40000 typ host", mid: "0" });
    phone.signal(cid, { type: "candidate", candidate: "candidate:2 1 udp 41885439 198.51.100.2 50000 typ relay raddr 0.0.0.0 rport 0", mid: "0" });
    await until(() => peers[0].applied.length === 1, "the offer");
    await new Promise((settle) => setTimeout(settle, 80));
    assert.deepEqual(peers[0].applied.map((a) => a.kind), ["offer"], "no connectivity check goes out before the STUN request has");
    (peers[0] as GatheringPeer).gathering?.("complete");
    assert.deepEqual(peers[0].applied.map((a) => a.kind), ["offer", "candidate", "candidate"]);
    // One that arrives afterwards is applied at once.
    phone.signal(cid, { type: "candidate", candidate: "candidate:3 1 udp 1686052607 203.0.113.9 40001 typ srflx raddr 0.0.0.0 rport 0", mid: "0" });
    await until(() => peers[0].applied.length === 4, "a late candidate");
  }, {}, GatheringPeer);
});

test("a STUN server that never answers does not hold the call up for long", async () => {
  await withRig(async ({ official, cloud, peers }) => {
    official.setEnabled(true);
    await until(() => official.state().status === "online", "online");
    const phone = await cloud.phone("fvs_good");
    const cid = await phone.connect(official.state().deviceId!);
    await until(() => peers.length === 1, "a peer connection");
    phone.signal(cid, { type: "offer", sdp: "v=0 offer" });
    phone.signal(cid, { type: "candidate", candidate: "candidate:1 1 udp 2122260223 192.168.1.7 40000 typ host", mid: "0" });
    await until(() => peers[0].applied.length === 2, "the candidate, once the wait is over", 3000);
  }, { connectTimeoutMs: 5000 }, GatheringPeer);
});

test("signals that arrive before the ICE servers are in are replayed in order", async () => {
  let release!: () => void;
  const gate = new Promise<void>((settle) => { release = settle; });
  await withRig(async ({ official, cloud, peers }) => {
    official.setEnabled(true);
    await until(() => official.state().status === "online", "online");
    const phone = await cloud.phone("fvs_good");
    const cid = await phone.connect(official.state().deviceId!);
    phone.signal(cid, { type: "offer", sdp: "v=0 offer" });
    phone.signal(cid, { type: "candidate", candidate: "candidate:1 1 udp 2122260223 192.168.1.5 54321 typ host", mid: "0" });
    await new Promise((settle) => setTimeout(settle, 80));
    assert.equal(peers.length, 0, "still waiting on the ICE request");
    release();
    await until(() => peers[0]?.applied.length === 2, "the replay");
    assert.deepEqual(peers[0].applied.map((a) => a.kind), ["offer", "candidate"]);
  }, {
    fetch: async (input, init) => {
      if (String(input).endsWith("/api/rtc/ice")) await gate;
      return fetch(input, init);
    },
  });
});

test("ICE servers that cannot be fetched do not stop a LAN connection", async () => {
  await withRig(async ({ official, cloud, peers }) => {
    cloud.ice = null;
    official.setEnabled(true);
    await until(() => official.state().status === "online", "online");
    const phone = await cloud.phone("fvs_good");
    await phone.connect(official.state().deviceId!);
    await until(() => peers.length === 1, "a peer connection even without ICE servers");
  }, {
    fetch: async (input, init) => {
      if (String(input).endsWith("/api/rtc/ice")) throw new Error("offline");
      return fetch(input, init);
    },
  });
});

test("a call that never opens a channel is abandoned", async () => {
  await withRig(async ({ official, cloud, peers }) => {
    official.setEnabled(true);
    await until(() => official.state().status === "online", "online");
    const phone = await cloud.phone("fvs_good");
    await phone.connect(official.state().deviceId!);
    await until(() => peers.length === 1, "a peer");
    await until(() => peers[0].closed, "the abandoned peer to be closed");
  });
});

test("the phone hanging up before the channel opens ends the call; after, it does not", async () => {
  await withRig(async ({ official, cloud, peers }) => {
    official.setEnabled(true);
    await until(() => official.state().status === "online", "online");
    const phone = await cloud.phone("fvs_good");
    const early = await phone.connect(official.state().deviceId!);
    await until(() => peers.length === 1, "a peer");
    phone.hangup(early);
    await until(() => peers[0].closed, "closed on hangup");

    const late = await phone.connect(official.state().deviceId!);
    await until(() => peers.length === 2, "a second peer");
    const { a } = FakeChannelPair.create();
    (a as unknown as { getLabel(): string }).getLabel = () => "fastvibe";
    peers[1].channel?.(a as unknown as PeerChannel);
    phone.hangup(late);
    await new Promise((settle) => setTimeout(settle, 80));
    assert.equal(peers[1].closed, false, "the channel is up; a hangup only frees the phone's slot");
  }, { connectTimeoutMs: 5000 });
});

test("a data channel with another label is refused", async () => {
  await withRig(async ({ official, cloud, peers, attached }) => {
    official.setEnabled(true);
    await until(() => official.state().status === "online", "online");
    const phone = await cloud.phone("fvs_good");
    await phone.connect(official.state().deviceId!);
    await until(() => peers.length === 1, "a peer");
    const { a } = FakeChannelPair.create();
    (a as unknown as { getLabel(): string }).getLabel = () => "something-else";
    peers[0].channel?.(a as unknown as PeerChannel);
    assert.equal(a.open, false, "closed");
    assert.deepEqual(attached, []);
  }, { connectTimeoutMs: 5000 });
});
