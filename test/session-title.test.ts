import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createAgentSession,
  DefaultResourceLoader,
  ModelRuntime,
  SessionManager,
  SettingsManager,
  type AgentSession,
} from "@earendil-works/pi-coding-agent";
import { createFauxCore, fauxAssistantMessage, InMemoryModelsStore, type AssistantMessage } from "@earendil-works/pi-ai";
import sessionTitle from "../resources/extensions/session-title.ts";
import { installThinkingOffGuard } from "../src/main/engine/thinking-off.ts";

/**
 * The title call is fire-and-forget and sits outside the agent loop, so nothing
 * in the SDK retries it — the extension has to. These run the real SDK against a
 * scripted provider to pin what it does with a transient failure, a deterministic
 * one, an unusable answer, and a stopped run.
 */

type Context = { messages: Array<{ content: unknown }> };

/** A title request is told apart from the agent's own by the instructions it carries. */
function isTitleRequest(context: Context): boolean {
  return JSON.stringify(context.messages).includes("You name chat sessions");
}

function errorReply(message: string): AssistantMessage {
  return fauxAssistantMessage("", { stopReason: "error", errorMessage: message });
}

async function harness(options: {
  /** The reply for a title request, by 1-indexed title attempt. */
  title: (attempt: number) => AssistantMessage;
  retry?: Record<string, unknown>;
  /** Chat requests are made on a reasoning model over this api, the way a gpt-5 chat is. */
  api?: string;
  /** The endpoint answers a request that carries pi's invented thinking-off parameter with a 400. */
  refusesThinkingOff?: boolean;
  /** Install FastVibe's guard on the runtime, as `PiProcessManager` does on start-up. */
  guard?: boolean;
  /**
   * What the host's `ctx.ui.lightModel()` answers — 轻量模型 (设置 → 模型), the same bridge
   * `PiProcessManager.#extensionUi` injects for a real session.
   */
  lightModel?: { provider: string; id: string };
  /** The model the conversation itself is on (default: the chat's only model, `scripted`). */
  chatModel?: string;
}): Promise<{ session: AgentSession; titleCalls: () => number; titleModels: () => string[]; chatModels: () => string[]; close: () => void }> {
  const dir = mkdtempSync(join(tmpdir(), "session-title-"));
  const faux = createFauxCore({
    api: options.api ?? "faux-api",
    provider: "faux",
    models: [{ id: "scripted", reasoning: options.api !== undefined }, { id: "cheap", reasoning: false }],
  });
  let titleCalls = 0;
  const titleModels: string[] = [];
  const chatModels: string[] = [];
  // A factory per call: which request it is decides the reply, so the test does not
  // depend on whether the title call or the agent's own request reaches the provider first.
  faux.setResponses(
    Array.from(
      { length: 8 },
      () =>
      (context: Context, _request: unknown, _state: unknown, model: { id?: string; reasoning?: boolean; thinkingLevelMap?: Record<string, string | null> }) => {
        if (!isTitleRequest(context)) {
          // The pin must not move the conversation itself — only the side job.
          chatModels.push(model.id ?? "");
          return fauxAssistantMessage("done");
        }
        titleCalls += 1;
        titleModels.push(model.id ?? "");
        if (options.refusesThinkingOff && model.reasoning && model.thinkingLevelMap?.off !== null) return errorReply(THINKING_OFF_REFUSAL);
        return options.title(titleCalls);
      },
    ),
  );
  const runtime = await ModelRuntime.create({
    credentials: undefined,
    authPath: join(dir, "auth.json"),
    modelsPath: null,
    modelsStore: new InMemoryModelsStore(),
    allowModelNetwork: false,
    refreshOnCreate: false,
  });
  runtime.registerProvider("faux", {
    baseUrl: "http://faux.invalid",
    api: (options.api ?? "faux-api") as never,
    apiKey: "unused",
    streamSimple: faux.streamSimple as never,
    models: [
      {
        id: "scripted",
        name: "scripted",
        reasoning: options.api !== undefined,
        input: ["text"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 100_000,
        maxTokens: 4096,
      },
      {
        // The 轻量模型 of this test install: a second model on the same provider, so it is
        // authenticated the same way and only the choice can differ.
        id: "cheap",
        name: "cheap",
        reasoning: false,
        input: ["text"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 100_000,
        maxTokens: 4096,
      },
    ],
  });

  if (options.guard) installThinkingOffGuard(runtime, new Set<string>());

  const cwd = join(dir, "project");
  const agentDir = join(dir, "agent");
  const settingsManager = SettingsManager.inMemory({ retry: { baseDelayMs: 1, ...options.retry } });
  const resourceLoader = new DefaultResourceLoader({
    cwd,
    agentDir,
    settingsManager,
    extensionFactories: [{ name: "fastvibe-session-title", hidden: true, factory: sessionTitle }],
  });
  await resourceLoader.reload();
  const { session } = await createAgentSession({
    cwd,
    agentDir,
    modelRuntime: runtime,
    model: runtime.getModel("faux", options.chatModel ?? "scripted"),
    sessionManager: SessionManager.inMemory(),
    settingsManager,
    resourceLoader,
  });
  await session.bindExtensions({
    mode: "rpc",
    // The host's bridge. `#extensionUi` in `src/main/pi/process-manager.ts` carries
    // `lightModel`; a host without it leaves the title on the conversation's own model.
    uiContext: { lightModel: () => options.lightModel } as never,
  });
  return { session, titleCalls: () => titleCalls, titleModels: () => titleModels, chatModels: () => chatModels, close: () => session.dispose() };
}

const PROMPT = "帮我修复登录流程里那个偶发的重定向问题";

/** What a gpt-5 endpoint answers `reasoning: { effort: "none" }` with. */
const THINKING_OFF_REFUSAL = "Invalid value for 'reasoning.effort': 'none' is not supported by this model. Try using one of: minimal, low, medium, high";

async function waitFor(check: () => boolean, timeoutMs = 3000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (check()) return true;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  return check();
}

/** Give the extension a moment to make any further attempt it intends to make. */
async function settle(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 60));
}

