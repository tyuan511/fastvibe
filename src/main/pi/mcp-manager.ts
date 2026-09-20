import { readFile, writeFile } from "node:fs/promises";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { getDefaultEnvironment, StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import type { McpServerConfig, McpServerStatus } from "@shared/types";
import { uiText } from "../engine/ui-text";
export type { McpServerConfig, McpServerStatus } from "@shared/types";

/**
 * How long one server gets to answer before it is given up on.
 *
 * Both calls below are bounded, because neither the MCP SDK's handshake nor its
 * `tools/list` has a deadline of its own — an unreachable HTTP endpoint, or a stdio
 * server that starts but never speaks, simply never settles. The engine awaits
 * `connectAll()` before it reports itself ready, so without this the whole app sat in
 * 「正在准备工作区…」 for as long as that server stayed silent, with no way to send a
 * prompt and nothing on screen to say why.
 */
const CONNECT_TIMEOUT_MS = 10_000;

function withTimeout<T>(work: Promise<T>, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(label)), CONNECT_TIMEOUT_MS);
    timer.unref?.();
    work.then(resolve, reject).finally(() => clearTimeout(timer));
  });
}

type Connection = { config: McpServerConfig; client: Client; transport: StdioClientTransport | StreamableHTTPClientTransport; tools: Array<{ name: string; description?: string; inputSchema?: unknown }> };

export class McpManager {
  #file: string;
  #configs: McpServerConfig[] = [];
  #connections = new Map<string, Connection>();
  #errors = new Map<string, string>();

  constructor(file: string) { this.#file = file; }

  async load(): Promise<void> {
    try {
      const parsed = JSON.parse(await readFile(this.#file, "utf8")) as unknown;
      this.#configs = normalizeConfigs(parsed);
    } catch { this.#configs = []; }
  }

  async save(configs: McpServerConfig[]): Promise<void> {
    this.#configs = configs.filter(isConfig);
    await writeFile(this.#file, `${JSON.stringify(this.#configs, null, 2)}\n`, "utf8");
  }

  list(): McpServerStatus[] {
    return this.#configs.map((config) => ({ ...config, connected: this.#connections.has(config.id), tools: this.#connections.get(config.id)?.tools.map((tool) => tool.name) ?? [], error: this.#errors.get(config.id) }));
  }

  async connectAll(): Promise<void> {
    await this.close();
    this.#errors.clear();
    await Promise.all(this.#configs.filter((config) => config.enabled).map((config) => this.#connect(config)));
  }

  async tools(): Promise<ToolDefinition<any>[]> {
    const output: ToolDefinition<any>[] = [];
    for (const connection of this.#connections.values()) {
      for (const tool of connection.tools) {
        const safeName = `mcp_${connection.config.id}_${tool.name}`.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 64);
        output.push({
          name: safeName,
          label: `${connection.config.name}: ${tool.name}`,
          description: tool.description ?? `MCP tool ${tool.name} from ${connection.config.name}`,
          parameters: (tool.inputSchema ?? { type: "object", properties: {} }) as any,
          execute: async (_toolCallId, params) => {
            const result = await connection.client.callTool({ name: tool.name, arguments: params as Record<string, unknown> });
            const text = Array.isArray(result.content) ? result.content.map((item) => item && typeof item === "object" && "text" in item ? String(item.text) : JSON.stringify(item)).join("\n") : JSON.stringify(result);
            return { content: [{ type: "text", text: text || "(empty result)" }], details: { isError: result.isError === true } } as any;
          },
        });
      }
    }
    return output;
  }

  async close(): Promise<void> {
    const connections = [...this.#connections.values()];
    this.#connections.clear();
    await Promise.all(connections.map((connection) => connection.client.close().catch(() => undefined)));
  }

  async #connect(config: McpServerConfig): Promise<void> {
    let client: Client | undefined;
    let stderr = "";
    try {
      client = new Client({ name: "FastVibe", version: "0.1.0" });
      let transport: StdioClientTransport | StreamableHTTPClientTransport;
      if (config.transport === "stdio") {
        const stdio = new StdioClientTransport({ command: config.command ?? "", args: config.args, env: { ...getDefaultEnvironment(), ...config.env }, cwd: process.cwd(), stderr: "pipe" });
        stdio.stderr?.on("data", (chunk) => {
          // Keep enough context for the settings tooltip without allowing a noisy
          // child process to grow the in-memory error indefinitely.
          stderr = `${stderr}${String(chunk)}`.slice(-12_000);
        });
        transport = stdio;
      } else {
        transport = new StreamableHTTPClientTransport(new URL(config.url ?? ""));
      }
      await withTimeout(client.connect(transport), uiText("连接超时", "Connection timed out"));
      const listed = await withTimeout(client.listTools(), uiText("读取工具列表超时", "Listing tools timed out"));
      this.#connections.set(config.id, { config, client, transport, tools: listed.tools ?? [] });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const details = stderr.trim();
      this.#errors.set(config.id, details ? `${message}\n\n${details}` : message);
      // A timed-out connect can still be in flight, and a stdio server is a child
      // process this one owns: closing releases it instead of leaving it running for
      // the life of the app.
      await client?.close().catch(() => undefined);
    }
  }
}

function normalizeConfigs(value: unknown): McpServerConfig[] {
  if (Array.isArray(value)) return value.filter(isConfig);
  if (!value || typeof value !== "object") return [];

  // Also accept the standard MCP client shape, so a config copied from DBX,
  // Claude Desktop, etc. can be placed directly in FastVibe's mcp.json.
  const servers = (value as Record<string, unknown>).mcpServers;
  if (!servers || typeof servers !== "object" || Array.isArray(servers)) return [];
  return Object.entries(servers).flatMap(([id, raw]) => {
    if (!raw || typeof raw !== "object") return [];
    const item = raw as Record<string, unknown>;
    const config: McpServerConfig = {
      id,
      name: id,
      enabled: item.disabled !== true,
      transport: "stdio",
      command: typeof item.command === "string" ? item.command : undefined,
      args: Array.isArray(item.args) && item.args.every((arg) => typeof arg === "string") ? item.args as string[] : undefined,
      env: item.env && typeof item.env === "object" && !Array.isArray(item.env)
        ? Object.fromEntries(Object.entries(item.env).filter(([, envValue]) => typeof envValue === "string")) as Record<string, string>
        : undefined,
    };
    return isConfig(config) ? [config] : [];
  });
}

function isConfig(value: unknown): value is McpServerConfig {
  if (!value || typeof value !== "object") return false;
  const item = value as Record<string, unknown>;
  if (typeof item.id !== "string" || typeof item.name !== "string") return false;
  if (item.transport === "stdio") {
    return typeof item.command === "string" && item.command.length > 0
      && (item.args === undefined || Array.isArray(item.args));
  }
  return item.transport === "http" && typeof item.url === "string" && item.url.length > 0;
}
