import type { ChatMessage, ConversationOpenResult, EngineStatus, WorkspaceSnapshot } from "@shared/types";
import type { AppInfo, GitStatus } from "@shared/ipc";
import {
  COMMANDS,
  CONVERSATIONS,
  INSTALLED_PACKAGES,
  MARKET_PACKAGES,
  MCP_SERVERS,
  MESSAGES,
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
const theme = params.get("theme");
const pane = params.get("pane");
const scroll = params.get("scroll");
const dialog = params.get("dialog");
const expand = params.get("expand");

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
  showTimestamps: true,
  sendOnEnter: true,
  themeMode: theme === "light" || theme === "dark" ? theme : "system",
  lightTheme: "github-light",
  darkTheme: "tokyo-night",
  sidebarWidth: 264,
  sidebarCollapsed: false,
  sidePaneWidth: 384,
};

const snapshot = (): WorkspaceSnapshot => ({
  projects: PROJECTS,
  conversations: CONVERSATIONS,
  activeId: "conv-theme",
});

const openResult = (id: string): ConversationOpenResult => {
  const conversation = CONVERSATIONS.find((item) => item.id === id) ?? CONVERSATIONS[0];
  const isActive = conversation.id === "conv-theme";
  return {
    ...snapshot(),
    conversation,
    messages: isActive ? MESSAGES : [],
    state: isActive ? SESSION : { ...SESSION, messageCount: 0 },
    status: { state: "ready", cwd: PREVIEW_CWD },
  };
};

const status: EngineStatus = { state: "ready", cwd: PREVIEW_CWD };

const APP_INFO: AppInfo = {
  version: "0.1.0",
  userData: "/Users/dev/Library/Application Support/FastVibe",
  runtimeRoot: "/Users/dev/Library/Application Support/FastVibe/runtime/engine",
  platform: "darwin",
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
 * The real app serves icons over a private `fastvibe-icon://` scheme registered by
 * Electron. In a plain browser that scheme is unknown, so rewrite the images to the
 * package's SVG files that the Vite dev server exposes.
 */
function rewriteIcons(scope: ParentNode): void {
  scope.querySelectorAll<HTMLImageElement>('img[src^="fastvibe-icon://"]').forEach((image) => {
    const name = (image.getAttribute("src") ?? "").replace("fastvibe-icon://icons/", "").replace(/\.svg$/, "");
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
    followUp: async () => undefined,
    abort: async () => undefined,
    continue: async () => undefined,
    clearQueue: async () => ({ steering: [], followUp: [] }),
    compact: async () => SESSION,
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
    getSubagents: async () => [],
    getSubagentMessages: async (): Promise<ChatMessage[]> => [],
    respondPermission: async () => undefined,
    newSession: async () => undefined,
    getState: async () => SESSION,
    getRunning: async (): Promise<string[]> => [],
    getModels: async () => MODELS,
    setModel: async () => SESSION,
    setThinking: async () => SESSION,
    setInterruptMode: async () => SESSION,
    setAutoCompaction: async () => SESSION,
    branch: async () => MESSAGES,
    getMessages: async () => MESSAGES,
    getStats: async () => STATS,
    setSteeringMode: async () => SESSION,
    setFollowUpMode: async () => SESSION,
    exportHtml: async () => undefined,
    promptConversation: async () => undefined,
    getConversationMessages: async (): Promise<ChatMessage[]> => [],
    onEvent: () => () => undefined,
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
    create: async (project?: string) => openResult(CONVERSATIONS[0].id),
    open: async (id: string) => openResult(id),
    rename: async () => snapshot(),
    delete: async () => ({ ...snapshot(), nextId: CONVERSATIONS[0].id }),
    recordPrompt: async () => snapshot(),
    setProject: async () => snapshot(),
    createSide: async () => openResult(CONVERSATIONS[0].id),
    search: async (query: string) => {
      const needle = query.trim().toLowerCase();
      if (needle.length < 2) return [];
      return CONVERSATIONS.filter((item) => `${item.title} ${item.preview ?? ""}`.toLowerCase().includes(needle)).map(
        (item) => ({ id: item.id, snippet: item.preview }),
      );
    },
  },
  projects: {
    add: async () => null,
    rename: async () => snapshot(),
    remove: async () => ({ ...snapshot(), nextId: null }),
    reorder: async (cwds: string[]) => {
      const rank = new Map(cwds.map((cwd, index) => [cwd, index]));
      PROJECTS.sort((a, b) => (rank.get(a.cwd) ?? Number.MAX_SAFE_INTEGER) - (rank.get(b.cwd) ?? Number.MAX_SAFE_INTEGER));
      return snapshot();
    },
  },
  workspace: {
    pick: async () => null,
    reveal: async () => undefined,
    preview: async (path: string) => previewFor(path),
    fileIcons: loadIconMapping,
    readDir: async (path: string) => TREE[path] ?? [],
    gitStatus: async (cwd: string): Promise<GitStatus> => ({
      cwd,
      isRepository: true,
      branch: "feat/theme-mode",
      changed: 4,
      staged: 1,
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
    gitDiff: async (_cwd: string, path?: string) => {
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
    terminalStart: async (cwd?: string) => ({ id: "term-mock", cwd: cwd ?? PREVIEW_CWD }),
    terminalWrite: async () => undefined,
    terminalResize: async () => undefined,
    terminalKill: async () => undefined,
    onTerminalData: () => () => undefined,
  },
  app: {
    getInfo: async () => APP_INFO,
    newWindow: async () => undefined,
  },
  settings: {
    initial: initialSettings,
    load: async () => initialSettings,
    save: async () => undefined,
    clear: async () => undefined,
  },
  stats: {
    usage: async () => USAGE,
  },
  // The browser-use bridge is main-process driven: in the preview nothing ever
  // requests a browser action, so `onRequest` just returns its unsubscribe.
  browser: {
    onRequest: () => () => undefined,
    respond: () => undefined,
  },
};

window.fastvibe = api as unknown as typeof window.fastvibe;

installIconRewrite();

/* ------------------------------------------------------------------ layout tweaks */

if (pane === "files" || pane === "preview" || pane === "git") {
  window.setTimeout(() => {
    void import("@/stores/side-pane").then(({ useSidePaneStore }) => {
      const store = useSidePaneStore.getState();
      if (pane === "git") {
        store.openGit();
        return;
      }
      store.openFiles();
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
