/**
 * How a run that was aborted — not failed — is described.
 *
 * The SDK files an abort as `stopReason: "aborted"` when it can read its own abort
 * flag, and as `stopReason: "error"` with Node's `errorMessage: "This operation was
 * aborted"` whenever the abort surfaced as a thrown `AbortError` (a request cancelled
 * before the first byte). Both are the same event to the reader, so both must reach the
 * transcript as the quiet 已中断 row: no red failure bubble, and no English string the
 * 界面语言 setting never got a chance to translate.
 */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import test from "node:test";
import * as abort from "../src/shared/abort.ts";
import * as attachmentMetadata from "../src/shared/attachment-metadata.ts";
import * as toolResult from "../src/shared/tool-result.ts";
import type { ChatMessage, EngineEvent } from "../src/shared/types.ts";
import { mapEngineMessages } from "../src/main/engine/map-messages.ts";

const ABORT_TEXT = "This operation was aborted";

test("the platform's own AbortError text is recognised, prose about aborting is not", () => {
  assert.equal(abort.isAbortErrorText(ABORT_TEXT), true);
  assert.equal(abort.isAbortErrorText("  this operation was aborted. "), true);
  assert.equal(abort.isAbortErrorText("The user aborted a request."), true);
  // A gateway is free to answer with the word in a sentence; that stays a failure.
  assert.equal(abort.isAbortErrorText("upstream aborted the response with status 500"), false);
  assert.equal(abort.isAbortErrorText(undefined), false);
});

test("an abort the SDK filed as an error reads as a stop", () => {
  assert.equal(abort.assistantStopVerdict({ stopReason: "error", errorMessage: ABORT_TEXT }), "aborted");
  assert.equal(abort.assistantStopVerdict({ stopReason: "aborted" }), "aborted");
  assert.equal(abort.assistantStopVerdict({ stopReason: "length" }), "length");
  assert.equal(abort.assistantStopVerdict({ stopReason: "error", errorMessage: "HTTP 500" }), undefined);
  assert.equal(abort.assistantStopVerdict({ stopReason: "stop" }), undefined);
});

test("a transcript reload draws the aborted reply as 已中断, not as a red error", () => {
  const entries = [
    { type: "message", message: { role: "user", content: "跑一下", timestamp: 1 } },
    { type: "message", message: { role: "assistant", content: [], stopReason: "error", errorMessage: ABORT_TEXT, timestamp: 2 } },
  ];
  const [reply] = mapEngineMessages(entries).filter((row) => row.role === "assistant");
  assert.equal(reply.error, undefined);
  assert.equal(reply.stop, "aborted");
});

test("a real failure still reaches the transcript as an error", () => {
  const entries = [
    { type: "message", message: { role: "assistant", content: [], stopReason: "error", errorMessage: "HTTP 500 bad gateway", timestamp: 1 } },
  ];
  const [reply] = mapEngineMessages(entries).filter((row) => row.role === "assistant");
  assert.equal(reply.error, "HTTP 500 bad gateway");
  assert.equal(reply.stop, undefined);
});

test("a failure with no text says so in the interface language", () => {
  const entries = [{ type: "message", message: { role: "assistant", content: [], stopReason: "error", timestamp: 1 } }];
  const previous = process.env.FASTVIBE_UI_LANGUAGE;
  try {
    process.env.FASTVIBE_UI_LANGUAGE = "en";
    assert.equal(mapEngineMessages(entries).at(-1)?.error, "Request failed");
    process.env.FASTVIBE_UI_LANGUAGE = "zh";
    assert.equal(mapEngineMessages(entries).at(-1)?.error, "请求失败");
  } finally {
    if (previous === undefined) delete process.env.FASTVIBE_UI_LANGUAGE;
    else process.env.FASTVIBE_UI_LANGUAGE = previous;
  }
});

// ---------------------------------------------------------------- live stream
//
// `apply-engine-event` is renderer code that pulls in i18next, so it is transpiled to
// CommonJS and handed stubs — the same harness 排队立即发送's tests use.

const ts = createRequire(import.meta.url)("typescript") as typeof import("typescript");
const compiled = ts.transpileModule(
  readFileSync(new URL("../src/renderer/src/lib/apply-engine-event.ts", import.meta.url), "utf8"),
  { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } },
).outputText;
type Step = { messages: ChatMessage[]; streaming: boolean; interrupted?: "aborted" | "error" };
const exports_: { applyEngineEvent?: (messages: ChatMessage[], event: EngineEvent, streaming: boolean) => Step } = {};
new Function("require", "exports", compiled)((name: string) => {
  if (name === "@shared/abort") return abort;
  if (name === "@shared/attachment-metadata") return attachmentMetadata;
  if (name === "@shared/tool-result") return toolResult;
  if (name.endsWith("random.ts")) return { randomUUID };
  if (name === "@/lib/i18n") return { i18n: { t: (key: string) => key } };
  throw new Error(`Unexpected dependency: ${name}`);
}, exports_);

function settle(messages: ChatMessage[], lastEngine: Record<string, unknown>): Step {
  return exports_.applyEngineEvent!(
    [...messages, { id: "a1", role: "assistant", text: "", tools: [], parts: [], createdAt: 1 }],
    { type: "agent_end", messages: [lastEngine], willRetry: false } as EngineEvent,
    true,
  );
}

test("the streamed reply takes the same verdict as the reloaded one", () => {
  const step = settle([], { role: "assistant", content: [], stopReason: "error", errorMessage: ABORT_TEXT });
  const reply = step.messages.at(-1)!;
  assert.equal(reply.error, undefined);
  assert.equal(reply.stop, "aborted");
  // Still an interruption the queue must not drain past — the same verdict a 停止 gives.
  assert.equal(step.interrupted, "aborted");

  const failed = settle([], { role: "assistant", content: [], stopReason: "error", errorMessage: "HTTP 500" });
  assert.equal(failed.messages.at(-1)!.error, "HTTP 500");
  assert.equal(failed.messages.at(-1)!.stop, undefined);
  assert.equal(failed.interrupted, "error");
});
