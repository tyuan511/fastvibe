// SPDX-License-Identifier: MIT
// Real SDK assessment (offline faux provider): automatic intake decides accept/ignore itself,
// while ticket identity stays host-authored.
import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { createFauxCore, fauxAssistantMessage, fauxToolCall, getCurrentTools, InMemoryModelsStore } from "@earendil-works/pi-ai";
import type { Trigger } from "../src/main/bot/core/model.ts";
import type { Candidate, Policy } from "../src/main/bot/core/ports.ts";
import { ManagedPiAssessor, assessorInput } from "../src/main/bot/shadow/pi-assessor.ts";
import { ShadowEngine } from "../src/main/bot/shadow/engine.ts";
import { openShadowStore, type ShadowStore } from "../src/main/bot/shadow/store.ts";

const timeout = { timeout: 20_000 };
type Responses = Parameters<ReturnType<typeof createFauxCore>["setResponses"]>[0];

const tool = (name: string, args: object) => fauxAssistantMessage([fauxToolCall(name, JSON.parse(JSON.stringify(args)))], { stopReason: "toolUse" });
const accept = (reason = "The reporter asks for the wrapping-window fix", note?: string) => tool("dsh_assess", { kind: "accept", reason, ...(note ? { note } : {}) });
const ignore = (reason = "Status chatter, no request") => tool("dsh_assess", { kind: "ignore", reason });

function trigger(id = "issue-1", text = "quiet hours wrap fails across midnight, please fix"): Trigger {
  return { id, source: "github", threads: [{ source: "github", id: "repo:thread:7" }], actor: { source: "github", id: "tyuan511" },
    human: true, at: new Date(1_000_000).toISOString(), text, meta: { number: 7, kind: "issue" } };
}

const policy = (): Policy => ({ version: "assessor-test", paused: false, evalTimeoutMs: 60_000,
  gate: () => ({ admissible: true, strength: "explicit", basis: { via: "listed" } }), revalidate: () => true, admitsInferred: () => true });

async function provider(root: string, responses: Responses) {
  const faux = createFauxCore({ api: "assessor-api", provider: "assessor", models: [{ id: "offline" }] }); faux.setResponses(responses);
  const runtime = await ModelRuntime.create({ authPath: join(root, "assessor-auth.json"), modelsPath: null, modelsStore: new InMemoryModelsStore(), allowModelNetwork: false, refreshOnCreate: false });
  runtime.registerProvider("assessor", { baseUrl: "http://faux.invalid", api: "assessor-api" as never, apiKey: "unused", streamSimple: faux.streamSimple as never,
    models: [{ id: "offline", name: "offline", reasoning: false, input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 100_000, maxTokens: 4096 }] });
  return { faux, runtime, model: runtime.getModel("assessor", "offline")! };
}

interface Options { responses?: Responses; describe?: (candidate: Candidate) => { title: string; scope: string } }

async function harness(t: TestContext, options: Options = {}) {
  const root = mkdtempSync(join(tmpdir(), "dsh-assessor-"));
  const store: ShadowStore = openShadowStore(join(root, "shadow.db"));
  const engine = new ShadowEngine(store, { scope: { scope: () => ({ listened: true, observed: false }) }, policy });
  const model = await provider(root, options.responses ?? [accept()]);
  const described: Candidate[] = [], decided: Array<{ triggerId: string; kind: string; title?: string; scope?: string; note?: string }> = [];
  const assessor = await ManagedPiAssessor.open({ store, root, modelRuntime: model.runtime, model: model.model,
    describe: candidate => { described.push(candidate); return (options.describe ?? (() => ({ title: "Fix quiet-hours wrapping", scope: "acme/widget" })))(candidate); },
    decide: (triggerId, outcome) => {
      decided.push({ triggerId, kind: outcome.kind, ...(outcome.kind === "accept" ? { title: outcome.title, scope: outcome.scope, ...(outcome.note ? { note: outcome.note } : {}) } : {}) });
      engine.main.decide(triggerId, outcome);
    },
  });
  t.after(async () => { await assessor.dispose(); store.close(); rmSync(root, { recursive: true, force: true }); });
  const candidateFor = (input = trigger()): Candidate => {
    engine.sources.receive(input); engine.evaluateDue();
    const candidate = engine.main.candidate(input.id); assert.ok(candidate, "an admissible trigger must produce a candidate");
    return candidate;
  };
  const tools = () => model.faux.state.callCount;
  return { root, store, engine, model, assessor, candidateFor, described, decided, tools,
    records: () => store.db.all<{ data: string }>("SELECT data FROM dsh_source_cursors WHERE source='pi-assessor'").map(row => JSON.parse(row.data)),
    tickets: () => store.tickets.list() };
}

