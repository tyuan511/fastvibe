import { test } from "node:test";
import assert from "node:assert/strict";
import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import { hasSubstance, redactSecrets, renderRollout } from "../src/main/engine/memory-transcript.ts";

const entry = (message: unknown, id = "e"): SessionEntry => ({ type: "message", id, parentId: null, timestamp: "2026-01-01T00:00:00Z", message } as unknown as SessionEntry);

test("secrets are replaced, and the key of an assignment survives", () => {
  const text = [
    "key sk-abcdefghijklmnopqrstuvwx",
    "token ghp_abcdefghijklmnopqrstuvwxyz0123",
    "Authorization: Bearer abcdefghijklmnop1234567890",
    "API_KEY=supersecretvalue",
    "password: \"hunter2hunter2\"",
    "-----BEGIN RSA PRIVATE KEY-----\nMIIabc\n-----END RSA PRIVATE KEY-----",
  ].join("\n");
  const out = redactSecrets(text);
  for (const leak of ["sk-abcdef", "ghp_abcdef", "abcdefghijklmnop1234567890", "supersecretvalue", "hunter2hunter2", "MIIabc"]) {
    assert.ok(!out.includes(leak), `${leak} leaked: ${out}`);
  }
  assert.match(out, /API_KEY=\[REDACTED_SECRET\]/);
  assert.match(out, /Bearer \[REDACTED_SECRET\]/);
});

test("ordinary prose and code are left alone", () => {
  const text = "Use the token bucket algorithm; set password policy in settings.";
  assert.equal(redactSecrets(text), text);
});

test("a conversation renders as users, replies and clipped tool use; thinking is dropped", () => {
  const rendered = renderRollout([
    entry({ role: "user", content: "把构建脚本改成并行" }, "1"),
    entry({ role: "assistant", content: [
      { type: "thinking", thinking: "SECRET REASONING" },
      { type: "text", text: "好的，我来看一下 package.json" },
      { type: "toolCall", id: "t", name: "read", arguments: { path: "package.json" } },
    ] }, "2"),
    entry({ role: "toolResult", toolName: "read", content: [{ type: "text", text: "x".repeat(20_000) }] }, "3"),
    { type: "label", id: "4", parentId: null, timestamp: "", label: "ignored" } as unknown as SessionEntry,
  ]);
  assert.equal(rendered.userMessages, 1);
  assert.equal(rendered.assistantMessages, 1);
  assert.ok(!rendered.text.includes("SECRET REASONING"));
  assert.match(rendered.text, /\[user\] 把构建脚本改成并行/);
  assert.match(rendered.text, /\[tool call\] read \{"path":"package.json"\}/);
  assert.ok(rendered.text.length < 9_000, "a tool result is clipped hard");
});

test("a long conversation keeps its start and its end", () => {
  const branch = Array.from({ length: 200 }, (_, index) => entry({ role: index % 2 ? "assistant" : "user", content: `message ${index} ${"y".repeat(500)}` }, String(index)));
  const rendered = renderRollout(branch, 10_000);
  assert.equal(rendered.truncated, true);
  assert.ok(rendered.text.length <= 10_000);
  assert.match(rendered.text, /message 0 /);
  assert.match(rendered.text, /message 199 /);
  assert.match(rendered.text, /\[\.\.\. response items omitted \.\.\.\]/);
});

test("a one-line exchange is not worth a model call", () => {
  assert.equal(hasSubstance(renderRollout([entry({ role: "user", content: "hi" }), entry({ role: "assistant", content: "hello" })])), false);
  assert.equal(hasSubstance(renderRollout([entry({ role: "user", content: "a".repeat(300) })])), false);
  assert.equal(hasSubstance(renderRollout([entry({ role: "user", content: "a".repeat(150) }), entry({ role: "assistant", content: "b".repeat(150) })])), true);
});
