import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LATEST_PROTOCOL_VERSION, StdioTransport, StreamableHttpTransport } from "@earendil-works/pi-mcp";
import { createInMemoryTransportPair, type InMemoryTransport } from "@earendil-works/pi-mcp/testing";
import { McpManager, createTransport, normalizeConfigs, type McpServerConfig } from "../src/main/pi/mcp-manager.ts";

type Rpc = { id?: number; method?: string; params?: Record<string, any> };

/**
 * A just-enough MCP server on the far end of an in-memory wire: it answers the
 * handshake, lists `tools`, and runs `call` for `tools/call`. The client side is the real
 * `McpClient`, so what these tests exercise is the manager and the protocol it speaks.
 */
function fakeServer(
  server: InMemoryTransport,
  options: { tools?: unknown[]; call?: (name: string, args: unknown) => unknown } = {},
): void {
  const tools = options.tools ?? [{ name: "echo", description: "Echo", inputSchema: { type: "object", properties: { text: { type: "string" } } } }];
  server.onMessage((message) => {
    const { id, method, params } = message as Rpc;
    if (id === undefined) return;
    const reply = (result: unknown) => void server.send({ jsonrpc: "2.0", id, result } as never);
    if (method === "initialize") reply({ protocolVersion: LATEST_PROTOCOL_VERSION, capabilities: { tools: {} }, serverInfo: { name: "fake", version: "1" } });
    else if (method === "tools/list") reply({ tools });
    else if (method === "tools/call") reply(options.call?.(params?.name, params?.arguments) ?? { content: [{ type: "text", text: "ok" }] });
  });
  void server.start();
}

function configOf(id: string, extra: Partial<McpServerConfig> = {}): McpServerConfig {
  return { id, name: id, enabled: true, transport: "stdio", command: "fake", ...extra };
}

async function managerWith(
  configs: McpServerConfig[],
  wire: (config: McpServerConfig, server: InMemoryTransport) => void,
): Promise<{ manager: McpManager; file: string }> {
  const file = join(mkdtempSync(join(tmpdir(), "mcp-")), "mcp.json");
  const manager = new McpManager(file, {
    createTransport: (config) => {
      const { client, server } = createInMemoryTransportPair();
      wire(config, server);
      return client;
    },
  });
  await manager.save(configs);
  await manager.load();
  await manager.connectAll();
  return { manager, file };
}

test("connects an enabled server, lists its tools and skips a disabled one", async () => {
  const { manager } = await managerWith([configOf("a"), configOf("b", { enabled: false })], (_c, server) => fakeServer(server));
  const [a, b] = manager.list();
  assert.equal(a.connected, true);
  assert.deepEqual(a.tools, ["echo"]);
  assert.equal(b.connected, false);
  assert.equal(b.error, undefined);
  await manager.close();
});

test("a tool call returns text, forwards the arguments and keeps images", async () => {
  const seen: unknown[] = [];
  const { manager } = await managerWith([configOf("img")], (_c, server) =>
    fakeServer(server, {
      call: (name, args) => {
        seen.push([name, args]);
        return { content: [{ type: "text", text: "hello" }, { type: "image", data: "AAAA", mimeType: "image/png" }] };
      },
    }),
  );
  const [tool] = await manager.tools();
  assert.equal(tool.name, "mcp_img_echo");
  const result = await tool.execute("call-1", { text: "hi" }, undefined as never, undefined, undefined as never);
  assert.deepEqual(seen, [["echo", { text: "hi" }]]);
  assert.deepEqual(result.content, [{ type: "text", text: "hello" }, { type: "image", data: "AAAA", mimeType: "image/png" }]);
  assert.equal((result as { isError?: boolean }).isError, undefined);
  await manager.close();
});

test("an error result is flagged as an error, with a message when the server sent none", async () => {
  const { manager } = await managerWith([configOf("bad")], (_c, server) =>
    fakeServer(server, { call: () => ({ isError: true, content: [] }) }),
  );
  const [tool] = await manager.tools();
  const result = await tool.execute("call-1", {}, undefined as never, undefined, undefined as never);
  assert.equal((result as { isError?: boolean }).isError, true);
  assert.equal(result.content.length, 1);
  assert.equal(result.content[0].type, "text");
  await manager.close();
});

