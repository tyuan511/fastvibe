import assert from "node:assert/strict";
import test from "node:test";
import {
  DuplicateServerIdentityError,
  type RemoteAppClient,
  type RemoteClientStatus,
  type RemoteConnectionStatus,
} from "../src/shared/remote-connection.ts";
import type { AppCapability, AppHandshake } from "../src/shared/app-protocol.ts";
import type { RemoteHostProfile } from "../src/shared/remote-host.ts";
import { Ipc } from "../src/shared/ipc.ts";
import { WebSocketServer, type WebSocket } from "ws";
import {
  RemoteConnectionManager,
  webSocketTransport,
} from "../src/main/remote/connection-manager.ts";

function profile(id: string): RemoteHostProfile {
  return { id, label: id, host: `${id}.example` };
}

function handshake(serverInstanceId: string, capabilities: AppCapability[] = ["engine"]): AppHandshake {
  return {
    protocol: "fastvibe.app",
    protocolVersion: 1,
    server: { serverInstanceId, version: "0.0.0", platform: "linux" },
    capabilities,
  };
}

type FakeClient = RemoteAppClient & {
  drop(status: RemoteClientStatus): void;
  push(channel: string, payload: unknown): void;
};

function fakeClient(result: AppHandshake | (() => Promise<AppHandshake>)): FakeClient {
  let pushListener: ((channel: string, payload: unknown) => void) | null = null;
  let statusListener: ((status: RemoteClientStatus) => void) | null = null;
  let closed = false;
  let hs: AppHandshake | null = null;
  let rejectConnect: ((error: Error) => void) | null = null;
  const client: FakeClient = {
    get handshake() {
      return hs;
    },
    async connect() {
      if (closed) throw new Error("远程连接已取消");
      if (typeof result !== "function") {
        hs = result;
        return result;
      }
      return new Promise<AppHandshake>((resolve, reject) => {
        rejectConnect = reject;
        void result().then(
          (next) => {
            rejectConnect = null;
            if (closed) reject(new Error("远程连接已取消"));
            else {
              hs = next;
              resolve(next);
            }
          },
          reject,
        );
      });
    },
    call: async () => undefined,
    subscribe() {},
    close() {
      closed = true;
      rejectConnect?.(new Error("远程连接已取消"));
      rejectConnect = null;
    },
    onPush(listener) {
      pushListener = listener;
    },
    onStatus(listener) {
      statusListener = listener;
    },
    drop(status) {
      statusListener?.(status);
    },
    push(channel, payload) {
      pushListener?.(channel, payload);
    },
  };
  return client;
}

function queuedManager(clients: RemoteAppClient[]) {
  const statuses: RemoteConnectionStatus[] = [];
  const pushes: Array<{ channel: string; payload: unknown }> = [];
  const closes: string[] = [];
  const instance = new RemoteConnectionManager({
    log: { info() {}, warn() {} },
    onStatus: (status) => statuses.push(status),
    onPush: (channel, payload) => pushes.push({ channel, payload }),
    openTransport: async (profile) => ({
      port: 1,
      close: async () => {
        closes.push(profile.id);
      },
    }),
    createClient: () => {
      const next = clients.shift();
      if (!next) throw new Error("no fake client");
      return next;
    },
  });
  return { instance, statuses, pushes, closes };
}

test("two profiles stay up at once — there is no global active host", async () => {
  const { instance } = queuedManager([fakeClient(handshake("srv_one")), fakeClient(handshake("srv_two"))]);
  const a = await instance.connect(profile("host-a"));
  const b = await instance.connect(profile("host-b"));
  assert.equal(a.serverInstanceId, "srv_one");
  assert.equal(b.serverInstanceId, "srv_two");
  assert.equal(instance.server("host-a")?.serverInstanceId, "srv_one");
  assert.equal(instance.serverForInstance("srv_two")?.connectionId, "host-b");
  assert.equal(instance.statuses().filter((item) => item.state === "ready").length, 2);
});

test("a second profile that handshakes the same server is refused and the first stays", async () => {
  const { instance, closes } = queuedManager([
    fakeClient(handshake("srv_same")),
    fakeClient(handshake("srv_same")),
  ]);
  await instance.connect(profile("host-a"));
  await assert.rejects(() => instance.connect(profile("host-b")), DuplicateServerIdentityError);
  assert.equal(instance.server("host-a")?.serverInstanceId, "srv_same");
  assert.equal(instance.server("host-b"), undefined);
  assert.equal(instance.serverForInstance("srv_same")?.connectionId, "host-a");
  assert.ok(closes.includes("host-b"));
  assert.equal(instance.status("host-b")?.state, "error");
});

