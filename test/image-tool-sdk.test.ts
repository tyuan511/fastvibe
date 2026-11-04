import type { ImageConfig, ImageTask } from "../src/shared/image-generation.ts";
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createAgentSession, DefaultResourceLoader, ModelRuntime, SessionManager, SettingsManager } from "@earendil-works/pi-coding-agent";
import { createFauxCore, fauxAssistantMessage, fauxToolCall, InMemoryModelsStore } from "@earendil-works/pi-ai";
import { ImageGenerationService } from "../src/main/images/service.ts";
import { availableImageTools, imageGenerationExtension } from "../src/main/engine/image-generation-tool.ts";
import { closeDatabases } from "../src/main/engine/db.ts";
import type { FastVibePaths } from "../src/main/engine/paths.ts";
import { collectInlinePreviews } from "../src/shared/inline-media.ts";
import type { ToolCallBlock } from "../src/shared/types.ts";

const PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";

test("real SDK: default image tool survives reload, preserves role restrictions and exposes saved previews", async () => {
  const root = mkdtempSync(join(tmpdir(), "image-agent-sdk-"));
  const cwd = join(root, "workspace");
  mkdirSync(cwd);
  const paths = { userData: root, runtimeRoot: join(root, "runtime"), databaseFile: join(root, "data.db") } as FastVibePaths;
  let fetchCalls = 0;
  const configured: ImageConfig = {
    defaultModelId: "image-provider/gpt-image-test",
    models: [{ id: "image-provider/gpt-image-test", providerId: "image-provider", name: "Image test", model: "gpt-image-test", protocol: "openai", baseUrl: "https://example.invalid/v1", enabled: true, hasKey: true }],
  };
  let config: ImageConfig = { models: [] };
  let failImage = false;
  let holdImage = false;
  const service = new ImageGenerationService({
    paths,
    getConfig: async () => structuredClone(config),
    resolveProviderKey: async (providerId) => {
      assert.equal(providerId, "image-provider");
      return "private-image-key";
    },
    fetch: async (_input, init) => {
      fetchCalls++;
      if (holdImage) return new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(init.signal?.reason), { once: true });
      });
      if (failImage && fetchCalls % 2 === 0) return Response.json({ error: { message: "limited" } }, { status: 429 });
      return Response.json({ data: [{ b64_json: PNG }] });
    },
  });
  const faux = createFauxCore({ api: "faux-api", provider: "faux", models: [{ id: "scripted" }] });
  const runtime = await ModelRuntime.create({ authPath: join(root, "auth.json"), modelsPath: null, modelsStore: new InMemoryModelsStore(), allowModelNetwork: false, refreshOnCreate: false });
  runtime.registerProvider("faux", { baseUrl: "http://faux.invalid", api: "faux-api" as never, apiKey: "unused", streamSimple: faux.streamSimple as never, models: [{ id: "scripted", name: "scripted", reasoning: false, input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 100000, maxTokens: 1024 }] });
  const make = async (tools?: string[]) => {
    const settingsManager = SettingsManager.inMemory();
    const resourceLoader = new DefaultResourceLoader({ cwd, agentDir: join(root, "agent"), settingsManager, noExtensions: true, noSkills: true, noThemes: true, noPromptTemplates: true, extensionFactories: [{ name: "fastvibe-image-generation", hidden: true, factory: imageGenerationExtension(service, "source-chat") }] });
    await resourceLoader.reload();
    const hasImageTool = resourceLoader.getExtensions().extensions.some((extension) => extension.tools.has("generate_image"));
    const selectedTools = tools ? availableImageTools(tools, hasImageTool) : undefined;
    const { session } = await createAgentSession({ cwd, agentDir: join(root, "agent"), modelRuntime: runtime, model: runtime.getModel("faux", "scripted"), settingsManager, sessionManager: SessionManager.inMemory(cwd), resourceLoader, ...(selectedTools ? { tools: selectedTools } : {}) });
    await session.bindExtensions({ mode: "rpc" });
    return session;
  };
  const sessions: Awaited<ReturnType<typeof make>>[] = [];
  try {
    const normal = await make(); sessions.push(normal);
    for (const unavailable of [{ models: [] }, { models: [{ ...configured.models[0], hasKey: false }] }, { models: [{ ...configured.models[0], enabled: false }] }]) {
      config = unavailable;
      await normal.reload();
      assert.ok(!normal.getActiveToolNames().includes("generate_image"));
      assert.ok(!normal.getAllTools().some((tool) => tool.name === "generate_image"));
      const loaderFactory = imageGenerationExtension(service, "source-chat");
      let registered = false;
      await loaderFactory({ registerTool: () => { registered = true; } } as never);
      assert.equal(registered, false, "no config, no key (including OAuth-only), or disabled must omit schema entirely");
    }
    const absentWorker = await make(["read", "generate_image"]); sessions.push(absentWorker);
    assert.ok(!absentWorker.getActiveToolNames().includes("generate_image"));
    config = structuredClone(configured);
    await normal.reload();
    assert.ok(normal.getActiveToolNames().includes("generate_image"));
    await normal.reload();
    assert.ok(normal.getActiveToolNames().includes("generate_image"));
    const worker = await make(["read", "generate_image"]); sessions.push(worker);
    assert.ok(worker.getActiveToolNames().includes("generate_image"));
    const explorer = await make(["read"]); sessions.push(explorer);
    assert.ok(!explorer.getActiveToolNames().includes("generate_image"));
    faux.setResponses([fauxAssistantMessage([fauxToolCall("generate_image", { prompt: "Create a quiet landscape" }, { id: "image-call" })]), fauxAssistantMessage("Saved the image.")]);
    await normal.prompt("Make a picture");
    const result = normal.messages.find((message) => message.role === "toolResult" && message.toolName === "generate_image");
    assert.ok(result && result.role === "toolResult");
    assert.equal(result.isError, false);
    assert.ok(!JSON.stringify(result).includes(PNG));
    assert.ok(!JSON.stringify(result).includes("private-image-key"));
    const details = result.details as { items: Array<{ ref: string }> };
    assert.equal(details.items.length, 1);
    const previews = collectInlinePreviews([{ id: "image-call", name: "generate_image", status: "done", details } as ToolCallBlock]);
    assert.equal(previews.get("image-call")?.[0].ref, details.items[0].ref);
    const snapshot = await service.snapshot();
    assert.equal(snapshot.sessions[0].sourceConversationId, "source-chat");
    const history = await service.snapshot(snapshot.sessions[0].id);
    assert.equal(history.tasks[0].status, "succeeded");
    assert.equal(fetchCalls, 1);

    faux.setResponses([
      fauxAssistantMessage([fauxToolCall("generate_image", { prompt: "Invalid references", reference_images: ["one.png", "two.png"] }, { id: "invalid-references" })]),
      fauxAssistantMessage("Only one reference image is allowed."),
    ]);
    await normal.prompt("Try two reference images");
    const rejected = normal.messages.find((message) => message.role === "toolResult" && message.toolCallId === "invalid-references");
    assert.ok(rejected && rejected.role === "toolResult");
    assert.equal(rejected.isError, true);
    assert.equal(fetchCalls, 1, "invalid tool arguments must not send a paid request");
    assert.equal((await service.snapshot(snapshot.sessions[0].id)).tasks.length, 1);

    faux.setResponses([
      fauxAssistantMessage([fauxToolCall("generate_image", { prompt: "Four quiet landscapes", count: 4 }, { id: "four-image-call" })]),
      fauxAssistantMessage("Saved four images."),
    ]);
    const progress: ImageTask[] = [];
    const stopProgress = normal.subscribe((event) => {
      if (event.type === "tool_execution_update" && event.toolCallId === "four-image-call") {
        const task = (event.partialResult.details as { task?: ImageTask })?.task;
        if (task) progress.push(task);
      }
    });
    await normal.prompt("Make four pictures");
    stopProgress();
    const four = normal.messages.find((message) => message.role === "toolResult" && message.toolCallId === "four-image-call");
    assert.ok(four && four.role === "toolResult");
    assert.equal(four.isError, false);
    assert.equal((four.details as { items: unknown[] }).items.length, 4);
    assert.equal(fetchCalls, 5);
    assert.ok([1, 2, 3, 4].every((count) => progress.some((task) => task.images.length === count)), "each saved image must immediately publish progress");
    assert.equal((four.details as { task: ImageTask }).task.status, "succeeded");
    assert.ok(!JSON.stringify(progress).includes(PNG));
    assert.ok(!JSON.stringify(progress).includes("private-image-key"));
    config = { models: configured.models };
    await normal.reload();
    faux.setResponses([fauxAssistantMessage([fauxToolCall("generate_image", { prompt: "No paid fallback" }, { id: "no-default" })]), fauxAssistantMessage("Choose a model.")]);
    await normal.prompt("Make an image without a default");
    assert.equal(fetchCalls, 5);
    const noDefault = normal.messages.find((message) => message.role === "toolResult" && message.toolCallId === "no-default");
    assert.ok(noDefault && noDefault.role === "toolResult" && noDefault.isError);
    config = structuredClone(configured);
    failImage = true;
    faux.setResponses([fauxAssistantMessage([fauxToolCall("generate_image", { prompt: "Partial", count: 2 }, { id: "partial-image" })]), fauxAssistantMessage("One image survived.")]);
    await normal.prompt("Partial result");
    const partial = normal.messages.find((message) => message.role === "toolResult" && message.toolCallId === "partial-image");
    assert.ok(partial && partial.role === "toolResult" && partial.isError);
    const partialTask = (partial.details as { task: ImageTask }).task;
    assert.equal(partialTask.status, "partial");
    assert.equal(partialTask.images.length, 1);
    assert.equal(partialTask.images[0].index, 1);
    await normal.reload();
    assert.equal((partial.details as { task: ImageTask }).task.images[0].path, partialTask.images[0].path);
    failImage = false;
    holdImage = true;
    const stopCancel = normal.subscribe((event) => {
      if (event.type === "tool_execution_update" && event.toolCallId === "cancel-image") {
        const task = (event.partialResult.details as { task?: ImageTask }).task;
        if (task?.status === "generating") void service.cancel(task.id);
      }
    });
    faux.setResponses([fauxAssistantMessage([fauxToolCall("generate_image", { prompt: "Cancel" }, { id: "cancel-image" })]), fauxAssistantMessage("Cancelled.")]);
    await normal.prompt("Cancel image");
    stopCancel();
    const cancelled = normal.messages.find((message) => message.role === "toolResult" && message.toolCallId === "cancel-image");
    assert.ok(cancelled && cancelled.role === "toolResult" && cancelled.isError);
    assert.equal((cancelled.details as { task: ImageTask }).task.status, "cancelled");
    config = { models: [{ ...configured.models[0], enabled: false }] };
    await normal.reload();
    assert.ok(!normal.getAllTools().some((tool) => tool.name === "generate_image"));
  } finally {
    for (const session of sessions) await session.dispose();
    await service.dispose();
    closeDatabases();
    rmSync(root, { recursive: true, force: true });
  }
});