test("a transient provider failure is retried and the chat still gets a title", async () => {
  const h = await harness({
    title: (attempt) => (attempt === 1 ? errorReply("502 Bad Gateway") : fauxAssistantMessage("修复登录流程")),
  });
  try {
    await h.session.prompt(PROMPT);
    assert.equal(await waitFor(() => h.session.sessionName === "修复登录流程"), true, "the retried title landed");
    assert.equal(h.titleCalls(), 2, "the transient failure was retried exactly once");
  } finally {
    h.close();
  }
});

test("a deterministic failure is not retried", async () => {
  const h = await harness({
    title: () => errorReply("insufficient_quota: your account is out of budget"),
  });
  try {
    await h.session.prompt(PROMPT);
    await settle();
    assert.equal(h.titleCalls(), 1, "quota exhaustion fails the same way however often it is sent");
    assert.equal(h.session.sessionName, undefined, "the host's fallback title stands");
  } finally {
    h.close();
  }
});

test("the retry budget is the engine's, and it stops there", async () => {
  const h = await harness({ retry: { maxRetries: 2 }, title: () => errorReply("503 Service Unavailable") });
  try {
    await h.session.prompt(PROMPT);
    assert.equal(await waitFor(() => h.titleCalls() >= 3), true);
    await settle();
    assert.equal(h.titleCalls(), 3, "two retries on top of the first attempt");
    assert.equal(h.session.sessionName, undefined);
  } finally {
    h.close();
  }
});

test("retry disabled in settings means a single attempt", async () => {
  const h = await harness({ retry: { enabled: false }, title: () => errorReply("502 Bad Gateway") });
  try {
    await h.session.prompt(PROMPT);
    await settle();
    assert.equal(h.titleCalls(), 1, "the engine's retry switch governs this call too");
  } finally {
    h.close();
  }
});

