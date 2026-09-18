import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { connect as netConnect } from "node:net";
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

async function withServer(
  fn: (h: Harness) => Promise<void>,
  options: { heartbeatMs?: number } = {},
): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), "fastvibe-remote-"));
  // The real layout: the web root holds the built client and nothing else, and the
  // credential file is a sibling of it rather than something inside what is served.
  // A static server serves what is under its root — keeping secrets out of that
  // directory is the rule, and the traversal check below is what enforces the boundary.
  const accessFile = join(dir, "remote-access.json");
  const webRoot = join(dir, "web");
  await mkdir(webRoot, { recursive: true });
  // Both built pages land in the same directory, which is the situation the routing
  // below has to get right: the client is what a browser may have, the desktop page is
  // what it must never be handed.
  await writeFile(join(webRoot, "remote.html"), "<!doctype html><title>client</title>", "utf8");
  await writeFile(join(webRoot, "index.html"), "<!doctype html><title>desktop</title>", "utf8");
  // The icons are a directory of the icon-theme package, outside the web root: the
  // desktop reads them through an Electron scheme, and the browser client over HTTP.
  const iconRoot = join(dir, "icons");
  await mkdir(iconRoot, { recursive: true });
  await writeFile(join(iconRoot, "typescript.svg"), "<svg id='ts'/>", "utf8");
  await writeFile(join(iconRoot, "file.svg"), "<svg id='generic'/>", "utf8");
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
    iconRoot,
    heartbeatMs: options.heartbeatMs,
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

/**
 * A handshake written by hand, so a test can choose the headers a tunnel would add.
 *
 * The `ws` client will not let a caller set `Host` or `Origin` freely, and those two are
 * the whole question here — so this speaks the upgrade itself and reports whatever came
 * back. No answer at all (the socket destroyed) is the refusal; `101` is the socket.
 */
