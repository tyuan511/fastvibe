import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createAgentSession,
  createCodemodeExtension,
  createToolSearchExtension,
  DefaultResourceLoader,
  ModelRuntime,
  SessionManager,
  SettingsManager,
  type AgentSession,
  type AgentSessionEvent,
  type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { createFauxCore, fauxAssistantMessage, fauxToolCall, InMemoryModelsStore } from "@earendil-works/pi-ai";
import { LATEST_PROTOCOL_VERSION } from "@earendil-works/pi-mcp";
import { createInMemoryTransportPair } from "@earendil-works/pi-mcp/testing";
import { McpManager, type McpServerConfig } from "../src/main/pi/mcp-manager.ts";
import { applyToolModes, toolModes } from "../src/main/engine/tool-modes.ts";

/**
 * The real SDK, end to end: the extensions FastVibe loads, an MCP server behind our
 * manager, and a scripted model. What it pins is the wiring the engine does in
 * `#createSession` — which tools are declared, what a script can reach, and what the
 * events a client receives look like — none of which a unit test of one piece can see.
 */

type Rpc = { id?: number; method?: string; params?: Record<string, any> };

function mcpServer(onCall: (args: unknown) => unknown) {
  return () => {
    const { client, server } = createInMemoryTransportPair();
    server.onMessage((message) => {
      const { id, method, params } = message as Rpc;
      if (id === undefined) return;
      const reply = (result: unknown) => void server.send({ jsonrpc: "2.0", id, result } as never);
      if (method === "initialize") reply({ protocolVersion: LATEST_PROTOCOL_VERSION, capabilities: { tools: {} }, serverInfo: { name: "fake", version: "1" }, instructions: "Echo things." });
      else if (method === "tools/list") reply({ tools: [{ name: "echo", description: "Echo the text back", inputSchema: { type: "object", properties: { text: { type: "string" } } } }] });
      else if (method === "tools/call") reply({ content: [{ type: "text", text: String(onCall(params?.arguments)) }] });
    });
    void server.start();
    return client;
  };
}

async function harness(options: {
  exposure: McpServerConfig["exposure"];
  settings?: Record<string, unknown>;
  responses: Array<ReturnType<typeof fauxAssistantMessage>>;
}) {
  const calls: unknown[] = [];
  const dir = mkdtempSync(join(tmpdir(), "codemode-"));
  const manager = new McpManager(join(dir, "mcp.json"), { createTransport: mcpServer((args) => (calls.push(args), "echoed")) });
  await manager.save([{ id: "srv", name: "srv", enabled: true, transport: "stdio", command: "fake", exposure: options.exposure }]);
  await manager.load();
  await manager.connectAll();

  const faux = createFauxCore({ api: "faux-api", provider: "faux", models: [{ id: "scripted" }] });
  faux.setResponses(options.responses);
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
    api: "faux-api" as never,
    apiKey: "unused",
    streamSimple: faux.streamSimple as never,
    models: [{ id: "scripted", name: "scripted", reasoning: false, input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 100_000, maxTokens: 4096 }],
  });

  const cwd = join(dir, "project");
  const agentDir = join(dir, "agent");
  const settingsManager = SettingsManager.inMemory();
  const resourceLoader = new DefaultResourceLoader({
    cwd,
    agentDir,
    settingsManager,
    extensionFactories: [
      { name: "fastvibe-mcp", hidden: true, factory: async (pi) => { for (const tool of await manager.tools()) pi.registerTool(tool as ToolDefinition); } },
      { name: "fastvibe-codemode", hidden: true, factory: createCodemodeExtension() },
      { name: "fastvibe-tool-search", hidden: true, factory: createToolSearchExtension() },
      {
        name: "fastvibe-tool-modes",
        hidden: true,
        factory: (pi) => {
          pi.on("session_start", () => {
            pi.setActiveTools(applyToolModes(pi.getActiveTools(), toolModes(options.settings ?? {}, manager.list())));
          });
        },
      },
    ],
  });
  await resourceLoader.reload();
  const { session } = await createAgentSession({
    cwd,
    agentDir,
    modelRuntime: runtime,
    model: runtime.getModel("faux", "scripted"),
    sessionManager: SessionManager.inMemory(),
    settingsManager,
    resourceLoader,
  });
  await session.bindExtensions({ mode: "rpc" });
  const events: AgentSessionEvent[] = [];
  session.subscribe((event) => events.push(event));
  return {
    session,
    events,
    calls,
    async close() {
      session.dispose();
      await manager.close();
    },
  };
}

function toolResults(session: AgentSession): Array<{ toolName: string; text: string; details?: any; isError?: boolean; nestedCalls?: unknown }> {
  return session.messages
    .filter((message: any) => message.role === "toolResult")
    .map((message: any) => ({
      toolName: message.toolName,
      text: message.content.map((part: any) => part.text ?? "").join(""),
      details: message.details,
      isError: message.isError,
      nestedCalls: message.nestedCalls,
    }));
}

const SCRIPT = [
  "const reply = await tools.mcp_srv_echo({ text: 'hi' });",
  "text(JSON.stringify(reply));",
  "return 'finished';",
].join("\n");

