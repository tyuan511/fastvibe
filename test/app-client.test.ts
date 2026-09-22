import assert from "node:assert/strict";
import test from "node:test";
import { APP_PROTOCOL, APP_PROTOCOL_VERSION } from "../src/shared/app-protocol.ts";
import { AppClient, type MessageTransport } from "../src/main/remote/app-client.ts";

class MemoryTransport implements MessageTransport {
  peer: MemoryTransport | null = null;
  sent: unknown[] = [];
  #messages = new Set<(message: unknown) => void>();
  #closes = new Set<(reason: string) => void>();
  #closed = false;

  send(message: unknown): void {
    if (this.#closed) throw new Error("closed");
    this.sent.push(message);
    this.peer?.deliver(message);
  }

  deliver(message: unknown): void {
    if (this.#closed) return;
    for (const listener of [...this.#messages]) listener(message);
  }

  onMessage(listener: (message: unknown) => void): () => void {
    this.#messages.add(listener);
    return () => this.#messages.delete(listener);
  }

  onClose(listener: (reason: string) => void): () => void {
    this.#closes.add(listener);
    return () => this.#closes.delete(listener);
  }

  close(): void {
    this.disconnect("closed");
  }

  disconnect(reason: string): void {
    if (this.#closed) return;
    this.#closed = true;
    for (const listener of [...this.#closes]) listener(reason);
  }
}

function pair(): { clientWire: MemoryTransport; serverWire: MemoryTransport } {
  const clientWire = new MemoryTransport();
  const serverWire = new MemoryTransport();
  clientWire.peer = serverWire;
  serverWire.peer = clientWire;
  return { clientWire, serverWire };
}

const IDENTITY = {
  serverInstanceId: "srv_test1",
  version: "0.7.0",
  platform: "linux",
} as const;

function handshake(over: Record<string, unknown> = {}) {
  return {
    protocol: APP_PROTOCOL,
    protocolVersion: APP_PROTOCOL_VERSION,
    server: IDENTITY,
    capabilities: ["engine", "conversations"],
    ...over,
  };
}

function welcome(over: Record<string, unknown> = {}) {
  const body = handshake();
  return {
    kind: "welcome",
    handshake: body,
    sessionId: "sess_abc",
    capabilities: body.capabilities,
    epoch: "ep1",
    ...over,
  };
}

function clientOf(clientWire: MemoryTransport) {
  return new AppClient(clientWire, {
    client: { kind: "test", version: "0.0.0" },
    handshakeTimeoutMs: 1_000,
  });
}

async function connected() {
  const { clientWire, serverWire } = pair();
  const app = clientOf(clientWire);
  const pending = app.connect();
  serverWire.send(welcome());
  const hs = await pending;
  return { app, clientWire, serverWire, handshake: hs };
}

test("handshake: exact v1 hello and welcome, connect promise is cached", async () => {
  const { clientWire, serverWire } = pair();
  const app = clientOf(clientWire);
  const first = app.connect();
  const second = app.connect();
  assert.equal(first, second);

  assert.equal(clientWire.sent.length, 1);
  const frame = clientWire.sent[0] as Record<string, unknown>;
  assert.equal(frame.kind, "hello");
  const hello = frame.hello as Record<string, unknown>;
  assert.equal(hello.protocol, APP_PROTOCOL);
  assert.equal(hello.protocolVersion, APP_PROTOCOL_VERSION);

  serverWire.send(welcome());
  const hs = await first;
  assert.equal(hs.protocolVersion, APP_PROTOCOL_VERSION);
  assert.equal(hs.server.serverInstanceId, "srv_test1");
  assert.equal(app.status.state, "ready");
  assert.equal(app.epoch, "ep1");
  assert.equal(await app.connect(), hs);
  assert.equal(clientWire.sent.length, 1);
});

test("handshake: mismatched protocol version is incompatible at once", async () => {
  const { clientWire, serverWire } = pair();
  const app = clientOf(clientWire);
  const pending = app.connect();
  serverWire.send(welcome({
    handshake: handshake({ protocolVersion: APP_PROTOCOL_VERSION + 1 }),
  }));
  await assert.rejects(pending, /协议版本不兼容/);
  assert.equal(app.status.state, "incompatible");
});

test("handshake: wrong protocol name is incompatible at once", async () => {
  const { clientWire, serverWire } = pair();
  const app = clientOf(clientWire);
  const pending = app.connect();
  serverWire.send(welcome({
    handshake: handshake({ protocol: "someone.else" }),
  }));
  await assert.rejects(pending, /协议版本不兼容/);
  assert.equal(app.status.state, "incompatible");
});

test("handshake: invalid welcome (no kind, no epoch, legacy frame) rejects promptly", async () => {
  const { clientWire, serverWire } = pair();
  const app = clientOf(clientWire);
  const pending = app.connect();
  serverWire.send({ handshake: handshake() });
  await assert.rejects(pending, /握手无效/);
  assert.equal(app.status.state, "error");

  const again = pair();
  const app2 = clientOf(again.clientWire);
  const pending2 = app2.connect();
  again.serverWire.send(welcome({ epoch: "" }));
  await assert.rejects(pending2, /握手无效/);

  const third = pair();
  const app3 = clientOf(third.clientWire);
  const pending3 = app3.connect();
  third.serverWire.send({ kind: "event", scope: "installation", seq: 1, channel: "x", epoch: "ep1" });
  await assert.rejects(pending3, /握手无效/);
});

test("handshake: disconnect during hello rejects promptly", async () => {
  const { clientWire } = pair();
  const app = clientOf(clientWire);
  const pending = app.connect();
  clientWire.disconnect("peer gone");
  await assert.rejects(pending, /peer gone/);
  assert.equal(app.status.state, "error");
});

test("reconnect is rejected after close and after a failed handshake", async () => {
  const { app } = await connected();
  app.close();
  assert.equal(app.status.state, "closed");
  await assert.rejects(() => app.connect(), /已关闭/);
  await assert.rejects(() => app.call("engine:get-state"), /已关闭/);

  const failed = pair();
  const app2 = clientOf(failed.clientWire);
  const pending = app2.connect();
  failed.clientWire.disconnect("no");
  await assert.rejects(pending);
  await assert.rejects(() => app2.connect(), /已关闭/);
});

test("call is refused until ready, then round-trips result", async () => {
  const { clientWire, serverWire } = pair();
  const app = clientOf(clientWire);
  await assert.rejects(() => app.call("engine:get-state"), /尚未就绪/);

  const pending = app.connect();
  await assert.rejects(() => app.call("engine:get-state"), /尚未就绪/);
  serverWire.send(welcome());
  await pending;

  const result = app.call("engine:get-state", { conversationId: "c1" });
  const frame = clientWire.sent.at(-1) as Record<string, unknown>;
  assert.equal(frame.kind, "call");
  assert.equal(frame.method, "engine:get-state");
  assert.equal(typeof frame.requestId, "number");
  serverWire.send({ kind: "result", requestId: frame.requestId, ok: true, result: { ok: 1 } });
  assert.deepEqual(await result, { ok: 1 });
});

test("pending cleanup: timeout sends cancel and a late result is abandoned, not aborted", async () => {
  const { app, clientWire, serverWire } = await connected();
  const pending = app.call("slow", {}, { timeoutMs: 40 });
  const call = clientWire.sent.find((item) => (item as { kind?: string }).kind === "call") as { requestId: number };
  await assert.rejects(pending, /响应超时/);
  const cancel = clientWire.sent.find((item) => (item as { kind?: string }).kind === "cancel") as Record<string, unknown>;
  assert.ok(cancel);
  assert.equal(cancel.targetRequestId, call.requestId);
  assert.equal(cancel.reason, "timeout");
  assert.equal(String(cancel.reason).includes("abort"), false);

  let settled = false;
  pending.then(() => {
    settled = true;
  }, () => {
    settled = true;
  });
  serverWire.send({ kind: "result", requestId: call.requestId, ok: true, result: "late" });
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(settled, true);
});

test("pending cleanup: disconnect rejects in-flight calls", async () => {
  const { app, clientWire } = await connected();
  const pending = app.call("engine:get-state");
  clientWire.disconnect("dropped");
  await assert.rejects(pending, /已断开/);
});

test("subscribe carries epoch and since; duplicate events per epoch+scope are dropped", async () => {
  const { app, clientWire, serverWire } = await connected();
  const pushes: Array<{ channel: string; payload: unknown }> = [];
  app.onPush((channel, payload) => pushes.push({ channel, payload }));

  app.subscribe(["installation"], { installation: 4 });
  const sub = clientWire.sent.at(-1) as Record<string, unknown>;
  assert.equal(sub.kind, "subscribe");
  assert.equal(sub.epoch, "ep1");
  assert.deepEqual(sub.scopes, ["installation"]);
  assert.deepEqual(sub.since, { installation: { epoch: "ep1", seq: 4 } });
  assert.deepEqual(app.cursors(), { installation: 4 });

  serverWire.send({
    kind: "event",
    scope: "installation",
    seq: 4,
    eventId: "e4",
    channel: "workspace:changed",
    payload: { n: 4 },
    epoch: "ep1",
  });
  serverWire.send({
    kind: "event",
    scope: "installation",
    seq: 5,
    eventId: "e5",
    channel: "workspace:changed",
    payload: { n: 5 },
    epoch: "ep1",
  });
  serverWire.send({
    kind: "event",
    scope: "installation",
    seq: 5,
    eventId: "e5",
    channel: "workspace:changed",
    payload: { n: 5 },
    epoch: "ep1",
  });
  serverWire.send({
    kind: "event",
    scope: "installation",
    seq: 1,
    eventId: "e1",
    channel: "workspace:changed",
    payload: { n: 1 },
    epoch: "ep2",
  });
  assert.equal(pushes.length, 1);
  assert.deepEqual(pushes[0], { channel: "workspace:changed", payload: { n: 5 } });
  assert.equal(app.epoch, "ep1");
  assert.deepEqual(app.cursors(), { installation: 5 });
});

test("subscribe since does not adopt an older cursor epoch", async () => {
  const { app, clientWire } = await connected();
  app.subscribe(["installation"], { installation: { epoch: "old-ep", seq: 9 } }, "old-ep");
  assert.equal(app.epoch, "ep1");
  assert.deepEqual(app.cursors(), {});
  const sub = clientWire.sent.at(-1) as Record<string, unknown>;
  assert.equal(sub.epoch, "ep1");
  assert.deepEqual(sub.since, { installation: { epoch: "old-ep", seq: 9 } });
});

test("epoch mismatch event resyncs and does not apply old state", async () => {
  const { app, serverWire } = await connected();
  const pushes: unknown[] = [];
  const resyncs: unknown[] = [];
  app.onPush((_channel, payload) => pushes.push(payload));
  app.onResync((resync) => resyncs.push(resync));
  app.subscribe(["installation"]);
  serverWire.send({
    kind: "event",
    scope: "installation",
    seq: 1,
    eventId: "e1",
    channel: "workspace:changed",
    payload: { n: 1 },
    epoch: "ep1",
  });
  serverWire.send({
    kind: "event",
    scope: "installation",
    seq: 1,
    eventId: "e1b",
    channel: "workspace:changed",
    payload: { n: "stale" },
    epoch: "ep-other",
  });
  assert.deepEqual(pushes, [{ n: 1 }]);
  assert.deepEqual(resyncs, [{ scope: "installation", reason: "事件纪元不匹配", epoch: "ep-other" }]);
  assert.equal(app.epoch, "ep1");
  assert.deepEqual(app.cursors(), { installation: 1 });
});

test("a failed push reducer does not advance the cursor", async () => {
  const { app, serverWire } = await connected();
  let boom = true;
  const payloads: unknown[] = [];
  app.onPush((_channel, payload) => {
    if (boom) throw new Error("reducer failed");
    payloads.push(payload);
  });
  app.subscribe(["installation"]);
  serverWire.send({
    kind: "event",
    scope: "installation",
    seq: 1,
    eventId: "e1",
    channel: "workspace:changed",
    payload: { n: 1 },
    epoch: "ep1",
  });
  assert.deepEqual(app.cursors(), {});
  boom = false;
  serverWire.send({
    kind: "event",
    scope: "installation",
    seq: 1,
    eventId: "e1",
    channel: "workspace:changed",
    payload: { n: 1 },
    epoch: "ep1",
  });
  assert.deepEqual(payloads, [{ n: 1 }]);
  assert.deepEqual(app.cursors(), { installation: 1 });
});

test("empty welcome capabilities stay empty; invalid seq is ignored", async () => {
  const { clientWire, serverWire } = pair();
  const app = clientOf(clientWire);
  const pending = app.connect();
  serverWire.send(welcome({ capabilities: [] }));
  await pending;
  assert.deepEqual(app.capabilities, []);
  assert.equal(app.supports("engine"), false);

  const pushes: unknown[] = [];
  app.onPush((_channel, payload) => pushes.push(payload));
  app.subscribe(["installation"]);
  for (const seq of [Number.NaN, 1.5, -1, Number.POSITIVE_INFINITY, "1"]) {
    serverWire.send({
      kind: "event",
      scope: "installation",
      seq,
      eventId: "bad",
      channel: "workspace:changed",
      payload: { seq },
      epoch: "ep1",
    });
  }
  assert.deepEqual(pushes, []);
  assert.deepEqual(app.cursors(), {});
  assert.equal(app.epoch, "ep1");
});

test("resync notifies and clears the scope cursor so the next seq is not treated as a duplicate", async () => {
  const { app, serverWire } = await connected();
  const pushes: unknown[] = [];
  const resyncs: unknown[] = [];
  app.onPush((_channel, payload) => pushes.push(payload));
  app.onResync((resync) => resyncs.push(resync));
  app.subscribe(["installation"]);

  serverWire.send({
    kind: "event",
    scope: "installation",
    seq: 9,
    eventId: "e9",
    channel: "workspace:changed",
    payload: { n: 9 },
    epoch: "ep1",
  });
  serverWire.send({ kind: "resync", scope: "installation", reason: "gap", epoch: "ep1" });
  serverWire.send({
    kind: "event",
    scope: "installation",
    seq: 9,
    eventId: "e9b",
    channel: "workspace:changed",
    payload: { n: "again" },
    epoch: "ep1",
  });

  assert.deepEqual(resyncs, [{ scope: "installation", reason: "gap", epoch: "ep1" }]);
  assert.deepEqual(pushes, [{ n: 9 }, { n: "again" }]);
});

test("a failed result rejects with the server message; unknown frames after ready are ignored", async () => {
  const { app, clientWire, serverWire } = await connected();
  const pending = app.call("engine:get-state");
  const id = (clientWire.sent.at(-1) as { requestId: number }).requestId;
  serverWire.send({ kind: "pong" });
  serverWire.send({ kind: "result", requestId: id, ok: false, error: { code: "x", message: "没有这个方法" } });
  await assert.rejects(pending, /没有这个方法/);
});

test("subscribe accepts canonical since cursors as well as numeric watermarks", async () => {
  const { app, clientWire } = await connected();
  app.subscribe(["installation"], { installation: { epoch: "ep1", seq: 7 } });
  const sub = clientWire.sent.at(-1) as Record<string, unknown>;
  assert.deepEqual(sub.since, { installation: { epoch: "ep1", seq: 7 } });
  assert.deepEqual(app.cursors(), { installation: 7 });
});

test("onStatus replays a terminal state to a late subscriber once", async () => {
  const { app } = await connected();
  app.close();
  const seen: string[] = [];
  app.onStatus((status) => seen.push(status.state));
  assert.deepEqual(seen, ["closed"]);
});
