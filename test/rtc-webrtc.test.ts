import { after, test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import nodeDataChannel from "node-datachannel";
import { RemoteServer } from "../src/main/server/server.ts";
import { ChannelSocket } from "../src/main/rtc/channel-socket.ts";
import { OfficialConnection } from "../src/main/rtc/official.ts";
import { createNodeDataChannelPeer } from "../src/main/rtc/peer.ts";
import { APP_PROTOCOL, APP_PROTOCOL_VERSION } from "../src/shared/app-protocol.ts";
import type { OfficialState } from "../src/shared/official.ts";
import { Ipc } from "../src/shared/ipc.ts";
import { registeredChannels } from "./registered-channels.ts";
import { startFakeCloud, type FakeCloud } from "./rtc-fake-cloud.ts";

/**
 * The real thing, end to end on loopback: libdatachannel on both ends, the desktop's
 * official connection answering, a stand-in cloud doing the signaling. What is faked is
 * only the cloud and the phone's UI; the WebRTC handshake, the data channel, the framing
 * and the App Protocol session on top are all the production code.
 */

// libdatachannel keeps its own threads, and with them the process, alive until told to stop.
after(() => nodeDataChannel.cleanup());

const silent = { info: () => undefined, warn: () => undefined, error: () => undefined };

type Rig = {
  cloud: FakeCloud;
  server: RemoteServer;
  official: OfficialConnection;
  states: OfficialState[];
  dispatched: string[];
};

async function withRig(fn: (rig: Rig) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), "fastvibe-rtc-e2e-"));
  const cloud = await startFakeCloud();
  const dispatched: string[] = [];
  const server = new RemoteServer({
    accessFile: join(dir, "remote-access.json"),
    channels: () => registeredChannels(),
    dispatch: async (method) => {
      dispatched.push(method);
      return { echoed: method, blob: method === Ipc.settingsGet ? "z".repeat(2_000_000) : undefined };
    },
    subscribe: () => () => undefined,
    log: silent,
  });
  const states: OfficialState[] = [];
  const official = new OfficialConnection({
    account: { token: () => "fvs_good", origin: () => cloud.origin },
    attach: (socket, peer) => server.attachTransport(socket, peer),
    installFile: join(dir, "rtc-device.json"),
    deviceName: () => "Test Mac",
    platform: "darwin",
    onChange: (state) => states.push(state),
    createPeer: (ice) => createNodeDataChannelPeer(ice),
    log: silent,
    pathPollMs: 100,
    signalingBackoffMs: [20],
  });
  try {
    await fn({ cloud, server, official, states, dispatched });
  } finally {
    official.shutdown();
    await server.stop();
    await cloud.close();
    await rm(dir, { recursive: true, force: true });
  }
}

async function until(condition: () => boolean, what: string, ms = 8000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((settle) => setTimeout(settle, 10));
  }
}

/** The phone's side: offers, opens the channel, and speaks the App Protocol over it. */
async function callDesktop(cloud: FakeCloud, deviceId: string) {
  const phone = await cloud.phone("fvs_good");
  const cid = await phone.connect(deviceId);
  const pc = new nodeDataChannel.PeerConnection("phone", { iceServers: [] });
  pc.onLocalDescription((sdp, type) => phone.signal(cid, { type, sdp }));
  pc.onLocalCandidate((candidate, mid) => phone.signal(cid, { type: "candidate", candidate, mid }));
  phone.onSignal((_cid, data) => {
    const message = data as { type: string; sdp?: string; candidate?: string; mid?: string };
    if (message.type === "answer") pc.setRemoteDescription(message.sdp!, "answer");
    else if (message.type === "candidate") pc.addRemoteCandidate(message.candidate!, message.mid ?? "0");
  });
  const channel = pc.createDataChannel("fastvibe");
  const socket = await new Promise<ChannelSocket>((settle, fail) => {
    const timer = setTimeout(() => fail(new Error("the data channel never opened")), 8000);
    channel.onOpen(() => {
      clearTimeout(timer);
      settle(new ChannelSocket(channel, { maxFrameBytes: 24 * 1024 * 1024 }));
    });
  });
  const frames: Array<Record<string, unknown>> = [];
  socket.on("message", (data: Buffer) => frames.push(JSON.parse(data.toString("utf8")) as Record<string, unknown>));
  const next = async (match: (f: Record<string, unknown>) => boolean): Promise<Record<string, unknown>> => {
    let found: Record<string, unknown> | undefined;
    await until(() => (found = frames.find(match)) !== undefined, "a frame from the desktop");
    frames.splice(frames.indexOf(found!), 1);
    return found!;
  };
  return {
    phone, cid, pc, socket, next,
    send: (frame: unknown) => socket.send(JSON.stringify(frame)),
    close: () => { socket.close(); pc.close(); phone.close(); },
  };
}

