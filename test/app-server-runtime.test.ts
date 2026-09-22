import assert from "node:assert/strict";
import test from "node:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import WebSocket from "ws";
import { AppServer } from "../src/main/app-server/app-server.ts";
import {
  createAppServer,
  getAppServer,
  initAppServer,
  resetAppServerRuntime,
} from "../src/main/app-server/runtime.ts";
import { broadcast, observe, subscribe, subscriberCount } from "../src/main/ipc/broadcast.ts";
import { loadOrCreateServerIdentity } from "../src/main/server/identity.ts";
import { RemoteServer } from "../src/main/server/server.ts";
import { setPassword } from "../src/main/server/store.ts";
import { AppClient, type MessageTransport } from "../src/main/remote/app-client.ts";
import { attachWindowSession } from "../src/main/transport/window-session.ts";
import { APP_PROTOCOL, APP_PROTOCOL_VERSION } from "../src/shared/app-protocol.ts";
import { Ipc } from "../src/shared/ipc.ts";
import { registeredChannels } from "./registered-channels.ts";

const identity = { serverInstanceId: "srv_runtime1", version: "0.7.0", platform: "darwin" };
const hello = {
  kind: "hello" as const,
  hello: {
    protocol: APP_PROTOCOL,
    protocolVersion: APP_PROTOCOL_VERSION,
    client: { kind: "test", version: "0.0.0" },
  },
};
const silent = { info: () => undefined, warn: () => undefined, error: () => undefined };

test("identity loader writes a valid id that AppClient would accept", async () => {
  const dir = await mkdtemp(join(tmpdir(), "fastvibe-identity-"));
  const file = join(dir, "server-identity.json");
  const first = loadOrCreateServerIdentity(file, { version: "1", platform: "linux" });
  const again = loadOrCreateServerIdentity(file, { version: "2", platform: "darwin" });
  assert.equal(first.serverInstanceId, again.serverInstanceId);
  assert.match(first.serverInstanceId, /^srv_/);
  assert.equal(again.version, "2");
  await rm(dir, { recursive: true, force: true });
});

test("identity loader replaces a corrupt file rather than claiming it", async () => {
  const dir = await mkdtemp(join(tmpdir(), "fastvibe-identity-"));
  const file = join(dir, "server-identity.json");
  await mkdir(dir, { recursive: true });
  await writeFile(file, "{not json", "utf8");
  const loaded = loadOrCreateServerIdentity(file, { version: "1", platform: "linux" });
  assert.match(loaded.serverInstanceId, /^srv_/);
  await rm(dir, { recursive: true, force: true });
});

test("create/init/get is one AppServer; observe is not a subscriber", async () => {
  resetAppServerRuntime();
  try {
    const methods: string[] = [];
    const created = createAppServer({
      identity,
      channels: () => [Ipc.engineGetStatus],
    });
    assert.equal(getAppServer(), created);
    assert.equal(createAppServer({ identity, channels: () => [] }), created);

    const pending: Array<{ kind?: string; ok?: boolean; error?: { message?: string } }> = [];
    const session = created.attach({
      identity: { subject: "window:1", kind: "window", clientKind: "electron", clientVersion: "1" },
      send: (message) => {
        pending.push(message);
        return true;
      },
      origin: "window:1",
    });
    await created.receive(session, hello);
    pending.length = 0;
    await created.receive(session, { kind: "call", requestId: 1, method: Ipc.engineGetStatus });
    assert.equal(pending[0]?.kind, "result");
    assert.equal(pending[0]?.ok, false);
    assert.match(String(pending[0]?.error?.message), /尚未初始化/);

    const before = subscriberCount();
    initAppServer({
      dispatch: async (method) => {
        methods.push(method);
        return { ok: true };
      },
    });
    assert.equal(getAppServer(), created);
    assert.equal(subscriberCount(), before, "the journal observer is not a subscribe() receiver");

    pending.length = 0;
    await created.receive(session, { kind: "call", requestId: 2, method: Ipc.engineGetStatus });
    assert.deepEqual(methods, [Ipc.engineGetStatus]);
    assert.equal(pending[0]?.ok, true);
    created.detach(session);
  } finally {
    resetAppServerRuntime();
  }
});