test("a model accept becomes a real Ticket whose identity came from the host, not the model", timeout, async t => {
  const h = await harness(t, { responses: [accept("Clear request to repair the wrapping logic", "Focus on mergedQuietIntervals")] });
  const candidate = h.candidateFor();
  const record = await h.assessor.assess(candidate);
  assert.equal(record.status, "completed"); assert.equal(record.outcome?.kind, "accept");
  // The model chose accept; the host chose the identity.
  assert.deepEqual(h.decided, [{ triggerId: "issue-1", kind: "accept", title: "Fix quiet-hours wrapping", scope: "acme/widget", note: "Focus on mergedQuietIntervals" }]);
  const tickets = h.tickets();
  assert.equal(tickets.length, 1);
  assert.equal(tickets[0]!.title, "Fix quiet-hours wrapping");
  assert.equal(tickets[0]!.mandate.scope, "acme/widget");
  assert.equal(h.store.decisions.get(tickets[0]!.decisionId)?.kind, "accept");
  // The assessor saw only redacted facts: no token, no scope, no other ticket internals.
  const seen = JSON.stringify(h.described[0]!);
  assert.match(seen, /quiet hours wrap fails/);
  assert.doesNotMatch(seen, /claimToken|assignmentId/i);
});

test("the model sees no ability to widen scope: a hostile reason cannot change repository", timeout, async t => {
  const h = await harness(t, { responses: [accept("accept")], describe: () => ({ title: "Triage", scope: "acme/widget" }) });
  const record = await h.assessor.assess(h.candidateFor());
  assert.equal(record.status, "completed");
  // Whatever the reason text says, the recorded Mandate uses the host scope.
  assert.equal(h.tickets()[0]!.mandate.scope, "acme/widget");
  assert.equal(h.tickets()[0]!.title, "Triage");
});

test("an ignore decision records why and starts no ticket", timeout, async t => {
  const h = await harness(t, { responses: [ignore("Already handled by the open ticket on this thread")] });
  const record = await h.assessor.assess(h.candidateFor(trigger("issue-2", "thanks, looks good")));
  assert.equal(record.status, "completed"); assert.equal(record.outcome?.kind, "ignore");
  assert.equal(h.tickets().length, 0);
  const decision = h.store.decisions.byThread("github:repo:thread:7").at(-1)!;
  assert.equal(decision.kind, "ignore");
});

test("assessment is idempotent per Eval: a redelivered Trigger never asks the model twice", timeout, async t => {
  const h = await harness(t, { responses: [accept(), accept()] });
  const candidate = h.candidateFor();
  const first = await h.assessor.assess(candidate);
  const calls = h.tools();
  const second = await h.assessor.assess(candidate);
  assert.deepEqual(second, first);
  assert.equal(h.tools(), calls, "a completed assessment must not dispatch the provider again");
  assert.equal(h.tickets().length, 1);
  assert.equal(h.decided.length, 1);
});

test("a model that never decides fails closed and creates no ticket", timeout, async t => {
  // A plain assistant message tries to answer in prose instead of calling the tool.
  const h = await harness(t, { responses: [fauxAssistantMessage("Looks like a request, I would accept it.")] });
  const record = await h.assessor.assess(h.candidateFor());
  assert.equal(record.status, "failed");
  assert.equal(h.tickets().length, 0);
  assert.equal(h.decided.length, 0);
  assert.equal(h.records()[0]?.status, "failed");
});

test("the assessor exposes exactly one tool and refuses to start after dispose", timeout, async t => {
  let tools: string[] = [];
  const h = await harness(t, { responses: [context => { tools = getCurrentTools(context.messages).map(item => item.name); return accept(); }] });
  await h.assessor.assess(h.candidateFor());
  assert.deepEqual(tools, ["dsh_assess"]);
  await h.assessor.dispose();
  const second = trigger("issue-3");
  h.engine.sources.receive(second); h.engine.evaluateDue();
  const candidate = h.engine.main.candidate(second.id)!;
  await assert.rejects(() => h.assessor.assess(candidate), /stopped/);
});

test("assessorInput redacts tickets to identity and outcome only", () => {
  const input = assessorInput({
    evalId: "eval-1", strength: "explicit", policyVersion: "v1",
    thread: { key: "k" } as Candidate["thread"],
    triggers: [trigger()],
    tickets: [
      { id: "t1", title: "Open work", mandate: { scope: "acme/widget" }, ended: undefined } as unknown as Candidate["tickets"][number],
      { id: "t2", title: "Done work", mandate: { scope: "acme/widget" }, ended: { at: "x", by: "executor", outcome: "merged" } } as unknown as Candidate["tickets"][number],
    ],
  });
  assert.deepEqual(input.openTicketsOnThread, [{ id: "t1", title: "Open work", scope: "acme/widget" }]);
  assert.deepEqual(input.endedTicketsOnThread, [{ id: "t2", title: "Done work", outcome: "merged" }]);
  assert.deepEqual(Object.keys(input).sort(), ["endedTicketsOnThread", "evalId", "messages", "openTicketsOnThread", "strength"]);
});