async function upgrade(port: number, headers: Record<string, string>): Promise<string> {
  return new Promise((settle, fail) => {
    const socket = netConnect(port, "127.0.0.1", () => {
      const head = Object.entries(headers)
        .map(([name, value]) => `${name}: ${value}\r\n`)
        .join("");
      socket.write(
        `GET /ws HTTP/1.1\r\n${head}Upgrade: websocket\r\nConnection: Upgrade\r\n` +
          "Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nSec-WebSocket-Version: 13\r\n\r\n",
      );
    });
    let received = "";
    let settled = false;
    let timer: NodeJS.Timeout;
    const finish = (): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      settle(received);
    };
    timer = setTimeout(() => {
      socket.destroy();
      fail(new Error("no answer to the upgrade"));
    }, 4000);
    socket.on("data", (chunk) => {
      received += chunk.toString();
      if (received.includes("\r\n\r\n")) finish();
    });
    socket.on("close", finish);
    socket.on("error", finish);
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

test("the desktop page is never served, by any spelling", async () => {
  // It is the Electron window's document: it reads `window.fastvibe` as it loads, which
  // a browser has no preload to provide, so serving it looks exactly like a client that
  // white-screens. Asking for it by name gets the real client instead.
  await withServer(async ({ port }) => {
    for (const path of ["/index.html", "/./index.html", "/%69ndex.html", "/a/../index.html"]) {
      const response = await fetch(`http://127.0.0.1:${port}${path}`);
      const text = await response.text();
      assert.doesNotMatch(text, /<title>desktop<\/title>/, `served the desktop page via ${path}`);
      assert.match(text, /<title>client<\/title>/, `should fall back to the client for ${path}`);
    }
  });
});

test("an unknown route falls through to the client, so it can own its own paths", async () => {
  await withServer(async ({ port }) => {
    const response = await fetch(`http://127.0.0.1:${port}/settings/remote`);
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

test("file icons are served over HTTP, because a browser has no private scheme", async () => {
  // `fastvibe-icon://` is a `protocol.handle` in Main, so it resolves in a window and
  // nowhere else; without this route every file chip in the web client is a broken
  // image. Unauthenticated on purpose — the page needs them before it has a socket.
  await withServer(async ({ port }) => {
    const hit = await fetch(`http://127.0.0.1:${port}/file-icon/typescript.svg`);
    assert.equal(hit.status, 200);
    assert.equal(hit.headers.get("content-type"), "image/svg+xml");
    assert.match(await hit.text(), /id='ts'/);

    // The theme's manifest names generated clones that never shipped as files, so an
    // unknown name is the generic glyph rather than a broken image.
    const missing = await fetch(`http://127.0.0.1:${port}/file-icon/not-an-icon.svg`);
    assert.equal(missing.status, 200);
    assert.match(await missing.text(), /id='generic'/);
  });
});

test("the icon route serves only icon names, and nothing through them", async () => {
  // This directory is addressed by name, not resolved from a path, so the guard is the
  // character class. A name that could name anything else is refused outright.
  await withServer(async ({ port }) => {
    const attempts = [
      "/file-icon/%2e%2e%2fremote-access.json",
      "/file-icon/..%2f..%2fremote-access.json",
      "/file-icon/%2fetc%2fpasswd",
      "/file-icon/sub%2fdir.svg",
    ];
    for (const path of attempts) {
      const response = await fetch(`http://127.0.0.1:${port}${path}`);
      const text = await response.text();
      assert.doesNotMatch(text, /scrypt\$/, `leaked credentials via ${path}`);
      assert.doesNotMatch(text, /"password"/, `leaked credentials via ${path}`);
      assert.doesNotMatch(text, /root:/, `served a system file via ${path}`);
    }
  });
});

test("a request that will not parse is answered, not left hanging", async () => {
  // Both halves of a request line come off the wire: `GET /%` is not decodable, and a
  // `Host` of `bad host` makes the base URL invalid. Either one thrown out of the
  // request handler reaches no catch but the process-wide logger's, which records it
  // and leaves the socket open — a client that waits forever, and one error line per
  // scan of a public tunnel.
  await withServer(async ({ port }) => {
    const malformed = await fetch(`http://127.0.0.1:${port}/%`);
    assert.equal(malformed.status, 200);
    assert.match(await malformed.text(), /<title>client<\/title>/);

    const badHost = await new Promise<string>((settle, fail) => {
      const socket = netConnect(port, "127.0.0.1", () => {
        socket.write("GET / HTTP/1.1\r\nHost: bad host\r\nConnection: close\r\n\r\n");
      });
      let received = "";
      const timer = setTimeout(() => {
        socket.destroy();
        fail(new Error("no response: the request hung"));
      }, 4000);
      socket.on("data", (chunk) => {
        received += chunk.toString();
      });
      socket.on("end", () => {
        clearTimeout(timer);
        settle(received);
      });
      socket.on("error", (error) => {
        clearTimeout(timer);
        fail(error);
      });
    });
    assert.match(badHost, /^HTTP\/1\.1 400 /);
  });
});

test("a websocket upgrade with an unparseable host is refused, not thrown on", async () => {
  await withServer(async ({ port }) => {
    const closed = await new Promise<boolean>((settle) => {
      const socket = netConnect(port, "127.0.0.1", () => {
        socket.write(
          "GET /ws HTTP/1.1\r\nHost: bad host\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n" +
            "Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nSec-WebSocket-Version: 13\r\n\r\n",
        );
      });
      const timer = setTimeout(() => {
        socket.destroy();
        settle(false);
      }, 4000);
      const finish = (): void => {
        clearTimeout(timer);
        settle(true);
      };
      socket.on("close", finish);
      socket.on("end", finish);
      socket.on("error", finish);
    });
    assert.equal(closed, true, "the upgrade should be closed rather than left open");

    // And the server is still answering afterwards, which is what says the throw did
    // not take the listener with it.
    const after = await fetch(`http://127.0.0.1:${port}/`);
    assert.equal(after.status, 200);
  });
});

test("an upgrade through a tunnel that rewrites Host is allowed", async () => {
  // Every tunnel rewrites `Host` to the address it forwards to, by default, while the
  // page sits on the public hostname — so judging on `Host` alone refused everyone who
  // brought their own tunnel, with 「连接被断开」 on screen and one warn line in the log.
  await withServer(async ({ port }) => {
    // ngrok's default shape: `Host` rewritten, the public name in `X-Forwarded-Host`.
    const ngrok = await upgrade(port, {
      Host: "127.0.0.1:7777",
      Origin: "https://calm-otter-42.ngrok-free.app",
      "X-Forwarded-Host": "calm-otter-42.ngrok-free.app",
      "X-Forwarded-Proto": "https",
    });
    assert.match(ngrok, /^HTTP\/1\.1 101 /, "ngrok's default shape should reach the socket");

    // cloudflared's shape: `Host` rewritten to the origin service and no
    // `X-Forwarded-Host` at all, only the proto/for pair.
    const cloudflared = await upgrade(port, {
      Host: "127.0.0.1:7777",
      Origin: "https://random-words.trycloudflare.com",
      "X-Forwarded-Proto": "https",
      "X-Forwarded-For": "203.0.113.7",
    });
    assert.match(cloudflared, /^HTTP\/1\.1 101 /, "cloudflared's default shape should reach the socket");

    // A chain of proxies sends a list, and the first entry is the host asked for.
    const chained = await upgrade(port, {
      Host: "127.0.0.1:7777",
      Origin: "https://fv.example.com",
      "X-Forwarded-Host": "fv.example.com, inner.example.com",
    });
    assert.match(chained, /^HTTP\/1\.1 101 /, "a forwarded host list should compare by its first entry");
  });
});

test("the origin check still refuses a page that dials this server itself", async () => {
  await withServer(async ({ port }) => {
    // A page at evil.example.com opening a socket here directly: no proxy, so none of
    // the headers rules 2 and 3 read, and the page is not where the socket points.
    const crossOrigin = await upgrade(port, {
      Host: `127.0.0.1:${port}`,
      Origin: "https://evil.example.com",
    });
    assert.doesNotMatch(crossOrigin, /101/, "a cross-origin page must not get a socket");

    // When `X-Forwarded-Host` is there it is the authoritative answer, so a value that
    // disagrees with the origin refuses rather than falling through to the looser rule.
    const mismatched = await upgrade(port, {
      Host: "127.0.0.1:7777",
      Origin: "https://evil.example.com",
      "X-Forwarded-Host": "calm-otter-42.ngrok-free.app",
      "X-Forwarded-Proto": "https",
    });
    assert.doesNotMatch(mismatched, /101/, "a forwarded host that disagrees must refuse");

    // The same-origin case still works, which is what makes the two refusals mean
    // something rather than the socket being closed for an unrelated reason.
    const sameOrigin = await upgrade(port, {
      Host: `127.0.0.1:${port}`,
      Origin: `http://127.0.0.1:${port}`,
    });
    assert.match(sameOrigin, /^HTTP\/1\.1 101 /, "a same-origin page must still connect");
  });
});

test("a socket that stops answering is dropped, and one that answers is kept", async () => {
  // A tunnel cuts a WebSocket that goes quiet (Cloudflare's edge at 100s, nginx's
  // `proxy_read_timeout` at 60), and quiet is the normal case: reading a transcript is a
  // socket with nothing to say. The heartbeat is also the only thing that notices a
  // half-open connection through a tunnel, which otherwise looks attached forever.
  await withServer(async ({ port }) => {
    const silent = new WebSocket(`ws://127.0.0.1:${port}/ws`, { autoPong: false });
    await new Promise((settle) => silent.once("open", settle));
    // No close code asserted: a terminated socket is an abnormal closure (1006) rather
    // than a frame, and "it went away" is the whole claim.
    await closed(silent);

    const live = new WebSocket(`ws://127.0.0.1:${port}/ws`);
    await new Promise((settle) => live.once("open", settle));
    // Several rounds of pings, each answered — a client that pongs must not be dropped.
    await new Promise((settle) => setTimeout(settle, 400));
    assert.equal(live.readyState, WebSocket.OPEN, "a client that answers must survive");
    live.close();
  }, { heartbeatMs: 50 });
});
