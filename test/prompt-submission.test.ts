import assert from "node:assert/strict";
import test from "node:test";
import { submitPrompt } from "../src/main/engine/prompt-submission.ts";
import type { ConversationQueueState } from "../src/shared/types.ts";

function host(options?: { behavior?: string; fail?: boolean }) {
  let preview = { title: "old", preview: "before" };
  const calls: unknown[] = [];
  return {
    calls,
    get current() { return preview; },
    preview: (id: string) => id === "chat" ? preview : undefined,
    record: (id: string, text: string) => { calls.push(["record", id, text]); preview = { title: "new", preview: text }; },
    restore: (_id: string, before: { title: string; preview?: string }, expected: { title: string; preview?: string }) => {
      calls.push(["restore"]);
      if (preview.title === expected.title && preview.preview === expected.preview) preview = { title: before.title, preview: before.preview ?? "" };
    },
    behavior: () => options?.behavior,
    prompt: async (input: unknown) => { calls.push(["prompt", input]); if (options?.fail) throw new Error("refused"); },
    enqueue: async (input: unknown, behavior: unknown, recorded: unknown) => {
      calls.push(["enqueue", input, behavior, recorded]); if (options?.fail) throw new Error("disk full");
      return { conversationId: "chat", revision: 1, pause: null, items: [] } as ConversationQueueState;
    },
  };
}

test("one server submission records the preview and admits exactly one direct prompt", async () => {
  const engine = host();
  const input = { conversationId: "chat", text: "hello", enqueue: false, images: [{ type: "image" as const, data: "abc", mimeType: "image/jpeg" }] };
  assert.equal(await submitPrompt(engine, input), null);
  assert.deepEqual(engine.calls, [["record", "chat", "hello"], ["prompt", input]]);
});

test("queued submission uses current host settings and keeps conditional rollback data", async () => {
  const engine = host({ behavior: "steer" });
  const input = { conversationId: "chat", text: "hello", enqueue: true };
  await submitPrompt(engine, input);
  assert.deepEqual(engine.calls[1], ["enqueue", input, "steer", {
    previousTitle: "old", previousPreview: "before", nextTitle: "new", nextPreview: "hello",
  }]);
  const compact = host({ behavior: "steer" });
  await submitPrompt(compact, { ...input, text: "/compact" });
  assert.equal((compact.calls[1] as unknown[])[2], "followUp");
});

test("refused admission restores its preview, and never touches another conversation", async () => {
  const engine = host({ fail: true });
  await assert.rejects(submitPrompt(engine, { conversationId: "chat", text: "next", enqueue: true }), /disk full/);
  assert.deepEqual(engine.current, { title: "old", preview: "before" });
  const other = host();
  await assert.rejects(submitPrompt(other, { conversationId: "missing", text: "next", enqueue: false }), /not found/);
  assert.deepEqual(other.calls, []);
});

test("a late refusal cannot overwrite a preview from a newer submission", async () => {
  const engine = host();
  await assert.rejects(submitPrompt({ ...engine, prompt: async () => {
    engine.record("chat", "newer");
    throw new Error("late refusal");
  } }, { conversationId: "chat", text: "first", enqueue: false }), /late refusal/);
  assert.equal(engine.current.preview, "newer");
});
