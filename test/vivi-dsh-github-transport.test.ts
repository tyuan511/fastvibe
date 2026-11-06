// SPDX-License-Identifier: MIT
// All network requests in this contract suite target an ephemeral IPv4 loopback server.
import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { ShadowCredentialHost } from "../src/main/bot/shadow/credential-host.ts";
import type { ShadowSourceRegistry } from "../src/main/bot/shadow/source-registry.ts";
import { GithubRestTransport, type GithubRestTransportOptions } from "../src/main/bot/shadow/github-transport.ts";

const secret = "fake-contract-token-abc";
const repository = { id: 11, owner: "acme", name: "widget" };
function credentials() {
  let revision = 1;
  let ref = { id: "fake", kind: "github" };
  const sources: string[] = [], purposes: string[] = [];
  const registry = {
    credentialBinding(source: string) { sources.push(source); return { source, ref, revision }; },
  } as unknown as ShadowSourceRegistry;
  const host = new ShadowCredentialHost(registry);
  host.register(ref, { resolve: async (_ref, purpose) => { purposes.push(purpose); return secret; } });
  return { host, sources, purposes, rotate() { ref = { id: "rotated", kind: "github" }; revision++; } };
}
async function fixture(t: TestContext, handle: (req: IncomingMessage, res: ServerResponse) => void, patch: Partial<GithubRestTransportOptions> = {}) {
  const server = createServer(handle);
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  });
  const baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const creds = credentials();
  const transport = new GithubRestTransport({ repository, credentials: creds.host, source: "github-contract", baseUrl, loopbackTest: true, ...patch });
  return { transport, baseUrl, creds };
}
const json = (res: ServerResponse, value: unknown) => { res.setHeader("content-type", "application/json"); res.end(JSON.stringify(value)); };

test("native headers, reader ETag forwarding, safe response headers and 304", async t => {
  const seen: string[] = [];
  const f = await fixture(t, (req, res) => {
    assert.equal(req.headers.authorization, `Bearer ${secret}`);
    assert.equal(req.headers.accept, "application/vnd.github+json");
    assert.equal(req.headers["x-github-api-version"], "2022-11-28");
    assert.equal(req.headers["x-ignored"], undefined);
    if (req.headers["if-none-match"]) { assert.equal(req.headers["if-none-match"], '"v1"'); res.writeHead(304); res.end(); return; }
    seen.push(req.method!);
    res.setHeader("etag", '"v1"'); res.setHeader("x-ratelimit-remaining", "42"); res.setHeader("x-github-request-id", "fake-id");
    res.setHeader("set-cookie", "sensitive"); res.setHeader("x-private", secret);
    json(res, [{ id: 1 }]);
  });
  const first = await f.transport.read({ path: "/repos/acme/widget/issues", headers: { "x-ignored": "no", Authorization: "override", Accept: "override" } });
  assert.deepEqual(first.body, [{ id: 1 }]);
  assert.deepEqual(first.headers, { etag: '"v1"', "x-ratelimit-remaining": "42", "x-github-request-id": "fake-id" });
  const second = await f.transport.read({ path: "/repos/acme/widget/issues", headers: { "If-None-Match": '"v1"' } });
  assert.equal(second.status, 304); assert.equal(second.body, null);
  assert.deepEqual(seen, ["GET"]); assert.ok(f.creds.sources.every(source => source === "github-contract"));
});

test("request preserves 5xx, serializes native JSON and accepts 204", async t => {
  const f = await fixture(t, (req, res) => {
    if (req.method === "DELETE") { res.writeHead(204); res.end(); return; }
    assert.equal(req.headers["content-type"], "application/json");
    let body = ""; req.on("data", chunk => { body += String(chunk); });
    req.on("end", () => { assert.deepEqual(JSON.parse(body), { title: "hello" }); res.statusCode = 503; json(res, { message: "temporarily unavailable" }); });
  }, { apiVersion: "2022-12-01" });
  const response = await f.transport.request("POST", "/repositories/11/issues", { title: "hello" });
  assert.equal(response.status, 503); assert.deepEqual(response.body, { message: "temporarily unavailable" });
  assert.equal((await f.transport.request("DELETE", "/repos/acme/widget/git/refs/heads/test")).body, null);
});

