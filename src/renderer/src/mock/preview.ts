import type { ChatMessage, ConversationOpenResult, EngineStatus, ImportSourceId, WorkspaceSnapshot } from "@shared/types";
import type { AppInfo, GitStatus } from "@shared/ipc";
import {
  COMMANDS,
  CONVERSATIONS,
  IMPORT_CANDIDATES,
  IMPORT_SOURCES,
  INSTALLED_PACKAGES,
  MARKET_PACKAGES,
  MCP_SERVERS,
  MESSAGES,
  MATH_MESSAGES,
  MODELS,
  PREVIEW_CWD,
  PROJECTS,
  PROVIDERS,
  SESSION,
  SKILLS,
  STATS,
  TREE,
  USAGE,
  previewFor,
} from "./preview-data";
import { websiteFixture, type WebsiteLanguage } from "./website-fixtures";

/**
 * Browser preview harness.
 *
 * `mock.html` loads this before `main.tsx` so the Electron-only `window.fastvibe`
 * bridge exists, then the real renderer mounts against these fixtures. It exists
 * so the UI can be rendered (and screenshotted) in a plain browser with
 * representative content — it is not part of the shipped app, and nothing here is
 * persisted.
 */

const params = new URLSearchParams(window.location.search);
const website = params.get("website") === "1";
const websiteLanguage: WebsiteLanguage = params.get("lang") === "en" ? "en" : "zh";
const websiteScene = params.get("scene") ?? "workspace";
const websiteData = website ? websiteFixture(websiteLanguage) : null;
if (website && websiteScene === "models") window.location.hash = "#/settings/providers";
const theme = params.get("theme");
const pane = params.get("pane");
const scroll = params.get("scroll");
const dialog = params.get("dialog");
const expand = params.get("expand");
/** `?sidebar=collapsed` renders the rail-less layout the title bar's toggle produces. */
const sidebar = params.get("sidebar");
/** `?maximize=1` hands the whole window to the side pane, with the sidebar as asked. */
const maximize = params.get("maximize") === "1";
/**
 * `?platform=win32|linux` renders the shell as it is packaged there: without
 * macOS' traffic lights, so with the title bar the app draws for itself
 * (`lib/platform.ts`). Defaults to macOS, the layout the app is developed on.
 */
const platform = params.get("platform") ?? "darwin";
/**
 * `?remote=1` renders the shell as the browser client sees it: no traffic lights to
 * inset and no hand-drawn title bar either, whatever `?platform=` says the host is.
 * This is the layout that had 88px of empty space where a Mac's traffic lights would
 * be, on a page that has none.
 */
const remote = params.get("remote") === "1";

// Reset persisted UI state so the harness always starts from the same layout.
try {
  for (const key of [
    "fastvibe.settings",
    "fastvibe.sidebar.collapsed",
    "fastvibe.sidebar.pinned",
    "fastvibe.side-pane.collapsed",
    "fastvibe.side-pane.width",
    "fastvibe.archived",
    "fastvibe.session-drafts",
  ]) {
    localStorage.removeItem(key);
  }
} catch {
  // ignore
}

const initialSettings: Record<string, unknown> = {
  permissionMode: "smart",
  thinkingLevel: "high",
  queueBehavior: "followUp",
  autoCompact: true,
  interruptMode: "immediate",
  showThinking: true,
  showTimestamps: !website,
  collapseRuns: website ? false : params.get("collapse") !== "off",
  sendOnEnter: true,
  ...(website ? { uiLanguage: websiteLanguage, aiLanguage: websiteLanguage } : {}),
  themeMode: website ? "dark" : theme === "light" || theme === "dark" ? theme : "system",
  lightTheme: "github-light",
  darkTheme: website ? "github-dark" : "tokyo-night",
  sidebarWidth: website ? 260 : 264,
  sidebarCollapsed: sidebar === "collapsed",
  sidePaneWidth: website ? 460 : 384,
};

const fixtureProjects = websiteData?.projects ?? PROJECTS;
const fixtureConversations = websiteData?.conversations ?? CONVERSATIONS;
const fixtureMessages = websiteData?.messages ?? MESSAGES;
const fixtureSession = websiteData?.session ?? SESSION;
const fixtureStats = websiteData?.stats ?? STATS;
const fixtureCwd = websiteData?.cwd ?? PREVIEW_CWD;
const fixtureActiveId = websiteData?.activeId ?? "conv-theme";

