import { test } from "node:test";
import assert from "node:assert/strict";
import { assistantErrorSummary, finalAssistantErrorSummary } from "../src/main/pi/assistant-error-summary.ts";
import { isAbortOutcome, isCompactionCancelled } from "../src/shared/abort.ts";

test("a successful retry does not replay an earlier aborted assistant message", () => {
  assert.equal(
    finalAssistantErrorSummary([
      { role: "assistant", stopReason: "aborted", errorMessage: "This operation was aborted" },
      { role: "toolResult", toolCallId: "call-1" },
      { role: "assistant", content: [{ type: "text", text: "已完成" }], stopReason: "stop" },
    ]),
    undefined,
  );
});

test("the current final assistant error is still preserved", () => {
  const message = { role: "assistant", stopReason: "error", errorMessage: "请求失败" };
  assert.deepEqual(finalAssistantErrorSummary([{ role: "assistant", stopReason: "stop" }, message]), {
    role: "assistant",
    stopReason: "error",
    errorMessage: "请求失败",
  });
  assert.deepEqual(assistantErrorSummary(message), {
    role: "assistant",
    stopReason: "error",
    errorMessage: "请求失败",
  });
});

test("tool results after an assistant error do not hide the assistant error", () => {
  assert.deepEqual(
    finalAssistantErrorSummary([
      { role: "assistant", stopReason: "error", errorMessage: "请求失败" },
      { role: "toolResult", toolCallId: "call-1" },
    ]),
    { role: "assistant", stopReason: "error", errorMessage: "请求失败" },
  );
});

test("structured abort outcomes are recognised without matching error text", () => {
  const abortError = new Error("This operation was aborted");
  abortError.name = "AbortError";

  assert.equal(isAbortOutcome(abortError), true);
  assert.equal(isAbortOutcome({ error: { stopReason: "aborted" } }), true);
  assert.equal(isAbortOutcome({ reason: "aborted" }), true);
  // A real provider failure may happen to contain this word. Text alone must never
  // suppress it, or genuine errors disappear from the transcript.
  assert.equal(isAbortOutcome(new Error("upstream aborted the response with status 500")), false);
  assert.equal(isCompactionCancelled(new Error("Compaction cancelled")), true);
  assert.equal(isCompactionCancelled(new DOMException("The operation was aborted", "AbortError")), true);
  assert.equal(isCompactionCancelled(new Error("Compaction failed: boom")), false);
  assert.equal(isAbortOutcome({ stopReason: "error", errorMessage: "This operation was aborted" }), false);
});

test("a reply FastVibe stopped for repeating itself is told apart from the user's own stop", async () => {
  const { mapEngineMessages } = await import("../src/main/engine/map-messages.ts");
  const { REPETITION_STOP_MESSAGE, isRepetitionStop } = await import("../src/shared/abort.ts");
  const reply = (errorMessage: string) => ({
    role: "assistant",
    stopReason: "aborted",
    errorMessage,
    content: [{ type: "text", text: "partial" }],
  });

  const [guarded] = mapEngineMessages([reply(REPETITION_STOP_MESSAGE)]);
  assert.equal(guarded.stop, "aborted");
  assert.equal(guarded.stopCause, "repetition");

  // The user's 停止 carries the stream's own text; it must stay a plain stop.
  const [stopped] = mapEngineMessages([reply("OpenAI Responses stream ended before a terminal response event")]);
  assert.equal(stopped.stop, "aborted");
  assert.equal(stopped.stopCause, undefined);

  // Only an aborted reply can carry the mark.
  assert.equal(isRepetitionStop({ stopReason: "error", errorMessage: REPETITION_STOP_MESSAGE }), false);
  assert.equal(isRepetitionStop({ stopReason: "aborted", errorMessage: REPETITION_STOP_MESSAGE }), true);
});
