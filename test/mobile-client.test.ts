import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import { ConnectionError, HEALTH_INTERVAL_MS, HEALTH_TIMEOUT_MS, RemoteClient, TransportError, type DisconnectDetail } from "../apps/mobile/src/protocol/client.ts";
import { parseServerAddress } from "../apps/mobile/src/protocol/address.ts";
import { connectionDiagnostics, recordConnectionDiagnostic } from "../apps/mobile/src/protocol/diagnostics.ts";

class Socket {
  static OPEN = 1;
  static CLOSING = 2;
  static latest: Socket;
  readyState = 0;
  sent: Array<Record<string, unknown>> = [];
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: string }) => void) | null = null;
  onclose: ((event: { code: number; reason: string }) => void) | null = null;
  onerror: (() => void) | null = null;
  throwOnSend = false;
  constructor() { Socket.latest = this; }
  send(raw: string) {
    if (this.throwOnSend) throw new Error("socket gone");
    this.sent.push(JSON.parse(raw));
  }
  close() { this.readyState = 3; }
  open() { this.readyState = Socket.OPEN; this.onopen?.(); }
  receive(message: unknown) { this.onmessage?.({ data: JSON.stringify(message) }); }
  end(code = 1006, reason = "") { this.readyState = 3; this.onclose?.({ code, reason }); }
}

function harness(t: TestContext) {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: 1_000 });
  const original = globalThis.WebSocket;
  globalThis.WebSocket = Socket as unknown as typeof WebSocket;
  t.after(() => { globalThis.WebSocket = original; });
  const client = new RemoteClient("test-version");
  t.after(() => client.close());
  const disconnects: DisconnectDetail[] = [];
  client.onDisconnect((detail) => disconnects.push(detail));
  client.setActive(true);
  const start = () => {
    const ready = client.connect(parseServerAddress("https://example.test")!, "test-token");
    const socket = Socket.latest;
    socket.open();
    socket.receive({ type: "auth", ok: true });
    return { socket, ready };
  };
  return { client, disconnects, start };
}

test("an idle foreground socket probes and reconnects even if no native close arrives", async (t) => {
  const { client, disconnects, start } = harness(t);
  const { socket, ready } = start();
  socket.receive({ kind: "welcome" });
  await ready;
  t.mock.timers.tick(HEALTH_INTERVAL_MS);
  assert.equal(socket.sent.at(-1)?.kind, "ping");
  client.checkHealth();
  assert.equal(socket.sent.filter((frame) => frame.kind === "ping").length, 1);
  t.mock.timers.tick(HEALTH_TIMEOUT_MS);
  assert.deepEqual(disconnects, [{ kind: "heartbeat-timeout" }]);
  assert.equal(socket.readyState, 3);
});

test("auth and hello are sent together, while readiness still waits for both responses", async (t) => {
  const { client } = harness(t);
  let connected = false;
  const ready = client.connect(parseServerAddress("https://example.test")!, "test-token").then(() => { connected = true; });
  const socket = Socket.latest;
  socket.open();
  assert.deepEqual(socket.sent.map((frame) => frame.type ?? frame.kind), ["auth", "hello"]);
  socket.receive({ type: "auth", ok: true });
  await Promise.resolve(); assert.equal(connected, false);
  assert.equal(socket.sent.length, 2, "auth acknowledgement must not send a second hello");
  socket.receive({ kind: "welcome" }); await ready;
  assert.equal(connected, true);
});

test("a rejected pipelined authentication cannot become ready on a late welcome", async (t) => {
  const { client } = harness(t);
  const ready = client.connect(parseServerAddress("https://example.test")!, "bad-token");
  const rejected = assert.rejects(ready, (error: unknown) => error instanceof ConnectionError && error.code === "unauthorized");
  const socket = Socket.latest; socket.open();
  const late = socket.onmessage;
  socket.receive({ type: "auth", ok: false });
  late?.({ data: JSON.stringify({ kind: "welcome" }) });
  await rejected;
  assert.equal(socket.readyState, 3);
});

test("backgrounding cancels frozen probe deadlines; returning probes again", async (t) => {
  const { client, disconnects, start } = harness(t);
  const { socket, ready } = start();
  socket.receive({ kind: "welcome" });
  await ready;
  client.checkHealth();
  client.setActive(false);
  t.mock.timers.tick(120_000);
  assert.equal(disconnects.length, 0);
  assert.equal(socket.sent.filter((frame) => frame.kind === "ping").length, 1);
  client.setActive(true);
  assert.equal(socket.sent.filter((frame) => frame.kind === "ping").length, 2);
  socket.receive({ kind: "pong" });
  t.mock.timers.tick(HEALTH_TIMEOUT_MS);
  assert.equal(disconnects.length, 0);
});