const snapshot = (): WorkspaceSnapshot => ({
  projects: fixtureProjects,
  conversations: fixtureConversations,
  activeId: fixtureActiveId,
});

/**
 * Which conversations the sidebar draws as 运行中. Every fixture transcript is settled,
 * and the live mark comes from the engine's `conversation_running` push, so `?running=1`
 * is the only way to look at a spinning sidebar row in the harness. It is answered from
 * here — module scope — because the app asks `engine:getRunning` *before* it opens the
 * conversation, so a set filled in during `open` would arrive one step too late.
 */
const runningIds = new Set<string>(params.get("running") === "1" ? [fixtureActiveId] : []);

/**
 * `?running=1` keeps the sidebar's 运行中 mark spinning. Every fixture run has settled,
 * and the real mark only ever comes from the engine's `conversation_running` push, so
 * the harness replays one — late, once the app has subscribed *and* finished opening the
 * conversation, because opening it is what sets the mark from the state reply.
 */
const runOnStart = params.get("running") === "1";

/** The store's engine-event subscribers, so the replay above has somewhere to land. */
const eventListeners = new Set<(event: unknown) => void>();

const openResult = (id: string): ConversationOpenResult => {
  const conversation = fixtureConversations.find((item) => item.id === id) ?? fixtureConversations[0];
  const isActive = conversation.id === fixtureActiveId;
  // `?math=1` swaps the thread for the LaTeX fixture, so the math pipeline can be
  // looked at without adding a conversation to the sidebar. `?running=1` puts
  // conv-theme in `engine:getRunning` (see `runningIds`), which the app asks for once
  // at mount — a state reply is not the mark's source, because `setSession` refuses to
  // speak for a conversation that is not on screen when it lands.
  let messages = isActive ? fixtureMessages : [];
  if (!website && isActive && params.get("math") === "1") messages = [...MESSAGES.slice(0, 2), ...MATH_MESSAGES];
  const planFixture = isActive && params.get("plan") === "1";
  const plan = {
    path: `${PREVIEW_CWD}/.tmp/fastvibe-plan.md`,
    title: "主题模式改造计划",
    summary: "目标：为设置页补充跟随系统主题，并确保主题切换在多个窗口间保持一致。\n\n## 实施步骤\n\n1. 梳理现有主题状态与持久化路径。\n2. 增加跟随系统的实时监听。\n3. 补充设置页交互与回归测试。",
  };
  return {
    ...snapshot(),
    conversation,
    messages,
    // `running` rides the state because that is what the store unions into the
    // sidebar mark (`working`); `engine:getRunning` only seeds the map before the
    // conversation is opened, and a settled-looking state reply would clear it again.
    state: isActive
      ? { ...fixtureSession, messageCount: messages.length, running: params.get("running") === "1" }
      : { ...fixtureSession, messageCount: 0 },
    status: { state: "ready", cwd: fixtureCwd },
    queue: { conversationId: conversation.id, revision: 0, items: [], pause: null },
    // Only the chat that owns a goal carries one: the panel is conversation-bound, and
    // the preview is where that is checked (`?goal=1`).
    extensionStatus:
      planFixture
        ? { "plan-mode": "active", "plan-review": JSON.stringify(plan) }
        : isActive && params.get("goal") === "1"
          ? { goal: JSON.stringify({ objective: GOAL_OBJECTIVE, status: params.get("goalState") ?? "running", round: 3 }) }
          : {},
  };
};

/** Long enough that the one-line row has to ellipsise it. */
const GOAL_OBJECTIVE =
  "分析下作为一个智能体客户端还有哪些比较重要的需求没做的，并把它们拆成本轮可执行的任务";

const status: EngineStatus = { state: "ready", cwd: fixtureCwd };

const APP_INFO: AppInfo = {
  version: "0.1.0",
  userData: "/Users/dev/Library/Application Support/FastVibe",
  runtimeRoot: "/Users/dev/Library/Application Support/FastVibe/runtime/engine",
  platform,
  modelsDev: { models: 1_284, aliases: 3_910, generatedAt: Date.now() - 36 * 60 * 60 * 1000, path: "resources/models-dev/index.json" },
};

/* ------------------------------------------------------------------ file icons */

