import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { createFauxCore, fauxAssistantMessage, fauxToolCall, getCurrentTools, InMemoryModelsStore } from "@earendil-works/pi-ai";
import { ManagedPiReviewer, type ManagedPiReviewerOptions, type PiReviewArtifact, type PiReviewInput } from "../src/main/bot/shadow/pi-reviewer.ts";
import { PiLedger } from "../src/main/bot/shadow/pi-ledger.ts";
import { openShadowStore } from "../src/main/bot/shadow/store.ts";

// Real Pi SDK + offline scripted provider. These tests do not use an external model.
const head = "a".repeat(40), base = "b".repeat(40);
const input: PiReviewInput = { artifactId: "artifact-1", headSha: head, baseSha: base, diff: "diff --git a/a.ts b/a.ts\n-old\n+new", requirements: "Inspect every changed line", files: [{ path: "a.ts", version: "v1" }] };
const artifact: PiReviewArtifact = { artifactId: input.artifactId, headSha: head, baseSha: base, findings: [],
  checks: [{ name: "unit", status: "not-run", evidence: "No test execution tool" }], summary: "Static inspection complete; tests not run", verdict: "comment" };
type Responses = Parameters<ReturnType<typeof createFauxCore>["setResponses"]>[0];
const call = (value = artifact) => fauxAssistantMessage([fauxToolCall("dsh_review", JSON.parse(JSON.stringify(value)))], { stopReason: "toolUse" });
const timeout = { timeout: 15_000 };
function deferred() { let resolve!: () => void; const promise = new Promise<void>(done => { resolve = done; }); return { promise, resolve }; }
async function until(check: () => boolean) {
  const deadline = Date.now() + 5_000;
  while (!check()) { if (Date.now() > deadline) throw new Error("SDK boundary timeout"); await new Promise<void>(done => setImmediate(done)); }
}
async function harness(t: TestContext, responses: Responses, extra: Partial<ManagedPiReviewerOptions> = {}) {
  const root = mkdtempSync(join(tmpdir(), "dsh-reviewer-sdk-")), file = join(root, "shadow.db");
  let store = openShadowStore(file);
  const faux = createFauxCore({ api: "reviewer-faux-api", provider: "reviewer-faux", models: [{ id: "offline" }] }); faux.setResponses(responses);
  const runtime = await ModelRuntime.create({ authPath: join(root, "auth.json"), modelsPath: null, modelsStore: new InMemoryModelsStore(), allowModelNetwork: false, refreshOnCreate: false });
  runtime.registerProvider("reviewer-faux", { baseUrl: "http://faux.invalid", api: "reviewer-faux-api" as never, apiKey: "unused", streamSimple: faux.streamSimple as never,
    models: [{ id: "offline", name: "offline", reasoning: false, input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 100_000, maxTokens: 4096 }] });
  let current = true, snapshot = { headSha: head, baseSha: base };
  const reads: string[] = [], reviewers: ManagedPiReviewer[] = [];
  const open = async (overrides: Partial<ManagedPiReviewerOptions> = {}) => {
    const reviewer = await ManagedPiReviewer.open({ store, root, modelRuntime: runtime, model: runtime.getModel("reviewer-faux", "offline")!,
      binding: { ticketId: "ticket-1", assignmentId: "assignment-1", generation: 1, claimToken: 1 }, isCurrent: () => current, snapshot: () => snapshot,
      readFile: async file => { reads.push(file.path); return { content: "const newValue = 1;", version: file.version }; }, ...extra, ...overrides });
    reviewers.push(reviewer); return reviewer;
  };
  const reviewer = await open();
  t.after(async () => { for (const r of reviewers.reverse()) await r.dispose(); store.close(); rmSync(root, { recursive: true, force: true }); });
  return { reviewer, faux, reads, open, get store() { return store; }, setCurrent: (value: boolean) => { current = value; }, setSnapshot: (value: typeof snapshot) => { snapshot = value; },
    async restart() { await reviewer.dispose(); store.close(); store = openShadowStore(file); return open(); } };
}

