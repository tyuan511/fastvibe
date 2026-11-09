// SPDX-License-Identifier: MIT
import assert from "node:assert/strict";
import test from "node:test";
import { execFile } from "node:child_process";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import type { Policy } from "../src/main/bot/core/ports.ts";
import { GithubNativeDeployment } from "../src/main/bot/shadow/github-native-deployment.ts";
import { ManagedGitRepository } from "../src/main/bot/shadow/git-repository.ts";
import { GithubRestTransport } from "../src/main/bot/shadow/github-transport.ts";
import { githubEventToTrigger, registerGithubShadowSource } from "../src/main/bot/shadow/github-source.ts";
import { ShadowSourceRegistry } from "../src/main/bot/shadow/source-registry.ts";
import { ShadowCredentialHost } from "../src/main/bot/shadow/credential-host.ts";
import { openShadowStore, type Operation } from "../src/main/bot/shadow/store.ts";
import * as gh from "./fixtures/vivi-dsh-github-http.ts";

const exec = promisify(execFile);
const ref = "refs/heads/dsh/issue-7";
const gitEnv = { ...process.env, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_AUTHOR_NAME: "Fixture", GIT_AUTHOR_EMAIL: "fixture@example.com", GIT_COMMITTER_NAME: "Fixture", GIT_COMMITTER_EMAIL: "fixture@example.com",
  GIT_AUTHOR_DATE: "2026-01-01T00:00:00Z", GIT_COMMITTER_DATE: "2026-01-01T00:00:00Z" };
async function git(directory: string, ...args: string[]) {
  return (await exec("git", ["-C", directory, ...args], { env: gitEnv })).stdout.trim();
}

async function fixture(t: { after(fn: () => Promise<void>): void }) {
  const root = await realpath(await mkdtemp(join(tmpdir(), "dsh-git-delivery-")));
  const directory = join(root, "work"), remote = join(root, "remote.git"), file = join(root, "shadow.db");
  await exec("git", ["init", "-q", "-b", "main", directory], { env: gitEnv });
  await exec("git", ["init", "-q", "--bare", remote], { env: gitEnv });
  await git(directory, "commit", "--allow-empty", "-m", "base");
  const parentSha = await git(directory, "rev-parse", "HEAD");
  await git(directory, "update-ref", ref, parentSha);
  await git(directory, "push", "-q", remote, `${ref}:${ref}`);
  const repo = new ManagedGitRepository({ directory, ref, remote, localTest: true });
  let commits = 0, pushes = 0, reads = 0, http = 0, credentialsRead = 0, revision: number | undefined = 1, now = Date.parse(gh.issue.updated_at) + 1_000;
  const commitExact = repo.commitExact.bind(repo), pushExact = repo.pushExact.bind(repo), remoteRef = repo.remoteRef.bind(repo);
  repo.commitExact = async (...args) => { commits++; return commitExact(...args); };
  repo.pushExact = async (...args) => { pushes++; return pushExact(...args); };
  repo.remoteRef = async (...args) => { reads++; return remoteRef(...args); };
  let store = openShadowStore(file);
  const config = { ...gh.config, selfLogins: ["agent"] };
  const policy: Policy = { version: "git-delivery", paused: false, evalTimeoutMs: 60_000,
    gate: () => ({ admissible: true, strength: "explicit", basis: { via: "listed" } }), revalidate: () => true, admitsInferred: () => true };
  let registry: ShadowSourceRegistry;
  const connect = () => {
    registry = new ShadowSourceRegistry(store); registerGithubShadowSource(registry);
    if (!registry.instance("github")?.revision) registry.configure("github", { enabled: true, config });
    const credentials = new ShadowCredentialHost(registry);
    credentials.register({ id: "fake.git.writer", kind: "github" }, { resolve: async () => { credentialsRead++; throw new Error("No credentials for local Git"); } });
    if (!registry.credentialBinding("github")) credentials.bind("github", { id: "fake.git.writer", kind: "github" });
    const transport = new GithubRestTransport({ repository: gh.config.repository, credentials, source: "github", baseUrl: "http://127.0.0.1:1", loopbackTest: true,
      fetchImpl: async () => { http++; throw new Error("HTTP forbidden"); } });
    transport.read = async () => { http++; throw new Error("HTTP forbidden"); };
    // Local managed Git must never use any of these REST transports.
    return new GithubNativeDeployment(store, registry, { reader: transport, writer: transport, reviewer: transport,
      writerIdentity: { id: "1", login: "agent" }, reviewerIdentity: { id: "2", login: "reviewer" }, requiredChecks: [], instance: "desktop",
      git: { repository: repo, directoryRevision: () => revision },
      driver: { policy: () => policy, now: () => now, intervalMs: false },
      adapters: { assessment: async () => {}, launch: async () => {}, delivery: async () => {}, notice: async () => {}, relay: async () => {}, stop: async () => {}, release: async () => {} } });
  };
  let deployment = connect();
  t.after(async () => { await deployment.stop({ abort: true }); store.close(); await rm(root, { recursive: true, force: true }); });
  const trigger = githubEventToTrigger({ type: "issues", issue: gh.issue, repository: gh.repository }, "github", "desktop", config);
  const engine = deployment.driver.engine;
  engine.sources.receive(trigger); engine.evaluateDue();
  const candidate = engine.main.candidate(trigger.id)!;
  const ticketId = engine.main.decide(trigger.id, { evalId: candidate.evalId, kind: "accept", title: "Git delivery", scope: "acme/widget", reason: "fixture" }).ticketId!;
  deployment.start(); await deployment.idle();
  const token = engine.currentBinding(ticketId)!; assert.ok(token);
  const authorization = deployment.grant(token, ["commit", "push"]);
  const snapshot = await repo.prepareCommit({ parentSha, changes: [{ path: "a.ts", content: "export const value = 1;\n" }], message: "Managed fix",
    author: { name: "Agent", email: "agent@example.com" }, timestamp: "2026-01-01T00:02:00Z" });
  const request = (kind: "commit" | "push") => ({ kind, authorization, snapshot, directoryRevision: 1, ...(kind === "push" ? { expectedRemoteSha: parentSha } : {}) });
  const current = (operation: Operation) => store.operations.get(operation.source, operation.instance, operation.key)!;
  return { repo, directory, remote, parentSha, snapshot, ticketId, token, request, current, policy,
    get store() { return store; }, get deployment() { return deployment; }, get registry() { return registry; },
    counts: () => ({ commits, pushes, reads, http, credentialsRead }), setRevision: (value: number | undefined) => { revision = value; },
    reopen: async () => { await deployment.stop({ abort: true }); store.close(); now += 120_000; store = openShadowStore(file); deployment = connect(); deployment.start(); await deployment.idle(); },
    noExternal: () => { assert.equal(http, 0); assert.equal(credentialsRead, 0); } };
}

