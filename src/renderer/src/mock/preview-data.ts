import type {
  ChatMessage,
  ImportCandidate,
  ImportSourceStatus,
  Conversation,
  DirEntry,
  EngineSessionState,
  ExtensionPackage,
  FastVibeModel,
  FilePreview,
  MarketPackage,
  McpServerStatus,
  Project,
  ProviderConfig,
  SessionStats,
  SkillInfo,
  SlashCommand,
  ToolCallBlock,
  UsageStats,
} from "@shared/types";

/**
 * Rich, hand-written fixtures for the browser preview harness (`mock.html`).
 * Nothing here is persisted: it only exists so the renderer can be rendered with
 * representative content for documentation screenshots and visual review.
 */

const NOW = Date.now();
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

export const PREVIEW_CWD = "/Users/dev/code/fastvibe";
export const SECOND_CWD = "/Users/dev/code/paper-trail";

export const PROJECTS: Project[] = [
  { cwd: PREVIEW_CWD, name: "fastvibe", createdAt: NOW - 12 * DAY, updatedAt: NOW - 2 * MINUTE },
  { cwd: SECOND_CWD, name: "paper-trail", createdAt: NOW - 30 * DAY, updatedAt: NOW - 3 * DAY },
];

export const CONVERSATIONS: Conversation[] = [
  {
    id: "conv-theme",
    title: "设置里的主题模式",
    cwd: PREVIEW_CWD,
    project: PREVIEW_CWD,
    createdAt: NOW - 26 * MINUTE,
    updatedAt: NOW - 2 * MINUTE,
    preview: "已为 设置 → 通用 补上「跟随系统」的主题模式入口，并注册了 ⌘J 快捷键。",
    sessionId: "sess-theme",
  },
  {
    id: "conv-plugins",
    title: "梳理 pi 扩展的加载流程",
    cwd: PREVIEW_CWD,
    project: PREVIEW_CWD,
    createdAt: NOW - 5 * HOUR,
    updatedAt: NOW - 5 * HOUR,
    preview: "内置扩展在 agentDir 下随会话绑定，用户安装的包走 DefaultPackageManager。",
    sessionId: "sess-plugins",
  },
  {
    id: "conv-queue",
    title: "修复消息队列重复发送",
    cwd: PREVIEW_CWD,
    project: PREVIEW_CWD,
    createdAt: NOW - 2 * DAY,
    updatedAt: NOW - 2 * DAY,
    preview: "队列排空改成循环消费，并在 queuePause 时停止下一轮派发。",
    sessionId: "sess-queue",
  },
  {
    id: "conv-cowork",
    title: "多智能体协作的入口设计",
    cwd: PREVIEW_CWD,
    project: PREVIEW_CWD,
    createdAt: NOW - 4 * DAY,
    updatedAt: NOW - 4 * DAY,
    preview: "每个 agent 一条独立会话，共享同一个工作区与改动审查。",
    sessionId: "sess-cowork",
  },
  {
    id: "conv-paper",
    title: "论文摘录的自动归档",
    cwd: SECOND_CWD,
    project: SECOND_CWD,
    createdAt: NOW - 6 * DAY,
    updatedAt: NOW - 6 * DAY,
    preview: "按 DOI 去重后写入 SQLite FTS5 索引，摘要支持增量更新。",
    sessionId: "sess-paper",
  },
  {
    id: "conv-readme",
    title: "写一篇介绍 README",
    cwd: "/Users/dev/FastVibe/scratch",
    createdAt: NOW - 20 * HOUR,
    updatedAt: NOW - 20 * HOUR,
    preview: "突出 100% 兼容 pi 插件机制，用截图讲清每个界面。",
    sessionId: "sess-readme",
  },
  {
    id: "conv-weekly",
    title: "整理这周的改动",
    cwd: "/Users/dev/FastVibe/scratch",
    createdAt: NOW - 3 * DAY,
    updatedAt: NOW - 3 * DAY,
    preview: "把提交整理成易于阅读的周报，附带上线计划。",
    sessionId: "sess-weekly",
  },
];

const DIFF = `--- a/src/renderer/src/components/settings/settings-dialog.tsx
+++ b/src/renderer/src/components/settings/settings-dialog.tsx
@@ -209,6 +209,24 @@ export function SettingsDialog({
           {section === "general" ? (
             <div className="space-y-6">
               <Group title="外观">
+                <Row
+                  title="主题模式"
+                  description="跟随系统时随 macOS 外观自动切换"
+                  control={
+                    <Select
+                      items={THEME_MODE_ITEMS}
+                      value={settings.themeMode}
+                      onValueChange={(value) => update({ themeMode: value as ThemeMode })}
+                    >
+                      <SelectTrigger size="sm" className="w-36">
+                        <SelectValue />
+                      </SelectTrigger>
+                      <SelectContent>
+                        <SelectItem value="system">跟随系统</SelectItem>
+                        <SelectItem value="light">亮色</SelectItem>
+                        <SelectItem value="dark">暗色</SelectItem>
+                      </SelectContent>
+                    </Select>
+                  }
+                />
                 <Row
                   title="亮色主题"
                   description="亮色模式下使用的主题"`;