// `?url&no-inline` keeps the asset as a servable `/@fs/...` URL instead of
// inlining a data URL, so the icon base can be derived from it. Bare
// `/node_modules/...` paths are no good: the dev server answers them with HTML.
import fileIconAsset from "material-icon-theme/icons/file.svg?url&no-inline";
import materialIconsRaw from "material-icon-theme/dist/material-icons.json?raw";

const ICONS_BASE = fileIconAsset.slice(0, fileIconAsset.lastIndexOf("/") + 1);

type MaterialManifest = {
  fileExtensions: Record<string, string>;
  fileNames: Record<string, string>;
  file: string;
  folder: string;
  folderExpanded: string;
};

const MANIFEST = JSON.parse(materialIconsRaw) as MaterialManifest;

const ICON_MAPPING = {
  fileExtensions: MANIFEST.fileExtensions,
  fileNames: MANIFEST.fileNames,
  file: MANIFEST.file,
  folder: MANIFEST.folder,
  folderExpanded: MANIFEST.folderExpanded,
};

async function loadIconMapping() {
  return ICON_MAPPING;
}

/**
 * The real app serves icons two ways — a private `fastvibe-icon://` scheme in the
 * desktop window, `/file-icon/` over HTTP for the browser client — and this harness is
 * neither, so both are rewritten to the package's SVGs that the Vite dev server
 * exposes. Matching both is what keeps `?remote=1` previewable.
 */
function rewriteIcons(scope: ParentNode): void {
  scope
    .querySelectorAll<HTMLImageElement>('img[src^="fastvibe-icon://"], img[src^="/file-icon/"]')
    .forEach((image) => {
    const name = (image.getAttribute("src") ?? "")
      .replace("fastvibe-icon://icons/", "")
      .replace("/file-icon/", "")
      .replace(/\.svg$/, "");
    image.onerror = () => {
      image.onerror = null;
      image.src = `${ICONS_BASE}file.svg`;
    };
    image.src = `${ICONS_BASE}${name}.svg`;
  });
}

function installIconRewrite(): void {
  rewriteIcons(document);
  new MutationObserver((records) => {
    for (const record of records) {
      record.addedNodes.forEach((node) => {
        if (node instanceof HTMLElement) rewriteIcons(node);
      });
    }
  }).observe(document.documentElement, { childList: true, subtree: true });
}

/* ------------------------------------------------------------------ the bridge */

