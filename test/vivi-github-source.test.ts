import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { EngineForSources } from "../src/main/bot/core/engine.ts";
import type { Policy } from "../src/main/bot/core/ports.ts";
import { GithubHttpError, GithubShadowSource, adaptGithubResponse, githubEventToTrigger, githubNextLink, registerGithubShadowSource, type GithubRequest, type GithubResponse, type GithubShadowSourceOptions } from "../src/main/bot/shadow/github-source.ts";
import { ShadowEngine } from "../src/main/bot/shadow/engine.ts";
import { ShadowSourceRegistry } from "../src/main/bot/shadow/source-registry.ts";
import { openShadowStore, type ShadowStore } from "../src/main/bot/shadow/store.ts";
import * as gh from "./fixtures/vivi-github-http.ts";

test("native normalization preserves Thread, review version, title/body and inline evidence", () => {
  const wrap = { type: "issue_comment", comment: gh.comment, issue: { number: 7 }, repository: gh.repository };
  const original = githubEventToTrigger(wrap, "github", "desktop", gh.config);
  const edited = githubEventToTrigger({ ...wrap, comment: { ...gh.comment, body: "edited", updated_at: "2026-01-01T00:05:00Z" } }, "github", "desktop", gh.config);
  const deliveredAgain = githubEventToTrigger({ ...wrap, id: "different-delivery-id" }, "github", "desktop", gh.config);
  assert.equal(original.id, deliveredAgain.id); assert.notEqual(original.id, edited.id); assert.deepEqual(original.threads, edited.threads);
  const issue = githubEventToTrigger({ type: "issues", issue: gh.issue, repository: gh.repository }, "github", "desktop", gh.config);
  assert.deepEqual(original.threads, issue.threads); assert.ok(issue.text.includes(gh.issue.title)); assert.ok(issue.text.includes(gh.issue.body)); assert.equal(issue.addressed, "mention");
  const inline = githubEventToTrigger({ type: "pull_request_review_comment", comment: gh.inline, pull_request: gh.pull, repository: gh.repository }, "github", "desktop", gh.config);
  const review = githubEventToTrigger({ type: "pull_request_review", review: gh.review, pull_request: gh.pull, repository: gh.repository }, "github", "desktop", gh.config);
  assert.deepEqual(inline.threads, review.threads); assert.equal(inline.meta.path, gh.inline.path); assert.equal(inline.meta.line, gh.inline.line);
  assert.ok(JSON.stringify(inline.meta).includes("head-a")); assert.ok(review.text.includes("CHANGES_REQUESTED")); assert.equal(Date.parse(review.at), Date.parse(gh.review.submitted_at));
  const changedReview = githubEventToTrigger({ type: "pull_request_review", review: { ...gh.review, state: "APPROVED", commit_id: "head-b" }, pull_request: gh.pull, repository: gh.repository }, "github", "desktop", gh.config);
  assert.notEqual(review.id, changedReview.id);
  for (const [source, instance, repository] of [["github-other", "desktop", gh.config.repository], ["github", "other", gh.config.repository], ["github", "desktop", { ...gh.config.repository, id: 12 }]] as const) {
    const different = githubEventToTrigger({ type: "issue_comment", comment: { ...gh.comment, issue_url: undefined }, issue: { number: 7 } }, source, instance, { ...gh.config, repository });
    assert.notEqual(original.id, different.id); assert.notEqual(original.threads[0]!.id, different.threads[0]!.id);
  }
});

test("human classification excludes unknown actors, Apps, bots, self and CI", () => {
  for (const user of [{ login: "app", type: "App" }, { login: "robot[bot]", type: "User" }, { login: "helper", type: "User" }, { login: "fastvibe[bot]", type: "Bot" }]) {
    assert.equal(githubEventToTrigger({ type: "issue_comment", comment: { ...gh.comment, user }, issue: { number: 7 } }, "github", "desktop", gh.config).human, false);
  }
  const ci = githubEventToTrigger({ type: "check_run", check_run: gh.check, pull_request: gh.pull, repository: gh.repository }, "github", "desktop", gh.config);
  assert.equal(ci.human, false); assert.equal(ci.actor.id, "");
});