const SHORTCUT_DIFF = `--- a/src/renderer/src/App.tsx
+++ b/src/renderer/src/App.tsx
@@ -336,6 +336,14 @@ export function App(): JSX.Element {
         document.querySelector<HTMLButtonElement>('[aria-label="停止"]')?.click();
       }
+      // ⌘J / Ctrl+J toggles between the configured light and dark theme. In
+      // "system" mode the current effective theme is pinned first.
+      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "j") {
+        event.preventDefault();
+        const { themeMode, lightTheme, darkTheme } = useSettingsStore.getState().settings;
+        const next = themeMode === "system" ? (systemPrefersDark() ? "light" : "dark") : themeMode === "dark" ? "light" : "dark";
+        useSettingsStore.getState().update({ themeMode: next });
+      }`;

const READ_TOOL = (id: string, path: string): ToolCallBlock => ({
  id,
  name: "read",
  args: { path },
  status: "done",
});

const GREP_TOOL: ToolCallBlock = {
  id: "tool-grep",
  name: "grep",
  args: { search_query: "themeMode", path: "src/renderer" },
  status: "done",
};

const EDIT_TOOL: ToolCallBlock = {
  id: "tool-edit-settings",
  name: "edit",
  args: { path: `${PREVIEW_CWD}/src/renderer/src/components/settings/settings-dialog.tsx` },
  status: "done",
  details: { diff: DIFF, patch: DIFF },
};

const EDIT_SHORTCUT: ToolCallBlock = {
  id: "tool-edit-shortcut",
  name: "edit",
  args: { path: `${PREVIEW_CWD}/src/renderer/src/App.tsx` },
  status: "done",
  details: { diff: SHORTCUT_DIFF, patch: SHORTCUT_DIFF },
};

const TYPECHECK_TOOL: ToolCallBlock = {
  id: "tool-typecheck",
  name: "bash",
  args: { command: "pnpm typecheck" },
  status: "done",
  result: `> tsc --noEmit -p tsconfig.node.json && tsc --noEmit -p tsconfig.web.json

✓ 类型检查通过，0 个错误（node · web）`,
};

const FAILED_TERMINAL: ToolCallBlock = {
  id: "tool-bash-fail",
  name: "bash",
  args: {
    command: "cd /Users/dev/code/fastvibe && node /tmp/fvcheck/run.mjs 2>&1 | tail -20",
  },
  status: "error",
  result:
    "node:internal/modules/cjs/loader:1215\n" +
    "  throw err;\n" +
    "  ^\n\n" +
    "Error: Cannot find module '/tmp/fvcheck/run.mjs' imported from /Users/dev/code/fastvibe/[eval]\n" +
    "    at finalizeResolution (node:internal/modules/esm/resolve:283:11)\n" +
    "    at moduleResolve (node:internal/modules/esm/resolve:924:10)\n" +
    "    at defaultResolve (node:internal/modules/esm/resolve:1065:11)\n" +
    "    at ModuleLoader.#resolve (node:internal/modules/esm/loader:690:31)\n" +
    "    at ModuleLoader.resolve (node:internal/modules/esm/loader:559:15) {" +
    "\n  code: 'ERR_MODULE_NOT_FOUND'\n}",
};

const FAILED_BUILD: ToolCallBlock = {
  id: "tool-build-fail",
  name: "bash",
  args: { command: "cd /Users/dev/code/fastvibe && npx electron-vite build 2>&1 | tail -5" },
  status: "error",
  result: "error during build:\nError: Could not resolve \"./missing\" from src/renderer/src/App.tsx",
};

/* A failing `bash` call with a command too long for the row, so the preview
 * harness exercises the failure badge in the case that used to break it. */
const THINKING =
  "用户想要主题能跟随系统。先确认现有的 themeMode 值域（light / dark / system），以及设置页里到底暴露了哪些入口，避免重复实现。";

