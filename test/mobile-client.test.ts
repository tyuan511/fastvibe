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
