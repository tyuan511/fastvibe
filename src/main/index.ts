import { app, BrowserWindow, dialog, ipcMain, nativeImage, Notification, protocol, session, shell } from "electron";
import type { WebContents } from "electron";
import { statSync } from "node:fs";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { join } from "node:path";
import { homedir } from "node:os";
import { Ipc, type AppModelsDevInfo } from "@shared/ipc";
import { broadcast, subscribe } from "./ipc/broadcast";
import { dispatch, handle, handlerChannels, type CallerContext } from "./ipc/registry";
import { registerRemoteIpc, restoreRemoteServer, stopRemoteServer } from "./remote";
import { readFilePreview } from "./engine/file-preview";
import { readWorkspaceDir } from "./engine/workspace-fs";
import { loadModelsDev, type ModelsDevStats } from "./engine/models-dev";
import { updateModelsDevSnapshot } from "./engine/models-dev-update";
import {
  applyNativeTheme,
  applyPermissionMode,
  applyStartupPermissionMode,
  clearAppSettings,
  paintWindows,
  readAppSettings,
  windowBackgroundColor,
  writeAppSettings,
} from "./engine/app-settings";
import { getFastVibePaths, type FastVibePaths } from "./engine/paths";
import { isNotificationPreference, type NotificationPreference } from "@shared/types";
import { applyLanguages } from "./engine/ai-language";
import { uiText } from "./engine/ui-text";
import { applyShellPath } from "./engine/shell-path";
import { exportLogs, initLogger, log, writeRendererLog } from "./engine/logger";
import { applyKeepAwake, clearRunningConversations, setConversationRunning } from "./engine/keep-awake";
import {
  getFileIconMapping,
  registerFileIconProtocol,
  registerFileIconScheme,
} from "./engine/file-icons";
import { collectUsageStats } from "./engine/usage-stats";
import { applyPendingInstall, registerUpdater, scheduleUpdateCheck } from "./updater";
import { PiProcessManager } from "./pi/process-manager";
import { fetchPackageCatalog } from "./pi/package-catalog";
import { TerminalSessions } from "./engine/terminal-sessions";
import { attachBrowserRenderer, installBrowserGlobal, respondBrowserRequest } from "./pi/browser-bridge";
import { importBrowserProfile, listBrowserProfiles } from "./engine/browser-profiles";
import type { ImportSourceId, ProviderModel, UsageRange } from "@shared/types";
import type { GitBranch, GitDiffSource, GitStatus } from "@shared/ipc";

const execFileAsync = promisify(execFile);

app.setName("FastVibe");

// GUI-launched Electron inherits a stub PATH. Fill in Homebrew / user bins
// before any agent session, MCP stdio server or in-app terminal is spawned.
applyShellPath();

// Privileged schemes must be declared before the app is ready.
registerFileIconScheme();

// File logger before anything that can throw: engine construction, IPC, windows.
initLogger();

// Extensions are TypeScript modules jiti compiles at load time. Its on-disk cache
// cannot be written inside the packaged asar, so turn it off there; dev keeps the
// cache for faster reloads.
if (app.isPackaged) process.env.JITI_FS_CACHE = "false";

const engine = new PiProcessManager();
const terminals = new TerminalSessions();
let mainWindow: BrowserWindow | null = null;
const windows = new Set<BrowserWindow>();

function resolveAppIcon(): string {
  const name = process.platform === "darwin" ? "icon.icns" : "icon.png";
  return app.isPackaged
    ? join(process.resourcesPath, name)
    : join(__dirname, "../../resources", name);
}

function applyAppIcon(): void {
  const image = nativeImage.createFromPath(resolveAppIcon());
  if (image.isEmpty()) return;
  if (process.platform === "darwin") {
    app.dock?.setIcon(image);
  }
}

/**
 * macOS keeps its own traffic lights, inset into the app's first row
 * (`hiddenInset`). Windows and Linux have no such thing to inset, so the window
 * ships with no chrome at all and the renderer draws the whole title bar — logo,
 * history and its own minimise/maximise/close (`components/layout/title-bar.tsx`).
 */
const IS_MAC = process.platform === "darwin";

function createWindow(): void {
  const window = new BrowserWindow({
    width: 1280,
    height: 840,
    minWidth: 920,
    minHeight: 640,
    title: "FastVibe",
    icon: resolveAppIcon(),
    backgroundColor: windowBackgroundColor(),
    // A frameless Linux window is the predictable spelling of the same thing
    // across window managers; on Windows `hidden` keeps the native thick frame,
    // so the window still resizes, snaps and casts a shadow.
    frame: process.platform === "linux" ? false : undefined,
    titleBarStyle: IS_MAC ? "hiddenInset" : "hidden",
    trafficLightPosition: IS_MAC ? { x: 16, y: 16 } : undefined,
    show: false,
      webPreferences: {
        preload: join(__dirname, "../preload/index.mjs"),
        sandbox: false,
        contextIsolation: true,
        nodeIntegration: false,
        webviewTag: true,
      },
  });

  window.on("ready-to-show", () => window.show());
  // The title bar's maximise control swaps its glyph on this; Main owns the truth
  // because the OS can also maximise the window (snap, double-click, a WM key).
  const sendWindowState = (): void => {
    if (window.isDestroyed()) return;
    window.webContents.send(Ipc.windowState, { maximized: window.isMaximized() });
  };
  window.on("maximize", sendWindowState);
  window.on("unmaximize", sendWindowState);
  // A window is just one receiver among others now (`ipc/broadcast.ts`); pushes reach
  // it through the hub rather than through a loop that knows what a window is.
  const unsubscribe = subscribe({
    id: windowOrigin(window.webContents.id),
    send: (channel, payload) => {
      if (window.isDestroyed()) return;
      window.webContents.send(channel, payload);
    },
  });
  window.on("closed", () => {
    unsubscribe();
    windows.delete(window);
    if (mainWindow === window) mainWindow = windows.values().next().value ?? null;
  });
  window.webContents.setWindowOpenHandler((details) => {
    shell.openExternal(details.url);
    return { action: "deny" };
  });
  window.webContents.on("preload-error", (path, error) => {
    log.error(`preload-error path=${path}`, error);
  });
  window.webContents.on("unresponsive", () => log.warn("window unresponsive"));
  window.webContents.on("responsive", () => log.info("window responsive"));
  attachBrowserRenderer(window.webContents);

  if (process.env.ELECTRON_RENDERER_URL) {
    window.loadURL(process.env.ELECTRON_RENDERER_URL);
  } else {
    window.loadFile(join(__dirname, "../renderer/index.html"));
  }

  mainWindow = window;
  windows.add(window);
  log.info("window opened");
}