export const MESSAGES: ChatMessage[] = [
  {
    id: "msg-u1",
    role: "user",
    text: "帮我看看设置里的主题切换，再补一个「跟随系统」的选项。",
    tools: [],
    parts: [{ kind: "text", text: "帮我看看设置里的主题切换，再补一个「跟随系统」的选项。" }],
    createdAt: NOW - 24 * MINUTE,
  },
  {
    id: "msg-a1",
    role: "assistant",
    text: "我先定位主题选择器，以及主题是怎么应用和持久化的。",
    thinking: THINKING,
    tools: [
      READ_TOOL("tool-read-theme-select", `${PREVIEW_CWD}/src/renderer/src/components/settings/theme-select.tsx`),
      GREP_TOOL,
      READ_TOOL("tool-read-themes", `${PREVIEW_CWD}/src/renderer/src/lib/themes.ts`),
    ],
    parts: [
      { kind: "thinking", text: THINKING, startedAt: NOW - 23.6 * MINUTE, endedAt: NOW - 23.1 * MINUTE },
      { kind: "text", text: "我先定位主题选择器，以及主题是怎么应用和持久化的。" },
      { kind: "tool", toolId: "tool-read-theme-select" },
      { kind: "tool", toolId: "tool-grep" },
      { kind: "tool", toolId: "tool-read-themes" },
    ],
    createdAt: NOW - 23 * MINUTE,
    completedAt: NOW - 22.4 * MINUTE,
  },
  {
    id: "msg-a2",
    role: "assistant",
    text:
      "现有的 `themeMode` 已经支持 `light | dark | system`，但「通用」页里只暴露了亮色 / 暗色两个主题，" +
      "缺少切换模式的入口。我在「外观」分组补一个「主题模式」下拉。",
    tools: [EDIT_TOOL, TYPECHECK_TOOL],
    parts: [
      {
        kind: "text",
        text:
          "现有的 `themeMode` 已经支持 `light | dark | system`，但「通用」页里只暴露了亮色 / 暗色两个主题，" +
          "缺少切换模式的入口。我在「外观」分组补一个「主题模式」下拉。",
      },
      // A switch made mid-reply: the divider sits between the reply's own blocks.
      {
        kind: "model",
        from: { provider: "fastvibe", id: "claude-sonnet-4-5" },
        to: { provider: "deepseek", id: "deepseek-chat" },
      },
      { kind: "tool", toolId: "tool-edit-settings" },
      { kind: "tool", toolId: "tool-typecheck" },
    ],
    createdAt: NOW - 22 * MINUTE,
    completedAt: NOW - 21.2 * MINUTE,
  },
  {
    id: "msg-a3",
    role: "assistant",
    text:
      "已完成，改动集中在设置页：\n\n" +
      "- 「主题模式」下拉支持 跟随系统 / 亮色 / 暗色，写入 `settings.json`。\n" +
      "- `useThemeSync` 在跟随系统时监听 `prefers-color-scheme`，切换 macOS 外观即时生效。\n" +
      "- 亮色与暗色主题各自独立记忆，切换模式不会丢失选择。\n\n" +
      "需要的话，我可以再把它接进命令面板。",
    tools: [],
    parts: [
      {
        kind: "text",
        text:
          "已完成，改动集中在设置页：\n\n" +
          "- 「主题模式」下拉支持 跟随系统 / 亮色 / 暗色，写入 `settings.json`。\n" +
          "- `useThemeSync` 在跟随系统时监听 `prefers-color-scheme`，切换 macOS 外观即时生效。\n" +
          "- 亮色与暗色主题各自独立记忆，切换模式不会丢失选择。\n\n" +
          "需要的话，我可以再把它接进命令面板。",
      },
    ],
    createdAt: NOW - 21 * MINUTE,
    completedAt: NOW - 20.6 * MINUTE,
  },
  {
    id: "msg-compact",
    role: "system",
    text:
      "User asked to add a system-following theme mode in Settings. Located theme-select and themes.ts, then added a themeMode setting (light / dark / system) persisted in settings.json. useThemeSync now listens to prefers-color-scheme when mode is system.",
    tools: [],
    parts: [],
    createdAt: NOW - 20 * MINUTE,
    kind: "compact",
    compact: { status: "done", reason: "threshold", tokensBefore: 128_000, tokensAfter: 24_400 },
  },
  {
    id: "msg-u2",
    role: "user",
    text: "顺便加个 ⌘J 快捷键，快速在亮色和暗色之间切换。",
    tools: [],
    parts: [{ kind: "text", text: "顺便加个 ⌘J 快捷键，快速在亮色和暗色之间切换。" }],
    createdAt: NOW - 3 * MINUTE,
  },
  {
    id: "msg-a4",
    role: "assistant",
    text: "好的，我在应用层注册一个全局快捷键，并顺手跑一遍验证脚本。",
    tools: [EDIT_SHORTCUT, FAILED_TERMINAL],
    parts: [
      { kind: "text", text: "好的，我在应用层注册一个全局快捷键，并顺手跑一遍验证脚本。" },
      { kind: "tool", toolId: "tool-edit-shortcut" },
      { kind: "tool", toolId: "tool-bash-fail" },
    ],
    createdAt: NOW - 3 * MINUTE,
    completedAt: NOW - 2.7 * MINUTE,
  },
  // One engine message per model round-trip: the second one carries the answer, so the fold's
  // 用时 (work up to this message) and the footer's 耗时 (the whole turn) differ.
  {
    id: "msg-a5",
    role: "assistant",
    text:
      "已注册：`⌘J` 会在亮色 / 暗色之间切换；当前若处于「跟随系统」，会先固定为此刻生效的主题再切换。" +
      "输入框内按 `⌘J` 也不会被吞掉。",
    tools: [FAILED_BUILD],
    parts: [
      { kind: "thinking", text: "脚本没找到，换成直接构建一遍看看。", startedAt: NOW - 2.6 * MINUTE, endedAt: NOW - 2.5 * MINUTE },
      { kind: "tool", toolId: "tool-build-fail" },
      {
        kind: "text",
        text:
          "已注册：`⌘J` 会在亮色 / 暗色之间切换；当前若处于「跟随系统」，会先固定为此刻生效的主题再切换。" +
          "输入框内按 `⌘J` 也不会被吞掉。",
      },
    ],
    createdAt: NOW - 2.7 * MINUTE,
    completedAt: NOW - 2.4 * MINUTE,
  },
];

