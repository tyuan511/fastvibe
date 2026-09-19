import { test } from "node:test";
import assert from "node:assert/strict";
import { assistantErrorSummary, finalAssistantErrorSummary } from "../src/main/pi/assistant-error-summary.ts";
import { isAbortOutcome } from "../src/shared/abort.ts";

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
  assert.equal(isAbortOutcome({ stopReason: "error", errorMessage: "This operation was aborted" }), false);
});
