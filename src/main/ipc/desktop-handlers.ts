import {
  app,
  BrowserWindow,
  dialog,
  screen,
  session,
  shell,
} from "electron";
import { statSync } from "node:fs";
import { homedir } from "node:os";
import { Ipc, type AppModelsDevInfo } from "@shared/ipc";
import { broadcast } from "./broadcast";
import { registerEngineIpc } from "./engine-handlers";
import { handle, type CallerContext } from "./registry";
import { readFilePreview } from "../engine/file-preview";
import { readWorkspaceDir } from "../engine/workspace-fs";
import { existingFiles } from "../engine/path-exists";
import { loadModelsDev, type ModelsDevStats } from "../engine/models-dev";
import {
  applyNativeTheme,
  applyPermissionMode,
  clearAppSettings,
  paintWindows,
  readAppSettings,
  writeAppSettings,
} from "../engine/app-settings";
import { getFastVibePaths } from "../engine/paths";
import { applyLanguages } from "../engine/ai-language";
import { uiText } from "../engine/ui-text";
import { exportLogs, writeRendererLog } from "../engine/logger";
import { applyKeepAwake } from "../engine/keep-awake";
import { assertProxySettings, mergeSettingsPreservingProxy, proxySettingsOf } from "../../shared/proxy";
import { getFileIconMapping } from "../engine/file-icons";
import { collectUsageStats } from "../engine/usage-stats";
import { scheduleUpdateCheck } from "../updater";
import { PiProcessManager } from "../pi/process-manager";
import { TerminalSessions } from "../engine/terminal-sessions";
import { RemoteGateway } from "../remote/gateway";
import { respondBrowserRequest } from "../pi/browser-bridge";
import {
  computerPermissions,
  listComputerApps,
  openComputerSettings,
  requestComputerPermissions,
  startComputerDrag,
} from "../pi/cua-bridge";
import { cancelGrantFlow, grantFlowState, startGrantFlow } from "../pi/computer-grant-flow";
import { importBrowserProfile, listBrowserProfiles } from "../engine/browser-profiles";
import {
  browserProfileDir,
  importIntoBrowserProfile,
  installedBrowsers,
  type ProfileCookie,
} from "../engine/browser-cdp";
import type { ProviderModel, UsageRange } from "@shared/types";
import type { GitBranch, GitDiffSource, GitStatus } from "@shared/ipc";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createNetworkProxy } from "../engine/network-proxy";
import { collectCommitMessageMaterial, readCommitStatusFiles, readGitStatus } from "../workspace-git";

const execFileAsync = promisify(execFile);

export type DesktopIpcDeps = {
  engine: PiProcessManager;
  windows: Set<BrowserWindow>;
  terminals: TerminalSessions;
  terminalOwners: Map<string, string>;
  gateway: RemoteGateway;
  networkProxy: Awaited<ReturnType<typeof createNetworkProxy>> | undefined;
  createWindow: () => void;
  broadcastSettings: (origin: string | undefined, settings: Record<string, unknown>) => void;
  modelsDevInfo: (stats: ModelsDevStats) => AppModelsDevInfo;
  queueSettingsWrite: (task: () => Promise<void>) => Promise<void>;
  refreshModelsDev: () => Promise<AppModelsDevInfo>;
};