test("incoming traffic defers idle probes and a queued pong does not break an active transfer", async (t) => {
  const { client, disconnects, start } = harness(t);
  const { socket, ready } = start();
  socket.receive({ kind: "welcome" });
  await ready;
  t.mock.timers.tick(HEALTH_INTERVAL_MS - 1);
  socket.receive({ kind: "event", channel: "engine:event", payload: {} });
  t.mock.timers.tick(1);
  assert.equal(socket.sent.some((frame) => frame.kind === "ping"), false);
  client.checkHealth();
  t.mock.timers.tick(HEALTH_TIMEOUT_MS - 1);
  socket.receive({ kind: "result", requestId: 0, ok: true });
  t.mock.timers.tick(1);
  assert.equal(disconnects.length, 0);
  for (let round = 0; round < 2; round++) {
    t.mock.timers.tick(HEALTH_TIMEOUT_MS - 1);
    socket.receive({ kind: "event", channel: "engine:event", payload: {} });
    t.mock.timers.tick(1);
  }
  assert.deepEqual(disconnects, [{ kind: "heartbeat-timeout" }], "inbound traffic must not hide a broken uplink forever");
});

test("an established socket error not followed by close rejects calls and notifies once", async (t) => {
  const { client, disconnects, start } = harness(t);
  const { socket, ready } = start();
  socket.receive({ kind: "welcome" });
  await ready;
  const pending = client.call("engine:queue-add", { text: "do this once" });
  const rejected = assert.rejects(pending, (error: unknown) => error instanceof TransportError && error.code === "dropped");
  const lateClose = socket.onclose;
  socket.onerror?.();
  lateClose?.({ code: 1006, reason: "" });
  await rejected;
  assert.deepEqual(disconnects, [{ kind: "socket-error" }]);
  assert.equal(socket.sent.filter((frame) => frame.method === "engine:queue-add").length, 1);
});

test("a request timeout probes without resending the possibly accepted request", async (t) => {
  const { client, disconnects, start } = harness(t);
  const { socket, ready } = start();
  socket.receive({ kind: "welcome" });
  await ready;
  const pending = client.call("engine:prompt", { text: "do this once" }, 100);
  const rejected = assert.rejects(pending, (error: unknown) => error instanceof TransportError && error.code === "timeout");
  t.mock.timers.tick(100);
  await rejected;
  assert.equal(socket.sent.at(-1)?.kind, "ping");
  socket.receive({ kind: "pong" });
  t.mock.timers.tick(100);
  assert.equal(disconnects.length, 0);
  assert.equal(socket.sent.filter((frame) => frame.method === "engine:prompt").length, 1);
});

test("retiring an in-flight connection settles it and stale callbacks cannot close its replacement", async (t) => {
  const { client, disconnects, start } = harness(t);
  const first = start();
  const firstRejection = assert.rejects(first.ready, TransportError);
  const lateError = first.socket.onerror;
  const second = start();
  second.socket.receive({ kind: "welcome" });
  await second.ready;
  await firstRejection;
  lateError?.();
  assert.equal(disconnects.length, 0);
  assert.equal(second.socket.readyState, Socket.OPEN);
  client.checkHealth();
  assert.equal(second.socket.sent.at(-1)?.kind, "ping");
});

test("backpressure, revoked-token and handshake close codes remain structured", async (t) => {
  const { disconnects, start } = harness(t);
  for (const [code, reason] of [[4004, "backpressure"], [4001, "device revoked"]] as const) {
    const { socket, ready } = start();
    socket.receive({ kind: "welcome" });
    await ready;
    socket.end(code, reason);
    assert.deepEqual(disconnects.at(-1), { kind: "socket-close", code, reason });
  }
  const { socket, ready } = start();
  socket.end(4001, "unauthorized");
  await assert.rejects(ready, (error: unknown) => error instanceof ConnectionError && error.detail?.code === 4001);
});

test("a failed subscription send enters recovery instead of silently losing its events", async (t) => {
  const { client, disconnects, start } = harness(t);
  const { socket, ready } = start();
  socket.receive({ kind: "welcome" });
  await ready;
  socket.throwOnSend = true;
  client.subscribe(["conversation:chat"]);
  assert.deepEqual(disconnects, [{ kind: "send-failed" }]);
});

test("a protocol resync closes the stale stream so reconnect will restore snapshots", async (t) => {
  const { disconnects, start } = harness(t);
  const { socket, ready } = start();
  socket.receive({ kind: "welcome" });
  await ready;
  socket.receive({ kind: "resync", reason: "journal-gap" });
  assert.deepEqual(disconnects, [{ kind: "resync" }]);
});

test("diagnostics retain the recent bounded history and structured close reason", () => {
  for (let attempt = 0; attempt < 120; attempt++) recordConnectionDiagnostic({ event: "connecting", attempt });
  recordConnectionDiagnostic({ event: "disconnected", detail: { kind: "socket-close", code: 4004, reason: "backpressure" } });
  const report = JSON.parse(connectionDiagnostics("test"));
  assert.equal(report.version, "test");
  assert.equal(report.entries.length, 100);
  assert.equal(report.entries[0].attempt, 21);
  assert.equal(report.entries.at(-1).detail.code, 4004);
});

