import assert from "node:assert/strict";
import test from "node:test";
import { AppServer, MAX_IDEMPOTENCY, type AppCallContext } from "../src/main/app-server/app-server.ts";
import { DESKTOP_CAPABILITIES, HEADLESS_CAPABILITIES } from "../src/main/app-server/capabilities.ts";
import { EventBus } from "../src/main/app-server/event-bus.ts";
import {
  ALL_SCOPES,
  APP_PROTOCOL,
  APP_PROTOCOL_VERSION,
  type AppServerMessage,
} from "../src/shared/app-protocol.ts";
import { Ipc } from "../src/shared/ipc.ts";

const identity = { serverInstanceId: "srv_test1", version: "0.7.0", platform: "darwin" };

const hello = {
  kind: "hello" as const,
  hello: {
    protocol: APP_PROTOCOL,
    protocolVersion: APP_PROTOCOL_VERSION,
    client: { kind: "browser", version: "0.7.0" },
  },
};

type Capture = { messages: AppServerMessage[]; ctx: AppCallContext[]; methods: string[] };

function createHarness(options?: {
  dispatch?: (method: string, payload: unknown, ctx: AppCallContext) => Promise<unknown>;
  capabilities?: readonly typeof DESKTOP_CAPABILITIES[number][];
  bus?: EventBus;
  kind?: "window" | "remote";
  origin?: string;
  window?: unknown;
  subject?: string;
}): { server: AppServer; session: ReturnType<AppServer["attach"]>; cap: Capture } {
  const cap: Capture = { messages: [], ctx: [], methods: [] };
  const server = new AppServer({
    identity,
    capabilities: options?.capabilities ?? DESKTOP_CAPABILITIES,
    channels: () => [Ipc.enginePrompt, Ipc.workspacePick, Ipc.providersFetch, Ipc.remoteGetState],
    bus: options?.bus,
    dispatch: async (method, payload, ctx) => {
      cap.methods.push(method);
      cap.ctx.push(ctx);
      if (options?.dispatch) return options.dispatch(method, payload, ctx);
      return { method, payload };
    },
  });
  const session = server.attach({
    identity: {
      subject: options?.subject ?? "device-1",
      kind: options?.kind ?? "remote",
      clientKind: "browser",
      clientVersion: "0.7.0",
    },
    send: (message) => {
      cap.messages.push(message);
      return true;
    },
    origin: options?.origin,
    window: options?.window,
  });
  return { server, session, cap };
}

test("attach does not welcome; exact v1 hello does", async () => {
  const { server, session, cap } = createHarness();
  assert.equal(session.handshaken, false);
  assert.equal(cap.messages.length, 0);
  assert.equal(await server.receive(session, hello), true);
  assert.equal(session.handshaken, true);
  const welcome = cap.messages[0];
  assert.ok(welcome && welcome.kind === "welcome");
  assert.equal(welcome.handshake.protocol, APP_PROTOCOL);
  assert.equal(welcome.handshake.protocolVersion, 1);
  assert.equal(welcome.sessionId, session.id);
  assert.equal(welcome.epoch, server.bus.epoch);
  assert.ok(welcome.capabilities.includes("engine"));
});

test("a non-v1 hello drops the session", async () => {
  const { server, session } = createHarness();
  const ok = await server.receive(session, {
    kind: "hello",
    hello: { protocol: APP_PROTOCOL, protocolVersion: 2, client: { kind: "browser", version: "1" } },
  });
  assert.equal(ok, false);
  assert.equal(server.sessionCount, 0);
});

test("calls before hello are not dispatched", async () => {
  const { server, session, cap } = createHarness();
  await server.receive(session, { kind: "call", requestId: 1, method: Ipc.enginePrompt });
  assert.equal(cap.methods.length, 0);
  assert.equal(cap.messages[0]?.kind, "result");
  if (cap.messages[0]?.kind === "result") {
    assert.equal(cap.messages[0].ok, false);
    assert.equal(cap.messages[0].error?.code, "protocol.not_ready");
  }
});