test("base URL and repository paths reject cross origin, cross repo and encoded traversal before credentials", async t => {
  let calls = 0;
  const f = await fixture(t, (_req, res) => { calls++; json(res, []); });
  const options = { repository, credentials: f.creds.host, source: "github-contract" };
  for (const baseUrl of [f.baseUrl, "http://localhost:9999", "https://example.com", "https://api.github.com/foo", "https://u:p@api.github.com", "https://api.github.com/?q=x"]) {
    assert.throws(() => new GithubRestTransport({ ...options, baseUrl }));
  }
  new GithubRestTransport(options); // Construction alone never performs I/O.
  for (const path of ["/repos/other/widget/issues", "/repositories/12/issues", "/repos/acme/widget-other", "/repos/acme/widget/../other", "/repos/acme/widget/%2e%2e/other", "/repos/acme/widget/%252e%252e/other", "/repos/acme/widget/%2f..%2fother", "/repos/acme/widget/%5cother", "/repos/acme/widget/issues#x", "//example.com/repos/acme/widget", "https://example.com/repos/acme/widget", "/user/repos", "/repos/%61cme/widget/issues"]) {
    await assert.rejects(f.transport.request("GET", path));
  }
  await assert.rejects(f.transport.request("POST", "/notifications", {}));
  await assert.rejects(f.transport.request("PATCH", "/user", {}));
  assert.equal(calls, 0); assert.deepEqual(f.creds.sources, []);
  for (const path of ["/user", "/notifications", "/repositories/11/issues", "/repos/acme/widget/issues?since=2025-01-01T00%3A00%3A00Z"]) await f.transport.request("GET", path);
  assert.equal(calls, 4);
});

test("redirects are rejected and never followed", async t => {
  let requests = 0;
  const f = await fixture(t, (_req, res) => { requests++; res.writeHead(302, { location: "/repos/acme/widget/issues?next=1" }); res.end(); });
  await assert.rejects(f.transport.request("GET", "/repos/acme/widget/issues"));
  assert.equal(requests, 1);
});

test("pages merges native arrays and follows Link; rejects cycles, cross origin, cross repo and limits", async t => {
  let mode = "normal", requests = 0;
  const f = await fixture(t, (req, res) => {
    requests++;
    const url = new URL(req.url!, f.baseUrl), page = Number(url.searchParams.get("page") ?? 1);
    let next: string | undefined;
    if (mode === "normal" && page === 1) next = `${f.baseUrl}/repos/acme/widget/issues?page=2`;
    if (mode === "cycle") next = `${f.baseUrl}/repos/acme/widget/issues`;
    if (mode === "foreign") next = "https://example.com/repos/acme/widget/issues";
    if (mode === "repo") next = `${f.baseUrl}/repos/acme/other/issues`;
    if (mode === "encoded") next = `${f.baseUrl}/repos/acme/widget/%2e%2e/other`;
    if (mode === "limit") next = `${f.baseUrl}/repos/acme/widget/issues?page=${page + 1}`;
    if (next) res.setHeader("link", `<${next}>; rel="next", <${f.baseUrl}/repos/acme/widget/issues?page=9>; rel="last"`);
    json(res, [{ page }]);
  });
  assert.deepEqual(await f.transport.pages("/repos/acme/widget/issues"), [{ page: 1 }, { page: 2 }]);
  for (const bad of ["cycle", "foreign", "repo", "encoded"]) { mode = bad; const before = requests; await assert.rejects(f.transport.pages("/repos/acme/widget/issues")); assert.equal(requests - before, 1); }
  mode = "limit"; const before = requests;
  await assert.rejects(f.transport.pages("/repos/acme/widget/issues"), /100/);
  assert.equal(requests - before, 100);
});