test("disconnect during deploy does not resurrect when the tunnel later arrives", async () => {
  let release: ((value: { port: number; close: () => Promise<void> }) => void) | null = null;
  let closed = false;
  const client = fakeClient(handshake("srv_late"));
  const statuses: RemoteConnectionStatus[] = [];
  const instance = new RemoteConnectionManager({
    log: { info() {}, warn() {} },
    onStatus: (status) => statuses.push(status),
    onPush() {},
    openTransport: () =>
      new Promise((resolve) => {
        release = resolve;
      }),
    createClient: () => client,
  });
  const pending = instance.connect(profile("host-a"));
  await new Promise((resolve) => setTimeout(resolve, 20));
  await instance.disconnect("host-a");
  release!({ port: 9, close: async () => { closed = true; } });
  await assert.rejects(pending, /远程连接已取消/);
  assert.equal(instance.server("host-a"), undefined);
  assert.equal(instance.status("host-a")?.state, "closed");
  assert.equal(closed, true);
  assert.equal(statuses.at(-1)?.state, "closed");
  assert.equal(statuses.some((item) => item.state === "ready"), false);
});

test("disconnect during handshake does not register a late welcome", async () => {
  const client = fakeClient(() => new Promise<AppHandshake>(() => undefined));
  let closed = 0;
  const statuses: RemoteConnectionStatus[] = [];
  const instance = new RemoteConnectionManager({
    log: { info() {}, warn() {} },
    onStatus: (status) => statuses.push(status),
    onPush() {},
    openTransport: async () => ({ port: 1, close: async () => { closed += 1; } }),
    createClient: () => client,
  });
  const pending = instance.connect(profile("host-a"));
  await new Promise((resolve) => setTimeout(resolve, 20));
  await instance.disconnect("host-a");
  await assert.rejects(pending, /远程连接已取消/);
  assert.equal(instance.server("host-a"), undefined);
  assert.equal(instance.status("host-a")?.state, "closed");
  assert.ok(closed >= 1);
  assert.equal(statuses.some((item) => item.state === "ready"), false);
});

test("a dropped AppClient is observed and the server is taken down", async () => {
  const client = fakeClient(handshake("srv_one"));
  const { instance, closes } = queuedManager([client]);
  await instance.connect(profile("host-a"));
  client.drop({ state: "error", message: "远程 App Server 连接已断开" });
  assert.equal(instance.server("host-a"), undefined);
  assert.equal(instance.status("host-a")?.state, "error");
  assert.equal(instance.status("host-a")?.error, "远程 App Server 连接已断开");
  assert.deepEqual(closes, ["host-a"]);
});

test("closeAll waits out an in-flight open and closes its transport", async () => {
  let release: ((value: { port: number; close: () => Promise<void> }) => void) | null = null;
  let closed = false;
  const instance = new RemoteConnectionManager({
    log: { info() {}, warn() {} },
    onStatus() {},
    onPush() {},
    openTransport: () =>
      new Promise((resolve) => {
        release = resolve;
      }),
    createClient: () => fakeClient(handshake("srv_one")),
  });
  const pending = instance.connect(profile("host-a"));
  await new Promise((resolve) => setTimeout(resolve, 20));
  const done = instance.closeAll();
  release!({ port: 3, close: async () => { closed = true; } });
  await done;
  await assert.rejects(pending, /远程连接已取消/);
  assert.equal(closed, true);
  assert.equal(instance.server("host-a"), undefined);
  assert.equal(instance.status("host-a")?.state, "closed");
});

test("pushes are namespaced and settings are not relayed", async () => {
  const client = fakeClient(handshake("srv_one"));
  const { instance, pushes } = queuedManager([client]);
  await instance.connect(profile("host-a"));
  client.push(Ipc.event, { type: "conversation_running", conversationId: "c1", running: true });
  client.push(Ipc.settingsChanged, { themeMode: "dark" });
  client.push(Ipc.workspaceChanged, { activeId: "c1", conversations: [{ id: "c1" }], projects: [] });
  assert.equal(pushes.length, 2);
  assert.deepEqual(pushes[0], {
    channel: Ipc.event,
    payload: { type: "conversation_running", conversationId: "remote:srv_one:c1", running: true },
  });
  const catalog = pushes[1]!.payload as Record<string, unknown>;
  assert.equal("activeId" in catalog, false);
  assert.equal((catalog.conversations as Array<{ id: string }>)[0]!.id, "remote:srv_one:c1");
});

test("connect is idempotent for a live server and concurrent callers share one attempt", async () => {
  let opens = 0;
  let finish: ((value: AppHandshake) => void) | null = null;
  const client = fakeClient(() => {
    opens += 1;
    return new Promise<AppHandshake>((resolve) => { finish = resolve; });
  });
  const { instance } = queuedManager([client]);
  const a = instance.connect(profile("host-a"));
  const b = instance.connect(profile("host-a"));
  await new Promise((resolve) => setTimeout(resolve, 10));
  finish!(handshake("srv_one"));
  const [left, right] = await Promise.all([a, b]);
  assert.equal(left, right);
  assert.equal(opens, 1);
  assert.equal(await instance.connect(profile("host-a")), left);
});

test("listWorkspaces reads the remote project list through the protocol", async () => {
  const client = fakeClient(handshake("srv_one"));
  client.call = async (method) => {
    assert.equal(method, "conversations:list");
    return { projects: [{ cwd: "/home/dev/app", name: "app" }, { cwd: "" }] };
  };
  const { instance } = queuedManager([client]);
  const server = await instance.connect(profile("host-a"));
  assert.deepEqual(await instance.listWorkspaces(server), [
    { serverInstanceId: "srv_one", workspaceId: "/home/dev/app", path: "/home/dev/app", name: "app" },
  ]);
});

