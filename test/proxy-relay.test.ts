import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import net from "node:net";
import https from "node:https";
import { proxies } from "proxy-agent";
import { once } from "node:events";
import { startProxyRelay } from "../src/main/engine/proxy-relay.ts";

async function listen(server: net.Server): Promise<number> {
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  return (server.address() as net.AddressInfo).port;
}
function auth(url: URL): string {
  return `Basic ${Buffer.from(`${url.username}:${url.password}`).toString("base64")}`;
}
async function get(relay: string, path: string, headers: http.OutgoingHttpHeaders = {}) {
  const url = new URL(relay);
  return new Promise<{ status: number; body: string; headers: http.IncomingHttpHeaders }>((resolve, reject) => {
    const req = http.request({ hostname: url.hostname, port: url.port, agent: new http.Agent(), path, headers: { "Proxy-Authorization": auth(url), ...headers } }, (res) => {
      let body = "";
      res.setEncoding("utf8").on("data", (chunk) => body += chunk);
      res.on("end", () => resolve({ status: res.statusCode!, body, headers: res.headers }));
    });
    req.on("error", reject).end();
  });
}
async function tunnel(relay: string, authority: string, authorized = true) {
  const url = new URL(relay);
  return new Promise<{ status: number; socket: net.Socket; head: Buffer }>((resolve, reject) => {
    const req = http.request({ hostname: url.hostname, port: url.port, agent: new http.Agent(), method: "CONNECT", path: authority, headers: authorized ? { "Proxy-Authorization": auth(url) } : {} });
    req.on("connect", (res, socket, head) => resolve({ status: res.statusCode!, socket, head }));
    req.on("error", reject).end();
  });
}

test("relay authenticates, validates absolute targets and strips hop-by-hop credentials", async (t) => {
  let seen: http.IncomingHttpHeaders = {};
  const origin = http.createServer((req, res) => {
    seen = req.headers;
    res.writeHead(200, { Connection: "x-private", "x-private": "secret", "content-type": "text/plain" });
    res.end("origin");
  });
  const port = await listen(origin);
  t.after(() => origin.close());
  const resolved: string[] = [];
  const relay = await startProxyRelay(async (url) => { resolved.push(url); return ""; });
  t.after(() => relay.close());
  const path = `http://127.0.0.1:${port}/hello`;
  assert.equal((await get(relay.url, path, { "Proxy-Authorization": "" })).status, 407);
  assert.equal((await get(relay.url, path, { "Proxy-Authorization": "Basic wrong" })).status, 407);
  for (const bad of ["/relative", "ftp://localhost/file", "http://user:pass@localhost/", "http://localhost/#fragment"]) {
    assert.equal((await get(relay.url, bad)).status, 400);
  }
  assert.deepEqual(resolved, []);
  const result = await get(relay.url, path, { Connection: "x-private", "x-private": "secret", Authorization: "Bearer origin-only", Host: "wrong" });
  assert.equal(result.body, "origin");
  assert.equal(seen["proxy-authorization"], undefined);
  assert.equal(seen["x-private"], undefined);
  assert.equal(seen.authorization, "Bearer origin-only");
  assert.equal(seen.host, `127.0.0.1:${port}`);
  assert.equal(result.headers["x-private"], undefined);
});

test("HTTP upstream receives its own auth, never local credentials; errors do not bypass", async (t) => {
  let originHits = 0;
  const origin = http.createServer((_req, res) => { originHits++; res.end("bypassed"); });
  const port = await listen(origin);
  t.after(() => origin.close());
  let seen: http.IncomingHttpHeaders = {};
  let path = "";
  const proxy = http.createServer((req, res) => { seen = req.headers; path = req.url!; res.end("upstream"); });
  const proxyPort = await listen(proxy);
  t.after(() => proxy.close());
  let mode = "proxy";
  const relay = await startProxyRelay(async () => {
    if (mode === "throw") throw new Error("PAC failed");
    if (mode === "invalid") return "ftp://127.0.0.1:1234";
    return `http://upstream:secret@127.0.0.1:${proxyPort}`;
  });
  t.after(() => relay.close());
  const target = `http://127.0.0.1:${port}/resource`;
  assert.equal((await get(relay.url, target)).body, "upstream");
  assert.equal(path, target);
  assert.equal(seen["proxy-authorization"], `Basic ${Buffer.from("upstream:secret").toString("base64")}`);
  for (mode of ["throw", "invalid"]) assert.equal((await get(relay.url, target)).status, 502);
  mode = "proxy";
  await new Promise<void>((resolve) => proxy.close(() => resolve()));
  assert.equal((await get(relay.url, target)).status, 502);
  assert.equal(originHits, 0);
});

