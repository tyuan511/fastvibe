import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { configureFastVibeUserData } from "../src/main/engine/paths.ts";
import { IrohRemoteConnection, type IrohRemoteDeps } from "../src/main/rtc/iroh-remote.ts";
import { IrohSidecar, type IrohSidecarEvent } from "../src/main/rtc/iroh-sidecar.ts";
import type { IrohDiscoveryEndpoint, IrohDiscoveryPublisher } from "../src/main/rtc/iroh-discovery.ts";
import { AccountService, type AccountIrohDevice } from "../src/main/engine/account.ts";
import { splitFrame } from "../src/main/rtc/frames.ts";
import { uiText } from "../src/main/engine/ui-text.ts";

const relayConfig = {
  relayId: "hk1",
  url: "https://relay.example.test/",
  quicPort: 7842,
  token: "fvr1.token",
  expiresAt: "2026-01-01T00:10:00.000Z",
  usage: {
    periodStart: "2026-01-01T00:00:00Z",
    resetsAt: "2026-02-01T00:00:00Z",
    usedBytes: 0,
    quotaBytes: 1000,
    remainingBytes: 1000,
  },
};

test("iroh initialization failures become visible error state", async () => {
  const dir = await mkdtemp(join(tmpdir(), "fastvibe-iroh-remote-"));
  const previous = process.env.FASTVIBE_IROH_BIN;
  process.env.FASTVIBE_IROH_BIN = "/tmp/does-not-exist-fastvibe-iroh";
  configureFastVibeUserData(dir);
  const changes: string[] = [];
  const remote = new IrohRemoteConnection({
    account: {
      async setIrohEndpoint() {},
      async issueIrohRelay() { return relayConfig; },
      async reportIrohUsage() { return relayConfig.usage; },
    },
    deviceId: "device",
    authorizePeer: async () => null,
    attach() {},
    log: { info() {}, warn() {} },
    onChange: () => changes.push("changed"),
  });
  try {
    await assert.rejects(remote.start(), /找不到 iroh transport/);
    const state = remote.state(true);
    assert.equal(state.status, "error");
    assert.match(state.error ?? "", /找不到 iroh transport/);
    assert.ok(changes.length > 0);
  } finally {
    await remote.dispose();
    if (previous === undefined) delete process.env.FASTVIBE_IROH_BIN;
    else process.env.FASTVIBE_IROH_BIN = previous;
    await rm(dir, { recursive: true, force: true });
  }
});

class FakeSidecar extends IrohSidecar {
  closed: string[] = [];
  endpointId = "desktop-endpoint";
  override async identity() { return this.endpointId; }
  override async startLease() {}
  override async refresh() {}
  override async stop() {}
  override closeConnection(id: string) { this.closed.push(id); }
  event(event: IrohSidecarEvent) { this.emit("event", event); }
}

function connection(authorizePeer: IrohRemoteDeps["authorizePeer"], attach?: IrohRemoteDeps["attach"], options: Pick<IrohRemoteDeps, "discovery" | "deviceName"> = {}) {
  const sidecar = new FakeSidecar();
  const attached: Array<{ id: string; label: string }> = [];
  const snapshots: unknown[] = [];
  const remote = new IrohRemoteConnection({
    account: {
      async issueIrohRelay() { return { ...relayConfig, expiresAt: new Date(Date.now() + 3600_000).toISOString() }; },
      async reportIrohUsage() { return relayConfig.usage; },
    },
    deviceId: "desktop-device",
    identityFile: "/unused/endpoint.key",
    sidecar,
    authorizePeer,
    attach(socket, peer) { attached.push(peer); attach?.(socket, peer); },
    log: { info() {}, warn() {} },
    onChange() { snapshots.push(remote.state(true).peers); },
    ...options,
  });
  return { remote, sidecar, attached, snapshots };
}

const tick = () => new Promise<void>((resolve) => setImmediate(resolve));
const device = (name: string): AccountIrohDevice => ({ id: "account-device", name, platform: "ios" });

