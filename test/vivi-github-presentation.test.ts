import assert from "node:assert/strict";
import test from "node:test";
import { GithubNativePlanner } from "../src/main/bot/shadow/github-native-plan.ts";
import { closingIssueNumbers, renderPullBody, renderReviewBody } from "../src/main/bot/shadow/github-presentation.ts";
import { registerGithubShadowSource } from "../src/main/bot/shadow/github-source.ts";
import type { PiReviewArtifact } from "../src/main/bot/shadow/pi-reviewer.ts";
import { ShadowSourceRegistry } from "../src/main/bot/shadow/source-registry.ts";
import { openShadowStore } from "../src/main/bot/shadow/store.ts";

const HEAD = "a".repeat(40), BASE = "b".repeat(40);

function planner() {
  const store = openShadowStore(":memory:");
  const registry = new ShadowSourceRegistry(store);
  registerGithubShadowSource(registry);
  registry.configure("github", { enabled: true, config: { repository: { id: 11, owner: "acme", name: "widget" } } });
  return new GithubNativePlanner(store, registry);
}

function pullRequest(object: Record<string, unknown>, body: string) {
  return { kind: "pull" as const, source: "github", instance: "github", repositoryId: 11, object,
    params: { headBranch: "vivi/issue-1", baseBranch: "main", title: "Fix quiet hours", body },
    authorization: { source: "github", instance: "github", repositoryId: "11", ticketId: "ticket-1", mandateId: "decision-1",
      generation: 1, assignmentId: "assignment-1", bindingClaim: 2, allowed: ["pull" as const] },
    preconditions: { headSha: HEAD, baseSha: BASE } };
}

const artifact = (patch: Partial<PiReviewArtifact> = {}): PiReviewArtifact => ({
  artifactId: "review-1", headSha: HEAD, baseSha: BASE,
  findings: [
    { severity: "low", path: "src/b.ts", line: 9, message: "Minor naming" },
    { severity: "critical", path: "src/a.ts", line: 3, message: "Drops the wrap window" },
  ],
  checks: [{ name: "test", status: "failed", evidence: "node --test exited 1" }, { name: "lint", status: "passed", evidence: "clean" }],
  summary: "Cross-midnight handling is wrong.",
  verdict: "request-changes",
  ...patch,
});

test("closing keywords are parsed the way GitHub parses them", () => {
  assert.deepEqual(closingIssueNumbers("Closes #1"), [1]);
  assert.deepEqual(closingIssueNumbers("fixes #12"), [12]);
  assert.deepEqual(closingIssueNumbers("Resolved: #7"), [7]);
  assert.deepEqual(closingIssueNumbers("fixed #5"), [5]);
  assert.deepEqual(closingIssueNumbers("body\n\nclosed #3\nand closes #4"), [3, 4]);
  // A bare mention is not a closing keyword — this is the defect that broke the loop.
  assert.deepEqual(closingIssueNumbers("Related to #1."), []);
  assert.deepEqual(closingIssueNumbers("see #1"), []);
  assert.deepEqual(closingIssueNumbers(""), []);
  // The keyword must be a whole word, not the tail of one.
  assert.deepEqual(closingIssueNumbers("prefix #3"), []);
  assert.deepEqual(closingIssueNumbers("unfix #3"), []);
});

test("a linked pull body always carries the closing keyword, exactly once", () => {
  assert.equal(renderPullBody({ summary: "Fix it", issueNumber: 1 }), "Fix it\n\nCloses #1");
  // Already linked: no duplicate keyword, so replays stay byte-identical.
  assert.equal(renderPullBody({ summary: "Fix it\n\nCloses #1", issueNumber: 1 }), "Fix it\n\nCloses #1");
  assert.equal(renderPullBody({ summary: "Fixes #1", issueNumber: 1 }), "Fixes #1");
  assert.equal(renderPullBody({ summary: "Fix it" }), "Fix it");
  assert.throws(() => renderPullBody({ summary: "   ", issueNumber: 1 }), /PR 正文不能为空/);
  assert.throws(() => renderPullBody({ summary: "Fix it", issueNumber: 0 }), /issueNumber/);
});

test("the planner refuses a pull request that claims an Issue it would not close", () => {
  const intent = planner();
  assert.throws(() => intent.buildIntent(pullRequest({ issueNumber: 1 }, "Related to #1.")), /Closes\/Fixes\/Resolves #1/);
  // Declaring a different Issue does not satisfy the declared one.
  assert.throws(() => intent.buildIntent(pullRequest({ issueNumber: 2 }, "Closes #1")), /Closes\/Fixes\/Resolves #2/);
  // Unlinked work is still allowed; the contract only binds a declared link.
  assert.match(String((intent.buildIntent(pullRequest({}, "Related to #1.")).payload.expected.body as { body: string }).body), /^Related to #1\./);
  const linked = intent.buildIntent(pullRequest({ issueNumber: 1 }, renderPullBody({ summary: "Fix it", issueNumber: 1 })));
  assert.match(String((linked.payload.expected.body as { body: string }).body), /Closes #1/);
});

test("a review body is readable markdown, not serialized JSON", () => {
  const body = renderReviewBody(artifact());
  assert.match(body, /^## Changes requested$/m);
  assert.match(body, /Cross-midnight handling is wrong\./);
  // Sorted by severity, with a resolvable location.
  assert.ok(body.indexOf("Drops the wrap window") < body.indexOf("Minor naming"));
  assert.match(body, /`src\/a\.ts`:3/);
  // Checks stay visible so a reader can see why the verdict was forced.
  assert.match(body, /\| test \| failed \| node --test exited 1 \|/);
  assert.match(body, /Review artifact `review-1`/);
  assert.ok(body.includes(HEAD.slice(0, 12)) && body.includes(BASE.slice(0, 12)));
  // No raw JSON keys remain.
  assert.doesNotMatch(body, /"findings"|"verdict"|"summary":/);
  assert.doesNotMatch(body.trimStart(), /^\{/);
});

test("review rendering is deterministic and safe for model-provided text", () => {
  assert.equal(renderReviewBody(artifact()), renderReviewBody(artifact()));
  const body = renderReviewBody(artifact({
    summary: "Backtick ` in summary",
    findings: [{ severity: "high", path: "src/`weird`.ts", line: 1, message: "Message with `ticks`" }],
  }));
  assert.match(body, /Backtick ` in summary/);
  assert.match(body, /``src\/`weird`\.ts``/);
});

test("approve with a failing check is called out, and an empty review says so", () => {
  assert.match(renderReviewBody(artifact({ verdict: "approve" })), /> Verdict is approve but test did not pass\./);
  const clean = renderReviewBody(artifact({ verdict: "approve", findings: [], checks: [] }));
  assert.match(clean, /^## Approved$/m);
  assert.match(clean, /No findings\./);
});