test("a network-change probe closes a silent socket faster but tolerates a draining transfer", async (t) => {
  const { client, disconnects, start } = harness(t);
  const { socket, ready } = start(); socket.receive({ kind: "welcome" }); await ready;
  client.checkHealth(true);
  t.mock.timers.tick(3999);
  assert.equal(disconnects.length, 0);
  socket.receive({ kind: "event", channel: "engine:event", payload: {} });
  t.mock.timers.tick(1);
  assert.equal(disconnects.length, 0, "active progress must retain its normal grace period");
  t.mock.timers.tick(HEALTH_TIMEOUT_MS);
  assert.equal(disconnects[0]?.kind, "heartbeat-timeout");
});

test("subscription recovery keeps the socket on a journal gap and exposes metadata to the reducer", async (t) => {
  const { client, disconnects, start } = harness(t);
  const { socket, ready } = start();
  socket.receive({ kind: "welcome", epoch: "e", features: { conversationResume: true, promptSubmit: true } }); await ready;
  assert.equal(client.supportsPromptSubmit, true);
  const subscription = client.subscribeConversation("conversation:chat", { epoch: "e", seq: 1 });
  socket.receive({ kind: "resync", scope: "conversation:chat" });
  socket.receive({ kind: "subscribed", requestId: socket.sent.at(-1)?.requestId, cursors: { "conversation:chat": { epoch: "e", seq: 8 } } });
  assert.deepEqual(await subscription, { resumed: false, cursor: { epoch: "e", seq: 8 } });
  assert.equal(disconnects.length, 0);
  const events: unknown[] = [];
  client.onPush((_channel, _payload, meta) => events.push(meta));
  socket.receive({ kind: "events", events: [{ kind: "event", channel: "engine:event", scope: "conversation:chat", epoch: "e", seq: 9 }] });
  assert.deepEqual(events, [{ scope: "conversation:chat", epoch: "e", seq: 9 }]);
});

test("retiring a connection settles pending subscription acknowledgements", async (t) => {
  const { client, start } = harness(t);
  const { socket, ready } = start(); socket.receive({ kind: "welcome", features: { conversationResume: true } }); await ready;
  const subscription = client.subscribeConversation("conversation:chat");
  const rejected = assert.rejects(subscription, TransportError);
  client.close(); await rejected;
});

test("late subscription acknowledgements cannot complete a replacement watch", async (t) => {
  const { client, start } = harness(t);
  const { socket, ready } = start(); socket.receive({ kind: "welcome", epoch: "e", features: { conversationResume: true } }); await ready;
  const old = client.subscribeConversation("conversation:chat");
  const rejected = assert.rejects(old, TransportError);
  const oldId = socket.sent.at(-1)?.requestId;
  client.unsubscribe(["conversation:chat"]); await rejected;
  let settled = false;
  const current = client.subscribeConversation("conversation:chat").then((value) => { settled = true; return value; });
  const requestId = socket.sent.at(-1)?.requestId;
  socket.receive({ kind: "subscribed", requestId: oldId, cursors: { "conversation:chat": { epoch: "e", seq: 1 } } });
  await Promise.resolve(); assert.equal(settled, false);
  socket.receive({ kind: "subscribed", requestId, cursors: { "conversation:chat": { epoch: "e", seq: 2 } } });
  assert.equal((await current).cursor?.seq, 2);
});

test("a network change accelerates an existing idle probe without sending another ping", async (t) => {
  const { client, disconnects, start } = harness(t);
  const { socket, ready } = start(); socket.receive({ kind: "welcome" }); await ready;
  client.checkHealth(); t.mock.timers.tick(1000); client.checkHealth(true);
  assert.equal(socket.sent.filter((frame) => frame.kind === "ping").length, 1);
  t.mock.timers.tick(3000);
  assert.equal(disconnects[0]?.kind, "heartbeat-timeout");
});

test("RPC metrics are bounded separately and cannot evict connection-failure diagnostics", () => {
  recordConnectionDiagnostic({ event: "disconnected", detail: { kind: "heartbeat-timeout" } });
  for (let elapsedMs = 1; elapsedMs <= 1000; elapsedMs++) recordConnectionDiagnostic({ event: "metric", metric: "snapshot", elapsedMs, frameChars: 100 });
  const report = JSON.parse(connectionDiagnostics("test"));
  assert.equal(report.entries.at(-1).detail.kind, "heartbeat-timeout");
  assert.equal(report.timings.snapshot.samples.length, 32);
  assert.equal(report.timings.snapshot.p95Ms, 999);
  assert.equal(report.timings.snapshot.samples[0].elapsedMs, 969);
});