test("ping is allowed before hello", async () => {
  const { server, session, cap } = createHarness();
  await server.receive(session, { kind: "ping" });
  assert.deepEqual(cap.messages[0], { kind: "pong" });
});

test("dispatch context carries trusted attach window and origin", async () => {
  const window = { id: 7 };
  const { server, session, cap } = createHarness({ kind: "window", origin: "win-1", window });
  await server.receive(session, hello);
  await server.receive(session, { kind: "call", requestId: 1, method: Ipc.enginePrompt, payload: { n: 1 } });
  assert.equal(cap.ctx[0]?.window, window);
  assert.equal(cap.ctx[0]?.origin, "win-1");
  assert.equal(cap.ctx[0]?.kind, "window");
  assert.equal(cap.ctx[0]?.subject, "device-1");
});

test("remote calls still hit remote-policy after handshake", async () => {
  const { server, session, cap } = createHarness();
  await server.receive(session, hello);
  await server.receive(session, { kind: "call", requestId: 1, method: Ipc.workspacePick });
  await server.receive(session, { kind: "call", requestId: 2, method: Ipc.providersFetch });
  await server.receive(session, { kind: "call", requestId: 3, method: Ipc.remoteGetState });
  assert.equal(cap.methods.length, 0);
  const codes = cap.messages.filter((message) => message.kind === "result").map((message) => {
    return message.kind === "result" ? message.error?.code : undefined;
  });
  assert.deepEqual(codes, ["policy.denied", "policy.denied", "policy.administrative"]);
});

test("local window may call admin methods", async () => {
  const { server, session, cap } = createHarness({ kind: "window" });
  await server.receive(session, hello);
  await server.receive(session, { kind: "call", requestId: 1, method: Ipc.remoteGetState });
  assert.deepEqual(cap.methods, [Ipc.remoteGetState]);
});

test("publish happens once and except-origin is skipped", async () => {
  const bus = new EventBus({ epoch: "e0" });
  const a = createHarness({ bus, origin: "client-a" });
  const b = createHarness({ bus, origin: "client-b" });
  a.server.detach(a.session);
  const sessionA = a.session;
  const server = b.server;
  const sessionB = server.attach({
    identity: sessionA.identity,
    send: (message) => {
      a.cap.messages.push(message);
      return true;
    },
    origin: "client-a",
  });
  await server.receive(sessionB, hello);
  await server.receive(b.session, hello);
  await server.receive(sessionB, { kind: "subscribe", scopes: ["installation"] });
  await server.receive(b.session, { kind: "subscribe", scopes: ["installation"] });
  a.cap.messages.length = 0;
  b.cap.messages.length = 0;
  const event = server.publish("workspace:changed", { ok: true }, { except: "client-a" });
  assert.equal(event.kind, "event");
  if (event.kind === "event") {
    assert.equal(event.seq, 1);
    assert.equal(event.epoch, "e0");
  }
  assert.equal(a.cap.messages.length, 0);
  assert.equal(b.cap.messages.length, 1);
  assert.equal(b.cap.messages[0]?.kind, "event");
  assert.equal(server.bus.sequence("installation"), 1);
});

test("named subscribe replays; wildcard is live-only", async () => {
  const bus = new EventBus({ epoch: "e0" });
  const { server, session, cap } = createHarness({ bus });
  bus.publish("installation", "workspace:changed", { n: 1 });
  bus.publish("installation", "workspace:changed", { n: 2 });
  await server.receive(session, hello);
  cap.messages.length = 0;
  await server.receive(session, {
    kind: "subscribe",
    scopes: ["installation"],
    since: { installation: { epoch: "e0", seq: 1 } },
  });
  assert.equal(cap.messages.length, 1);
  assert.equal(cap.messages[0]?.kind, "event");
  if (cap.messages[0]?.kind === "event") assert.equal(cap.messages[0].seq, 2);

  const wild = createHarness({ bus });
  await wild.server.receive(wild.session, hello);
  wild.cap.messages.length = 0;
  await wild.server.receive(wild.session, {
    kind: "subscribe",
    scopes: [ALL_SCOPES],
    since: { [ALL_SCOPES]: { epoch: "e0", seq: 0 } },
  });
  assert.equal(wild.cap.messages.some((message) => message.kind === "event"), false);
  assert.equal(wild.cap.messages.some((message) => message.kind === "resync"), true);
  wild.cap.messages.length = 0;
  wild.server.publish("workspace:changed", { n: 3 });
  assert.equal(wild.cap.messages[0]?.kind, "event");
});