const hello = {
  kind: "hello",
  hello: { protocol: APP_PROTOCOL, protocolVersion: APP_PROTOCOL_VERSION, client: { kind: "mobile", version: "0.0.0" } },
};

test("a phone on the account connects over WebRTC and uses the app", async () => {
  await withRig(async ({ cloud, official, states, dispatched, server }) => {
    official.setEnabled(true);
    await until(() => official.state().status === "online", "the desktop to come online");
    const deviceId = official.state().deviceId!;
    assert.ok(deviceId);
    assert.equal(cloud.registrations[0].name, "Test Mac");

    const call = await callDesktop(cloud, deviceId);
    assert.equal((await call.next((f) => f.type === "auth")).ok, true);
    call.send(hello);
    assert.equal((await call.next((f) => f.kind === "welcome")).kind, "welcome");

    call.send({ kind: "call", requestId: 1, method: Ipc.engineGetStatus });
    const small = await call.next((f) => f.kind === "result");
    assert.equal(small.ok, true);

    // 2 MB of reply crosses an SCTP association in 16 KiB fragments, in order.
    call.send({ kind: "call", requestId: 2, method: Ipc.settingsGet });
    const large = await call.next((f) => f.kind === "result" && f.requestId === 2);
    assert.equal(((large.result as { blob: string }).blob).length, 2_000_000);
    assert.deepEqual(dispatched, [Ipc.engineGetStatus, Ipc.settingsGet]);

    // Direct on loopback, and the pane is told so.
    await until(() => official.state().peers[0]?.path === "direct", "the path to be known");
    assert.deepEqual(official.state().peers.map((p) => p.name), ["Test phone"]);
    assert.equal(server.status.clients, 0, "an official connection is not a LAN login");
    assert.ok(states.some((s) => s.peers.length === 1));

    // The phone releases its signaling slot, as the real client does; the link stays up.
    call.phone.hangup(call.cid);
    await new Promise((settle) => setTimeout(settle, 150));
    call.send({ kind: "call", requestId: 3, method: Ipc.engineGetStatus });
    assert.equal((await call.next((f) => f.kind === "result" && f.requestId === 3)).ok, true);

    call.close();
    await until(() => official.state().peers.length === 0, "the phone to be gone");
  });
});

test("the policy still applies over WebRTC", async () => {
  await withRig(async ({ cloud, official, dispatched }) => {
    official.setEnabled(true);
    await until(() => official.state().status === "online", "online");
    const call = await callDesktop(cloud, official.state().deviceId!);
    await call.next((f) => f.type === "auth");
    call.send(hello);
    await call.next((f) => f.kind === "welcome");
    call.send({ kind: "call", requestId: 1, method: Ipc.remoteStop });
    assert.equal((await call.next((f) => f.kind === "result")).ok, false);
    assert.deepEqual(dispatched, []);
    call.close();
  });
});

test("two phones at once, each its own connection", async () => {
  await withRig(async ({ cloud, official, server }) => {
    official.setEnabled(true);
    await until(() => official.state().status === "online", "online");
    const first = await callDesktop(cloud, official.state().deviceId!);
    const second = await callDesktop(cloud, official.state().deviceId!);
    await first.next((f) => f.type === "auth");
    await second.next((f) => f.type === "auth");
    // Both stand-ins introduce themselves as the same phone, so the pane's list — which
    // keeps one row per phone — shows one of them. What matters here is that both
    // connections are up, and closing one leaves the other.
    await until(() => server.status.clients === 0, "neither counts as a LAN login");
    first.close();
    second.send(hello);
    assert.equal((await second.next((f) => f.kind === "welcome")).kind, "welcome");
    second.close();
  });
});

test("switching it off drops the phones and takes the desktop offline", async () => {
  await withRig(async ({ cloud, official, server }) => {
    official.setEnabled(true);
    await until(() => official.state().status === "online", "online");
    const deviceId = official.state().deviceId!;
    const call = await callDesktop(cloud, deviceId);
    await call.next((f) => f.type === "auth");

    official.setEnabled(false);
    assert.equal(official.state().status, "off");
    await until(() => official.state().peers.length === 0, "the phone to be dropped");
    await until(() => !cloud.deviceSockets.has(deviceId), "signaling to close");
    call.close();
  });
});