/**
 * A LaTeX answer, so the preview harness renders the math pipeline end to end: the
 * display block, the inline `$…$`, and — the case worth looking at — shell text that
 * uses `$` for variables, which must stay plain instead of being eaten by math.
 */
export const MATH_MESSAGES: ChatMessage[] = [
  {
    id: "msg-math-u",
    role: "user",
    text: "把注意力公式用 LaTeX 写一遍，顺便导出一份到 $HOME。",
    tools: [],
    parts: [{ kind: "text", text: "把注意力公式用 LaTeX 写一遍，顺便导出一份到 $HOME。" }],
    createdAt: NOW - 40_000,
  },
  {
    id: "msg-math-a",
    role: "assistant",
    text:
      "缩放点积注意力，softmax 作用在缩放后的点积上：\n\n" +
      "$$\n\\operatorname{Attention}(Q,K,V) = \\operatorname{softmax}\\!\\left(\\frac{QK^\\top}{\\sqrt{d_k}}\\right)V\n$$\n\n" +
      "其中 $d_k$ 是键的维度；导出脚本里 `$HOME` 与 `$PATH` 是 shell 变量，不会被当成公式。",
    tools: [],
    parts: [
      {
        kind: "text",
        text:
          "缩放点积注意力，softmax 作用在缩放后的点积上：\n\n" +
          "$$\n\\operatorname{Attention}(Q,K,V) = \\operatorname{softmax}\\!\\left(\\frac{QK^\\top}{\\sqrt{d_k}}\\right)V\n$$\n\n" +
          "其中 $d_k$ 是键的维度；导出脚本里 `$HOME` 与 `$PATH` 是 shell 变量，不会被当成公式。",
      },
    ],
    createdAt: NOW - 39_000,
    completedAt: NOW - 38_000,
  },
];

export const SESSION: EngineSessionState = {
  // The model the divider's last switch landed on, so the chip and the transcript agree.
  model: { provider: "deepseek", id: "deepseek-chat" },
  thinkingLevel: "high",
  isStreaming: false,
  messageCount: MESSAGES.length,
  autoCompactionEnabled: true,
  contextUsage: { tokens: 51_230, contextWindow: 200_000, percent: 26 },
};

export const STATS: SessionStats = {
  tokens: { input: 48_210, output: 3_180, cacheRead: 12_400, cacheWrite: 2_048, total: 65_838 },
  cost: 0.184,
  toolCalls: 7,
  steps: 4,
  timing: { totalMs: 68_400, modelMs: 41_200, toolMs: 18_200 },
};

export const MODELS: FastVibeModel[] = [
  { provider: "fastvibe", providerName: "FastVibe", id: "deepseek-flash", name: "DeepSeek Flash", thinkingLevels: ["low", "medium", "high"] },
  { provider: "fastvibe", providerName: "FastVibe", id: "claude-sonnet-4-5", name: "Claude Sonnet 4.5", thinkingLevels: ["low", "medium", "high"] },
  { provider: "fastvibe", providerName: "FastVibe", id: "claude-opus-4-1", name: "Claude Opus 4.1", thinkingLevels: ["low", "medium", "high"] },
  { provider: "fastvibe", providerName: "FastVibe", id: "gpt-5", name: "GPT-5", thinkingLevels: ["minimal", "low", "medium", "high"] },
  { provider: "fastvibe", providerName: "FastVibe", id: "gemini-2.5-pro", name: "Gemini 2.5 Pro", thinkingLevels: ["low", "medium", "high"] },
  { provider: "deepseek", providerName: "DeepSeek", id: "deepseek-chat", name: "DeepSeek V3.2", thinkingLevels: ["low", "medium", "high"] },
];

export const COMMANDS: SlashCommand[] = [
  { name: "plan", description: "进入计划模式，只读探索后给出方案", source: "extension" },
  { name: "goal", description: "为目标模式设定一个长期目标", source: "extension" },
  { name: "compact", description: "压缩当前会话的上下文", source: "builtin" },
  { name: "init", description: "为项目生成 AGENTS.md", source: "builtin" },
];

export const SKILLS: SkillInfo[] = [
  {
    name: "frontend-design",
    description: "Create distinctive, production-grade frontend interfaces with high design quality.",
    filePath: "/Users/dev/FastVibe/runtime/engine/agent/skills/frontend-design/SKILL.md",
    baseDir: "/Users/dev/FastVibe/runtime/engine/agent/skills/frontend-design",
    scope: "user",
    source: "fastvibe",
    removable: true,
  },
  {
    name: "excalidraw",
    description: "Generate architecture diagrams as .excalidraw files from codebase analysis.",
    filePath: "/Users/dev/FastVibe/runtime/engine/agent/skills/excalidraw/SKILL.md",
    baseDir: "/Users/dev/FastVibe/runtime/engine/agent/skills/excalidraw",
    scope: "user",
    source: "fastvibe",
    removable: true,
  },
  {
    name: "changelog",
    description: "Turn a changelog markdown into a short branded video.",
    filePath: `${PREVIEW_CWD}/.agents/skills/changelog/SKILL.md`,
    baseDir: `${PREVIEW_CWD}/.agents/skills/changelog`,
    scope: "project",
    source: "project",
    removable: false,
  },
];

