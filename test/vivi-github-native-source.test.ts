// SPDX-License-Identifier: MIT
import assert from "node:assert/strict";
import test from "node:test";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { GithubRestTransport } from "../src/main/bot/shadow/github-transport.ts";
import { GithubShadowSource, registerGithubShadowSource } from "../src/main/bot/shadow/github-source.ts";
import { ShadowCredentialHost } from "../src/main/bot/shadow/credential-host.ts";
import { ShadowSourceRegistry } from "../src/main/bot/shadow/source-registry.ts";
import { ShadowEngine } from "../src/main/bot/shadow/engine.ts";
import { openShadowStore } from "../src/main/bot/shadow/store.ts";
import * as gh from "./fixtures/vivi-github-http.ts";

test("native REST transport feeds the actual M9 Source without a model, write or production host", async () => {
  const requests: Array<{ method: string; etag?: string }> = [];
  const server = createServer((req, res) => {
    assert.equal(req.headers.authorization, "Bearer native-source-fixture");
    const path = new URL(req.url!, "http://127.0.0.1").pathname;
    requests.push({ method: req.method!, etag: req.headers["if-none-match"] as string | undefined });
    if (req.headers["if-none-match"] === '"native-issue"') { res.writeHead(304); res.end(); return; }
    res.writeHead(200, { "content-type": "application/json", etag: '"native-issue"' });
    res.end(JSON.stringify(path.endsWith("/issues/7") ? gh.issue : []));
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const store = openShadowStore(), registry = new ShadowSourceRegistry(store); registerGithubShadowSource(registry);
  registry.configure("github", { enabled: true, config: gh.config });
  const credentials = new ShadowCredentialHost(registry);
  credentials.register({ id: "native.source", kind: "github" }, { resolve: async () => "native-source-fixture" });
  credentials.bind("github", { id: "native.source", kind: "github" });
  const engine = new ShadowEngine(store, { now: () => Date.parse(gh.at), scope: registry, policy: () => ({ version: "observe", paused: true,
    evalTimeoutMs: 60000, gate: () => ({ admissible: false, reason: "read only" }), revalidate: () => false, admitsInferred: () => false }) });
  const transport = new GithubRestTransport({ source: "github", repository: gh.config.repository, credentials, loopbackTest: true,
    baseUrl: `http://127.0.0.1:${(server.address() as AddressInfo).port}` });
  const source = () => new GithubShadowSource({ store, registry, engine, reader: transport, source: "github", instance: "desktop", config: gh.config,
    now: () => Date.parse(gh.at), since: "2025-12-31T00:00:00Z", targets: [{ id: "issue", path: "/repos/acme/widget/issues/7", kind: "issue" }] });
  try {
    assert.equal((await source().poll()).status, "completed");
    const first = store.db.countRows("vivi_triggers"); assert.equal(first, 1);
    assert.equal((await source().poll()).status, "completed");
    assert.equal(store.db.countRows("vivi_triggers"), first);
    assert.ok(requests.some(r => r.etag === '"native-issue"'));
    assert.ok(requests.every(r => r.method === "GET"));
    assert.equal(store.tickets.list().length, 0);
    assert.equal(store.db.countRows("vivi_session_receipts"), 0);
    assert.equal(store.db.countRows("vivi_effects"), 0);
  } finally { store.close(); server.closeAllConnections(); await new Promise<void>((resolve, reject) => server.close(e => e ? reject(e) : resolve())); }
});
