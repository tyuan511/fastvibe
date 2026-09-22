import assert from "node:assert/strict";
import test from "node:test";
import { AppClient, type MessageTransport } from "../src/main/remote/app-client.ts";
import { AppServer } from "../src/main/app-server/app-server.ts";
import { DESKTOP_CAPABILITIES } from "../src/main/app-server/capabilities.ts";
import { ALL_SCOPES, APP_PROTOCOL, APP_PROTOCOL_VERSION } from "../src/shared/app-protocol.ts";
import { planResume, toScopeCursors, unseenScopes } from "../src/shared/app-resume.ts";
import { Ipc } from "../src/shared/ipc.ts";

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

async function connectedPair(options?: {
  dispatch?: (method: string, payload: unknown) => Promise<unknown>;
}) {
  const { clientWire, serverWire } = pair();
  const methods: string[] = [];
  const server = new AppServer({
    identity: { serverInstanceId: "srv_it1", version: "0.7.0", platform: "linux" },
    capabilities: DESKTOP_CAPABILITIES,
    channels: () => [Ipc.engineGetState, Ipc.conversationsList],
    dispatch: async (method, payload) => {
      methods.push(method);
      if (options?.dispatch) return options.dispatch(method, payload);
      return { method, payload };
    },
  });
  const session = server.attach({
    identity: {
      subject: "ssh-loopback",
      kind: "remote",
      clientKind: "test",
      clientVersion: "0.0.0",
    },
    send: (message) => {
      serverWire.send(message);
      return true;
    },
  });
  serverWire.onMessage((message) => {
    void server.receive(session, message);
  });
  const app = new AppClient(clientWire, {
    client: { kind: "test", version: "0.0.0" },
    handshakeTimeoutMs: 1_000,
    callTimeoutMs: 1_000,
  });
  const handshake = await app.connect();
  return { app, server, session, clientWire, serverWire, handshake, methods };
}

test("AppClient handshake and call round-trip a real AppServer", async () => {
  const { app, handshake, methods } = await connectedPair();
  assert.equal(handshake.protocol, APP_PROTOCOL);
  assert.equal(handshake.protocolVersion, APP_PROTOCOL_VERSION);
  assert.equal(handshake.server.serverInstanceId, "srv_it1");
  assert.equal(app.status.state, "ready");
  assert.equal(typeof app.epoch, "string");

  const result = await app.call(Ipc.engineGetState, { conversationId: "c1" });
  assert.deepEqual(result, { method: Ipc.engineGetState, payload: { conversationId: "c1" } });
  assert.deepEqual(methods, [Ipc.engineGetState]);
});

test("AppClient subscribe receives AppServer publish events", async () => {
  const { app, server } = await connectedPair();
  const pushes: Array<{ channel: string; payload: unknown }> = [];
  app.onPush((channel, payload) => pushes.push({ channel, payload }));
  app.subscribe([ALL_SCOPES]);

  server.publish(Ipc.workspaceChanged, { conversations: [{ id: "c1" }], projects: [] });
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(pushes.length, 1);
  assert.equal(pushes[0]?.channel, Ipc.workspaceChanged);
});

test("AppClient subscribe with numeric since is converted before AppServer resume", async () => {
  const { app, server, clientWire } = await connectedPair();
  server.publish(Ipc.workspaceChanged, { n: 1 });
  server.publish(Ipc.workspaceChanged, { n: 2 });

  const pushes: unknown[] = [];
  app.onPush((_channel, payload) => pushes.push(payload));
  app.subscribe(["installation"], { installation: 1 });
  const frame = clientWire.sent.find((item) => (item as { kind?: string }).kind === "subscribe") as {
    since?: Record<string, { epoch: string; seq: number }>;
  };
  assert.equal(frame.since?.installation?.seq, 1);
  assert.equal(typeof frame.since?.installation?.epoch, "string");
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.deepEqual(pushes, [{ n: 2 }]);
});

test("wildcard live events only remember seen scopes; reconnect must rebootstrap", async () => {
  const { app, server } = await connectedPair();
  const pushes: Array<{ channel: string; payload: unknown }> = [];
  app.onPush((channel, payload) => pushes.push({ channel, payload }));
  app.subscribe([ALL_SCOPES]);

  server.publish(Ipc.workspaceChanged, { n: 1 });
  server.publish(Ipc.event, { conversationId: "c1", n: 2 });
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(pushes.length, 2);

  const epoch = app.epoch;
  assert.equal(typeof epoch, "string");
  const cursors = toScopeCursors(epoch as string, app.cursors());
  assert.equal(cursors.installation?.seq, 1);
  assert.equal(cursors["conversation:c1"]?.seq, 1);
  assert.deepEqual(unseenScopes(cursors, ["installation", "conversation:c1", "conversation:c2"]), [
    "conversation:c2",
  ]);

  const sameEpoch = planResume({
    welcomeEpoch: epoch as string,
    cursors,
    wildcard: true,
    expectedScopes: ["installation", "conversation:c1", "conversation:c2"],
  });
  assert.deepEqual(sameEpoch, { kind: "rebootstrap", reason: "wildcard" });

  const restarted = planResume({
    welcomeEpoch: "after-restart",
    cursors,
    wildcard: true,
  });
  assert.deepEqual(restarted, { kind: "rebootstrap", reason: "wildcard" });

  const namedButStale = planResume({
    welcomeEpoch: "after-restart",
    cursors,
    wildcard: false,
  });
  assert.deepEqual(namedButStale, { kind: "rebootstrap", reason: "epoch-changed" });
});

test("a failed AppServer dispatch rejects the AppClient call", async () => {
  const { app } = await connectedPair({
    dispatch: async () => {
      throw new Error("没有这个方法");
    },
  });
  await assert.rejects(() => app.call(Ipc.engineGetState), /没有这个方法/);
});
