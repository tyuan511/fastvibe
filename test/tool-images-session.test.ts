import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Type } from "typebox";
import {
  createAgentSession,
  DefaultResourceLoader,
  ModelRuntime,
  SessionManager,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";
import { createFauxCore, fauxAssistantMessage, fauxToolCall, InMemoryModelsStore } from "@earendil-works/pi-ai";
import { toolImagesExtension } from "../src/main/engine/tool-images-extension.ts";
import { referenceStoredToolImages, ToolImageReader } from "../src/main/engine/tool-images.ts";
import { prepareTranscriptForOpen } from "../src/main/engine/transcript-file.ts";
import { openSessionFile } from "../src/main/engine/session-open.ts";
import { isToolImageRef, TOOL_IMAGE_REF_FIELD } from "../src/shared/tool-image-ref.ts";

/**
 * The real SDK, end to end, for a tool that returns a picture: what lands in the transcript on
 * disk, what the session keeps in memory, and what the provider is actually sent. A unit test of
 * the helpers cannot see the SDK's own steps between them — its persistence of a hooked result,
 * the normalization after the hook, the clone before the `context` hook.
 */

// A 1×1 PNG, so the SDK's own image normalization has something real to look at.
const PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";

type Sent = Array<{ role: string; content?: unknown }>;

async function harness(responses: Parameters<ReturnType<typeof createFauxCore>["setResponses"]>[0]) {
  const root = mkdtempSync(join(tmpdir(), "tool-images-session-"));
  const imagesDir = join(root, "tool-images");
  const faux = createFauxCore({ api: "faux-api", provider: "faux", models: [{ id: "scripted" }] });
  faux.setResponses(responses);
  const runtime = await ModelRuntime.create({
    credentials: undefined,
    authPath: join(root, "auth.json"),
    modelsPath: null,
    modelsStore: new InMemoryModelsStore(),
    allowModelNetwork: false,
    refreshOnCreate: false,
  });
  runtime.registerProvider("faux", {
    baseUrl: "http://faux.invalid",
    api: "faux-api" as never,
    apiKey: "unused",
    streamSimple: faux.streamSimple as never,
    models: [{ id: "scripted", name: "scripted", reasoning: false, input: ["text", "image"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 100_000, maxTokens: 4096 }],
  });
  const cwd = join(root, "project");
  const agentDir = join(root, "agent");
  const settingsManager = SettingsManager.inMemory();
  const open = async (sessionManager: SessionManager) => {
    const resourceLoader = new DefaultResourceLoader({
      cwd,
      agentDir,
      settingsManager,
      extensionFactories: [
        {
          name: "snapshot-tool",
          hidden: true,
          factory: (pi) => {
            pi.registerTool({
              name: "snap",
              label: "Snap",
              description: "Take a screenshot",
              parameters: Type.Object({}),
              execute: async () => ({ content: [{ type: "text", text: "captured" }, { type: "image", data: PNG, mimeType: "image/png" }], details: {} }),
            });
          },
        },
        {
          name: "fastvibe-tool-images",
          hidden: true,
          factory: toolImagesExtension({ dir: imagesDir, conversationId: "conv", resize: async () => null, reader: new ToolImageReader() }),
        },
      ],
    });
    await resourceLoader.reload();
    const { session } = await createAgentSession({
      cwd,
      agentDir,
      modelRuntime: runtime,
      model: runtime.getModel("faux", "scripted"),
      sessionManager,
      settingsManager,
      resourceLoader,
    });
    await session.bindExtensions({ mode: "rpc" });
    return session;
  };
  return { root, imagesDir, cwd, open, sessionDir: join(root, "sessions") };
}

/** A response that records what the provider was sent, then answers. */
function capture(into: Sent[], text: string) {
  return (context: { messages: unknown[] }) => {
    into.push(structuredClone(context.messages) as Sent);
    return fauxAssistantMessage(text);
  };
}

function sentImages(messages: Sent): string[] {
  return messages.flatMap((message) =>
    message.role === "toolResult" && Array.isArray(message.content)
      ? (message.content as Array<Record<string, unknown>>).flatMap((block) => (block.type === "image" ? [String(block.data)] : []))
      : [],
  );
}

test("a tool's picture is kept on disk by reference, and the model is still sent the picture", async () => {
  const sent: Sent[] = [];
  const h = await harness([fauxAssistantMessage([fauxToolCall("snap", {}, { id: "call-1" })]), capture(sent, "done")]);
  const session = await h.open(SessionManager.create(h.cwd, h.sessionDir));
  try {
    await session.prompt("take one");
    // The request after the tool carried the picture itself.
    assert.deepEqual(sentImages(sent[0]), [PNG]);
    // The session's memory and the file hold a reference, not the bytes.
    const result = session.messages.find((message) => message.role === "toolResult") as { content: unknown[] };
    assert.ok(result.content.some(isToolImageRef));
    assert.ok(!result.content.some((block) => (block as { type?: unknown }).type === "image"));
    const file = session.sessionFile!;
    const raw = readFileSync(file, "utf8");
    assert.equal(raw.includes(PNG), false);
    assert.equal(raw.includes(TOOL_IMAGE_REF_FIELD), true);
    assert.equal(readFileSync(join(h.imagesDir, "conv", "model", "call-1-0.png"), "base64"), PNG);
  } finally {
    session.dispose();
  }
});

test("a reopened chat sends its referenced picture again", async () => {
  const first: Sent[] = [];
  const second: Sent[] = [];
  const h = await harness([fauxAssistantMessage([fauxToolCall("snap", {}, { id: "call-1" })]), capture(first, "done"), capture(second, "again")]);
  const session = await h.open(SessionManager.create(h.cwd, h.sessionDir));
  await session.prompt("take one");
  const file = session.sessionFile!;
  session.dispose();

  const prepared = prepareTranscriptForOpen(file, (tool) => tool);
  const reopened = await h.open(openSessionFile(file, h.cwd, prepared?.entries));
  try {
    await reopened.prompt("look again");
    assert.deepEqual(sentImages(second[0]), [PNG]);
  } finally {
    reopened.dispose();
  }
});

test("a transcript written before references existed is lightened as it opens", async () => {
  const h = await harness([capture([], "ok")]);
  // The old shape: the picture's base64 inline in the stored tool result.
  const manager = SessionManager.create(h.cwd, h.sessionDir);
  manager.appendMessage({ role: "user", content: "take one", timestamp: 1 });
  manager.appendMessage({ role: "assistant", content: [{ type: "toolCall", id: "old-1", name: "snap", arguments: {} }], api: "faux-api", provider: "faux", model: "scripted", usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }, stopReason: "toolUse", timestamp: 2 } as never);
  manager.appendMessage({ role: "toolResult", toolCallId: "old-1", toolName: "snap", content: [{ type: "image", data: PNG, mimeType: "image/png" }], isError: false, timestamp: 3 } as never);
  manager.appendMessage({ role: "assistant", content: [{ type: "text", text: "seen" }], api: "faux-api", provider: "faux", model: "scripted", usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }, stopReason: "stop", timestamp: 4 } as never);
  const file = manager.getSessionFile()!;
  const before = readFileSync(file, "utf8");
  assert.ok(before.includes(PNG));

  const sent: Sent[] = [];
  const h2 = await harness([capture(sent, "ok")]);
  const prepared = prepareTranscriptForOpen(file, (tool) => tool);
  const opened = openSessionFile(file, h.cwd, prepared?.entries);
  assert.equal(referenceStoredToolImages(opened.getEntries(), h2.imagesDir, "conv"), 1);
  const session = await h2.open(opened);
  try {
    const result = session.messages.find((message) => message.role === "toolResult") as { content: unknown[] };
    assert.ok(result.content.every(isToolImageRef));
    await session.prompt("again");
    assert.deepEqual(sentImages(sent[0]), [PNG]);
    // The file on disk was only appended to: the old lines are as they were.
    assert.ok(readFileSync(file, "utf8").startsWith(before));
    assert.ok(existsSync(join(h2.imagesDir, "conv", "model", "old-1-0.png")));
  } finally {
    session.dispose();
  }
});
