import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import https from "node:https";
import net from "node:net";
import dns from "node:dns";
import type { Duplex } from "node:stream";
import { once } from "node:events";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { getGlobalDispatcher } from "undici";
import { WebSocketServer, type WebSocket } from "ws";
import { proxyUrlFromResolution } from "../src/shared/proxy.ts";

import { installNodeProxy } from "../src/main/engine/node-proxy.ts";

// Disposable test-only identity. TLS verification is disabled on the individual
// fixture request, never process-wide (and no external endpoint is contacted).
const key = `-----BEGIN PRIVATE KEY-----
MIGHAgEAMBMGByqGSM49AgEGCCqGSM49AwEHBG0wawIBAQQg6weRwxS2qKL84azq
vpZ+d1xT1R35CnwCR7y2k7oLyKuhRANCAATMvXVF78t6nCF4HLZL19Esm0qBFW9O
ohVBPgjKpyQPL7uF8r0HGTEyKEQWXDNZdKH3hDZ6CbMGQsSYZM7pvsKG
-----END PRIVATE KEY-----`;
const cert = `-----BEGIN CERTIFICATE-----
MIIBozCCAUigAwIBAgIUJD+sr/tfE8cyNObu6Yd2fwsbe/gwCgYIKoZIzj0EAwIw
GTEXMBUGA1UEAwwOdGFyZ2V0LmludmFsaWQwHhcNMjYwOTIyMTQyMjU0WhcNMzYw
OTE5MTQyMjU0WjAZMRcwFQYDVQQDDA50YXJnZXQuaW52YWxpZDBZMBMGByqGSM49
AgEGCCqGSM49AwEHA0IABMy9dUXvy3qcIXgctkvX0SybSoEVb06iFUE+CMqnJA8v
u4XyvQcZMTIoRBZcM1l0ofeENnoJswZCxJhkzum+woajbjBsMB0GA1UdDgQWBBTC
6a01l7a0D/z/01/+ugR0H/ApnzAfBgNVHSMEGDAWgBTC6a01l7a0D/z/01/+ugR0
H/ApnzAPBgNVHRMBAf8EBTADAQH/MBkGA1UdEQQSMBCCDnRhcmdldC5pbnZhbGlk
MAoGCCqGSM49BAMCA0kAMEYCIQCt3Aoc2fF4q2AhVnoXwje2nh5y7mg277oa46qw
RSCyBQIhAJh4C6d20+Aqd5mmsk1o8Ov1d3s+2G/p1HePSAg/f1s8
-----END CERTIFICATE-----`;