test("account-authorized device names reach peer state and transport attachment; pending and unknown peers stay hidden", async () => {
  const dir = await mkdtemp(join(tmpdir(), "fastvibe-iroh-account-"));
  const file = join(dir, "account.json");
  const origin = "https://account.example.test";
  await writeFile(file, JSON.stringify({ version: 1, origin, token: "account-token", user: { id: "u1", login: "user" } }));
  let answer!: (response: Response) => void;
  const account = new AccountService({
    file, origin, deviceName: () => "Desktop", platform: "darwin", openUrl() {}, onChange() {},
    fetch: async (url, options) => {
      assert.equal(String(url), `${origin}/api/devices`);
      assert.equal((options?.headers as Record<string, string>).Authorization, "Bearer account-token");
      return new Promise<Response>((resolve) => { answer = resolve; });
    },
  });
  const received: string[] = [];
  const r = connection(async (endpointId) => (await account.irohDevices()).get(endpointId) ?? null,
    (socket) => socket.on("message", (data) => received.push(data.toString())));
  try {
    await r.remote.start();
    r.sidecar.event({ type: "connected", connectionId: "iroh-1", remoteId: "verified-endpoint", name: "Forged name" } as IrohSidecarEvent);
    r.sidecar.event({ type: "path", connectionId: "iroh-1", path: "direct" });
    const frame = splitFrame(Buffer.from("early hello"), false, false)[0];
    r.sidecar.event({ type: "data", connectionId: "iroh-1", data: frame.toString("base64") });
    assert.deepEqual(r.remote.state(true).peers, []);
    assert.deepEqual(r.attached, []);
    assert.deepEqual(received, []);
    answer(Response.json({ devices: [{ id: "phone", name: "Ada’s iPhone", platform: "ios", iroh_endpoint_id: "verified-endpoint" }] }));
    await tick();
    assert.deepEqual(r.remote.state(true).peers, [{ id: "iroh-1", label: "Ada’s iPhone", path: "direct" }]);
    assert.deepEqual(r.attached, [{ id: "iroh:iroh-1", label: "Ada’s iPhone" }]);
    assert.deepEqual(received, ["early hello"]);

    r.sidecar.event({ type: "connected", connectionId: "iroh-2", remoteId: "unknown-endpoint", name: "Ada’s iPhone" } as IrohSidecarEvent);
    r.sidecar.event({ type: "path", connectionId: "iroh-2", path: "relay" });
    assert.equal(r.remote.state(true).peers.length, 1);
    answer(Response.json({ devices: [{ name: "Ada’s iPhone", iroh_endpoint_id: "verified-endpoint" }] }));
    await tick();
    assert.deepEqual(r.sidecar.closed, ["iroh-2"]);
    assert.equal(r.attached.length, 1);
    assert.equal(JSON.stringify(r.snapshots).includes("iroh-2"), false);
    r.sidecar.event({ type: "closed", connectionId: "iroh-1" });
    assert.deepEqual(r.remote.state(true).peers, []);
  } finally {
    await r.remote.dispose();
    await rm(dir, { recursive: true, force: true });
  }
});

test("duplicate and missing account device names stay distinct without endpoint labels", async () => {
  const names = [" Phone ", "Phone", "Phone (2)", "", "  ", "bad\nname"];
  const r = connection(async (endpointId) => device(names[Number(endpointId)]));
  try {
    await r.remote.start();
    for (let i = 0; i < names.length; i++) r.sidecar.event({ type: "connected", connectionId: `iroh-${i}`, remoteId: String(i) });
    await tick();
    const fallback = uiText("已连接设备", "Connected device");
    const labels = ["Phone", "Phone (2)", "Phone (2) (2)", fallback, `${fallback} (2)`, `${fallback} (3)`];
    assert.deepEqual(r.remote.state(true).peers.map((peer) => peer.label), labels);
    assert.deepEqual(r.attached.map((peer) => peer.label), labels);
    assert.equal(new Set(labels).size, names.length);
    r.remote.disconnectPeers();
    assert.deepEqual(r.remote.state(true).peers, []);
  } finally { await r.remote.dispose(); }
});

test("failed account authorization closes the socket without attaching or listing it", async () => {
  const r = connection(async () => { throw new Error("account offline"); });
  try {
    await r.remote.start();
    r.sidecar.event({ type: "connected", connectionId: "denied", remoteId: "endpoint" });
    await tick();
    assert.deepEqual(r.attached, []);
    assert.deepEqual(r.remote.state(true).peers, []);
    assert.deepEqual(r.sidecar.closed, ["denied"]);
  } finally { await r.remote.dispose(); }
});

test("authorization resolving after stop, disconnect or peer close never revives a session", async (t) => {
  for (const action of ["stop", "disconnect", "closed"] as const) await t.test(action, async () => {
    let authorize!: (value: AccountIrohDevice) => void;
    const r = connection(() => new Promise((resolve) => { authorize = resolve; }));
    try {
      await r.remote.start();
      r.sidecar.event({ type: "connected", connectionId: "pending", remoteId: "endpoint" });
      if (action === "stop") {
        await r.remote.stop();
        await r.remote.start();
      } else if (action === "disconnect") r.remote.disconnectPeers();
      else r.sidecar.event({ type: "closed", connectionId: "pending" });
      authorize(device("Late phone"));
      await tick();
      assert.deepEqual(r.attached, []);
      assert.deepEqual(r.remote.state(true).peers, []);
      assert.deepEqual(r.sidecar.closed, ["pending"]);
    } finally { await r.remote.dispose(); }
  });
});