test("an empty successful result still says something", async () => {
  const { manager } = await managerWith([configOf("e")], (_c, server) => fakeServer(server, { call: () => ({ content: [] }) }));
  const [tool] = await manager.tools();
  const result = await tool.execute("call-1", {}, undefined as never, undefined, undefined as never);
  assert.deepEqual(result.content, [{ type: "text", text: "(empty result)" }]);
  await manager.close();
});

test("a direct server's tools carry no exposure, a codemode or deferred one's carry it with a namespace", async () => {
  const { manager } = await managerWith(
    [configOf("plain"), configOf("scripted", { exposure: "codemode" }), configOf("lazy", { exposure: "deferred" })],
    (_c, server) => fakeServer(server),
  );
  const byName = new Map((await manager.tools()).map((tool) => [tool.name, tool as unknown as Record<string, unknown>]));
  assert.equal(byName.get("mcp_plain_echo")?.exposure, undefined);
  assert.equal(byName.get("mcp_plain_echo")?.namespace, undefined);
  assert.equal(byName.get("mcp_scripted_echo")?.exposure, "codemode");
  assert.deepEqual(byName.get("mcp_scripted_echo")?.namespace, { name: "scripted" });
  assert.equal(byName.get("mcp_lazy_echo")?.exposure, "deferred");
  await manager.close();
});

test("a server's own instructions become its namespace's guide", async () => {
  const file = join(mkdtempSync(join(tmpdir(), "mcp-")), "mcp.json");
  const manager = new McpManager(file, {
    createTransport: () => {
      const { client, server } = createInMemoryTransportPair();
      server.onMessage((message) => {
        const { id, method } = message as Rpc;
        if (id === undefined) return;
        const reply = (result: unknown) => void server.send({ jsonrpc: "2.0", id, result } as never);
        if (method === "initialize") reply({ protocolVersion: LATEST_PROTOCOL_VERSION, capabilities: { tools: {} }, serverInfo: { name: "fake", version: "1" }, instructions: "Search before you fetch." });
        else if (method === "tools/list") reply({ tools: [{ name: "echo", inputSchema: { type: "object" } }] });
      });
      void server.start();
      return client;
    },
  });
  await manager.save([configOf("guided", { exposure: "codemode" })]);
  await manager.load();
  await manager.connectAll();
  const [tool] = (await manager.tools()) as unknown as Array<Record<string, any>>;
  assert.deepEqual(tool.namespace, { name: "guided", instructions: "Search before you fetch." });
  await manager.close();
});

test("a stored exposure that is not a known one drops the server rather than guessing", async () => {
  const { manager } = await managerWith(
    [configOf("ok", { enabled: false }), { ...configOf("odd", { enabled: false }), exposure: "everywhere" } as never],
    (_c, server) => fakeServer(server),
  );
  assert.deepEqual(manager.list().map((item) => item.id), ["ok"]);
  await manager.close();
});

test("tool parameters are always an object schema", async () => {
  const { manager } = await managerWith([configOf("p")], (_c, server) => fakeServer(server, { tools: [{ name: "bare", inputSchema: {} }] }));
  const [tool] = await manager.tools();
  assert.deepEqual(tool.parameters, { type: "object", properties: {} });
  await manager.close();
});

test("a server that cannot connect is reported with its error and the others still connect", async () => {
  const { manager } = await managerWith([configOf("down"), configOf("up")], (config, server) => {
    if (config.id === "up") fakeServer(server);
    else void server.close();
  });
  const [down, up] = manager.list();
  assert.equal(down.connected, false);
  assert.ok(down.error, "a failed connect leaves a reason");
  assert.equal(up.connected, true);
  await manager.close();
});

test("a server that goes away later is shown as down, not as connected", async () => {
  let wire: InMemoryTransport | undefined;
  const { manager } = await managerWith([configOf("flaky")], (_c, server) => {
    wire = server;
    fakeServer(server);
  });
  assert.equal(manager.list()[0].connected, true);
  await wire!.close();
  await new Promise((resolve) => setImmediate(resolve));
  const [status] = manager.list();
  assert.equal(status.connected, false);
  assert.deepEqual(status.tools, []);
  assert.ok(status.error);
  await manager.close();
});