export const INSTALLED_PACKAGES: ExtensionPackage[] = [
  { source: "npm:@narumitw/pi-plan-mode", scope: "user", installedPath: "/Users/dev/FastVibe/runtime/engine/agent/packages/pi-plan-mode", builtin: false, loaded: true, commands: 2, tools: 1 },
  { source: "builtin:plan", scope: "user", builtin: true, loaded: true, commands: 1, tools: 1 },
  { source: "builtin:goal", scope: "user", builtin: true, loaded: true, commands: 1, tools: 1 },
  { source: "builtin:todo", scope: "user", builtin: true, loaded: true, commands: 0, tools: 1 },
  { source: "builtin:permission-sandbox", scope: "user", builtin: true, loaded: true, commands: 0, tools: 0 },
  { source: "builtin:session-title", scope: "user", builtin: true, loaded: true, commands: 0, tools: 0 },
];

export const MARKET_PACKAGES: MarketPackage[] = [
  { name: "pi-mcp-adapter", description: "MCP (Model Context Protocol) adapter extension for the Pi coding agent.", author: "nicopreme", types: ["extension"], downloads: 939_700, version: "2.34.0", updatedAt: NOW - 1 * HOUR, npmUrl: "https://www.npmjs.com/package/pi-mcp-adapter", repoUrl: "https://github.com/nicopreme/pi-mcp-adapter" },
  { name: "@companion-ai/feynman", description: "Research-first CLI agent built on Pi and alphaXiv.", author: "advaitspallwal", types: ["prompt", "extension"], downloads: 354_200, version: "0.3.47", updatedAt: NOW - 12 * DAY, npmUrl: "https://www.npmjs.com/package/@companion-ai/feynman" },
  { name: "bigpowers", description: "73 agent skills synthesizing 17 years of software engineering discipline into a prescriptive methodology.", author: "danielvm", types: ["skill"], downloads: 70_300, version: "2.88.6", updatedAt: NOW - 1 * DAY, npmUrl: "https://www.npmjs.com/package/bigpowers" },
  { name: "pi-hermes-memory", description: "Persistent memory + session search + secret scanning for Pi. Token-aware policy-only memory by default, SQLite FTS5 index.", author: "chandra447", types: ["extension", "skill"], downloads: 28_100, version: "0.9.9", updatedAt: NOW - 2 * DAY, npmUrl: "https://www.npmjs.com/package/pi-hermes-memory" },
  { name: "pi-dark-theme", description: "A dark theme for Pi.", author: "someone", types: ["theme"], downloads: 1_200, version: "1.0.0", updatedAt: NOW - 5 * DAY, npmUrl: "https://www.npmjs.com/package/pi-dark-theme" },
  { name: "pi-prompt-pack", description: "Useful prompt templates for everyday refactors and reviews.", author: "someone", types: ["prompt"], downloads: 340, version: "0.2.0", updatedAt: NOW - 9 * DAY, npmUrl: "https://www.npmjs.com/package/pi-prompt-pack" },
];