test("selfIsHuman moves the own account into the person path without weakening bot classification", () => {
  const owner = { login: "tyuan511", type: "User" };
  const issue = () => githubEventToTrigger({ type: "issues", issue: { ...gh.issue, user: owner }, repository: gh.repository }, "github", "desktop", config);
  const config = { ...gh.config, selfLogins: ["tyuan511"], botLogins: [] as string[] };
  // Default: the configured own account is this agent, so its own events are self and never a request.
  const strict = issue();
  assert.equal(strict.meta.self, true); assert.equal(strict.human, false);
  // Opted in: a single-account deployment has no other person, so the owner's Issue IS the request.
  const single = githubEventToTrigger({ type: "issues", issue: { ...gh.issue, user: owner }, repository: gh.repository },
    "github", "desktop", { ...config, selfIsHuman: true });
  assert.equal(single.meta.self, false); assert.equal(single.human, true);
  // A real bot stays machine even when it is also listed as own.
  for (const bot of [{ login: "fastvibe-vivi[bot]", type: "Bot" }, { login: "deployer", type: "Bot" }]) {
    const trigger = githubEventToTrigger({ type: "issues", issue: { ...gh.issue, user: bot }, repository: gh.repository },
      "github", "desktop", { ...config, selfLogins: [bot.login.toLowerCase()], selfIsHuman: true });
    assert.equal(trigger.human, false); assert.equal(trigger.meta.bot, true);
  }
});

function fixture(t: test.TestContext, persistent = false, source = "github") {
  const directory = persistent ? mkdtempSync(join(tmpdir(), "vivi-github-")) : undefined;
  const file = directory ? join(directory, "shadow.db") : ":memory:";
  let store: ShadowStore; let registry: ShadowSourceRegistry; let engine: ShadowEngine;
  let now = Date.parse(gh.at);
  const policy: Policy = { version: "m9-observe", paused: true, evalTimeoutMs: 60_000, gate: () => ({ admissible: false, reason: "shadow read only" }), revalidate: () => false, admitsInferred: () => false };
  function open() {
    store = openShadowStore(file); registry = new ShadowSourceRegistry(store, () => now);
    registerGithubShadowSource(registry, source);
    if (!registry.instance(source)?.enabled) registry.configure(source, { enabled: true, config: gh.config });
    engine = new ShadowEngine(store, { policy: () => policy, scope: registry, now: () => now });
  }
  open();
  t.after(() => { store.close(); if (directory) rmSync(directory, { recursive: true, force: true }); });
  return {
    get store() { return store; }, get registry() { return registry; }, get engine() { return engine; }, source,
    reopen() { store.close(); open(); }, tick(ms: number) { now += ms; }, now: () => now,
    create(read: (request: GithubRequest) => GithubResponse | Promise<GithubResponse>, sources: EngineForSources = engine.sources, extra: Partial<GithubShadowSourceOptions> = {}) {
      return new GithubShadowSource({ store, registry, engine: { sources }, source, instance: "desktop", config: gh.config, reader: { read }, now: () => now, since: "2025-12-31T00:00:00Z", ...extra });
    },
  };
}
function pathOf(request: GithubRequest): string { return new URL(request.path, "https://api.github.com").pathname; }
function rows(store: ShadowStore) { return store.db.all<{ data: string }>("SELECT data FROM vivi_triggers ORDER BY at,id").map(r => JSON.parse(r.data) as ReturnType<typeof githubEventToTrigger>); }
function checkpoints(store: ShadowStore) { return store.db.all("SELECT * FROM vivi_source_cursors ORDER BY source,instance,cursor_key"); }
function noExecution(store: ShadowStore) {
  assert.equal(store.tickets.list().length, 0);
  assert.equal(store.db.all("SELECT * FROM vivi_effects WHERE kind IN ('launch','delivery','reply','assessment')").length, 0);
  assert.equal(store.db.all("SELECT * FROM vivi_session_receipts").length, 0);
}
function reader(overrides: (request: GithubRequest) => GithubResponse | undefined = () => undefined) {
  return (request: GithubRequest): GithubResponse => {
    const custom = overrides(request); if (custom) return custom;
    const path = pathOf(request);
    if (path === "/repos/acme/widget") return { status: 200, body: gh.repository };
    if (path.endsWith("/branches/main")) return { status: 200, body: { name: "main", commit: { sha: "head-a" } } };
    if (path.endsWith("/issues/7")) return { status: 200, body: gh.issue };
    if (path.endsWith("/issues/10")) return { status: 200, body: { ...gh.issue, id: 103, number: 10, html_url: "https://github.com/acme/widget/issues/10" } };
    if (path.endsWith("/issues/8")) return { status: 200, body: { ...gh.pull, pull_request: { url: gh.pull.url } } };
    if (path.endsWith("/pulls/8")) return { status: 200, body: gh.pull };
    if (path.endsWith("/check-runs")) return { status: 200, body: { total_count: 0, check_runs: [] } };
    if (path.endsWith("/status")) return { status: 200, body: { state: "success", statuses: [] } };
    return { status: 200, body: [] };
  };
}

