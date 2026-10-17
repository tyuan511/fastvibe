import assert from "node:assert/strict";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { searchConversationContent } from "../src/main/engine/conversation-search.ts";

function row(id: string, parentId: string | null, text: string, role = "assistant") {
  return JSON.stringify({ type: "message", id, parentId, message: { role, content: [{ type: "text", text }] } });
}
async function fixture(t: { after(fn: () => Promise<void>): void }) {
  const dir = await mkdtemp(join(tmpdir(), "fv-search-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const file = join(dir, "chat.jsonl");
  const conversation = { id: "chat", sessionFile: file, updatedAt: 1 };
  return { file, conversation };
}

test("large transcripts remain searchable, including beyond the cache budget", async (t) => {
  const { file, conversation } = await fixture(t);
  await writeFile(file, [row("u", null, "start", "user"), row("a", "u", "x".repeat(8_100_000)), row("b", "a", "searchable ending")].join("\n"));
  for (let i = 0; i < 2; i++) {
    const hits = await searchConversationContent("searchable", [conversation as never]);
    assert.equal(hits[0]?.entryId, "b");
    assert.match(hits[0]?.snippet ?? "", /searchable ending/);
  }
});

test("hidden client matches cannot consume a global twenty-hit quota", async (t) => {
  const { file, conversation } = await fixture(t);
  await writeFile(file, row("a", null, "matching body"));
  const chats = Array.from({ length: 25 }, (_, i) => ({ ...conversation, id: `chat-${i}` }));
  assert.equal((await searchConversationContent("matching", chats as never)).length, 25);
});

test("only the current branch is searched; tool results link to the owning reply", async (t) => {
  const { file, conversation } = await fixture(t);
  await writeFile(file, [row("u", null, "start", "user"), row("old", "u", "discarded answer"), row("new", "u", "new answer"), row("tool", "new", "important output", "toolResult")].join("\n"));
  assert.deepEqual(await searchConversationContent("discarded", [conversation as never]), []);
  assert.equal((await searchConversationContent("important", [conversation as never]))[0]?.entryId, "new");
  await writeFile(file, row("replacement", null, "rewritten answer"));
  assert.deepEqual(await searchConversationContent("important", [conversation as never]), []);
  assert.equal((await searchConversationContent("rewritten", [conversation as never]))[0]?.entryId, "replacement");
});

test("scanning a corpus larger than the cache does not evict every warm conversation", async (t) => {
  const fs = (await import("node:fs")).default;
  const { syncBuiltinESMExports } = await import("node:module");
  const dir = await mkdtemp(join(tmpdir(), "fv-search-working-set-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const chats = [];
  for (let i = 0; i < 3; i++) {
    const file = join(dir, `${i}.jsonl`);
    await writeFile(file, row(`a${i}`, null, `needleA needleB ${"x".repeat(3_000_000)}`));
    chats.push({ id: String(i), sessionFile: file, updatedAt: 3 - i });
  }
  const original = fs.createReadStream;
  let reads: string[] = [];
  const mocked = t.mock.method(fs, "createReadStream", (...args: Parameters<typeof original>) => {
    reads.push(String(args[0]));
    return original(...args);
  });
  syncBuiltinESMExports();
  t.after(() => { mocked.mock.restore(); syncBuiltinESMExports(); });
  assert.equal((await searchConversationContent("needleA", chats as never)).length, 3);
  assert.equal(reads.length, 3);
  reads = [];
  assert.equal((await searchConversationContent("needleB", chats as never)).length, 3);
  assert.deepEqual(reads, [chats[2].sessionFile]);
  reads = [];
  assert.equal((await searchConversationContent("absent", chats as never)).length, 0);
  assert.deepEqual(reads, [chats[2].sessionFile]);
  reads = [];
  assert.equal((await searchConversationContent("absent-longer", chats as never)).length, 0);
  assert.deepEqual(reads, []);
});
