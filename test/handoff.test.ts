import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { Agent } from "@earendil-works/pi-agent-core";
import {
  AgentSession,
  DefaultResourceLoader,
  SessionManager,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";
import { clipHandoffTranscript, handoffEntries, handoffRequest } from "../resources/extensions/handoff.ts";
import { promptPreview } from "../src/main/engine/prompt-preview.ts";
import { parseHandoffCommand } from "../src/shared/slash.ts";
import { parsePermission } from "../src/renderer/src/stores/session-reducer.ts";
import type { EngineEvent } from "../src/shared/types.ts";

test("parseHandoffCommand takes the goal and nothing else", () => {
  assert.deepEqual(parseHandoffCommand("/handoff"), { goal: undefined });
  assert.deepEqual(parseHandoffCommand("  /Handoff   把修复用到别处  "), { goal: "把修复用到别处" });
  assert.equal(parseHandoffCommand("/handoff\n第二行")?.goal, "第二行");
  assert.equal(parseHandoffCommand("/handoffx"), null);
  assert.equal(parseHandoffCommand("/compact keep this"), null);
});

test("handoffEntries keep the compaction summary instead of the turns it replaced", () => {
  const branch = [
    { type: "message", id: "m1" },
    { type: "message", id: "m2" },
    { type: "compaction", id: "c1", firstKeptEntryId: "m2" },
    { type: "custom", id: "x" },
    { type: "message", id: "m3" },
  ];
  assert.deepEqual(handoffEntries(branch).map((entry) => entry.id), ["c1", "m2", "m3"]);
  assert.deepEqual(
    handoffEntries([{ type: "message", id: "m1" }, { type: "model_change", id: "mc" }]).map((entry) => entry.id),
    ["m1"],
  );
});

test("clipHandoffTranscript keeps the start and the end", () => {
  const text = `${"H".repeat(100)}${"T".repeat(100)}`;
  const clipped = clipHandoffTranscript(text, 80);
  assert.ok(clipped.startsWith("H"));
  assert.ok(clipped.endsWith("T"));
  assert.match(clipped, /characters omitted/);
  assert.ok(clipped.length <= 80);
  assert.equal(clipHandoffTranscript("short"), "short");
});

test("the editor dialog keeps the prefill it was given", () => {
  const parsed = parsePermission({
    type: "extension_ui_request",
    id: "e1",
    method: "editor",
    title: "编辑交接提示",
    prefill: "## Task\n接着做",
  } as EngineEvent);
  assert.equal(parsed?.prefill, "## Task\n接着做");
  assert.equal(parsed?.method, "editor");
});

const usage = { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };

function assistant(text: string) {
  return {
    role: "assistant" as const,
    content: [{ type: "text" as const, text }],
    provider: "fake",
    model: "m",
    timestamp: Date.now(),
    stopReason: "stop" as const,
    usage,
  };
}

async function runHandoff(options: {
  seed?: string;
  command: string;
  editor?: (prefill?: string) => string | undefined;
  input?: () => string | undefined;
}) {
  const dir = mkdtempSync(join(tmpdir(), "fastvibe-handoff-"));
  const notices: string[] = [];
  const statuses: string[] = [];
  let request = "";
  let editorTitle = "";
  let editorPrefill = "";
  /** Prompts the command sent into the new chat. Empty means nothing was sent. */
  const sent: string[] = [];
  const parents: Array<string | undefined> = [];
  const partial = assistant("登录校验少了空密码");
  const streamFn = () => ({
    async *[Symbol.asyncIterator]() {
      yield { type: "start", partial };
      yield { type: "done", reason: "stop", message: partial };
    },
    result: async () => partial,
  });
  const model = { provider: "fake", id: "m", name: "F", contextWindow: 100_000, maxTokens: 4096, input: ["text"], api: "openai-completions" };
  const agent = new Agent({
    initialState: { systemPrompt: "", model, thinkingLevel: "off", tools: [] },
    convertToLlm: (messages) => messages,
    streamFn,
  });
  const settingsManager = SettingsManager.create(dir, join(dir, "agent"));
  const sessionManager = SessionManager.create(dir, join(dir, "sessions"));
  const resourceLoader = new DefaultResourceLoader({
    cwd: dir,
    agentDir: join(dir, "agent"),
    settingsManager,
    additionalExtensionPaths: [new URL("../resources/extensions/handoff.ts", import.meta.url).pathname],
  });
  await resourceLoader.reload();
  const session = new AgentSession({
    agent: agent as never,
    sessionManager,
    settingsManager,
    cwd: dir,
    resourceLoader,
    modelRuntime: {
      hasConfiguredAuth: () => true,
      checkAuth: async () => ({}),
      isUsingOAuth: () => false,
      getAuth: async () => ({ auth: {} }),
      streamSimple: streamFn,
      complete: async (_model: unknown, context: { messages: Array<{ content?: string }> }) => {
        request = String(context.messages[0]?.content ?? "");
        return assistant("## Context\n登录校验少了空密码\n\n## Task\n把修复用到别处");
      },
    } as never,
    initialActiveToolNames: [],
  });
  await session.bindExtensions({
    mode: "rpc",
    uiContext: {
      setStatus: (key: string, text?: string) => {
        if (key === "handoff" && text) statuses.push(text);
      },
      notify: (message: string) => notices.push(message),
      select: async () => undefined,
      confirm: async () => false,
      input: async () => options.input?.(),
      editor: async (title: string, prefill?: string) => {
        editorTitle = title;
        editorPrefill = prefill ?? "";
        return options.editor ? options.editor(prefill) : prefill;
      },
      onTerminalInput: () => () => undefined,
      setWidget: () => undefined,
      setTitle: () => undefined,
      setEditorText: () => undefined,
      getEditorText: () => "",
      setFooter: () => undefined,
      setHeader: () => undefined,
    } as never,
    commandContextActions: {
      waitForIdle: async () => undefined,
      newSession: async (opts?: {
        parentSession?: string;
        withSession?: (ctx: {
          ui: { notify: (message: string) => void };
          sendUserMessage: (text: string) => Promise<void>;
        }) => Promise<void>;
      }) => {
        parents.push(opts?.parentSession);
        await opts?.withSession?.({
          ui: { notify: (message: string) => notices.push(message) },
          sendUserMessage: async (text: string) => {
            sent.push(text);
          },
        });
        return { cancelled: false };
      },
    } as never,
    onError: () => undefined,
  });
  if (options.seed) {
    await session.prompt(options.seed);
    await session.waitForIdle();
  }
  await session.prompt(options.command);
  return { request, notices, statuses, editorTitle, editorPrefill, sent, parents, sessionFile: sessionManager.getSessionFile() };
}

test("handoff sends the reviewed prompt into the new session", async () => {
  const result = await runHandoff({ seed: "看看登录失败", command: "/handoff 把修复用到别处" });
  assert.match(result.request, /看看登录失败/);
  assert.match(result.request, /<goal>\n把修复用到别处\n<\/goal>/);
  assert.equal(result.statuses[0], "正在生成交接摘要…");
  assert.match(result.editorPrefill, /## Task/);
  // Submitting the review is what sends it: no second press in the composer.
  assert.deepEqual(result.sent, [result.editorPrefill]);
  assert.equal(result.parents[0], result.sessionFile);
  assert.equal(result.notices.some((notice) => notice.includes("没有可以交接")), false);
});

test("cancelling the review does not open a session", async () => {
  const result = await runHandoff({
    seed: "看看登录失败",
    command: "/handoff 把修复用到别处",
    editor: () => undefined,
  });
  assert.deepEqual(result.parents, []);
  assert.deepEqual(result.sent, []);
  assert.equal(result.notices.at(-1), "已取消");
});

test("an empty chat is not handed off", async () => {
  const result = await runHandoff({ command: "/handoff 继续" });
  assert.equal(result.request, "");
  assert.equal(result.notices.at(-1), "没有可以交接的对话");
  assert.deepEqual(result.parents, []);
  assert.deepEqual(result.sent, []);
});

test("a bare /handoff asks for the goal", async () => {
  const result = await runHandoff({
    seed: "看看登录失败",
    command: "/handoff",
    input: () => "补上测试",
  });
  assert.match(result.request, /<goal>\n补上测试\n<\/goal>/);
  assert.equal(result.sent.length, 1);
});

test("handoffRequest keeps the transcript and the goal apart", () => {
  assert.equal(handoffRequest("历史", "下一步"), "<conversation>\n历史\n</conversation>\n\n<goal>\n下一步\n</goal>");
});

test("a prompt from Main gets the same sidebar row as a composer send", () => {
  // The first prompt names and previews an unnamed chat, exactly as `recordPrompt` does.
  assert.deepEqual(promptPreview({ title: "新会话" }, "  把修复用到别处 "), {
    title: "把修复用到别处",
    preview: "把修复用到别处",
  });
  // A name the user set by hand survives, and so does one session-title generated.
  assert.equal(promptPreview({ title: "登录", titleManual: true }, "x").title, "登录");
  assert.equal(promptPreview({ title: "登录校验" }, "x").title, "登录校验");
  // The default title of an English interface is a placeholder too, not a name.
  assert.equal(promptPreview({ title: "New chat" }, "fix the login").title, "fix the login");
  assert.equal(promptPreview({}, "a".repeat(200)).preview.length, 80);
});