test("direct CONNECT tunnels bytes, checks credentials/authority, close terminates tunnels", async (t) => {
  const echo = net.createServer((socket) => socket.pipe(socket));
  const port = await listen(echo);
  t.after(() => echo.close());
  const relay = await startProxyRelay(async () => "");
  t.after(() => relay.close());
  const unauthorized = await tunnel(relay.url, `127.0.0.1:${port}`, false);
  assert.equal(unauthorized.status, 407);
  unauthorized.socket.destroy();
  for (const bad of ["localhost", "localhost:0", "user@localhost:80", "localhost:80/path"]) {
    const result = await tunnel(relay.url, bad);
    assert.equal(result.status, 400);
    result.socket.destroy();
  }
  const result = await tunnel(relay.url, `127.0.0.1:${port}`);
  assert.equal(result.status, 200);
  result.socket.write("hello tunnel");
  assert.equal(String((await once(result.socket, "data"))[0]), "hello tunnel");
  const ended = once(result.socket, "close");
  result.socket.resume();
  await relay.close();
  await ended;
  await relay.close();
  await assert.rejects(get(relay.url, "http://localhost/"));
});

test("CONNECT via HTTP upstream handles success and rejection without direct fallback", async (t) => {
  let reject = false;
  let seen: http.IncomingHttpHeaders = {};
  const proxy = http.createServer();
  proxy.on("connect", (req, socket, head) => {
    seen = req.headers;
    if (reject) { socket.end("HTTP/1.1 403 Forbidden\r\n\r\n"); return; }
    socket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
    if (head.length) socket.write(head);
    socket.pipe(socket);
  });
  const port = await listen(proxy);
  t.after(() => proxy.close());
  const relay = await startProxyRelay(async () => `http://user:pass@127.0.0.1:${port}`);
  t.after(() => relay.close());
  const result = await tunnel(relay.url, "unresolvable.invalid:443");
  assert.equal(result.status, 200);
  assert.equal(seen["proxy-authorization"], `Basic ${Buffer.from("user:pass").toString("base64")}`);
  result.socket.write("echo");
  assert.equal(String((await once(result.socket, "data"))[0]), "echo");
  result.socket.destroy();
  reject = true;
  const denied = await tunnel(relay.url, "unresolvable.invalid:443");
  assert.equal(denied.status, 502);
  denied.socket.destroy();
});

test("resolution timeout returns 502 and never contacts origin", async (t) => {
  let hits = 0;
  const origin = http.createServer((_req, res) => { hits++; res.end(); });
  const port = await listen(origin);
  t.after(() => origin.close());
  let started!: () => void;
  const resolving = new Promise<void>((resolve) => { started = resolve; });
  const relay = await startProxyRelay(async () => { started(); return new Promise<string>(() => {}); });
  t.after(() => relay.close());
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const result = get(relay.url, `http://127.0.0.1:${port}/`);
  await resolving;
  t.mock.timers.tick(30_000);
  assert.equal((await result).status, 502);
  assert.equal(hits, 0);
});

test("close cancels an HTTP upstream stalled during CONNECT", async (t) => {
  const proxy = http.createServer();
  let incoming!: net.Socket;
  let accepted!: () => void;
  const ready = new Promise<void>((resolve) => { accepted = resolve; });
  proxy.on("connect", (_req, socket) => { incoming = socket as net.Socket; accepted(); });
  const port = await listen(proxy);
  t.after(() => { incoming?.destroy(); proxy.close(); });
  const relay = await startProxyRelay(async () => `http://127.0.0.1:${port}`);
  t.after(() => relay.close());
  const waiting = tunnel(relay.url, "unresolvable.invalid:443").catch(() => undefined);
  await ready;
  const ended = once(incoming, "end");
  incoming.resume();
  await relay.close();
  await ended;
  await waiting;
});