const api = {
  engine: {
    getStatus: async () => status,
    start: async () => status,
    stop: async () => status,
    prompt: async () => undefined,
    steer: async () => undefined,
    replaceSteering: async () => undefined,
    followUp: async () => undefined,
    abort: async () => undefined,
    abortSubagent: async () => undefined,
    continue: async () => undefined,
    clearQueue: async () => ({ steering: [], followUp: [] }),
    compact: async () => fixtureSession,
    getCommands: async () => COMMANDS,
    getExtensions: async () => [
      { path: "resources/extensions/plan.ts", name: "plan", commands: 1, tools: 1 },
      { path: "resources/extensions/goal.ts", name: "goal", commands: 1, tools: 0 },
      { path: "resources/extensions/todo.ts", name: "todo", commands: 0, tools: 1 },
      { path: "resources/extensions/permission-sandbox.ts", name: "permission-sandbox", commands: 0, tools: 0 },
      { path: "resources/extensions/session-title.ts", name: "session-title", commands: 0, tools: 0 },
    ],
    listExtensionPackages: async () => INSTALLED_PACKAGES,
    installExtensionPackage: async () => INSTALLED_PACKAGES,
    removeExtensionPackage: async () => INSTALLED_PACKAGES,
    listMarketPackages: async (query?: { query?: string; type?: string; page?: number }) => ({
      packages: MARKET_PACKAGES.filter((item) => !query?.query || item.name.includes(query.query)),
      query: query?.query ?? "",
      type: query?.type ?? "",
      sort: "downloads",
      page: query?.page ?? 1,
      total: MARKET_PACKAGES.length,
      totalPages: 1,
    }),
    listMcpServers: async () => MCP_SERVERS,
    saveMcpServers: async (configs: unknown) => (Array.isArray(configs) ? MCP_SERVERS : MCP_SERVERS),
    listSkills: async () => SKILLS,
    createSkill: async () => SKILLS,
    importSkill: async () => SKILLS,
    removeSkill: async () => SKILLS,
    importSources: async () => IMPORT_SOURCES,
    importCandidates: async (source: ImportSourceId) =>
      IMPORT_CANDIDATES.filter((candidate) => candidate.source === source).map((candidate) => ({
        ...candidate,
        source,
      })),
    importSessions: async (_source: ImportSourceId, ids: string[]) => ({
      source: "claude-code" as ImportSourceId,
      outcomes: ids.map((id) => {
        const candidate = IMPORT_CANDIDATES.find((item) => item.id === id);
        return {
          id,
          title: candidate?.title ?? id,
          ok: true,
          messages: (candidate?.messageCount ?? 0) * 2,
          skipped: ["已跳过 4 条子 agent 消息", "已跳过 2 条系统注入消息"],
          cwd: candidate?.cwd,
          conversationId: `imported-${id}`,
        };
      }),
      snapshot: { projects: fixtureProjects, conversations: fixtureConversations, activeId: fixtureConversations[0]?.id },
    }),
    getSubagents: async () => [],
    listAgentConfigs: async () => [],
    saveAgentConfig: async () => [],
    removeAgentConfig: async () => [],
    getSubagentMessages: async (): Promise<ChatMessage[]> => [],
    respondPermission: async () => undefined,
    newSession: async () => undefined,
    getState: async () => fixtureSession,
    getRunning: async (): Promise<string[]> => [...runningIds],
    getModels: async () => MODELS,
    setModel: async () => fixtureSession,
    setThinking: async () => fixtureSession,
    setInterruptMode: async () => fixtureSession,
    setAutoCompaction: async () => fixtureSession,
    branch: async () => (!website && params.get("math") === "1" ? [...MESSAGES.slice(0, 2), ...MATH_MESSAGES] : fixtureMessages),
    getMessages: async () => (!website && params.get("math") === "1" ? [...MESSAGES.slice(0, 2), ...MATH_MESSAGES] : fixtureMessages),
    getStats: async () => fixtureStats,
    setSteeringMode: async () => fixtureSession,
    setFollowUpMode: async () => fixtureSession,
    exportHtml: async () => undefined,
    promptConversation: async () => undefined,
    getConversationMessages: async (): Promise<ChatMessage[]> => [],
    // The retry flow asks before offering a file rewind; the fixture has no checkpoint.
    getCheckpoint: async () => null,
    restoreCheckpoint: async () => ({ restored: 0, removed: 0, skipped: 0 }),
    onEvent: (listener: (event: unknown) => void) => {
      // Exposed so the harness can replay engine events from the page console (a
      // model switch, a streamed token) instead of only rendering a fixture thread.
      (window as unknown as { __engineEvent?: (event: unknown) => void }).__engineEvent = listener;
      eventListeners.add(listener);
      if (runOnStart) {
        window.setTimeout(() => {
          if (eventListeners.has(listener)) {
            listener({ type: "conversation_running", conversationId: fixtureActiveId, running: true });
          }
        }, 0);
      }
      if (params.get("plan") === "1") {
        window.setTimeout(() => {
          if (eventListeners.has(listener)) {
            listener({ type: "extension_ui_request", id: "plan-review-preview", conversationId: "conv-theme", method: "plan_review", plan: {
              path: `${PREVIEW_CWD}/.tmp/fastvibe-plan.md`,
              title: "主题模式改造计划",
              summary: "目标：为设置页补充跟随系统主题，并确保主题切换在多个窗口间保持一致。\\n\\n## 实施步骤\\n\\n1. 梳理现有主题状态与持久化路径。\\n2. 增加跟随系统的实时监听。\\n3. 补充设置页交互与回归测试。",
            } });
          }
        }, 50);
      }
      return () => eventListeners.delete(listener);
    },
    onStatus: () => () => undefined,
    onConversationReady: () => () => undefined,
  },
  providers: {
    list: async () => PROVIDERS,
    native: async () => [],
    addNative: async () => PROVIDERS,
    fetch: async () => PROVIDERS[0].models,
    saveFastVibe: async () => PROVIDERS,
    add: async () => PROVIDERS,
    update: async () => PROVIDERS,
    remove: async () => PROVIDERS,
    refresh: async () => PROVIDERS[0].models,
    scanCcSwitch: async () => ({ found: false, path: "", candidates: [] }),
    importCcSwitch: async () => PROVIDERS,
  },
  conversations: {
    list: async () => snapshot(),
    create: async (project?: string) => openResult(fixtureConversations[0].id),
    open: async (id: string) => openResult(id),
    rename: async () => snapshot(),
    delete: async () => ({ ...snapshot(), nextId: fixtureConversations[0].id }),
    recordPrompt: async () => snapshot(),
    setProject: async () => snapshot(),
    createSide: async () => openResult(fixtureConversations[0].id),
    search: async (query: string) => {
      const needle = query.trim().toLowerCase();
      if (needle.length < 2) return [];
      return fixtureConversations.filter((item) => `${item.title} ${item.preview ?? ""}`.toLowerCase().includes(needle)).map(
        (item) => ({ id: item.id, snippet: item.preview }),
      );
    },
    // Nothing else is writing the catalog in the preview, so this push never fires.
    onChanged: () => () => undefined,
  },
  projects: {
    add: async () => null,
    rename: async () => snapshot(),
    remove: async () => ({ ...snapshot(), nextId: null }),
    reorder: async (cwds: string[]) => {
      const rank = new Map(cwds.map((cwd, index) => [cwd, index]));
      fixtureProjects.sort((a, b) => (rank.get(a.cwd) ?? Number.MAX_SAFE_INTEGER) - (rank.get(b.cwd) ?? Number.MAX_SAFE_INTEGER));
      return snapshot();
    },
  },
  workspace: {
    pick: async () => null,
    reveal: async () => undefined,
    preview: async (path: string) => websiteData?.previewFor(path) ?? previewFor(path),
    fileIcons: loadIconMapping,
    readDir: async (path: string) => websiteData?.tree[path] ?? TREE[path] ?? [],
    gitStatus: async (cwd: string): Promise<GitStatus> => websiteData?.gitStatus ?? ({
      cwd,
      isRepository: true,
      branch: "feat/theme-mode",
      changed: 4,
      staged: 1,
      additions: 128,
      deletions: 34,
      ahead: 1,
      behind: 0,
      files: [
        { path: "src/renderer/src/components/settings/theme-select.tsx", index: "M", worktree: " " },
        { path: "src/renderer/src/components/layout/side-pane-git.tsx", index: " ", worktree: "M" },
        { path: "src/renderer/src/App.tsx", index: " ", worktree: "M" },
        { path: "src/renderer/src/lib/themes.ts", index: "?", worktree: "?" },
      ],
    }),
    openTerminal: async () => undefined,
    gitBranches: async () => [{ name: "feat/theme-mode", current: true, upstream: "origin/feat/theme-mode" }, { name: "main", current: false }],
    gitCheckout: async (cwd: string) => api.workspace.gitStatus(cwd),
    gitCreateBranch: async (cwd: string) => api.workspace.gitStatus(cwd),
    gitStage: async (cwd: string) => api.workspace.gitStatus(cwd),
    gitCommit: async (cwd: string) => api.workspace.gitStatus(cwd),
    gitGenerateCommitMessage: async () => "feat: add repository status shortcuts",
    gitDiff: async (_cwd: string, path?: string) => {
      if (websiteData) return websiteData.gitDiff(path);
      const file = path?.split("/").pop() ?? "file.tsx";
      return `@@ -12,8 +12,11 @@ export function Example(): JSX.Element {
   return (
     <div className="flex items-center gap-2">
-      <span className="text-xs text-muted-foreground">${file}</span>
+      <FileIcon name="${file}" />
+      <span className="min-w-0 truncate text-xs font-medium">${file}</span>
     </div>
   );
 }
`;
    },
    gitUnstage: async (cwd: string) => api.workspace.gitStatus(cwd),
    gitDiscard: async (cwd: string) => api.workspace.gitStatus(cwd),
    gitPull: async (cwd: string) => api.workspace.gitStatus(cwd),
    gitPush: async (cwd: string) => api.workspace.gitStatus(cwd),
    terminalStart: async (cwd?: string) => ({ id: "term-mock", cwd: cwd ?? fixtureCwd }),
    terminalWrite: async () => undefined,
    terminalResize: async () => undefined,
    terminalKill: async () => undefined,
    onTerminalData: () => () => undefined,
  },
  app: {
    /** Read by `lib/platform.ts` before the first paint; `?platform=` overrides it. */
    platform,
    /** `?remote=1`: the window chrome the browser client has, which is none. */
    remote,
    getInfo: async () => APP_INFO,
    log: () => undefined,
    exportLogs: async () => "/Users/dev/Downloads/fastvibe-logs-preview.zip",
    // 关于's metadata refresh: the preview has no upstream to fetch, so it reports the
    // same fixture catalog with a fresh date.
    updateModelsDev: async () => ({ ...APP_INFO.modelsDev!, generatedAt: Date.now() }),
    newWindow: async () => undefined,
  },
  settings: {
    initial: initialSettings,
    load: async () => initialSettings,
    save: async () => undefined,
    clear: async () => undefined,
    // The real bridge pushes cross-window settings writes; the preview has one window.
    onChanged: () => () => undefined,
  },
  // The window controls of a hand-drawn title bar (`?platform=win32`): there is no
  // window in the browser, so they only have to be present and inert. State starts
  // unmaximised and never changes, which is what the fixtures render.
  window: {
    minimize: async () => undefined,
    toggleMaximize: async () => undefined,
    close: async () => undefined,
    isMaximized: async () => false,
    onState: () => () => undefined,
  },
  stats: {
    usage: async () => USAGE,
  },
  // Remote access is a real server in the main process; the preview has none to show,
  // so every action is a no-op over one of the two fixtures `?tunnel=` picks.
  remote: {
    getState: async () => REMOTE_STATE,
    setPassword: async () => ({ ...REMOTE_STATE, configured: true }),
    clearPassword: async () => REMOTE_OFF,
    start: async () => REMOTE_STATE,
    stop: async () => REMOTE_OFF,
    listDevices: async () => REMOTE_DEVICES,
    revokeDevice: async () => [],
    tunnelTools: async () => REMOTE_TOOLS,
    setTunnel: async () => REMOTE_STATE,
    onState: () => () => undefined,
  },
  // The browser-use bridge is main-process driven: in the preview nothing ever
  // requests a browser action, so `onRequest` just returns its unsubscribe.
  browser: {
    onRequest: () => () => undefined,
    respond: () => undefined,
  },
  /**
   * 电脑操控 in the preview.
   *
   * `?computer=granted` renders the pane a user sees once macOS has agreed — the state
   * the switches are actually usable in. The default is the ungranted one, because that
   * is the screen this pane has to get right: it is where every user starts, and it is
   * the only one that has to explain something.
   */
  computer: {
    permissions: async () => computerStatus(),
    requestPermissions: async () => computerStatus(),
    openSettings: async () => undefined,
    listApps: async () => [
      { pid: 412, name: "Google Chrome", bundleId: "com.google.Chrome", active: true },
      { pid: 733, name: "Microsoft Excel", bundleId: "com.microsoft.Excel", active: false },
      { pid: 901, name: "访达", bundleId: "com.apple.finder", active: false },
    ],
    startDrag: async () => undefined,
    // The flow drives a real Electron window and polls the real OS, so the preview can
    // only report the shape it would be in: `?computer=granting` renders the pane mid
    // sequence, which is the state the 授权 button is otherwise hard to look at.
    startGrantFlow: async () => grantFlowState(),
    cancelGrantFlow: async () => undefined,
    getGrantFlow: async () => grantFlowState(),
    onGrantFlowState: () => () => undefined,
  },
};

