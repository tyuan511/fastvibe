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
 *   full   完全访问 不询问
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
const T = (zh: string, en: string): string => (process.env.FASTVIBE_UI_LANGUAGE === "en" ? en : zh);

function modeLabel(mode: PermissionMode): string {
  if (mode === "ask") return T("请求批准", "Ask first");
  if (mode === "smart") return T("帮我批准", "Smart");
  return T("完全访问", "Full access");
}

function modeDescription(mode: PermissionMode): string {
  if (mode === "ask") return T("编辑外部文件和使用互联网时始终询问", "Always ask before editing outside files or using the network");
  if (mode === "smart") return T("仅对检测到的风险操作请求批准", "Ask only for detected risky operations");
  return T("可不受限制地访问互联网和你电脑上的任何文件", "Unrestricted access to the internet and any file on your computer");
}

/** Tools with no side effects; they are never worth a confirmation. */
const READ_ONLY_TOOLS = new Set(["read", "grep", "find", "ls", "todo", "conversation_search", "worktree_list"]);

/** Built-in network lookup; `ask` confirms it, `smart` does not. */
const NETWORK_TOOLS = new Set(["web_search"]);

/** Built-in tools this extension knows how to classify. */
const KNOWN_TOOLS = new Set([
  "read",
  "write",
  "edit",
  "bash",
  "powershell",
  "grep",
  "find",
  "ls",
  "worktree_create",
  "worktree_bind",
  "worktree_unbind",
]);

/**
 * Cua-driven desktop control, split by whether the call changes anything.
 *
 * Observation is classified as neither network nor external, so it confirms in no mode —
 * a loop that has to ask before every screenshot is a loop nobody will use. Note that
 * this does mean a full-desktop capture reaches the model without a prompt.
 *
 * The action tools are marked `external`, because "outside the workspace" is exactly
 * what they are: they reach applications and documents the conversation never named, on
 * a desktop the user may be using at the same time. That places them under `smart` and
 * `ask` alongside a write outside the project — and, like every other tool, outside
 * `full`, which promises no prompts at all.
 */
const COMPUTER_OBSERVE_TOOLS = new Set([
  "computer_screenshot",
  "computer_list_apps",
  "computer_list_windows",
  "computer_window_state",
  "computer_clipboard_read",
]);

const COMPUTER_ACTION_TOOLS = new Set([
  "computer_click",
  "computer_type",
  "computer_key",
  "computer_hotkey",
  "computer_scroll",
  "computer_menu",
  "computer_clipboard_write",
  "computer_batch",
]);

/** The step actions inside a batch that change something, named as the bridge names them. */
const BATCH_ACTING_STEPS = new Set(["click", "type", "key", "hotkey", "scroll", "menu", "clipboard_write"]);

/**
 * A batch is confirmed once, for the sequence as a whole.
 *
 * Asking per step would defeat the reason the batch exists — the point is to stop
 * charging a round trip and a dialog to each click — but a single "run 6 actions?" is
 * not consent either. So the prompt lists what the sequence will do, in order, and the
 * user agrees to that list rather than to a count.
 */
function describeBatch(input: unknown): string | undefined {
  const steps = input && typeof input === "object" ? (input as Record<string, unknown>).steps : undefined;
  if (!Array.isArray(steps) || steps.length === 0) return undefined;
  const acting = steps.filter(
    (step) => step && typeof step === "object" && BATCH_ACTING_STEPS.has(String((step as Record<string, unknown>).action)),
  );
  // Observation-only sequences change nothing; they are not what the dialog is for.
  if (acting.length === 0) return undefined;
  const parts = steps.map((step) => {
    const record = (step ?? {}) as Record<string, unknown>;
    const action = String(record.action ?? "?");
    const text = typeof record.text === "string" ? record.text : "";
    if (action === "type" && text) return T(`输入「${firstLine(text, 24)}」`, `type "${firstLine(text, 24)}"`);
    if (action === "key" && typeof record.key === "string") return T(`按 ${record.key}`, `press ${record.key}`);
    if (action === "menu" && Array.isArray(record.path)) return T(`菜单 ${record.path.join(" › ")}`, `menu ${record.path.join(" › ")}`);
    return action;
  });
  // Long sequences are summarised rather than truncated mid-list: a dialog the user
  // cannot read in one glance is one they will approve without reading.
  const shown = parts.slice(0, 6).join(" → ");
  return parts.length > 6
    ? T(`${shown} …共 ${parts.length} 步`, `${shown} … ${parts.length} steps in total`)
    : shown;
}

