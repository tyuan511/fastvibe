import { dispatch, type CallerContext } from "./ipc/registry.ts";
import { Ipc, type RemoteTunnelProvider } from "../shared/ipc.ts";
import type { FrpSettingsInput, FrpSettingsView } from "../shared/frp.ts";
import type { McpServerConfig, McpServerStatus } from "../shared/types.ts";
import { APP_CONFIG_CATALOG, isAppConfigAction, type AppConfigAction, type AppConfigHostRequest, type AppConfigHostResult } from "../shared/app-config.ts";

/**
 * What the agent may do to FastVibe's own configuration (the `fastvibe_config_*` tools).
 *
 * The point is that a setup like 远程访问 → frp is a dozen fields across a server the
 * user owns and a pane on this machine: the agent can do the server half over SSH with
 * its ordinary tools, and this is the other half — filling the pane for them.
 *
 * Every action goes through the same call table the settings panes use (`dispatch`), so
 * the agent cannot do anything a click could not, and a write is broadcast to every
 * window exactly like a click's. It is an **allowlist**, action by action, never a
 * pass-through of arbitrary channels: the table also holds methods that would let the
 * agent raise its own permissions or read a credential back.
 *
 * Three rules the table keeps:
 *
 * - **No action returns a secret.** SSH passwords are stripped, frp serves `hasToken`,
 *   the remote-access password is write-only.
 * - **The agent never chooses its own permissions.** `settings.set` refuses the
 *   permission keys — a model that could write `permissionMode: "full"` would have
 *   approved every later prompt for itself.
 * - **The remote-access password never reaches the model.** The extension asks the user
 *   for it in the composer and hands it here directly (`resources/extensions/app-config.ts`).
 */

/** The caller the actions dispatch as: Main itself, no window, broadcast to everyone. */
const AGENT_CALLER: CallerContext = { kind: "window", window: null };

const call = <T>(channel: string, payload?: unknown): Promise<T> => dispatch(channel, payload, AGENT_CALLER) as Promise<T>;

/** Settings keys the agent must not write, each for a reason stated beside it. */
const BLOCKED_SETTINGS: Array<[RegExp, string]> = [
  // The permission sandbox reads these; the agent writing them approves itself.
  [/^(permissionMode|defaultPermissionMode|fullAccessConfirmed|permissionAlways)$/, "权限相关设置只能由用户在界面上修改"],
  // Remote access has its own actions, which go through the server's own start/stop.
  [/^remote/, "远程访问请用 remote.* 动作配置"],
  // Proxy writes are validated by their own method; settings:set preserves them anyway.
  [/^proxy/, "代理请在 设置 → 通用 → 网络代理 中配置"],
];

type Input = Record<string, unknown>;

/** Kind and summary live in the shared catalog; this side only implements. */
type Run = (input: Input) => Promise<unknown>;

function stripMcpStatus(server: McpServerStatus | McpServerConfig): McpServerConfig {
  const { id, name, enabled, transport, command, args, env, url } = server;
  return { id, name, enabled, transport, command, args, env, url };
}

function isTunnelProvider(value: unknown): value is RemoteTunnelProvider {
  return value === "cloudflared" || value === "ngrok" || value === "frp";
}

async function readHosts(): Promise<unknown> {
  const hosts = await call<{ saved: Array<Record<string, unknown>>; discovered: Array<Record<string, unknown>> }>(Ipc.sshHosts);
  const clean = (list: Array<Record<string, unknown>>) => list.map(({ password: _password, ...rest }) => rest);
  return { saved: clean(hosts.saved ?? []), discovered: clean(hosts.discovered ?? []) };
}