function grantFlowState(): { active: boolean; permission?: "accessibility" | "screenRecording"; step: number; total: number } {
  if (params.get("computer") !== "granting") return { active: false, step: 0, total: 0 };
  return { active: true, permission: "screenRecording", step: 1, total: 2 };
}

function computerStatus(): {
  platform: string;
  accessibility: boolean;
  screenRecording: boolean;
  ready: boolean;
  available: boolean;
} {
  const granted = params.get("computer") === "granted";
  return {
    platform: params.get("platform") ?? "darwin",
    accessibility: granted,
    screenRecording: granted,
    ready: granted,
    available: params.get("computer") !== "unavailable",
  };
}

/* ------------------------------------------------------------------ 远程访问 fixtures */

/**
 * 远程访问 in the preview, in one of three shapes.
 *
 * The default is a machine nobody has set up, which is the pane's first screen and the
 * one that has to read as an invitation rather than as a failure. The other two are the
 * ends of the tunnel story, and neither can be reached in a browser otherwise — the real
 * thing needs a password, a port and somebody else's binary:
 *
 * - `?tunnel=online`: a running server with a Cloudflare quick tunnel in front of it,
 *   which is the only way to see the public address and its QR code here.
 * - `?tunnel=missing`: a server running with ngrok chosen and nothing installed, which
 *   is the state most machines are actually in the first time the pane is opened.
 */