test("Link/response adapter preserves native object envelopes and HTTP error identity", () => {
  assert.equal(githubNextLink('<https://api.github.com/x?page=2>; rel="next", <x>; rel="last"'), "https://api.github.com/x?page=2");
  assert.equal(githubNextLink(undefined), undefined);
  assert.throws(() => adaptGithubResponse({ status: 503, body: { message: "temporary" } }), (error: unknown) => error instanceof GithubHttpError && error.status === 503);
});

test("CI aggregates all pages, reorders deterministically and persists changes across reopen", async t => {
  const f = fixture(t, true); let phase = 0;
  const read = reader(request => {
    const url = new URL(request.path, "https://api.github.com"); const path = url.pathname;
    if (path === "/notifications") return { status: 200, body: [gh.notification] };
    if (path.endsWith("/check-runs")) {
      const a = { ...gh.check, conclusion: "success" };
      const b = { ...gh.check, id: 403, name: "build", conclusion: phase === 0 ? "failure" : "success" };
      if (url.searchParams.get("page") === "2") return { status: 200, body: { total_count: 2, check_runs: [b] } };
      return { status: 200, headers: { link: `<https://api.github.com${path}?page=2>; rel="next"` }, body: { total_count: 2, check_runs: [a] } };
    }
    if (path.endsWith("/statuses")) return { status: 200, body: [gh.status, { ...gh.status, id: 400, state: "failure", created_at: "2026-01-01T00:01:00Z", updated_at: "2026-01-01T00:01:00Z" }] };
    return undefined;
  });
  assert.equal((await f.create(read).poll()).status, "completed");
  assert.equal(rows(f.store).filter(trigger => trigger.meta.ci).length, 0);
  f.reopen(); phase = 1; assert.equal((await f.create(read).poll()).status, "completed");
  const changed = rows(f.store).filter(trigger => trigger.meta.ci); assert.ok(changed.length > 0); assert.ok(changed.every(trigger => !trigger.human && trigger.actor.id === ""));
  const before = rows(f.store); f.reopen(); assert.equal((await f.create(read).poll()).status, "completed"); assert.deepEqual(rows(f.store), before); noExecution(f.store);
});

test("HTTP failures preserve retry checkpoints; secondary rate limit never revokes Source", async t => {
  for (const response of [
    { status: 404, body: { message: "missing" } },
    { status: 403, headers: { "retry-after": "20" }, body: { message: "secondary rate limit" } },
    { status: 429, headers: { "retry-after": "20" }, body: { message: "too many" } },
    { status: 503, body: { message: "temporary" } },
  ]) {
    const f = fixture(t); const before = checkpoints(f.store);
    const source = f.create(reader(request => pathOf(request) === "/repos/acme/widget/issues" ? response : undefined));
    assert.equal((await source.poll()).status, "transient-failure");
    assert.equal(f.registry.instance("github")?.status, "enabled"); assert.equal(f.registry.health("github")?.state, "degraded");
    assert.deepEqual(rows(f.store), []); assert.deepEqual(checkpoints(f.store), before);
  }
});