/**
 * Broadcast identity of one window, derived from its WebContents id. It is what
 * `settings:set` skips so a window is not told to re-read what it just wrote.
 */
function windowOrigin(webContentsId: number): string {
  return `window:${webContentsId}`;
}

function broadcastStatus(): void {
  broadcast(Ipc.status, engine.status);
}

/** The models.dev metadata shape the renderer's 关于 pane reads. */
function modelsDevInfo(stats: ModelsDevStats): AppModelsDevInfo {
  return {
    models: stats.models,
    aliases: stats.aliases,
    generatedAt: stats.generatedAt,
    path: stats.path,
  };
}

function registerIpc(): void {
  handle(Ipc.browserResponse, (payload: { id: string; ok: boolean; result?: unknown; error?: string }) => {
    respondBrowserRequest(payload);
  });
  handle(Ipc.browserListProfiles, () => listBrowserProfiles());
  handle(Ipc.browserImportProfile, async (payload: { profile: import("@shared/types").BrowserProfileInfo }) => {
    if (!payload?.profile?.cookiePath) throw new Error(uiText("浏览器配置文件无效", "Invalid browser profile"));
    const allowed = (await listBrowserProfiles()).find((profile) => profile.id === payload.profile.id && profile.cookiePath === payload.profile.cookiePath);
    if (!allowed) throw new Error(uiText("浏览器配置文件未通过校验，请重新打开导入列表", "Browser profile failed validation. Open the list again."));
    return importBrowserProfile(allowed, (cookie) => session.fromPartition("persist:fastvibe-browser").cookies.set(cookie));
  });
  handle(Ipc.engineGetStatus, () => engine.status);

  handle(Ipc.engineStart, async (payload?: { cwd?: string }) => {
    return engine.start(payload?.cwd ?? engine.cwd);
  });

  handle(Ipc.engineStop, async () => {
    await engine.stop();
    return engine.status;
  });

  handle(
    Ipc.enginePrompt,
    async (
      payload: {
        message: string;
        streamingBehavior?: "steer" | "followUp";
        images?: Array<{ type: "image"; data: string; mimeType: string }>;
        /** Omitted by single-window callers, which mean "the chat on screen". */
        conversationId?: string;
      },
    ) => {
      await engine.prompt(payload.message, {
        streamingBehavior: payload.streamingBehavior,
        images: payload.images,
        conversationId: payload.conversationId,
      });
    },
  );

  handle(
    Ipc.engineSteer,
    async (
      payload: { message: string; images?: Array<{ type: "image"; data: string; mimeType: string }>; conversationId?: string },
    ) => {
      await engine.steer(payload.message, payload.images, payload.conversationId);
    },
  );

  handle(
    Ipc.engineFollowUp,
    async (
      payload: { message: string; images?: Array<{ type: "image"; data: string; mimeType: string }>; conversationId?: string },
    ) => {
      await engine.followUp(payload.message, payload.images, payload.conversationId);
    },
  );

  handle(Ipc.engineAbort, async (payload?: { conversationId?: string }) => {
    await engine.abort(payload?.conversationId);
  });

  handle(Ipc.engineAbortSubagent, async (payload: { subagentId: string }) => {
    await engine.abortSubagent(payload.subagentId);
  });

  handle(Ipc.engineContinue, async (payload?: { conversationId?: string }) => {
    await engine.continueTurn(payload?.conversationId);
  });

  handle(Ipc.engineClearQueue, async (payload?: { conversationId?: string }) => {
    return engine.clearQueue(payload?.conversationId);
  });

  handle(
    Ipc.engineReplaceSteering,
    async (
      payload: {
        items: Array<{ text: string; images?: Array<{ type: "image"; data: string; mimeType: string }> }>;
        conversationId?: string;
      },
    ) => {
      await engine.replaceSteering(payload.items, payload.conversationId);
    },
  );

  handle(Ipc.engineCompact, async (payload?: { customInstructions?: string; conversationId?: string }) => {
    return engine.compact(payload?.customInstructions, payload?.conversationId);
  });

  handle(Ipc.engineGetCommands, async () => {
    return engine.getCommands();
  });
  handle(Ipc.engineGetExtensions, async () => engine.getExtensions());
  handle(Ipc.engineListExtensionPackages, async () => engine.listExtensionPackages());
  handle(
    Ipc.engineInstallExtensionPackage,
    async (payload: { source: string }) => engine.installExtensionPackage(payload.source),
  );
  handle(
    Ipc.engineRemoveExtensionPackage,
    async (payload: { source: string }) => engine.removeExtensionPackage(payload.source),
  );
  handle(
    Ipc.engineListMarketPackages,
    async (payload: import("@shared/types").MarketPackageQuery) => fetchPackageCatalog(payload),
  );
  handle(Ipc.engineListMcpServers, async () => engine.listMcpServers());
  handle(Ipc.engineSaveMcpServers, async (payload: { configs: import("@shared/types").McpServerConfig[] }) => engine.saveMcpServers(payload.configs));
  handle(Ipc.engineListSkills, async () => engine.listSkills());
  handle(Ipc.engineCreateSkill, async (payload: import("@shared/types").SkillDraft) => engine.createSkill(payload));
  handle(Ipc.engineImportSkill, async () => {
    const result = await dialog.showOpenDialog({
      title: uiText("导入技能", "Import skill"),
      properties: ["openDirectory"],
    });
    if (result.canceled || !result.filePaths[0]) return null;
    return engine.importSkill(result.filePaths[0]);
  });
  handle(Ipc.engineRemoveSkill, async (payload: { name: string }) => engine.removeSkill(payload.name));

  handle(Ipc.engineGetSubagents, async () => {
    return engine.getSubagents();
  });
  handle(Ipc.engineListAgentConfigs, () => engine.getAgentConfigs());
  handle(Ipc.engineSaveAgentConfig, (payload: import("@shared/types").SubagentDraft) => engine.saveAgentConfig(payload));
  handle(Ipc.engineRemoveAgentConfig, (payload: { id: string }) => engine.removeAgentConfig(payload.id));

  handle(Ipc.engineGetSubagentMessages, async (payload: { subagentId: string }) => {
    return engine.getSubagentMessages(payload.subagentId);
  });

  handle(Ipc.engineGetCheckpoint, (payload: { conversationId: string }) => {
    return engine.getCheckpoint(payload.conversationId);
  });

  handle(Ipc.engineRestoreCheckpoint, async (payload: { conversationId: string }) => {
    return engine.restoreCheckpoint(payload.conversationId);
  });

  handle(Ipc.conversationsSearch, (payload: { query?: string }) => {
    return engine.searchConversations(payload?.query ?? "");
  });

  handle(
    Ipc.enginePermissionRespond,
    (payload: { id: string; confirmed?: boolean; value?: string; cancelled?: boolean; answers?: Array<string | null>; planAction?: "approve" | "revise" | "ignore" }) => {
      engine.respondPermission(payload);
    },
  );

  handle(Ipc.engineNewSession, async () => {
    await engine.newSession();
  });

  handle(Ipc.engineGetState, async (payload?: { conversationId?: string }) => {
    return engine.getState(payload?.conversationId);
  });

  handle(Ipc.engineGetRunning, async () => {
    return engine.getRunningConversations();
  });

  handle(Ipc.engineGetModels, async () => {
    return engine.getAvailableModels();
  });

  handle(
    Ipc.engineSetModel,
    async (payload: { provider: string; modelId: string; conversationId?: string }) => {
      return engine.setModel(payload.provider, payload.modelId, payload.conversationId);
    },
  );

  handle(
    Ipc.engineSetThinking,
    async (payload: { level: string; conversationId?: string }) => {
      return engine.setThinkingLevel(payload.level, payload.conversationId);
    },
  );
  handle(Ipc.engineSetInterrupt, async (payload: { mode: "immediate" | "wait" }) => {
    return engine.setInterruptMode(payload.mode);
  });
  handle(Ipc.engineSetAutoCompact, async (payload: { enabled: boolean }) => {
    return engine.setAutoCompaction(payload.enabled);
  });
  handle(Ipc.engineBranch, async (payload: { entryId: string; conversationId?: string }) => {
    return engine.branch(payload.entryId, payload.conversationId);
  });
  handle(Ipc.engineGetMessages, async (payload?: { conversationId?: string }) => {
    return engine.loadMessages(payload?.conversationId);
  });
  handle(Ipc.engineGetSnapshot, async (payload?: { conversationId?: string }) => {
    return engine.getSnapshot(payload?.conversationId);
  });
  handle(Ipc.engineGetStats, async (payload?: { conversationId?: string }) => {
    return engine.getSessionStats(payload?.conversationId);
  });
  handle(Ipc.engineSetSteering, async (payload: { mode: "all" | "one-at-a-time" }) => {
    return engine.setSteeringMode(payload.mode);
  });
  handle(Ipc.engineSetFollowUp, async (payload: { mode: "all" | "one-at-a-time" }) => {
    return engine.setFollowUpMode(payload.mode);
  });
  handle(Ipc.engineExportHtml, async () => {
    const path = await engine.exportHtml();
    if (path) await shell.openPath(path);
    return path;
  });
  // 设置 → 导入. Read-only scans of the other agents' data plus an explicit import;
  // nothing here runs on the live engine, so a scan cannot disturb the chat in flight.
  handle(Ipc.engineImportSources, async () => engine.importSources());
  handle(Ipc.engineImportCandidates, async (payload: { source: ImportSourceId }) =>
    engine.importCandidates(payload.source),
  );
  handle(Ipc.engineImportSessions, async (payload: { source: ImportSourceId; ids: string[] }) =>
    engine.importSessions(payload.source, payload.ids),
  );

  handle(Ipc.providersList, async () => {
    return engine.listProviders();
  });
  handle(Ipc.providersNative, async () => {
    return engine.listNativeProviders();
  });
  handle(
    Ipc.providersAddNative,
    async (payload: { id: string; apiKey: string; models: ProviderModel[] }) => {
      return engine.addNativeProvider(payload.id, payload.apiKey, payload.models);
    },
  );
  handle(
    Ipc.providersFetch,
    async (payload: { baseUrl: string; apiKey: string; api?: import("@shared/types").ProviderApi }) => {
      return engine.fetchModels(payload.baseUrl, payload.apiKey, payload.api);
    },
  );
  handle(
    Ipc.providersSaveFastVibe,
    async (payload: { apiKey: string; models: ProviderModel[] }) => {
      return engine.saveFastVibe(payload.apiKey, payload.models);
    },
  );
  handle(
    Ipc.providersAdd,
    async (payload: { name: string; baseUrl: string; apiKey: string; api?: import("@shared/types").ProviderApi; models: ProviderModel[] }) => {
      return engine.addProvider(
        { name: payload.name, baseUrl: payload.baseUrl, apiKey: payload.apiKey, api: payload.api },
        payload.models,
      );
    },
  );
  handle(
    Ipc.providersUpdate,
    async (
      payload: { id: string; name?: string; baseUrl?: string; api?: import("@shared/types").ProviderApi; enabled?: boolean; apiKey?: string; models?: ProviderModel[] },
    ) => {
      return engine.updateProvider(payload.id, {
        name: payload.name,
        baseUrl: payload.baseUrl,
        api: payload.api,
        enabled: payload.enabled,
        apiKey: payload.apiKey,
        models: payload.models,
      });
    },
  );
  handle(Ipc.providersRemove, async (payload: { id: string }) => {
    return engine.removeProvider(payload.id);
  });
  handle(Ipc.providersRefresh, async (payload: { id: string }) => {
    return engine.refreshProviderModels(payload.id);
  });
  handle(Ipc.providersQuota, async (payload: { id: string; force?: boolean }) => {
    return engine.getOpenAIAccountQuota(payload.id, payload.force === true);
  });
  handle(Ipc.providersCcSwitchScan, async () => {
    return engine.scanCcSwitch();
  });
  handle(Ipc.providersCcSwitchImport, async (payload: { ids: string[] }) => {
    return engine.importCcSwitch(payload.ids);
  });
  // Subscription (OAuth) logins. `login` resolves when the flow ends, so the renderer
  // holds one open dialog per provider while its events stream in on
  // `providers:oauth-event` — the prompts it has to answer among them.
  handle(Ipc.providersOAuthLogin, async (payload: { id: string }) => {
    return engine.loginProvider(payload.id);
  });
  handle(
    Ipc.providersOAuthAnswer,
    (payload: { id: string; promptId: string; value: string }) => {
      engine.answerOAuthPrompt(payload.id, payload.promptId, payload.value ?? "");
    },
  );
  handle(Ipc.providersOAuthCancel, (payload: { id: string }) => {
    engine.cancelOAuthLogin(payload.id);
  });
  handle(Ipc.providersLogout, async (payload: { id: string }) => {
    return engine.logoutProvider(payload.id);
  });

  handle(Ipc.conversationsList, () => engine.listWorkspace());
  handle(Ipc.conversationsCreate, async (payload?: { project?: string }) => {
    return engine.createConversation(payload?.project);
  });
  handle(Ipc.conversationsOpen, async (payload: { id: string }) => {
    return engine.openConversation(payload.id);
  });
  handle(Ipc.conversationsRename, (payload: { id: string; title: string }) => {
    return engine.renameConversation(payload.id, payload.title);
  });
  handle(Ipc.conversationsDelete, async (payload: { id: string }) => {
    return engine.deleteConversation(payload.id);
  });
  handle(Ipc.conversationsRecordPrompt, (payload: { id: string; text: string }) => {
    return engine.recordPrompt(payload.id, payload.text);
  });
  handle(Ipc.conversationsSetProject, async (payload: { id: string; project: string | null }) => {
    return engine.setConversationProject(payload.id, payload.project);
  });
  handle(Ipc.projectsAdd, async () => {
    const result = await dialog.showOpenDialog({
      title: uiText("打开项目", "Open project"),
      properties: ["openDirectory", "createDirectory"],
    });
    if (result.canceled || !result.filePaths[0]) return null;
    return engine.addProject(result.filePaths[0]);
  });
  handle(Ipc.projectsRename, (payload: { cwd: string; name: string }) => {
    return engine.renameProject(payload.cwd, payload.name);
  });
  handle(Ipc.projectsRemove, async (payload: { cwd: string }) => {
    return engine.removeProject(payload.cwd);
  });
  handle(Ipc.projectsReorder, (payload: { cwds: string[] }) => {
    return engine.reorderProjects(Array.isArray(payload?.cwds) ? payload.cwds : []);
  });
  handle(Ipc.workspaceReveal, async (payload: { cwd: string }) => {
    if (!payload.cwd) return;
    try {
      if (statSync(payload.cwd).isFile()) {
        shell.showItemInFolder(payload.cwd);
        return;
      }
    } catch {
      // fall through
    }
    await shell.openPath(payload.cwd);
  });
  handle(Ipc.workspacePreview, (payload: { path: string }) => {
    if (!payload.path) return { kind: "error", path: "", name: "", message: uiText("路径无效", "Invalid path") };
    return readFilePreview(payload.path);
  });
  handle(Ipc.workspaceFileIcons, () => getFileIconMapping());
  handle(Ipc.workspaceReadDir, (payload: { path: string }) => {
    try {
      return readWorkspaceDir(payload.path);
    } catch {
      return [];
    }
  });
  handle(Ipc.workspaceGitStatus, async (payload: { cwd: string }): Promise<GitStatus> => {
    const cwd = typeof payload.cwd === "string" ? payload.cwd.trim() : "";
    if (!cwd) return { cwd, isRepository: false, changed: 0, staged: 0, files: [] };
    return readGitStatus(cwd);
  });
  handle(Ipc.workspaceOpenTerminal, async (payload: { cwd: string }): Promise<void> => {
    const cwd = typeof payload.cwd === "string" ? payload.cwd.trim() : "";
    if (!cwd) return;
    if (process.platform === "darwin") {
      await execFileAsync("open", ["-a", "Terminal", cwd]);
    } else if (process.platform === "win32") {
      await execFileAsync("cmd.exe", ["/c", "start", "", cwd]);
    } else {
      await execFileAsync("x-terminal-emulator", ["--working-directory", cwd]);
    }
  });
  handle(Ipc.workspaceGitBranches, async (payload: { cwd: string }): Promise<GitBranch[]> => {
    const cwd = typeof payload.cwd === "string" ? payload.cwd.trim() : "";
    if (!cwd) return [];
    try {
      const { stdout } = await execFileAsync("git", ["-C", cwd, "for-each-ref", "--format=%(refname:short)\t%(HEAD)\t%(upstream:short)", "refs/heads"], { timeout: 5000, maxBuffer: 128 * 1024 });
      return stdout.split(/\r?\n/).filter(Boolean).map((line) => {
        const [name, head, upstream] = line.split("\t");
        return { name, current: head === "*", upstream: upstream || undefined };
      });
    } catch {
      return [];
    }
  });
  handle(Ipc.workspaceGitCheckout, async (payload: { cwd: string; branch: string }): Promise<GitStatus> => {
    const cwd = typeof payload.cwd === "string" ? payload.cwd.trim() : "";
    const branch = typeof payload.branch === "string" ? payload.branch.trim() : "";
    if (!cwd || !branch || branch.startsWith("-") || branch.includes("\0")) throw new Error(uiText("分支名称无效", "Invalid branch name"));
    await execFileAsync("git", ["-C", cwd, "switch", branch], { timeout: 10000, maxBuffer: 128 * 1024 });
    return readGitStatus(cwd);
  });
  handle(Ipc.workspaceGitCreateBranch, async (payload: { cwd: string; branch: string }): Promise<GitStatus> => {
    const cwd = typeof payload.cwd === "string" ? payload.cwd.trim() : "";
    const branch = typeof payload.branch === "string" ? payload.branch.trim() : "";
    if (!cwd || !branch || branch.startsWith("-") || branch.includes("\0") || /\s/.test(branch)) throw new Error(uiText("分支名称无效", "Invalid branch name"));
    await execFileAsync("git", ["-C", cwd, "switch", "-c", branch], { timeout: 10000, maxBuffer: 128 * 1024 });
    return readGitStatus(cwd);
  });
  handle(Ipc.workspaceGitStage, async (payload: { cwd: string; paths?: string[]; all?: boolean }): Promise<GitStatus> => {
    const cwd = typeof payload.cwd === "string" ? payload.cwd.trim() : "";
    if (!cwd) throw new Error(uiText("项目路径无效", "Invalid project path"));
    const paths = Array.isArray(payload.paths) ? payload.paths.filter((item): item is string => typeof item === "string" && item.length > 0 && !item.includes("\0")) : [];
    const args = ["-C", cwd, "add", payload.all || paths.length === 0 ? "-A" : "--", ...paths];
    await execFileAsync("git", args, { timeout: 10000, maxBuffer: 128 * 1024 });
    return readGitStatus(cwd);
  });
  handle(Ipc.workspaceGitCommit, async (payload: { cwd: string; message: string }): Promise<GitStatus> => {
    const cwd = typeof payload.cwd === "string" ? payload.cwd.trim() : "";
    const message = typeof payload.message === "string" ? payload.message.trim() : "";
    if (!cwd || !message) throw new Error(uiText("提交信息不能为空", "Commit message cannot be empty"));
    if (message.length > 5000) throw new Error(uiText("提交信息过长", "Commit message is too long"));
    await execFileAsync("git", ["-C", cwd, "commit", "-m", message], { timeout: 30000, maxBuffer: 256 * 1024 });
    return readGitStatus(cwd);
  });
  handle(Ipc.workspaceGitDiff, async (payload: { cwd: string; path?: string; source?: GitDiffSource }): Promise<string> => {
    const cwd = typeof payload.cwd === "string" ? payload.cwd.trim() : "";
    if (!cwd) return "";
    const path = typeof payload.path === "string" ? payload.path.trim() : "";
    const source = payload.source ?? "unstaged";
    const args = ["-C", cwd, "diff", "--no-ext-diff", "--unified=3"];
    if (source === "staged") args.push("--cached");
    else if (source === "branch") args.push("@{upstream}...HEAD");
    else if (source === "last-turn") args.push("HEAD");
    if (path && !path.includes("\0")) args.push("--", path);
    try {
      const { stdout } = await execFileAsync("git", args, { timeout: 10000, maxBuffer: 1024 * 1024 });
      return stdout;
    } catch (error) {
      const detail = error && typeof error === "object" && "stdout" in error && typeof error.stdout === "string" ? error.stdout : "";
      return detail;
    }
  });
  handle(Ipc.workspaceGitUnstage, async (payload: { cwd: string; paths: string[] }): Promise<GitStatus> => {
    const cwd = typeof payload.cwd === "string" ? payload.cwd.trim() : "";
    if (!cwd) throw new Error(uiText("项目路径无效", "Invalid project path"));
    const paths = Array.isArray(payload.paths) ? payload.paths.filter((item): item is string => typeof item === "string" && item.length > 0 && !item.includes("\0")) : [];
    if (paths.length === 0) throw new Error(uiText("没有要取消暂存的文件", "No files to unstage"));
    await execFileAsync("git", ["-C", cwd, "restore", "--staged", "--", ...paths], { timeout: 10000, maxBuffer: 128 * 1024 });
    return readGitStatus(cwd);
  });
  handle(Ipc.workspaceGitDiscard, async (payload: { cwd: string; paths: string[] }): Promise<GitStatus> => {
    const cwd = typeof payload.cwd === "string" ? payload.cwd.trim() : "";
    if (!cwd) throw new Error(uiText("项目路径无效", "Invalid project path"));
    const paths = Array.isArray(payload.paths) ? payload.paths.filter((item): item is string => typeof item === "string" && item.length > 0 && !item.includes("\0")) : [];
    if (paths.length === 0) throw new Error(uiText("没有要丢弃的文件", "No files to discard"));
    await execFileAsync("git", ["-C", cwd, "restore", "--worktree", "--source=HEAD", "--", ...paths], { timeout: 10000, maxBuffer: 128 * 1024 }).catch(async () => {
      await execFileAsync("git", ["-C", cwd, "checkout", "--", ...paths], { timeout: 10000, maxBuffer: 128 * 1024 });
    });
    return readGitStatus(cwd);
  });
  handle(Ipc.workspaceTerminalStart, (payload: { cwd?: string; cols?: number; rows?: number }) => {
    const cwd = typeof payload.cwd === "string" ? payload.cwd.trim() : "";
    // A terminal is not tied to a project: with no workspace bound it opens in home.
    return terminals.start(cwd || homedir(), { cols: payload.cols, rows: payload.rows });
  });
  handle(Ipc.workspaceTerminalWrite, (payload: { id: string; data: string }) => {
    if (!payload.id || typeof payload.data !== "string") return;
    terminals.write(payload.id, payload.data);
  });
  handle(Ipc.workspaceTerminalResize, (payload: { id: string; cols: number; rows: number }) => {
    if (!payload.id) return;
    terminals.resize(payload.id, payload.cols, payload.rows);
  });
  handle(Ipc.workspaceTerminalKill, (payload: { id: string }) => {
    if (payload.id) terminals.kill(payload.id);
  });
  handle(
    Ipc.enginePromptConversation,
    async (payload: { id: string; message: string; images?: Array<{ type: "image"; data: string; mimeType: string }> }) => {
      await engine.promptConversation(payload.id, payload.message, payload.images);
    },
  );
  handle(Ipc.engineGetConversationMessages, async (payload: { id: string }) => {
    return engine.getConversationMessages(payload.id);
  });
  handle(Ipc.conversationsCreateSide, async (payload: { project?: string; parentId?: string; title?: string }) => {
    return engine.createSideConversation(payload?.project, payload?.parentId, payload?.title);
  });
  for (const [channel, command] of [[Ipc.workspaceGitPull, "pull"], [Ipc.workspaceGitPush, "push"]] as const) {
    handle(channel, async (payload: { cwd: string }): Promise<GitStatus> => {
      const cwd = typeof payload.cwd === "string" ? payload.cwd.trim() : "";
      if (!cwd) throw new Error(uiText("项目路径无效", "Invalid project path"));
      await execFileAsync("git", ["-C", cwd, command, ...(command === "pull" ? ["--ff-only"] : [])], { timeout: 60000, maxBuffer: 512 * 1024 });
      return readGitStatus(cwd);
    });
  }
  handle(Ipc.appGetInfo, () => {
    const paths = getFastVibePaths();
    return {
      version: app.getVersion(),
      userData: paths.userData,
      runtimeRoot: paths.runtimeRoot,
      platform: process.platform,
      modelsDev: modelsDevInfo(loadModelsDev().stats),
    };
  });
  handle(Ipc.appLog, (payload: unknown) => {
    writeRendererLog(payload);
  });
  handle(Ipc.appExportLogs, async (_payload: void, ctx) => {
    return exportLogs(ctx.window);
  });
  /**
   * Pull the current models.dev catalog (Settings → 关于) and apply it to the running
   * engine. A refresh that cannot reach the registry has still updated the snapshot,
   * which is durable and read on the next start, so it is reported as a success rather
   * than as a failure the user would have to undo.
   */
  handle(Ipc.modelsDevUpdate, async () => {
    const stats = await updateModelsDevSnapshot();
    await engine.reloadModelMetadata().catch(() => undefined);
    return modelsDevInfo(stats);
  });
  handle(Ipc.statsUsage, (payload?: { range?: UsageRange }) => {
    return collectUsageStats(getFastVibePaths(), payload?.range ?? "30d");
  });
  handle(Ipc.windowNew, () => {
    createWindow();
  });

  // Window controls for the hand-drawn title bar (Windows / Linux only). They act
  // on the window that asked, so a second window is not steered from the first.
  // A remote caller has no window to act on, so these are no-ops there rather than
  // reaching for "the first window" and moving a window nobody asked about.
  handle(Ipc.windowMinimize, (_payload: void, ctx) => {
    ctx.window?.minimize();
  });
  handle(Ipc.windowToggleMaximize, (_payload: void, ctx) => {
    const window = ctx.window;
    if (!window) return;
    if (window.isMaximized()) window.unmaximize();
    else window.maximize();
  });
  handle(Ipc.windowClose, (_payload: void, ctx) => {
    ctx.window?.close();
  });
  handle(Ipc.windowIsMaximized, (_payload: void, ctx) => ctx.window?.isMaximized() ?? false);

  handle(Ipc.settingsGet, () => readAppSettings(getFastVibePaths()));
  handle(Ipc.settingsSet, (settings: Record<string, unknown>, ctx) => {
    const payload = settings && typeof settings === "object" ? settings : {};
    const paths = getFastVibePaths();
    writeAppSettings(paths, payload);
    applyNativeTheme(payload);
    applyPermissionMode(payload);
    applyLanguages(payload);
    applyKeepAwake(payload);
    paintWindows(windows);
    scheduleUpdateCheck(payload.autoCheckUpdates !== false);
    // The other windows hold their own copy, loaded once at startup.
    broadcastSettings(ctx.origin, payload);
  });
  handle(Ipc.settingsClear, (_payload: void, ctx) => {
    const paths = getFastVibePaths();
    clearAppSettings(paths);
    applyNativeTheme({});
    applyPermissionMode({});
    applyLanguages({});
    applyKeepAwake({});
    paintWindows(windows);
    // 恢复默认 is a write like any other: the other windows hold their own copy and
    // would otherwise keep — and later re-save — the settings that were just reset.
    broadcastSettings(ctx.origin, {});
  });

  handle(Ipc.workspacePick, async () => {
    const result = await dialog.showOpenDialog({
      title: uiText("选择项目", "Choose a project"),
      properties: ["openDirectory", "createDirectory"],
    });
    if (result.canceled || !result.filePaths[0]) return null;
    const cwd = result.filePaths[0];
    engine.addProject(cwd);
    await engine.start(cwd);
    return { cwd, status: engine.status };
  });
}