test("pages flattens native check_runs envelopes, statuses and issue events; purpose reaches resolver", async t => {
  const sha = "a".repeat(40);
  const f = await fixture(t, (req, res) => {
    const url = new URL(req.url!, f.baseUrl);
    if (url.pathname.endsWith("/check-runs")) {
      const page = Number(url.searchParams.get("page") ?? 1);
      if (page === 1) res.setHeader("link", `<${url.pathname}?page=2>; rel="next"`);
      json(res, { total_count: 2, check_runs: [{ id: page, head_sha: sha }] });
    } else if (url.pathname.endsWith("/statuses")) json(res, [{ context: "test", state: "success" }]);
    else json(res, [{ event: "closed", commit_id: sha }]);
  }, { purpose: "reviewer" });
  assert.deepEqual(await f.transport.pages(`/repos/acme/widget/commits/${sha}/check-runs`), [{ id: 1, head_sha: sha }, { id: 2, head_sha: sha }]);
  assert.deepEqual(await f.transport.pages(`/repos/acme/widget/commits/${sha}/statuses`), [{ context: "test", state: "success" }]);
  assert.deepEqual(await f.transport.pages("/repos/acme/widget/issues/7/events"), [{ event: "closed", commit_id: sha }]);
  assert.deepEqual(f.creds.purposes, ["reviewer", "reviewer", "reviewer", "reviewer"]);
  assert.ok(f.creds.sources.every(source => source === "github-contract"));
});

test("timeout covers response body and pending headers; external abort is combined", async t => {
  const f = await fixture(t, (req, res) => {
    if (req.url!.includes("body")) { res.writeHead(200, { "content-type": "application/json" }); res.write("["); }
  }, { timeoutMs: 60 });
  for (const endpoint of ["body", "headers"]) {
    const started = Date.now(); await assert.rejects(f.transport.request("GET", `/repos/acme/widget/${endpoint}`));
    assert.ok(Date.now() - started < 1500);
  }
  const controller = new AbortController();
  const pending = f.transport.request("GET", "/repos/acme/widget/body", undefined, { signal: controller.signal });
  controller.abort(new Error(secret)); await assert.rejects(pending, error => !String(error).includes(secret));
});

test("responses scrub secret in nested values, keys and safe header values", async t => {
  const f = await fixture(t, (_req, res) => {
    res.setHeader("etag", `"${secret}"`); res.setHeader("x-private", "private");
    json(res, { [secret]: { message: `prefix ${secret}`, nested: [secret, 1, null] }, "__proto__": "ignored" });
  });
  const response = await f.transport.request("GET", "/user");
  assert.ok(!JSON.stringify(response).includes(secret));
  assert.equal(response.headers.etag, '"[REDACTED]"');
  assert.deepEqual(response.body, { "[REDACTED]": { message: "prefix [REDACTED]", nested: ["[REDACTED]", 1, null] } });
});

test("callbacks run synchronously after resolver and before fetch; callback errors never disclose secrets", async t => {
  const order: string[] = [];
  const f = await fixture(t, (_req, res) => { order.push("server"); json(res, {}); }, { beforeRequest: request => { assert.deepEqual(request, { method: "POST", path: "/repos/acme/widget/issues" }); order.push("beforeRequest"); } });
  await f.transport.request("POST", "/repos/acme/widget/issues", {}, { beforeSend: () => { assert.ok(f.creds.sources.length > 0); order.push("beforeSend"); } });
  assert.deepEqual(order, ["beforeRequest", "beforeSend", "server"]);
  order.length = 0;
  await assert.rejects(f.transport.request("POST", "/repos/acme/widget/issues", {}, { beforeSend: () => { throw new Error(secret); } }), error => !String(error).includes(secret) && !(error as Error).cause);
  assert.deepEqual(order, ["beforeRequest"]);
});