/**
 * 始终允许的应用, as 设置 › 电脑操控 wrote them.
 *
 * Passed through the environment for the same reason the permission mode is: this file
 * is loaded from outside the bundle and cannot read FastVibe's settings store. Main
 * re-exports it whenever the list changes, and it is re-read per call so an app added
 * mid-run takes effect without restarting the session.
 */
const ALLOWED_APPS_ENV = "FASTVIBE_COMPUTER_ALLOWED_APPS";

function allowedApps(): string[] {
  const raw = process.env[ALLOWED_APPS_ENV];
  if (!raw) return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === "string") : [];
  } catch {
    return [];
  }
}

/**
 * Which application a `computer_*` call targets, asked of the bridge in Main.
 *
 * The tool arguments carry a pid, and a pid means nothing to a user reading a dialog.
 * The bridge is in this same process and already caches the mapping, so resolving it
 * here costs a map lookup and turns 「操作 pid 4711」 into 「操作 Microsoft Excel」.
 */
async function computerApp(input: unknown): Promise<{ name: string; bundleId?: string } | undefined> {
  const pid = input && typeof input === "object" ? (input as Record<string, unknown>).pid : undefined;
  if (typeof pid !== "number") return undefined;
  const resolve = (globalThis as Record<string, unknown>).__fastvibeComputerAppForPid;
  if (typeof resolve !== "function") return undefined;
  try {
    return (await (resolve as (pid: number) => Promise<{ name: string; bundleId?: string } | undefined>)(pid)) ?? undefined;
  } catch {
    return undefined;
  }
}

/** What the confirmation dialog shows: the intended effect, not the tool name. */
function describeComputer(toolName: string, input: unknown): string {
  const text = inputString(input, "text");
  const key = inputString(input, "key");
  if (toolName === "computer_type" && text) return T(`输入「${firstLine(text, 80)}」`, `Type "${firstLine(text, 80)}"`);
  if (toolName === "computer_clipboard_write" && text) return T("写入剪贴板", "Write to the clipboard");
  if (toolName === "computer_key" && key) return T(`按下 ${key}`, `Press ${key}`);
  if (toolName === "computer_menu") {
    const path = input && typeof input === "object" ? (input as Record<string, unknown>).path : undefined;
    if (Array.isArray(path)) return T(`菜单 ${path.join(" › ")}`, `Menu ${path.join(" › ")}`);
  }
  if (toolName === "computer_batch") return describeBatch(input) ?? toolName;
  return toolName;
}

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

const LABEL_EN: Record<string, string> = {
  递归删除文件: "Recursive delete",
  强制删除文件: "Force delete",
  提权执行: "Privilege escalation",
  开放全部权限: "chmod 777",
  递归修改所有者: "Recursive chown",
  磁盘级操作: "Disk-level operation",
  关机或重启: "Shutdown or reboot",
  批量结束进程: "Kill processes",
  管道执行脚本: "Pipe into a shell",
  强制推送: "Force push",
  丢弃本地改动: "Discard local changes",
  发布软件包: "Publish a package",
  写入磁盘设备: "Write to a disk device",
  修改系统账号文件: "Modify system account files",
  环境变量文件: "Environment file",
  "Git 内部目录": "Git internals",
  "SSH 密钥": "SSH key",
  云凭证: "Cloud credentials",
  私钥或证书: "Private key or certificate",
  包管理器凭证: "Package-manager credentials",
};

function matchedLabels(rules: Array<{ label: string; pattern: RegExp }>, text: string): string[] {
  return rules.filter((rule) => rule.pattern.test(text)).map((rule) => T(rule.label, LABEL_EN[rule.label] ?? rule.label));
}