export const PROVIDERS: ProviderConfig[] = [
  {
    id: "fastvibe",
    kind: "builtin",
    name: "FastVibe",
    baseUrl: "https://fastvibe.dev/v1",
    api: "openai-responses",
    apiKeyEnv: "FASTVIBE_API_KEY",
    hasKey: true,
    hasOAuth: false,
    supportsKey: true,
    gateway: "sub2api",
    enabled: true,
    models: MODELS.filter((model) => model.provider === "fastvibe").map((model) => ({
      id: model.id,
      name: model.name,
      contextWindow: 200_000,
      maxTokens: 64_000,
      reasoning: true,
      input: ["text", "image"],
      thinkingLevels: model.thinkingLevels,
      source: "models.dev",
    })),
  },
  {
    id: "custom-deepseek",
    kind: "custom",
    name: "DeepSeek",
    baseUrl: "https://api.deepseek.com/v1",
    api: "openai-completions",
    apiKeyEnv: "DEEPSEEK_API_KEY",
    hasKey: true,
    hasOAuth: false,
    supportsKey: true,
    enabled: true,
    models: [
      { id: "deepseek-chat", name: "DeepSeek V3.2", contextWindow: 128_000, maxTokens: 8_192, reasoning: false, input: ["text"], source: "models.dev" },
    ],
  },
  // The three 余额 states, so `mock.html` renders each without a real relay: a
  // new-api key with a budget, a sub2api rate, and an endpoint nobody identified.
  {
    id: "custom-relay",
    kind: "custom",
    name: "New API Relay",
    baseUrl: "https://relay.example.com/v1",
    api: "openai-completions",
    apiKeyEnv: "RELAY_API_KEY",
    hasKey: true,
    hasOAuth: false,
    supportsKey: true,
    gateway: "new-api",
    // A stored panel credential is what makes a new-api balance readable at all.
    gatewayCredential: true,
    enabled: true,
    models: [
      { id: "gpt-5.6-terra", name: "GPT-5.6 Terra", contextWindow: 400_000, maxTokens: 128_000, reasoning: true, input: ["text", "image"], source: "models.dev" },
    ],
  },
  // The same upstream, with no panel credential yet — the state that offers 配置 instead
  // of a number, and the one a preview is for.
  {
    id: "custom-relay-nocred",
    kind: "custom",
    name: "Relay (no panel token)",
    baseUrl: "https://relay2.example.com/v1",
    api: "openai-completions",
    apiKeyEnv: "RELAY2_API_KEY",
    hasKey: true,
    hasOAuth: false,
    supportsKey: true,
    gateway: "new-api",
    enabled: true,
    models: [
      { id: "gpt-5.6-luna", name: "GPT-5.6 Luna", contextWindow: 400_000, maxTokens: 128_000, reasoning: true, input: ["text"], source: "models.dev" },
    ],
  },
  {
    id: "custom-sub2api",
    kind: "custom",
    name: "Subscription Relay",
    baseUrl: "https://sub.example.com/v1",
    api: "anthropic-messages",
    apiKeyEnv: "SUB_API_KEY",
    hasKey: true,
    hasOAuth: false,
    supportsKey: true,
    gateway: "sub2api",
    enabled: true,
    models: [
      { id: "claude-opus-4-6", name: "Claude Opus 4.6", contextWindow: 200_000, maxTokens: 64_000, reasoning: true, input: ["text", "image"], source: "models.dev" },
    ],
  },
  {
    id: "custom-plain",
    kind: "custom",
    name: "Plain Endpoint",
    baseUrl: "https://plain.example.com/v1",
    api: "openai-completions",
    apiKeyEnv: "PLAIN_API_KEY",
    hasKey: true,
    hasOAuth: false,
    supportsKey: true,
    enabled: true,
    models: [
      { id: "gpt-5.6-sol", name: "GPT-5.6 Sol", contextWindow: 400_000, maxTokens: 128_000, reasoning: true, input: ["text"], source: "models.dev" },
    ],
  },
];

export const MCP_SERVERS: McpServerStatus[] = [
  { id: "mcp-filesystem", name: "filesystem", enabled: true, transport: "stdio", command: "npx", args: ["-y", "@modelcontextprotocol/server-filesystem", PREVIEW_CWD], connected: true, tools: ["read_file", "write_file", "list_directory", "search_files"] },
  { id: "mcp-postgres", name: "postgres", enabled: false, transport: "stdio", connected: false, tools: [], error: "not started" },
];

export const USAGE: UsageStats = {
  range: "30d",
  from: "2026-08-16",
  to: "2026-09-15",
  totals: { input: 1_842_300, output: 184_200, cacheRead: 934_000, cacheWrite: 62_400, tokens: 2_960_900, cost: 18.42, requests: 412, toolCalls: 1_284, activeDays: 21 },
  days: [
    { date: "2026-08-18", input: 64_200, output: 6_100, cacheRead: 31_200, cacheWrite: 2_100, tokens: 101_500, cost: 0.62, requests: 14, toolCalls: 41 },
    { date: "2026-08-20", input: 92_400, output: 9_800, cacheRead: 44_100, cacheWrite: 3_200, tokens: 146_300, cost: 0.94, requests: 19, toolCalls: 63 },
    { date: "2026-08-25", input: 121_800, output: 12_400, cacheRead: 58_300, cacheWrite: 4_100, tokens: 192_500, cost: 1.21, requests: 26, toolCalls: 82 },
    { date: "2026-08-28", input: 88_100, output: 8_900, cacheRead: 41_700, cacheWrite: 2_900, tokens: 138_700, cost: 0.88, requests: 18, toolCalls: 52 },
    { date: "2026-09-02", input: 143_600, output: 15_200, cacheRead: 71_400, cacheWrite: 5_300, tokens: 230_200, cost: 1.46, requests: 31, toolCalls: 104 },
    { date: "2026-09-05", input: 96_300, output: 10_100, cacheRead: 46_900, cacheWrite: 3_400, tokens: 153_300, cost: 0.98, requests: 21, toolCalls: 66 },
    { date: "2026-09-08", input: 168_900, output: 17_800, cacheRead: 84_200, cacheWrite: 6_100, tokens: 270_900, cost: 1.72, requests: 36, toolCalls: 128 },
    { date: "2026-09-11", input: 132_400, output: 13_900, cacheRead: 65_800, cacheWrite: 4_700, tokens: 212_100, cost: 1.35, requests: 29, toolCalls: 97 },
    { date: "2026-09-14", input: 176_200, output: 19_400, cacheRead: 89_600, cacheWrite: 6_800, tokens: 285_200, cost: 1.84, requests: 38, toolCalls: 141 },
  ],
  models: [
    { provider: "fastvibe", model: "claude-sonnet-4-5", input: 1_120_400, output: 112_800, cacheRead: 612_000, cacheWrite: 38_200, tokens: 1_845_200, cost: 11.24, requests: 248, toolCalls: 802 },
    { provider: "fastvibe", model: "gpt-5", input: 512_900, output: 51_200, cacheRead: 246_800, cacheWrite: 16_900, tokens: 810_900, cost: 5.18, requests: 112, toolCalls: 358 },
    { provider: "deepseek", model: "deepseek-chat", input: 209_000, output: 20_200, cacheRead: 75_200, cacheWrite: 7_300, tokens: 304_800, cost: 2.0, requests: 52, toolCalls: 124 },
  ],
  sessions: 37,
  longestSessionMinutes: 19,
  currentStreak: 1,
  longestStreak: 3,
};