const ACTIONS: Record<AppConfigAction, Run> = {
  overview: async () => {
    const [remote, tunnelTools, frp, sshHosts, mcp] = await Promise.all([
      call(Ipc.remoteGetState),
      call(Ipc.remoteTunnelTools),
      call(Ipc.remoteFrpGet),
      readHosts(),
      call<McpServerStatus[]>(Ipc.engineListMcpServers).then((list) =>
        list.map((item) => ({ id: item.id, name: item.name, enabled: item.enabled, transport: item.transport, connected: item.connected, error: item.error })),
      ),
    ]);
    return { actions: APP_CONFIG_CATALOG, remote, tunnelTools, frp, sshHosts, mcp };
  },
  "remote.status": () => call(Ipc.remoteGetState),
  "remote.tunnel_tools": () => call(Ipc.remoteTunnelTools),
  "remote.frp_get": () => call(Ipc.remoteFrpGet),
  "ssh.hosts": readHosts,
  "mcp.list": () => call(Ipc.engineListMcpServers),
  "settings.get": () => call(Ipc.settingsGet),

  "remote.set_password": async (input) => {
    if (typeof input.password !== "string" || !input.password) throw new Error("没有收到密码");
    return call(Ipc.remoteSetPassword, { password: input.password });
  },
  "remote.start": (input) => call(Ipc.remoteStart, typeof input.port === "number" ? { port: input.port } : {}),
  "remote.stop": () => call(Ipc.remoteStop),
  "remote.set_tunnel": async (input) => {
    const provider = input.provider ?? null;
    if (provider !== null && !isTunnelProvider(provider)) throw new Error("provider 只能是 cloudflared / ngrok / frp / null");
    return call(Ipc.remoteTunnelSet, { provider });
  },
  // Merged with what is stored, so the agent can change one field without restating the
  // form — and a token it leaves out is kept, the same three-valued rule the pane uses.
  "remote.frp_set": async (input) => {
    const current = await call<FrpSettingsView | null>(Ipc.remoteFrpGet);
    const base: Partial<FrpSettingsInput> = current
      ? (({ hasToken: _hasToken, proxyName: _proxyName, ...rest }) => rest)(current)
      : {};
    return call(Ipc.remoteFrpSet, { ...base, ...input } as FrpSettingsInput);
  },
  // One server at a time: handing the agent the whole-list save would let a list it
  // misremembered silently delete the user's other servers.
  "mcp.upsert": async (input) => {
    const server = input.server as McpServerConfig | undefined;
    if (!server || typeof server !== "object" || !server.id || !server.name) throw new Error("server 需要 id 和 name");
    if (server.transport !== "stdio" && server.transport !== "http") throw new Error("transport 只能是 stdio 或 http");
    const list = (await call<McpServerStatus[]>(Ipc.engineListMcpServers)).map(stripMcpStatus);
    const next = { ...stripMcpStatus(server), enabled: server.enabled !== false };
    const index = list.findIndex((item) => item.id === next.id);
    if (index >= 0) list[index] = next;
    else list.push(next);
    return call(Ipc.engineSaveMcpServers, { configs: list });
  },
  "mcp.remove": async (input) => {
    const list = (await call<McpServerStatus[]>(Ipc.engineListMcpServers)).map(stripMcpStatus);
    const next = list.filter((item) => item.id !== input.id);
    if (next.length === list.length) throw new Error(`没有 id 为 ${String(input.id)} 的 MCP 服务器`);
    return call(Ipc.engineSaveMcpServers, { configs: next });
  },
  "settings.set": async (input) => {
    const patch = input.patch;
    if (!patch || typeof patch !== "object" || Array.isArray(patch)) throw new Error("patch 必须是一个对象");
    for (const key of Object.keys(patch)) {
      const blocked = BLOCKED_SETTINGS.find(([pattern]) => pattern.test(key));
      if (blocked) throw new Error(`${key}：${blocked[1]}`);
    }
    const current = await call<Record<string, unknown>>(Ipc.settingsGet);
    await call(Ipc.settingsSet, { ...current, ...patch });
    return call(Ipc.settingsGet);
  },
};

/** The host side of the `fastvibe_config_*` tools. Never throws: errors are data for the agent. */
export async function runAppConfig(request: AppConfigHostRequest): Promise<AppConfigHostResult> {
  if (!isAppConfigAction(request.action)) {
    return { ok: false, error: `未知动作：${request.action}。可用动作：\n${JSON.stringify(APP_CONFIG_CATALOG, null, 2)}` };
  }
  if (APP_CONFIG_CATALOG[request.action].kind === "write" && !request.write) {
    return { ok: false, error: `${request.action} 是写入动作，请用 fastvibe_config_apply` };
  }
  try {
    return { ok: true, value: await ACTIONS[request.action](request.input ?? {}) };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}
