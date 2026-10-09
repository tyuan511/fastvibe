import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { WebSocketServer, type WebSocket } from "ws";
import { SignalingClient, type SignalingEvents, type SignalingStop, type SignalingStatus } from "../src/main/rtc/signaling.ts";

/** The desktop's signaling client against a stand-in for the cloud's /api/rtc/signal. */

const silent = { info: () => undefined, warn: () => undefined };

type Cloud = {
  origin: string;
  sockets: WebSocket[];
  requests: IncomingMessage[];
  received: Array<Record<string, unknown>>;
  /** Refuse the upgrade with this status instead of accepting it. */
  refuse: number | null;
  close(): Promise<void>;
};

async function startCloud(): Promise<Cloud> {
  const wss = new WebSocketServer({ noServer: true });
  const cloud: Cloud = {
    origin: "",
    sockets: [],
    requests: [],
    received: [],
    refuse: null,
    close: async () => {
      for (const socket of cloud.sockets) socket.terminate();
      wss.close();
      await new Promise<void>((settle) => server.close(() => settle()));
    },
  };
  const server: Server = createServer();
  server.on("upgrade", (request, socket, head) => {
    cloud.requests.push(request);
    if (cloud.refuse !== null) {
      socket.write(`HTTP/1.1 ${cloud.refuse} Refused\r\nContent-Length: 0\r\nConnection: close\r\n\r\n`);
      socket.destroy();
      return;
    }
    wss.handleUpgrade(request, socket, head, (ws) => {
      cloud.sockets.push(ws);
      ws.on("message", (raw) => {
        const message = JSON.parse(String(raw)) as Record<string, unknown>;
        cloud.received.push(message);
        if (message.type === "hello") ws.send(JSON.stringify({ type: "hello", role: "device" }));
      });
    });
  });
  await new Promise<void>((settle) => server.listen(0, "127.0.0.1", settle));
  cloud.origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return cloud;
}

function events() {
  const log = {
    statuses: [] as SignalingStatus[],
    incoming: [] as Array<{ cid: string; name: string; platform?: string }>,
    signals: [] as Array<{ cid: string; data: unknown }>,
    hangups: [] as string[],
    stopped: [] as SignalingStop[],
  };
  const handlers: SignalingEvents = {
    status: (s) => log.statuses.push(s),
    incoming: (cid, peer) => log.incoming.push({ cid, ...peer }),
    signal: (cid, data) => log.signals.push({ cid, data }),
    hangup: (cid) => log.hangups.push(cid),
    stopped: (r) => log.stopped.push(r),
  };
  return { log, handlers };
}

async function until(condition: () => boolean, what: string, ms = 3000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((settle) => setTimeout(settle, 5));
  }
}

function client(cloud: Cloud, handlers: SignalingEvents, over: Partial<ConstructorParameters<typeof SignalingClient>[0]> = {}) {
  return new SignalingClient({
    origin: cloud.origin,
    token: () => "fvs_token",
    deviceId: "dev-1",
    platform: "darwin",
    events: handlers,
    log: silent,
    backoffMs: [20, 20, 20],
    ...over,
  });
}

test("it connects with the bearer token, says hello as the device, and goes online", async () => {
  const cloud = await startCloud();
  const { log, handlers } = events();
  const c = client(cloud, handlers);
  c.start();
  await until(() => c.status === "online", "online");
  assert.equal(cloud.requests[0].headers.authorization, "Bearer fvs_token");
  assert.equal(cloud.requests[0].url, "/api/rtc/signal");
  assert.deepEqual(cloud.received[0], { type: "hello", role: "device", device_id: "dev-1", platform: "darwin" });
  assert.deepEqual(log.statuses, ["connecting", "online"]);
  c.stop();
  await cloud.close();
});

