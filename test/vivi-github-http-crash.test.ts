// SPDX-License-Identifier: MIT
import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import { GithubTestServer } from "./fixtures/vivi-github-server.ts";
import { GithubTestDeployment } from "../src/main/bot/shadow/github-deployment.ts";
import { ShadowCredentialHost } from "../src/main/bot/shadow/credential-host.ts";
import { registerGithubShadowSource } from "../src/main/bot/shadow/github-source.ts";
import { ShadowSourceRegistry } from "../src/main/bot/shadow/source-registry.ts";
import { openShadowStore } from "../src/main/bot/shadow/store.ts";

// Parent event loop must stay live to serve the child HTTP request.
test("real process exits after HTTP branch creation: new owner only inspects persisted remote fact", async t => {
  const dir = mkdtempSync(join(tmpdir(), "vivi-github-process-")), file = join(dir, "shadow.db");
  const server = new GithubTestServer(); await server.start();
  let store = openShadowStore(file); let deployment: GithubTestDeployment | undefined;
  t.after(async () => { await deployment?.stop({ abort: true }); store.close(); await server.close(); rmSync(dir, { recursive: true, force: true }); });
  const connect = (now: number) => {
    const registry = new ShadowSourceRegistry(store); registerGithubShadowSource(registry);
    if (!registry.instance("github")?.enabled) registry.configure("github", { enabled: true, config: { repository: { id: 11, owner: "acme", name: "widget", fullName: "acme/widget" }, selfLogins: ["agent"] } });
    const credentials = new ShadowCredentialHost(registry);
    credentials.register({ id: "m11.fake", kind: "github" }, { resolve: async () => "loopback-only-secret" });
    if (!registry.credentialBinding("github")) credentials.bind("github", { id: "m11.fake", kind: "github" });
    return new GithubTestDeployment(store, registry, credentials, { baseUrl: server.baseUrl, instance: "desktop", now: () => now });
  };
  deployment = connect(1000);
  const plan = deployment.planAndQueue({ kind: "branch", source: "github", instance: "desktop", repositoryId: 11, object: { branch: "fix/crash" }, params: { baseSha: "a".repeat(40) }, preconditions: {},
    authorization: { source: "github", instance: "desktop", repositoryId: "11", ticketId: "crash-ticket", mandateId: "test-mandate", generation: 1, allowed: ["branch"] } });
  await deployment.stop(); store.close(); deployment = undefined;
  const child = spawn(process.execPath, [fileURLToPath(new URL("./fixtures/vivi-github-http-crash.ts", import.meta.url)), file, server.baseUrl], { stdio: ["ignore", "pipe", "pipe"] });
  let stderr = ""; child.stderr.on("data", chunk => { stderr += String(chunk); });
  const timer = setTimeout(() => child.kill("SIGKILL"), 10_000);
  const code = await new Promise<number | null>((resolve, reject) => { child.once("error", reject); child.once("exit", resolve); }).finally(() => clearTimeout(timer));
  assert.equal(code, 73, stderr);
  store = openShadowStore(file);
  assert.equal(store.operations.get(plan.source, plan.instance, plan.key)?.status, "uncertain");
  assert.equal(store.operations.get(plan.source, plan.instance, plan.key)?.receipt, undefined);
  assert.equal(server.state.branches.get("fix/crash"), "a".repeat(40));
  deployment = connect(3000); deployment.start(); await deployment.idle();
  assert.equal(store.operations.get(plan.source, plan.instance, plan.key)?.status, "confirmed");
  assert.equal(server.requests.filter(row => row.method === "POST").length, 1);
  assert.equal(server.requests.filter(row => row.method === "GET").length, 1);
});
