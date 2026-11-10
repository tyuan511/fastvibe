import assert from "node:assert/strict";
import test from "node:test";
import type { AgentThread } from "../src/shared/agent-thread.ts";
import type { ChatMessage } from "../src/shared/types.ts";
import { mergeReviewThreads, projectReviewMessages } from "../src/renderer/src/lib/review-messages.ts";
import { REVIEW_COMMAND_TYPE } from "../src/shared/review.ts";

const context = { id: "review-run", scope: "worktree" as const, base: "base", target: "target", capturedAt: 15, promptVersion: 1 as const, model: "review/model", thinkingLevel: "high", files: [{ path: "file.ts", status: "M", oldLines: 1, newLines: 1 }], root: "/repo", digest: "digest" };
const thread: AgentThread = { id: "agent-review", conversationId: "chat-a", rootId: "agent-review", agent: "review", task: "Review", cwd: "/repo", status: "working", createdAt: 15, updatedAt: 15, revision: 1, review: context };
const report = { version: 1 as const, summary: "No confirmed defects", findings: [], coverage: { reviewedPaths: ["file.ts"], unreviewedPaths: [] } };
const message = (id: string, createdAt: number, role: "user" | "assistant" = "assistant"): ChatMessage => ({ id, createdAt, role, text: id, tools: [] });

test("Review cards are derived from durable threads and are independent of parent tools or final prose", () => {
  const source = [message("request", 10, "user"), message("response", 12), message("later-request", 20, "user")];
  const projected = projectReviewMessages(source, [thread], "chat-a");
  assert.equal(source.length, 3);
  assert.deepEqual(projected.map((item) => item.id), ["request", "response", "review-card:chat-a:agent-review", "later-request"]);
  assert.equal(projected[0], source[0]);
  const card = projected[2];
  assert.equal(card.role, "system", "Review results stay outside assistant process folds");
  assert.equal(card.review, thread);
  assert.equal(card.createdAt, thread.createdAt);
  assert.deepEqual(card.tools, []);
});

test("completion, failure and interruption update one card without moving it to a later user turn", () => {
  const source = [message("first", 10, "user"), message("next", 20, "user")];
  const first = projectReviewMessages(source, [thread], "chat-a")[1];
  for (const status of ["completed", "failed", "interrupted"] as const) {
    const updated = { ...thread, status, updatedAt: 30, endedAt: 30, revision: 2, ...(status === "completed" ? { reviewReport: report } : {}) };
    const result = projectReviewMessages(source, [updated], "chat-a");
    assert.equal(result[1].id, first.id);
    assert.equal(result[1].createdAt, first.createdAt);
    assert.equal(result[1].review?.status, status);
    assert.equal(result[2], source[1]);
  }
});

test("a delayed snapshot cannot overwrite a newer completion push or another owner's report", () => {
  const done: AgentThread = { ...thread, status: "completed", revision: 3, reviewReport: report };
  const live = mergeReviewThreads([], [done], "chat-a");
  assert.equal(mergeReviewThreads(live, [thread], "chat-a"), live);
  assert.equal(mergeReviewThreads(live, [{ ...thread, conversationId: "chat-b", revision: 99 }], "chat-a"), live);
  assert.equal(live[0].reviewReport, report);
  assert.deepEqual(mergeReviewThreads(live, [], "chat-b"), []);
});

test("ordinary agents and other conversations do not produce Review cards", () => {
  const source = [message("request", 10, "user")];
  const ordinary = { ...thread, id: "worker", agent: "worker", review: undefined };
  assert.equal(projectReviewMessages(source, [ordinary, { ...thread, conversationId: "chat-b" }], "chat-a"), source);
  assert.equal(projectReviewMessages(source, [thread], null), source);
  assert.equal(projectReviewMessages([], [thread], "chat-a").length, 1, "Git-started review works without a fabricated user prompt");
});

test("duplicate live/snapshot entries remain one card, and unchanged cards retain identity while text streams", () => {
  const done = { ...thread, status: "completed" as const, revision: 2, reviewReport: report };
  const source = [message("request", 10, "user")];
  const first = projectReviewMessages(source, [done, thread, done], "chat-a");
  assert.equal(first.length, 2);
  assert.equal(first[1].review, done);
  const next = projectReviewMessages([...source, message("streamed", 30)], [done], "chat-a");
  assert.equal(next[1], first[1]);
  assert.equal(projectReviewMessages(first, [done], "chat-a").filter((row) => row.review).length, 1);
});

test("a /review command row is derived from the durable thread and sits directly above its card", () => {
  const commanded = { ...thread, review: { ...context, command: "/review 重点看会话切换" } };
  const rows = projectReviewMessages([message("request", 10, "user")], [commanded], "chat-a");
  assert.deepEqual(rows.map((row) => row.customType ?? row.role), ["user", REVIEW_COMMAND_TYPE, "fastvibe-review-card"]);
  const command = rows[1];
  assert.equal(command.text, "/review 重点看会话切换");
  assert.equal(command.role, "system", "the command is not a prompt the assistant was asked");
  assert.ok(command.createdAt < rows[2].createdAt, "the command precedes the card it opened");
  assert.equal(command.review, undefined, "the card, not the command row, carries the thread");
});

test("a review started from the dialog or Git pane has no command row, and reloading cannot duplicate one", () => {
  assert.deepEqual(projectReviewMessages([], [thread], "chat-a").map((row) => row.customType), ["fastvibe-review-card"]);
  const commanded = { ...thread, review: { ...context, command: "/review" } };
  const first = projectReviewMessages([], [commanded], "chat-a");
  assert.equal(first.length, 2);
  const again = projectReviewMessages([], [commanded, commanded], "chat-a");
  assert.equal(again.length, 2);
  assert.equal(again[1], first[1], "an unchanged thread keeps the same card row");
  assert.equal(again[0], first[0], "and the same command row");
  assert.equal(projectReviewMessages([], [{ ...commanded, conversationId: "chat-b" }], "chat-a").length, 0);
});
