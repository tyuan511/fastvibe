import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { promisify } from "node:util";
import { createReviewSnapshot, type ReviewSnapshot } from "../src/main/engine/review-snapshot.ts";
import { createReviewTools } from "../src/main/pi/review-tools.ts";

const exec = promisify(execFile);
async function snapshot(t: TestContext): Promise<ReviewSnapshot> {
  const root = await mkdtemp(join(tmpdir(), "fastvibe-review-result-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const git = (...args: string[]) => exec("git", ["-C", root, ...args]);
  await git("init", "-b", "main");
  await writeFile(join(root, "a.ts"), "export const value = 1;\nexport const retained = true;\n");
  await git("add", "."); await git("-c", "user.name=Test", "-c", "user.email=test@example.com", "commit", "-m", "Initial");
  await writeFile(join(root, "a.ts"), "export const value = 0;\nexport const retained = true;\n");
  return createReviewSnapshot({ conversationId: "owner", cwd: root, scope: "worktree" }, { id: "review-result", model: "p/m", thinkingLevel: "high" });
}
function report() {
  return {
    version: 1,
    summary: "The new value breaks the caller's nonzero-value contract.",
    findings: [{
      id: "model-supplied-id",
      title: "Zero value reaches division", severity: "P1", confidence: "high", category: "correctness",
      location: { path: "a.ts", side: "new", startLine: 1, endLine: 1, snippet: "invented source" },
      trigger: "The caller divides a total by this value.", impact: "The result becomes Infinity.",
      evidence: ["The exported value is zero."], recommendation: "Retain a nonzero value or handle zero at the caller.",
    }],
    coverage: { reviewedPaths: ["a.ts"], unreviewedPaths: [] as Array<{ path: string; reason: string }> },
  };
}

test("report validation generates stable IDs and authoritative frozen code excerpts", async (t) => {
  const review = await snapshot(t);
  const first = review.validateReport(report());
  assert.equal(first.version, 1);
  assert.notEqual(first.findings[0].id, "model-supplied-id");
  assert.match(first.findings[0].location.snippet!, /1: export const value = 0;/);
  assert.doesNotMatch(first.findings[0].location.snippet!, /invented/);
  assert.equal(first.findings[0].id, review.validateReport(report()).findings[0].id);
});

test("finding locations, evidence, severity, and coverage are checked independently of tool schema", async (t) => {
  const review = await snapshot(t);
  for (const change of [
    (r: ReturnType<typeof report>) => { r.findings[0].location.path = "../outside.ts"; },
    (r: ReturnType<typeof report>) => { r.findings[0].location.path = "not-changed.ts"; },
    (r: ReturnType<typeof report>) => { r.findings[0].location.startLine = 10; r.findings[0].location.endLine = 10; },
    (r: ReturnType<typeof report>) => { r.findings[0].location.endLine = 0; },
    (r: ReturnType<typeof report>) => { r.findings[0].severity = "urgent"; },
    (r: ReturnType<typeof report>) => { r.findings[0].confidence = "maybe"; },
    (r: ReturnType<typeof report>) => { r.findings[0].evidence = []; },
    (r: ReturnType<typeof report>) => { r.findings[0].trigger = ""; },
    (r: ReturnType<typeof report>) => { r.coverage.reviewedPaths = []; },
    (r: ReturnType<typeof report>) => { r.coverage.unreviewedPaths = [{ path: "a.ts", reason: "Not checked" }]; },
    (r: ReturnType<typeof report>) => { r.findings.push(r.findings[0]); },
  ]) {
    const input = report(); change(input);
    assert.throws(() => review.validateReport(input));
  }
});

test("no findings is a valid outcome but unaccounted changed files cannot pass", async (t) => {
  const review = await snapshot(t);
  const empty = { ...report(), findings: [] };
  assert.equal(review.validateReport(empty).findings.length, 0);
  assert.throws(() => review.validateReport({ ...empty, coverage: { reviewedPaths: [], unreviewedPaths: [] } }));
  const partial = review.validateReport({ ...empty, coverage: { reviewedPaths: [], unreviewedPaths: [{ path: "a.ts", reason: "Caller unavailable" }] } });
  assert.equal(partial.coverage.unreviewedPaths[0].reason, "Caller unavailable");
});

test("tools expose only immutable reads/search and validated submission; further reads invalidate reports", async (t) => {
  const review = await snapshot(t);
  const tools = new Map<string, { execute: (...args: any[]) => Promise<any> }>();
  const bridge = createReviewTools(review);
  await bridge.factory({ registerTool(tool: any) { tools.set(tool.name, tool); } } as any);
  assert.deepEqual([...tools.keys()], ["review_read_file", "review_search", "submit_review_result"]);
  const submit = tools.get("submit_review_result")!;
  const invalid = report(); invalid.findings[0].location.endLine = 300;
  assert.equal((await submit.execute("bad", invalid)).isError, true);
  assert.equal(bridge.getReport(), undefined);
  const accepted = await submit.execute("good", report());
  assert.equal(accepted.details.accepted, true);
  assert.equal(bridge.getReport()!.findings.length, 1);
  await tools.get("review_read_file")!.execute("read", { path: "a.ts" });
  assert.equal(bridge.getReport(), undefined);
  await submit.execute("good-again", report());
  await tools.get("review_search")!.execute("search", { query: "value" });
  assert.equal(bridge.getReport(), undefined);
  await submit.execute("good-last", report());
  assert.ok(bridge.getReport());
  await submit.execute("bad-last", invalid);
  assert.equal(bridge.getReport(), undefined);
});

test("an aborted submission cannot produce a successful report", async (t) => {
  const review = await snapshot(t);
  const tools = new Map<string, { execute: (...args: any[]) => Promise<any> }>();
  const bridge = createReviewTools(review);
  await bridge.factory({ registerTool(tool: any) { tools.set(tool.name, tool); } } as any);
  const cancelled = new AbortController(); cancelled.abort();
  assert.equal((await tools.get("submit_review_result")!.execute("cancelled", report(), cancelled.signal)).isError, true);
  assert.equal(bridge.getReport(), undefined);
});