test("a reply that is not a title is retried, and the second answer wins", async () => {
  const h = await harness({
    title: (attempt) =>
      attempt === 1
        ? // The model ignored the instruction and answered with a sentence.
          fauxAssistantMessage("We need to fix the login redirect loop, so let me look at the auth flow first")
        : fauxAssistantMessage("登录重定向"),
  });
  try {
    await h.session.prompt(PROMPT);
    assert.equal(await waitFor(() => h.session.sessionName === "登录重定向"), true);
    assert.equal(h.titleCalls(), 2);
  } finally {
    h.close();
  }
});

test("stopping the run ends the retry instead of hammering the provider", async () => {
  const h = await harness({
    // Long enough to abort while the first retry is waiting out its backoff.
    retry: { baseDelayMs: 400 },
    title: () => errorReply("502 Bad Gateway"),
  });
  try {
    await h.session.prompt(PROMPT);
    assert.equal(await waitFor(() => h.titleCalls() >= 1), true);
    h.session.abort();
    await settle();
    assert.equal(h.titleCalls(), 1, "the abort interrupted the backoff, not the next attempt");
  } finally {
    h.close();
  }
});

test("a truncated reply is treated as a failure, not clipped into a title", async () => {
  const h = await harness({
    retry: { maxRetries: 1 },
    title: () => fauxAssistantMessage("修复登录重定向", { stopReason: "length" }),
  });
  try {
    await h.session.prompt(PROMPT);
    await settle();
    assert.equal(h.titleCalls(), 2, "a cut-off reply is worth one more attempt");
    assert.equal(h.session.sessionName, undefined);
  } finally {
    h.close();
  }
});

test("a chat on a model whose endpoint refuses pi's thinking-off parameter still gets a title", async () => {
  // The title request asks for no thinking, and pi answers that with `reasoning: {effort:"none"}`
  // — a 400 on the reasoning models before gpt-5.1. The guard lives on the runtime, which is where
  // the extension's own `ctx.modelRegistry` and Main's requests meet, so nothing may throw and the
  // chat still names itself: the second attempt is made with the parameter left out.
  const h = await harness({
    api: "openai-responses",
    refusesThinkingOff: true,
    guard: true,
    title: () => fauxAssistantMessage("修复登录重定向"),
  });
  try {
    await h.session.prompt(PROMPT);
    assert.equal(await waitFor(() => h.session.sessionName === "修复登录重定向"), true);
    assert.equal(h.titleCalls(), 2, "refused once, then asked again without the field");
  } finally {
    h.close();
  }
});

test("a pinned 轻量模型 names the chat; the conversation stays on its own model", async () => {
  // The whole point of the setting: four side jobs (title, commit subject, the
  // next-message guess, memory extraction) that need little of a model's window. Moving
  // them must not move the chat the user is actually reading.
  const h = await harness({
    lightModel: { provider: "faux", id: "cheap" },
    title: () => fauxAssistantMessage("修复登录重定向"),
  });
  try {
    await h.session.prompt(PROMPT);
    assert.equal(await waitFor(() => h.session.sessionName === "修复登录重定向"), true);
    assert.deepEqual(h.titleModels(), ["cheap"], "the title ran on the pin");
    assert.deepEqual(h.chatModels(), ["scripted"], "the reply did not");
  } finally {
    h.close();
  }
});

test("a pin this install cannot resolve leaves the title on the conversation's model", async () => {
  // Provider deleted, or 同步模型 dropped the model: 轻量模型 is a preference, not a hard
  // requirement, and a chat without a name is the worse outcome.
  const h = await harness({
    lightModel: { provider: "faux", id: "gone" },
    title: () => fauxAssistantMessage("修复登录重定向"),
  });
  try {
    await h.session.prompt(PROMPT);
    assert.equal(await waitFor(() => h.session.sessionName === "修复登录重定向"), true);
    assert.deepEqual(h.titleModels(), ["scripted"], "the conversation's own model answered instead");
  } finally {
    h.close();
  }
});
