import { homedir } from "node:os";
import { isAbsolute, join, relative, resolve } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { PermissionMode } from "@shared/types";

/**
 * FastVibe's built-in permission sandbox — the enforcement half of the
 * composer's three permission modes. The renderer owns *which* mode is active
 * (Settings + the composer chip); this extension owns *what that mode means* for
 * tool calls, and asks through `ctx.ui.confirm`, which the desktop host renders
 * as the permission dialog.
 *
 *   ask    请求批准    外部文件写入 + 联网 + 风险操作都询问
 *   smart  帮我批准    只询问检测到的风险操作（含外部文件写入）
 *   full   完全访问权限 不询问
 *
 * The active mode is read from `FASTVIBE_PERMISSION_MODE`, which the Electron
 * main process keeps in sync with `settings.json`. It is re-read on every tool
 * call, so switching modes applies to a session that is already running. An
 * unset or unknown value falls back to `full` (the app default).
 *
 * Custom / MCP tools cannot be classified from their name or schema, so `ask`
 * confirms them by default; `smart` only confirms them when their arguments
 * happen to match a known risk pattern.
 */
const MODE_ENV = "FASTVIBE_PERMISSION_MODE";

const MODE_LABELS: Record<PermissionMode, string> = {
  ask: "请求批准",
  smart: "帮我批准",
  full: "完全访问权限",
};

const MODE_DESCRIPTIONS: Record<PermissionMode, string> = {
  ask: "编辑外部文件和使用互联网时始终询问",
  smart: "仅对检测到的风险操作请求批准",
  full: "可不受限制地访问互联网和你电脑上的任何文件",
};

/** Tools with no side effects; they are never worth a confirmation. */
const READ_ONLY_TOOLS = new Set(["read", "grep", "find", "ls", "todo"]);

/** Built-in network lookup; `ask` confirms it, `smart` does not. */
const NETWORK_TOOLS = new Set(["web_search"]);

/** Built-in tools this extension knows how to classify. */
const KNOWN_TOOLS = new Set(["read", "write", "edit", "bash", "powershell", "grep", "find", "ls"]);

/** Shell activity that reaches the network ("使用互联网"). */
const NETWORK_RULES: RegExp[] = [
  /\b(curl|wget)\b/i,
  /\b(ssh|scp|sftp|rsync|telnet|nc|ncat|netcat|ftp|tftp)\b/i,
  /\b(ping|traceroute|dig|nslookup|whois)\b/i,
  /\bhttps?:\/\/\S+/i,
  /\bgit\b[^;&|]*\b(clone|fetch|pull|push|ls-remote|remote\s+(add|set-url)|submodule)\b/i,
  /\b(npm|pnpm|yarn|bun)\b[^;&|]*\b(install|i|add|ci|publish|unpublish|update|upgrade|deprecate|exec|dlx|create)\b/i,
  /\b(pip|pip3|uv|poetry|conda)\b[^;&|]*\b(install|download|add|sync|lock|update|upgrade)\b/i,
  /\b(cargo|go|gem|composer|dotnet)\b[^;&|]*\b(install|add|get|publish|update|push|restore)\b/i,
  /\b(gh|glab|hub)\b/i,
  /\b(aws|gcloud|az|kubectl|helm|terraform|ansible)\b/i,
  /\b(docker|podman|nerdctl)\b[^;&|]*\b(pull|push|login|run|build)\b/i,
  /\b(brew|apt|apt-get|yum|dnf|pacman|apk|snap|zypper)\b[^;&|]*\b(install|update|upgrade|add|remove)\b/i,
];

