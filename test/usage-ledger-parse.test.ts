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

test("a parse survives a restart in the cache file and is redone only for a file that changed", async () => {
  const { readFile, stat, utimes } = await import("node:fs/promises");
  const { clearSessionUsageCache, settleParseCache, usePersistentParseCache } = await import("../src/main/engine/usage-ledger.ts");
  const dir = await mkdtemp(join(tmpdir(), "usage-cache-"));
  try {
    const file = join(dir, "s.jsonl");
    const cache = join(dir, "cache.json");
    const turn = (id: string, parent: string | null) => ({ type: "message", id, parentId: parent, timestamp, message: { role: "assistant", content: [{ type: "text", text: "x" }], provider: "p", model: "m", usage, stopReason: "stop", timestamp: 2 } });
    await writeFile(file, `${[{ type: "session", version: 3, id: "s1", timestamp, cwd: dir }, turn("a1", null)].map((line) => JSON.stringify(line)).join("\n")}\n`);
    clearSessionUsageCache();
    usePersistentParseCache(cache);
    assert.equal((await parseSessionTurns(file)).turns.length, 1);
    await settleParseCache([file]);
    assert.equal(JSON.parse(await readFile(cache, "utf8")).files[file].turns.length, 1);

    // "Restart": no memo, a cache file that now disagrees with the transcript's content but
    // not its identity. Only a hit can return what the file says, so this proves no re-parse.
    const stored = JSON.parse(await readFile(cache, "utf8"));
    stored.files[file].turns[0].model = "from-cache";
    await writeFile(cache, JSON.stringify(stored));
    clearSessionUsageCache();
    usePersistentParseCache(cache);
    assert.equal((await parseSessionTurns(file)).turns[0].model, "from-cache");

    // The transcript grows: its size and mtime move, so it is parsed again.
    clearSessionUsageCache();
    usePersistentParseCache(cache);
    await writeFile(file, `${[{ type: "session", version: 3, id: "s1", timestamp, cwd: dir }, turn("a1", null), turn("a2", "a1")].map((line) => JSON.stringify(line)).join("\n")}\n`);
    const grown = await parseSessionTurns(file);
    assert.deepEqual(grown.turns.map((item) => [item.entryId, item.model]), [["a1", "m"], ["a2", "m"]]);

    // A transcript that is gone leaves the cache.
    await settleParseCache([]);
    assert.deepEqual(Object.keys(JSON.parse(await readFile(cache, "utf8")).files), []);
    void stat; void utimes;
  } finally {
    clearSessionUsageCache();
    await rm(dir, { recursive: true, force: true });
  }
});
