import { readFile, writeFile } from "node:fs/promises";
import {
  McpClient,
  StdioTransport,
  StreamableHttpTransport,
  toLlmContent,
  type McpTransport,
  type Tool as McpTool,
} from "@earendil-works/pi-mcp";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import type { McpServerConfig, McpServerStatus } from "@shared/types";
import { isStringRecord, serverFromEntry } from "../../shared/mcp-config.ts";
import { uiText } from "../engine/ui-text.ts";
export type { McpServerConfig, McpServerStatus } from "@shared/types";

/**
 * How long one server gets to answer before it is given up on.
 *
 * Both calls below are bounded, because neither the handshake nor `tools/list` has a
 * deadline of its own — an unreachable HTTP endpoint, or a stdio server that starts but
 * never speaks, simply never settles. The engine used to await `connectAll()` before it
 * reported itself ready, so without this the whole app sat in 「正在准备工作区…」 for as long
 * that server stayed silent. It connects in the background now (`PiProcessManager.start`), but
 * a connect still must end: a prompt waits for it, and so does a scheduled task.
 */
const CONNECT_TIMEOUT_MS = 10_000;

/** A tool call is allowed to be slow; a hung server is ended by Stop (the call's signal). */
const REQUEST_TIMEOUT_MS = 60_000;

function withTimeout<T>(work: Promise<T>, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(label)), CONNECT_TIMEOUT_MS);
    timer.unref?.();
    work.then(resolve, reject).finally(() => clearTimeout(timer));
  });
}

/**
 * The variables a stdio server inherits before its own `env` is laid on top. The
 * transport would hand over the whole of `process.env` by default; the app's own
 * environment is not the server's business, so only what a process needs to find its
 * interpreter and home directory goes through — the MCP reference client's short list,
 * plus the character locale.
 *
 * The locale is the one addition. Without it a server runs in the C locale, where a byte
 * above 0x7f is not part of a character — the same hole `engine/shell-locale.ts` closes
 * for the terminal, reopened here by this list, and the one place a server started inside
 * FastVibe would behave worse than the same `npx` run by hand in Terminal.app (which does
 * pass `LANG`). Both spellings are listed because either may be the one that is set: a
 * desktop session's `LANG`, or the `LC_CTYPE` Main wrote. Windows has a console code page
 * rather than a locale, and ConPTY is UTF-8 either way.
 */
const INHERITED_ENV =
  process.platform === "win32"
    ? ["APPDATA", "HOMEDRIVE", "HOMEPATH", "LOCALAPPDATA", "PATH", "PROCESSOR_ARCHITECTURE", "SYSTEMDRIVE", "SYSTEMROOT", "TEMP", "USERNAME", "USERPROFILE", "PROGRAMFILES"]
    : ["HOME", "LANG", "LC_CTYPE", "LOGNAME", "PATH", "SHELL", "TERM", "USER"];

function inheritedEnvironment(): Record<string, string> {
  const env: Record<string, string> = {};
  for (const key of INHERITED_ENV) {
    const value = process.env[key];
    // A value starting with "()" is a shell function exported by bash, not data.
    if (value && !value.startsWith("()")) env[key] = value;
  }
  return env;
}

type Connection = {
  config: McpServerConfig;
  client: McpClient;
  tools: McpTool[];
  /** What the server says about its tools as a group; handed to `codemode` as the namespace's guide. */
  instructions?: string;
};

/** Builds the wire to one server. `onStderr` receives a stdio child's error output. */
export type McpTransportFactory = (config: McpServerConfig, onStderr: (chunk: string) => void) => McpTransport;

export function createTransport(config: McpServerConfig, onStderr: (chunk: string) => void): McpTransport {
  if (config.transport === "stdio") {
    return new StdioTransport({
      command: config.command ?? "",
      args: config.args,
      env: { ...inheritedEnvironment(), ...config.env },
      inheritEnv: false,
      cwd: process.cwd(),
      stderr: "pipe",
      onStderr,
    });
  }
  return new StreamableHttpTransport({ url: config.url ?? "", headers: config.headers });
}