test("reconnecting after a close does not report the old connection as lost", async () => {
  const { manager } = await managerWith([configOf("r")], (_c, server) => fakeServer(server));
  await manager.connectAll();
  await new Promise((resolve) => setImmediate(resolve));
  const [status] = manager.list();
  assert.equal(status.connected, true);
  assert.equal(status.error, undefined);
  await manager.close();
});

test("a stdio server gets the short inherited environment plus its own, not the app's", () => {
  const key = "FASTVIBE_TEST_SECRET";
  process.env[key] = "leak";
  try {
    const transport = createTransport(configOf("s", { command: "node", args: ["x"], env: { API_KEY: "k" } }), () => {}) as StdioTransport;
    assert.ok(transport instanceof StdioTransport);
    assert.equal(transport.options.inheritEnv, false);
    assert.equal(transport.options.env?.API_KEY, "k");
    assert.equal(transport.options.env?.[key], undefined);
    assert.equal(transport.options.env?.PATH, process.env.PATH);
  } finally {
    delete process.env[key];
  }
});

test("an http server is built with its headers", () => {
  const transport = createTransport(
    { id: "h", name: "h", enabled: true, transport: "http", url: "https://example.com/mcp", headers: { Authorization: "Bearer t" } },
    () => {},
  ) as StreamableHttpTransport;
  assert.ok(transport instanceof StreamableHttpTransport);
  assert.equal(transport.url.href, "https://example.com/mcp");
  assert.deepEqual(transport.options.headers, { Authorization: "Bearer t" });
});

test("save keeps env and headers, and a reload reads them back", async () => {
  const { manager, file } = await managerWith(
    [
      configOf("s", { env: { A: "1" } }),
      { id: "h", name: "h", enabled: false, transport: "http", url: "https://x/mcp", headers: { "X-Key": "v" } },
    ],
    (_c, server) => fakeServer(server),
  );
  const stored = JSON.parse(readFileSync(file, "utf8")) as McpServerConfig[];
  assert.deepEqual(stored[0].env, { A: "1" });
  assert.deepEqual(stored[1].headers, { "X-Key": "v" });
  await manager.close();
});

test("save drops a server whose headers are not strings", async () => {
  const { manager } = await managerWith(
    [{ id: "h", name: "h", enabled: false, transport: "http", url: "https://x/mcp", headers: { A: 1 } as never }, configOf("ok", { enabled: false })],
    (_c, server) => fakeServer(server),
  );
  assert.deepEqual(manager.list().map((item) => item.id), ["ok"]);
  await manager.close();
});

test("a hand-written numeric env value is kept, not a reason to drop the server", () => {
  const configs = normalizeConfigs([{ id: "n", name: "n", enabled: true, transport: "stdio", command: "x", env: { PORT: 3000 } }]);
  assert.equal(configs.length, 1);
});

test("the standard mcpServers shape: stdio and http entries, disabled and enabled flags", () => {
  const configs = normalizeConfigs({
    mcpServers: {
      fs: { command: "npx", args: ["-y", "srv"], env: { A: "1" } },
      docs: { url: "https://example.com/mcp", headers: { Authorization: "Bearer t" } },
      off: { command: "x", disabled: true },
      off2: { url: "https://example.com/other", enabled: false },
      junk: { nothing: true },
    },
  });
  assert.deepEqual(configs.map((item) => [item.id, item.transport, item.enabled]), [
    ["fs", "stdio", true],
    ["docs", "http", true],
    ["off", "stdio", false],
    ["off2", "http", false],
  ]);
  assert.deepEqual(configs[0].env, { A: "1" });
  assert.deepEqual(configs[1].headers, { Authorization: "Bearer t" });
});

test("a stored SSE entry stays in the list instead of vanishing", () => {
  const configs = normalizeConfigs({ mcpServers: { old: { type: "sse", url: "https://example.com/sse" } } });
  assert.deepEqual(configs.map((item) => [item.id, item.transport]), [["old", "http"]]);
});

test("a missing or unreadable file means no servers", async () => {
  const dir = mkdtempSync(join(tmpdir(), "mcp-"));
  const manager = new McpManager(join(dir, "none.json"));
  await manager.load();
  assert.deepEqual(manager.list(), []);
  writeFileSync(join(dir, "bad.json"), "{ not json");
  const broken = new McpManager(join(dir, "bad.json"));
  await broken.load();
  assert.deepEqual(broken.list(), []);
});