/** A small project tree for the right pane's 文件 tab. */
export const TREE: Record<string, DirEntry[]> = {
  [PREVIEW_CWD]: [
    { name: "resources", path: `${PREVIEW_CWD}/resources`, kind: "directory" },
    { name: "scripts", path: `${PREVIEW_CWD}/scripts`, kind: "directory" },
    { name: "src", path: `${PREVIEW_CWD}/src`, kind: "directory" },
    { name: "electron.vite.config.ts", path: `${PREVIEW_CWD}/electron.vite.config.ts`, kind: "file" },
    { name: "package.json", path: `${PREVIEW_CWD}/package.json`, kind: "file" },
    { name: "pnpm-workspace.yaml", path: `${PREVIEW_CWD}/pnpm-workspace.yaml`, kind: "file" },
    { name: "tsconfig.json", path: `${PREVIEW_CWD}/tsconfig.json`, kind: "file" },
  ],
  [`${PREVIEW_CWD}/src`]: [
    { name: "main", path: `${PREVIEW_CWD}/src/main`, kind: "directory" },
    { name: "preload", path: `${PREVIEW_CWD}/src/preload`, kind: "directory" },
    { name: "renderer", path: `${PREVIEW_CWD}/src/renderer`, kind: "directory" },
    { name: "shared", path: `${PREVIEW_CWD}/src/shared`, kind: "directory" },
  ],
  [`${PREVIEW_CWD}/src/renderer`]: [
    { name: "public", path: `${PREVIEW_CWD}/src/renderer/public`, kind: "directory" },
    { name: "src", path: `${PREVIEW_CWD}/src/renderer/src`, kind: "directory" },
    { name: "index.html", path: `${PREVIEW_CWD}/src/renderer/index.html`, kind: "file" },
  ],
  [`${PREVIEW_CWD}/src/renderer/src`]: [
    { name: "components", path: `${PREVIEW_CWD}/src/renderer/src/components`, kind: "directory" },
    { name: "lib", path: `${PREVIEW_CWD}/src/renderer/src/lib`, kind: "directory" },
    { name: "stores", path: `${PREVIEW_CWD}/src/renderer/src/stores`, kind: "directory" },
    { name: "App.tsx", path: `${PREVIEW_CWD}/src/renderer/src/App.tsx`, kind: "file" },
    { name: "main.tsx", path: `${PREVIEW_CWD}/src/renderer/src/main.tsx`, kind: "file" },
  ],
  [`${PREVIEW_CWD}/src/renderer/src/lib`]: [
    { name: "themes.ts", path: `${PREVIEW_CWD}/src/renderer/src/lib/themes.ts`, kind: "file" },
    { name: "highlight.ts", path: `${PREVIEW_CWD}/src/renderer/src/lib/highlight.ts`, kind: "file" },
    { name: "group-parts.tsx", path: `${PREVIEW_CWD}/src/renderer/src/lib/group-parts.tsx`, kind: "file" },
    { name: "tool-presentation.tsx", path: `${PREVIEW_CWD}/src/renderer/src/lib/tool-presentation.tsx`, kind: "file" },
    { name: "workspace-path.ts", path: `${PREVIEW_CWD}/src/renderer/src/lib/workspace-path.ts`, kind: "file" },
  ],
  [`${PREVIEW_CWD}/src/renderer/src/stores`]: [
    { name: "session.ts", path: `${PREVIEW_CWD}/src/renderer/src/stores/session.ts`, kind: "file" },
    { name: "settings.ts", path: `${PREVIEW_CWD}/src/renderer/src/stores/settings.ts`, kind: "file" },
    { name: "side-pane.ts", path: `${PREVIEW_CWD}/src/renderer/src/stores/side-pane.ts`, kind: "file" },
  ],
};

const THEME_SELECT_TSX = `import { type JSX } from "react";
import { HugeiconsIcon } from "@hugeicons/react";
import { Tick02Icon } from "@hugeicons/core-free-icons";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuLabel,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { themesFor, type ThemeId } from "@/lib/themes";

/**
 * Theme picker for Settings → 通用. Light and dark are stored separately so
 * switching the mode never loses the other half's selection.
 */
export function ThemeSelect({
  kind,
  value,
  onChange,
}: {
  kind: "light" | "dark";
  value: ThemeId;
  onChange: (id: ThemeId) => void;
}): JSX.Element {
  const themes = themesFor(kind);
  const active = themes.find((theme) => theme.id === value) ?? themes[0];
  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        render={<Button variant="outline" size="sm" className="w-44 justify-between" />}
      >
        <span className="truncate">{active.label}</span>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-56">
        <DropdownMenuLabel>{kind === "dark" ? "暗色主题" : "亮色主题"}</DropdownMenuLabel>
        {themes.map((theme) => (
          <DropdownMenuCheckboxItem
            key={theme.id}
            checked={theme.id === value}
            onCheckedChange={() => onChange(theme.id)}
          >
            <span className="flex-1 truncate">{theme.label}</span>
            {theme.id === value ? <HugeiconsIcon icon={Tick02Icon} /> : null}
          </DropdownMenuCheckboxItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
`;

