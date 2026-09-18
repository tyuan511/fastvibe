import { test } from "node:test";
import assert from "node:assert/strict";
import { canResumeRun } from "../src/main/engine/resume.ts";

/**
 * The composer's 继续 control and the engine's `continueTurn` have to agree: a rule
 * that says "resumable" for a transcript the loop refuses, or misses one it could
 * re-enter, is a button that either fails or is missing on exactly the chat that
 * needs it. The rule is pure, so the cases are enumerated here rather than discovered
 * in the GUI.
 */

const assistant = (stopReason: string) => ({ role: "assistant", stopReason });
const user = { role: "user", content: "hi" };
const toolResult = { role: "toolResult", content: [] };

test("a trailing assistant that did not finish is resumable", () => {
  // `continueTurn` drops exactly these before re-entering the loop.
  assert.equal(canResumeRun([user, assistant("error")]), true);
  assert.equal(canResumeRun([user, assistant("aborted")]), true);
  assert.equal(canResumeRun([user, assistant("length")]), true);
});

test("a trailing assistant that finished cleanly is not", () => {
  assert.equal(canResumeRun([user, assistant("stop")]), false);
  // Still inside a tool batch, or deferred to the next turn: the run did what it
  // meant to, so there is nothing to continue.
  assert.equal(canResumeRun([user, assistant("toolUse")]), false);
  assert.equal(canResumeRun([user, assistant("pending")]), false);
  assert.equal(canResumeRun([user, assistant("deferred")]), false);
});

test("a trailing user or tool result is a half-delivered turn", () => {
  // What a run aborted before its first token, or a crash mid-tool, leaves behind.
  assert.equal(canResumeRun([user]), true);
  assert.equal(canResumeRun([user, assistant("stop"), user]), true);
  assert.equal(canResumeRun([assistant("toolUse"), toolResult]), true);
});

test("anything else has no run to continue", () => {
  assert.equal(canResumeRun([]), false);
  // A compaction summary is the new head of the context, not a turn in flight.
  assert.equal(canResumeRun([{ role: "compactionSummary", summary: "…" }]), false);
  assert.equal(canResumeRun([{ role: "custom", customType: "goal" }]), false);
  // Session files are parsed without validation, so a malformed row must not throw.
  assert.equal(canResumeRun([null as unknown]), false);
  assert.equal(canResumeRun([undefined as unknown]), false);
  assert.equal(canResumeRun([42 as unknown]), false);
});

test("only the last message decides", () => {
  assert.equal(canResumeRun([assistant("error"), user]), true);
  assert.equal(canResumeRun([assistant("aborted"), assistant("stop")]), false);
});