export class McpManager {
  #file: string;
  #createTransport: McpTransportFactory;
  #configs: McpServerConfig[] = [];
  #connections = new Map<string, Connection>();
  #errors = new Map<string, string>();
  /** Bumped by every `close()`: a connect that finishes under an older number is discarded. */
  #generation = 0;
  /** The same, for one server: `reconnect(id)` discards that server's connect that is still in flight. */
  #epochs = new Map<string, number>();

  constructor(file: string, options: { createTransport?: McpTransportFactory } = {}) {
    this.#file = file;
    this.#createTransport = options.createTransport ?? createTransport;
  }

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

  /**
   * Replace every connection with fresh ones for the enabled servers.
   *
   * The engine connects at launch without waiting for it, so a settings save or a restart can
   * arrive while that connect is still in flight. Each run is stamped with the generation its
   * own `close()` produced, and a connect that finishes under an older one is discarded — its
   * child process closed, its error not recorded — so overlapping runs cannot refill the map
   * the newer one just emptied, and the newer one does not have to wait out a hung server.
   */
  async connectAll(): Promise<void> {
    // Taken before the first await: two calls made back to back must not both read the number
    // after the second one's bump, or they would trust each other's connections.
    const generation = ++this.#generation;
    await this.#closeConnections();
    this.#errors.clear();
    await Promise.all(this.#configs.filter((config) => config.enabled).map((config) => this.#connect(config, generation)));
  }

  /**
   * Drop one server's connection and connect it again, leaving the others as they are.
   *
   * A disabled server is only disconnected. The server's own epoch is bumped first, so a connect of
   * the same server that is still in flight (the launch-time one, a hung endpoint) is discarded when
   * it finally answers instead of replacing this one.
   */
  async reconnect(id: string): Promise<void> {
    const config = this.#configs.find((item) => item.id === id);
    if (!config) throw new Error(uiText("没有这个 MCP 服务器", "No such MCP server"));
    this.#epochs.set(id, (this.#epochs.get(id) ?? 0) + 1);
    const previous = this.#connections.get(id);
    this.#connections.delete(id);
    this.#errors.delete(id);
    await previous?.client.close().catch(() => undefined);
    if (config.enabled) await this.#connect(config, this.#generation);
  }

  async tools(): Promise<ToolDefinition<any>[]> {
    const output: ToolDefinition<any>[] = [];
    for (const connection of this.#connections.values()) {
      for (const tool of connection.tools) {
        const safeName = `mcp_${connection.config.id}_${tool.name}`.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 64);
        // `direct` is the SDK's own default and needs no namespace. The other two are
        // tools the model does not see declared, so `codemode` lists them under their
        // server and `tool_search` ranks them by it.
        const exposure = connection.config.exposure ?? "direct";
        output.push({
          name: safeName,
          ...(exposure === "direct"
            ? {}
            : {
                exposure,
                namespace: {
                  name: connection.config.name,
                  ...(connection.instructions ? { instructions: connection.instructions } : {}),
                },
              }),
          label: `${connection.config.name}: ${tool.name}`,
          description: tool.description ?? `MCP tool ${tool.name} from ${connection.config.name}`,
          parameters: toParameters(tool.inputSchema) as any,
          execute: async (_toolCallId, params, signal) => {
            // Stop reaches the server as a cancellation, instead of leaving the call to
            // run out its timeout behind a run that has already ended.
            const result = await connection.client.callTool(tool.name, (params ?? {}) as Record<string, unknown>, { signal });
            const content = toLlmContent(result);
            if (!content.length) content.push({ type: "text", text: result.isError ? uiText("MCP 工具返回了错误", "The MCP tool returned an error") : "(empty result)" });
            return {
              content,
              details: {
                isError: result.isError === true,
                // Keep provenance with the transcript so preview filtering also works on reload.
                mcp: { toolName: tool.name, readOnlyHint: tool.annotations?.readOnlyHint === true },
              },
              ...(result.isError ? { isError: true } : {}),
            };
          },
        });
      }
    }
    return output;
  }

  async close(): Promise<void> {
    this.#generation++;
    await this.#closeConnections();
  }

  async #closeConnections(): Promise<void> {
    const connections = [...this.#connections.values()];
    this.#connections.clear();
    await Promise.all(connections.map((connection) => connection.client.close().catch(() => undefined)));
  }