test("explicit revocation blocks future reads while object Gone leaves repository available", async t => {
  const f = fixture(t); let reads = 0;
  const source = f.create(request => { reads++; return { status: 401, body: { message: "bad credentials" } }; });
  assert.notEqual((await source.poll()).status, "completed"); assert.equal(f.registry.instance("github")?.status, "revoked");
  const count = reads; assert.notEqual((await source.poll()).status, "completed"); assert.equal(reads, count);
  const g = fixture(t); const gone = g.create(reader(request => {
    if (pathOf(request) === "/notifications") return { status: 200, body: [gh.notification] };
    if (pathOf(request).endsWith("/pulls/8") || pathOf(request).endsWith("/issues/8")) return { status: 410, body: { message: "gone" } };
    return undefined;
  }));
  await gone.poll(); assert.equal(g.registry.instance("github")?.status, "enabled"); noExecution(g.store);
});

test("two installed GitHub Sources persist and revoke independently", async t => {
  const f = fixture(t, false, "github-a"); const g = fixture(t, false, "github-b");
  const read = reader(request => pathOf(request) === "/repos/acme/widget/issues" ? { status: 200, body: [gh.issue] } : undefined);
  assert.equal((await f.create(read).poll()).status, "completed"); assert.equal((await g.create(read).poll()).status, "completed");
  assert.notEqual(rows(f.store)[0]!.id, rows(g.store)[0]!.id);
  f.registry.setStatus("github-a", "revoked"); assert.equal((await g.create(read).poll()).status, "completed"); assert.equal(g.registry.instance("github-b")?.status, "enabled");
});

test("committed ETags survive repeated 304 and reopen without skipping cached objects", async t => {
  const f = fixture(t, true); let conditional = 0;
  const read = reader(request => {
    if (pathOf(request) !== "/repos/acme/widget/issues") return undefined;
    if (request.headers["if-none-match"]) { conditional++; assert.equal(request.headers["if-none-match"], '"stable"'); return { status: 304, body: null }; }
    return { status: 200, headers: { etag: '"stable"' }, body: [gh.issue] };
  });
  for (let i = 0; i < 4; i++) { assert.equal((await f.create(read).poll()).status, "completed"); f.reopen(); }
  assert.equal(conditional, 2); assert.equal(rows(f.store).length, 1); noExecution(f.store);
});

test("CI changes and baselines roll back together after a real SQL abort", async t => {
  const f = fixture(t); let phase = 0;
  const read = reader(request => {
    if (pathOf(request) === "/notifications") return { status: 200, body: [gh.notification] };
    if (pathOf(request).endsWith("/check-runs")) return { status: 200, body: { check_runs: [{ ...gh.check, conclusion: phase ? "success" : "failure" }] } };
    return undefined;
  });
  assert.equal((await f.create(read).poll()).status, "completed"); const before = checkpoints(f.store); const triggers = rows(f.store); phase = 1;
  f.store.db.exec("CREATE TRIGGER m9_abort BEFORE UPDATE ON vivi_source_cursors BEGIN SELECT RAISE(ABORT, 'm9 checkpoint abort'); END");
  assert.equal((await f.create(read).poll()).status, "transient-failure"); assert.deepEqual(checkpoints(f.store), before); assert.deepEqual(rows(f.store), triggers);
  f.store.db.exec("DROP TRIGGER m9_abort"); assert.equal((await f.create(read).poll()).status, "completed"); assert.ok(rows(f.store).some(trigger => trigger.meta.ci)); noExecution(f.store);
});

test("pending default-branch checks preserve failures until complete recovery", async t => {
  const f = fixture(t); let phase = 0;
  const read = reader(request => pathOf(request).endsWith("/check-runs") ? { status: 200, body: { check_runs: [{ ...gh.check, pull_requests: [], status: phase === 1 ? "in_progress" : "completed", conclusion: phase === 0 ? "failure" : phase === 1 ? null : "success" }] } } : undefined);
  assert.equal((await f.create(read).poll()).status, "completed"); phase = 1;
  assert.equal((await f.create(read).poll()).status, "completed"); assert.equal(rows(f.store).filter(trigger => trigger.meta.ci).length, 0); phase = 2;
  assert.equal((await f.create(read).poll()).status, "completed"); const ci = rows(f.store).filter(trigger => trigger.meta.ci); assert.equal(ci.length, 1); assert.equal(ci[0]!.channel, undefined); assert.deepEqual(ci[0]!.meta.failures, []);
});