test("SOCKS5h tunnels with remote DNS and rejects failed handshakes", async (t) => {
  const sockets = new Set<net.Socket>();
  let hostname = "";
  let deny = false;
  const proxy = net.createServer((socket) => {
    sockets.add(socket);
    socket.once("close", () => sockets.delete(socket));
    let stage = 0;
    socket.on("data", (data) => {
      if (stage === 0) {
        assert.deepEqual(data, Buffer.from([5, 1, 0]));
        socket.write(Buffer.from([5, deny ? 255 : 0]));
        stage++;
      } else if (stage === 1) {
        assert.equal(data[3], 3);
        hostname = data.subarray(5, 5 + data[4]).toString();
        socket.write(Buffer.from([5, 0, 0, 1, 127, 0, 0, 1, 0, 80]));
        stage++;
      } else socket.write(data);
    });
  });
  const port = await listen(proxy);
  t.after(() => { for (const socket of sockets) socket.destroy(); proxy.close(); });
  const relay = await startProxyRelay(async () => `socks5h://127.0.0.1:${port}`);
  t.after(() => relay.close());
  const result = await tunnel(relay.url, "unresolvable.invalid:443");
  assert.equal(result.status, 200);
  assert.equal(hostname, "unresolvable.invalid");
  result.socket.write("socks payload");
  assert.equal(String((await once(result.socket, "data"))[0]), "socks payload");
  result.socket.destroy();
  deny = true;
  const rejected = await tunnel(relay.url, "unresolvable.invalid:443");
  assert.equal(rejected.status, 502);
  rejected.socket.destroy();
});

test("close cancels a SOCKS upstream stalled during handshake", async (t) => {
  let incoming!: net.Socket;
  let accepted!: () => void;
  const ready = new Promise<void>((resolve) => { accepted = resolve; });
  const proxy = net.createServer((socket) => { incoming = socket; accepted(); });
  const port = await listen(proxy);
  t.after(() => { incoming?.destroy(); proxy.close(); });
  const relay = await startProxyRelay(async () => `socks5h://127.0.0.1:${port}`);
  t.after(() => relay.close());
  const waiting = tunnel(relay.url, "unresolvable.invalid:443").catch(() => undefined);
  await ready;
  const ended = once(incoming, "end");
  incoming.resume();
  await relay.close();
  await ended;
  await waiting;
});

test("HTTP response streams before end and closing cancels pending resolution", async (t) => {
  const origin = http.createServer((_req, res) => { res.writeHead(200, { "Content-Type": "text/event-stream" }); res.write("data: first\n\n"); });
  const port = await listen(origin);
  t.after(() => { origin.closeAllConnections(); origin.close(); });
  let pending = false;
  let release!: (proxy: string) => void;
  const relay = await startProxyRelay(async () => pending ? new Promise<string>((resolve) => { release = resolve; }) : "");
  t.after(() => relay.close());
  const url = new URL(relay.url);
  const req = http.get({ hostname: url.hostname, port: url.port, path: `http://127.0.0.1:${port}/`, headers: { "Proxy-Authorization": auth(url) } });
  const [response] = await once(req, "response");
  assert.equal(String((await once(response, "data"))[0]), "data: first\n\n");
  req.destroy();
  pending = true;
  const waiting = get(relay.url, `http://127.0.0.1:${port}/`).catch(() => undefined);
  while (!release) await new Promise((resolve) => setTimeout(resolve, 5));
  await relay.close();
  release("");
  await waiting;
});


test("native relay agents bypass replaced globals, including upstream CONNECT", async (t) => {
  let hits = 0;
  const origin = http.createServer((_req, res) => { hits++; res.end("direct"); });
  const port = await listen(origin);
  t.after(() => origin.close());
  let deny = false;
  const proxy = http.createServer((_req, res) => res.end("proxied"));
  proxy.on("connect", (_req, socket) => {
    if (deny) { socket.end("HTTP/1.1 403 Forbidden\r\n\r\n"); return; }
    socket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
    socket.pipe(socket);
  });
  const proxyPort = await listen(proxy);
  t.after(() => proxy.close());
  let upstream = "";
  let resolutions = 0;
  const relay = await startProxyRelay(async () => {
    assert.ok(++resolutions < 10, "relay must not recursively resolve itself");
    return upstream;
  });
  t.after(() => relay.close());
  const oldHttp = http.globalAgent;
  const oldHttps = https.globalAgent;
  const HttpProxyAgent = await proxies.http[0]();
  const HttpsProxyAgent = await proxies.http[1]();
  http.globalAgent = new HttpProxyAgent(relay.url);
  https.globalAgent = new HttpsProxyAgent(relay.url);
  t.after(() => {
    http.globalAgent.destroy(); https.globalAgent.destroy();
    http.globalAgent = oldHttp; https.globalAgent = oldHttps;
  });
  const body = await new Promise<string>((resolve, reject) => {
    http.get(`http://127.0.0.1:${port}/`, (res) => {
      let data = "";
      res.on("data", (chunk) => data += chunk);
      res.on("end", () => resolve(data));
    }).on("error", reject);
  });
  assert.equal(body, "direct");
  upstream = `http://127.0.0.1:${proxyPort}`;
  assert.equal((await get(relay.url, `http://127.0.0.1:${port}/`)).body, "proxied");
  const connected = await tunnel(relay.url, `127.0.0.1:${port}`);
  assert.equal(connected.status, 200);
  connected.socket.write("native agent");
  assert.equal(String((await once(connected.socket, "data"))[0]), "native agent");
  connected.socket.destroy();
  deny = true;
  const refused = await tunnel(relay.url, `127.0.0.1:${port}`);
  assert.equal(refused.status, 502);
  refused.socket.destroy();
  assert.equal(hits, 1);
  assert.equal(resolutions, 4);
});