const TUNNEL_IDLE = {
  provider: null,
  phase: "off" as const,
  url: null,
  error: null,
  output: [],
  needsAuth: false,
};

const REMOTE_OFF = {
  running: false,
  host: "127.0.0.1",
  port: null,
  configured: false,
  clients: 0,
  failedLogins: 0,
  tunnel: TUNNEL_IDLE,
  tunnelChoice: null,
};

const REMOTE_ONLINE = {
  running: true,
  host: "127.0.0.1",
  port: 7777,
  configured: true,
  clients: 1,
  failedLogins: 0,
  tunnel: {
    ...TUNNEL_IDLE,
    provider: "cloudflared" as const,
    phase: "online" as const,
    url: "https://fluffy-panda-rides-again.trycloudflare.com",
  },
  tunnelChoice: "cloudflared" as const,
};

const REMOTE_MISSING = {
  ...REMOTE_ONLINE,
  clients: 0,
  tunnel: TUNNEL_IDLE,
  tunnelChoice: "ngrok" as const,
};

/** ngrok installed, chosen, and refused for want of an authtoken. */
const REMOTE_NOAUTH = {
  ...REMOTE_ONLINE,
  clients: 0,
  tunnel: {
    ...TUNNEL_IDLE,
    provider: "ngrok" as const,
    phase: "error" as const,
    error: "ngrok 认证失败：还没有配置可用的 authtoken",
    output: [
      '{"lvl":"eror","msg":"authentication failed","err":"Usage of ngrok requires a verified account and authtoken. ERR_NGROK_4018"}',
    ],
    needsAuth: true,
  },
  tunnelChoice: "ngrok" as const,
};

