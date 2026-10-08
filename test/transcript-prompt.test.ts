import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { readTranscriptPrompt, transcriptPrompt } from "../src/main/engine/transcript-file.ts";

const user = (text: unknown) => ({ type: "message", message: { role: "user", content: text } });

test("a transcript with no message entries is empty", () => {
  assert.deepEqual(transcriptPrompt([{ type: "session" }, { type: "model_change" }, { type: "session_info" }]), { hasMessages: false });
});

test("the first user text is the prompt, whatever wrote it", () => {
  // An extension's handoff seeds a system message before the user's.
  const seeded = [{ type: "message", message: { role: "system", content: "" } }, user([{ type: "text", text: "  多agent\n编排  " }])];
  assert.deepEqual(transcriptPrompt(seeded), { hasMessages: true, prompt: "多agent 编排" });
  assert.equal(transcriptPrompt([user("hello")]).prompt, "hello");
});

test("messages without user text still make the chat non-empty", () => {
  const found = transcriptPrompt([{ type: "message", message: { role: "assistant", content: [{ type: "text", text: "hi" }] } }]);
  assert.deepEqual(found, { hasMessages: true });
});

test("a file is read the same way, and a missing one is empty", () => {
  const dir = mkdtempSync(join(tmpdir(), "transcript-prompt-"));
  try {
    const file = join(dir, "s.jsonl");
    writeFileSync(file, [{ type: "session" }, user("from disk")].map((line) => JSON.stringify(line)).join("\n") + "\n{torn");
    assert.deepEqual(readTranscriptPrompt(file), { hasMessages: true, prompt: "from disk" });
    assert.deepEqual(readTranscriptPrompt(join(dir, "missing.jsonl")), { hasMessages: false });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
