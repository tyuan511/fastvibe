import { Type } from "typebox";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

/**
 * The agent's hands on FastVibe's own settings panes.
 *
 * A setup like 远程访问 → frp spans two machines: a server the user owns (install frps,
 * open a port) and a form on this one. The agent already does the first half with bash
 * and ssh; these two tools are the second half. The playbook for using them lives in the
 * `fastvibe-setup` skill (`resources/skills/fastvibe-setup/SKILL.md`).
 *
 * Holds no settings code: every call crosses into Main's allowlist
 * (`src/main/app-config.ts`) through `ctx.ui.appConfig`, which dispatches the same
 * methods the panes call. The action catalog is Main's too — `overview` returns it — so
 * this file never has to be edited when an action is added.
 */

type AppConfigResult = { ok: true; value: unknown } | { ok: false; error: string };

type AppConfigHost = {
  appConfig?(request: { action: string; input?: Record<string, unknown>; write?: boolean }): Promise<AppConfigResult>;
};

const T = (zh: string, en: string): string => (process.env.FASTVIBE_UI_LANGUAGE === "en" ? en : zh);

function hostOf(ctx: ExtensionContext): AppConfigHost {
  return ctx.ui as unknown as AppConfigHost;
}

function text(value: unknown): string {
  return typeof value === "string" ? value : JSON.stringify(value, null, 2);
}

function reply(result: AppConfigResult, action: string) {
  return result.ok
    ? { content: [{ type: "text" as const, text: text(result.value) }], details: { action, ok: true } }
    : { content: [{ type: "text" as const, text: result.error }], details: { action, ok: false }, isError: true };
}

const unsupported = (action: string) => ({
  content: [{ type: "text" as const, text: T("当前宿主不支持修改 FastVibe 设置。", "This host cannot change FastVibe settings.") }],
  details: { action, ok: false },
  isError: true,
});

const params = Type.Object({
  action: Type.String({ description: "Action name from the catalog, e.g. overview, remote.status, remote.frp_set" }),
  input: Type.Optional(Type.Record(Type.String(), Type.Unknown(), { description: "Action input; see the catalog's summary for its fields" })),
});

export default function appConfigExtension(pi: ExtensionAPI): void {
  pi.registerTool({
    name: "fastvibe_config_get",
    label: T("读取 FastVibe 设置", "Read FastVibe settings"),
    description: [
      "Read FastVibe's own configuration (the app you are running in): remote access and its tunnel,",
      "the frp form, SSH hosts, MCP servers, UI settings. Call with action \"overview\" first —",
      "it returns the full action catalog (every read and write action with its input fields) plus current state.",
      "Never returns secrets.",
    ].join(" "),
    promptSnippet: "Read FastVibe's own settings (remote access, tunnels, frp, MCP, SSH hosts)",
    promptGuidelines: [
      "When the user asks to set up or change a FastVibe feature (远程访问 / 内网穿透 / frp / MCP / 设置项), follow the fastvibe-setup skill and start with fastvibe_config_get({ action: \"overview\" }).",
    ],
    parameters: params,
    async execute(_id, input, _signal, _onUpdate, ctx) {
      const host = hostOf(ctx);
      if (!host.appConfig) return unsupported(input.action);
      return reply(await host.appConfig({ action: input.action, input: input.input ?? {} }), input.action);
    },
  });

  pi.registerTool({
    name: "fastvibe_config_apply",
    label: T("修改 FastVibe 设置", "Change FastVibe settings"),
    description: [
      "Change FastVibe's own configuration through the same methods its settings panes call; the panes update live.",
      "Write actions come from the catalog fastvibe_config_get({ action: \"overview\" }) returns.",
      "remote.set_password takes no input: the user types the password into a prompt and it never reaches you.",
      "Permission-related settings cannot be changed here.",
    ].join(" "),
    promptSnippet: "Change FastVibe's own settings (fill the remote access / frp / MCP forms for the user)",
    promptGuidelines: [
      "Before a change the user did not spell out (turning remote access on, publishing it through a tunnel), say what you are about to change and why.",
      "Never ask the user to paste the remote-access password into the chat; call remote.set_password and let the prompt collect it.",
      "After remote.start, poll remote.status until tunnel.phase is online or error; report tunnel.url, or tunnel.error with the last lines of tunnel.output.",
    ],
    parameters: params,
    async execute(_id, input, _signal, _onUpdate, ctx) {
      const host = hostOf(ctx);
      if (!host.appConfig) return unsupported(input.action);
      const action = input.action;
      let payload: Record<string, unknown> = { ...(input.input ?? {}) };

      if (action === "remote.set_password") {
        // Collected here and handed to Main directly, so the model never holds a
        // credential that unlocks a shell on this machine.
        const password = await ctx.ui.input(
          T("设置远程访问密码（至少 8 位；不会发送给模型）", "Set the remote-access password (8+ characters; never sent to the model)"),
          T("远程访问密码", "Remote-access password"),
        );
        if (!password) {
          return { content: [{ type: "text" as const, text: T("用户没有填写密码，未作修改。", "The user did not enter a password; nothing changed.") }], details: { action, ok: false }, isError: true };
        }
        payload = { password };
      } else if (process.env.FASTVIBE_PERMISSION_MODE !== "full") {
        const shown = Object.keys(payload).length > 0 ? `\n${JSON.stringify(redact(payload), null, 2)}` : "";
        const approved = await ctx.ui.confirm(T("修改 FastVibe 设置", "Change FastVibe settings"), `${action}${shown}`);
        if (!approved) {
          return { content: [{ type: "text" as const, text: T("用户拒绝了这次设置修改。", "The user declined this settings change.") }], details: { action, ok: false }, isError: true };
        }
      }

      return reply(await host.appConfig({ action, input: payload, write: true }), action);
    },
  });
}

/** The confirm panel shows what will change, but not a token the user may be screen-sharing. */
function redact(value: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value)) {
    out[key] = /token|secret|password|key/i.test(key) && typeof item === "string" && item ? "••••••" : item;
  }
  return out;
}