const timeout = { timeout: 30_000 };
test("真实 Git commit/push 确认且同 intent 不重复执行", timeout, async t => {
  const h = await fixture(t);
  const commit = h.deployment.planGitAndQueue(h.request("commit"));
  assert.equal(h.deployment.planGitAndQueue(h.request("commit")).id, commit.id);
  await h.deployment.idle(); assert.equal(h.current(commit).status, "confirmed");
  assert.deepEqual(h.current(commit).receipt, { provider: "managed-git", repositoryId: "11", kind: "commit", ref,
    sha: h.snapshot.sha, tree: h.snapshot.tree, parentSha: h.parentSha, directoryRevision: 1 });
  assert.equal(await git(h.directory, "rev-parse", ref), h.snapshot.sha);
  assert.equal(await git(h.directory, "show", `${h.snapshot.sha}:a.ts`), "export const value = 1;");
  const push = h.deployment.planGitAndQueue(h.request("push")); await h.deployment.idle();
  assert.equal(h.current(push).status, "confirmed"); assert.equal(await h.repo.remoteRef(), h.snapshot.sha);
  assert.deepEqual(h.current(push).receipt, { provider: "managed-git", repositoryId: "11", kind: "push", ref,
    sha: h.snapshot.sha, tree: h.snapshot.tree, parentSha: h.parentSha, directoryRevision: 1, expectedRemoteSha: h.parentSha });
  assert.equal(h.deployment.planGitAndQueue(h.request("push")).id, push.id); await h.deployment.idle();
  assert.equal(h.counts().commits, 1); assert.equal(h.counts().pushes, 1); h.noExternal();
});

test("push 必须有同 binding 的已确认 commit", timeout, async t => {
  const h = await fixture(t), push = h.deployment.planGitAndQueue(h.request("push"));
  await h.deployment.idle(); assert.equal(h.current(push).status, "failed");
  assert.equal(h.counts().pushes, 0); assert.equal(await h.repo.remoteRef(), h.parentSha); h.noExternal();
});