test("live first-poll baseline excludes historical descriptions and self/empty comments", async t => {
  const f = fixture(t); const read = reader(request => {
    if (pathOf(request) === "/repos/acme/widget/issues") return { status: 200, body: [gh.issue] };
    if (pathOf(request) === "/repos/acme/widget/issues/comments") return { status: 200, body: [gh.comment, { ...gh.comment, id: 999, user: { login: "fastvibe[bot]", type: "Bot" }, updated_at: gh.at }, { ...gh.comment, id: 998, body: "", updated_at: gh.at }] };
    return undefined;
  });
  assert.equal((await f.create(read, f.engine.sources, { since: undefined }).poll()).status, "completed"); assert.equal(rows(f.store).length, 0); noExecution(f.store);
});

test("pagination cycles, foreign repositories and foreign Link URLs fail without checkpoints", async t => {
  for (const mode of ["cycle", "repository", "link"] as const) {
    const f = fixture(t); const read = reader(request => {
      if (pathOf(request) !== "/repos/acme/widget/issues") return undefined;
      if (mode === "repository") return { status: 200, body: [{ ...gh.issue, repository: { ...gh.repository, id: 999 } }] };
      const next = mode === "cycle" ? request.path : "https://attacker.invalid/repos/acme/widget/issues";
      return { status: 200, headers: { link: `<${next}>; rel="next"` }, body: [gh.issue] };
    });
    assert.equal((await f.create(read).poll()).status, "transient-failure"); assert.equal(rows(f.store).length, 0); assert.deepEqual(checkpoints(f.store), []);
  }
});

test("a second reader cannot share the first reader's poll lease", async t => {
  const f = fixture(t); let release!: () => void; let entered!: () => void;
  const waiting = new Promise<void>(resolve => { release = resolve; }); const started = new Promise<void>(resolve => { entered = resolve; });
  const first = f.create(async request => { entered(); await waiting; return reader()(request); });
  const run = first.poll(); await started;
  let secondReads = 0; const second = f.create(request => { secondReads++; return reader()(request); });
  assert.equal((await second.poll()).status, "rejected"); assert.equal(secondReads, 0); release(); assert.equal((await run).status, "completed");
});

test("cursor CAS conflict rejects the whole round including newly received data", async t => {
  const f = fixture(t); const read = reader(request => pathOf(request) === "/repos/acme/widget/issues" ? { status: 200, body: [gh.issue] } : undefined);
  assert.equal((await f.create(read).poll()).status, "completed"); const before = rows(f.store); let changed = false;
  const source = f.create(reader(request => {
    if (!changed && pathOf(request) === "/repos/acme/widget/issues") {
      changed = true; const state = f.store.cursors.get("github", "desktop", "github:m9:11")!;
      assert.equal(f.store.cursors.save("github", "desktop", "github:m9:11", state.value, state.revision), true);
      return { status: 200, body: [{ ...gh.issue, id: 103, number: 10, html_url: "https://github.com/acme/widget/issues/10" }] };
    }
    return undefined;
  }));
  assert.equal((await source.poll()).status, "rejected"); assert.deepEqual(rows(f.store), before); noExecution(f.store);
});

