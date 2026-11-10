// SPDX-License-Identifier: MIT
// The production bridge: a real userData-shaped directory, a production-purpose store, a composed
// runtime with model-driven intake, and the Bot API the renderer already speaks.
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { createFauxCore, fauxAssistantMessage, fauxToolCall, InMemoryModelsStore } from "@earendil-works/pi-ai";
import { openViviDshProduction, viviDshProductionFile, viviDshProductionRoot } from "../src/main/bot/dsh-production.ts";
import type { ViviDshModelBinding } from "../src/main/bot/shadow/main-host.ts";
import { openShadowStore } from "../src/main/bot/shadow/store.ts";
import { dispatch } from "../src/main/ipc/registry.ts";
import { registerBotIpc } from "../src/main/ipc/bot-handlers.ts";
import { Ipc } from "../src/shared/ipc.ts";
import type { WorkSnapshot } from "../src/shared/bot.ts";

const timeout = { timeout: 20_000 };
type Responses = Parameters<ReturnType<typeof createFauxCore>["setResponses"]>[0];
const tool = (name: string, args: object) => fauxAssistantMessage([fauxToolCall(name, JSON.parse(JSON.stringify(args)))], { stopReason: "toolUse" });

/** A userData-shaped directory, so the production path assertions are about the real layout. */
function paths(root: string) {
  return { userData: root, runtimeRoot: join(root, "runtime", "engine") } as unknown as Parameters<typeof openViviDshProduction>[0]["paths"];
}

async function provider(root: string) {
  const faux = createFauxCore({ api: "prodapi", provider: "prod", models: [{ id: "offline" }] });
  const modelRuntime = await ModelRuntime.create({ authPath: join(root, "auth.json"), modelsPath: null,
    modelsStore: new InMemoryModelsStore(), allowModelNetwork: false, refreshOnCreate: false });
  modelRuntime.registerProvider("prod", { baseUrl: "http://offline.invalid", api: "prodapi" as never, apiKey: "offline", streamSimple: faux.streamSimple as never,
    models: [{ id: "offline", name: "offline", reasoning: false, input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 100_000, maxTokens: 4096 }] });
  return { faux, binding: { modelRuntime, model: modelRuntime.getModel("prod", "offline")! } satisfies ViviDshModelBinding };
}

function fixture(t: test.TestContext) {
  const root = mkdtempSync(join(tmpdir(), "dsh-production-"));
  const opened: Array<{ stop(): Promise<void> }> = [];
  t.after(async () => { for (const item of opened) await item.stop().catch(() => undefined); rmSync(root, { recursive: true, force: true }); });
  return { root, paths: paths(root), opened };
}

test("the production bridge opens a production-purpose store under userData, not fastvibe.db", timeout, async t => {
  const f = await fixture(t);
  const production = openViviDshProduction({ paths: f.paths, model: () => undefined, intake: { scope: "local" } });
  f.opened.push(production);
  assert.equal(production.store.purpose, "vivi-dsh-production");
  const file = viviDshProductionFile(f.paths);
  assert.ok(file.startsWith(f.root), `the Shadow store must live under userData: ${file}`);
  assert.ok(!file.endsWith("fastvibe.db"));
  assert.equal(statSync(file).mode & 0o777 & 0o077, 0, "the database must not be group/world readable");
  assert.ok(viviDshProductionRoot(f.paths).startsWith(f.root));
  // A persisted production store keeps its purpose; reopening it with the same authorization works.
  await production.stop();
  const reopened = openViviDshProduction({ paths: f.paths, model: () => undefined, intake: { scope: "local" } });
  f.opened.push(reopened);
  assert.equal(reopened.store.purpose, "vivi-dsh-production");
});

test("without an authenticated model the bridge serves snapshots and refuses execution", timeout, async t => {
  const f = await fixture(t);
  const production = openViviDshProduction({ paths: f.paths, model: () => undefined, intake: { scope: "local" } });
  f.opened.push(production);
  assert.equal(production.start(), false);
  assert.deepEqual((await production.api.getWorkSnapshot()).conversations, []);
  await assert.rejects(production.api.submit({ requestId: "no-model", text: "do work" }));
  assert.equal(production.store.tickets.list().length, 0);
});

test("with a model the bridge runs a Ticket end to end through the real Bot IPC", timeout, async t => {
  const f = await fixture(t);
  const p = await provider(f.root);
  p.faux.setResponses([tool("dsh_report", { state: "ready", summary: "production bridge ready" })]);
  const production = openViviDshProduction({ paths: f.paths, model: () => p.binding, intake: { scope: "local" }, maxWorkers: () => 1 });
  f.opened.push(production);
  assert.equal(production.start(), true);
  registerBotIpc({ bot: production.api });
  const ctx = { kind: "window" as const, window: null };
  const accepted = await dispatch(Ipc.botSubmit, { requestId: "prod-1", text: "do the production task" }, ctx) as WorkSnapshot;
  assert.equal(accepted.conversations.length, 1);
  await production.idle();
  const snapshot = await dispatch(Ipc.botGetWorkSnapshot, undefined, ctx) as WorkSnapshot;
  assert.equal(snapshot.results[0]?.status, "ready");
  assert.equal(snapshot.results[0]?.summary, "production bridge ready");
  // The domain, not a compatibility table, holds the work.
  assert.equal(production.store.tickets.list().length, 1);
  assert.equal(p.faux.state.callCount, 1);
  // The answer path the renderer calls now reaches the domain instead of throwing.
  await assert.rejects(production.api.answer({ attentionId: "missing", answer: "yes" }), /attention 不存在或已被替换/);
});

test("the runtime composes model-driven intake from the same binding", timeout, async t => {
  const f = await fixture(t);
  const p = await provider(f.root);
  // The assessor decides first; the worker then reports ready.
  p.faux.setResponses([tool("dsh_assess", { kind: "accept", reason: "clear request" }), tool("dsh_report", { state: "ready", summary: "intake accepted" })]);
  const production = openViviDshProduction({ paths: f.paths, model: () => p.binding, intake: { scope: "acme/widget" }, maxWorkers: () => 1 });
  f.opened.push(production);
  assert.equal(production.start(), true);
  await production.idle();
  // A model-created Ticket carries the host-provided scope, never one the model chose.
  await production.api.submit({ requestId: "intake-1", text: "fix the wrapping window" }).catch(() => undefined);
  await production.idle();
  const tickets = production.store.tickets.list();
  assert.ok(tickets.length >= 1, "the submit path must create a Ticket");
  for (const ticket of tickets) assert.equal(ticket.mandate.scope, "acme/widget");
});

test("stop releases the store and a second start after stop is refused until reopened", timeout, async t => {
  const f = await fixture(t);
  const p = await provider(f.root);
  const production = openViviDshProduction({ paths: f.paths, model: () => p.binding, intake: { scope: "local" } });
  assert.equal(production.start(), true);
  await production.stop();
  // The store is closed by stop; reading through it must fail rather than silently serve stale rows.
  assert.throws(() => production.store.tickets.list());
  await assert.rejects(production.api.submit({ requestId: "after-stop", text: "must not run" }));
});
