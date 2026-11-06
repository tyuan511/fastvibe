// SPDX-License-Identifier: MIT
import assert from "node:assert/strict";
import test from "node:test";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openShadowStore } from "../src/main/bot/shadow/store.ts";
import { ShadowSourceRegistry } from "../src/main/bot/shadow/source-registry.ts";
import { ShadowCredentialHost } from "../src/main/bot/shadow/credential-host.ts";
import { registerGithubShadowSource } from "../src/main/bot/shadow/github-source.ts";
import { GithubNativePlanner } from "../src/main/bot/shadow/github-native-plan.ts";
import { GithubNativeOperationAdapter } from "../src/main/bot/shadow/github-native-operation.ts";
import { GithubRestTransport } from "../src/main/bot/shadow/github-transport.ts";
import { ShadowEffects } from "../src/main/bot/shadow/effects.ts";
import { ShadowOperations } from "../src/main/bot/shadow/operations.ts";
import { GithubNativeServer, BASE } from "./fixtures/vivi-dsh-github-native-server.ts";

test("native REST creation survives process exit before receipt: new owner only reads", async t => {
  const dir = mkdtempSync(join(tmpdir(), "dsh-native-crash-")), file = join(dir, "shadow.db"), server = new GithubNativeServer(); await server.start();
  let store = openShadowStore(file), effects: ShadowEffects | undefined;
  t.after(async () => { await effects?.drain({ abort: true }); store.close(); await server.close(); rmSync(dir, { recursive: true, force: true }); });
  const registry = new ShadowSourceRegistry(store); registerGithubShadowSource(registry);
  registry.configure("github", { enabled: true, config: { repository: { id: 11, owner: "acme", name: "widget" } } });
  for (const source of ["github", "github-review"]) registry.bindCredential(source, { id: source, kind: "github" });
  const planner = new GithubNativePlanner(store, registry);
  const initialEffects = new ShadowEffects(store, { now: () => 1000 }), initialOperations = new ShadowOperations(store, initialEffects, { execute: async () => { throw new Error("not started"); }, inspect: async () => ({ status: "unknown" }) }, { now: () => 1000 });
  const plan = initialOperations.plan(planner.buildIntent({ kind: "branch", source: "github", instance: "github", repositoryId: 11, object: { branch: "fix/crash" }, params: { baseSha: BASE }, preconditions: {},
    authorization: { source: "github", instance: "github", repositoryId: "11", ticketId: "crash", mandateId: "fixture", generation: 1, allowed: ["branch"] } }));
  store.close();
  const child = spawn(process.execPath, [fileURLToPath(new URL("./fixtures/vivi-dsh-github-native-crash.ts", import.meta.url)), file, server.baseUrl], { stdio: ["ignore", "pipe", "pipe"] });
  let error = ""; child.stderr.on("data", chunk => { error += String(chunk); });
  const timer = setTimeout(() => child.kill("SIGKILL"), 10_000);
  const code = await new Promise<number | null>((resolve, reject) => { child.once("error", reject); child.once("exit", resolve); }).finally(() => clearTimeout(timer));
  assert.equal(code, 75, error); store = openShadowStore(file);
  assert.equal(store.operations.get(plan.source, plan.instance, plan.key)?.status, "uncertain");
  assert.equal(store.operations.get(plan.source, plan.instance, plan.key)?.receipt, undefined);
  const credentials = new ShadowCredentialHost(new ShadowSourceRegistry(store));
  for (const [source, value] of [["github", "fake-writer"], ["github-review", "fake-reviewer"]]) credentials.register({ id: source!, kind: "github" }, { resolve: async () => value });
  const transport = (source: string) => new GithubRestTransport({ source, credentials, repository: { id: 11, owner: "acme", name: "widget" }, baseUrl: server.baseUrl, loopbackTest: true });
  effects = new ShadowEffects(store, { now: () => 3000, owner: "reopened-native", leaseMs: 1000 });
  const adapter = new GithubNativeOperationAdapter({ store, writer: transport("github"), reviewer: transport("github-review"), writerIdentity: { id: "1", login: "agent" }, reviewerIdentity: { id: "2", login: "reviewer" }, requiredChecks: ["test"], now: () => 3000,
    authorize: () => { throw new Error("recovery must not write"); } });
  const ops = new ShadowOperations(store, effects, adapter, { now: () => 3000 });
  ops.recover(); effects.start(); await effects.idle();
  assert.equal(ops.get(plan.source, plan.instance, plan.key)?.status, "confirmed");
  assert.equal(server.requests.filter(row => row.method === "POST").length, 1);
  assert.equal(server.branches.get("fix/crash"), BASE);
});