test("PR lifecycle closes a real Follow once and reopen never wakes the ended Ticket", async t => {
  const f = fixture(t); let phase = "open"; let closeCalls = 0;
  const read = reader(request => {
    if (pathOf(request) === "/notifications") return { status: 200, body: [gh.notification] };
    if (pathOf(request).endsWith("/pulls/8")) return { status: 200, body: { ...gh.pull, ...(phase === "merged" ? { state: "closed", merged: true, merged_at: "2026-01-01T00:20:00Z" } : {}) } };
    return undefined;
  });
  assert.equal((await f.create(read).poll()).status, "completed");
  const origin = rows(f.store).find(trigger => trigger.meta.number === 8)!; assert.ok(origin);
  const policy: Policy = { version: "authorized-fixture", paused: false, evalTimeoutMs: 60_000, gate: () => ({ admissible: true, strength: "explicit", basis: { via: "listed" } }), revalidate: () => true, admitsInferred: () => true };
  const engine = new ShadowEngine(f.store, { policy: () => policy, scope: f.registry, now: f.now });
  const decision = engine.main.decide(origin.id, { kind: "accept", title: "Fix", scope: "fixture", reason: "requested" });
  const ticketId = decision.ticketId!; assert.ok(ticketId);
  const claim = (kind: "launch" | "delivery", key?: string) => {
    const pending = key ? f.store.effects.get(kind, key)! : f.store.effects.due(kind, f.now())[0]!;
    const claimed = f.store.effects.claim(kind, pending.key, "m9-fixture", f.now(), 30_000); assert.ok(claimed); return claimed;
  };
  const token = engine.completeLaunch(claim("launch")); assert.ok(token);
  const current = f.store.tickets.get(ticketId)!; if (current.undelivered.length) assert.equal(engine.completeDelivery(claim("delivery", ticketId), token), true);
  engine.worker.read(token, f.store.tickets.get(ticketId)!.inputs.map(input => input.id));
  engine.sources.bindThread(ticketId, origin.threads[0]!, true);
  engine.worker.report(token, { state: "ready", summary: "ready for merge" }); assert.equal(f.store.tickets.get(ticketId)!.ended, undefined);
  const sources: EngineForSources = { ...engine.sources, threadClosed: (thread, outcome, at) => { closeCalls++; engine.sources.threadClosed(thread, outcome, at); } };
  const before = rows(f.store).length; phase = "merged"; assert.equal((await f.create(read, sources).poll()).status, "completed");
  assert.equal(f.store.tickets.get(ticketId)!.ended?.outcome, "merged"); assert.equal(rows(f.store).length, before);
  const assignments = f.store.tickets.get(ticketId)!.assignments.length;
  assert.equal((await f.create(read, sources).poll()).status, "completed"); assert.equal(closeCalls, 1);
  phase = "open"; assert.equal((await f.create(read, sources).poll()).status, "completed"); assert.equal((await f.create(read, sources).poll()).status, "completed");
  assert.equal(f.store.tickets.get(ticketId)!.assignments.length, assignments); assert.equal(f.store.tickets.get(ticketId)!.ended?.outcome, "merged");
  phase = "merged"; assert.equal((await f.create(read, sources).poll()).status, "completed"); assert.equal(closeCalls, 2);
});

test("initial closed PR never creates an opening message after a later reopen", async t => {
  const f = fixture(t); let closed = true;
  const read = reader(request => {
    if (pathOf(request) === "/notifications") return { status: 200, body: [gh.notification] };
    if (pathOf(request).endsWith("/pulls/8")) return { status: 200, body: { ...gh.pull, ...(closed ? { state: "closed", closed_at: "2026-01-01T00:07:00Z" } : {}) } };
    return undefined;
  });
  assert.equal((await f.create(read).poll()).status, "completed"); assert.equal(rows(f.store).length, 0); closed = false;
  assert.equal((await f.create(read).poll()).status, "completed"); assert.equal((await f.create(read).poll()).status, "completed"); assert.equal(rows(f.store).length, 0); noExecution(f.store);
});

test("M9 rejects and rolls back injected execution intents", async t => {
  const f = fixture(t);
  const sources: EngineForSources = { ...f.engine.sources, receive: trigger => {
    const result = f.engine.sources.receive(trigger); f.store.effects.enqueue("launch", "forbidden", { ticketId: "forged" }, f.now()); return result;
  } };
  const read = reader(request => pathOf(request) === "/repos/acme/widget/issues" ? { status: 200, body: [gh.issue] } : undefined);
  const result = await f.create(read, sources).poll(); assert.equal(result.status, "transient-failure"); assert.match(result.error!, /M9 Shadow/);
  assert.deepEqual(rows(f.store), []); assert.deepEqual(checkpoints(f.store), []); noExecution(f.store);
});