  async #connect(config: McpServerConfig, generation: number): Promise<void> {
    const client = new McpClient({ name: "FastVibe", version: "0.1.0", requestTimeoutMs: REQUEST_TIMEOUT_MS });
    const epoch = this.#epochs.get(config.id) ?? 0;
    // Replaced by a newer `connectAll()` / `close()`, or by a `reconnect()` of this very server.
    const replaced = (): boolean => generation !== this.#generation || epoch !== (this.#epochs.get(config.id) ?? 0);
    let stderr = "";
    try {
      const transport = this.#createTransport(config, (chunk) => {
        // Keep enough context for the settings tooltip without allowing a noisy
        // child process to grow the in-memory error indefinitely.
        stderr = `${stderr}${chunk}`.slice(-12_000);
      });
      await withTimeout(client.connect(transport), uiText("连接超时", "Connection timed out"));
      const tools = await withTimeout(client.listTools(), uiText("读取工具列表超时", "Listing tools timed out"));
      // The engine was stopped while this server was still answering. Its child process is
      // ours to end: registering the connection now would leave it running with nothing
      // that ever closes it.
      if (replaced()) {
        await client.close().catch(() => undefined);
        return;
      }
      const connection: Connection = { config, client, tools, instructions: client.instructions };
      this.#connections.set(config.id, connection);
      // A server that exits later is shown as down rather than as connected with tools
      // that can no longer be called. Closing on our own side clears the map first, so
      // only a connection that is still the current one reports itself lost.
      client.onClose(() => {
        if (this.#connections.get(config.id) !== connection) return;
        this.#connections.delete(config.id);
        this.#errors.set(config.id, uiText("连接已断开", "The connection was closed"));
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const details = stderr.trim();
      // A run that has been replaced reports nothing: its error would land on the newer run's.
      if (!replaced()) this.#errors.set(config.id, details ? `${message}\n\n${details}` : message);
      // A timed-out connect can still be in flight, and a stdio server is a child
      // process this one owns: closing releases it instead of leaving it running for
      // the life of the app.
      await client.close().catch(() => undefined);
    }
  }
}

/**
 * A tool's input schema must be an object, and some providers reject an object schema
 * with no `properties`; MCP servers may omit either.
 */
function toParameters(schema: McpTool["inputSchema"] | undefined): Record<string, unknown> {
  const base = (schema ?? {}) as Record<string, unknown>;
  return { ...base, type: base.type ?? "object", ...(base.properties === undefined ? { properties: {} } : {}) };
}

export function normalizeConfigs(value: unknown): McpServerConfig[] {
  if (Array.isArray(value)) return value.filter(isConfig);
  if (!value || typeof value !== "object") return [];

  // Also accept the standard MCP client shape, so a config copied from DBX,
  // Claude Desktop, etc. can be placed directly in FastVibe's mcp.json.
  const servers = (value as Record<string, unknown>).mcpServers;
  if (!servers || typeof servers !== "object" || Array.isArray(servers)) return [];
  return Object.entries(servers).flatMap(([name, raw]) => {
    const result = serverFromEntry(name, raw, { lenient: true });
    return "server" in result ? [result.server] : [];
  });
}

function isConfig(value: unknown): value is McpServerConfig {
  if (!value || typeof value !== "object") return false;
  const item = value as Record<string, unknown>;
  if (typeof item.id !== "string" || typeof item.name !== "string") return false;
  // `env` was never validated before, and a hand-written `"PORT": 3000` spawns fine, so only
  // its shape is checked; `headers` is new and must be strings, which a request needs.
  if (item.env !== undefined && (typeof item.env !== "object" || item.env === null || Array.isArray(item.env))) return false;
  if (item.headers !== undefined && !isStringRecord(item.headers)) return false;
  if (item.exposure !== undefined && item.exposure !== "direct" && item.exposure !== "deferred" && item.exposure !== "codemode") return false;
  if (item.transport === "stdio") {
    return typeof item.command === "string" && item.command.length > 0
      && (item.args === undefined || Array.isArray(item.args));
  }
  return item.transport === "http" && typeof item.url === "string" && item.url.length > 0;
}
