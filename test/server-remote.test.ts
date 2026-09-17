import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import WebSocket from "ws";
import { RemoteServer } from "../src/main/server/server.ts";
import { setPassword } from "../src/main/server/store.ts";
import { Ipc } from "../src/shared/ipc.ts";
import { registeredChannels } from "./registered-channels.ts";

/**
 * The server, over real sockets on a real port.
 *
 * Everything here is a door onto a machine that runs an agent with shell access, so the
 * tests are about what is *refused*: a socket that never authenticates, a token that is
 * not one, a method the policy denies, a path that climbs out of the web root. Each of
 * those failing open looks exactly like the server working.
 */

const silent = { info: () => undefined, warn: () => undefined, error: () => undefined };
const PASSWORD = "a-good-enough-password";

type Harness = {
  server: RemoteServer;
  port: number;
  dispatched: Array<{ method: string; payload: unknown }>;
  push: (channel: string, payload: unknown) => void;
  subscribers: number;
  /** Times `onStatusChange` fired — what the settings pane's live refresh rides on. */
  statusChanges: number;
};

async function withServer(fn: (h: Harness) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), "fastvibe-remote-"));
  // The real layout: the web root holds the built client and nothing else, and the
  // credential file is a sibling of it rather than something inside what is served.
  // A static server serves what is under its root — keeping secrets out of that
  // directory is the rule, and the traversal check below is what enforces the boundary.
  const accessFile = join(dir, "remote-access.json");
  const webRoot = join(dir, "web");
  await mkdir(webRoot, { recursive: true });
  await writeFile(join(webRoot, "index.html"), "<!doctype html><title>client</title>", "utf8");
  setPassword(accessFile, PASSWORD);
  const dispatched: Array<{ method: string; payload: unknown }> = [];
  const receivers = new Map<string, (channel: string, payload: unknown) => void>();
  let statusChanges = 0;
  const server = new RemoteServer({
    accessFile,
    channels: () => registeredChannels(),
    dispatch: async (method, payload) => {
      dispatched.push({ method, payload });
      if (method === Ipc.engineAbort) throw new Error("boom from the handler");
      return { echoed: method };
    },
    subscribe: (client) => {
      receivers.set(client.id, client.send);
      return () => receivers.delete(client.id);
    },
    onStatusChange: () => {
      statusChanges += 1;
    },
    webRoot,
    log: silent,
  });
  const { port } = await server.start({ port: 0, host: "127.0.0.1" });
  try {
    await fn({
      server,
      port: port ?? 0,
      dispatched,
      push: (channel, payload) => receivers.forEach((send) => send(channel, payload)),
      get subscribers() {
        return receivers.size;
      },
      get statusChanges() {
        return statusChanges;
      },
    } as Harness);
  } finally {
    await server.stop();
    await rm(dir, { recursive: true, force: true });
  }
}