test("a codemode server: its tool is not declared, but a script reaches it", async () => {
  const h = await harness({
    exposure: "codemode",
    responses: [fauxAssistantMessage([fauxToolCall("codemode", { code: SCRIPT }, { id: "call-1" })]), fauxAssistantMessage("done")],
  });
  try {
    const active = h.session.getActiveToolNames();
    assert.ok(active.includes("codemode"));
    assert.ok(!active.includes("mcp_srv_echo"), "a codemode tool is not declared to the model");

    await h.session.prompt("go");

    assert.deepEqual(h.calls, [{ text: "hi" }], "the script's call reached the MCP server");
    const [result] = toolResults(h.session);
    assert.equal(result.toolName, "codemode");
    assert.match(result.text, /Script completed/);
    assert.match(result.text, /echoed/);
    assert.equal(result.isError, false);
    // The renderer draws the card from these.
    assert.deepEqual(result.details.calls.map((call: any) => [call.name, call.status]), [["mcp_srv_echo", "ok"]]);
  } finally {
    await h.close();
  }
});

test("a script's nested calls arrive as events tagged with the codemode call's id", async () => {
  const h = await harness({
    exposure: "codemode",
    responses: [fauxAssistantMessage([fauxToolCall("codemode", { code: SCRIPT }, { id: "call-1" })]), fauxAssistantMessage("done")],
  });
  try {
    await h.session.prompt("go");
    const nested = h.events.filter((event: any) => typeof event.parentToolCallId === "string") as any[];
    const types = nested.map((event) => event.type);
    assert.deepEqual([types[0], types.at(-1)], ["tool_execution_start", "tool_execution_end"]);
    assert.ok(nested.every((event) => event.parentToolCallId === "call-1" && event.toolName === "mcp_srv_echo"));
    assert.ok(nested[0].toolCallId.startsWith("call-1/"));
    // The model-issued call itself has no parent, and its updates carry the call list.
    const outer = h.events.filter((event: any) => event.toolCallId === "call-1" && event.parentToolCallId === undefined) as any[];
    assert.ok(outer.some((event) => event.type === "tool_execution_start"));
    assert.ok(outer.some((event) => event.type === "tool_execution_update" && Array.isArray(event.partialResult?.details?.calls)));
    assert.ok(outer.some((event) => event.type === "tool_execution_end"));
  } finally {
    await h.close();
  }
});

test("both tools are on with nothing saved, and a direct tool stays declared next to them", async () => {
  const h = await harness({ exposure: "direct", responses: [fauxAssistantMessage("hi")] });
  try {
    const active = h.session.getActiveToolNames();
    assert.ok(active.includes("codemode") && active.includes("tool_search"), "on by default");
    assert.ok(active.includes("mcp_srv_echo"), "a direct tool is still declared to the model");
  } finally {
    await h.close();
  }
});

test("the settings switches turn each tool off", async () => {
  const h = await harness({ exposure: "direct", settings: { codemode: false, toolSearch: false }, responses: [fauxAssistantMessage("hi")] });
  try {
    const active = h.session.getActiveToolNames();
    assert.ok(!active.includes("codemode") && !active.includes("tool_search"));
    assert.ok(active.includes("mcp_srv_echo"));
  } finally {
    await h.close();
  }
});

test("a codemode server keeps codemode on even when its switch is off", async () => {
  const h = await harness({
    exposure: "codemode",
    settings: { codemode: false, toolSearch: false },
    responses: [fauxAssistantMessage([fauxToolCall("codemode", { code: SCRIPT }, { id: "call-1" })]), fauxAssistantMessage("done")],
  });
  try {
    const active = h.session.getActiveToolNames();
    assert.ok(active.includes("codemode"), "the server's exposure needs it");
    assert.ok(!active.includes("tool_search"), "nothing needs this one");
    await h.session.prompt("go");
    assert.deepEqual(h.calls, [{ text: "hi" }]);
  } finally {
    await h.close();
  }
});

test("a deferred server: tool_search finds the tool and declares it for the next request", async () => {
  const h = await harness({
    exposure: "deferred",
    responses: [fauxAssistantMessage([fauxToolCall("tool_search", { query: "echo text back" }, { id: "search-1" })]), fauxAssistantMessage("found it")],
  });
  try {
    const before = h.session.getActiveToolNames();
    assert.ok(before.includes("tool_search"));
    assert.ok(!before.includes("mcp_srv_echo"), "a deferred tool is not declared until it is searched for");

    await h.session.prompt("find a tool");

    const [result] = toolResults(h.session);
    assert.equal(result.toolName, "tool_search");
    assert.match(result.text, /mcp_srv_echo/);
    assert.ok(h.session.getActiveToolNames().includes("mcp_srv_echo"), "the match is now declared");
  } finally {
    await h.close();
  }
});

test("a script that calls a tool that does not exist fails as a result, not a crash", async () => {
  const h = await harness({
    exposure: "codemode",
    responses: [
      fauxAssistantMessage([fauxToolCall("codemode", { code: "await tools.nothing_here({});" }, { id: "call-1" })]),
      fauxAssistantMessage("done"),
    ],
  });
  try {
    await h.session.prompt("go");
    const [result] = toolResults(h.session);
    assert.match(result.text, /Script failed/);
    assert.match(result.text, /Script error/);
    assert.equal(h.calls.length, 0);
  } finally {
    await h.close();
  }
});
