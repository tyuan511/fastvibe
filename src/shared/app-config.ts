/**
 * The catalog of what the agent may do to FastVibe's own configuration.
 *
 * Main implements exactly these names (`src/main/app-config.ts` is typed against this
 * list, so an action cannot be offered without an implementation) and serves the list
 * itself to the model: `overview` carries it, and so does every unknown-action error.
 * The extension cannot import it — built-in extensions ship as loose files outside the
 * bundle, with no `@shared` to resolve — so it never restates the list either.
 */
export const APP_CONFIG_CATALOG = {
  overview: { kind: "read", summary: "一次读取远程访问状态、SSH 主机和 MCP 服务器" },
  "remote.status": { kind: "read", summary: "远程访问的当前状态：局域网监听、官方连接（同账号手机能否发现这台电脑）和已连接的手机" },
  "ssh.hosts": { kind: "read", summary: "FastVibe 里保存的和 ~/.ssh/config 里发现的 SSH 主机（不含密码）" },
  "mcp.list": { kind: "read", summary: "MCP 服务器配置与连接状态" },
  "settings.get": { kind: "read", summary: "settings.json 里的界面与对话偏好" },

  "remote.set_password": { kind: "write", summary: "设置远程访问密码：用户在输入框里填写，不经过模型，input 不需要任何字段" },
  "remote.start": { kind: "write", summary: "打开远程访问：设了密码就启动局域网监听，登录了账号就接入官方连接；input: { port?: number }" },
  "remote.stop": { kind: "write", summary: "关闭远程访问：停止局域网监听，并断开官方连接" },
  "mcp.upsert": {
    kind: "write",
    summary: "新增或按 id 替换一个 MCP 服务器；input: { server: { id, name, enabled?, transport: \"stdio\"|\"http\", command?, args?, env?, url? } }",
  },
  "mcp.remove": { kind: "write", summary: "按 id 删除一个 MCP 服务器；input: { id }" },
  "settings.set": { kind: "write", summary: "合并写入 settings.json；input: { patch: {...} }。远程访问、代理相关键会被拒绝" },
} as const satisfies Record<string, { kind: "read" | "write"; summary: string }>;

export type AppConfigAction = keyof typeof APP_CONFIG_CATALOG;

export function isAppConfigAction(value: unknown): value is AppConfigAction {
  return typeof value === "string" && Object.hasOwn(APP_CONFIG_CATALOG, value);
}

export type AppConfigHostRequest = {
  action: string;
  input?: Record<string, unknown>;
  /** Set only by `fastvibe_config_apply`, so the read tool cannot reach a write. */
  write?: boolean;
};

export type AppConfigHostResult = { ok: true; value: unknown } | { ok: false; error: string };