/**
 * Channels the renderer *sends* rather than *invokes*: no reply, so they are wired
 * with `ipcMain.on`. They are in the same table as everything else because the remote
 * transport has no such distinction — it is an Electron detail, not a method's nature.
 */
const SEND_ONLY = new Set<string>([Ipc.browserResponse, Ipc.appLog]);

/** The window that asked, in the shape a handler reads (`ipc/registry.ts`). */
function contextFor(event: { sender: WebContents }): CallerContext {
  return {
    kind: "window",
    window: BrowserWindow.fromWebContents(event.sender),
    origin: windowOrigin(event.sender.id),
  };
}

/**
 * Attach every registered method to Electron IPC.
 *
 * This is one half of the wiring: the table above was built without knowing how it
 * would be reached, and the remote server's WebSocket becomes the other half,
 * dispatching the same functions with a `kind: "remote"` context. Anything registered
 * once is therefore reachable both ways by construction — a method cannot exist on the
 * desktop and be missing on the phone.
 */
function wireElectronTransport(): void {
  for (const channel of handlerChannels()) {
    if (SEND_ONLY.has(channel)) {
      ipcMain.on(channel, (event, payload: unknown) => {
        void dispatch(channel, payload, contextFor(event)).catch((error: unknown) => {
          log.warn(`ipc send failed channel=${channel}: ${String(error)}`);
        });
      });
      continue;
    }
    ipcMain.handle(channel, (event, payload: unknown) => dispatch(channel, payload, contextFor(event)));
  }

  // `settings:get-sync` is the one call that cannot go through the table: it is read in
  // the preload world before the page runs so the first paint already has the theme,
  // and `sendSync` has no counterpart on any other transport. A remote client answers
  // the same need from its connection handshake instead.
  ipcMain.on(Ipc.settingsGetSync, (event) => {
    event.returnValue = readAppSettings(getFastVibePaths());
  });
}