test("empty, pruned and future cursors resync", async () => {
  const bus = new EventBus({ epoch: "e0", maxPerScope: 1 });
  const { server, session, cap } = createHarness({ bus });
  await server.receive(session, hello);
  cap.messages.length = 0;
  await server.receive(session, {
    kind: "subscribe",
    scopes: ["installation"],
    since: { installation: { epoch: "e0", seq: 3 } },
  });
  assert.equal(cap.messages[0]?.kind, "resync");

  bus.publish("installation", "workspace:changed", 1);
  bus.publish("installation", "workspace:changed", 2);
  cap.messages.length = 0;
  await server.receive(session, {
    kind: "subscribe",
    scopes: ["installation"],
    since: { installation: { epoch: "e0", seq: 0 } },
  });
  assert.equal(cap.messages[0]?.kind, "resync");

  cap.messages.length = 0;
  await server.receive(session, {
    kind: "subscribe",
    scopes: ["installation"],
    since: { installation: { epoch: "old", seq: 2 } },
  });
  assert.equal(cap.messages[0]?.kind, "resync");
});

test("cancel abandons only that in-flight response", async () => {
  let release: (value: unknown) => void = () => undefined;
  const { server, session, cap } = createHarness({
    dispatch: () => new Promise((resolve) => {
      release = resolve;
    }),
  });
  await server.receive(session, hello);
  cap.messages.length = 0;
  const pending = server.receive(session, { kind: "call", requestId: 8, method: Ipc.enginePrompt });
  await server.receive(session, { kind: "cancel", targetRequestId: 8 });
  await server.receive(session, { kind: "cancel", targetRequestId: 99 });
  release({ done: true });
  await pending;
  assert.equal(cap.messages.length, 0);
});

test("idempotency is subject+key dedupe, bounded", async () => {
  let n = 0;
  const { server, session, cap } = createHarness({
    dispatch: async () => {
      n += 1;
      return n;
    },
    subject: "device-a",
  });
  await server.receive(session, hello);
  await server.receive(session, {
    kind: "call",
    requestId: 1,
    method: Ipc.enginePrompt,
    idempotencyKey: "k1",
  });
  await server.receive(session, {
    kind: "call",
    requestId: 2,
    method: Ipc.enginePrompt,
    idempotencyKey: "k1",
  });
  assert.equal(n, 1);
  const results = cap.messages.filter((message) => message.kind === "result");
  assert.equal(results.length, 2);
  if (results[0]?.kind === "result" && results[1]?.kind === "result") {
    assert.equal(results[0].result, 1);
    assert.equal(results[1].result, 1);
    assert.equal(results[1].requestId, 2);
  }

  const other = createHarness({
    dispatch: async () => {
      n += 1;
      return n;
    },
    subject: "device-b",
  });
  other.server.detach(other.session);
  const sessionB = server.attach({
    identity: { subject: "device-b", kind: "remote", clientKind: "browser", clientVersion: "1" },
    send: (message) => {
      other.cap.messages.push(message);
      return true;
    },
  });
  await server.receive(sessionB, hello);
  await server.receive(sessionB, {
    kind: "call",
    requestId: 1,
    method: Ipc.enginePrompt,
    idempotencyKey: "k1",
  });
  assert.equal(n, 2);
  assert.ok(MAX_IDEMPOTENCY >= 1);
});