test("broadcast except metadata reaches AppServer and is not echoed", async () => {
  resetAppServerRuntime();
  const stopObserve = observe(() => undefined);
  stopObserve();
  try {
    const server = createAppServer({
      identity,
      channels: () => [Ipc.engineGetStatus],
    });
    initAppServer({ dispatch: async () => ({}) });

    const aMessages: Array<{ kind?: string }> = [];
    const bMessages: Array<{ kind?: string }> = [];
    const sessionA = server.attach({
      identity: { subject: "a", kind: "remote", clientKind: "test", clientVersion: "1" },
      send: (message) => {
        aMessages.push(message);
        return true;
      },
      origin: "client-a",
    });
    const sessionB = server.attach({
      identity: { subject: "b", kind: "remote", clientKind: "test", clientVersion: "1" },
      send: (message) => {
        bMessages.push(message);
        return true;
      },
      origin: "client-b",
    });
    await server.receive(sessionA, hello);
    await server.receive(sessionB, hello);
    await server.receive(sessionA, { kind: "subscribe", scopes: ["installation"] });
    await server.receive(sessionB, { kind: "subscribe", scopes: ["installation"] });
    aMessages.length = 0;
    bMessages.length = 0;

    const seen: Array<{ except?: string }> = [];
    const stop = observe((observation) => {
      seen.push({ except: observation.except });
    });
    const unsub = subscribe({
      id: "client-a",
      send: () => undefined,
    });

    broadcast("workspace:changed", { n: 1 }, { except: "client-a" });
    assert.equal(aMessages.some((message) => message.kind === "event"), false);
    assert.equal(bMessages.some((message) => message.kind === "event"), true);
    assert.equal(seen.some((item) => item.except === "client-a"), true);

    stop();
    unsub();
  } finally {
    resetAppServerRuntime();
  }
});

test("a RemoteServer without appServer owns a fallback instance, not the process one", async () => {
  resetAppServerRuntime();
  try {
    const processServer = createAppServer({
      identity,
      channels: () => [Ipc.engineGetStatus],
    });
    initAppServer({ dispatch: async () => ({}) });
    const dir = await mkdtemp(join(tmpdir(), "fastvibe-owned-"));
    const remote = new RemoteServer({
      accessFile: join(dir, "remote-access.json"),
      channels: () => [Ipc.engineGetStatus],
      dispatch: async () => undefined,
      subscribe: () => () => undefined,
      log: silent,
    });
    assert.ok(remote.appServer instanceof AppServer);
    assert.notEqual(remote.appServer, processServer);
    await rm(dir, { recursive: true, force: true });
  } finally {
    resetAppServerRuntime();
  }
});

const PASSWORD = "a-good-enough-password";

class WsTransport implements MessageTransport {
  #socket: WebSocket;
  constructor(socket: WebSocket) {
    this.#socket = socket;
  }
  send(message: unknown): void {
    this.#socket.send(JSON.stringify(message));
  }
  onMessage(listener: (message: unknown) => void): () => void {
    const handler = (raw: WebSocket.RawData): void => {
      let message: unknown;
      try {
        message = JSON.parse(String(raw));
      } catch {
        return;
      }
      if (typeof message !== "object" || message === null) return;
      if (typeof (message as { kind?: unknown }).kind !== "string") return;
      listener(message);
    };
    this.#socket.on("message", handler);
    return () => this.#socket.off("message", handler);
  }
  onClose(listener: (reason: string) => void): () => void {
    const handler = (): void => listener("closed");
    this.#socket.on("close", handler);
    return () => this.#socket.off("close", handler);
  }
  close(): void {
    this.#socket.close();
  }
}

async function waitUntil(predicate: () => boolean, message: string): Promise<void> {
  for (let i = 0; i < 40; i += 1) {
    if (predicate()) return;
    await new Promise((settle) => setTimeout(settle, 25));
  }
  throw new Error(message);
}

