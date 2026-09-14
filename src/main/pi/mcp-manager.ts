import { readFile, writeFile } from "node:fs/promises";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { getDefaultEnvironment, StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { ToolDefinition } from "@mariozechner/pi-coding-agent";
import type { McpServerConfig, McpServerStatus } from "@shared/types";
export type { McpServerConfig, McpServerStatus } from "@shared/types";

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
      this.#configs = Array.isArray(parsed) ? parsed.filter(isConfig) : [];
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
    try {
      const client = new Client({ name: "FastVibe", version: "0.1.0" });
      const transport = config.transport === "stdio"
        ? new StdioClientTransport({ command: config.command ?? "", args: config.args, env: { ...getDefaultEnvironment(), ...config.env }, cwd: process.cwd(), stderr: "pipe" })
        : new StreamableHTTPClientTransport(new URL(config.url ?? ""));
      await client.connect(transport);
      const listed = await client.listTools();
      this.#connections.set(config.id, { config, client, transport, tools: listed.tools ?? [] });
    } catch (error) {
      this.#errors.set(config.id, error instanceof Error ? error.message : String(error));
    }
  }
}

function isConfig(value: unknown): value is McpServerConfig {
  if (!value || typeof value !== "object") return false;
  const item = value as Record<string, unknown>;
  return typeof item.id === "string" && typeof item.name === "string" && (item.transport === "stdio" || item.transport === "http");
}