test("真实SDK仅声明read_file/dsh_review，真实工具结果和provider-read证据绑定artifact", timeout, async t => {
  let providerText = "", toolNames: string[] = [];
  const h = await harness(t, [context => {
    providerText = JSON.stringify(context.messages); toolNames = getCurrentTools(context.messages).map(tool => tool.name);
    return fauxAssistantMessage([fauxToolCall("read_file", { path: "a.ts" })], { stopReason: "toolUse" });
  }, context => { assert.match(JSON.stringify(context.messages), /const newValue = 1/); return call(); }]);
  const record = await h.reviewer.review(input);
  assert.equal(record.status, "completed"); assert.deepEqual(toolNames.sort(), ["dsh_review", "read_file"]);
  assert.deepEqual(h.reads, ["a.ts"]); assert.match(providerText, /Inspect every changed line/); assert.match(providerText, /diff --git/);
  assert.equal(record.artifact?.checks[0]?.status, "not-run"); assert.ok(record.evidence?.toolCallId); assert.ok(record.evidence?.read.entryId);
  assert.deepEqual(record.evidence?.read.binding, record.binding);
  assert.match(record.sessionKey, /^reviewer-[0-9a-f]{64}$/);
  const ledger = new PiLedger(h.store), state = ledger.session(record.sessionKey)!;
  const transcript = readFileSync(state.sessionFile, "utf8").split("\n").filter(Boolean).map(line => JSON.parse(line));
  assert.ok(transcript.some(row => row.type === "message" && row.message.role === "toolResult" && row.message.toolName === "read_file"));
  assert.ok(transcript.some(row => row.type === "message" && row.message.role === "toolResult" && row.message.toolName === "dsh_review"));
  assert.ok(ledger.get(record.sessionKey, record.requestId)?.reads.length);
  assert.equal(ledger.get(`worker-${record.ticketId}`, record.requestId), undefined);
});

test("assistant普通文本不构成artifact；重开只读检查不自动重跑，显式retry才新attempt", timeout, async t => {
  const h = await harness(t, [fauxAssistantMessage(JSON.stringify(artifact)), call()]);
  const first = await h.reviewer.review(input); assert.equal(first.status, "uncertain"); assert.equal(first.artifact, undefined);
  const restarted = await h.restart(); assert.equal(restarted.inspect(input)?.status, "uncertain");
  assert.equal((await restarted.review(input)).status, "uncertain"); assert.equal(h.faux.state.callCount, 1);
  const second = await restarted.retry(input); assert.equal(second.status, "completed"); assert.equal(second.attempt, 2);
  assert.equal(second.sessionKey, first.sessionKey); assert.equal(h.faux.state.callCount, 2);
});

test("同artifact幂等；diff、要求、head、base、文件版本和宿主check漂移均拒绝", timeout, async t => {
  const h = await harness(t, [call()]); const result = await h.reviewer.review(input);
  assert.deepEqual(await h.reviewer.review(structuredClone(input)), result); assert.equal(h.faux.state.callCount, 1);
  for (const patch of [{ diff: "different" }, { requirements: "different" }, { headSha: "c".repeat(40) }, { baseSha: "d".repeat(40) },
    { files: [{ path: "a.ts", version: "v2" }] }, { verifiedChecks: [{ name: "unit", status: "passed" as const, evidence: "host run" }] }]) {
    await assert.rejects(h.reviewer.review({ ...input, ...patch }), /drift/);
  }
});

test("新Ticket、新artifact和新head/base使用独立session", timeout, async t => {
  const h = await harness(t, [call(), call(), call({ ...artifact, artifactId: "artifact-2", headSha: "c".repeat(40) })]);
  const first = await h.reviewer.review(input);
  const other = await h.open({ binding: { ticketId: "ticket-2", assignmentId: "assignment-2", generation: 1, claimToken: 1 } });
  const second = await other.review(input); assert.equal(second.status, "completed"); assert.notEqual(first.sessionKey, second.sessionKey);
  h.setSnapshot({ headSha: "c".repeat(40), baseSha: base });
  const third = await h.reviewer.review({ ...input, artifactId: "artifact-2", headSha: "c".repeat(40) });
  assert.equal(third.status, "completed"); assert.notEqual(first.sessionKey, third.sessionKey);
});

