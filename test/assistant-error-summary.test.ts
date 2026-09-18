import { test } from "node:test";
import assert from "node:assert/strict";
import { assistantErrorSummary, finalAssistantErrorSummary } from "../src/main/pi/assistant-error-summary.ts";

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
