import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createAgentSession, createCodemodeExtension, DefaultResourceLoader, ModelRuntime,
  SessionManager, SettingsManager, type ExtensionAPI, type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { createFauxCore, fauxAssistantMessage, fauxToolCall, InMemoryModelsStore } from "@earendil-works/pi-ai";
import browserUse from "../resources/extensions/browser-use.ts";
import { checkBody, pageProgram } from "../src/shared/browser-page.ts";
import { runInNewContext } from "node:vm";
import { setTimeout as delay } from "node:timers/promises";

type Request = { action: string; tabId?: string; conversationId?: string; [key: string]: unknown };
const globals = globalThis as Record<string, unknown>;

async function harness(code: string, respond: (request: Request, signal?: AbortSignal) => unknown) {
  const dir = mkdtempSync(join(tmpdir(), "browser-script-"));
  const calls: Request[] = [];
  const previousBridge = globals.__fastvibeBrowserRequest;
  const previousId = globals.__fastvibeBrowserConversationId;
  globals.__fastvibeBrowserConversationId = "conversation-a";
  globals.__fastvibeBrowserRequest = async (request: Request, signal?: AbortSignal) => {
    calls.push(request);
    return respond(request, signal);
  };
  const faux = createFauxCore({ api: "faux-api", provider: "faux", models: [{ id: "scripted" }] });
  faux.setResponses([
    fauxAssistantMessage([fauxToolCall("codemode", { code }, { id: "batch" })]),
    fauxAssistantMessage("done"),
  ]);
  const runtime = await ModelRuntime.create({
    credentials: undefined, authPath: join(dir, "auth.json"), modelsPath: null,
    modelsStore: new InMemoryModelsStore(), allowModelNetwork: false, refreshOnCreate: false,
  });
  runtime.registerProvider("faux", {
    baseUrl: "http://faux.invalid", api: "faux-api" as never, apiKey: "unused", streamSimple: faux.streamSimple as never,
    models: [{ id: "scripted", name: "scripted", reasoning: false, input: ["text"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 100_000, maxTokens: 4096 }],
  });
  const settingsManager = SettingsManager.inMemory();
  const resourceLoader = new DefaultResourceLoader({
    cwd: dir, agentDir: dir, settingsManager,
    extensionFactories: [browserUse, createCodemodeExtension(), (pi) => {
      pi.on("session_start", () => pi.setActiveTools([...pi.getActiveTools(), "codemode"]));
    }],
  });
  await resourceLoader.reload();
  const { session } = await createAgentSession({
    cwd: dir, agentDir: dir, modelRuntime: runtime, model: runtime.getModel("faux", "scripted"),
    sessionManager: SessionManager.inMemory(), settingsManager, resourceLoader,
  });
  await session.bindExtensions({ mode: "rpc" });
  return {
    calls, session,
    async run() {
      await session.prompt("Use one script to finish the browser task");
      const result = session.messages.find((m: any) => m.role === "toolResult" && m.toolName === "codemode") as any;
      return { result, text: result.content.map((p: any) => p.text ?? "").join(""), details: result.details };
    },
    close() {
      session.dispose();
      globals.__fastvibeBrowserRequest = previousBridge;
      globals.__fastvibeBrowserConversationId = previousId;
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

function snapshot(text = "Email form") {
  return { tabId: "tab-a", url: "https://example.com/form", title: "Form", text, elementCount: 2, truncated: false,
    elements: [
      { ref: "e0", selector: "#email", tag: "input", name: "email", text: "Email" },
      { ref: "e1", selector: "#save", tag: "button", text: "Save" },
    ],
  };
}

test("one codemode script uses structured browser results, waits, branches and returns only the answer", async () => {
  let polls = 0;
  const h = await harness(`
    const opened = await tools.browser_open({ url: 'https://example.com/form' });
    const page = await tools.browser_snapshot({ tabId: opened.tabId });
    const field = page.elements.find(e => e.name === 'email');
    const save = page.elements.find(e => e.text === 'Save');
    if (!field || !save) throw new Error('missing fields');
    await tools.browser_type({ tabId: opened.tabId, ref: field.ref, text: 'person@example.com' });
    await tools.browser_click({ tabId: opened.tabId, ref: save.ref });
    await tools.browser_wait({ tabId: opened.tabId, text: 'Saved', timeoutMs: 2000 });
    const result = await tools.browser_snapshot({ tabId: opened.tabId });
    return { url: result.url, saved: result.text.includes('Saved') };
  `, (r) => {
    if (r.action === "open") return { tabId: "tab-a", url: r.url, loaded: true };
    if (r.action === "snapshot") return snapshot(polls ? "Saved" : undefined);
    if (r.action === "type") return { filled: true };
    if (r.action === "click") return { clicked: true };
    if (r.action === "check") return { tabId: "tab-a", matched: ++polls >= 2, url: "https://example.com/form", title: "Form" };
    throw new Error(`unexpected ${r.action}`);
  });
  try {
    const { result, text, details } = await h.run();
    assert.equal(result.isError, false);
    assert.match(text, /"saved":true/);
    assert.doesNotMatch(text, /Email form|person@example.com|"elements"/);
    assert.deepEqual(h.calls.map(r => r.action), ["open", "snapshot", "type", "click", "check", "check", "snapshot"]);
    assert.ok(h.calls.every(r => r.conversationId === "conversation-a"));
    assert.ok(h.calls.slice(1).every(r => r.tabId === "tab-a"));
    assert.equal(details.calls.length, 6, "six browser tools cost one model-issued script call");
    assert.ok(details.calls.every((c: any) => c.status === "ok"));
  } finally { h.close(); }
});

test("a failed fill stops before submitting and keeps candidates and partial output", async () => {
  const h = await harness(`
    text('form opened');
    await tools.browser_type({ tabId: 'tab-a', selector: '#missing', text: 'value' });
    await tools.browser_click({ tabId: 'tab-a', selector: '#save' });
  `, () => ({ filled: false, error: "No input element found", candidates: ["Email"] }));
  try {
    const { result, text } = await h.run();
    assert.equal(result.isError, true);
    assert.match(text, /form opened/);
    assert.match(text, /No input element found/);
    assert.match(text, /Email/);
    assert.deepEqual(h.calls.map(r => r.action), ["type"]);
  } finally { h.close(); }
});

test("a failed navigation stops before reading the wrong page", async () => {
  const h = await harness(`
    await tools.browser_navigate({ tabId: 'tab-a', url: 'https://example.com' });
    await tools.browser_snapshot({ tabId: 'tab-a' });
  `, () => ({ loaded: false, error: "unreachable" }));
  try {
    const { result, text } = await h.run();
    assert.equal(result.isError, true);
    assert.match(text, /unreachable/);
    assert.equal(h.calls.length, 1);
  } finally { h.close(); }
});

test("a wait timeout stops later steps and pins an omitted tab to its first resolved id", async () => {
  const h = await harness(`
    await tools.browser_wait({ text: 'Saved', timeoutMs: 250 });
    await tools.browser_click({ selector: '#again' });
  `, () => ({ tabId: "tab-a", matched: false, url: "https://example.com/form", title: "Form" }));
  try {
    const { result, text } = await h.run();
    assert.equal(result.isError, true);
    assert.match(text, /browser_wait timed out/);
    assert.ok(h.calls.length >= 2);
    assert.equal(h.calls[0].tabId, undefined);
    assert.ok(h.calls.slice(1).every(r => r.tabId === "tab-a"));
    assert.ok(h.calls.every(r => r.action === "check"));
  } finally { h.close(); }
});

test("a wait deadline cancels a probe in flight before the bridge's normal timeout", async () => {
  let cancelled = false;
  const h = await harness(`await tools.browser_wait({ text: 'Saved', timeoutMs: 50 });`, async (_request, signal) => {
    try { await delay(5000, undefined, { signal }); }
    catch (error) { cancelled = true; throw error; }
    return { tabId: "tab-a", matched: true, url: "https://example.com", title: "Form" };
  });
  try {
    const { result, text } = await h.run();
    assert.equal(result.isError, true);
    assert.match(text, /browser_wait timed out/);
    assert.equal(cancelled, true);
    assert.equal(h.calls.length, 1);
  } finally { h.close(); }
});

test("tab lists are arrays in scripts and independent page reads can run in parallel", async () => {
  const h = await harness(`
    const tabs = await tools.browser_list_tabs({});
    return await Promise.all(tabs.map(async tab => {
      const page = await tools.browser_snapshot({ tabId: tab.tabId });
      return { tabId: tab.tabId, title: page.title };
    }));
  `, r => r.action === "list"
    ? ["tab-a", "tab-b"].map(tabId => ({ tabId, url: "https://example.com", title: tabId, alive: true }))
    : { ...snapshot(), tabId: r.tabId });
  try {
    const { result, text } = await h.run();
    assert.equal(result.isError, false);
    assert.match(text, /tab-a/);
    assert.match(text, /tab-b/);
    assert.equal(h.calls.length, 3);
  } finally { h.close(); }
});

test("Stop aborts a polling wait and no further browser requests run", async () => {
  const tools = new Map<string, ToolDefinition>();
  browserUse({ registerTool: (tool: ToolDefinition) => tools.set(tool.name, tool) } as unknown as ExtensionAPI);
  const previous = globals.__fastvibeBrowserRequest;
  const controller = new AbortController();
  let calls = 0;
  globals.__fastvibeBrowserRequest = async () => {
    calls++;
    queueMicrotask(() => controller.abort());
    return { matched: false, url: "https://example.com", title: "Form" };
  };
  try {
    await assert.rejects(tools.get("browser_wait")!.execute("wait", { text: "Saved" }, controller.signal, undefined, {} as never), /abort/i);
    assert.equal(calls, 1);
    await assert.rejects(tools.get("browser_wait")!.execute("wait", {}, undefined, undefined, {} as never), /requires/);
    assert.equal(calls, 1);
  } finally { globals.__fastvibeBrowserRequest = previous; }
});

test("condition probes require all conditions, check visibility, and preserve snapshot refs", () => {
  const element = { getBoundingClientRect: () => ({ width: 20, height: 20 }) };
  let shown = true;
  const context = {
    document: { querySelector: (selector: string) => selector === "#done" ? element : null, body: { innerText: "Saved changes" }, title: "Form" },
    location: { href: "https://example.com/done" },
    getComputedStyle: () => ({ display: shown ? "block" : "none", visibility: "visible", opacity: "1" }),
  };
  const check = (condition: Parameters<typeof checkBody>[0]) => runInNewContext(pageProgram(checkBody(condition)), context);
  assert.equal(check({ selector: "#done", text: "Saved", url: "/done" }).value.matched, true);
  assert.equal(check({ selector: "#missing", text: "Saved" }).value.matched, false);
  assert.equal(check({ text: "Missing" }).value.matched, false);
  assert.equal(check({ url: "/other" }).value.matched, false);
  shown = false;
  assert.equal(check({ selector: "#done" }).value.matched, false);
  assert.equal(check({ text: "Saved" }).value.matched, true);
  assert.doesNotMatch(checkBody({ selector: "#done" }), /setAttribute|removeAttribute/);
});
