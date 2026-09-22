import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import WebSocket from "ws";
import { RemoteServer } from "../src/main/server/server.ts";
import { setPassword } from "../src/main/server/store.ts";
import { AppClient, type MessageTransport } from "../src/main/remote/app-client.ts";
import {
  ALL_SCOPES,
  APP_PROTOCOL,
  APP_PROTOCOL_VERSION,
} from "../src/shared/app-protocol.ts";
import { Ipc } from "../src/shared/ipc.ts";
import { registeredChannels } from "./registered-channels.ts";

const silent = { info: () => undefined, warn: () => undefined, error: () => undefined };
const PASSWORD = "a-good-enough-password";

type Harness = {
  server: RemoteServer;
  port: number;
  dispatched: Array<{ method: string; payload: unknown }>;
};

async function withServer(fn: (h: Harness) => Promise<void>, options?: { loopbackToken?: string; password?: boolean }): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), "fastvibe-app-ws-"));
  const accessFile = join(dir, "remote-access.json");
  const webRoot = join(dir, "web");
  await mkdir(webRoot, { recursive: true });
  await writeFile(join(webRoot, "remote.html"), "<!doctype html><title>client</title>", "utf8");
  if (options?.password !== false) setPassword(accessFile, PASSWORD);
  const dispatched: Array<{ method: string; payload: unknown }> = [];
  const server = new RemoteServer({
    accessFile,
    channels: () => registeredChannels(),
    dispatch: async (method, payload) => {
      dispatched.push({ method, payload });
      return { echoed: method };
    },
    subscribe: () => () => undefined,
    webRoot,
    log: silent,
    ...(options?.loopbackToken ? { loopbackToken: options.loopbackToken } : {}),
  });
  const { port } = await server.start({ port: 0, host: "127.0.0.1" });
  try {
    await fn({ server, port: port ?? 0, dispatched });
  } finally {
    await server.stop();
    await rm(dir, { recursive: true, force: true });
  }
}

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

function closed(socket: WebSocket): Promise<number> {
  return new Promise((settle, fail) => {
    const timer = setTimeout(() => fail(new Error("socket stayed open")), 4000);
    socket.once("close", (code) => {
      clearTimeout(timer);
      settle(code);
    });
  });
}

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

async function authedSocket(port: number): Promise<WebSocket> {
  const token = await loginToken(port);
  const socket = await connectSocket(port);
  socket.send(JSON.stringify({ type: "auth", token }));
  const reply = await nextMessage(socket);
  assert.equal(reply.ok, true);
  return socket;
}

async function waitUntil(predicate: () => boolean, label: string): Promise<void> {
  for (let i = 0; i < 40; i += 1) {
    if (predicate()) return;
    await new Promise((settle) => setTimeout(settle, 25));
  }
  throw new Error(label);
}

async function drainSubscribe(socket: WebSocket, frames: Record<string, unknown>[]): Promise<void> {
  const before = frames.filter((frame) => frame.kind === "pong").length;
  socket.send(JSON.stringify({ kind: "ping" }));
  await waitUntil(() => frames.filter((frame) => frame.kind === "pong").length > before, "subscribe did not settle");
}

async function connectedClient(port: number, capabilities?: readonly string[]): Promise<{
  client: AppClient;
  socket: WebSocket;
  frames: Record<string, unknown>[];
}> {
  const socket = await authedSocket(port);
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
    ...(capabilities ? { capabilities: capabilities as never } : {}),
  });
  await client.connect();
  return { client, socket, frames };
}

test("AppClient handshake over a real socket", async () => {
  await withServer(async ({ server, port }) => {
    const { client } = await connectedClient(port);
    assert.equal(client.status.state, "ready");
    assert.equal(client.handshake?.protocol, APP_PROTOCOL);
    assert.equal(client.handshake?.protocolVersion, APP_PROTOCOL_VERSION);
    assert.equal(client.handshake?.server.serverInstanceId, server.appServer.identity.serverInstanceId);
    assert.ok(client.epoch);
    client.close();
  });
});