test("connect subscribes to all scopes and call delegates the deadline to the client", async () => {
  const client = fakeClient(handshake("srv_one"));
  const scopes: string[][] = [];
  const calls: Array<{ method: string; options: unknown }> = [];
  client.subscribe = (next) => {
    scopes.push([...next]);
  };
  client.call = async (method, _payload, options) => {
    calls.push({ method, options });
    return { ok: true };
  };
  const { instance } = queuedManager([client]);
  const server = await instance.connect(profile("host-a"));
  assert.deepEqual(scopes, [["*"]]);
  await instance.call(server, "engine:get-state", {});
  assert.equal(calls[0]?.method, "engine:get-state");
  assert.equal((calls[0]?.options as { timeoutMs?: number }).timeoutMs, 120_000);
});

test("disconnect aborts openTransport so a later deploy does not run", async () => {
  let aborted = false;
  let deployed = false;
  const statuses: RemoteConnectionStatus[] = [];
  const instance = new RemoteConnectionManager({
    log: { info() {}, warn() {} },
    onStatus: (status) => statuses.push(status),
    onPush() {},
    openTransport: (_profile, signal) =>
      new Promise((_, reject) => {
        const timer = setTimeout(() => {
          deployed = true;
          reject(new Error("deployed"));
        }, 200);
        signal?.addEventListener("abort", () => {
          aborted = true;
          clearTimeout(timer);
          reject(new Error("远程连接已取消"));
        });
      }),
    createClient: () => fakeClient(handshake("srv_one")),
  });
  const pending = instance.connect(profile("host-a"));
  await new Promise((resolve) => setTimeout(resolve, 20));
  await instance.disconnect("host-a");
  await assert.rejects(pending, /远程连接已取消/);
  assert.equal(aborted, true);
  assert.equal(deployed, false);
  assert.equal(statuses.some((item) => item.state === "ready"), false);
});

async function withWsServer(
  onConnection: (socket: WebSocket) => void,
): Promise<{ port: number; close: () => Promise<void> }> {
  const wss = new WebSocketServer({ host: "127.0.0.1", port: 0 });
  wss.on("connection", onConnection);
  await new Promise<void>((resolve, reject) => {
    wss.once("listening", () => resolve());
    wss.once("error", reject);
  });
  const address = wss.address();
  const port = typeof address === "object" && address ? address.port : 0;
  return {
    port,
    close: () => new Promise((resolve) => wss.close(() => resolve())),
  };
}

test("webSocketTransport queues frames until auth ack and never delivers legacy pushes", async () => {
  const inbound: unknown[] = [];
  const delivered: unknown[] = [];
  const server = await withWsServer((socket) => {
    socket.on("message", (data) => {
      const message = JSON.parse(String(data)) as Record<string, unknown>;
      inbound.push(message);
      if (message.type === "auth") {
        socket.send(JSON.stringify({ type: "auth", ok: true }));
        socket.send(JSON.stringify({ push: "settings:changed", payload: { themeMode: "dark" } }));
        socket.send(JSON.stringify({ kind: "welcome", epoch: "ep1" }));
      }
    });
  });
  try {
    const transport = webSocketTransport(server.port);
    transport.onMessage((message) => delivered.push(message));
    transport.send({ kind: "hello" });
    await new Promise((resolve) => setTimeout(resolve, 80));
    assert.equal((inbound[0] as { type?: string })?.type, "auth");
    assert.equal((inbound[1] as { kind?: string })?.kind, "hello");
    assert.equal(inbound.some((item) => (item as { kind?: string }).kind === "hello" && inbound.indexOf(item) === 0), false);
    assert.deepEqual(delivered, [{ kind: "welcome", epoch: "ep1" }]);
    transport.close();
  } finally {
    await server.close();
  }
});

test("webSocketTransport close/error settle once and replay to late subscribers", async () => {
  const server = await withWsServer((socket) => {
    socket.close();
  });
  try {
    const transport = webSocketTransport(server.port);
    const reasons: string[] = [];
    transport.onClose((reason) => reasons.push(reason));
    await new Promise((resolve) => setTimeout(resolve, 80));
    assert.equal(reasons.length, 1);
    const late: string[] = [];
    transport.onClose((reason) => late.push(reason));
    assert.deepEqual(late, reasons);
    transport.onClose((reason) => late.push(`again:${reason}`));
    assert.equal(late.length, 2);
  } finally {
    await server.close();
  }
});

test("webSocketTransport auth deadline settles when no ack arrives", async () => {
  const server = await withWsServer(() => undefined);
  try {
    const transport = webSocketTransport(server.port, { authTimeoutMs: 40 });
    const reasons: string[] = [];
    transport.onClose((reason) => reasons.push(reason));
    await new Promise((resolve) => setTimeout(resolve, 80));
    assert.equal(reasons.length, 1);
    assert.match(reasons[0]!, /鉴权超时/);
  } finally {
    await server.close();
  }
});