test("未执行check不能伪造成passed；可信宿主版本证据按原值保留", timeout, async t => {
  const h = await harness(t, [call({ ...artifact, checks: [{ name: "invented", status: "passed", evidence: "model says green" }, { name: "unit", status: "passed", evidence: "model rewritten" }] })]);
  const record = await h.reviewer.review({ ...input, verifiedChecks: [{ name: "unit", status: "failed", evidence: "host captured exit=1 at fixed SHA" }] });
  assert.equal(record.status, "completed"); assert.equal(record.artifact?.checks[0]?.status, "not-run");
  assert.deepEqual(record.artifact?.checks[1], { name: "unit", status: "failed", evidence: "host captured exit=1 at fixed SHA" });
});

for (const tool of ["bash", "write", "dsh_report", "subagent", "fetch"]) test(`未暴露${tool}，SDK不能调用其宿主能力`, timeout, async t => {
  const h = await harness(t, [fauxAssistantMessage([fauxToolCall(tool, { path: "a.ts", command: "echo fake", state: "ready", summary: "fake" })], { stopReason: "toolUse" }), fauxAssistantMessage("done")]);
  const record = await h.reviewer.review(input); assert.equal(record.status, "uncertain"); assert.equal(record.artifact, undefined); assert.deepEqual(h.reads, []);
});

for (const path of ["../secret", "/tmp/secret", "a.ts/../secret", "a\\b", "missing.ts"]) test(`read_file拒绝越界或非快照路径${path}`, timeout, async t => {
  const h = await harness(t, [fauxAssistantMessage([fauxToolCall("read_file", { path })], { stopReason: "toolUse" }), fauxAssistantMessage("cannot read")]);
  assert.equal((await h.reviewer.review(input)).status, "uncertain"); assert.deepEqual(h.reads, []);
});

for (const change of ["head", "base", "binding"] as const) test(`${change}漂移发生在provider处理中，迟到dsh_review不得写artifact`, timeout, async t => {
  const gate = deferred(); t.after(gate.resolve);
  const h = await harness(t, [async () => { await gate.promise; return call(); }, fauxAssistantMessage("rejected")]);
  const run = h.reviewer.review(input); await until(() => h.faux.state.callCount === 1);
  if (change === "binding") h.setCurrent(false); else h.setSnapshot({ headSha: change === "head" ? "c".repeat(40) : head, baseSha: change === "base" ? "d".repeat(40) : base });
  gate.resolve(); const record = await run; assert.equal(record.status, "uncertain"); assert.equal(record.artifact, undefined);
});

test("read_file异步返回后再次校验当前binding，迟到内容不送入下一provider", timeout, async t => {
  const gate = deferred(); t.after(gate.resolve); let reading = false;
  const h = await harness(t, [fauxAssistantMessage([fauxToolCall("read_file", { path: "a.ts" })], { stopReason: "toolUse" }), call()], {
    readFile: async () => { reading = true; await gate.promise; return { content: "LATE_SECRET_CONTENT", version: "v1" }; },
  });
  const run = h.reviewer.review(input); await until(() => reading); h.setCurrent(false); gate.resolve();
  const record = await run; assert.equal(record.status, "uncertain"); assert.equal(record.artifact, undefined); assert.equal(h.faux.state.callCount, 1);
});

test("read_file版本漂移不能返回旧上下文", timeout, async t => {
  let secondText = "";
  const h = await harness(t, [fauxAssistantMessage([fauxToolCall("read_file", { path: "a.ts" })], { stopReason: "toolUse" }), context => { secondText = JSON.stringify(context.messages); return fauxAssistantMessage("no artifact"); }], {
    readFile: async () => ({ content: "WRONG_VERSION_CONTENT", version: "v2" }),
  });
  assert.equal((await h.reviewer.review(input)).status, "uncertain"); assert.doesNotMatch(secondText, /WRONG_VERSION_CONTENT/);
});

test("Stop等待真实abort/dispose，迟到结果不能完成，资源owner释放且不可恢复旧artifact", timeout, async t => {
  const gate = deferred(); t.after(gate.resolve);
  const h = await harness(t, [async () => { await gate.promise; return call(); }]);
  const run = h.reviewer.review(input); await until(() => h.faux.state.callCount === 1);
  const stopping = h.reviewer.stop(); gate.resolve(); await stopping;
  const record = await run; assert.equal(record.status, "cancelled"); assert.equal(record.artifact, undefined); assert.equal(record.cancelRequested, true);
  assert.equal(h.store.get(`pi:owner:${record.sessionKey}`), null);
  await assert.rejects(h.reviewer.review(input), /stopped/);
  const reopened = await h.open(); await assert.rejects(reopened.retry(input), /Cancelled/); assert.equal(h.faux.state.callCount, 1);
});