const proxyKeys = ["HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "http_proxy", "https_proxy", "all_proxy", "npm_config_proxy", "npm_config_https_proxy"];
const bypassKeys = ["NO_PROXY", "no_proxy", "npm_config_noproxy"];
const envKeys = [...proxyKeys, ...bypassKeys];
const exec = promisify(execFile);

async function listen(server: net.Server) {
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  return (server.address() as net.AddressInfo).port;
}
function tracked(server: net.Server) {
  const sockets = new Set<net.Socket>();
  server.on("connection", (socket) => {
    sockets.add(socket);
    socket.on("error", () => {});
    socket.once("close", () => sockets.delete(socket));
  });
  return async () => {
    const closed = new Promise<void>((resolve) => server.close(() => resolve()));
    for (const socket of sockets) socket.destroy();
    await closed;
  };
}
function request(url: string, onRequest?: (req: http.ClientRequest) => void) {
  return new Promise<string>((resolve, reject) => {
    // Deliberately omit `agent`: these calls must use the installed global agents.
    const req = (url.startsWith("https:") ? https : http).get(url, { rejectUnauthorized: false }, (res) => {
      let text = "";
      res.setEncoding("utf8").on("data", (chunk) => text += chunk);
      res.once("end", () => res.statusCode === 200 ? resolve(text) : reject(new Error(`HTTP ${res.statusCode}`)));
      res.once("error", reject);
    });
    req.setTimeout(3000, () => req.destroy(new Error("request timed out")));
    req.once("error", reject);
    onRequest?.(req);
  });
}

function socketEvent(socket: globalThis.WebSocket, event: "open" | "close" | "message") {
  return new Promise<Event>((resolve, reject) => {
    const timer = setTimeout(() => { cleanup(); reject(new Error(`WebSocket ${event} timed out`)); }, 3000);
    const done = (value: Event) => { cleanup(); resolve(value); };
    const failed = () => { cleanup(); reject(new Error(`WebSocket failed before ${event}`)); };
    const cleanup = () => {
      clearTimeout(timer);
      socket.removeEventListener(event, done);
      socket.removeEventListener("error", failed);
    };
    socket.addEventListener(event, done, { once: true });
    // Aborting an unfinished handshake emits error before close, deliberately.
    if (event !== "close") socket.addEventListener("error", failed, { once: true });
  });
}
async function echo(socket: globalThis.WebSocket, text: string) {
  const reply = socketEvent(socket, "message");
  socket.send(text);
  assert.equal((await reply as MessageEvent).data, `echo:${text}`);
}
async function cannotSend(socket: globalThis.WebSocket) {
  assert.equal(socket.readyState, socket.CLOSED);
  // ws reports sends after termination through the callback rather than throwing.
  await assert.rejects(new Promise<void>((resolve, reject) => {
    (socket as unknown as WebSocket).send("must-not-arrive", (error) => error ? reject(error) : resolve());
  }), /not open/);
}

// Global dispatcher/agents/env are process-wide; all mutations stay inside this
// serial parent test and are restored even when a subtest fails.
test("installNodeProxy routes Node clients and descendants, resets and restores globals", { timeout: 25000 }, async (t) => {
  const before = { http: http.globalAgent, https: https.globalAgent, websocket: globalThis.WebSocket, dispatcher: getGlobalDispatcher() };
  const originalEnv = new Map(envKeys.map((key) => [key, process.env[key]]));
  // Exercise restoration of both an existing value and an absent variable.
  process.env.HTTP_PROXY = "http://previous.invalid:1234";
  delete process.env.http_proxy;
  const expectedEnv = new Map(envKeys.map((key) => [key, process.env[key]]));
  t.after(() => { for (const [key, value] of originalEnv) { if (value === undefined) delete process.env[key]; else process.env[key] = value; } });

  const lookups: string[] = [];
  const lookup = dns.lookup;
  t.mock.method(dns, "lookup", function (host: string, ...args: unknown[]) {
    if (host.endsWith(".invalid")) {
      lookups.push(host);
      // Fail before touching a real resolver, even if a regression bypasses us.
      const callback = args.at(-1) as (error: Error) => void;
      queueMicrotask(() => callback(new Error(`Direct DNS forbidden: ${host}`)));
      return;
    }
    return Reflect.apply(lookup, dns, [host, ...args]);
  });

  const secure = https.createServer({ key, cert }, (req, res) => res.end(`secure:${req.url}`));
  t.after(tracked(secure));
  const securePort = await listen(secure);
  const wsOrigin = http.createServer();
  t.after(tracked(wsOrigin));
  const wsPort = await listen(wsOrigin);
  const wss = new WebSocketServer({ noServer: true });
  t.after(() => { for (const socket of wss.clients) socket.terminate(); wss.close(); });
  const upgrades: string[] = [];
  const upgrade = (req: http.IncomingMessage, socket: Duplex, head: Buffer) => {
    upgrades.push(req.url!);
    if (req.url === "/pending") {
      // Withhold HTTP 101. Upgraded HTTP sockets are half-open: acknowledge the
      // client's FIN so the fixture itself does not retain the other TCP half.
      socket.once("end", () => socket.end());
      socket.resume();
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => ws.on("message", (data) => ws.send(`echo:${data}`)));
  };
  wsOrigin.on("upgrade", upgrade);

  const connections: string[] = [];
  const seen: { label: string; method: string; url: string; headers: http.IncomingHttpHeaders }[] = [];
  async function upstream(label: string) {
    const server = http.createServer((req, res) => {
      seen.push({ label, method: req.method!, url: req.url!, headers: req.headers });
      if (req.url!.endsWith("/redirect")) {
        res.writeHead(302, { location: "http://redirect.invalid/final" }).end();
      } else if (req.url!.endsWith("/events")) {
        res.writeHead(200, { "content-type": "text/event-stream" });
        res.write("data: first\n\n"); // Intentionally never end: abort must cancel this stream.
      } else res.end(`${label}:${req.url}`);
    });
    t.after(tracked(server));
    server.on("connection", () => connections.push(label));
    server.on("upgrade", upgrade);
    server.on("connect", (req, client, head) => {
      seen.push({ label, method: "CONNECT", url: req.url!, headers: req.headers });
      const port = req.url === "target.invalid:443" ? securePort : req.url === "socket.invalid:80" ? wsPort : undefined;
      if (!port) { client.end("HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n"); return; }
      const remote = net.connect(port, "127.0.0.1", () => {
        client.write("HTTP/1.1 200 Connection Established\r\n\r\n");
        if (head.length) remote.write(head);
        client.pipe(remote).pipe(client);
      });
      remote.on("error", () => client.destroy());
      client.once("close", () => remote.destroy());
      remote.once("close", () => client.destroy());
    });
    return `http://127.0.0.1:${await listen(server)}`;
  }
  const first = await upstream("first");
  const second = await upstream("second");
  let selected = first;
  let failure = false;
  const resolved: string[] = [];
  let controlledResolve: ((url: string) => Promise<string>) | undefined;
  const installed = await installNodeProxy(async (url) => {
    resolved.push(url);
    if (controlledResolve) return controlledResolve(url);
    if (failure) throw new Error("PAC lookup failed");
    return selected;
  });
  let closed = false;
  t.after(async () => { if (!closed) await installed.close(); });

  await t.test("global fetch and both global Agents use the upstream, never target DNS", async () => {
    assert.notEqual(getGlobalDispatcher(), before.dispatcher);
    assert.notEqual(http.globalAgent, before.http);
    assert.notEqual(https.globalAgent, before.https);
    assert.equal(await (await fetch("http://target.invalid/fetch", { signal: AbortSignal.timeout(3000) })).text(), "first:http://target.invalid/fetch");
    assert.equal(await (await fetch("http://target.invalid/redirect", { signal: AbortSignal.timeout(3000) })).text(), "first:http://redirect.invalid/final");
    assert.ok(resolved.includes("http://redirect.invalid/final"));
    assert.equal(await request("http://target.invalid/http"), "first:http://target.invalid/http");
    assert.equal(await request("https://target.invalid/https"), "secure:/https");
    assert.ok(seen.some((entry) => entry.method === "CONNECT" && entry.url === "target.invalid:443"));
    assert.deepEqual(lookups, []);
  });

  await t.test("global fetch delivers SSE before EOF and abort cancels the pending read", async () => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 3000);
    try {
      const response = await fetch("http://target.invalid/events", { signal: controller.signal });
      assert.equal(response.headers.get("content-type"), "text/event-stream");
      const reader = response.body!.getReader();
      const chunk = await reader.read();
      assert.equal(new TextDecoder().decode(chunk.value), "data: first\n\n");
      const pending = reader.read();
      controller.abort();
      await assert.rejects(pending, { name: "AbortError" });
      reader.releaseLock();
    } finally { clearTimeout(timer); controller.abort(); }
  });

  await t.test("global WebSocket exchanges messages through the proxy without target DNS", async () => {
    const socket = new globalThis.WebSocket("ws://socket.invalid/echo");
    try {
      const reply = await new Promise<string>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error("WebSocket timed out")), 3000);
        socket.addEventListener("open", () => socket.send("hello"), { once: true });
        socket.addEventListener("message", (event) => { clearTimeout(timer); resolve(String(event.data)); }, { once: true });
        socket.addEventListener("error", () => { clearTimeout(timer); reject(new Error("WebSocket failed")); }, { once: true });
      });
      assert.equal(reply, "echo:hello");
      assert.ok(upgrades.some((url) => url.endsWith("/echo")));
      assert.ok(resolved.some((url) => url.includes("socket.invalid")));
      assert.deepEqual(lookups, []);
    } finally { socket.close(); }
  });

  async function openDirect(path: string) {
    const socket = new globalThis.WebSocket(`ws://127.0.0.1:${wsPort}/${path}`);
    await socketEvent(socket, "open");
    await echo(socket, path);
    return socket;
  }
  async function pendingHandshake() {
    const incoming = once(wsOrigin, "upgrade", { signal: AbortSignal.timeout(3000) });
    const socket = new globalThis.WebSocket(`ws://127.0.0.1:${wsPort}/pending`);
    const [, transport] = await incoming as [http.IncomingMessage, Duplex, Buffer];
    assert.equal(socket.readyState, socket.CONNECTING);
    return { socket, transport };
  }

  await t.test("reset terminates existing direct WebSockets and unfinished handshakes; new sockets use the proxy", async () => {
    selected = "";
    await installed.reset();
    const direct = await openDirect("before-reset");
    const pending = await pendingHandshake();
    const terminated = Promise.all([
      socketEvent(direct, "close"), socketEvent(pending.socket, "close"),
      once(pending.transport, "close", { signal: AbortSignal.timeout(3000) }),
    ]);
    selected = first;
    await installed.reset();
    await terminated;
    await cannotSend(direct);
    await cannotSend(pending.socket);
    assert.ok(pending.transport.destroyed, "unfinished handshake must not leak its TCP connection");
    const start = seen.length;
    const replacement = new globalThis.WebSocket("ws://socket.invalid/after-reset");
    try {
      await socketEvent(replacement, "open");
      await echo(replacement, "after-reset");
      assert.ok(seen.slice(start).some((entry) => entry.label === "first" && entry.method === "CONNECT" && entry.url === "socket.invalid:80"));
      assert.deepEqual(lookups, []);
    } finally { replacement.close(); }
  });

  for (const client of ["fetch", "http", "WebSocket"] as const) {
    for (const stale of ["DIRECT", "old proxy"] as const) {
      await t.test(`reset invalidates unresolved ${client} routing returning ${stale}`, { timeout: 4000 }, async () => {
        selected = first;
        await installed.reset();
        const entered = Promise.withResolvers<void>();
        const decision = Promise.withResolvers<string>();
        controlledResolve = async () => {
          entered.resolve();
          return decision.promise;
        };
        // DIRECT targets a real local listener, so accidental direct traffic is
        // observable without DNS. The other case must never reach the old proxy.
        const path = `/stale-${client}-${stale === "DIRECT" ? "direct" : "proxy"}`;
        const target = stale === "DIRECT" ? `${first}${path}` : `http://socket.invalid${path}`;
        const startConnections = connections.length;
        const startSeen = seen.length;
        const startUpgrades = upgrades.length;
        let socket: globalThis.WebSocket | undefined;
        let pendingRequest: http.ClientRequest | undefined;
        let rejected: Promise<void>;
        let terminated: Promise<Event> | undefined;
        if (client === "WebSocket") {
          socket = new globalThis.WebSocket(target.replace(/^http:/, "ws:"));
          rejected = assert.rejects(socketEvent(socket, "open"), /WebSocket failed/);
          terminated = socketEvent(socket, "close");
        } else {
          const pending = client === "fetch"
            ? fetch(target, { signal: AbortSignal.timeout(3000) })
            : request(target, (req) => { pendingRequest = req; });
          rejected = assert.rejects(pending, (error: Error & { cause?: Error }) =>
            (error.cause?.message ?? error.message) === "Proxy configuration changed");
        }
        try {
          await entered.promise;
          controlledResolve = undefined;
          selected = second;
          await installed.reset();
          // These requests do not yet own a socket in an Agent pool. Node marks
          // HTTP destroyed now, but can defer its error until connect settles.
          if (pendingRequest) assert.equal(pendingRequest.destroyed, true, "reset must destroy requests still resolving PAC");
          if (client === "WebSocket") await rejected;
          if (terminated) await terminated;
          decision.resolve(stale === "DIRECT" ? "" : first);
          await rejected;
          // Let the retired connect continuation run before probing the new config.
          await new Promise<void>((resolve) => setImmediate(resolve));
          assert.equal(connections.length, startConnections, "stale resolution must not create a TCP connection");
          assert.equal(seen.length, startSeen, "stale resolution must not send HTTP to the origin or old proxy");
          assert.equal(upgrades.length, startUpgrades, "stale resolution must not start a WebSocket handshake");
          if (socket) await cannotSend(socket);

          if (client === "WebSocket") {
            const replacement = new globalThis.WebSocket("ws://socket.invalid/fresh-resolution");
            try {
              await socketEvent(replacement, "open");
              await echo(replacement, "fresh-resolution");
            } finally { replacement.close(); }
          } else {
            const url = "http://socket.invalid/fresh-resolution";
            const body = client === "fetch"
              ? await (await fetch(url, { signal: AbortSignal.timeout(3000) })).text()
              : await request(url);
            assert.equal(body, `second:${url}`);
          }
          assert.ok(seen.slice(startSeen).some((entry) => entry.label === "second"));
          assert.ok(seen.slice(startSeen).every((entry) => entry.label === "second"));
          assert.ok(connections.slice(startConnections).every((label) => label === "second"));
          assert.deepEqual(lookups, []);
        } finally {
          controlledResolve = undefined;
          decision.resolve(stale === "DIRECT" ? "" : first);
          socket?.close();
        }
      });
    }
  }
  selected = first;
  await installed.reset();

  async function childRequests() {
    // This is a fresh process, not one sharing our dispatcher or global agents.
    const { stdout } = await exec(process.execPath, ["--input-type=module", "-e", `
      import http from 'node:http';
      import https from 'node:https';
      import { ProxyAgent } from 'proxy-agent';
      import dns from 'node:dns';
      const lookup = dns.lookup;
      dns.lookup = (host, ...args) => {
        if (host.endsWith('.invalid')) {
          queueMicrotask(() => args.at(-1)(new Error('Direct DNS forbidden: ' + host)));
          return;
        }
        return Reflect.apply(lookup, dns, [host, ...args]);
      };
      const agent = new ProxyAgent();
      async function get(url) {
        return new Promise((resolve, reject) => {
          (url.startsWith('https:') ? https : http).get(url, { agent, rejectUnauthorized: false }, res => {
            let body = ''; res.setEncoding('utf8').on('data', part => body += part);
            res.on('end', () => resolve(body)); res.on('error', reject);
          }).on('error', reject);
        });
      }
      try {
        console.log(JSON.stringify({ env: Object.fromEntries(${JSON.stringify(envKeys)}.map(key => [key, process.env[key]])),
          http: await get('http://target.invalid/child'), https: await get('https://target.invalid/child') }));
      } finally { agent.destroy(); agent.httpAgent.destroy(); agent.httpsAgent.destroy(); }
    `], { timeout: 5000, env: { ...process.env } });
    return JSON.parse(stdout) as { env: Record<string, string>; http: string; https: string };
  }

  await t.test("children inherit authenticated relay env and transport HTTP/HTTPS through it", async () => {
    const relay = new URL(process.env.HTTP_PROXY!);
    assert.equal(relay.hostname, "127.0.0.1");
    assert.ok(relay.username && relay.password);
    assert.notEqual(relay.href, first);
    for (const key of proxyKeys) assert.equal(process.env[key], process.env.HTTP_PROXY);
    for (const key of bypassKeys) assert.equal(process.env[key], "localhost,127.0.0.1,::1");
    const result = await childRequests();
    assert.equal(result.http, "first:http://target.invalid/child");
    assert.equal(result.https, "secure:/child");
    assert.deepEqual(result.env, Object.fromEntries(envKeys.map((key) => [key, process.env[key]])));
    assert.equal(seen.find((entry) => entry.url === "http://target.invalid/child")?.headers["proxy-authorization"], undefined);
  });

  await t.test("reset switches live fetch/global Agents to the new proxy", async () => {
    const oldAgent = http.globalAgent;
    const relayUrl = process.env.HTTP_PROXY;
    const stream = await fetch("http://target.invalid/events", { signal: AbortSignal.timeout(3000) });
    const reader = stream.body!.getReader();
    await reader.read();
    const terminated = assert.rejects(reader.read());
    selected = second;
    await installed.reset();
    await terminated;
    reader.releaseLock();
    assert.notEqual(http.globalAgent, oldAgent);
    assert.equal(process.env.HTTP_PROXY, relayUrl);
    assert.equal(await (await fetch("http://target.invalid/reset", { signal: AbortSignal.timeout(3000) })).text(), "second:http://target.invalid/reset");
    assert.equal(await request("http://target.invalid/reset-agent"), "second:http://target.invalid/reset-agent");
    assert.equal(await request("https://target.invalid/reset-secure"), "secure:/reset-secure");
    assert.ok(seen.some((entry) => entry.label === "second" && entry.method === "CONNECT"));
    const child = await childRequests();
    assert.equal(child.http, "second:http://target.invalid/child");
    assert.equal(child.https, "secure:/child");
  });

  await t.test("PAC errors and refused upstreams fail closed, including a trailing DIRECT", async () => {
    failure = true;
    await assert.rejects(fetch("http://target.invalid/fail", { signal: AbortSignal.timeout(3000) }), (error: Error & { cause?: Error }) => error.cause?.message === "PAC lookup failed");
    await assert.rejects(request("http://target.invalid/fail"), /PAC lookup failed/);
    await assert.rejects(request("https://target.invalid/fail"), /PAC lookup failed/);
    failure = false;
    // Closed ephemeral port: no dependency on any well-known port being unused.
    const unavailable = net.createServer();
    const port = await listen(unavailable);
    await new Promise<void>((resolve) => unavailable.close(() => resolve()));
    selected = proxyUrlFromResolution(`PROXY 127.0.0.1:${port}; DIRECT`);
    await installed.reset();
    await assert.rejects(fetch("http://target.invalid/refused", { signal: AbortSignal.timeout(3000) }));
    await assert.rejects(request("http://target.invalid/refused"));
    await assert.rejects(request("https://target.invalid/refused"));
    assert.deepEqual(lookups, [], "no fallback may resolve the target locally");
  });

  await t.test("close restores dispatcher, agents, WebSocket, env and closes the relay listener", async () => {
    selected = "";
    await installed.reset();
    const direct = await openDirect("before-close");
    const pending = await pendingHandshake();
    const terminated = Promise.all([
      socketEvent(direct, "close"), socketEvent(pending.socket, "close"),
      once(pending.transport, "close", { signal: AbortSignal.timeout(3000) }),
    ]);
    const relay = new URL(process.env.HTTP_PROXY!);
    await installed.close();
    closed = true;
    await terminated;
    await cannotSend(direct);
    await cannotSend(pending.socket);
    assert.ok(pending.transport.destroyed, "close must release unfinished handshake TCP connections");
    assert.equal(http.globalAgent, before.http);
    assert.equal(https.globalAgent, before.https);
    assert.equal(globalThis.WebSocket, before.websocket);
    assert.equal(getGlobalDispatcher(), before.dispatcher);
    assert.deepEqual(new Map(envKeys.map((key) => [key, process.env[key]])), expectedEnv);
    await assert.rejects(new Promise<void>((resolve, reject) => {
      const socket = net.connect(Number(relay.port), relay.hostname);
      socket.once("connect", () => { socket.destroy(); resolve(); });
      socket.once("error", reject);
    }), { code: "ECONNREFUSED" });
  });
});