function connect(port: number): Promise<WebSocket> {
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

async function post(port: number, path: string, body: unknown): Promise<{ status: number; body: Record<string, unknown> }> {
  const response = await fetch(`http://127.0.0.1:${port}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  return { status: response.status, body: (await response.json()) as Record<string, unknown> };
}

async function loginToken(port: number): Promise<string> {
  const { status, body } = await post(port, "/api/login", { password: PASSWORD, label: "test" });
  assert.equal(status, 200);
  return body.token as string;
}

test("a server with no password refuses to start", async () => {
  // A reachable server that asks for nothing is the one mistake that cannot be undone
  // after the fact, so it is made impossible rather than warned about.
  const dir = await mkdtemp(join(tmpdir(), "fastvibe-remote-"));
  const server = new RemoteServer({
    accessFile: join(dir, "remote-access.json"),
    channels: () => [],
    dispatch: async () => undefined,
    subscribe: () => () => undefined,
    log: silent,
  });
  await assert.rejects(() => server.start({ port: 0 }), /密码/);
  await rm(dir, { recursive: true, force: true });
});

test("the wrong password is refused and the right one issues a token", async () => {
  await withServer(async ({ port }) => {
    const bad = await post(port, "/api/login", { password: "not-the-password", label: "x" });
    assert.equal(bad.status, 401);
    assert.equal(bad.body.token, undefined);

    const good = await post(port, "/api/login", { password: PASSWORD, label: "phone" });
    assert.equal(good.status, 200);
    assert.equal(typeof good.body.token, "string");
    assert.ok((good.body.token as string).length >= 40);
  });
});

test("repeated wrong passwords start costing time", async () => {
  await withServer(async ({ port }) => {
    let throttled = false;
    for (let i = 0; i < 6; i += 1) {
      const result = await post(port, "/api/login", { password: "wrong", label: "x" });
      if (result.status === 429) {
        throttled = true;
        assert.ok(Number(result.body.retryAfterMs) > 0);
        break;
      }
    }
    assert.ok(throttled, "guessing should eventually be throttled");
  });
});

test("a socket that never authenticates is told nothing and dispatches nothing", async () => {
  await withServer(async ({ port, dispatched }) => {
    const socket = await connect(port);
    socket.send(JSON.stringify({ id: 1, method: Ipc.engineGetStatus }));
    const code = await closed(socket);
    assert.equal(code, 4001);
    assert.deepEqual(dispatched, []);
  });
});

test("a token that is not one is refused", async () => {
  await withServer(async ({ port }) => {
    const socket = await connect(port);
    socket.send(JSON.stringify({ type: "auth", token: "made-up" }));
    const reply = await nextMessage(socket);
    assert.equal(reply.ok, false);
    assert.equal(await closed(socket), 4001);
  });
});

test("an authenticated client can call an allowed method", async () => {
  await withServer(async ({ port, dispatched }) => {
    const token = await loginToken(port);
    const socket = await connect(port);
    socket.send(JSON.stringify({ type: "auth", token }));
    assert.equal((await nextMessage(socket)).ok, true);

    socket.send(JSON.stringify({ id: 7, method: Ipc.engineGetStatus, payload: { a: 1 } }));
    const reply = await nextMessage(socket);
    assert.equal(reply.id, 7);
    assert.equal(reply.ok, true);
    assert.deepEqual(reply.result, { echoed: Ipc.engineGetStatus });
    assert.deepEqual(dispatched, [{ method: Ipc.engineGetStatus, payload: { a: 1 } }]);
    socket.close();
  });
});

test("a denied method is refused without ever reaching the handler", async () => {
  await withServer(async ({ port, dispatched }) => {
    const token = await loginToken(port);
    const socket = await connect(port);
    socket.send(JSON.stringify({ type: "auth", token }));
    await nextMessage(socket);

    socket.send(JSON.stringify({ id: 9, method: Ipc.workspacePick }));
    const reply = await nextMessage(socket);
    assert.equal(reply.ok, false);
    assert.match(String(reply.error), /远程/);
    // The point of the policy is that the call does not happen, not that its result is
    // discarded — `workspace:pick` would open a dialog nobody can answer.
    assert.deepEqual(dispatched, []);
    socket.close();
  });
});

test("a handler that throws returns its message, not a stack trace", async () => {
  await withServer(async ({ port }) => {
    const token = await loginToken(port);
    const socket = await connect(port);
    socket.send(JSON.stringify({ type: "auth", token }));
    await nextMessage(socket);

    socket.send(JSON.stringify({ id: 11, method: Ipc.engineAbort }));
    const reply = await nextMessage(socket);
    assert.equal(reply.ok, false);
    assert.equal(reply.error, "boom from the handler");
    // A stack names paths and packages on this machine and the client can do nothing
    // with it.
    assert.doesNotMatch(String(reply.error), /at |\.ts:|node_modules/);
    socket.close();
  });
});

test("pushes start at authentication, not at connection", async () => {
  await withServer(async (h) => {
    const socket = await connect(h.port);
    // Before authenticating there must be no receiver attached at all.
    assert.equal(h.subscribers, 0);
    const token = await loginToken(h.port);
    socket.send(JSON.stringify({ type: "auth", token }));
    await nextMessage(socket);
    assert.equal(h.subscribers, 1);

    const arrived = nextMessage(socket);
    h.push(Ipc.event, { type: "hello" });
    const message = await arrived;
    assert.equal(message.push, Ipc.event);
    assert.deepEqual(message.payload, { type: "hello" });
    socket.close();
  });
});

test("logging in, authenticating, and dropping an attached client each notify the caller", async () => {
  // This is what the settings pane's device list and client count live-update on. A
  // device logging in over plain HTTP, or a socket attaching or dropping, happens
  // nowhere near a `remote:*` method — without this the pane only learns of any of it
  // the next time its own effect happens to run.
  await withServer(async (h) => {
    assert.equal(h.statusChanges, 0);

    const token = await loginToken(h.port);
    assert.equal(h.statusChanges, 1, "a login should notify");

    const socket = await connect(h.port);
    assert.equal(h.statusChanges, 1, "connecting alone (before auth) should not notify");
    socket.send(JSON.stringify({ type: "auth", token }));
    await nextMessage(socket);
    assert.equal(h.statusChanges, 2, "authenticating should notify");

    socket.close();
    await closed(socket);
    for (let i = 0; i < 20 && h.statusChanges < 3; i += 1) await new Promise((r) => setTimeout(r, 50));
    assert.equal(h.statusChanges, 3, "an attached client dropping should notify");
  });
});

test("a socket that never authenticates does not notify when it drops", async () => {
  // The count this drives (`clients`) is meant to answer "who is actually connected",
  // not "how many sockets happened to open and time out" — a scanner probing the port
  // must not look like device activity in the settings pane.
  await withServer(async (h) => {
    const socket = await connect(h.port);
    socket.close();
    await closed(socket);
    await new Promise((r) => setTimeout(r, 100));
    assert.equal(h.statusChanges, 0);
  });
});

test("a closed socket stops receiving pushes", async () => {
  await withServer(async (h) => {
    const token = await loginToken(h.port);
    const socket = await connect(h.port);
    socket.send(JSON.stringify({ type: "auth", token }));
    await nextMessage(socket);
    assert.equal(h.subscribers, 1);
    socket.close();
    await closed(socket);
    // Otherwise every reconnect from a flaky phone leaks a receiver that is written to
    // for the life of the process.
    for (let i = 0; i < 20 && h.subscribers > 0; i += 1) await new Promise((r) => setTimeout(r, 50));
    assert.equal(h.subscribers, 0);
  });
});

test("a path that climbs out of the web root does not escape it", async () => {
  // The credential file sits one level above what is served. Every spelling of "go up
  // one directory" must land back inside the root — a single one that does not is the
  // password hash handed to whoever asked for it.
  await withServer(async ({ port }) => {
    const attempts = [
      "/../remote-access.json",
      "/../../remote-access.json",
      "/web/../../remote-access.json",
      "/..%2fremote-access.json",
      "/%2e%2e/remote-access.json",
      "/%2e%2e%2fremote-access.json",
      "/a/b/../../../remote-access.json",
      "/.%2e/remote-access.json",
    ];
    for (const path of attempts) {
      const response = await fetch(`http://127.0.0.1:${port}${path}`);
      const text = await response.text();
      assert.doesNotMatch(text, /scrypt\$/, `leaked credentials via ${path}`);
      assert.doesNotMatch(text, /"password"/, `leaked credentials via ${path}`);
    }
  });
});

test("a file inside the web root is served, so the check is not simply refusing everything", async () => {
  // Without this the traversal test above would pass just as well against a server that
  // serves nothing at all.
  await withServer(async ({ port }) => {
    const response = await fetch(`http://127.0.0.1:${port}/`);
    assert.equal(response.status, 200);
    assert.match(await response.text(), /<title>client<\/title>/);
  });
});

test("the credential file is not world readable", async () => {
  const dir = await mkdtemp(join(tmpdir(), "fastvibe-remote-"));
  const file = join(dir, "remote-access.json");
  setPassword(file, PASSWORD);
  const mode = statSync(file).mode & 0o777;
  assert.equal(mode, 0o600, `expected 0600, found ${mode.toString(8)}`);
  await rm(dir, { recursive: true, force: true });
});