const tunnelFixture = params.get("tunnel");

const REMOTE_STATE =
  tunnelFixture === "online"
    ? REMOTE_ONLINE
    : tunnelFixture === "missing"
      ? REMOTE_MISSING
      : tunnelFixture === "noauth"
        ? REMOTE_NOAUTH
        : REMOTE_OFF;

const REMOTE_DEVICES =
  tunnelFixture === "online"
    ? [{ id: "device-1", label: "iPhone", createdAt: Date.now() - 86_400_000, lastSeenAt: Date.now() - 120_000 }]
    : [];

/**
 * What each fixture needs of the probe.
 *
 * `?tunnel=noauth` is the one that needs ngrok *installed*: the whole point of that
 * state is a binary that is present and cannot authenticate, which is a different block
 * in the pane from a binary that is not there at all.
 */
const REMOTE_TOOLS =
  tunnelFixture === "noauth"
    ? {
        cloudflared: { installed: true, path: "/opt/homebrew/bin/cloudflared", version: "cloudflared version 2026.9.0", authenticated: null },
        ngrok: { installed: true, path: "/opt/homebrew/bin/ngrok", version: "ngrok version 3.30.0", authenticated: false },
      }
    : {
        cloudflared: { installed: true, path: "/opt/homebrew/bin/cloudflared", version: "cloudflared version 2026.9.0", authenticated: null },
        ngrok: { installed: false, path: null, version: null, authenticated: false },
      };

window.fastvibe = api as unknown as typeof window.fastvibe;

installIconRewrite();

/**
 * Website captures run in a browser, so Electron cannot draw macOS window controls.
 * Keep this strictly inside the dedicated website fixture and inside the 88px title
 * row clearance used by the real macOS shell.
 */
if (website && platform === "darwin" && !remote) {
  const controls = document.createElement("div");
  controls.setAttribute("aria-hidden", "true");
  controls.dataset.websiteTrafficLights = "true";
  Object.assign(controls.style, {
    position: "fixed",
    left: "20px",
    top: "16px",
    display: "flex",
    gap: "8px",
    zIndex: "1000",
    pointerEvents: "none",
  });
  for (const color of ["#ff5f57", "#febc2e", "#28c840"]) {
    const light = document.createElement("span");
    Object.assign(light.style, {
      width: "12px",
      height: "12px",
      borderRadius: "9999px",
      background: color,
      boxShadow: "inset 0 0 0 0.5px rgb(0 0 0 / 22%)",
    });
    controls.append(light);
  }
  document.body.append(controls);
}