test("runtime + RemoteServer + AppClient: broadcast is published once, except skips origin including legacy", async () => {
  resetAppServerRuntime();
  const dir = await mkdtemp(join(tmpdir(), "fastvibe-runtime-ws-"));
  const accessFile = join(dir, "remote-access.json");
  setPassword(accessFile, PASSWORD);
  const origins: string[] = [];
  try {
    const processServer = createAppServer({
      identity,
      channels: () => registeredChannels(),
    });
    initAppServer({
      dispatch: async (method) => ({ echoed: method }),
    });
    const remote = new RemoteServer({
      accessFile,
      appServer: processServer,
      channels: () => registeredChannels(),
      dispatch: async (method, payload, clientId) => ({ echoed: method, payload, clientId }),
      subscribe: (client) => {
        origins.push(client.id);
        return subscribe(client);
      },
      log: silent,
    });
    const { port } = await remote.start({ port: 0, host: "127.0.0.1" });
    assert.ok(port);

    const token = await loginToken(port);
    const a = await connectedProtocol(port, token);
    const b = await connectedProtocol(port, token);
    const legacy = await authedSocket(port, token);
    const originA = origins[0];
    const originLegacy = origins[2];
    assert.equal(typeof originA, "string");
    assert.equal(typeof originLegacy, "string");

    a.client.subscribe(["installation"]);
    b.client.subscribe(["installation"]);
    await drainSubscribe(a.socket, a.frames);
    await drainSubscribe(b.socket, b.frames);
    a.frames.length = 0;
    b.frames.length = 0;
    const legacyFrames: Record<string, unknown>[] = [];
    legacy.on("message", (raw) => {
      try {
        legacyFrames.push(JSON.parse(String(raw)) as Record<string, unknown>);
      } catch {
        // ignore
      }
    });

    broadcast("workspace:changed", { n: 1 });
    await waitUntil(
      () =>
        a.frames.filter((frame) => frame.kind === "event").length === 1
        && b.frames.filter((frame) => frame.kind === "event").length === 1
        && legacyFrames.some((frame) => frame.push === "workspace:changed"),
      "canonical clients and the legacy client should each see the event once",
    );
    const eventA = a.frames.filter((frame) => frame.kind === "event");
    const eventB = b.frames.filter((frame) => frame.kind === "event");
    assert.equal(eventA.length, 1);
    assert.equal(eventB.length, 1);
    assert.equal(eventA[0]?.seq, eventB[0]?.seq);
    assert.equal(eventA[0]?.eventId, eventB[0]?.eventId);
    assert.equal(legacyFrames.filter((frame) => frame.push === "workspace:changed").length, 1);

    a.frames.length = 0;
    b.frames.length = 0;
    legacyFrames.length = 0;
    broadcast("workspace:changed", { n: 2 }, { except: originA });
    await waitUntil(
      () => b.frames.some((frame) => frame.kind === "event") && legacyFrames.some((frame) => frame.push),
      "non-origin clients should see the excepted broadcast",
    );
    assert.equal(a.frames.some((frame) => frame.kind === "event"), false);
    assert.equal(b.frames.filter((frame) => frame.kind === "event").length, 1);
    assert.deepEqual((b.frames.find((frame) => frame.kind === "event")?.payload as { n?: number }), { n: 2 });
    assert.equal(legacyFrames.filter((frame) => frame.push === "workspace:changed").length, 1);

    a.frames.length = 0;
    b.frames.length = 0;
    legacyFrames.length = 0;
    broadcast("workspace:changed", { n: 3 }, { except: originLegacy });
    await waitUntil(
      () =>
        a.frames.some((frame) => frame.kind === "event") && b.frames.some((frame) => frame.kind === "event"),
      "canonical clients should see an event excepted for the legacy origin",
    );
    assert.equal(a.frames.filter((frame) => frame.kind === "event").length, 1);
    assert.equal(b.frames.filter((frame) => frame.kind === "event").length, 1);
    await new Promise((settle) => setTimeout(settle, 40));
    assert.equal(legacyFrames.some((frame) => frame.push === "workspace:changed"), false);

    a.client.close();
    b.client.close();
    legacy.close();
    await remote.stop();
  } finally {
    resetAppServerRuntime();
    await rm(dir, { recursive: true, force: true });
  }
});