app.whenReady().then(async () => {
  log.info("app ready");
  installBrowserGlobal();
  applyAppIcon();
  const startupSettings = readAppSettings(getFastVibePaths());
  applyNativeTheme(startupSettings);
  applyStartupPermissionMode(getFastVibePaths());
  // Seed the sandbox/extensions' UI language and the AI 偏好语言 prompt before any
  // session starts. A first launch has no settings file yet; the renderer writes one
  // (with the OS-detected language) on boot, which re-applies these.
  applyLanguages(startupSettings);
  applyKeepAwake(startupSettings);
  registerFileIconProtocol();
  // Every module that owns methods registers them first; the transport is attached
  // once, afterwards. Wiring inside `registerIpc` meant the updater's four methods —
  // registered on the next line — landed in the table after the loop had already run,
  // so they were reachable by nothing.
  registerIpc();
  registerUpdater(() => windows);
  registerRemoteIpc();
  wireElectronTransport();
  scheduleUpdateCheck(startupSettings.autoCheckUpdates !== false);

  engine.onStatus(() => broadcastStatus());
  engine.onConversationReady((payload) => {
    broadcast(Ipc.conversationReady, payload);
  });
  // The conversation list, to everyone. Without this a client read the catalog once at
  // connect and never learned of another one's chats — invisible between two desktop
  // windows, and the whole of what a phone saw over remote access.
  engine.onWorkspaceChange((snapshot) => {
    broadcast(Ipc.workspaceChanged, snapshot);
  });
  engine.onOAuthEvent((payload) => {
    // The flow hands us a URL to visit; opening it here is what the CLI does with a
    // browser open, and the renderer shows the same URL so a machine where that fails
    // (or the browser is elsewhere) is still recoverable by hand.
    if (payload.event.type === "auth_url") {
      void shell.openExternal(payload.event.url).catch((error: unknown) => log.warn(`oauth openExternal failed: ${String(error)}`));
    } else if (payload.event.type === "device_code") {
      void shell
        .openExternal(payload.event.verificationUri)
        .catch((error: unknown) => log.warn(`oauth openExternal failed: ${String(error)}`));
    }
    broadcast(Ipc.providersOAuthEvent, payload);
  });
  terminals.onData((event) => {
    broadcast(Ipc.workspaceTerminalData, event);
  });

  engine.onEvent((event) => {
    // Only two event types can raise a 系统通知. Everything else — every streamed
    // token among them — must fall straight through to the fan-out below: reading
    // the preference (and resolving the paths) ahead of this gate put a settings
    // parse and six `mkdirSync` calls on the main process's event loop for every
    // delta of every reply.
    const notifiable =
      (event.type === "conversation_activity" && event.status === "completed") ||
      (event.type === "extension_ui_request" && isBlockingPrompt(event));
    if (notifiable && Notification.isSupported()) {
      const unfocused = ![...windows].some((window) => !window.isDestroyed() && window.isFocused());
      // 系统通知 is a preference with three values (设置 → 通用), read per event so a
      // change lands without a restart. `done` and `approval` are separate choices
      // because the two notifications answer different questions: a finished run is
      // something to come back to, a parked approval is something that *cannot* proceed
      // without the user.
      const notifications = unfocused ? readNotificationPreference(getFastVibePaths()) : undefined;
      if (event.type === "conversation_activity" && notifications === "done") {
        new Notification({
          title: String(event.title ?? uiText("会话", "Chat")),
          body: uiText("任务已完成，可以回来查看结果。", "The task is done. Come back to see the result."),
        }).show();
      } else if (event.type === "extension_ui_request" && notifications === "approval") {
        // A blocking prompt parks the tool until it is answered, and its panel is only
        // drawn for the conversation on screen — so without this notice a background
        // chat could sit waiting with nothing anywhere to say so.
        new Notification({
          title: uiText("有一个会话在等你", "A chat is waiting for you"),
          body: uiText("切换到这个会话继续处理。", "Switch to that conversation to continue."),
        }).show();
      }
    }
    if (event.type === "extension_ui_request") {
      void engine.handleExtensionUi(event);
    }
    // 运行时保持唤醒: the engine broadcasts run start/end for every conversation,
    // active or not, so a background chat keeps the machine up too.
    if (event.type === "conversation_running") {
      setConversationRunning(String(event.conversationId ?? ""), event.running === true);
    }
    broadcast(Ipc.event, event);
  });

  createWindow();
  void engine.start();
  // Brought back only if it was running before, and never without a password.
  void restoreRemoteServer();

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});