/* ------------------------------------------------------------------ layout tweaks */

if (websiteData && websiteScene !== "models") {
  window.setTimeout(() => {
    void import("@/stores/side-pane").then(({ useSidePaneStore }) => {
      const store = useSidePaneStore.getState();
      if (websiteScene === "review") {
        store.openGitDiff("src/components/CommandMenu.tsx", "unstaged", websiteData.cwd);
      } else {
        store.openFiles();
        store.openFilePreview(websiteData.previewFor(websiteData.previewPath));
      }
    });
  }, 500);

  // Wait for React rather than racing a fixed delay on a cold Vite build.
  const selectSceneControl = () => {
    const button = websiteScene === "workspace"
      ? document.querySelector<HTMLElement>('[data-tool-id="website-todo"]')?.closest("button")
      : [...document.querySelectorAll<HTMLButtonElement>("button")]
        .find((node) => (node.textContent ?? "").startsWith("CommandMenu.tsxsrc/components"));
    if (!button) return false;
    button.click();
    document.body.dataset.websiteSceneReady = websiteScene;
    return true;
  };
  const observer = new MutationObserver(() => {
    if (selectSceneControl()) observer.disconnect();
  });
  if (!selectSceneControl()) {
    observer.observe(document.body, { childList: true, subtree: true });
    window.setTimeout(() => observer.disconnect(), 15_000);
  }
}

if (pane === "files" || pane === "preview" || pane === "git") {
  window.setTimeout(() => {
    void import("@/stores/side-pane").then(({ useSidePaneStore }) => {
      const store = useSidePaneStore.getState();
      if (pane === "git") {
        store.openGit();
        return;
      }
      store.openFiles();
      if (maximize) store.toggleMaximized();
      if (pane === "preview") {
        store.openFilePreview(previewFor(`${PREVIEW_CWD}/src/renderer/src/components/settings/theme-select.tsx`));
      }
    });
  }, 400);
}

if (dialog === "market") {
  // Sidebar 「插件」 routes to Settings → 插件; open the catalog tab.
  window.location.hash = "#/settings/extensions";
  const clickByText = (text: string, root: ParentNode = document): boolean => {
    const target = [...root.querySelectorAll<HTMLElement>("button")].find((node) =>
      (node.textContent ?? "").includes(text),
    );
    target?.click();
    return Boolean(target);
  };
  window.setTimeout(() => clickByText("官方市场"), 800);
}

if (expand === "tools") {
  window.setTimeout(() => {
    document.querySelectorAll<HTMLElement>('[data-slot="tool-row"]').forEach((row) => {
      row.closest("button")?.click();
    });
  }, 1500);
}

if (expand === "run") {
  // 折叠运行过程: open every folded run so its process is visible in a screenshot.
  window.setTimeout(() => {
    document.querySelectorAll<HTMLElement>('[data-slot="run-collapse"]').forEach((row) => {
      row.closest("button")?.click();
    });
  }, 1500);
}

if (scroll) {
  // A synthetic wheel marks "the reader took over", which makes the scroller drop
  // out of following the bottom; then pin the offset once. Fighting it with an
  // interval would thrash the scroller's per-scroll re-measure.
  const pin = (): void => {
    const viewport = document.querySelector<HTMLElement>('[data-slot="message-scroller-viewport"]');
    if (!viewport) return;
    viewport.dispatchEvent(new WheelEvent("wheel", { deltaY: -120, bubbles: true }));
    viewport.scrollTop = scroll === "top" ? 0 : Math.round(viewport.scrollHeight * 0.32);
  };
  window.setTimeout(pin, 1200);
  window.setTimeout(pin, 2600);
}

// Re-apply the requested theme once settings and the store are live.
if (theme === "light" || theme === "dark") {
  window.setTimeout(() => {
    void import("@/stores/settings").then(({ useSettingsStore }) => {
      useSettingsStore.getState().update({ themeMode: theme });
    });
  }, 200);
}

