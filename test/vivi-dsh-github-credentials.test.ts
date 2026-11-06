// SPDX-License-Identifier: MIT
import assert from "node:assert/strict";
import test from "node:test";
import { GithubOperationHttpAdapter, GithubTestDeployment } from "../src/main/bot/shadow/github-deployment.ts";
import { ShadowCredentialHost } from "../src/main/bot/shadow/credential-host.ts";
import { ShadowSourceRegistry } from "../src/main/bot/shadow/source-registry.ts";
import { registerGithubShadowSource } from "../src/main/bot/shadow/github-source.ts";
import { openShadowStore } from "../src/main/bot/shadow/store.ts";
import { GithubTestServer } from "./fixtures/vivi-dsh-github-server.ts";

for (const mode of ["resolver-error", "rebind", "resolver-removed"] as const) test(`HTTP credential ${mode} sends no write and cannot leak secret into persisted errors`, async t => {
  const store = openShadowStore(); const registry = new ShadowSourceRegistry(store); registerGithubShadowSource(registry);
  registry.configure("github", { enabled: true, config: { repository: { id: 11, owner: "acme", name: "widget", fullName: "acme/widget" } } });
  const host = new ShadowCredentialHost(registry), server = new GithubTestServer(); await server.start();
  const secret = "fixture-sensitive-value-123456";
  let entered!: () => void, release!: () => void;
  const waiting = new Promise<void>(resolve => { entered = resolve; }), gate = new Promise<void>(resolve => { release = resolve; });
  const unregister = host.register({ id: "fixture.old", kind: "github" }, { resolve: async () => {
    entered(); await gate; if (mode === "resolver-error") throw new Error(`credential failed ${secret}`); return secret;
  } });
  host.bind("github", { id: "fixture.old", kind: "github" });
  const deployment = new GithubTestDeployment(store, registry, host, { baseUrl: server.baseUrl });
  try {
    const plan = deployment.planAndQueue({ kind: "branch", source: "github", instance: "github", repositoryId: 11, object: { branch: "fix/secret" }, params: { baseSha: "a".repeat(40) }, preconditions: {},
      authorization: { source: "github", instance: "github", repositoryId: "11", ticketId: "t", mandateId: "d", generation: 1, allowed: ["branch"] } });
    deployment.start(); await waiting;
    if (mode === "rebind") host.bind("github", { id: "fixture.new", kind: "github" });
    if (mode === "resolver-removed") unregister();
    release(); await deployment.idle();
    assert.equal(store.operations.get(plan.source, plan.instance, plan.key)?.status, "uncertain");
    assert.equal(server.requests.length, 0);
    for (const table of ["dsh_effects", "dsh_operations", "dsh_kv", "dsh_source_cursors", "dsh_outbox"]) {
      assert.equal(JSON.stringify(store.db.all(`SELECT * FROM ${table}`)).includes(secret), false, table);
    }
    const adapter = new GithubOperationHttpAdapter({ baseUrl: server.baseUrl, credentials: host });
    await assert.rejects(adapter.inspect(plan, { source: plan.source, instance: plan.instance, key: plan.key,
      signal: new AbortController().signal, requestId: "read", claim: store.effects.get("source-operation", JSON.stringify([plan.source, plan.instance, plan.key]))! }), error => !String(error).includes(secret));
  } finally { release(); await deployment.stop({ abort: true }); store.close(); await server.close(); }
});
