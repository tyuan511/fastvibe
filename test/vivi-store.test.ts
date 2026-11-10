import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, symlinkSync, existsSync, realpathSync, copyFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { openShadowStore, type ShadowStore, type EffectRecord } from "../src/main/bot/shadow/store.ts";
import { SHADOW_MIGRATIONS, SHADOW_SCHEMA_VERSION } from "../src/main/bot/shadow/schema.ts";
import { openDatabaseConnection } from "../src/main/engine/db.ts";
import { MIGRATIONS } from "../src/main/engine/db-schema.ts";
import { LEGACY_TABLES, planLegacyMigration, readLegacySnapshot, type LegacySnapshot } from "../src/main/bot/shadow/legacy.ts";
import { threadKey, type Thread, type Trigger, type Decision, type Ticket, type Evaluation } from "../src/main/bot/core/model.ts";
import type { OutboundMessage } from "../src/main/bot/core/ports.ts";

const at = "2026-01-01T00:00:00.000Z";
function temporary(t: TestContext): string {
  const dir = mkdtempSync(join(tmpdir(), "vivi-store-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}
function memory(t: TestContext): ShadowStore {
  const store = openShadowStore();
  t.after(() => store.close());
  return store;
}
function thread(id = "thread"): Thread {
  const ref = { source: "fixture", id };
  return { key: threadKey(ref), ref, createdAt: at, subscriptions: [], correlated: [], pending: [], meta: {} };
}
function trigger(id = "trigger", ids = ["thread"]): Trigger {
  return { id, source: "fixture", threads: ids.map(id => ({ source: "fixture", id })), actor: { source: "fixture", id: "human" }, human: true, at, text: id, meta: {} };
}
function evaluation(owner: Thread, id: string): Evaluation {
  return { id, threadKey: owner.key, triggerIds: [], strength: "explicit", actor: { source: "fixture", id: "human" }, basis: { via: "addressed", addressed: "direct" }, policyVersion: "v1", startedAt: at, deadline: "2026-01-01T01:00:00.000Z" };
}
function decision(id = "decision", triggerIds: string[] = [], kind: Decision["kind"] = "accept"): Decision {
  return { id, evalId: `eval-${id}`, threadKey: thread().key, triggerIds, policyVersion: "v1", at, kind, reason: [], strength: "explicit" };
}
function ticket(id = "ticket"): Ticket {
  return { id, title: id, decisionId: `decision-${id}`, mandate: { strength: "explicit", policyVersion: "v1", basis: { via: "addressed", addressed: "direct" }, actor: { source: "fixture", id: "human" }, scope: "fixture" }, channels: [], assignments: [], inputs: [], undelivered: [], createdAt: at, updatedAt: at, origin: { triggerId: "origin", triggerIds: ["origin"] } };
}
function seedTicket(store: ShadowStore, value: Ticket): void {
  store.threads.save(thread());
  store.decisions.save(decision(value.decisionId));
  store.tickets.save(value);
}
function message(id = "message", text = "original"): OutboundMessage {
  return { id, kind: "reply", channel: { source: "fixture", thread: "thread", address: { room: "room" } }, text, ticketId: "ticket" };
}
function plan(index: number) { return { id: `operation-${index}`, source: "fixture", instance: "a", key: `key-${index}`, payload: { text: "write" } }; }
function usesIndex(store: ShadowStore, sql: string, name: string): void {
  const details = store.db.all(`EXPLAIN QUERY PLAN ${sql}`).map(row => String(row.detail)).join("\n");
  assert.match(details, new RegExp(`\\b${name}\\b`));
}

for (const mode of ["memory", "file"] as const) {
  test(`${mode}: schema, repository round trip and independent connections`, t => {
    const file = mode === "memory" ? ":memory:" : join(temporary(t), "shadow.db");
    const first = openShadowStore(file);
    const second = openShadowStore(file);
    try {
      assert.notEqual(first.db, second.db);
      assert.equal(first.db.userVersion(), 15);
      first.triggers.save(trigger());
      first.triggers.saveDisposition("trigger", { at, fanout: [], evalId: "eval" });
      first.threads.save({ ...thread(), pending: ["trigger"] });
      first.set("record", { nested: [1, "two"] });
      assert.deepEqual(first.triggers.get("trigger"), trigger());
      assert.deepEqual(first.triggers.disposition("trigger"), { at, fanout: [], evalId: "eval" });
      assert.equal(second.get("record") !== undefined, mode === "file");
      if (mode === "file") {
        assert.deepEqual(second.threads.active().map(x => x.key), [thread().key]);
        second.set("other-writer", 2);
        assert.equal(first.get("other-writer"), 2);
      }
      const detached = first.triggers.get("trigger")!;
      detached.text = "mutated in memory";
      assert.equal(first.triggers.get("trigger")!.text, "trigger");
      assert.equal(first.triggers.get("missing"), undefined);
    } finally { first.close(); second.close(); }
    assert.equal(first.db.closed, true);
    assert.throws(() => first.get("record"));
    first.close();
    const reopened = openShadowStore(file);
    try {
      assert.deepEqual(reopened.get("record"), mode === "file" ? { nested: [1, "two"] } : undefined);
      assert.equal(reopened.triggers.get("trigger")?.text, mode === "file" ? "trigger" : undefined);
    } finally { reopened.close(); }
  });
}

test("SQL projections track thread pending/evaluating and ticket open/active with their indexes", t => {
  const s = memory(t);
  s.threads.save(thread("idle"));
  s.threads.save({ ...thread("pending"), pending: ["a"] });
  const evaluating = thread("evaluating");
  s.threads.save({ ...evaluating, evaluating: evaluation(evaluating, "eval-active") });
  s.threads.save({ ...thread("subscribed"), subscriptions: ["ticket"] });
  assert.deepEqual(s.threads.active().map(x => x.ref.id), ["pending", "evaluating"]);
  usesIndex(s, "SELECT data FROM vivi_threads WHERE active=1 ORDER BY rowid", "vivi_thread_active");
  usesIndex(s, "SELECT data FROM vivi_threads WHERE source='fixture' AND subscribed=1", "vivi_thread_subscribed");
  const values = [ticket("idle"), ticket("pending"), ticket("running"), ticket("ended"), ticket("undelivered")];
  values[1]!.assignments = [{ id: "pending-a", state: "pending", createdAt: at }];
  values[2]!.assignments = [{ id: "running-a", state: "running", createdAt: at }];
  values[3]!.assignments = [{ id: "ended-a", state: "ended", createdAt: at }];
  values[3]!.ended = { at, by: "executor", outcome: "completed" };
  values[4]!.undelivered = ["input"];
  for (const value of values) seedTicket(s, value);
  assert.deepEqual(s.tickets.open().map(x => x.id), ["undelivered", "running", "pending", "idle"]);
  assert.deepEqual(s.tickets.active().map(x => x.id), ["undelivered", "running", "pending"]);
  usesIndex(s, "SELECT data FROM vivi_tickets WHERE open=1 ORDER BY rowid DESC", "vivi_ticket_open");
  usesIndex(s, "SELECT data FROM vivi_tickets WHERE active=1 ORDER BY rowid DESC", "vivi_ticket_active");
  usesIndex(s, "SELECT id FROM vivi_assignments WHERE state='running'", "vivi_assignment_state");
  assert.deepEqual(s.db.all("SELECT id,ticket_id,state FROM vivi_assignments ORDER BY id").map(row => ({ ...row })), [
    { id: "ended-a", ticket_id: "ended", state: "ended" }, { id: "pending-a", ticket_id: "pending", state: "pending" }, { id: "running-a", ticket_id: "running", state: "running" },
  ]);
  s.threads.save(thread("pending"));
  s.threads.save(evaluating);
  s.tickets.save({ ...values[1]!, assignments: [{ id: "pending-a", state: "ended", createdAt: at }] });
  assert.equal(s.threads.active().length, 0);
  assert.deepEqual(s.tickets.active().map(x => x.id), ["undelivered", "running"]);
});

test("trigger association replacement removes stale threads, deduplicates references, preserves chronological order", t => {
  const s = memory(t);
  s.triggers.save(trigger("b", ["old", "shared"]));
  s.triggers.save({ ...trigger("a", ["shared"]), at: "2025-12-31T00:00:00.000Z" });
  assert.deepEqual(s.triggers.byThread("fixture:shared").map(x => x.id), ["a", "b"]);
  s.triggers.save({ ...trigger("b", ["new", "new"]), human: false });
  assert.deepEqual(s.triggers.byThread("fixture:old"), []);
  assert.deepEqual(s.triggers.byThread("fixture:shared").map(x => x.id), ["a"]);
  assert.deepEqual(s.triggers.byThread("fixture:new").map(x => x.id), ["b"]);
  assert.equal(s.db.get("SELECT human FROM vivi_trigger_threads WHERE trigger_id='b'")?.human, 0);
});

test("accept consumes every trigger in a batch exactly once and conflicts roll back the whole decision", t => {
  const s = memory(t);
  s.threads.save(thread());
  for (const id of ["a", "b", "c"]) s.triggers.save(trigger(id));
  const accepted = decision("first", ["a", "b", "a"]);
  s.decisions.save(accepted);
  s.decisions.save(accepted);
  assert.equal(s.db.countRows("vivi_accepted_triggers"), 2);
  assert.throws(() => s.decisions.save(decision("conflict", ["c", "b"])), /Trigger|UNIQUE/);
  assert.equal(s.decisions.get("conflict"), undefined);
  assert.equal(s.db.get("SELECT decision_id FROM vivi_accepted_triggers WHERE trigger_id='c'"), undefined);
  s.decisions.save(decision("third", ["c"]));
  assert.deepEqual(s.decisions.byThread(thread().key).map(x => x.id), ["first", "third"]);
  assert.throws(() => s.decisions.save(decision("missing", ["unknown"])), /FOREIGN KEY/);
  assert.equal(s.decisions.get("missing"), undefined);
});

test("evaluation identities are unique across threads and decision identities", t => {
  const s = memory(t);
  const a = thread("a"), b = thread("b");
  s.threads.save({ ...a, evaluating: evaluation(a, "same") });
  s.threads.save(b);
  assert.throws(() => s.threads.save({ ...b, evaluating: evaluation(b, "same") }), /UNIQUE/);
  assert.equal(s.threads.get(b.key)?.evaluating, undefined);
  assert.throws(() => s.threads.save({ ...b, evaluating: evaluation(a, "other") }), /归属/);
  s.threads.save(thread());
  s.decisions.save(decision("first"));
  assert.throws(() => s.decisions.save({ ...decision("second"), evalId: "eval-first" }), /UNIQUE/);
  assert.equal(s.decisions.get("second"), undefined);
});

test("assignment primary key, one live assignment per ticket and one ticket per decision are SQL enforced; failed aggregate saves roll back", t => {
  const s = memory(t);
  const a = { ...ticket("a"), assignments: [{ id: "shared", state: "running" as const, createdAt: at }] };
  const b = ticket("b");
  seedTicket(s, a); seedTicket(s, b);
  assert.throws(() => s.tickets.save({ ...b, title: "must roll back", assignments: a.assignments }), /UNIQUE/);
  assert.deepEqual(s.tickets.get("b"), b);
  assert.throws(() => s.tickets.save({ ...a, title: "must roll back", assignments: [...a.assignments, { id: "second-live", state: "pending", createdAt: at }] }), /UNIQUE/);
  assert.deepEqual(s.tickets.get("a"), a);
  assert.deepEqual(s.db.all("SELECT id FROM vivi_assignments").map(row => row.id), ["shared"]);
  assert.throws(() => s.tickets.save({ ...ticket("duplicate-decision"), decisionId: a.decisionId }), /UNIQUE/);
  assert.equal(s.tickets.get("duplicate-decision"), undefined);
  const ended = { ...a, assignments: [{ id: "shared", state: "ended" as const, createdAt: at }, { id: "replacement", state: "running" as const, createdAt: at }] };
  s.tickets.save(ended);
  assert.deepEqual(s.tickets.get("a"), ended);
  assert.equal(s.db.countRows("vivi_assignments"), 2);
});

test("nested savepoints discard failed inner writes/callbacks, merge successes and notify only after outer commit", t => {
  const file = join(temporary(t), "transactions.db");
  const s = openShadowStore(file), observer = openShadowStore(file);
  t.after(() => { s.close(); observer.close(); });
  const calls: string[] = [];
  const value = s.atomic(() => {
    s.set("outer", 1);
    s.afterCommit(() => { assert.equal(observer.get("outer"), 1); calls.push("outer"); });
    assert.equal(observer.get("outer"), undefined);
    assert.throws(() => s.atomic(() => {
      s.set("inner-failed", 2);
      s.afterCommit(() => calls.push("discarded"));
      throw new Error("inner-failure");
    }), /inner-failure/);
    assert.equal(s.get("inner-failed"), undefined);
    s.atomic(() => {
      s.set("inner-ok", 3);
      s.afterCommit(() => { assert.equal(observer.get("inner-ok"), 3); calls.push("inner"); });
      s.atomic(() => s.afterCommit(() => calls.push("deep")));
    });
    assert.deepEqual(calls, []);
    return 17;
  });
  assert.equal(value, 17);
  assert.deepEqual(calls, ["outer", "inner", "deep"]);
  assert.throws(() => s.atomic(() => {
    s.atomic(() => { s.set("rolled-back", true); s.afterCommit(() => calls.push("outer-discarded")); });
    throw new Error("outer-failure");
  }), /outer-failure/);
  assert.equal(observer.get("rolled-back"), undefined);
  assert.deepEqual(calls, ["outer", "inner", "deep"]);
  s.afterCommit(() => calls.push("immediate"));
  assert.equal(calls.at(-1), "immediate");
});

test("callback errors are reported after commit and cannot undo writes or skip later wakeups", () => {
  const errors: unknown[] = [];
  const s = openShadowStore(":memory:", error => { errors.push(error); throw new Error("report failed"); });
  try {
    let later = false;
    s.atomic(() => {
      s.set("committed", true);
      s.afterCommit(() => { throw new Error("wake failed"); });
      s.afterCommit(() => { later = true; });
    });
    assert.equal(s.get("committed"), true);
    assert.equal(later, true);
    assert.equal(errors.length, 1);
    assert.match(String(errors[0]), /wake failed/);
  } finally { s.close(); }
});

test("async/thenable transaction callbacks explicitly fail and roll back outer and nested writes", t => {
  const s = memory(t);
  assert.throws(() => s.atomic(async () => { s.set("async", true); }), /同步/);
  assert.equal(s.get("async"), undefined);
  assert.throws(() => s.atomic(() => { s.set("thenable", true); return { then() {} }; }), /同步/);
  assert.equal(s.get("thenable"), undefined);
  s.atomic(() => {
    assert.throws(() => s.atomic(async () => { s.set("nested-async", true); }), /同步/);
    s.set("valid", 1);
  });
  assert.equal(s.get("nested-async"), undefined);
  assert.equal(s.get("valid"), 1);
});

test("effect kind/key uniqueness, ordered due projection and generation fencing", t => {
  const s = memory(t);
  const initial = s.effects.enqueue("delivery", "same", { n: 1 }, 100);
  const other = s.effects.enqueue("reply", "same", { n: 2 }, 100);
  s.effects.enqueue("delivery", "later", null, 200);
  assert.equal(initial.generation, 0);
  assert.ok(other.seq > initial.seq);
  assert.deepEqual(s.effects.due("delivery", 100).map(x => x.key), ["same"]);
  const claimed = s.effects.claim("delivery", "same", "a", 100, 20)!;
  assert.ok(claimed);
  const replaced = s.effects.enqueue("delivery", "same", { n: 3 }, 101);
  assert.equal(replaced.generation, 1);
  assert.equal(replaced.seq, initial.seq);
  assert.equal(replaced.status, "running");
  assert.equal(replaced.attempts, claimed.attempts);
  assert.equal(replaced.leaseOwner, claimed.leaseOwner);
  assert.equal(replaced.leaseUntil, claimed.leaseUntil);
  assert.equal(replaced.claimedGeneration, claimed.generation);
  assert.equal(replaced.claimToken, claimed.claimToken);
  assert.equal(s.effects.claim("delivery", "same", "b", 102, 20), undefined);
  assert.equal(s.effects.settle(claimed, "done", 102), false);
  const pending = s.effects.get("delivery", "same")!;
  assert.equal(pending.status, "pending");
  assert.equal(pending.generation, 1);
  assert.equal(pending.leaseOwner, undefined);
  assert.equal(pending.claimedGeneration, undefined);
  assert.equal(s.effects.settle(claimed, "done", 103), false);
  assert.equal(s.db.countRows("vivi_effects"), 3);
  assert.deepEqual(s.effects.get("delivery", "same")?.payload, { n: 3 });
  assert.equal(s.effects.claim("delivery", "later", "a", 199, 10), undefined);
  usesIndex(s, "SELECT * FROM vivi_effects WHERE kind='delivery' AND status='pending' AND due<=200 ORDER BY seq", "vivi_effect_due");
});

test("independent effect claim contention and same-generation claim tokens reject old, duplicate and expired settlements", t => {
  const file = join(temporary(t), "effects.db");
  const a = openShadowStore(file), b = openShadowStore(file);
  t.after(() => { a.close(); b.close(); });
  a.effects.enqueue("launch", "worker", {}, 0);
  const first = a.effects.claim("launch", "worker", "owner", 0, 10)!;
  assert.ok(first);
  assert.equal(b.effects.claim("launch", "worker", "other", 1, 10), undefined);
  assert.equal(b.effects.settle({ ...first, leaseOwner: "other" }, "done", 1), false);
  assert.equal(a.effects.settle(first, "pending", 2, 3, "retry"), true);
  assert.equal(a.effects.settle(first, "done", 2), false);
  assert.equal(b.effects.claim("launch", "worker", "owner", 2, 10), undefined);
  const second = b.effects.claim("launch", "worker", "owner", 3, 10)!;
  assert.equal(second.generation, first.generation);
  assert.ok(second.claimToken > first.claimToken);
  assert.equal(second.attempts, 2);
  assert.equal(a.effects.settle(first, "done", 4), false);
  assert.equal(a.effects.settle(second, "done", 13), false);
  assert.equal(a.effects.expire(12), 0);
  assert.equal(a.effects.expire(13), 1);
  assert.equal(b.effects.get("launch", "worker")?.status, "uncertain");
  assert.equal(b.effects.claim("launch", "worker", "third", 14, 10), undefined);
  assert.equal(a.effects.settle(second, "done", 14), false);
  assert.equal(a.effects.expire(14), 0);
  const queued = a.effects.enqueue("launch", "worker", {}, 15);
  assert.equal(queued.status, "uncertain");
  assert.equal(a.effects.claim("launch", "worker", "third", 15, 10), undefined);
  assert.equal(b.effects.reconcile(second, "retry", 15), false);
  assert.equal(b.effects.reconcile(queued, "retry", 15), true);
  assert.equal(a.effects.reconcile(queued, "retry", 15), false);
  const third = a.effects.claim("launch", "worker", "third", 15, 10)!;
  assert.equal(a.effects.settle(third, "done", 16), true);
  assert.equal(b.effects.settle(third, "done", 16), false);
});

test("cross-connection enqueue preserves the running lease and an old completion releases only that attempt", t => {
  const file = join(temporary(t), "running-generation.db");
  const a = openShadowStore(file), b = openShadowStore(file);
  t.after(() => { a.close(); b.close(); });
  a.effects.enqueue("reply", "key", { version: 0 }, 0);
  const old = a.effects.claim("reply", "key", "owner-a", 0, 20)!;
  assert.ok(old);
  const queued = b.effects.enqueue("reply", "key", { version: 1 }, 1);
  assert.equal(queued.status, "running");
  assert.equal(queued.generation, old.generation + 1);
  assert.equal(queued.claimedGeneration, old.generation);
  assert.equal(queued.claimToken, old.claimToken);
  assert.equal(queued.leaseOwner, "owner-a");
  assert.equal(queued.leaseUntil, 20);
  assert.deepEqual(a.effects.get("reply", "key"), queued);
  assert.equal(b.db.get("SELECT claimed_generation FROM vivi_effects WHERE key='key'")?.claimed_generation, old.generation);
  assert.deepEqual(b.effects.due("reply", 2), []);
  assert.equal(b.effects.claim("reply", "key", "owner-b", 2, 20), undefined);
  assert.equal(b.effects.reconcile(queued, "done", 2), false);
  assert.equal(a.effects.settle({ ...old, claimToken: old.claimToken + 1 }, "done", 2), false);
  assert.deepEqual(b.effects.get("reply", "key"), queued);
  assert.equal(a.effects.settle(old, "done", 3), false);
  const pending = b.effects.get("reply", "key")!;
  assert.equal(pending.status, "pending");
  assert.equal(pending.generation, queued.generation);
  assert.deepEqual(pending.payload, { version: 1 });
  assert.equal(pending.leaseOwner, undefined);
  assert.equal(pending.claimedGeneration, undefined);
  const next = b.effects.claim("reply", "key", "owner-b", 3, 20)!;
  assert.ok(next);
  assert.equal(next.claimedGeneration, queued.generation);
  assert.ok(next.claimToken > old.claimToken);
  assert.equal(a.effects.settle(old, "done", 4), false);
  assert.deepEqual(a.effects.get("reply", "key"), next);
  assert.equal(b.effects.settle(next, "done", 4), true);
});

for (const outcome of ["retry", "done", "cancelled"] as const) {
  test(`uncertain reconciliation ${outcome} uses generation/token CAS and preserves queued generations`, t => {
    const file = join(temporary(t), "reconcile.db");
    let s = openShadowStore(file);
    try {
      s.effects.enqueue("reply", "key", "original", 0);
      const claim = s.effects.claim("reply", "key", "owner", 0, 10)!;
      assert.ok(claim);
      assert.equal(s.effects.expire(10), 1);
      const uncertain = s.effects.get("reply", "key")!;
      const queued = s.effects.enqueue("reply", "key", "new payload", 11);
      assert.equal(queued.status, "uncertain");
      assert.equal(queued.claimedGeneration, claim.generation);
      assert.equal(queued.leaseOwner, undefined);
      s.close(); s = openShadowStore(file);
      assert.deepEqual(s.effects.get("reply", "key"), queued);
      assert.equal(s.effects.claim("reply", "key", "other", 12, 10), undefined);
      assert.deepEqual(s.effects.due("reply", 12), []);
      assert.equal(s.effects.settle(claim, "done", 12), false);
      assert.equal(s.effects.reconcile(uncertain, outcome, 12), false);
      assert.equal(s.effects.reconcile({ ...queued, claimToken: queued.claimToken + 1 }, outcome, 12), false);
      assert.deepEqual(s.effects.get("reply", "key"), queued);
      assert.equal(s.effects.reconcile(queued, outcome, 12), true);
      assert.equal(s.effects.reconcile(queued, outcome, 12), false);
      const reconciled = s.effects.get("reply", "key")!;
      assert.equal(reconciled.status, "pending", "reconciling the old attempt must retain every newer payload");
      assert.equal(reconciled.generation, queued.generation);
      assert.deepEqual(reconciled.payload, "new payload");
      assert.equal(reconciled.claimedGeneration, undefined);
      const next = s.effects.claim("reply", "key", "other", 12, 10)!;
      assert.ok(next);
      assert.equal(s.effects.expire(22), 1);
      const sameGeneration = s.effects.get("reply", "key")!;
      assert.equal(s.effects.reconcile(queued, "done", 23), false);
      const terminal = outcome === "cancelled" ? "cancelled" : "done";
      assert.equal(s.effects.reconcile(sameGeneration, terminal, 23), true);
      assert.equal(s.effects.get("reply", "key")?.status, terminal);
    } finally { s.close(); }
  });
}

test("leases fence owner and generation, preserve fencing after release, and renew only before expiry", t => {
  const file = join(temporary(t), "leases.db");
  const a = openShadowStore(file), b = openShadowStore(file);
  t.after(() => { a.close(); b.close(); });
  const first = a.leases.acquire("worker", "owner", 10, 10)!;
  assert.equal(first.generation, 1);
  assert.equal(b.leases.acquire("worker", "other", 11, 10), undefined);
  assert.equal(a.leases.renew({ ...first, owner: "other" }, 11, 20), false);
  assert.equal(a.leases.renew(first, 15, 10), true);
  assert.equal(b.leases.get("worker")?.expiresAt, 25);
  assert.equal(b.leases.acquire("worker", "other", 24, 10), undefined);
  const second = b.leases.acquire("worker", "owner", 25, 10)!;
  assert.equal(second.generation, 2);
  assert.equal(a.leases.renew(first, 26, 10), false);
  assert.equal(a.leases.release(first, 26), false);
  assert.equal(b.leases.release(second, 26), true);
  const third = a.leases.acquire("worker", "other", 26, 10)!;
  assert.equal(third.generation, 3);
  assert.equal(b.leases.renew(second, 27, 10), false);
  assert.equal(a.leases.renew(third, 36, 10), false);
  assert.equal(a.leases.release(third, 36), false);
  for (const ttl of [0, -1, 0.5, Infinity]) assert.throws(() => a.leases.acquire("invalid", "owner", 0, ttl), /有效期|整数/);
  assert.throws(() => a.effects.claim("launch", "missing", "owner", Number.MAX_SAFE_INTEGER, 1), /整数/);
});

test("cursor CAS isolates source and instance and rejects stale writes from another connection", t => {
  const file = join(temporary(t), "cursors.db");
  const a = openShadowStore(file), b = openShadowStore(file);
  t.after(() => { a.close(); b.close(); });
  assert.equal(a.cursors.save("source", "one", "cursor", { offset: 1 }), true);
  assert.equal(b.cursors.save("source", "one", "cursor", { offset: 0 }), false);
  assert.equal(b.cursors.save("source", "one", "cursor", { offset: 2 }, 1), true);
  assert.equal(a.cursors.save("source", "one", "cursor", { offset: 9 }, 1), false);
  assert.equal(a.cursors.save("source", "two", "cursor", { offset: 10 }), true);
  assert.equal(a.cursors.save("other", "one", "cursor", { offset: 20 }), true);
  assert.deepEqual(a.cursors.get("source", "one", "cursor"), { revision: 2, value: { offset: 2 } });
  assert.deepEqual(b.cursors.get("source", "two", "cursor"), { revision: 1, value: { offset: 10 } });
  assert.deepEqual(b.cursors.get("other", "one", "cursor"), { revision: 1, value: { offset: 20 } });
});

test("cursor CAS must not create a missing cursor when a nonzero revision was expected", t => {
  const s = memory(t);
  assert.equal(s.cursors.save("source", "one", "missing", "stale", 9), false);
  assert.equal(s.cursors.get("source", "one", "missing"), undefined);
});

test("operation plan identity/intent uniqueness and uncertain reconciliation survive close and restart", t => {
  const file = join(temporary(t), "operations.db");
  let s = openShadowStore(file);
  try {
    const planned = s.operations.plan(plan(1));
    assert.equal(planned.status, "planned");
    assert.deepEqual(s.operations.plan(plan(1)), { ...plan(1), status: "planned", revision: 1 });
    assert.throws(() => s.operations.plan({ ...plan(1), payload: { text: "changed" } }), /意图/);
    assert.throws(() => s.operations.plan({ ...plan(1), id: "different" }), /意图/);
    assert.throws(() => s.operations.plan({ ...plan(1), key: "other" }), /UNIQUE/);
    s.operations.plan(plan(2));
    assert.equal(s.operations.transition(planned, "uncertain", { lookup: "remote-id" }), true);
    assert.equal(s.operations.transition(planned, "confirmed"), false);
    s.close(); s = openShadowStore(file);
    assert.equal(s.operations.get("fixture", "a", "key-2")?.status, "planned");
    const uncertain = s.operations.get("fixture", "a", "key-1")!;
    assert.equal(uncertain.status, "uncertain");
    assert.deepEqual(uncertain.receipt, { lookup: "remote-id" });
    assert.deepEqual(s.operations.plan(plan(1)), uncertain);
    assert.equal(uncertain.revision, 2);
    assert.throws(() => s.operations.transition(uncertain, "planned"), /不可/);
    assert.deepEqual(s.operations.get("fixture", "a", "key-1"), uncertain);
    assert.equal(s.operations.transition(uncertain, "confirmed"), true);
    const confirmed = s.operations.get("fixture", "a", "key-1")!;
    assert.equal(confirmed.revision, 3);
    assert.equal(s.operations.transition(uncertain, "confirmed"), false);
    assert.throws(() => s.operations.transition(confirmed, "planned"), /不可/);
    assert.deepEqual(s.operations.get("fixture", "a", "key-1")?.receipt, { lookup: "remote-id" });
    assert.equal(s.db.countRows("vivi_operations"), 2);
  } finally { s.close(); }
});

test("operation revisions reject cross-connection planned/failed/planned ABA and duplicate records", t => {
  const file = join(temporary(t), "operation-aba.db");
  const a = openShadowStore(file), b = openShadowStore(file);
  t.after(() => { a.close(); b.close(); });
  const original = a.operations.plan(plan(1));
  assert.equal(original.revision, 1);
  assert.equal(b.operations.transition(original, "failed", { error: "known failure" }), true);
  const failed = a.operations.get("fixture", "a", "key-1")!;
  assert.equal(failed.revision, 2);
  assert.equal(a.operations.transition(original, "confirmed"), false);
  assert.equal(a.operations.transition(failed, "planned"), true);
  const retried = b.operations.get("fixture", "a", "key-1")!;
  assert.equal(retried.status, original.status);
  assert.equal(retried.revision, 3);
  assert.equal(b.operations.transition(original, "confirmed", { incorrect: true }), false);
  assert.equal(b.operations.transition(failed, "cancelled"), false);
  assert.deepEqual(a.operations.get("fixture", "a", "key-1"), retried);
  assert.deepEqual(a.operations.plan(plan(1)), retried);
  assert.equal(b.operations.transition(retried, "confirmed", { remote: "id" }), true);
  const confirmed = a.operations.get("fixture", "a", "key-1")!;
  assert.equal(confirmed.revision, 4);
  assert.equal(a.db.get("SELECT revision FROM vivi_operations WHERE id=?", original.id)?.revision, 4);
  assert.equal(a.operations.transition(retried, "confirmed"), false);
  for (const status of ["planned", "uncertain", "confirmed", "failed", "cancelled"] as const) {
    assert.throws(() => a.operations.transition(confirmed, status), /不可/);
  }
  assert.deepEqual(b.operations.get("fixture", "a", "key-1"), confirmed);
});

for (const next of ["uncertain", "confirmed", "failed", "cancelled"] as const) {
  test(`operation planned -> ${next} and permitted follow-up transitions enforce revisions`, t => {
    const s = memory(t);
    const planned = s.operations.plan(plan(1));
    assert.equal(s.operations.transition(planned, next), true);
    let current = s.operations.get("fixture", "a", "key-1")!;
    assert.equal(current.revision, 2);
    assert.equal(s.operations.transition(planned, next), false);
    if (next === "uncertain") {
      assert.throws(() => s.operations.transition(current, "planned"), /不可/);
      assert.deepEqual(s.operations.plan(plan(1)), current);
      assert.equal(s.operations.transition(current, "failed"), true);
      current = s.operations.get("fixture", "a", "key-1")!;
      assert.equal(current.revision, 3);
    }
    if (current.status === "failed" || current.status === "uncertain") {
      assert.equal(s.operations.transition(current, "cancelled"), true);
      current = s.operations.get("fixture", "a", "key-1")!;
    }
    if (current.status === "confirmed" || current.status === "cancelled") {
      for (const status of ["planned", "uncertain", "confirmed", "failed", "cancelled"] as const) {
        assert.throws(() => s.operations.transition(current, status), /不可/);
      }
    }
  });
}

test("outbox first message survives duplicates and restart; sent/dropped receipts cannot revert", t => {
  const file = join(temporary(t), "outbox.db");
  let s = openShadowStore(file);
  try {
    assert.equal(s.receipts.add(message()), true);
    assert.equal(s.receipts.add(message("message", "overwrite")), false);
    assert.equal(s.receipts.add(message("drop", "drop this")), true);
    s.close(); s = openShadowStore(file);
    assert.deepEqual(s.receipts.get("message"), { ...message(), status: "pending" });
    assert.deepEqual(s.receipts.waiting().map(x => x.id), ["message", "drop"]);
    assert.equal(s.receipts.settle("message", "sent"), true);
    assert.equal(s.receipts.settle("message", "dropped", { at, reason: "channelGone" }), false);
    assert.throws(() => s.receipts.settle("drop", "dropped"), /原因/);
    assert.equal(s.receipts.get("drop")?.status, "pending");
    assert.equal(s.receipts.settle("drop", "dropped", { at, reason: "channelIgnored" }), true);
    assert.equal(s.receipts.settle("drop", "sent"), false);
    assert.equal(s.receipts.add(message("message", "resurrect")), false);
    s.close(); s = openShadowStore(file);
    assert.equal(s.receipts.get("message")?.text, "original");
    assert.equal(s.receipts.get("message")?.status, "sent");
    assert.deepEqual(s.receipts.get("drop")?.dropped, { at, reason: "channelIgnored" });
    assert.deepEqual(s.receipts.waiting(), []);
  } finally { s.close(); }
});

test("session receipt progress is monotonic, preserves fields and isolates request/session identities across restart", t => {
  const file = join(temporary(t), "receipts.db");
  let s = openShadowStore(file);
  try {
    const identity = { sessionKey: "session", requestId: "request" };
    s.sessionReceipts.save({ ...identity, stage: "accepted", entryId: "entry" });
    for (const stage of ["persisted", "read", "reported"] as const) s.sessionReceipts.save({ ...identity, stage });
    assert.throws(() => s.sessionReceipts.save({ ...identity, stage: "read", entryId: "overwrite" }), /倒退/);
    s.sessionReceipts.save({ sessionKey: "other", requestId: "request", stage: "accepted" });
    s.sessionReceipts.save({ sessionKey: "session", requestId: "other", stage: "accepted" });
    s.close(); s = openShadowStore(file);
    assert.deepEqual(s.sessionReceipts.get("session", "request"), { ...identity, stage: "reported", entryId: "entry" });
    assert.equal(s.sessionReceipts.get("other", "request")?.stage, "accepted");
    assert.equal(s.sessionReceipts.get("session", "other")?.stage, "accepted");
  } finally { s.close(); }
});

for (const phase of ["before", "after"] as const) {
  test(`real child process exit ${phase} commit: reopen recovers ${phase === "before" ? "rollback" : "durable intents without duplicate delivery"}`, t => {
    const file = join(temporary(t), "crash.db");
    const child = spawnSync(process.execPath, [fileURLToPath(new URL("./fixtures/vivi-crash.ts", import.meta.url)), file, phase], { encoding: "utf8", timeout: 15000 });
    assert.ifError(child.error);
    assert.equal(child.signal, null);
    assert.equal(child.status, phase === "before" ? 41 : 42, child.stderr);
    assert.match(child.stdout, phase === "before" ? /before-commit/ : /after-commit/);
    const s = openShadowStore(file);
    try {
      assert.deepEqual(s.get("crash-intent"), phase === "before" ? undefined : { phase });
      assert.equal(s.db.countRows("vivi_effects"), phase === "before" ? 0 : 1);
      assert.equal(s.receipts.waiting().length, phase === "before" ? 0 : 1);
      if (phase === "after") {
        assert.equal(s.receipts.add({ ...message("crash-message"), text: "duplicate" }), false);
        assert.equal(s.receipts.get("crash-message")?.text, "first message");
        assert.equal(s.receipts.settle("crash-message", "sent"), true);
        assert.equal(s.receipts.settle("crash-message", "sent"), false);
        const claim = s.effects.claim("reply", "crash-reply", "recovery", 2, 10)!;
        assert.ok(claim);
        assert.equal(s.effects.settle(claim, "done", 3), true);
        assert.equal(s.effects.claim("reply", "crash-reply", "duplicate", 4, 10), undefined);
      }
    } finally { s.close(); }
    const again = openShadowStore(file);
    try {
      assert.deepEqual(again.receipts.waiting(), []);
      assert.equal(again.effects.get("reply", "crash-reply")?.status, phase === "before" ? undefined : "done");
    } finally { again.close(); }
  });
}

test("real child exit with a superseded running effect preserves ownership and requires reconciliation after expiry", t => {
  const file = join(temporary(t), "running-crash.db");
  const child = spawnSync(process.execPath, [fileURLToPath(new URL("./fixtures/vivi-crash.ts", import.meta.url)), file, "running"], { encoding: "utf8", timeout: 15000 });
  assert.ifError(child.error);
  assert.equal(child.signal, null);
  assert.equal(child.status, 43, child.stderr);
  assert.match(child.stdout, /running-committed/);
  let s = openShadowStore(file);
  try {
    const old = s.get<EffectRecord>("crashed-claim")!;
    assert.ok(old);
    const running = s.effects.get("reply", "crash-running")!;
    assert.equal(running.status, "running");
    assert.equal(running.generation, 1);
    assert.equal(running.claimedGeneration, 0);
    assert.equal(running.leaseOwner, "crashed-owner");
    assert.equal(running.leaseUntil, 10);
    assert.equal(running.claimToken, old.claimToken);
    assert.deepEqual(running.payload, { version: 1 });
    assert.equal(s.effects.claim("reply", "crash-running", "recovery", 9, 10), undefined);
    assert.equal(s.effects.settle(old, "done", 10), false);
    assert.deepEqual(s.effects.get("reply", "crash-running"), running);
    assert.equal(s.effects.expire(10), 1);
    const queued = s.effects.enqueue("reply", "crash-running", { version: 2 }, 11);
    assert.equal(queued.status, "uncertain");
    assert.equal(queued.generation, 2);
    s.close(); s = openShadowStore(file);
    assert.deepEqual(s.effects.get("reply", "crash-running"), queued);
    assert.equal(s.effects.claim("reply", "crash-running", "recovery", 12, 10), undefined);
    assert.equal(s.effects.reconcile(running, "done", 12), false);
    assert.equal(s.effects.reconcile(queued, "done", 12), true);
    assert.equal(s.effects.get("reply", "crash-running")?.status, "pending");
    const next = s.effects.claim("reply", "crash-running", "recovery", 12, 10)!;
    assert.ok(next);
    assert.equal(s.effects.settle(old, "done", 13), false);
    assert.equal(s.effects.settle(next, "done", 13), true);
    const uncertain = s.operations.get("fixture", "crash", "write")!;
    assert.equal(uncertain.status, "uncertain");
    assert.equal(uncertain.revision, 2);
    assert.deepEqual(uncertain.receipt, { lookup: "remote-id" });
    assert.throws(() => s.operations.transition(uncertain, "planned"), /不可/);
    assert.equal(s.operations.transition(uncertain, "confirmed"), true);
    s.close(); s = openShadowStore(file);
    assert.equal(s.effects.get("reply", "crash-running")?.status, "done");
    assert.equal(s.effects.claim("reply", "crash-running", "duplicate", 14, 10), undefined);
    assert.equal(s.operations.get("fixture", "crash", "write")?.revision, 3);
    assert.equal(s.operations.transition(uncertain, "confirmed"), false);
  } finally { s.close(); }
});

test("shadow path rejects non-temp destinations and symlink escapes before creating anything", t => {
  const dir = temporary(t);
  const nonTemp = resolve(".vivi-must-not-create", "shadow.db");
  assert.equal(existsSync(nonTemp), false);
  assert.throws(() => openShadowStore(nonTemp), /临时目录/);
  assert.equal(existsSync(nonTemp), false);
  const danglingTarget = join(process.cwd(), ".vivi-must-not-create", "missing.db");
  symlinkSync(danglingTarget, join(dir, "dangling.db"));
  assert.throws(() => openShadowStore(join(dir, "dangling.db")), { code: "ENOENT" });
  assert.equal(existsSync(danglingTarget), false);
  const danglingDirectory = join(process.cwd(), ".vivi-must-not-create", "missing-dir");
  symlinkSync(danglingDirectory, join(dir, "dangling-dir"), "dir");
  assert.throws(() => openShadowStore(join(dir, "dangling-dir", "shadow.db")), { code: "ENOENT" });
  assert.equal(existsSync(danglingDirectory), false);
  assert.equal(existsSync(nonTemp), false);
  symlinkSync(realpathSync(process.cwd()), join(dir, "escape"), "dir");
  assert.throws(() => openShadowStore(join(dir, "escape", ".vivi-must-not-create", "shadow.db")), /临时目录/);
  const safe = openShadowStore(join(dir, "nested", "shadow.db"));
  safe.close();
});

test("schema 15 stays shadow-only; repeat opens preserve production table DDL and content", t => {
  assert.equal(MIGRATIONS.length, 14);
  assert.equal(SHADOW_SCHEMA_VERSION, 15);
  const file = join(temporary(t), "schema.db");
  const production = openDatabaseConnection(file);
  let before: unknown[];
  try {
    assert.equal(production.userVersion(), 14);
    production.run("INSERT INTO bot_meta VALUES (?,?)", "m2-sentinel", "unchanged");
    before = production.all("SELECT type,name,tbl_name,sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY type,name").map(row => ({ ...row }));
    assert.equal(production.get("SELECT name FROM sqlite_master WHERE name='vivi_shadow_meta'"), undefined);
  } finally { production.close(); }
  for (let i = 0; i < 3; i++) {
    const s = openShadowStore(file);
    try {
      assert.equal(s.db.userVersion(), 15);
      assert.equal(s.db.get("SELECT value FROM bot_meta WHERE key='m2-sentinel'")?.value, "unchanged");
      const after = s.db.all("SELECT type,name,tbl_name,sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' AND name NOT LIKE 'vivi_%' ORDER BY type,name").map(row => ({ ...row }));
      assert.deepEqual(after, before!);
      assert.equal(s.db.get("SELECT value FROM vivi_shadow_meta WHERE key='purpose'")?.value, "isolated-m2");
    } finally { s.close(); }
  }
});

test("future schema is rejected without changing its version or data", t => {
  const file = join(temporary(t), "future.db");
  const db = openDatabaseConnection(file);
  db.run("INSERT INTO bot_meta VALUES (?,?)", "future", "preserve");
  db.userVersion(99); db.close();
  assert.throws(() => openShadowStore(file), /schema 99/);
  const inspect = openDatabaseConnection(file, { migrations: Array.from({ length: 99 }, () => () => {}) });
  try {
    assert.equal(inspect.userVersion(), 99);
    assert.equal(inspect.get("SELECT value FROM bot_meta WHERE key='future'")?.value, "preserve");
    assert.equal(inspect.get("SELECT name FROM sqlite_master WHERE name='vivi_shadow_meta'"), undefined);
  } finally { inspect.close(); }
});

test("failure after shadow DDL rolls back all schema-15 writes and version; unmodified migration reruns successfully", t => {
  const file = join(temporary(t), "retry.db");
  const initial = openDatabaseConnection(file);
  initial.run("INSERT INTO bot_meta VALUES (?,?)", "sentinel", "keep");
  initial.close();
  const failing = [...SHADOW_MIGRATIONS.slice(0, 14), (db: Parameters<(typeof SHADOW_MIGRATIONS)[number]>[0]) => {
    SHADOW_MIGRATIONS[14]!(db);
    db.run("UPDATE bot_meta SET value='must rollback' WHERE key='sentinel'");
    throw new Error("injected-migration-failure");
  }];
  assert.throws(() => openDatabaseConnection(file, { migrations: failing }), /injected-migration-failure/);
  const inspect = openDatabaseConnection(file);
  try {
    assert.equal(inspect.userVersion(), 14);
    assert.equal(inspect.get("SELECT value FROM bot_meta WHERE key='sentinel'")?.value, "keep");
    assert.equal(inspect.all("SELECT name FROM sqlite_master WHERE name LIKE 'vivi_%'").length, 0);
  } finally { inspect.close(); }
  const retry = openShadowStore(file);
  try {
    assert.equal(retry.db.userVersion(), 15);
    assert.equal(retry.db.get("SELECT value FROM bot_meta WHERE key='sentinel'")?.value, "keep");
    retry.effects.enqueue("reply", "retry", {}, 0);
    assert.equal(retry.db.countRows("vivi_effects"), 1);
  } finally { retry.close(); }
});

function migrationPlan(snapshotId = "snapshot", duplicates = false) {
  const tables: LegacySnapshot["tables"] = { bot_meta: [
    { key: "a", value: "one" }, { key: "b", value: "two" }, { key: "c", value: "three" }, { key: "d", value: "four" },
  ] };
  if (duplicates) tables.bot_meta = [...tables.bot_meta!, { key: "b", value: "conflicting two" }];
  return planLegacyMigration({ snapshotId, schemaVersion: 14, tables, missingTables: LEGACY_TABLES.filter(name => name !== "bot_meta") });
}

test("empty migration is completed and idempotent across restart with its stable report", t => {
  const file = join(temporary(t), "empty-migration.db");
  const plan = planLegacyMigration({ snapshotId: "empty", schemaVersion: 14, tables: {}, missingTables: [...LEGACY_TABLES] });
  let s = openShadowStore(file);
  try {
    const initial = s.migrations.begin(plan);
    assert.equal(initial.total, 0);
    assert.equal(initial.nextRow, 0);
    assert.equal(initial.status, "completed");
    assert.deepEqual(initial.plan, plan);
    assert.match(initial.digest, /^[a-f0-9]{64}$/);
    assert.deepEqual(s.migrations.advance("empty"), initial);
    assert.deepEqual(s.migrations.begin(plan), initial);
    s.close(); s = openShadowStore(file);
    assert.deepEqual(s.migrations.get("empty"), initial);
    assert.deepEqual(s.migrations.begin(plan), initial);
    assert.deepEqual(s.migrations.records("empty"), []);
    assert.equal(s.db.countRows("vivi_migration_runs"), 1);
  } finally { s.close(); }
});

test("migration batches resume after restart without duplicate mappings and preserve every duplicate conflict record", t => {
  const file = join(temporary(t), "migration-resume.db");
  const plan = migrationPlan("resume", true);
  assert.equal(plan.records.length, 5);
  assert.equal(plan.mappings.length, 4);
  let s = openShadowStore(file);
  try {
    assert.equal(s.migrations.begin(plan).total, 4);
    assert.equal(s.migrations.advance("resume", 1).nextRow, 1);
    s.close(); s = openShadowStore(file);
    assert.deepEqual(s.migrations.get("resume")?.plan, plan);
    assert.equal(s.migrations.begin(plan).nextRow, 1);
    assert.equal(s.migrations.advance("resume", 2).nextRow, 3);
    s.close(); s = openShadowStore(file);
    const done = s.migrations.advance("resume", 10);
    assert.equal(done.nextRow, 4);
    assert.equal(done.status, "completed");
    assert.deepEqual(s.migrations.advance("resume", 1), done);
    assert.equal(s.db.countRows("vivi_legacy_mappings"), 4);
    const groups = s.migrations.records("resume");
    assert.equal(groups.length, 4);
    assert.equal(groups.flatMap(group => group.records).length, 5);
    for (const group of groups) {
      assert.deepEqual(group.mapping, plan.mappings.find(mapping => mapping.legacyKey === group.mapping.legacyKey));
      assert.deepEqual(group.records, plan.records.filter(record => record.legacyKey === group.mapping.legacyKey));
    }
    const conflict = groups.find(group => group.mapping.legacyKey === "b")!;
    assert.equal(conflict.records.length, 2);
    assert.ok(conflict.records.every(record => record.classification === "invalid" && record.authorized === false));
    assert.equal(s.db.get("SELECT classification FROM vivi_legacy_mappings WHERE legacy_id='b'")?.classification, "invalid");
    assert.equal(s.db.countRows("vivi_tickets"), 0);
    assert.equal(s.db.countRows("vivi_effects"), 0);
  } finally { s.close(); }
});

test("migration snapshot identity rejects content and classification drift without replacing saved evidence", t => {
  const s = memory(t);
  const plan = migrationPlan("stable");
  const initial = s.migrations.begin(plan);
  const content = structuredClone(plan);
  content.records[0]!.raw.value = "different content";
  assert.throws(() => s.migrations.begin(content), /变化|snapshotId/);
  const classification = structuredClone(plan);
  classification.records[0]!.classification = "blocked";
  assert.throws(() => s.migrations.begin(classification), /变化|snapshotId/);
  assert.deepEqual(s.migrations.get("stable"), initial);
  assert.deepEqual(s.migrations.records("stable"), []);
  assert.equal(s.migrations.advance("stable", 1).nextRow, 1);
  assert.throws(() => s.migrations.begin(content), /变化|snapshotId/);
  assert.deepEqual(s.migrations.get("stable")?.plan, plan);
});

test("SQLite ABORT midway through migration batch rolls back new mappings and checkpoint; retry resumes", t => {
  const file = join(temporary(t), "migration-rollback.db");
  let s = openShadowStore(file);
  const plan = migrationPlan("rollback");
  try {
    s.migrations.begin(plan);
    s.migrations.advance("rollback", 1);
    const before = s.migrations.get("rollback");
    const written = s.migrations.records("rollback");
    // Batch order is a,b,c,d: write b successfully, then fail c inside the same transaction.
    s.db.exec("CREATE TRIGGER m2_inject_abort BEFORE INSERT ON vivi_legacy_mappings WHEN NEW.legacy_id='c' BEGIN SELECT RAISE(ABORT,'injected batch failure'); END");
    assert.throws(() => s.migrations.advance("rollback", 3), /injected batch failure/);
    assert.deepEqual(s.migrations.get("rollback"), before);
    assert.deepEqual(s.migrations.records("rollback"), written);
    assert.equal(s.db.countRows("vivi_legacy_mappings"), 1);
    s.close(); s = openShadowStore(file);
    assert.deepEqual(s.migrations.get("rollback"), before);
    s.db.exec("DROP TRIGGER m2_inject_abort");
    const completed = s.migrations.advance("rollback", 3);
    assert.equal(completed.status, "completed");
    assert.equal(completed.nextRow, 4);
    assert.equal(s.migrations.records("rollback").length, 4);
  } finally { s.close(); }
});

test("two independent connections alternate migration batches against the persisted checkpoint", t => {
  const file = join(temporary(t), "migration-connections.db");
  const a = openShadowStore(file), b = openShadowStore(file);
  t.after(() => { a.close(); b.close(); });
  const plan = migrationPlan("connections");
  const initial = a.migrations.begin(plan);
  assert.deepEqual(b.migrations.begin(plan), initial);
  assert.equal(a.migrations.advance("connections", 1).nextRow, 1);
  assert.equal(b.migrations.advance("connections", 1).nextRow, 2);
  assert.equal(a.migrations.advance("connections", 1).nextRow, 3);
  const done = b.migrations.advance("connections", 1);
  assert.equal(done.status, "completed");
  assert.deepEqual(a.migrations.get("connections"), done);
  assert.deepEqual(a.migrations.advance("connections", 1), done);
  assert.equal(a.migrations.records("connections").length, 4);
  assert.equal(a.db.countRows("vivi_migration_runs"), 1);
  for (const batchSize of [0, -1, 0.5, Infinity]) assert.throws(() => a.migrations.advance("connections", batchSize), /正整数/);
  assert.throws(() => a.migrations.advance("missing"), /不存在/);
});

test("legacy fixture copied before shadow conversion keeps source schema 14 and all source rows unchanged", t => {
  const dir = temporary(t), sourceFile = join(dir, "source.db"), copyFile = join(dir, "copy.db");
  const source = openDatabaseConnection(sourceFile);
  let evidence: LegacySnapshot;
  try {
    source.run("INSERT INTO bot_meta VALUES (?,?)", "migration-sentinel", "source unchanged");
    source.run("INSERT INTO bot_conversations VALUES (?,?,?,?,?,?,?,?,?)", "worker", "worker", "vivi", "worker-key", 2, false, 1, 1, JSON.stringify({ conversationId: "worker", role: "worker", owner: "vivi", epoch: 2 }));
    source.run("INSERT INTO bot_v2_inputs VALUES (?,?,?,?,?,?,?,?)", "input", "worker", 2, "user", "do work", "accepted", 1, JSON.stringify({ id: "input", conversationId: "worker", epoch: 2, source: "user", status: "accepted" }));
    evidence = readLegacySnapshot(source);
    source.exec("PRAGMA wal_checkpoint(TRUNCATE)");
  } finally { source.close(); }
  const sourceBytes = readFileSync(sourceFile);
  copyFileSync(sourceFile, copyFile);
  const converted = openShadowStore(copyFile);
  try {
    const copyEvidence = readLegacySnapshot(converted.db);
    assert.deepEqual(copyEvidence.tables, evidence!.tables);
    const plan = planLegacyMigration({ ...copyEvidence, snapshotId: "copied-fixture" });
    converted.migrations.begin(plan);
    assert.equal(converted.migrations.advance(plan.snapshotId).status, "completed");
    assert.equal(converted.db.userVersion(), 15);
    assert.deepEqual(readLegacySnapshot(converted.db).tables, evidence!.tables);
    assert.equal(converted.migrations.records(plan.snapshotId).length, plan.mappings.length);
  } finally { converted.close(); }
  assert.deepEqual(readFileSync(sourceFile), sourceBytes);
  const unchanged = openDatabaseConnection(sourceFile);
  try {
    assert.equal(unchanged.userVersion(), 14);
    assert.deepEqual(readLegacySnapshot(unchanged), evidence!);
    assert.equal(unchanged.get("SELECT name FROM sqlite_master WHERE name='vivi_migration_runs'"), undefined);
  } finally { unchanged.close(); }
});
