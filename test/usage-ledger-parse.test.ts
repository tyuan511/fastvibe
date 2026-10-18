import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { clearSessionUsageCache, parseSessionTurns } from "../src/main/engine/usage-ledger.ts";

const timestamp = "2026-10-01T00:00:00.000Z";
const usage = { input: 10, output: 5, cacheRead: 0, cacheWrite: 0, totalTokens: 15, cost: { total: 0 } };

test("tool results and prompts are skipped by their envelope, never an assistant turn that quotes them", async () => {
  const dir = await mkdtemp(join(tmpdir(), "usage-parse-"));
  try {
    const file = join(dir, "s.jsonl");
    const lines = [
      { type: "session", version: 3, id: "s1", timestamp, cwd: dir },
      { type: "message", id: "u1", parentId: null, timestamp, message: { role: "user", content: "hi", timestamp: 1 } },
      // An assistant whose tool call arguments contain the very envelope words.
      { type: "message", id: "a1", parentId: "u1", timestamp, message: { role: "assistant", content: [{ type: "toolCall", id: "c1", name: "post", arguments: { message: { role: "toolResult" }, messages: [{ role: "user" }] } }], provider: "p", model: "m", usage, stopReason: "toolUse", timestamp: 2 } },
      { type: "message", id: "r1", parentId: "a1", timestamp, message: { role: "toolResult", toolCallId: "c1", toolName: "post", content: [{ type: "image", data: "x".repeat(600_000), mimeType: "image/png" }], isError: false, timestamp: 3 } },
      { type: "message", id: "a2", parentId: "r1", timestamp, message: { role: "assistant", content: [{ type: "text", text: "done" }], provider: "p", model: "m", usage, stopReason: "stop", timestamp: 4 } },
    ];
    await writeFile(file, `${lines.map((line) => JSON.stringify(line)).join("\n")}\n`);
    clearSessionUsageCache();
    const parsed = await parseSessionTurns(file);
    assert.equal(parsed.sessionId, "s1");
    assert.deepEqual(parsed.turns.map((turn) => turn.entryId), ["a1", "a2"]);
    assert.equal(parsed.turns[0].toolCalls, 1);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