let stopping = false;

app.on("before-quit", (event) => {
  if (stopping) return;
  event.preventDefault();
  stopping = true;
  log.info("app quitting");
  void stopRemoteServer().catch(() => undefined);
  void engine.stop().finally(() => {
    terminals.dispose();
    clearRunningConversations();
    engine.flush();
    if (!applyPendingInstall()) app.quit();
  });
});

/**
 * `git status --short --branch` heads with `## main...origin/main [ahead 1]`,
 * `## No commits yet on main` in a fresh repo, and `## HEAD (no branch)` when
 * detached. Strip the decorations so the UI can print a bare ref name.
 */
function parseBranchHeader(header: string): string | undefined {
  const text = header.split("...")[0].trim();
  const name = (text.match(/^No commits yet on (.+)$/)?.[1] ?? text).replace(/ \(no branch\)$/, "").trim();
  return name || undefined;
}

/**
 * Which desktop notifications the user asked for, from `settings.json`.
 *
 * Read per event rather than cached: the switch in 设置 → 通用 writes the file, and a
 * notification is rare enough that one small read costs nothing. An absent or
 * malformed value is `done`, which is what every install had before the preference
 * existed.
 */
function readNotificationPreference(paths: FastVibePaths): NotificationPreference {
  const value = readAppSettings(paths).notifications;
  return isNotificationPreference(value) ? value : "done";
}

