import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RemoteServer } from "../src/main/server/server.ts";
import { ChannelSocket } from "../src/main/rtc/channel-socket.ts";
import { APP_PROTOCOL, APP_PROTOCOL_VERSION } from "../src/shared/app-protocol.ts";
import { Ipc } from "../src/shared/ipc.ts";
import { registeredChannels } from "./registered-channels.ts";
import { FakeChannelPair } from "./rtc-fake-channel.ts";

/**
 * A connection that something else authenticated — the official remote connection's
 * data channel — joining the remote server. It must get the App Protocol and the policy
 * like any other, and need neither the listener nor a password.
 */

const silent = { info: () => undefined, warn: () => undefined, error: () => undefined };

async function withServer(fn: (h: { server: RemoteServer; dispatched: string[]; changes: () => number }) => Promise<void>) {
  const dir = await mkdtemp(join(tmpdir(), "fastvibe-rtc-attach-"));
  const dispatched: string[] = [];
  let changes = 0;
  const server = new RemoteServer({
    // No password has ever been set: this door does not use one.
    accessFile: join(dir, "remote-access.json"),
    channels: () => registeredChannels(),
    dispatch: async (method) => {
      dispatched.push(method);
      return { echoed: method, blob: method === Ipc.settingsGet ? "x".repeat(1_500_000) : undefined };
    },
    subscribe: () => () => undefined,
    onStatusChange: () => { changes += 1; },
    log: silent,
    heartbeatMs: 40,
  });
  try {
    await fn({ server, dispatched, changes: () => changes });
  } finally {
    await server.stop();
    await rm(dir, { recursive: true, force: true });
  }
}

function phone(server: RemoteServer, label = "Ada's iPhone") {
  const { a, b } = FakeChannelPair.create();
  const host = new ChannelSocket(a, { maxFrameBytes: 24 * 1024 * 1024 });
  const remote = new ChannelSocket(b, { maxFrameBytes: 24 * 1024 * 1024 });
  server.attachTransport(host, { id: "rtc:test-peer", label });
  const frames: Array<Record<string, unknown>> = [];
  const waiters: Array<() => void> = [];
  remote.on("message", (data: Buffer) => {
    frames.push(JSON.parse(data.toString("utf8")) as Record<string, unknown>);
    waiters.splice(0).forEach((w) => w());
  });
  const next = async (match: (f: Record<string, unknown>) => boolean): Promise<Record<string, unknown>> => {
    const deadline = Date.now() + 3000;
    for (;;) {
      const index = frames.findIndex(match);
      if (index >= 0) return frames.splice(index, 1)[0];
      if (Date.now() > deadline) throw new Error("timed out waiting for a frame");
      await new Promise<void>((settle) => { waiters.push(settle); setTimeout(settle, 50); });
    }
  };
  const send = (frame: unknown) => remote.send(JSON.stringify(frame));
  return { host, remote, next, send, frames };
}

const hello = {
  kind: "hello",
  hello: { protocol: APP_PROTOCOL, protocolVersion: APP_PROTOCOL_VERSION, client: { kind: "mobile", version: "0.0.0" } },
};

test("an attached connection is told it is authenticated, then speaks the App Protocol", async () => {
  await withServer(async ({ server, dispatched }) => {
    const p = phone(server);
    const auth = await p.next((f) => f.type === "auth");
    assert.equal(auth.ok, true);
    assert.deepEqual(auth.device, { id: "rtc:test-peer", label: "Ada's iPhone" });

    p.send(hello);
    assert.equal((await p.next((f) => f.kind === "welcome")).kind, "welcome");

    p.send({ kind: "call", requestId: 1, method: Ipc.engineGetStatus });
    const reply = await p.next((f) => f.kind === "result");
    assert.equal(reply.ok, true);
    assert.deepEqual(dispatched, [Ipc.engineGetStatus]);
  });
});

test("it works with the listener off and no password set", async () => {
  await withServer(async ({ server }) => {
    assert.equal(server.status.running, false);
    assert.equal(server.status.configured, false);
    const p = phone(server);
    await p.next((f) => f.type === "auth");
    assert.equal(server.status.clients, 1);
  });
});

test("a reply well past one data channel message comes through intact", async () => {
  await withServer(async ({ server }) => {
    const p = phone(server);
    await p.next((f) => f.type === "auth");
    p.send(hello);
    await p.next((f) => f.kind === "welcome");
    p.send({ kind: "call", requestId: 7, method: Ipc.settingsGet });
    const reply = await p.next((f) => f.kind === "result");
    assert.equal(reply.ok, true);
    assert.equal(((reply.result as { blob: string }).blob).length, 1_500_000);
  });
});

test("the policy applies here exactly as on the WebSocket", async () => {
  await withServer(async ({ server, dispatched }) => {
    const p = phone(server);
    await p.next((f) => f.type === "auth");
    p.send(hello);
    await p.next((f) => f.kind === "welcome");
    // `remote:*` is denied to every remote caller, so a stolen phone cannot lock the owner out.
    p.send({ kind: "call", requestId: 2, method: Ipc.remoteStop });
    const reply = await p.next((f) => f.kind === "result");
    assert.equal(reply.ok, false);
    assert.deepEqual(dispatched, []);
  });
});

test("revoking a device by id closes its connection", async () => {
  await withServer(async ({ server }) => {
    const p = phone(server);
    await p.next((f) => f.type === "auth");
    const closed = new Promise<number>((settle) => p.remote.once("close", (code: number) => settle(code)));
    server.disconnectDevice("rtc:test-peer");
    assert.equal(await closed, 4001);
  });
});

test("stopping the listener leaves an attached connection up, and the heartbeat keeps it alive", async () => {
  await withServer(async ({ server }) => {
    await server.start({ port: 0, host: "127.0.0.1" }).catch(() => undefined); // no password: refuses, which is fine
    const p = phone(server);
    await p.next((f) => f.type === "auth");
    await server.stop();
    assert.equal(server.status.clients, 1);
    // Several heartbeat rounds (40 ms) with the pong answered by the adapter: still here.
    await new Promise((settle) => setTimeout(settle, 250));
    assert.equal(server.status.clients, 1);
    assert.equal(p.host.readyState, 1);
  });
});

test("a connection that stops answering is dropped by the heartbeat", async () => {
  await withServer(async ({ server }) => {
    const { a, b } = FakeChannelPair.create();
    const host = new ChannelSocket(a, { maxFrameBytes: 1 << 20 });
    new ChannelSocket(b, { maxFrameBytes: 1 << 20 });
    server.attachTransport(host, { id: "rtc:silent", label: "silent" });
    b.muted = true; // the far end stops answering, as a phone that left the network does
    await new Promise((settle) => setTimeout(settle, 300));
    assert.equal(server.status.clients, 0);
    assert.equal(host.readyState, 3);
  });
});