test("a call before hello is not dispatched", async () => {
  await withServer(async ({ port, dispatched }) => {
    const socket = await authedSocket(port);
    socket.send(JSON.stringify({ kind: "call", requestId: 1, method: Ipc.engineGetStatus }));
    const reply = await nextMessage(socket);
    assert.equal(reply.kind, "result");
    assert.equal(reply.ok, false);
    assert.equal((reply.error as { code?: string } | undefined)?.code, "protocol.not_ready");
    assert.deepEqual(dispatched, []);
    socket.close();
  });
});

test("repeated hello is ignored after welcome", async () => {
  await withServer(async ({ port }) => {
    const { client, frames, socket } = await connectedClient(port);
    const welcomes = frames.filter((frame) => frame.kind === "welcome");
    assert.equal(welcomes.length, 1);
    socket.send(JSON.stringify({
      kind: "hello",
      hello: {
        protocol: APP_PROTOCOL,
        protocolVersion: APP_PROTOCOL_VERSION,
        client: { kind: "test", version: "0.0.0" },
      },
    }));
    await new Promise((settle) => setTimeout(settle, 80));
    assert.equal(frames.filter((frame) => frame.kind === "welcome").length, 1);
    client.close();
  });
});

test("capability narrowing refuses a method the client did not declare", async () => {
  await withServer(async ({ port, dispatched }) => {
    const { client } = await connectedClient(port, ["settings"]);
    await assert.rejects(() => client.call(Ipc.engineGetStatus), /不支持|能力/);
    assert.deepEqual(dispatched, []);
    const result = await client.call(Ipc.settingsGet);
    assert.deepEqual(result, { echoed: Ipc.settingsGet });
    client.close();
  });
});

test("two subscribers see the same eventId from one publish", async () => {
  await withServer(async ({ server, port }) => {
    const a = await connectedClient(port);
    const b = await connectedClient(port);
    a.client.subscribe(["installation"]);
    b.client.subscribe(["installation"]);
    await drainSubscribe(a.socket, a.frames);
    await drainSubscribe(b.socket, b.frames);
    a.frames.length = 0;
    b.frames.length = 0;
    const event = server.appServer.publish("workspace:changed", { n: 1 });
    await waitUntil(
      () => a.frames.some((frame) => frame.kind === "event") && b.frames.some((frame) => frame.kind === "event"),
      "both subscribers should see the event",
    );
    const eventA = a.frames.find((frame) => frame.kind === "event");
    const eventB = b.frames.find((frame) => frame.kind === "event");
    assert.ok(eventA);
    assert.ok(eventB);
    assert.equal(eventA.eventId, event.eventId);
    assert.equal(eventB.eventId, event.eventId);
    assert.deepEqual(eventA, eventB);
    a.client.close();
    b.client.close();
  });
});

test("named subscribe replays; a restart past the journal resyncs", async () => {
  await withServer(async ({ server, port }) => {
    server.appServer.publish("workspace:changed", { n: 1 });
    server.appServer.publish("workspace:changed", { n: 2 });
    const { client, frames } = await connectedClient(port);
    frames.length = 0;
    client.subscribe(["installation"], { installation: 1 });
    for (let i = 0; i < 20 && !frames.some((frame) => frame.kind === "event"); i += 1) {
      await new Promise((settle) => setTimeout(settle, 20));
    }
    const replayed = frames.filter((frame) => frame.kind === "event");
    assert.equal(replayed.length, 1);
    assert.equal(replayed[0]?.seq, 2);
    assert.deepEqual(replayed[0]?.payload, { n: 2 });

    frames.length = 0;
    const resyncs: string[] = [];
    client.onResync((resync) => resyncs.push(resync.reason));
    client.subscribe(["installation"], { installation: 99 });
    for (let i = 0; i < 20 && resyncs.length === 0 && !frames.some((frame) => frame.kind === "resync"); i += 1) {
      await new Promise((settle) => setTimeout(settle, 20));
    }
    assert.ok(
      resyncs.length > 0 || frames.some((frame) => frame.kind === "resync"),
      "a cursor ahead of the server must resync",
    );
    client.close();
  });
});

test("an unauthorized socket is told nothing and cannot hello", async () => {
  await withServer(async ({ port, dispatched }) => {
    const socket = await connectSocket(port);
    socket.send(JSON.stringify({
      kind: "hello",
      hello: {
        protocol: APP_PROTOCOL,
        protocolVersion: APP_PROTOCOL_VERSION,
        client: { kind: "test", version: "0.0.0" },
      },
    }));
    const code = await closed(socket);
    assert.equal(code, 4001);
    assert.deepEqual(dispatched, []);
  });
});