test("SOCKS5 wire addresses preserve IPv4, IPv6 and remote DNS; refusal never goes direct", async (t) => {
  let originHits = 0;
  const origin = net.createServer((socket) => { originHits++; socket.destroy(); });
  const originPort = await listen(origin);
  t.after(() => origin.close());
  const seen: Buffer[] = [];
  const sockets = new Set<net.Socket>();
  let deny = false;
  const proxy = net.createServer((socket) => {
    sockets.add(socket);
    socket.on("error", () => {});
    socket.once("close", () => sockets.delete(socket));
    let pending = Buffer.alloc(0);
    let stage = 0;
    socket.on("data", (chunk) => {
      pending = Buffer.concat([pending, chunk]);
      if (stage === 0 && pending.length >= 3) {
        assert.deepEqual(pending.subarray(0, 3), Buffer.from([5, 1, 0]));
        pending = pending.subarray(3);
        socket.write(Buffer.from([5, 0]));
        stage = 1;
      }
      if (stage === 1 && pending.length >= 5) {
        const size = pending[3] === 1 ? 4 : pending[3] === 4 ? 16 : 1 + pending[4];
        const length = 4 + size + 2;
        if (pending.length < length) return;
        seen.push(Buffer.from(pending.subarray(3, length)));
        pending = pending.subarray(length);
        stage = 2;
        // Fragment the reply, exercising the relay's exact-byte reader.
        socket.write(Buffer.from([5, deny ? 5 : 0, 0]));
        socket.write(Buffer.from([1, 127, 0, 0, 1, 0, 80]));
        if (deny) { socket.end(); return; }
      }
      if (stage === 2 && pending.length) {
        if (pending.toString().startsWith("GET ")) socket.end("HTTP/1.1 200 OK\r\nContent-Length: 5\r\nConnection: close\r\n\r\nsocks");
        else socket.write(pending);
        pending = Buffer.alloc(0);
      }
    });
  });
  const port = await listen(proxy);
  t.after(() => { for (const socket of sockets) socket.destroy(); proxy.close(); });
  const relay = await startProxyRelay(async () => `socks5://127.0.0.1:${port}`);
  t.after(() => relay.close());
  for (const [host, expected] of [
    ["127.0.0.1", Buffer.from([1, 127, 0, 0, 1])],
    ["[::1]", Buffer.from([4, ...Array(15).fill(0), 1])],
    ["[::ffff:192.0.2.1]", Buffer.from([4, ...Array(10).fill(0), 255, 255, 192, 0, 2, 1])],
    ["unresolvable.invalid", Buffer.concat([Buffer.from([3, 20]), Buffer.from("unresolvable.invalid")])],
  ] as const) {
    const result = await tunnel(relay.url, `${host}:443`);
    assert.equal(result.status, 200);
    assert.deepEqual(seen.at(-1), Buffer.concat([expected, Buffer.from([1, 187])]));
    result.socket.write("payload");
    assert.equal(String((await once(result.socket, "data"))[0]), "payload");
    result.socket.destroy();
  }
  assert.equal((await get(relay.url, "http://unresolvable.invalid/")).body, "socks");
  assert.equal(seen.at(-1)![0], 3);
  deny = true;
  assert.equal((await get(relay.url, `http://127.0.0.1:${originPort}/`)).status, 502);
  const refused = await tunnel(relay.url, `127.0.0.1:${originPort}`);
  assert.equal(refused.status, 502);
  refused.socket.destroy();
  assert.equal(originHits, 0);
});