/** Previews the 文件 tab can open, keyed by absolute path. */
export function previewFor(path: string): FilePreview {
  const name = path.split("/").pop() ?? path;
  if (name.endsWith(".tsx") || name.endsWith(".ts")) {
    return { kind: "code", path, name, language: name.endsWith(".tsx") ? "tsx" : "typescript", text: THEME_SELECT_TSX };
  }
  if (name.endsWith(".json")) {
    return { kind: "code", path, name, language: "json", text: '{\n  "name": "fastvibe",\n  "version": "0.1.0"\n}\n' };
  }
  return {
    kind: "markdown",
    path,
    name,
    text: `# ${name}\n\n这是 **${name}** 的预览。\n\n- 支持 Markdown 渲染\n- 支持代码高亮与图片、PDF\n`,
  };
}

/**
 * 设置 → 导入: three sources, one of them installed but empty, so the pane's two states
 * (a countable row, a 没有找到会话 row) are both represented. `pi` is deliberately absent
 * here — that is exactly what "not installed" now looks like.
 */
export const IMPORT_SOURCES: ImportSourceStatus[] = [
  { id: "claude-code", name: "Claude Code", sessionCount: 18, latestAt: NOW - 2 * HOUR },
  { id: "codex", name: "Codex", sessionCount: 42, archivedCount: 9, latestAt: NOW - 25 * MINUTE },
  { id: "opencode", name: "opencode", sessionCount: 0, reason: "没有找到会话" },
  { id: "zcode", name: "zcode", sessionCount: 6, latestAt: NOW - 5 * HOUR },
];

export const IMPORT_CANDIDATES: ImportCandidate[] = [
  {
    id: "claude-code:f27c296d",
    source: "claude-code",
    title: "重构文件预览的尺寸计算",
    cwd: "/Users/yuantang/code/matpool/matpilot",
    createdAt: NOW - 3 * HOUR,
    updatedAt: NOW - 2 * HOUR,
    messageCount: 84,
    bytes: 1_820_416,
    imported: false,
  },
  {
    id: "claude-code:8f4fe7f3",
    source: "claude-code",
    title: "OpenCode provider 配置",
    cwd: "/Users/yuantang/code/apifuck",
    createdAt: NOW - 12 * DAY,
    updatedAt: NOW - 12 * DAY + 40 * MINUTE,
    messageCount: 30,
    bytes: 2_184_877,
    imported: true,
  },
  {
    id: "claude-code:3e13ca73",
    source: "claude-code",
    title: "思考块时长统计与折叠",
    cwd: "/Users/yuantang/Library/Application Support/Claude/scratch-workspaces/b442a2b6/526af9ed",
    createdAt: NOW - 20 * DAY,
    updatedAt: NOW - 20 * DAY + 90 * MINUTE,
    messageCount: 52,
    bytes: 620_544,
    note: "含子 agent 轨迹，导入时会跳过",
    imported: false,
  },
  {
    id: "claude-code:a91f07",
    source: "claude-code",
    title: "回归：会话运行中状态推断",
    cwd: "/Users/yuantang/code/matpool/matcloud-fe-new",
    createdAt: NOW - 45 * DAY,
    updatedAt: NOW - 44 * DAY,
    messageCount: 1204,
    bytes: 16_240_000,
    note: "会话较长，导入后建议先压缩上下文",
    imported: false,
  },
  {
    id: "claude-code:b6a28e5c",
    source: "claude-code",
    title: "(空)",
    createdAt: NOW - 60 * DAY,
    updatedAt: NOW - 60 * DAY,
    messageCount: 2,
    bytes: 6_144,
    imported: false,
  },
  {
    id: "codex:live-1",
    source: "codex",
    title: "排查 browser_click 命中失败",
    cwd: "/Users/yuantang/code/fastvibe",
    createdAt: NOW - 40 * MINUTE,
    updatedAt: NOW - 25 * MINUTE,
    bytes: 3_100_000,
    imported: false,
  },
  {
    id: "codex:live-2",
    source: "codex",
    title: "git worktree 并发冲突",
    cwd: "/Users/yuantang/code/fastvibe",
    createdAt: NOW - 4 * DAY,
    updatedAt: NOW - 4 * DAY + 50 * MINUTE,
    bytes: 1_240_000,
    note: "消息数为估算值",
    imported: false,
  },
  {
    id: "codex:arch-1",
    source: "codex",
    title: "旧版队列实现的调研",
    cwd: "/Users/yuantang/code/apifuck",
    createdAt: NOW - 90 * DAY,
    updatedAt: NOW - 88 * DAY,
    messageCount: 41,
    bytes: 940_000,
    archived: true,
    imported: false,
  },
];