/** Operations `smart` treats as "检测到的风险操作". */
const RISK_RULES: Array<{ label: string; pattern: RegExp }> = [
  { label: "递归删除文件", pattern: /\brm\b[^;&|]*\s-[a-z]*r/i },
  { label: "强制删除文件", pattern: /\brm\b[^;&|]*\s-[a-z]*f/i },
  { label: "提权执行", pattern: /\b(sudo|doas)\b/i },
  { label: "开放全部权限", pattern: /\bchmod\b[^;&|]*\s777\b/i },
  { label: "递归修改所有者", pattern: /\bchown\b[^;&|]*-R\b/i },
  { label: "磁盘级操作", pattern: /\b(mkfs|fdisk|parted|dd)\b/i },
  { label: "关机或重启", pattern: /\b(shutdown|reboot|halt|poweroff)\b/i },
  { label: "批量结束进程", pattern: /\b(killall|pkill)\b/i },
  { label: "管道执行脚本", pattern: /\|\s*(sudo\s+)?(sh|bash|zsh|dash|python3?|node|perl|ruby)\b/i },
  { label: "强制推送", pattern: /\bgit\b[^;&|]*\bpush\b[^;&|]*\s(-f|--force|--force-with-lease)\b/i },
  {
    label: "丢弃本地改动",
    pattern: /\bgit\b[^;&|]*\b(reset\s+--hard|clean\b[^;&|]*-[a-z]*f|branch\b[^;&|]*-D|checkout\s+--?\s*\.)/i,
  },
  { label: "发布软件包", pattern: /\b(npm|pnpm|yarn|bun)\b[^;&|]*\b(publish|unpublish)\b/i },
  { label: "写入磁盘设备", pattern: />\s*\/dev\/(sd|disk|nvme|rdisk)/i },
  { label: "修改系统账号文件", pattern: /\/etc\/(passwd|shadow|sudoers|hosts)\b/i },
];

/** Files `smart` should not let the agent rewrite silently. */
const SENSITIVE_PATH_RULES: Array<{ label: string; pattern: RegExp }> = [
  { label: "环境变量文件", pattern: /(^|[/\\])\.env(\.[^/\\]+)?$/i },
  { label: "Git 内部目录", pattern: /(^|[/\\])\.git([/\\]|$)/i },
  { label: "SSH 密钥", pattern: /(^|[/\\])\.ssh([/\\]|$)|(^|[/\\])id_(rsa|ed25519|ecdsa)(\.[^/\\]+)?$/i },
  { label: "云凭证", pattern: /(^|[/\\])\.(aws|gnupg|kube|docker)([/\\]|$)|(^|[/\\])credentials(\.json)?$/i },
  { label: "私钥或证书", pattern: /\.(pem|key|p12|pfx|keystore)$/i },
  { label: "包管理器凭证", pattern: /(^|[/\\])\.(npmrc|pypirc)$/i },
];

type Assessment = {
  /** The shell command or file path being acted on, for the dialog. */
  detail: string;
  /** Short verb describing the action ("运行命令", "写入文件", …). */
  action: string;
  /** The command reaches the network. */
  network: boolean;
  /** The write/edit target lives outside the workspace. */
  external: boolean;
  /** Detected risky operations, in human-readable Chinese. */
  risks: string[];
  /** A tool whose behaviour cannot be inferred (custom / MCP). */
  opaque: boolean;
};

function currentMode(): PermissionMode {
  const raw = process.env[MODE_ENV];
  return raw === "ask" || raw === "smart" || raw === "full" ? raw : "full";
}

function inputString(input: unknown, key: string): string {
  if (!input || typeof input !== "object") return "";
  const value = (input as Record<string, unknown>)[key];
  return typeof value === "string" ? value : "";
}

function firstLine(text: string, limit = 300): string {
  const line = text.split(/\r?\n/, 1)[0]?.trim() ?? "";
  return line.length > limit ? `${line.slice(0, limit)}…` : line;
}

function resolveToolPath(cwd: string, raw: string): string {
  const trimmed = raw.trim();
  const expanded = trimmed === "~" || trimmed.startsWith("~/") ? join(homedir(), trimmed.slice(1)) : trimmed;
  return resolve(cwd, expanded);
}

