import assert from "node:assert/strict";
import test from "node:test";
import { Engine, MemoryRepositories } from "../src/main/bot/core/index.ts";
import type { EngineOptions } from "../src/main/bot/core/index.ts";
import { githubReplay, replayResults } from "./fixtures/vivi-source-events.ts";

function harness(repo = new MemoryRepositories()) {
  const unexpected = () => { throw new Error("Source replay must not launch sessions, assess with a model, or write externally"); };
  const options: EngineOptions = {
    repo,
    now: () => "2026-11-04T11:00:00.000Z",
    scope: { scope: () => ({ listened: true, observed: true }) },
    policy: () => ({
      version: "fixture-v1", paused: true, evalTimeoutMs: 60_000,
      gate: () => ({ admissible: false, reason: "replay-only" }),
      revalidate: () => false, admitsInferred: () => false,
    }),
    assessor: { request: unexpected },
    executor: { start: unexpected, deliver: unexpected, stop: unexpected },
    outbox: { send: unexpected, withdraw: unexpected, status: () => undefined },
  };
  return { repo, engine: new Engine(options) };
}

test("replay fixtures retain edits, reject overlap duplicates, and preserve newest source time under reordering", () => {
  const h = harness();
  assert.deepEqual(githubReplay.map((event) => h.engine.receive(event)), [...replayResults]);
  const thread = h.repo.threads.get("github-fixture:repo-11/7")!;
  assert.deepEqual(thread.pending, ["issue-101:v1", "comment-201:v1", "comment-201:v2", "check-301:v1"]);
  assert.equal(thread.lastAt, "2026-11-04T10:03:00.000Z");
  assert.equal(h.repo.triggers.get("comment-201:v1")!.text, "Keep the current behavior.");
  assert.equal(h.repo.triggers.get("comment-201:v2")!.text, "Keep the current behavior and existing API.");
  h.engine.evaluateDue();
  assert.equal(h.repo.tickets.list().length, 0);
  assert.equal(h.repo.threads.get("github-fixture:repo-11/7")!.evaluating, undefined);
});

test("replaying from a cloned domain checkpoint retains trigger identity without a runtime or database", () => {
  const first = harness();
  for (const event of githubReplay.slice(0, 2)) first.engine.receive(event);
  const checkpoint = new MemoryRepositories();
  for (const event of githubReplay.slice(0, 2)) {
    checkpoint.triggers.save(first.repo.triggers.get(event.id)!);
    checkpoint.triggers.saveDisposition(event.id, first.repo.triggers.disposition(event.id)!);
  }
  for (const thread of first.repo.threads.list()) checkpoint.threads.save(thread);
  const restarted = harness(checkpoint);
  assert.deepEqual(githubReplay.map((event) => restarted.engine.receive(event)), ["duplicate", "duplicate", "duplicate", "stored", "duplicate", "stored"]);
  assert.equal(restarted.repo.threads.get("github-fixture:repo-11/7")!.pending.length, 4);
  assert.equal(first.repo.threads.get("github-fixture:repo-11/7")!.pending.length, 2);
});
