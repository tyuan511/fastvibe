import { app, BrowserWindow, dialog, ipcMain, nativeImage, Notification, protocol, shell } from "electron";
import { statSync } from "node:fs";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { join } from "node:path";
import { homedir } from "node:os";
import { Ipc } from "@shared/ipc";
import { readFilePreview } from "./engine/file-preview";
import { readWorkspaceDir } from "./engine/workspace-fs";
import { loadModelsDev } from "./engine/models-dev";
import {
  applyNativeTheme,
  applyPermissionMode,
  clearAppSettings,
  paintWindows,
  readAppSettings,
  windowBackgroundColor,
  writeAppSettings,
} from "./engine/app-settings";
import { getFastVibePaths } from "./engine/paths";
import {
  getFileIconMapping,
  registerFileIconProtocol,
  registerFileIconScheme,
} from "./engine/file-icons";
import { collectUsageStats } from "./engine/usage-stats";
import { PiProcessManager } from "./pi/process-manager";
import { fetchPackageCatalog } from "./pi/package-catalog";
import { TerminalSessions } from "./engine/terminal-sessions";
import type { ProviderModel, UsageRange } from "@shared/types";
import type { GitBranch, GitDiffSource, GitStatus } from "@shared/ipc";

const execFileAsync = promisify(execFile);

app.setName("FastVibe");

// Privileged schemes must be declared before the app is ready.
registerFileIconScheme();

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