for (const patch of [{ headSha: "wrong" }, { artifactId: "other" }, { findings: [{ severity: "high", path: "../escape", message: "bad" }] },
  { summary: "" }, { verdict: "unstructured" }]) test(`结构化artifact拒绝错误身份或schema ${JSON.stringify(patch)}`, timeout, async t => {
  const h = await harness(t, [call({ ...artifact, ...patch } as PiReviewArtifact), fauxAssistantMessage("invalid")]);
  const record = await h.reviewer.review(input); assert.equal(record.status, "uncertain"); assert.equal(record.artifact, undefined);
});

test("SQL ABORT使prepare receipt与running转换同事务回滚，不派发provider", timeout, async t => {
  const h = await harness(t, [call()]);
  h.store.db.exec(`CREATE TRIGGER reject_reviewer_running BEFORE UPDATE ON dsh_source_cursors
    WHEN json_extract(NEW.data,'$.status')='running' BEGIN SELECT RAISE(ABORT,'injected reviewer rollback'); END`);
  const record = await h.reviewer.review(input); assert.equal(record.status, "uncertain"); assert.equal(h.faux.state.callCount, 0);
  assert.equal(new PiLedger(h.store).get(record.sessionKey, record.requestId), undefined);
});

test("SDK接受前输入固定SHA和路径检查；无provider或session副作用", timeout, async t => {
  const h = await harness(t, [call()]);
  for (const patch of [{ headSha: "abc" }, { baseSha: "z".repeat(40) }, { artifactId: "" }, { files: [{ path: "../secret", version: "1" }] }]) {
    await assert.rejects(h.reviewer.review({ ...input, ...patch }), /Invalid/);
  }
  h.setSnapshot({ headSha: "c".repeat(40), baseSha: base }); await assert.rejects(h.reviewer.review(input), /version drift/);
  assert.equal(h.faux.state.callCount, 0);
});

test("同artifact并发请求共用真实provider运行；另一宿主只读观察不能自动重跑", timeout, async t => {
  const gate = deferred(); t.after(gate.resolve);
  const h = await harness(t, [async () => { await gate.promise; return call(); }]);
  const first = h.reviewer.review(input); await until(() => h.faux.state.callCount === 1);
  const running = h.reviewer.inspect(input)!; assert.equal(running.status, "running");
  const second = h.reviewer.review(input);
  const observer = await h.open();
  const rowCount = h.store.db.get<{ n: number }>("SELECT SUM(revision) AS n FROM dsh_source_cursors")!.n;
  assert.equal(observer.inspect(input)?.status, "uncertain");
  assert.equal((await observer.review(input)).status, "uncertain");
  assert.equal(h.store.db.get<{ n: number }>("SELECT SUM(revision) AS n FROM dsh_source_cursors")!.n, rowCount);
  assert.equal(h.faux.state.callCount, 1); gate.resolve();
  assert.deepEqual(await first, await second);
  const ledger = new PiLedger(h.store); assert.equal(ledger.list(running.sessionKey).length, 1);
});

test("Stop发生在SDK open期间也等待资源释放，不留下queued或活owner", timeout, async t => {
  const h = await harness(t, [call()]);
  const run = h.reviewer.review(input);
  await h.reviewer.stop();
  const record = await run; assert.equal(record.status, "cancelled"); assert.equal(record.artifact, undefined);
  assert.equal(h.faux.state.callCount, 0); assert.equal(h.store.get(`pi:owner:${record.sessionKey}`), null);
});

test("同一SDK batch重复dsh_review异内容不能覆盖首个artifact", timeout, async t => {
  const h = await harness(t, [fauxAssistantMessage([
    fauxToolCall("dsh_review", JSON.parse(JSON.stringify(artifact))),
    fauxToolCall("dsh_review", JSON.parse(JSON.stringify({ ...artifact, summary: "DRIFTED SECOND RESULT" }))),
  ], { stopReason: "toolUse" }), fauxAssistantMessage("done")]);
  const record = await h.reviewer.review(input);
  assert.equal(record.status, "completed"); assert.equal(record.artifact?.summary, artifact.summary);
  assert.ok(record.evidence?.toolCallId);
});