test("calls arrive as events, and signals go back on the same call", async () => {
  const cloud = await startCloud();
  const { log, handlers } = events();
  const c = client(cloud, handlers);
  c.start();
  await until(() => c.status === "online", "online");
  cloud.sockets[0].send(JSON.stringify({ type: "incoming", cid: "c1", peer: { name: "Ada's iPhone", platform: "ios" } }));
  cloud.sockets[0].send(JSON.stringify({ type: "signal", cid: "c1", data: { type: "offer", sdp: "v=0" } }));
  cloud.sockets[0].send(JSON.stringify({ type: "hangup", cid: "c1" }));
  await until(() => log.hangups.length === 1, "hangup");
  assert.deepEqual(log.incoming, [{ cid: "c1", name: "Ada's iPhone", platform: "ios" }]);
  assert.deepEqual(log.signals, [{ cid: "c1", data: { type: "offer", sdp: "v=0" } }]);

  assert.equal(c.signal("c1", { type: "answer", sdp: "v=0" }), true);
  assert.equal(c.hangup("c1"), true);
  await until(() => cloud.received.length === 3, "outbound");
  assert.deepEqual(cloud.received[1], { type: "signal", cid: "c1", data: { type: "answer", sdp: "v=0" } });
  assert.deepEqual(cloud.received[2], { type: "hangup", cid: "c1" });
  c.stop();
  await cloud.close();
});

test("a dropped connection is retried and says hello again", async () => {
  const cloud = await startCloud();
  const { handlers } = events();
  const c = client(cloud, handlers);
  c.start();
  await until(() => c.status === "online", "online");
  cloud.sockets[0].terminate();
  await until(() => cloud.sockets.length === 2 && c.status === "online", "reconnected");
  assert.equal(cloud.received.filter((m) => m.type === "hello").length, 2);
  c.stop();
  await cloud.close();
});

test("sending while down reports the loss instead of pretending", async () => {
  const cloud = await startCloud();
  const { handlers } = events();
  const c = client(cloud, handlers);
  assert.equal(c.signal("c1", {}), false);
  c.start();
  await until(() => c.status === "online", "online");
  c.stop();
  assert.equal(c.signal("c1", {}), false);
  await cloud.close();
});

test("being replaced, or removed, ends it for good — no fighting for the seat", async () => {
  for (const [code, reason] of [[4001, "replaced"], [4005, "removed"]] as const) {
    const cloud = await startCloud();
    const { log, handlers } = events();
    const c = client(cloud, handlers);
    c.start();
    await until(() => c.status === "online", "online");
    cloud.sockets[0].close(code, "x");
    await until(() => log.stopped.length === 1, "stopped");
    assert.deepEqual(log.stopped, [reason]);
    await new Promise((settle) => setTimeout(settle, 100));
    assert.equal(cloud.sockets.length, 1, "it must not reconnect");
    await cloud.close();
  }
});

test("a refused token stops it; a server error only retries", async () => {
  const cloud = await startCloud();
  const { log, handlers } = events();
  cloud.refuse = 401;
  const c = client(cloud, handlers);
  c.start();
  await until(() => log.stopped.length === 1, "stopped");
  assert.deepEqual(log.stopped, ["unauthorized"]);

  const again = events();
  cloud.refuse = 502;
  const retrying = client(cloud, again.handlers);
  retrying.start();
  await until(() => cloud.requests.length >= 4, "retries");
  assert.deepEqual(again.log.stopped, []);
  retrying.stop();
  await cloud.close();
});

test("no token means unauthorized without dialling", async () => {
  const cloud = await startCloud();
  const { log, handlers } = events();
  client(cloud, handlers, { token: () => null }).start();
  assert.deepEqual(log.stopped, ["unauthorized"]);
  assert.equal(cloud.requests.length, 0);
  await cloud.close();
});

test("a device the account does not have stops it, so the owner can register again", async () => {
  const cloud = await startCloud();
  const { log, handlers } = events();
  const c = client(cloud, handlers);
  c.start();
  await until(() => c.status === "online", "online");
  cloud.sockets[0].send(JSON.stringify({ type: "error", code: "device_not_found", message: "no such device" }));
  await until(() => log.stopped.length === 1, "stopped");
  assert.deepEqual(log.stopped, ["unknown-device"]);
  await cloud.close();
});

test("a connection that goes silent is dropped and re-dialled", async () => {
  const cloud = await startCloud();
  const { handlers } = events();
  const c = client(cloud, handlers, { silenceMs: 80 });
  c.start();
  await until(() => c.status === "online", "online");
  await until(() => cloud.sockets.length >= 2, "re-dial after silence");
  c.stop();
  await cloud.close();
});

test("stop is final", async () => {
  const cloud = await startCloud();
  const { log, handlers } = events();
  const c = client(cloud, handlers);
  c.start();
  await until(() => c.status === "online", "online");
  c.stop();
  assert.equal(c.status, "offline");
  await new Promise((settle) => setTimeout(settle, 100));
  assert.equal(cloud.sockets.length, 1);
  assert.deepEqual(log.stopped, []);
  await cloud.close();
});