test("stopping the HTTP remote does not close shared Electron AppServer sessions", async () => {
  resetAppServerRuntime();
  const dir = await mkdtemp(join(tmpdir(), "fastvibe-runtime-stop-"));
  const accessFile = join(dir, "remote-access.json");
  setPassword(accessFile, PASSWORD);
  try {
    const processServer = createAppServer({
      identity,
      channels: () => registeredChannels(),
    });
    initAppServer({ dispatch: async () => ({ ok: true }) });
    const sends: Array<{ channel: string; payload: unknown }> = [];
    const window = attachWindowSession(processServer, {
      origin: "window:keep",
      sendToRenderer: (channel, payload) => sends.push({ channel, payload }),
    });
    await window.ready;
    assert.equal(processServer.sessionCount, 1);

    const remote = new RemoteServer({
      accessFile,
      appServer: processServer,
      channels: () => registeredChannels(),
      dispatch: async () => undefined,
      subscribe: () => () => undefined,
      log: silent,
    });
    await remote.start({ port: 0, host: "127.0.0.1" });
    await remote.stop();

    assert.equal(window.session.closed, false);
    assert.equal(processServer.sessionCount, 1);
    broadcast("workspace:changed", { kept: true });
    await waitUntil(() => sends.some((item) => item.channel === "workspace:changed"), "shared window still receives");
    assert.deepEqual(sends[sends.length - 1]?.payload, { kept: true });
    window.dispose();
  } finally {
    resetAppServerRuntime();
    await rm(dir, { recursive: true, force: true });
  }
});

async function loginToken(port: number): Promise<string> {
  const response = await fetch(`http://127.0.0.1:${port}/api/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ password: PASSWORD, label: "test" }),
  });
  const body = (await response.json()) as { token?: string };
  assert.equal(response.status, 200);
  assert.ok(body.token);
  return body.token;
}

function connectSocket(port: number): Promise<WebSocket> {
  const socket = new WebSocket(`ws://127.0.0.1:${port}/ws`);
  return new Promise((settle, fail) => {
    socket.once("open", () => settle(socket));
    socket.once("error", fail);
  });
}

function nextMessage(socket: WebSocket): Promise<Record<string, unknown>> {
  return new Promise((settle, fail) => {
    const timer = setTimeout(() => fail(new Error("timed out waiting for a message")), 4000);
    socket.once("message", (raw) => {
      clearTimeout(timer);
      settle(JSON.parse(String(raw)) as Record<string, unknown>);
    });
  });
}

async function authedSocket(port: number, token: string): Promise<WebSocket> {
  const socket = await connectSocket(port);
  socket.send(JSON.stringify({ type: "auth", token }));
  const reply = await nextMessage(socket);
  assert.equal(reply.ok, true);
  return socket;
}

async function drainSubscribe(socket: WebSocket, frames: Record<string, unknown>[]): Promise<void> {
  const before = frames.filter((frame) => frame.kind === "pong").length;
  socket.send(JSON.stringify({ kind: "ping" }));
  await waitUntil(() => frames.filter((frame) => frame.kind === "pong").length > before, "subscribe did not settle");
}

async function connectedProtocol(port: number, token: string): Promise<{
  client: AppClient;
  socket: WebSocket;
  frames: Record<string, unknown>[];
}> {
  const socket = await authedSocket(port, token);
  const frames: Record<string, unknown>[] = [];
  socket.on("message", (raw) => {
    try {
      const message = JSON.parse(String(raw)) as Record<string, unknown>;
      if (typeof message.kind === "string") frames.push(message);
    } catch {
      // ignore
    }
  });
  const client = new AppClient(new WsTransport(socket), {
    client: { kind: "test", version: "0.0.0" },
    handshakeTimeoutMs: 4_000,
  });
  await client.connect();
  return { client, socket, frames };
}