test("resolver errors, fetch errors and invalid JSON return uniform secret-free errors", async t => {
  const f = await fixture(t, (_req, res) => res.end(`invalid JSON ${secret}`));
  const errors: string[] = [];
  const capture = async (transport: GithubRestTransport) => {
    await assert.rejects(transport.request("GET", "/user"), error => { errors.push(String(error)); return !String(error).includes(secret) && !(error as Error).cause; });
  };
  await capture(f.transport);
  const opts = { repository, source: "github-contract", baseUrl: f.baseUrl, loopbackTest: true };
  await capture(new GithubRestTransport({ ...opts, credentials: f.creds.host, fetchImpl: async () => { throw new Error(secret); } }));
  const c = credentials();
  c.host.register({ id: "rotated", kind: "github" }, { resolve: async () => { throw new Error(secret); } }); c.rotate();
  await capture(new GithubRestTransport({ ...opts, credentials: c.host }));
  assert.equal(new Set(errors).size, 1);
});

test("each request resolves the current credential and uses the rotated secret", async t => {
  const rotatedSecret = "fake-rotated-contract-token";
  const seen: string[] = [];
  const f = await fixture(t, (req, res) => {
    seen.push(String(req.headers.authorization));
    json(res, { echo: req.headers.authorization });
  });
  const first = await f.transport.request("GET", "/user");
  f.creds.host.register({ id: "rotated", kind: "github" }, { resolve: async () => rotatedSecret });
  f.creds.rotate();
  const second = await f.transport.request("GET", "/user");
  assert.deepEqual(seen, [`Bearer ${secret}`, `Bearer ${rotatedSecret}`]);
  assert.deepEqual(first.body, { echo: "Bearer [REDACTED]" });
  assert.deepEqual(second.body, { echo: "Bearer [REDACTED]" });
});

test("credential rebind during resolution prevents sending; timeout prevents late resolver send", async t => {
  let requests = 0;
  const f = await fixture(t, (_req, res) => { requests++; json(res, []); });
  const c = credentials();
  let release!: (value: unknown) => void;
  c.host.register({ id: "rotated", kind: "github" }, { resolve: () => new Promise(resolve => { release = resolve; }) }); c.rotate();
  const transport = new GithubRestTransport({ repository, credentials: c.host, source: "github-contract", baseUrl: f.baseUrl, loopbackTest: true, timeoutMs: 50 });
  const pending = transport.request("GET", "/user");
  c.rotate(); release(secret); await assert.rejects(pending); assert.equal(requests, 0);
  const pendingTimeout = transport.request("GET", "/user");
  await assert.rejects(pendingTimeout); release(secret);
  await new Promise<void>(resolve => setImmediate(resolve)); assert.equal(requests, 0);
});

for (const mode of ["valid", "wrong-principal", "rebind-during-identity"] as const) test(`write principal is checked with the same secret: ${mode}`, async t => {
  const seen: string[] = []; let writes = 0, checks = 0;
  const f = await fixture(t, (req, res) => {
    seen.push(String(req.headers.authorization));
    if (req.url === "/user") {
      checks++; if (mode === "rebind-during-identity") f.creds.rotate();
      json(res, { id: mode === "wrong-principal" ? 2 : 1, login: mode === "wrong-principal" ? "reviewer" : "agent" }); return;
    }
    writes++; json(res, { ok: true });
  });
  const call = f.transport.request("POST", "/repos/acme/widget/git/refs", { ref: "refs/heads/test" }, { principal: { id: "1", login: "agent" } });
  if (mode === "valid") await call; else await assert.rejects(call);
  assert.equal(checks, 1); assert.equal(writes, mode === "valid" ? 1 : 0);
  assert.ok(seen.every(value => value === `Bearer ${secret}`));
});
