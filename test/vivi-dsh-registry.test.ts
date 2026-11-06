import assert from "node:assert/strict";
import test from "node:test";
import { openShadowStore } from "../src/main/bot/shadow/store.ts";
import { ShadowSourceRegistry } from "../src/main/bot/shadow/source-registry.ts";
import { ShadowCredentialHost } from "../src/main/bot/shadow/credential-host.ts";
import { ShadowPolicyHost } from "../src/main/bot/shadow/policy-host.ts";
import { ShadowControl } from "../src/main/bot/shadow/control.ts";
import type { Settings } from "../src/main/bot/core/policy.ts";

const settings = (mode: Settings["eval"]["mode"] = "observe"): Settings => ({ paused: false,
  policy: { rules: [{ id: "copy", name: "Copy", enabled: true, instruction: "copy" }], sources: { probe: { allowed: [], admission: {} } } },
  eval: { mode, timeoutSeconds: 120 } });
function fixture(t: test.TestContext, testMode = true) {
  const store = openShadowStore(":memory:"); let now = 100;
  const registry = new ShadowSourceRegistry(store, () => now);
  const unregister = registry.register({ kind: "probe", validate: input => {
    const value = (input ?? {}) as Record<string, unknown>;
    if (typeof value.room !== "string") return {};
    return { ...value, room: value.room };
  }, scope: ({ meta }, config) => meta.room === config.room ? { listened: true, observed: meta.observe === true, row: String(meta.room) } : { listened: false, reason: "room_not_configured" } });
  const policy = new ShadowPolicyHost(store, settings()); const credentials = new ShadowCredentialHost(registry); const control = new ShadowControl(registry, policy, credentials, testMode);
  t.after(() => { unregister(); store.close(); }); return { store, registry, policy, credentials, control, advance: (n: number) => { now += n; } };
}

test("unknown and disabled Sources cannot listen, and registration is explicit", t => { const f = fixture(t); assert.deepEqual(f.registry.scope({ source: "missing", meta: {} }), { listened: false, reason: "source_not_installed" }); assert.deepEqual(f.registry.scope({ source: "probe", meta: { room: "r" } }), { listened: false, reason: "source_disabled" }); const current = f.registry.configure("probe", { enabled: true, config: { room: "r" } }); assert.deepEqual(f.registry.scope({ source: "probe", meta: { room: "r", observe: true } }), { listened: true, observed: true, row: "r" }); assert.throws(() => f.registry.register({ kind: "probe", validate: () => ({}) }), /already registered/); assert.equal(current.revision, 1); });

test("Source config is revisioned and secrets cannot enter Shadow", t => { const f = fixture(t); assert.throws(() => f.registry.configure("probe", { enabled: true, config: { room: "r", token: "secret" } }), /凭据字段/); const a = f.registry.configure("probe", { enabled: true, config: { room: "r", credentialRef: "github-agent" } }); assert.throws(() => f.registry.configure("probe", { enabled: false, config: {} }, 0), /revision/); const b = f.registry.configure("probe", { enabled: false, config: { room: "r" } }, a.revision); assert.equal(b.revision, 2); });

test("health and poll cursor survive a fresh registry and use CAS", t => { const f = fixture(t); f.registry.configure("probe", { enabled: true, config: { room: "r" } }); const health = f.registry.setHealth("probe", "healthy", "ok"); assert.equal(health.revision, 1); const cursor = f.registry.advanceCursor("probe", "instance-a", "cursor-1", 0); assert.equal(cursor.revision, 1); assert.throws(() => f.registry.advanceCursor("probe", "instance-a", "cursor-2", 0), /cursor revision/); const again = new ShadowSourceRegistry(f.store, () => 200); const stop = again.register({ kind: "probe", validate: () => ({}) }); assert.equal(again.health("probe")?.state, "healthy"); assert.equal(again.cursor("probe", "instance-a").cursor, "cursor-1"); stop(); });