test("真实 SQL enqueue ABORT 回滚 operation 和 Effect，ref 无变化", timeout, async t => {
  const h = await fixture(t);
  h.store.db.exec("CREATE TRIGGER reject_git_enqueue BEFORE INSERT ON dsh_effects WHEN NEW.kind='source-operation' BEGIN SELECT RAISE(ABORT,'git enqueue abort'); END");
  assert.throws(() => h.deployment.planGitAndQueue(h.request("commit")), /git enqueue abort/);
  assert.equal(h.store.db.countRows("dsh_operations"), 0);
  assert.equal(h.store.db.get("SELECT 1 FROM dsh_effects WHERE kind='source-operation'"), undefined);
  await h.deployment.idle(); assert.equal(h.counts().commits, 0);
  assert.equal(await git(h.directory, "rev-parse", ref), h.parentSha); h.noExternal();
});

for (const kind of ["commit", "push"] as const) test(`${kind} 成功后 confirmed SQL ABORT 保留 uncertain，重开只读确认`, timeout, async t => {
  const h = await fixture(t);
  if (kind === "push") {
    const commit = h.deployment.planGitAndQueue(h.request("commit")); await h.deployment.idle(); assert.equal(h.current(commit).status, "confirmed");
  }
  h.store.db.exec("CREATE TRIGGER reject_git_receipt BEFORE UPDATE ON dsh_operations WHEN NEW.status='confirmed' BEGIN SELECT RAISE(ABORT,'git receipt abort'); END");
  const operation = h.deployment.planGitAndQueue(h.request(kind)); await h.deployment.idle();
  assert.equal(h.current(operation).status, "uncertain"); assert.equal(h.current(operation).receipt, undefined);
  assert.equal(await git(h.directory, "rev-parse", ref), h.snapshot.sha);
  if (kind === "push") {
    assert.equal(await h.repo.remoteRef(), h.snapshot.sha);
    h.deployment.driver.engine.people.stopTicket(h.ticketId, "fixture human stop"); await h.deployment.idle();
    assert.equal(h.store.tickets.get(h.ticketId)!.ended?.outcome, "stopped");
  }
  const before = h.counts(); h.store.db.exec("DROP TRIGGER reject_git_receipt");
  await h.reopen(); assert.equal(h.current(operation).status, "confirmed");
  assert.equal(h.counts().commits, before.commits); assert.equal(h.counts().pushes, before.pushes);
  assert.equal(h.store.tickets.get(h.ticketId)!.assignments.length, 1); h.noExternal();
});

for (const drift of ["source", "policy", "binding", "directory"] as const) test(`${drift} 漂移阻止新 Git 写入`, timeout, async t => {
  const h = await fixture(t);
  if (drift === "source") h.registry.configure("github", { enabled: false, config: gh.config });
  if (drift === "policy") h.policy.revalidate = () => false;
  if (drift === "binding") h.deployment.driver.engine.people.stopTicket(h.ticketId, "fixture stop");
  if (drift === "directory") h.setRevision(2);
  if (drift === "directory") {
    const operation = h.deployment.planGitAndQueue(h.request("commit")); await h.deployment.idle(); assert.equal(h.current(operation).status, "failed");
  } else assert.throws(() => h.deployment.planGitAndQueue(h.request("commit")));
  assert.equal(h.counts().commits, 0); assert.equal(h.counts().pushes, 0);
  assert.equal(await git(h.directory, "rev-parse", ref), h.parentSha); h.noExternal();
});

test("未知远端变更只读对账仍 uncertain，禁止自动重推", timeout, async t => {
  const h = await fixture(t);
  const commit = h.deployment.planGitAndQueue(h.request("commit")); await h.deployment.idle(); assert.equal(h.current(commit).status, "confirmed");
  const other = await h.repo.prepareCommit({ parentSha: h.parentSha, changes: [{ path: "other.txt", content: "unrelated\n" }], message: "Remote change",
    author: { name: "Other", email: "other@example.com" }, timestamp: "2026-01-01T00:03:00Z" });
  await git(h.directory, "push", "-q", h.remote, `${other.sha}:${ref}`);
  const push = h.deployment.planGitAndQueue(h.request("push")); await h.deployment.idle();
  assert.equal(h.current(push).status, "uncertain"); assert.equal(h.counts().pushes, 1);
  await h.reopen(); assert.equal(h.current(push).status, "uncertain"); assert.equal(h.counts().pushes, 1);
  assert.equal(await h.repo.remoteRef(), other.sha); assert.ok(h.counts().reads > 0); h.noExternal();
});