test("except-origin does not echo the writer", async () => {
  await withServer(async ({ server, port }) => {
    const a = await connectedClient(port);
    const b = await connectedClient(port);
    a.client.subscribe(["installation"]);
    b.client.subscribe(["installation"]);
    await drainSubscribe(a.socket, a.frames);
    await drainSubscribe(b.socket, b.frames);
    const sessionA = a.frames.find((frame) => frame.kind === "welcome")?.sessionId;
    assert.equal(typeof sessionA, "string");
    a.frames.length = 0;
    b.frames.length = 0;
    server.appServer.publish("workspace:changed", { n: 1 }, { except: sessionA as string });
    await waitUntil(() => b.frames.some((frame) => frame.kind === "event"), "the other subscriber should see the event");
    assert.equal(a.frames.some((frame) => frame.kind === "event"), false);
    const eventB = b.frames.find((frame) => frame.kind === "event");
    assert.ok(eventB);
    assert.deepEqual(eventB.payload, { n: 1 });
    a.client.close();
    b.client.close();
  });
});

test("a canonical client cannot fall back to a legacy call to bypass negotiated capabilities", async () => {
  await withServer(async ({ port, dispatched }) => {
    const { client, socket } = await connectedClient(port, ["settings"]);
    const pending = nextMessage(socket);
    socket.send(JSON.stringify({ id: 1, method: Ipc.engineGetStatus, payload: {} }));
    const reply = await pending;
    assert.equal(reply.ok, undefined);
    assert.equal(reply.type, "error");
    assert.deepEqual(dispatched, []);
    const allowed = await client.call(Ipc.settingsGet);
    assert.deepEqual(allowed, { echoed: Ipc.settingsGet });
    await assert.rejects(() => client.call(Ipc.engineGetStatus), /不支持|能力/);
    assert.deepEqual(dispatched, [{ method: Ipc.settingsGet, payload: undefined }]);
    client.close();
  });
});

test("wildcard subscribe is live-only", async () => {
  await withServer(async ({ server, port }) => {
    server.appServer.publish("workspace:changed", { n: 0 });
    const { client, socket, frames } = await connectedClient(port);
    frames.length = 0;
    client.subscribe([ALL_SCOPES]);
    await drainSubscribe(socket, frames);
    frames.length = 0;
    assert.equal(frames.some((frame) => frame.kind === "event"), false);
    server.appServer.publish("workspace:changed", { n: 1 });
    for (let i = 0; i < 20 && !frames.some((frame) => frame.kind === "event"); i += 1) {
      await new Promise((settle) => setTimeout(settle, 20));
    }
    assert.equal(frames.some((frame) => frame.kind === "event" && (frame.payload as { n?: number }).n === 1), true);
    client.close();
  });
});

test("SSH loopback auth needs the bootstrap token, not just a loopback address", async () => {
  const token = "a".repeat(64);
  await withServer(async ({ port }) => {
    // Any local user on the host can reach loopback; an empty or wrong token is refused.
    for (const attempt of ["", "b".repeat(64)]) {
      const socket = await connectSocket(port);
      const reply = nextMessage(socket);
      const code = closed(socket);
      socket.send(JSON.stringify({ type: "auth", token: attempt }));
      assert.deepEqual({ type: (await reply).type, ok: (await reply).ok }, { type: "auth", ok: false });
      assert.equal(await code, 4001);
    }
    const socket = await connectSocket(port);
    const reply = nextMessage(socket);
    socket.send(JSON.stringify({ type: "auth", token }));
    assert.equal((await reply).ok, true);
    socket.close();
  }, { loopbackToken: token, password: false });
});

test("a socket that sends nothing is not authenticated just for being on loopback", async () => {
  await withServer(async ({ port }) => {
    const socket = await connectSocket(port);
    const code = closed(socket);
    socket.send(JSON.stringify({ kind: "hello", hello: { protocol: APP_PROTOCOL, protocolVersion: APP_PROTOCOL_VERSION, client: { kind: "test", version: "0.0.0" } } }));
    assert.equal(await code, 4001);
  }, { loopbackToken: "c".repeat(64), password: false });
});
