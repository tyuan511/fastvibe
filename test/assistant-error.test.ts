import { test } from "node:test";
import assert from "node:assert/strict";
import { describeAssistantError, errorHasDetail, prettyProviderDetail } from "../src/shared/assistant-error.ts";

/**
 * The shape a gateway failure really arrives in: a status code glued to one line of JSON.
 * Drawn as-is it was the transcript's most prominent red line, and reading it meant parsing
 * the provider's own body.
 */
const QUOTA =
  '429: {"message":"Allocated quota exceeded, please increase your quota limit. For details, see: ' +
  'https://www.alibabacloud.com/help/en/model-studio/error-code#token-limit","id":"14fc57c3-2e05-4bdb",' +
  '"type":"insufficient_quota","code":"insufficient_quota"}';

/** An SDK setup failure: three paragraphs, the last of them one unbreakable path. */
const SETUP =
  "No API key found for anthropic.\n\nUse /login to log into a provider via OAuth or API key. See:\n" +
  "  /Users/yuantang/code/fastvibe/node_modules/.pnpm/@earendil-works+pi-coding-agent@1.3.0/docs/providers.md";

test("a status and a JSON body are lifted out of the provider's line", () => {
  const shape = describeAssistantError(QUOTA);
  assert.equal(shape.status, 429);
  assert.equal(shape.code, "insufficient_quota");
  // One sentence of the provider's message: the allocation advice after it reads as body.
  assert.equal(shape.headline, "Allocated quota exceeded, please increase your quota limit.");
  assert.deepEqual(shape.body, ["For details, see: https://www.alibabacloud.com/help/en/model-studio/error-code#token-limit"]);
  // The detail keeps everything, pretty-printed so it can be read a key at a time.
  assert.match(shape.detail, /\n {2}"message": /);
  assert.match(shape.detail, /#token-limit/);
  assert.doesNotMatch(shape.detail, /^429:/);
});

test("an OpenAI-shaped envelope nested one level still yields its message", () => {
  const shape = describeAssistantError(
    'OpenAI API error (429): {"error":{"message":"Rate limit reached","type":"rate_limit_error"}}',
  );
  assert.equal(shape.status, 429);
  assert.equal(shape.headline, "Rate limit reached");
  assert.equal(shape.code, "rate_limit_error");
  // The provider's own prefix survives inside the detail rather than being thrown away.
  assert.match(shape.detail, /^OpenAI API error \(429\):/);
});

test("a multi-line setup error keeps its first line, its advice, and its path as separate rows", () => {
  const shape = describeAssistantError(SETUP);
  assert.equal(shape.headline, "No API key found for anthropic.");
  // The blank line between the paragraphs is not a row of its own, and the indented path is
  // one line — not glued onto the sentence that introduces it.
  assert.deepEqual(shape.body, [
    "Use /login to log into a provider via OAuth or API key. See:",
    "/Users/yuantang/code/fastvibe/node_modules/.pnpm/@earendil-works+pi-coding-agent@1.3.0/docs/providers.md",
  ]);
  assert.equal(errorHasDetail(shape), true);
});

test("a stack trace is split one frame per row, indentation removed", () => {
  const shape = describeAssistantError(
    'error during build:\nError: Could not resolve "./missing"\n    at file:///Users/dev/App.tsx:12:3',
  );
  assert.equal(shape.headline, "error during build:");
  assert.deepEqual(shape.body, ["Error: Could not resolve \"./missing\"", "at file:///Users/dev/App.tsx:12:3"]);
});

test("a body with no message falls back to the text itself", () => {
  const shape = describeAssistantError("Request timed out.");
  assert.equal(shape.status, undefined);
  assert.equal(shape.headline, "Request timed out.");
  assert.deepEqual(shape.body, []);
  assert.equal(shape.detail, "Request timed out.");
  // One sentence with nothing behind it: no disclosure at all.
  assert.equal(errorHasDetail(shape), false);
});

test("a status the provider sent without a body is the status, not a headline", () => {
  for (const raw of ["413 status code (no body)", "502 "]) {
    const shape = describeAssistantError(raw);
    assert.equal(shape.headline, "", raw);
    assert.equal(typeof shape.status, "number", raw);
    // Nothing is lost: 复制 copies the raw text.
    assert.match(shape.detail, /^\d{3}/, raw);
  }
});

test("a number that is not a status is left alone", () => {
  const shape = describeAssistantError("read failed at line 500 of foo.ts");
  assert.equal(shape.status, undefined);
  assert.equal(shape.headline, "read failed at line 500 of foo.ts");
});

test("a long provider sentence is cut to one readable line, and only in the headline", () => {
  const shape = describeAssistantError(`500: {"message":"${"x".repeat(600)}"}`);
  assert.equal(shape.status, 500);
  assert.equal(shape.headline.length, 241);
  assert.ok(shape.headline.endsWith("…"));
  assert.ok(shape.detail.includes("x".repeat(600)));
});

test("an empty error is empty, never a stray label", () => {
  assert.deepEqual(describeAssistantError("   "), { headline: "", body: [], detail: "" });
});

test("pretty-printing a non-JSON detail returns it untouched", () => {
  assert.equal(prettyProviderDetail("socket hang up\nECONNRESET"), "socket hang up\nECONNRESET");
  assert.equal(prettyProviderDetail('{"a":1}'), '{\n  "a": 1\n}');
});