test("rate-limit Retry-After delays explicit polling and recovers after the deadline", async t => {
  const f = fixture(t); let count = 0;
  const limited = f.create(() => { count++; return { status: 403, headers: { "retry-after": "20" }, body: { message: "secondary rate limit" } }; });
  assert.equal((await limited.poll()).status, "transient-failure"); const calls = count;
  assert.equal((await limited.poll()).status, "transient-failure"); assert.equal(count, calls); f.tick(20_001);
  assert.equal((await f.create(reader()).poll()).status, "completed"); assert.equal(f.registry.health("github")?.state, "healthy");
});

test("comment URL boundaries reject cross-repository and wrong-thread payloads", async t => {
  for (const issue_url of ["https://api.github.com/repos/other/repo/issues/7", "https://api.github.com/repos/acme/widget/issues/9"]) {
    const f = fixture(t); const read = reader(request => {
      if (pathOf(request) === "/repos/acme/widget/issues") return { status: 200, body: [gh.issue] };
      if (pathOf(request).endsWith("/issues/7/comments")) return { status: 200, body: [{ ...gh.comment, issue_url }] };
      return undefined;
    });
    assert.equal((await f.create(read).poll()).status, "transient-failure"); assert.deepEqual(rows(f.store), []); assert.deepEqual(checkpoints(f.store), []);
  }
});

test("trusted PR binding precedes first review intake and preserves its owner", async t => {
  const f = fixture(t);
  const origin = githubEventToTrigger({ issue: gh.issue }, "github", "desktop", gh.config);
  const policy: Policy = { version: "fixture", paused: true, evalTimeoutMs: 60_000, gate: () => ({ admissible: true, strength: "explicit", basis: { via: "listed" } }), revalidate: () => true, admitsInferred: () => true };
  const engine = new ShadowEngine(f.store, { policy: () => policy, scope: f.registry, now: f.now });
  engine.sources.receive(origin);
  const accepted = engine.main.decide(origin.id, { kind: "accept", title: "Fix", scope: "fixture", reason: "requested" });
  const ticket = f.store.tickets.get(accepted.ticketId!)!;
  // A valid open ticket between assignments; receiving context must not start an executor in M9.
  ticket.assignments.forEach(assignment => { assignment.state = "ended"; assignment.endedAt = gh.at; assignment.endedReason = "fixture interruption"; });
  f.store.tickets.save(ticket);
  const read = reader(request => {
    if (pathOf(request) === "/notifications") return { status: 200, body: [gh.notification] };
    if (pathOf(request).endsWith("/pulls/8")) return { status: 200, body: { ...gh.pull, user: { login: "fastvibe[bot]", type: "Bot" } } };
    if (pathOf(request).endsWith("/pulls/8/reviews")) return { status: 200, body: [gh.review] };
    return undefined;
  });
  const result = await f.create(read, engine.sources, { bindings: [{ ticketId: ticket.id, branch: "fix", repositoryId: 11 }] }).poll(); assert.equal(result.status, "completed", result.error);
  const review = rows(f.store).find(trigger => trigger.meta.kind === "review")!; assert.ok(review);
  assert.deepEqual(f.store.triggers.disposition(review.id)!.fanout, [ticket.id]); assert.ok(f.store.tickets.get(ticket.id)!.inputs.some(input => input.kind === "trigger" && input.triggerId === review.id));
});

test("native HTTP streams persist detached triggers in real ShadowStore without execution", async t => {
  const f = fixture(t, true); const requests: GithubRequest[] = [];
  const source = f.create(reader(request => {
    requests.push(structuredClone(request)); const path = pathOf(request);
    if (path === "/notifications") return { status: 200, body: [gh.notification] };
    if (path === "/repos/acme/widget/issues") return { status: 200, body: [gh.issue] };
    if (path === "/repos/acme/widget/issues/comments") return { status: 200, body: [gh.comment] };
    if (path === "/repos/acme/widget/pulls/comments") return { status: 200, body: [gh.inline] };
    if (path === "/repos/acme/widget/pulls/8/reviews") return { status: 200, body: [gh.review] };
    return undefined;
  }));
  assert.equal((await source.poll()).status, "completed");
  const stored = rows(f.store); assert.ok(stored.length >= 5);
  assert.ok(stored.some(item => item.text.includes(gh.issue.title) && item.text.includes(gh.issue.body)));
  assert.ok(stored.some(item => item.text.includes("CHANGES_REQUESTED")));
  const inline = stored.find(item => item.text.includes(gh.inline.body))!; assert.ok(inline);
  assert.ok(inline.channel); assert.equal(inline.meta.path, gh.inline.path); assert.equal(inline.meta.line, 12);
  assert.ok(requests.some(request => pathOf(request).endsWith("/pulls/8")));
  assert.ok(requests.some(request => pathOf(request).endsWith("/pulls/8/reviews")));
  noExecution(f.store); const before = rows(f.store); f.reopen(); assert.deepEqual(rows(f.store), before); noExecution(f.store);
});