/** Classify a tool call, or `null` when it can never need a confirmation. */
function assess(toolName: string, input: unknown, cwd: string): Assessment | null {
  if (READ_ONLY_TOOLS.has(toolName)) return null;

  if (NETWORK_TOOLS.has(toolName)) {
    return {
      action: T("搜索网络", "Search the web"),
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
      action: T("运行命令", "Run command"),
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
      action: T("写入文件", "Write file"),
      detail: raw,
      network: false,
      external: !isInside(cwd, absolute),
      risks: matchedLabels(SENSITIVE_PATH_RULES, absolute),
      opaque: false,
    };
  }

  if (COMPUTER_OBSERVE_TOOLS.has(toolName)) {
    return {
      action: T("查看电脑屏幕", "Read the screen"),
      detail: toolName,
      network: false,
      external: false,
      risks: [],
      opaque: false,
    };
  }

  // A batch that only looks at things belongs with the observation tools, not with the
  // ones that change something.
  if (toolName === "computer_batch" && !describeBatch(input)) {
    return {
      action: T("查看电脑屏幕", "Read the screen"),
      detail: toolName,
      network: false,
      external: false,
      risks: [],
      opaque: false,
    };
  }

  if (COMPUTER_ACTION_TOOLS.has(toolName)) {
    return {
      action: T("操作电脑", "Control the computer"),
      detail: describeComputer(toolName, input),
      network: false,
      external: true,
      risks: [T("操作其他应用", "Control another application")],
      opaque: false,
    };
  }

  if (KNOWN_TOOLS.has(toolName)) return null;

  // Custom / MCP tool: scan the serialized arguments so an obviously destructive
  // call is still caught even though the tool itself is unknown.
  const serialized = JSON.stringify(input ?? {}).slice(0, 4000);
  return {
    action: T("调用工具", "Call tool"),
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
  if (assessment.network) reasons.push(T("访问网络", "Network access"));
  if (assessment.external) reasons.push(T("修改工作区外的文件", "Modify files outside the workspace"));
  reasons.push(...assessment.risks);
  if (assessment.opaque && reasons.length === 0) reasons.push(T("外部工具，无法预判其行为", "External tool; behaviour cannot be predicted"));
  return reasons.length > 0 ? reasons : [T("当前权限模式要求确认", "The current permission mode requires confirmation")];
}

function describeCommand(mode: PermissionMode): string {
  return [
    T(`当前权限模式：${modeLabel(mode)}（${modeDescription(mode)}）`, `Permission mode: ${modeLabel(mode)} (${modeDescription(mode)})`),
    "",
    T("沙箱规则：", "Sandbox rules:"),
    T("· 请求批准：外部文件写入、联网、风险操作、外部工具都询问。", "· Ask first: confirm outside writes, network, risky operations and unknown tools."),
    T("· 帮我批准：仅在检测到风险操作时询问（含外部文件写入）。", "· Smart: confirm only detected risky operations (including outside writes)."),
    T("· 完全访问：不询问。", "· Full access: never ask."),
    "",
    T("在输入框的权限菜单中切换模式。", "Switch modes from the permission menu above the composer."),
  ].join("\n");
}

export default function permissionSandbox(pi: ExtensionAPI): void {
  pi.on("tool_call", async (event, ctx) => {
    const mode = currentMode();
    if (mode === "full") return undefined;

    const assessment = assess(event.toolName, event.input, ctx.cwd);
    if (!assessment || !shouldConfirm(mode, assessment)) return undefined;

    if (COMPUTER_ACTION_TOOLS.has(event.toolName)) {
      const target = await computerApp(event.input);
      // 始终允许的应用: the user has already said yes to this application, for good.
      // Matched on bundle id first because a display name is not an identity — two
      // applications can share one, and a rename must not silently widen the list.
      const allowed = allowedApps();
      if (target && (allowed.includes(target.bundleId ?? " ") || allowed.includes(target.name))) {
        return undefined;
      }
      // Name the application in the dialog. 「在 Microsoft Excel 中点击」 is a question
      // the user can answer; 「computer_click」 is not.
      if (target) {
        assessment.detail = T(`在 ${target.name} 中${assessment.detail}`, `${assessment.detail} in ${target.name}`);
      }
    }

    const reasons = reasonsFor(assessment);
    if (!ctx.hasUI) {
      return {
        block: true,
        reason: T(`权限模式「${modeLabel(mode)}」需要确认（${reasons.join("、")}），但当前会话没有确认界面。`, `Permission mode "${modeLabel(mode)}" needs confirmation (${reasons.join(", ")}), but this session has no confirm UI.`),
      };
    }

    const message = `${assessment.action}：${assessment.detail}`;

    const approved = await ctx.ui.confirm(T("FastVibe 操作确认", "FastVibe wants to run an action"), message);
    if (!approved) {
      return { block: true, reason: T(`用户未批准该操作（${reasons.join("、")}）`, `The user denied this action (${reasons.join(", ")})`) };
    }
    return undefined;
  });

  pi.registerCommand("permissions", {
    description: "Show the current permission mode",
    handler: async (_args, ctx) => {
      ctx.ui.notify(describeCommand(currentMode()), "info");
    },
  });
}
