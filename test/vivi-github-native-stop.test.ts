// SPDX-License-Identifier: MIT
import assert from "node:assert/strict";
import test from "node:test";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { GithubNativeDeployment } from "../src/main/bot/shadow/github-native-deployment.ts";
import { GithubRestTransport } from "../src/main/bot/shadow/github-transport.ts";
import { registerGithubShadowSource } from "../src/main/bot/shadow/github-source.ts";
import { ShadowSourceRegistry } from "../src/main/bot/shadow/source-registry.ts";
import { ShadowCredentialHost } from "../src/main/bot/shadow/credential-host.ts";
import { openShadowStore } from "../src/main/bot/shadow/store.ts";
import * as gh from "./fixtures/vivi-github-http.ts";

test("native deployment shutdown drains and fences an in-flight Source read before the database closes", async () => {
  let entered!: () => void; const waiting = new Promise<void>(resolve => { entered = resolve; });
  const server = createServer(() => { entered(); }); // Leave headers pending until shutdown aborts the read.
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const store = openShadowStore(), registry = new ShadowSourceRegistry(store); registerGithubShadowSource(registry);
  registry.configure("github", { enabled: true, config: gh.config });
  const credentials = new ShadowCredentialHost(registry);
  credentials.register({ id: "stop.fixture", kind: "github" }, { resolve: async () => "stop-fixture-only" });
  credentials.bind("github", { id: "stop.fixture", kind: "github" });
  const reader = new GithubRestTransport({ source: "github", repository: gh.config.repository, credentials, baseUrl: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, loopbackTest: true });
  const deployment = new GithubNativeDeployment(store, registry, { reader, writer: reader, reviewer: reader, writerIdentity: { id: "1", login: "writer" }, reviewerIdentity: { id: "2", login: "reviewer" }, requiredChecks: [],
    driver: { now: () => Date.parse(gh.at), intervalMs: false, policy: () => ({ version: "read", paused: true, evalTimeoutMs: 60000,
      gate: () => ({ admissible: false, reason: "read only" }), revalidate: () => false, admitsInferred: () => false }) } });
  try {
    assert.throws(() => deployment.poll(), /尚未启动/);
    deployment.start();
    const poll = deployment.poll({ since: "2025-12-31T00:00:00Z", targets: [{ id: "issue", path: "/repos/acme/widget/issues/7", kind: "issue" }] });
    await waiting; await deployment.stop({ abort: true });
    assert.notEqual((await poll).status, "completed");
    assert.equal(store.db.countRows("vivi_triggers"), 0);
    assert.equal(store.db.countRows("vivi_source_cursors"), 0);
    assert.throws(() => deployment.poll(), /正在停止/);
    assert.throws(() => deployment.start(), /已停止/);
  } finally { await deployment.stop({ abort: true }); store.close(); server.closeAllConnections(); await new Promise<void>((resolve, reject) => server.close(e => e ? reject(e) : resolve())); }
});

test("native first beforePass can poll without racing deployment startup", async () => {
  const store = openShadowStore(), registry = new ShadowSourceRegistry(store); registerGithubShadowSource(registry);
  registry.configure("github", { enabled: true, config: gh.config });
  const credentials = new ShadowCredentialHost(registry);
  const transport = new GithubRestTransport({ source: "github", repository: gh.config.repository, credentials,
    fetchImpl: async () => { throw new Error("empty explicit poll must not request HTTP"); } });
  let polled = false;
  const deployment: GithubNativeDeployment = new GithubNativeDeployment(store, registry, { reader: transport, writer: transport, reviewer: transport,
    writerIdentity: { id: "1", login: "writer" }, reviewerIdentity: { id: "2", login: "reviewer" }, requiredChecks: [],
    driver: { now: () => Date.parse(gh.at), intervalMs: false, beforePass: async (): Promise<void> => {
      if (!polled) { polled = true; assert.equal((await deployment.poll({ targets: [] })).status, "completed"); }
    }, policy: () => ({ version: "read", paused: true, evalTimeoutMs: 60000,
      gate: () => ({ admissible: false, reason: "read only" }), revalidate: () => false, admitsInferred: () => false }) } });
  try {
    deployment.start(); await deployment.idle();
    assert.equal(polled, true); assert.equal(deployment.driver.passes.health().state, "ready");
    assert.equal(store.db.countRows("vivi_source_cursors"), 1);
  } finally { await deployment.stop(); store.close(); }
});