/**
 * Whether an extension UI request is one that parks the run until a human answers.
 *
 * `notify` / `setStatus` / `setWidget` are one-way and must not raise a notification;
 * only the dialog methods block. `editor` is a dialog too, and it is answered through
 * the modal — the user still has to act, so it counts.
 */
function isBlockingPrompt(event: Record<string, unknown>): boolean {
  const method = event.method;
  return (
    method === "confirm" ||
    method === "select" ||
    method === "input" ||
    method === "editor" ||
    method === "questions"
  );
}

/**
 * Tell every other window what one window just wrote.
 *
 * Preferences live in one `settings.json`, but each window keeps its own in-memory
 * copy loaded at startup — so two open windows silently overwrote each other and
 * showed different themes/font sizes until a reload. The write already happened;
 * this only makes the other windows read it back.
 */
function broadcastSettings(origin: string | undefined, settings: Record<string, unknown>): void {
  broadcast(Ipc.settingsChanged, settings, { except: origin });
}

async function readGitStatus(cwd: string): Promise<GitStatus> {
  const empty: GitStatus = { cwd, isRepository: false, changed: 0, staged: 0, files: [] };
  try {
    const { stdout } = await execFileAsync("git", ["-C", cwd, "status", "--short", "--branch"], { timeout: 5000, maxBuffer: 256 * 1024 });
    const lines = stdout.split(/\r?\n/).filter(Boolean);
    const header = lines.shift() ?? "";
    if (!header.startsWith("## ")) return empty;
    const branch = parseBranchHeader(header.slice(3));
    const ahead = Number(header.match(/ahead (\d+)/)?.[1] ?? 0);
    const behind = Number(header.match(/behind (\d+)/)?.[1] ?? 0);
    let changed = 0;
    let staged = 0;
    const files: GitStatus["files"] = [];
    for (const line of lines) {
      if (line.length < 2) continue;
      changed += 1;
      if (line[0] !== " " && line[0] !== "?") staged += 1;
      files.push({ index: line[0] === "?" ? "?" : line[0], worktree: line[1] ?? " ", path: line.slice(3).trim() });
    }
    return { cwd, isRepository: true, branch, changed, staged, ahead, behind, files };
  } catch {
    return empty;
  }
}
