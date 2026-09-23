import { test } from "node:test";
import assert from "node:assert/strict";
import { ALLOW_CONFIDENCE, approvalPolicy, approvalVerdict, buildApprovalRequest, MAX_SUBJECT_CHARS } from "../src/main/engine/decision/approval.ts";
import { adoptAnswers } from "../src/main/engine/decision/dispatch.ts";
import { assertValidQuestions } from "../src/main/engine/decision/protocol.ts";

/**
 * 帮我批准 on the decision model (docs/decision-layer.md §7.11). The rule under test is the
 * asymmetry: `ask` is taken at any confidence, `allow` — the answer that removes a prompt —
 * only at ALLOW_CONFIDENCE, and anything else leaves the call to the sandbox's patterns.
 */

const call = { tool: "bash", subject: "rm -rf dist", workspace: "/work/app", ruleFlags: ["Recursive delete"] };

function verdictFor(raw: unknown) {
  const request = buildApprovalRequest(call);
  return approvalVerdict(adoptAnswers(request.questions, { verdict: raw }, approvalPolicy).outcome);
}

test("the request is a valid single choice over allow / ask", () => {
  const request = buildApprovalRequest(call);
  assertValidQuestions(request.questions);
  const question = request.questions.verdict;
  assert.equal(question.type, "choice");
  assert.deepEqual(Object.keys(question.type === "choice" ? question.criteria : {}).sort(), ["allow", "ask"]);
  assert.deepEqual(request.state, { tool: "bash", call: "rm -rf dist", workspace: "/work/app", rule_flags: ["Recursive delete"] });
});

test("a long command is cut, and a write says whether it stays in the workspace", () => {
  const request = buildApprovalRequest({ ...call, tool: "write", subject: "x".repeat(MAX_SUBJECT_CHARS + 50), insideWorkspace: false });
  const state = request.state as Record<string, unknown>;
  assert.equal((state.call as string).length, MAX_SUBJECT_CHARS + 1);
  assert.equal(state.target_inside_workspace, false);
});

test("ask is adopted at any confidence", () => {
  assert.equal(verdictFor({ type: "choice", choice: "ask", confidence: { value: 0.1, source: "reported" } }), "ask");
});

test("allow needs the threshold", () => {
  assert.equal(verdictFor({ type: "choice", choice: "allow", confidence: { value: ALLOW_CONFIDENCE, source: "reported" } }), "allow");
  assert.equal(verdictFor({ type: "choice", choice: "allow", confidence: { value: ALLOW_CONFIDENCE - 0.01, source: "reported" } }), null);
});

test("an allow with no confidence at all is not trusted", () => {
  assert.equal(verdictFor({ type: "choice", choice: "allow" }), null);
});

test("a malformed or unknown answer leaves the call to the rules", () => {
  assert.equal(verdictFor({ type: "choice", choice: "run_it", confidence: { value: 1, source: "reported" } }), null);
  assert.equal(verdictFor({ type: "noul", noul: 1 }), null);
  assert.equal(approvalVerdict({ status: "handoff", reason: "unreachable" }), null);
  assert.equal(approvalVerdict({ status: "cancelled" }), null);
});