function createWindow(): void {
  const window = new BrowserWindow({
    width: 1280,
    height: 840,
    minWidth: 920,
    minHeight: 640,
    title: "FastVibe",
    icon: resolveAppIcon(),
    backgroundColor: windowBackgroundColor(),
    titleBarStyle: process.platform === "darwin" ? "hiddenInset" : "default",
    trafficLightPosition: { x: 16, y: 16 },
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
  window.on("closed", () => {
    windows.delete(window);
    if (mainWindow === window) mainWindow = windows.values().next().value ?? null;
  });
  window.webContents.setWindowOpenHandler((details) => {
    shell.openExternal(details.url);
    return { action: "deny" };
  });

  if (process.env.ELECTRON_RENDERER_URL) {
    window.loadURL(process.env.ELECTRON_RENDERER_URL);
  } else {
    window.loadFile(join(__dirname, "../renderer/index.html"));
  }

  mainWindow = window;
  windows.add(window);
}

function broadcastStatus(): void {
  for (const window of windows) window.webContents.send(Ipc.status, engine.status);
}

function registerIpc(): void {
  ipcMain.handle(Ipc.engineGetStatus, () => engine.status);

  ipcMain.handle(Ipc.engineStart, async (_event, payload?: { cwd?: string }) => {
    return engine.start(payload?.cwd ?? engine.cwd);
  });

  ipcMain.handle(Ipc.engineStop, async () => {
    await engine.stop();
    return engine.status;
  });

  ipcMain.handle(
    Ipc.enginePrompt,
    async (
      _event,
      payload: {
        message: string;
        streamingBehavior?: "steer" | "followUp";
        images?: Array<{ type: "image"; data: string; mimeType: string }>;
      },
    ) => {
      await engine.prompt(payload.message, {
        streamingBehavior: payload.streamingBehavior,
        images: payload.images,
      });
    },
  );

  ipcMain.handle(
    Ipc.engineSteer,
    async (_event, payload: { message: string; images?: Array<{ type: "image"; data: string; mimeType: string }> }) => {
      await engine.steer(payload.message, payload.images);
    },
  );

  ipcMain.handle(
    Ipc.engineFollowUp,
    async (_event, payload: { message: string; images?: Array<{ type: "image"; data: string; mimeType: string }> }) => {
      await engine.followUp(payload.message, payload.images);
    },
  );

  ipcMain.handle(Ipc.engineAbort, async () => {
    await engine.abort();
  });

  ipcMain.handle(Ipc.engineClearQueue, async () => {
    return engine.clearQueue();
  });

  ipcMain.handle(Ipc.engineCompact, async (_event, payload?: { customInstructions?: string }) => {
    return engine.compact(payload?.customInstructions);
  });

  ipcMain.handle(Ipc.engineGetCommands, async () => {
    return engine.getCommands();
  });
  ipcMain.handle(Ipc.engineGetExtensions, async () => engine.getExtensions());
  ipcMain.handle(Ipc.engineListExtensionPackages, async () => engine.listExtensionPackages());
  ipcMain.handle(
    Ipc.engineInstallExtensionPackage,
    async (_event, payload: { source: string }) => engine.installExtensionPackage(payload.source),
  );
  ipcMain.handle(
    Ipc.engineRemoveExtensionPackage,
    async (_event, payload: { source: string }) => engine.removeExtensionPackage(payload.source),
  );
  ipcMain.handle(
    Ipc.engineListMarketPackages,
    async (_event, payload: import("@shared/types").MarketPackageQuery) => fetchPackageCatalog(payload),
  );
  ipcMain.handle(Ipc.engineListMcpServers, async () => engine.listMcpServers());
  ipcMain.handle(Ipc.engineSaveMcpServers, async (_event, payload: { configs: import("@shared/types").McpServerConfig[] }) => engine.saveMcpServers(payload.configs));
  ipcMain.handle(Ipc.engineListSkills, async () => engine.listSkills());
  ipcMain.handle(Ipc.engineCreateSkill, async (_event, payload: import("@shared/types").SkillDraft) => engine.createSkill(payload));
  ipcMain.handle(Ipc.engineImportSkill, async () => {
    const result = await dialog.showOpenDialog({
      title: "导入技能",
      properties: ["openDirectory"],
    });
    if (result.canceled || !result.filePaths[0]) return null;
    return engine.importSkill(result.filePaths[0]);
  });
  ipcMain.handle(Ipc.engineRemoveSkill, async (_event, payload: { name: string }) => engine.removeSkill(payload.name));

  ipcMain.handle(Ipc.engineGetSubagents, async () => {
    return engine.getSubagents();
  });

  ipcMain.handle(Ipc.engineGetSubagentMessages, async (_event, payload: { subagentId: string }) => {
    return engine.getSubagentMessages(payload.subagentId);
  });

  ipcMain.handle(Ipc.conversationsMultiRun, async (_event, payload: import("@shared/types").MultiRunRequest) => engine.multiRun(payload));

  ipcMain.handle(
    Ipc.enginePermissionRespond,
    (_event, payload: { id: string; confirmed?: boolean; value?: string; cancelled?: boolean }) => {
      engine.respondPermission(payload);
    },
  );

  ipcMain.handle(Ipc.engineNewSession, async () => {
    await engine.newSession();
  });

  ipcMain.handle(Ipc.engineGetState, async () => {
    return engine.getState();
  });

  ipcMain.handle(Ipc.engineGetRunning, async () => {
    return engine.getRunningConversations();
  });

  ipcMain.handle(Ipc.engineGetModels, async () => {
    return engine.getAvailableModels();
  });

  ipcMain.handle(Ipc.engineSetModel, async (_event, payload: { provider: string; modelId: string }) => {
    return engine.setModel(payload.provider, payload.modelId);
  });

  ipcMain.handle(Ipc.engineSetThinking, async (_event, payload: { level: string }) => {
    return engine.setThinkingLevel(payload.level);
  });
  ipcMain.handle(Ipc.engineSetInterrupt, async (_event, payload: { mode: "immediate" | "wait" }) => {
    return engine.setInterruptMode(payload.mode);
  });
  ipcMain.handle(Ipc.engineSetAutoCompact, async (_event, payload: { enabled: boolean }) => {
    return engine.setAutoCompaction(payload.enabled);
  });
  ipcMain.handle(Ipc.engineBranch, async (_event, payload: { entryId: string }) => {
    return engine.branch(payload.entryId);
  });
  ipcMain.handle(Ipc.engineGetMessages, async () => {
    return engine.loadMessages();
  });
  ipcMain.handle(Ipc.engineGetStats, async () => {
    return engine.getSessionStats();
  });
  ipcMain.handle(Ipc.engineSetSteering, async (_event, payload: { mode: "all" | "one-at-a-time" }) => {
    return engine.setSteeringMode(payload.mode);
  });
  ipcMain.handle(Ipc.engineSetFollowUp, async (_event, payload: { mode: "all" | "one-at-a-time" }) => {
    return engine.setFollowUpMode(payload.mode);
  });
  ipcMain.handle(Ipc.engineExportHtml, async () => {
    const path = await engine.exportHtml();
    if (path) await shell.openPath(path);
    return path;
  });

  ipcMain.handle(Ipc.providersList, async () => {
    return engine.listProviders();
  });
  ipcMain.handle(Ipc.providersNative, async () => {
    return engine.listNativeProviders();
  });
  ipcMain.handle(
    Ipc.providersAddNative,
    async (_event, payload: { id: string; apiKey: string; models: ProviderModel[] }) => {
      return engine.addNativeProvider(payload.id, payload.apiKey, payload.models);
    },
  );
  ipcMain.handle(
    Ipc.providersFetch,
    async (_event, payload: { baseUrl: string; apiKey: string }) => {
      return engine.fetchModels(payload.baseUrl, payload.apiKey);
    },
  );
  ipcMain.handle(
    Ipc.providersSaveFastVibe,
    async (_event, payload: { apiKey: string; models: ProviderModel[] }) => {
      return engine.saveFastVibe(payload.apiKey, payload.models);
    },
  );
  ipcMain.handle(
    Ipc.providersAdd,
    async (_event, payload: { name: string; baseUrl: string; apiKey: string; api?: import("@shared/types").ProviderApi; models: ProviderModel[] }) => {
      return engine.addProvider(
        { name: payload.name, baseUrl: payload.baseUrl, apiKey: payload.apiKey, api: payload.api },
        payload.models,
      );
    },
  );
  ipcMain.handle(
    Ipc.providersUpdate,
    async (
      _event,
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
  ipcMain.handle(Ipc.providersRemove, async (_event, payload: { id: string }) => {
    return engine.removeProvider(payload.id);
  });
  ipcMain.handle(Ipc.providersRefresh, async (_event, payload: { id: string }) => {
    return engine.refreshProviderModels(payload.id);
  });

  ipcMain.handle(Ipc.conversationsList, () => engine.listWorkspace());
  ipcMain.handle(Ipc.conversationsCreate, async (_event, payload?: { project?: string }) => {
    return engine.createConversation(payload?.project);
  });
  ipcMain.handle(Ipc.conversationsOpen, async (_event, payload: { id: string }) => {
    return engine.openConversation(payload.id);
  });
  ipcMain.handle(Ipc.conversationsRename, (_event, payload: { id: string; title: string }) => {
    return engine.renameConversation(payload.id, payload.title);
  });
  ipcMain.handle(Ipc.conversationsDelete, async (_event, payload: { id: string }) => {
    return engine.deleteConversation(payload.id);
  });
  ipcMain.handle(Ipc.conversationsRecordPrompt, (_event, payload: { id: string; text: string }) => {
    return engine.recordPrompt(payload.id, payload.text);
  });
  ipcMain.handle(Ipc.conversationsSetProject, async (_event, payload: { id: string; project: string | null }) => {
    return engine.setConversationProject(payload.id, payload.project);
  });
  ipcMain.handle(Ipc.projectsAdd, async () => {
    const result = await dialog.showOpenDialog({
      title: "打开项目",
      properties: ["openDirectory", "createDirectory"],
    });
    if (result.canceled || !result.filePaths[0]) return null;
    return engine.addProject(result.filePaths[0]);
  });
  ipcMain.handle(Ipc.projectsRename, (_event, payload: { cwd: string; name: string }) => {
    return engine.renameProject(payload.cwd, payload.name);
  });
  ipcMain.handle(Ipc.projectsRemove, async (_event, payload: { cwd: string }) => {
    return engine.removeProject(payload.cwd);
  });
  ipcMain.handle(Ipc.workspaceReveal, async (_event, payload: { cwd: string }) => {
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
  ipcMain.handle(Ipc.workspacePreview, (_event, payload: { path: string }) => {
    if (!payload.path) return { kind: "error", path: "", name: "", message: "路径无效" };
    return readFilePreview(payload.path);
  });
  ipcMain.handle(Ipc.workspaceFileIcons, () => getFileIconMapping());
  ipcMain.handle(Ipc.workspaceReadDir, (_event, payload: { path: string }) => {
    try {
      return readWorkspaceDir(payload.path);
    } catch {
      return [];
    }
  });
  ipcMain.handle(Ipc.workspaceGitStatus, async (_event, payload: { cwd: string }): Promise<GitStatus> => {
    const cwd = typeof payload.cwd === "string" ? payload.cwd.trim() : "";
    if (!cwd) return { cwd, isRepository: false, changed: 0, staged: 0, files: [] };
    return readGitStatus(cwd);
  });
  ipcMain.handle(Ipc.workspaceOpenTerminal, async (_event, payload: { cwd: string }): Promise<void> => {
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
  ipcMain.handle(Ipc.workspaceGitBranches, async (_event, payload: { cwd: string }): Promise<GitBranch[]> => {
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
  ipcMain.handle(Ipc.workspaceGitCheckout, async (_event, payload: { cwd: string; branch: string }): Promise<GitStatus> => {
    const cwd = typeof payload.cwd === "string" ? payload.cwd.trim() : "";
    const branch = typeof payload.branch === "string" ? payload.branch.trim() : "";
    if (!cwd || !branch || branch.startsWith("-") || branch.includes("\0")) throw new Error("分支名称无效");
    await execFileAsync("git", ["-C", cwd, "switch", branch], { timeout: 10000, maxBuffer: 128 * 1024 });
    return readGitStatus(cwd);
  });
  ipcMain.handle(Ipc.workspaceGitCreateBranch, async (_event, payload: { cwd: string; branch: string }): Promise<GitStatus> => {
    const cwd = typeof payload.cwd === "string" ? payload.cwd.trim() : "";
    const branch = typeof payload.branch === "string" ? payload.branch.trim() : "";
    if (!cwd || !branch || branch.startsWith("-") || branch.includes("\0") || /\s/.test(branch)) throw new Error("分支名称无效");
    await execFileAsync("git", ["-C", cwd, "switch", "-c", branch], { timeout: 10000, maxBuffer: 128 * 1024 });
    return readGitStatus(cwd);
  });
  ipcMain.handle(Ipc.workspaceGitStage, async (_event, payload: { cwd: string; paths?: string[]; all?: boolean }): Promise<GitStatus> => {
    const cwd = typeof payload.cwd === "string" ? payload.cwd.trim() : "";
    if (!cwd) throw new Error("项目路径无效");
    const paths = Array.isArray(payload.paths) ? payload.paths.filter((item): item is string => typeof item === "string" && item.length > 0 && !item.includes("\0")) : [];
    const args = ["-C", cwd, "add", payload.all || paths.length === 0 ? "-A" : "--", ...paths];
    await execFileAsync("git", args, { timeout: 10000, maxBuffer: 128 * 1024 });
    return readGitStatus(cwd);
  });
  ipcMain.handle(Ipc.workspaceGitCommit, async (_event, payload: { cwd: string; message: string }): Promise<GitStatus> => {
    const cwd = typeof payload.cwd === "string" ? payload.cwd.trim() : "";
    const message = typeof payload.message === "string" ? payload.message.trim() : "";
    if (!cwd || !message) throw new Error("提交信息不能为空");
    if (message.length > 5000) throw new Error("提交信息过长");
    await execFileAsync("git", ["-C", cwd, "commit", "-m", message], { timeout: 30000, maxBuffer: 256 * 1024 });
    return readGitStatus(cwd);
  });
  ipcMain.handle(Ipc.workspaceGitDiff, async (_event, payload: { cwd: string; path?: string; source?: GitDiffSource }): Promise<string> => {
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
  ipcMain.handle(Ipc.workspaceGitUnstage, async (_event, payload: { cwd: string; paths: string[] }): Promise<GitStatus> => {
    const cwd = typeof payload.cwd === "string" ? payload.cwd.trim() : "";
    if (!cwd) throw new Error("项目路径无效");
    const paths = Array.isArray(payload.paths) ? payload.paths.filter((item): item is string => typeof item === "string" && item.length > 0 && !item.includes("\0")) : [];
    if (paths.length === 0) throw new Error("没有要取消暂存的文件");
    await execFileAsync("git", ["-C", cwd, "restore", "--staged", "--", ...paths], { timeout: 10000, maxBuffer: 128 * 1024 });
    return readGitStatus(cwd);
  });
  ipcMain.handle(Ipc.workspaceGitDiscard, async (_event, payload: { cwd: string; paths: string[] }): Promise<GitStatus> => {
    const cwd = typeof payload.cwd === "string" ? payload.cwd.trim() : "";
    if (!cwd) throw new Error("项目路径无效");
    const paths = Array.isArray(payload.paths) ? payload.paths.filter((item): item is string => typeof item === "string" && item.length > 0 && !item.includes("\0")) : [];
    if (paths.length === 0) throw new Error("没有要丢弃的文件");
    await execFileAsync("git", ["-C", cwd, "restore", "--worktree", "--source=HEAD", "--", ...paths], { timeout: 10000, maxBuffer: 128 * 1024 }).catch(async () => {
      await execFileAsync("git", ["-C", cwd, "checkout", "--", ...paths], { timeout: 10000, maxBuffer: 128 * 1024 });
    });
    return readGitStatus(cwd);
  });
  ipcMain.handle(Ipc.workspaceTerminalStart, (_event, payload: { cwd?: string; cols?: number; rows?: number }) => {
    const cwd = typeof payload.cwd === "string" ? payload.cwd.trim() : "";
    // A terminal is not tied to a project: with no workspace bound it opens in home.
    return terminals.start(cwd || homedir(), { cols: payload.cols, rows: payload.rows });
  });
  ipcMain.handle(Ipc.workspaceTerminalWrite, (_event, payload: { id: string; data: string }) => {
    if (!payload.id || typeof payload.data !== "string") return;
    terminals.write(payload.id, payload.data);
  });
  ipcMain.handle(Ipc.workspaceTerminalResize, (_event, payload: { id: string; cols: number; rows: number }) => {
    if (!payload.id) return;
    terminals.resize(payload.id, payload.cols, payload.rows);
  });
  ipcMain.handle(Ipc.workspaceTerminalKill, (_event, payload: { id: string }) => {
    if (payload.id) terminals.kill(payload.id);
  });
  ipcMain.handle(Ipc.enginePromptConversation, async (_event, payload: { id: string; message: string }) => {
    await engine.promptConversation(payload.id, payload.message);
  });
  ipcMain.handle(Ipc.engineGetConversationMessages, async (_event, payload: { id: string }) => {
    return engine.getConversationMessages(payload.id);
  });
  ipcMain.handle(Ipc.conversationsCreateSide, async (_event, payload: { project?: string; parentId?: string; title?: string }) => {
    return engine.createSideConversation(payload?.project, payload?.parentId, payload?.title);
  });
  for (const [channel, command] of [[Ipc.workspaceGitPull, "pull"], [Ipc.workspaceGitPush, "push"]] as const) {
    ipcMain.handle(channel, async (_event, payload: { cwd: string }): Promise<GitStatus> => {
      const cwd = typeof payload.cwd === "string" ? payload.cwd.trim() : "";
      if (!cwd) throw new Error("项目路径无效");
      await execFileAsync("git", ["-C", cwd, command, ...(command === "pull" ? ["--ff-only"] : [])], { timeout: 60000, maxBuffer: 512 * 1024 });
      return readGitStatus(cwd);
    });
  }
  ipcMain.handle(Ipc.appGetInfo, () => {
    const paths = getFastVibePaths();
    const meta = loadModelsDev().stats;
    return {
      version: app.getVersion(),
      userData: paths.userData,
      runtimeRoot: paths.runtimeRoot,
      platform: process.platform,
      modelsDev: {
        models: meta.models,
        aliases: meta.aliases,
        generatedAt: meta.generatedAt,
        path: meta.path,
      },
    };
  });
  ipcMain.handle(Ipc.statsUsage, (_event, payload?: { range?: UsageRange }) => {
    return collectUsageStats(getFastVibePaths(), payload?.range ?? "30d");
  });
  ipcMain.handle(Ipc.windowNew, () => {
    createWindow();
  });

  ipcMain.on(Ipc.settingsGetSync, (event) => {
    event.returnValue = readAppSettings(getFastVibePaths());
  });
  ipcMain.handle(Ipc.settingsGet, () => readAppSettings(getFastVibePaths()));
  ipcMain.handle(Ipc.settingsSet, (_event, settings: Record<string, unknown>) => {
    const payload = settings && typeof settings === "object" ? settings : {};
    const paths = getFastVibePaths();
    writeAppSettings(paths, payload);
    applyNativeTheme(payload);
    applyPermissionMode(payload);
    paintWindows(windows);
  });
  ipcMain.handle(Ipc.settingsClear, () => {
    const paths = getFastVibePaths();
    clearAppSettings(paths);
    applyNativeTheme({});
    applyPermissionMode({});
    paintWindows(windows);
  });

  ipcMain.handle(Ipc.workspacePick, async () => {
    const result = await dialog.showOpenDialog({
      title: "选择项目",
      properties: ["openDirectory", "createDirectory"],
    });
    if (result.canceled || !result.filePaths[0]) return null;
    const cwd = result.filePaths[0];
    engine.addProject(cwd);
    await engine.start(cwd);
    return { cwd, status: engine.status };
  });
}

app.whenReady().then(async () => {
  applyAppIcon();
  const startupSettings = readAppSettings(getFastVibePaths());
  applyNativeTheme(startupSettings);
  applyPermissionMode(startupSettings);
  registerFileIconProtocol();
  registerIpc();

  engine.onStatus(() => broadcastStatus());
  engine.onConversationReady((payload) => {
    for (const window of windows) window.webContents.send(Ipc.conversationReady, payload);
  });
  terminals.onData((event) => {
    for (const window of windows) window.webContents.send(Ipc.workspaceTerminalData, event);
  });

  engine.onEvent((event) => {
    if (event.type === "conversation_activity" && !mainWindow?.isFocused() && Notification.isSupported()) {
      new Notification({ title: String(event.title ?? "会话"), body: "任务已完成，可以回来查看结果。" }).show();
    }
    if (event.type === "extension_ui_request") {
      void engine.handleExtensionUi(event);
    }
    for (const window of windows) window.webContents.send(Ipc.event, event);
  });

  createWindow();
  void engine.start();

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
  void engine.stop().finally(() => {
    terminals.dispose();
    engine.flush();
    app.quit();
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
