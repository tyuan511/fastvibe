import { test } from "node:test";
import assert from "node:assert/strict";
import { toolResultStatus } from "../src/shared/tool-result.ts";

const abortedDetails = {
  mode: "single",
  results: [{ agent: "explorer", stopReason: "aborted", errorMessage: "This operation was aborted" }],
};

test("an aborted subagent result is a cancellation, not a tool error", () => {
  assert.equal(toolResultStatus("subagent", true, abortedDetails), "aborted");
  assert.equal(toolResultStatus("SUBAGENT", true, abortedDetails), "aborted");
});

test("only structured subagent cancellations are suppressed", () => {
  assert.equal(toolResultStatus("subagent", true, { results: [{ stopReason: "error" }] }), "error");
  assert.equal(toolResultStatus("bash", true, abortedDetails), "error");
  assert.equal(toolResultStatus("subagent", true, { message: "This operation was aborted" }), "error");
  assert.equal(toolResultStatus("subagent", false, abortedDetails), "done");
});