test("Link pagination restarts at root each round and only reuses URL-matched ETags", async t => {
  const f = fixture(t); let round = 0; const requests: GithubRequest[] = [];
  const source = f.create(reader(request => {
    requests.push(structuredClone(request)); const url = new URL(request.path, "https://api.github.com");
    if (url.pathname !== "/repos/acme/widget/issues") return undefined;
    if (url.searchParams.get("page") === "2") { assert.equal(request.headers["if-none-match"], undefined); return { status: 200, body: [{ ...gh.issue, id: 103, number: 10, html_url: "https://github.com/acme/widget/issues/10" }] }; }
    round++;
    if (round === 1) return { status: 200, headers: { etag: '"root-v1"', link: '<https://api.github.com/repos/acme/widget/issues?page=2>; rel="next"' }, body: [gh.issue] };
    return { status: 200, headers: { etag: '"root-v2"' }, body: [gh.issue] };
  }));
  assert.equal((await source.poll()).status, "completed"); assert.equal(rows(f.store).length, 2);
  assert.equal((await source.poll()).status, "completed"); assert.equal(rows(f.store).length, 2); assert.equal(round, 2);
  const rootRequests = requests.filter(request => pathOf(request) === "/repos/acme/widget/issues" && !new URL(request.path, "https://api.github.com").searchParams.has("page"));
  assert.equal(rootRequests.length, 2); noExecution(f.store);
});

test("receive failure rolls back triggers, ETags, CI baselines and all cursors, then replay succeeds", async t => {
  const f = fixture(t); let fail = true;
  const wrapped: EngineForSources = { ...f.engine.sources, receive: trigger => { const result = f.engine.sources.receive(trigger); if (fail) throw new Error("test receive failure"); return result; } };
  const source = f.create(reader(request => pathOf(request) === "/repos/acme/widget/issues" ? { status: 200, headers: { etag: '"v1"' }, body: [gh.issue] } : undefined), wrapped);
  const before = checkpoints(f.store); assert.equal((await source.poll()).status, "transient-failure");
  assert.deepEqual(rows(f.store), []); assert.deepEqual(checkpoints(f.store), before);
  fail = false; assert.equal((await source.poll()).status, "completed"); assert.equal(rows(f.store).length, 1); noExecution(f.store);
});

test("disable and config revision changes during awaited read fence every state write", async t => {
  for (const action of ["disable", "reconfigure"] as const) {
    const f = fixture(t); let changed = false; const before = checkpoints(f.store);
    const source = f.create(reader(request => {
      if (!changed && pathOf(request) === "/repos/acme/widget/issues") {
        changed = true;
        if (action === "disable") f.registry.setStatus("github", "disabled");
        else f.registry.configure("github", { enabled: true, config: { ...gh.config, selfLogins: ["another"] } });
        return { status: 200, body: [gh.issue] };
      }
      return undefined;
    }));
    assert.notEqual((await source.poll()).status, "completed"); assert.equal(rows(f.store).length, 0); assert.deepEqual(checkpoints(f.store), before); noExecution(f.store);
  }
});

test("expired lease and competing pollers cannot commit a late HTTP page", async t => {
  const f = fixture(t); const before = checkpoints(f.store);
  const source = f.create(reader(request => { if (pathOf(request) === "/repos/acme/widget/issues") { f.tick(60_000); return { status: 200, body: [gh.issue] }; } return undefined; }));
  assert.notEqual((await source.poll()).status, "completed"); assert.deepEqual(rows(f.store), []); assert.deepEqual(checkpoints(f.store), before);
});