function isInside(root: string, target: string): boolean {
  const rel = relative(root, target);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

function matchedLabels(rules: Array<{ label: string; pattern: RegExp }>, text: string): string[] {
  return rules.filter((rule) => rule.pattern.test(text)).map((rule) => rule.label);
}

/** Classify a tool call, or `null` when it can never need a confirmation. */
function assess(toolName: string, input: unknown, cwd: string): Assessment | null {
  if (READ_ONLY_TOOLS.has(toolName)) return null;

  if (NETWORK_TOOLS.has(toolName)) {
    return {
      action: "搜索网络",
      detail: firstLine(inputString(input, "query") || toolName),
      network: true,
      external: false,
      risks: [],
      opaque: false,
    };
  }

  if (toolName === "bash" || toolName === "powershell") {
    const command = inputString(input, "command");
    if (!command) return null;
    return {
      action: "运行命令",
      detail: firstLine(command),
      network: NETWORK_RULES.some((rule) => rule.test(command)),
      external: false,
      risks: matchedLabels(RISK_RULES, command),
      opaque: false,
    };
  }

  if (toolName === "write" || toolName === "edit") {
    const raw = inputString(input, "path");
    if (!raw) return null;
    const absolute = resolveToolPath(cwd, raw);
    return {
      action: "写入文件",
      detail: raw,
      network: false,
      external: !isInside(cwd, absolute),
      risks: matchedLabels(SENSITIVE_PATH_RULES, absolute),
      opaque: false,
    };
  }

  if (KNOWN_TOOLS.has(toolName)) return null;

  // Custom / MCP tool: scan the serialized arguments so an obviously destructive
  // call is still caught even though the tool itself is unknown.
  const serialized = JSON.stringify(input ?? {}).slice(0, 4000);
  return {
    action: "调用工具",
    detail: toolName,
    network: NETWORK_RULES.some((rule) => rule.test(serialized)),
    external: false,
    risks: matchedLabels(RISK_RULES, serialized),
    opaque: true,
  };
}

function shouldConfirm(mode: PermissionMode, assessment: Assessment): boolean {
  if (mode === "full") return false;
  if (assessment.opaque) return mode === "ask" || assessment.risks.length > 0;
  if (mode === "ask") return assessment.network || assessment.external || assessment.risks.length > 0;
  return assessment.external || assessment.risks.length > 0;
}

function reasonsFor(assessment: Assessment): string[] {
  const reasons: string[] = [];
  if (assessment.network) reasons.push("访问网络");
  if (assessment.external) reasons.push("修改工作区外的文件");
  reasons.push(...assessment.risks);
  if (assessment.opaque && reasons.length === 0) reasons.push("外部工具，无法预判其行为");
  return reasons.length > 0 ? reasons : ["当前权限模式要求确认"];
}

function describeCommand(mode: PermissionMode): string {
  return [
    `当前权限模式：${MODE_LABELS[mode]}（${MODE_DESCRIPTIONS[mode]}）`,
    "",
    "沙箱规则：",
    "· 请求批准：外部文件写入、联网、风险操作、外部工具都询问。",
    "· 帮我批准：仅在检测到风险操作时询问（含外部文件写入）。",
    "· 完全访问权限：不询问。",
    "",
    "在输入框的权限菜单中切换模式。",
  ].join("\n");
}

export default function permissionSandbox(pi: ExtensionAPI): void {
  pi.on("tool_call", async (event, ctx) => {
    const mode = currentMode();
    if (mode === "full") return undefined;

    const assessment = assess(event.toolName, event.input, ctx.cwd);
    if (!assessment || !shouldConfirm(mode, assessment)) return undefined;

    const reasons = reasonsFor(assessment);
    if (!ctx.hasUI) {
      return {
        block: true,
        reason: `权限模式「${MODE_LABELS[mode]}」需要确认（${reasons.join("、")}），但当前会话没有确认界面。`,
      };
    }

    const message = `${assessment.action}：${assessment.detail}`;

    const approved = await ctx.ui.confirm("FastVibe 操作确认", message);
    if (!approved) {
      return { block: true, reason: `用户未批准该操作（${reasons.join("、")}）` };
    }
    return undefined;
  });

  pi.registerCommand("permissions", {
    description: "查看当前权限模式（请求批准 / 帮我批准 / 完全访问权限）",
    handler: async (_args, ctx) => {
      ctx.ui.notify(describeCommand(currentMode()), "info");
    },
  });
}