export function registerDesktopIpc(deps: DesktopIpcDeps): void {
  const {
    engine,
    windows,
    terminals,
    terminalOwners,
    gateway,
    networkProxy,
    createWindow,
    broadcastSettings,
    modelsDevInfo,
    queueSettingsWrite,
    refreshModelsDev,
  } = deps;

  handle(Ipc.memoryGetState, () => engine.memory.state());
  handle(Ipc.memoryPrepareModel, () => engine.memory.prepareModel());
  handle(Ipc.memorySetConfig, async (payload: unknown, ctx) => {
    const state = await engine.memory.setConfig(payload);
    broadcast(Ipc.memoryChanged, state, { except: ctx.origin });
    return state;
  });
  handle(Ipc.memorySearch, async (payload: import("@shared/memory").MemorySearchRequest) => engine.memory.search(payload ?? { query: "" }));
  handle(Ipc.memoryGraph, (payload: import("@shared/memory").MemoryGraphRequest | undefined) => engine.memory.graph(payload ?? {}));
  // `null`, not `undefined`, for a memory that is gone: an undefined reply does not survive the remote client's JSON.
  handle(Ipc.memoryDetail, (payload: { id?: unknown }) => (typeof payload?.id === "string" ? engine.memory.detail(payload.id) ?? null : null));
  handle(Ipc.memoryDelete, (payload: { id?: unknown }, ctx) => {
    const id = typeof payload?.id === "string" ? payload.id.trim() : "";
    if (!id) throw new Error("记忆 ID 不能为空");
    const state = engine.memory.delete(id);
    broadcast(Ipc.memoryChanged, state, { except: ctx.origin });
    return state;
  });
  handle(Ipc.memoryClear, (_payload: void, ctx) => {
    const state = engine.memory.clear();
    broadcast(Ipc.memoryChanged, state, { except: ctx.origin });
    return state;
  });
  handle(Ipc.browserResponse, (payload: { id: string; ok: boolean; result?: unknown; error?: string }) => {
    respondBrowserRequest(payload);
  });
  handle(Ipc.browserListProfiles, () => listBrowserProfiles());
  handle(Ipc.browserImportProfile, async (payload: { profile: import("@shared/types").BrowserProfileInfo; target?: "builtin" | "system" }) => {
    if (!payload?.profile?.cookiePath) throw new Error(uiText("浏览器配置文件无效", "Invalid browser profile"));
    const allowed = (await listBrowserProfiles()).find((profile) => profile.id === payload.profile.id && profile.cookiePath === payload.profile.cookiePath);
    if (!allowed) throw new Error(uiText("浏览器配置文件未通过校验，请重新打开导入列表", "Browser profile failed validation. Open the list again."));
    // The settings pane follows the browser chosen above it. The side pane's own
    // import keeps writing the built-in browser, which is the one on screen there.
    if (payload.target === "system") {
      const collected: ProfileCookie[] = [];
      const result = await importBrowserProfile(allowed, async (cookie) => { collected.push(cookie); });
      const written = await importIntoBrowserProfile(browserProfileDir(), collected);
      return { ...result, cookies: written, message: uiText(`已导入 ${written} 个 Cookie 到所选浏览器`, `Imported ${written} cookies into the selected browser`) };
    }
    return importBrowserProfile(allowed, (cookie) => session.fromPartition("persist:fastvibe-browser").cookies.set(cookie));
  });
  handle(Ipc.browserClearData, () =>
    session.fromPartition("persist:fastvibe-browser").clearStorageData(),
  );
  handle(Ipc.browserListEngines, () => installedBrowsers());
  handle(Ipc.computerPermissions, () => computerPermissions());
  handle(Ipc.computerRequestPermissions, () => requestComputerPermissions());
  handle(Ipc.computerOpenSettings, () => openComputerSettings());
  handle(Ipc.computerListApps, () => listComputerApps());
  handle(Ipc.computerStartDrag, (_payload, ctx) => {
    // A drag belongs to the window the gesture started in — in practice the floating
    // grant panel, which is a window of its own. A remote caller has no `webContents`
    // to drag from, which is why the policy denies this method outright.
    const contents = ctx.window?.webContents;
    if (!contents) throw new Error(uiText("需要在桌面端窗口中拖拽", "Dragging requires a desktop window"));
    startComputerDrag(contents);
  });
  handle(Ipc.computerStartGrantFlow, () => startGrantFlow());
  handle(Ipc.computerCancelGrantFlow, () => cancelGrantFlow());
  handle(Ipc.computerGetGrantFlow, () => grantFlowState());

  registerEngineIpc(engine);

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
  handle(Ipc.providersProbeGateway, async (payload: { baseUrl: string }) => {
    return engine.probeGateway(payload.baseUrl);
  });
  handle(Ipc.providersGatewayBalance, async (payload: { id: string; force?: boolean }) => {
    return engine.getGatewayBalance(payload.id, payload.force === true);
  });
  handle(Ipc.providersGatewayCredentials, async (payload: { id: string; accessToken: string; userId: string }) => {
    await engine.setGatewayCredentials(payload.id, { accessToken: payload.accessToken, userId: payload.userId });
  });
  handle(Ipc.providersIdentifyGateway, async (payload: { id: string }) => {
    return engine.identifyGateway(payload.id);
  });
  handle(
    Ipc.providersSaveFastVibe,
    async (payload: { apiKey: string; models: ProviderModel[] }) => {
      return engine.saveFastVibe(payload.apiKey, payload.models);
    },
  );
  handle(
    Ipc.providersAdd,
    async (payload: { name: string; baseUrl: string; apiKey: string; api?: import("@shared/types").ProviderApi; gateway?: import("@shared/types").GatewayKind; models: ProviderModel[] }) => {
      return engine.addProvider(
        { name: payload.name, baseUrl: payload.baseUrl, apiKey: payload.apiKey, api: payload.api, gateway: payload.gateway },
        payload.models,
      );
    },
  );
  handle(
    Ipc.providersUpdate,
    async (
      payload: { id: string; name?: string; baseUrl?: string; api?: import("@shared/types").ProviderApi; enabled?: boolean; apiKey?: string; models?: ProviderModel[]; modelOrder?: string[] },
    ) => {
      return engine.updateProvider(payload.id, {
        name: payload.name,
        baseUrl: payload.baseUrl,
        api: payload.api,
        enabled: payload.enabled,
        apiKey: payload.apiKey,
        models: payload.models,
        modelOrder: payload.modelOrder,
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
  handle(Ipc.conversationsCreate, async (payload?: { project?: string; activate?: boolean; reuseEmpty?: boolean }) => {
    return engine.createConversation(payload?.project, {
      activate: payload?.activate !== false,
      reuseEmpty: payload?.reuseEmpty,
    });
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
  handle(Ipc.conversationsRestorePrompt, (payload: { id: string; expectedTitle: string; expectedPreview?: string; title: string; preview?: string }) => {
    return engine.restorePromptPreview(payload);
  });
  handle(Ipc.conversationsSetProject, async (payload: { id: string; project: string | null }) => {
    return engine.setConversationProject(payload.id, payload.project);
  });
  handle(Ipc.conversationsCreateWorktree, async (payload: { id: string; path?: string; branch?: string; label?: string }) => {
    return engine.createConversationWorktree(payload.id, payload);
  });
  handle(Ipc.conversationsBindWorktree, async (payload: { id: string; path: string }) => {
    return engine.bindConversationWorktree(payload.id, payload.path);
  });
  handle(Ipc.conversationsUnbindWorktree, async (payload: { id: string; remove?: boolean }) => {
    return engine.unbindConversationWorktree(payload.id, payload);
  });
  handle(Ipc.conversationsListWorktrees, async (payload: { id: string }) => {
    return engine.listConversationWorktrees(payload.id);
  });
  handle(Ipc.projectsAdd, async () => {
    const result = await dialog.showOpenDialog({
      title: uiText("打开项目", "Open project"),
      properties: ["openDirectory", "createDirectory"],
    });
    if (result.canceled || !result.filePaths[0]) return null;
    return engine.addProject(result.filePaths[0]);
  });
  handle(Ipc.projectsAddRemote, (payload: { cwd?: string }) => {
    const cwd = typeof payload?.cwd === "string" ? payload.cwd.trim() : "";
    if (!cwd) throw new Error("远程项目目录不能为空");
    return engine.addProject(cwd);
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
    if (!payload.cwd) return { ok: false as const, reason: "invalid" as const };
    try {
      const stat = statSync(payload.cwd);
      if (stat.isFile()) shell.showItemInFolder(payload.cwd);
      else {
        const error = await shell.openPath(payload.cwd);
        if (error) return { ok: false as const, reason: "missing" as const };
      }
      return { ok: true as const };
    } catch (error) {
      // A missing path used to fall through to openPath, which can open a parent
      // and look like the action did nothing. Report it so the caller can toast.
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return { ok: false as const, reason: "missing" as const };
      throw error;
    }
  });
  handle(Ipc.workspacePreview, (payload: { path: string }) => {
    if (!payload.path) return { kind: "error", path: "", name: "", message: uiText("路径无效", "Invalid path") };
    return readFilePreview(payload.path);
  });
  handle(Ipc.workspaceFilesExist, (payload: { paths?: unknown; cwd?: unknown }) =>
    existingFiles(payload?.paths, payload?.cwd),
  );
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
    if (!cwd) return { cwd, isRepository: false, changed: 0, staged: 0, additions: 0, deletions: 0, files: [] };
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
  handle(Ipc.workspaceGitGenerateCommitMessage, async (payload: { cwd: string; conversationId?: string }): Promise<string> => {
    const cwd = typeof payload.cwd === "string" ? payload.cwd.trim() : "";
    const conversationId = typeof payload.conversationId === "string" ? payload.conversationId : undefined;
    if (!cwd) throw new Error(uiText("项目路径无效", "Invalid project path"));
    const statusFiles = await readCommitStatusFiles(cwd);
    if (statusFiles.length === 0) throw new Error(uiText("没有要提交的改动", "No changes to commit"));
    const files = await collectCommitMessageMaterial(cwd, statusFiles);
    return engine.generateCommitMessage(files, conversationId);
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
  handle(Ipc.workspaceTerminalStart, (payload: { cwd?: string; cols?: number; rows?: number }, ctx) => {
    const cwd = typeof payload.cwd === "string" ? payload.cwd.trim() : "";
    // A terminal is not tied to a project: with no workspace bound it opens in home.
    const session = terminals.start(cwd || homedir(), { cols: payload.cols, rows: payload.rows });
    // Each pane starts its own shell and is the only client that can draw it, so its
    // output is addressed back to whoever asked for it (see `terminals.onData`).
    if (ctx.origin) terminalOwners.set(session.id, ctx.origin);
    return session;
  });
  handle(Ipc.workspaceTerminalWrite, (payload: { id: string; data: string }, ctx) => {
    if (!payload.id || typeof payload.data !== "string") return;
    // Typing into a terminal claims it: a client that reattached to a shell it did not
    // start (a reloaded window) is where its output belongs from now on.
    if (ctx.origin) terminalOwners.set(payload.id, ctx.origin);
    terminals.write(payload.id, payload.data);
  });
  handle(Ipc.workspaceTerminalResize, (payload: { id: string; cols: number; rows: number }) => {
    if (!payload.id) return;
    terminals.resize(payload.id, payload.cols, payload.rows);
  });
  handle(Ipc.workspaceTerminalKill, (payload: { id: string }) => {
    if (!payload.id) return;
    terminalOwners.delete(payload.id);
    terminals.kill(payload.id);
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
   * engine. The hourly refresh calls the same function. A refresh that cannot reach the
   * registry has still updated the snapshot, which is durable and read on the next
   * start, so it is reported as a success rather than as a failure the user would have
   * to undo.
   */
  handle(Ipc.modelsDevUpdate, () => refreshModelsDev());
  handle(Ipc.statsUsage, (payload?: { range?: UsageRange }) => {
    return collectUsageStats(getFastVibePaths(), payload?.range ?? "30d");
  });
  handle(Ipc.windowNew, () => {
    // FastVibe is a single-window app: every push, and every method that acts on "the
    // active conversation" without saying whose, is addressed to one client by design.
    // Rather than answer a second window with a second, subtly different view of the
    // same state, the request is folded into the window that already exists — which is
    // what the shortcut is really asking for.
    for (const window of windows) {
      if (window.isDestroyed()) continue;
      if (window.isMinimized()) window.restore();
      window.show();
      window.focus();
      return;
    }
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
  const commitSettings = async (payload: Record<string, unknown>, ctx: CallerContext) => {
    assertProxySettings(payload);
    const paths = getFastVibePaths();
    const previous = readAppSettings(paths);
    await networkProxy?.apply(payload);
    try { writeAppSettings(paths, payload); }
    catch (error) { await networkProxy?.apply(previous); throw error; }
    applyNativeTheme(payload);
    applyPermissionMode(payload);
    applyLanguages(payload);
    applyKeepAwake(payload);
    paintWindows(windows);
    scheduleUpdateCheck(payload.autoCheckUpdates !== false);
    // The other windows hold their own copy, loaded once at startup.
    broadcastSettings(ctx.origin, payload);
  };
  handle(Ipc.settingsSet, (settings: Record<string, unknown>, ctx) => queueSettingsWrite(async () => {
    const incoming = settings && typeof settings === "object" ? settings : {};
    await commitSettings(mergeSettingsPreservingProxy(readAppSettings(getFastVibePaths()), incoming), ctx);
  }));
  handle(Ipc.settingsProxySet, (settings: Record<string, unknown>, ctx) => queueSettingsWrite(async () => {
    const incoming = settings && typeof settings === "object" ? settings : {};
    assertProxySettings(incoming);
    await commitSettings({ ...readAppSettings(getFastVibePaths()), ...proxySettingsOf(incoming) }, ctx);
  }));
  handle(Ipc.settingsClear, (_payload: void, ctx) => queueSettingsWrite(async () => {
    const paths = getFastVibePaths();
    const previous = readAppSettings(paths);
    await networkProxy?.apply({});
    try { clearAppSettings(paths); }
    catch (error) { await networkProxy?.apply(previous); throw error; }
    applyNativeTheme({});
    applyPermissionMode({});
    applyLanguages({});
    applyKeepAwake({});
    paintWindows(windows);
    // 恢复默认 is a write like any other: the other windows hold their own copy and
    // would otherwise keep — and later re-save — the settings that were just reset.
    broadcastSettings(ctx.origin, {});
  }));

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