test("idempotency authorizes before cache and rejects method/payload conflicts", async () => {
  const broad = createHarness({ subject: "same", capabilities: DESKTOP_CAPABILITIES });
  await broad.server.receive(broad.session, hello);
  await broad.server.receive(broad.session, { kind: "call", requestId: 1, method: Ipc.enginePrompt, payload: { a: 1 }, idempotencyKey: "same-key" });
  const narrow = broad.server.attach({
    identity: { subject: "same", kind: "remote", clientKind: "browser", clientVersion: "1" },
    send: (message) => { broad.cap.messages.push(message); return true; },
  });
  await broad.server.receive(narrow, { kind: "hello", hello: { ...hello.hello, capabilities: ["conversations"] } });
  await broad.server.receive(narrow, { kind: "call", requestId: 2, method: Ipc.enginePrompt, payload: { a: 1 }, idempotencyKey: "same-key" });
  await broad.server.receive(broad.session, { kind: "call", requestId: 3, method: Ipc.enginePrompt, payload: { a: 2 }, idempotencyKey: "same-key" });
  const results = broad.cap.messages.filter((m) => m.kind === "result");
  assert.equal(results.at(-2)?.kind, "result");
  if (results.at(-2)?.kind === "result") assert.equal(results.at(-2).error?.code, "capability.unsupported");
  if (results.at(-1)?.kind === "result") assert.equal(results.at(-1).error?.code, "idempotency.conflict");
});

test("invalid frames are ignored; unknown methods do not use the legacy shape", async () => {
  const { server, session, cap } = createHarness();
  await server.receive(session, hello);
  cap.messages.length = 0;
  assert.equal(await server.receive(session, { id: 1, method: Ipc.enginePrompt }), true);
  assert.equal(cap.methods.length, 0);
  assert.equal(cap.messages.length, 0);
});

test("two subscribers see the same event id from one publish", async () => {
  const { server, session, cap } = createHarness({ origin: "a" });
  const otherMessages: AppServerMessage[] = [];
  const other = server.attach({
    identity: { subject: "device-2", kind: "remote", clientKind: "browser", clientVersion: "1" },
    send: (message) => {
      otherMessages.push(message);
      return true;
    },
    origin: "b",
  });
  await server.receive(session, hello);
  await server.receive(other, hello);
  await server.receive(session, { kind: "subscribe", scopes: ["installation"] });
  await server.receive(other, { kind: "subscribe", scopes: ["installation"] });
  cap.messages.length = 0;
  otherMessages.length = 0;
  server.publish("workspace:changed", { v: 1 });
  assert.equal(cap.messages.length, 1);
  assert.equal(otherMessages.length, 1);
  assert.deepEqual(cap.messages[0], otherMessages[0]);
  assert.equal(server.bus.sequence("installation"), 1);
});

test("idempotency cache evicts the oldest key", async () => {
  let n = 0;
  const { server, session } = createHarness({
    dispatch: async () => {
      n += 1;
      return n;
    },
  });
  await server.receive(session, hello);
  for (let i = 0; i < MAX_IDEMPOTENCY + 1; i++) {
    await server.receive(session, {
      kind: "call",
      requestId: i,
      method: Ipc.enginePrompt,
      idempotencyKey: `k-${i}`,
    });
  }
  assert.equal(n, MAX_IDEMPOTENCY + 1);
  await server.receive(session, {
    kind: "call",
    requestId: 9000,
    method: Ipc.enginePrompt,
    idempotencyKey: "k-0",
  });
  assert.equal(n, MAX_IDEMPOTENCY + 2);
  await server.receive(session, {
    kind: "call",
    requestId: 9001,
    method: Ipc.enginePrompt,
    idempotencyKey: `k-${MAX_IDEMPOTENCY}`,
  });
  assert.equal(n, MAX_IDEMPOTENCY + 2);
});

test("a declaration cannot open headless-native methods", async () => {
  const { server, session, cap } = createHarness({
    capabilities: HEADLESS_CAPABILITIES,
  });
  await server.receive(session, {
    kind: "hello",
    hello: {
      protocol: APP_PROTOCOL,
      protocolVersion: 1,
      client: { kind: "browser", version: "1" },
      capabilities: ["native", "engine"],
    },
  });
  await server.receive(session, { kind: "query", requestId: 1, method: Ipc.updateGetState });
  const result = cap.messages.find((message) => message.kind === "result");
  assert.ok(result && result.kind === "result");
  assert.equal(result.ok, false);
  assert.equal(result.error?.code, "capability.unsupported");
});
