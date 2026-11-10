import assert from "node:assert/strict";
import test from "node:test";
import type { Trigger } from "../src/main/bot/core/model.ts";
import { ShadowEngine } from "../src/main/bot/shadow/engine.ts";
import { LocalSourceReplay, legacyBotInputToTrigger } from "../src/main/bot/shadow/local-source.ts";
import { ShadowSourceRegistry } from "../src/main/bot/shadow/source-registry.ts";
import { openShadowStore } from "../src/main/bot/shadow/store.ts";

function fixture(t: test.TestContext) {
  const store = openShadowStore(":memory:");
  let now = 1000;
  const registry = new ShadowSourceRegistry(store, () => now);
  const unregister = registry.register({ kind: "local", validate: value => ({ room: (value as { room?: string })?.room ?? "main" }), scope: () => ({ listened: true, observed: false }) });
  registry.configure("local", { enabled: true, config: { room: "main" } });
  const engine = new ShadowEngine(store, {
    now: () => now,
    scope: registry,
    policy: () => ({ version: "test", paused: true, evalTimeoutMs: 10_000, gate: () => ({ admissible: false, reason: "replay" }), revalidate: () => false, admitsInferred: () => false }),
  });
  t.after(() => { unregister(); store.close(); });
  return { store, registry, engine, setNow: (value: number) => { now = value; } };
}
function trigger(id: string, text = id, at = "2026-01-01T00:00:00.000Z"): Trigger {
  return { id, source: "local", threads: [{ source: "local", id: "chat" }], actor: { source: "local", id: "user" }, human: true, addressed: "direct", at, text, meta: {} };
}

 test("Local replay is explicit, preserves duplicate and edited Trigger versions", t => {
  const f = fixture(t);
  const replay = new LocalSourceReplay({ registry: f.registry, engine: f.engine, now: () => 1000 });
  assert.equal(replay.receive(trigger("same")), "stored");
  assert.equal(replay.receive(trigger("same")), "duplicate");
  assert.equal(replay.receive(trigger("same:v2", "edited")), "stored");
  assert.equal(f.store.triggers.get("same")?.text, "same");
  assert.equal(f.store.triggers.get("same:v2")?.text, "edited");
});

test("controlled pages advance cursor by CAS and retrying an overlapping page is idempotent", t => {
  const f = fixture(t);
  const replay = new LocalSourceReplay({ registry: f.registry, engine: f.engine });
  const first = replay.replay({ source: "local", instance: "desktop", events: [trigger("a")], nextCursor: "one", hasMore: true });
  assert.equal(first.cursor, "one");
  assert.equal(f.registry.cursor("local", "desktop").revision, 1);
  const second = replay.replay({ source: "local", instance: "desktop", cursor: "one", events: [trigger("a"), trigger("b")], nextCursor: "two", hasMore: false });
  assert.deepEqual(second.results, ["duplicate", "stored"]);
  assert.equal(f.registry.cursor("local", "desktop").cursor, "two");
  assert.throws(() => replay.replay({ source: "local", instance: "desktop", cursor: "one", events: [], nextCursor: "three", hasMore: false }), /cursor 值冲突/);
});

test("poll reports transient failure, records degraded health, and leaves cursor unchanged", async t => {
  const f = fixture(t);
  const replay = new LocalSourceReplay({ registry: f.registry, engine: f.engine, now: () => 1000 });
  const result = await replay.poll("local", async () => { throw new Error("temporary"); }, "desktop");
  assert.equal(result.status, "transient-failure");
  assert.equal(f.registry.cursor("local", "desktop").revision, 0);
  assert.equal(f.registry.health("local")?.state, "degraded");
});

test("poll lease fences a page that outlives its lease", async t => {
  const f = fixture(t);
  let now = 0;
  const replay = new LocalSourceReplay({ registry: f.registry, engine: f.engine, now: () => now, leaseMs: 10, owner: "test" });
  const result = await replay.poll("local", async () => { now = 20; return { source: "local", instance: "desktop", events: [trigger("late")], nextCursor: "one", hasMore: false }; }, "desktop");
  assert.equal(result.status, "rejected");
  assert.equal(f.store.triggers.get("late"), undefined);
  assert.equal(f.registry.cursor("local", "desktop").revision, 0);
});

test("unknown, disabled, revoked and unavailable Sources never receive", t => {
  const f = fixture(t);
  const replay = new LocalSourceReplay({ registry: f.registry, engine: f.engine });
  assert.throws(() => replay.receive(trigger("unknown"), "missing"), /不可接收/);
  const current = f.registry.instance("local")!;
  f.registry.setStatus("local", "revoked", current.revision);
  assert.throws(() => replay.receive(trigger("revoked")), /不可接收/);
  const revoked = f.registry.instance("local")!;
  f.registry.setStatus("local", "unavailable", revoked.revision);
  assert.throws(() => replay.receive(trigger("unavailable")), /不可接收/);
});

test("legacy compatibility projection is pure and does not use shared API", () => {
  const input = { requestId: "r1", conversationId: "chat", text: "hello", createdAt: "2026-01-01T00:00:00Z" };
  const first = legacyBotInputToTrigger(input);
  input.text = "changed";
  assert.equal(first.id, "legacy:r1");
  assert.equal(first.text, "hello");
  assert.deepEqual(first.threads, [{ source: "local-legacy", id: "chat" }]);
});