class FakeDiscovery implements IrohDiscoveryPublisher {
  current: IrohDiscoveryEndpoint | null = null;
  published: IrohDiscoveryEndpoint[] = [];
  publish(endpoint: IrohDiscoveryEndpoint) { this.current = endpoint; this.published.push(endpoint); }
  stop() { this.current = null; }
}

test("iroh LAN discovery follows actual addresses, account identity, rename and stop independently of a password listener", async () => {
  const discovery = new FakeDiscovery();
  let name = "Office";
  const r = connection(async () => null, undefined, { discovery, deviceName: () => name });
  try {
    await r.remote.start();
    assert.equal(discovery.current, null);
    r.sidecar.event({ type: "started", endpointId: "desktop-endpoint", directAddresses: ["192.168.1.2:41414"] });
    assert.deepEqual(discovery.current, {
      deviceId: "desktop-device", endpointId: "desktop-endpoint", name: "Office", directAddresses: ["192.168.1.2:41414"],
    });
    r.sidecar.event({ type: "addresses", endpointId: "other-endpoint", directAddresses: ["192.168.1.3:51515"] });
    assert.deepEqual(discovery.current!.directAddresses, ["192.168.1.2:41414"]);
    name = "Renamed";
    r.remote.renamed();
    assert.equal(discovery.current!.name, "Renamed");
    r.sidecar.event({ type: "addresses", endpointId: "desktop-endpoint", directAddresses: [] });
    assert.equal(discovery.current, null);
    r.sidecar.event({ type: "addresses", endpointId: "desktop-endpoint", directAddresses: ["192.168.1.2:41415"] });
    assert.deepEqual(discovery.current!.directAddresses, ["192.168.1.2:41415"]);
    r.sidecar.event({ type: "peer_error", message: "incoming connection timed out" });
    assert.equal(r.remote.state(true).status, "online");
    assert.ok(discovery.current);
    await r.remote.stop();
    assert.equal(discovery.current, null);
    r.sidecar.event({ type: "addresses", endpointId: "desktop-endpoint", directAddresses: ["192.168.1.9:9"] });
    assert.equal(discovery.current, null);
    r.sidecar.endpointId = "new-endpoint";
    await r.remote.start();
    assert.equal(discovery.current, null);
    r.sidecar.event({ type: "addresses", endpointId: "desktop-endpoint", directAddresses: ["192.168.1.9:9"] });
    assert.equal(discovery.current, null);
    r.sidecar.event({ type: "addresses", endpointId: "new-endpoint", directAddresses: ["192.168.1.2:41416"] });
    assert.equal(discovery.current!.endpointId, "new-endpoint");
  } finally { await r.remote.dispose(); }
});

test("sign-out, sidecar error and exit withdraw discovery immediately and ignore late addresses", async (t) => {
  for (const action of ["signout", "error", "exit"] as const) await t.test(action, async () => {
    const discovery = new FakeDiscovery();
    const r = connection(async () => null, undefined, { discovery });
    try {
      await r.remote.start();
      r.sidecar.event({ type: "addresses", endpointId: "desktop-endpoint", directAddresses: ["192.168.1.2:44444"] });
      assert.ok(discovery.current);
      if (action === "signout") r.remote.setSignedOut(true);
      else if (action === "error") r.sidecar.emit("error", new Error("transport failed"));
      else r.sidecar.emit("exit");
      assert.equal(discovery.current, null);
      r.sidecar.event({ type: "addresses", endpointId: "desktop-endpoint", directAddresses: ["192.168.1.2:44445"] });
      assert.equal(discovery.current, null);
    } finally { await r.remote.dispose(); }
  });
});

test("stop during lease issuance prevents a late startup from advertising or becoming online", async () => {
  let resolveLease!: (value: typeof relayConfig) => void;
  const sidecar = new FakeSidecar();
  const discovery = new FakeDiscovery();
  const remote = new IrohRemoteConnection({
    account: {
      issueIrohRelay: () => new Promise((resolve) => { resolveLease = resolve; }),
      async reportIrohUsage() { return relayConfig.usage; },
    },
    deviceId: "desktop-device", identityFile: "/unused/endpoint.key", sidecar, discovery,
    authorizePeer: async () => null, attach() {}, log: { info() {}, warn() {} },
  });
  try {
    const start = remote.start();
    await tick();
    const stopped = remote.stop();
    resolveLease(relayConfig);
    await Promise.all([start, stopped]);
    assert.equal(remote.running, false);
    sidecar.event({ type: "started", endpointId: "desktop-endpoint", directAddresses: ["192.168.1.2:44444"] });
    assert.equal(discovery.current, null);
  } finally { await remote.dispose(); }
});