test("poll lease fences overlapping Source instances", t => { const f = fixture(t); const first = f.registry.acquirePoll("probe", "a", "owner-a", 1000); assert.ok(first); assert.equal(f.registry.acquirePoll("probe", "a", "owner-b", 1000), undefined); assert.equal(f.registry.renewPoll(first!, 1000), true); assert.equal(f.registry.releasePoll(first!), true); const second = f.registry.acquirePoll("probe", "a", "owner-b", 1000); assert.ok(second); assert.equal(f.registry.releasePoll(first!), false); });


test("credential host persists only a reference and uses secret inside callback", async t => { const f = fixture(t); f.registry.configure("probe", { enabled: true, config: { room: "r", credentialRef: "github-agent" } }); const dispose = f.credentials.register({ id: "github-agent", kind: "github", label: "test" }, { resolve: async () => "TOP-SECRET" }); const binding = f.credentials.bind("probe", { id: "github-agent", kind: "github", label: "test" }); assert.equal(binding.ref.id, "github-agent"); let seen = ""; await f.credentials.withSourceCredential("probe", "read", async secret => { seen = String(secret); return undefined; }); assert.equal(seen, "TOP-SECRET"); assert.equal(JSON.stringify(f.control.read()).includes("TOP-SECRET"), false); assert.equal(JSON.stringify(f.store.db.all("SELECT data FROM dsh_kv" )).includes("TOP-SECRET"), false); dispose(); });

test("policy host persists versioned authorization and rejects stale writes", t => { const f = fixture(t); const first = f.policy.read(); const saved = f.policy.save(settings("auto"), first.revision); assert.notEqual(saved.version, first.version); assert.throws(() => f.policy.save(settings("off"), first.revision), /revision/); const restored = new ShadowPolicyHost(f.store, settings("observe")).read(); assert.equal(restored.settings.eval.mode, "auto"); assert.equal(restored.revision, 1); });

test("revoked and unavailable Sources remain persisted but cannot receive", t => { const f = fixture(t); const enabled = f.registry.configure("probe", { enabled: true, config: { room: "r" } }); assert.equal(f.registry.scope({ source: "probe", meta: { room: "r" } }).listened, true); const revoked = f.registry.setStatus("probe", "revoked", enabled.revision); assert.equal(revoked.status, "revoked"); assert.deepEqual(f.registry.scope({ source: "probe", meta: { room: "r" } }), { listened: false, reason: "source_revoked" }); const unavailable = f.registry.setStatus("probe", "unavailable", revoked.revision); assert.equal(unavailable.enabled, false); assert.deepEqual(f.registry.scope({ source: "probe", meta: { room: "r" } }), { listened: false, reason: "source_unavailable" }); });

test("unknown policy credential fields are rejected before persistence", t => { const f = fixture(t); const current = f.policy.read(); const unsafe = settings("auto"); unsafe.policy.sources.probe = { allowed: [], admission: {}, token: "secret" }; assert.throws(() => f.policy.save(unsafe, current.revision), /凭据字段/); assert.equal(f.policy.read().revision, current.revision); });

test("Policy host revalidation follows current Source status", t => { const f = fixture(t); const next = settings("auto"); next.policy.sources.probe = { allowed: [{ id: "alice" }], admission: {} }; const host = new ShadowPolicyHost(f.store, next); f.registry.configure("probe", { enabled: true, config: { room: "r" } }); const policy = host.policy(f.registry); const mandate = { strength: "explicit" as const, policyVersion: policy.version, actor: { source: "probe", id: "alice" }, scope: "r", basis: { source: "probe", scope: { room: "r" }, via: "addressed" as const, addressed: "mention" as const } }; assert.equal(policy.revalidate(mandate), true); const current = f.registry.instance("probe")!; f.registry.setStatus("probe", "revoked", current.revision); assert.equal(host.policy(f.registry).revalidate(mandate), false); });
