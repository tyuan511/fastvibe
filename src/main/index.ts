import { app, BrowserWindow, dialog, ipcMain, nativeImage, protocol, safeStorage, screen, session, shell } from "electron";
import type { WebContents } from "electron";
import { statSync } from "node:fs";
import { execFile, execFileSync } from "node:child_process";
import { promisify } from "node:util";
import { join } from "node:path";
import { homedir } from "node:os";
import { Ipc, type AppModelsDevInfo } from "@shared/ipc";
import { broadcast } from "./ipc/broadcast";
import { dispatch, handle, handlerChannels, type CallerContext } from "./ipc/registry";
import { registerRemoteIpc, restoreRemoteServer, stopRemoteServer } from "./remote";
import { readFilePreview } from "./engine/file-preview";
import { readWorkspaceDir } from "./engine/workspace-fs";
import {
  classifyCommitFile,
  countPatchLines,
  parseCommitPorcelain,
  type CommitFileMaterial,
  type CommitStatusPath,
} from "./engine/commit-message";
import { loadModelsDev, type ModelsDevStats } from "./engine/models-dev";
import { startModelsDevRefresh } from "./engine/models-dev-refresh";
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
import { configureFastVibeUserData, getFastVibePaths, type FastVibePaths } from "./engine/paths";
import { readDecisionConfig, writeDecisionConfig } from "./engine/decision/store";
import { testJevConnection } from "./engine/decision/backends/jev";
import { decisionModelConfigOf, JEV_KEY_ENV, type DecisionKeyState, type DecisionModelConfig, type DecisionTestResult } from "@shared/decision";
import { installBrowserTaskGlobal, revokeBrowserTasks } from "./pi/browser-task-runner";
import { loadProviderKeys, setProviderKey } from "./engine/providers";
import { readWindowState, writeWindowState } from "./engine/window-state";
import { presentNotification, readNotificationSettings } from "./engine/notifications";
import { readAgentConfig } from "./engine/runtime-config";
import { notificationEnabled, notificationForEvent, type NotificationRequest } from "@shared/notifications";
import { applyLanguages } from "./engine/ai-language";
import { uiText } from "./engine/ui-text";
import { applyShellPath } from "./engine/shell-path";
import { exportLogs, initLogger, log, writeRendererLog } from "./engine/logger";
import { applyKeepAwake, clearRunningConversations, setConversationRunning } from "./engine/keep-awake";
import { createNetworkProxy } from "./engine/network-proxy";
import { assertProxySettings, mergeSettingsPreservingProxy, proxySettingsOf } from "../shared/proxy";
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
import { SshManager, openSshAppTransport } from "./ssh/ssh-manager";
import { RemoteConnectionManager } from "./remote/connection-manager";
import { RemoteGateway, shouldSyncAgentConfig } from "./remote/gateway";
import { createAppServer, initAppServer, getAppServer } from "./app-server/runtime";
import { loadOrCreateServerIdentity } from "./server/identity";
import { APP_CAPABILITIES } from "@shared/app-protocol";
import { wireElectronAppTransport } from "./transport/electron";
import type { RemoteHostProfile, RemoteHostConnectionState, RemoteTransferProgress, SshErrorCode } from "@shared/remote-host";
import { stopBrowserCdp } from "./engine/browser-cdp";
import { attachBrowserRenderer, guardGuestPopups, installBrowserGlobal, respondBrowserRequest } from "./pi/browser-bridge";
import {
  computerPermissions,
  installComputerGlobal,
  listComputerApps,
  openComputerSettings,
  requestComputerPermissions,
  startComputerDrag,
} from "./pi/cua-bridge";
import { cancelGrantFlow, grantFlowState, startGrantFlow } from "./pi/computer-grant-flow";
import { importBrowserProfile, listBrowserProfiles } from "./engine/browser-profiles";
import { browserProfileDir, importIntoBrowserProfile, installedBrowsers, type ProfileCookie } from "./engine/browser-cdp";
import type { ImportSourceId, ProviderModel, UsageRange } from "@shared/types";
import type { GitBranch, GitDiffSource, GitStatus } from "@shared/ipc";

const execFileAsync = promisify(execFile);

app.setName("FastVibe");
configureFastVibeUserData(app.getPath("userData"));
process.env.FASTVIBE_RESOURCES_PATH = app.isPackaged
  ? process.resourcesPath
  : join(app.getAppPath(), "resources");

// GUI-launched Electron inherits a stub PATH. Fill in Homebrew / user bins
// before any agent session, MCP stdio server or in-app terminal is spawned.
applyShellPath();

// Privileged schemes must be declared before the app is ready.
registerFileIconScheme();

// A guest's popup must never become a second window — see `guardGuestPopups`. Registered
// here, before any window exists, so no guest can be created ahead of it.
guardGuestPopups();

// File logger before anything that can throw: engine construction, IPC, windows.
initLogger();

// Extensions are TypeScript modules jiti compiles at load time. Its on-disk cache
// cannot be written inside the packaged asar, so turn it off there; dev keeps the
// cache for faster reloads.
if (app.isPackaged) process.env.JITI_FS_CACHE = "false";

const engine = new PiProcessManager();
const terminals = new TerminalSessions();
/**
 * Which client each shell belongs to, by broadcast identity.
 *
 * A terminal pane starts its own shell (`terminalStart` returns a fresh id) and is the
 * only receiver that can draw it, so its output is delivered to that one client rather
 * than pushed to every window and every remote session.
 */
const terminalOwners = new Map<string, string>();

const sshManager = new SshManager({
  paths: getFastVibePaths(),
  // Linux without a secret service falls back to a hard-coded key ("basic_text"), which
  // is obfuscation rather than encryption; the 0600 file is no worse than that.
  secrets: {
    available: () => app.isReady()
      && safeStorage.isEncryptionAvailable()
      && (process.platform !== "linux" || safeStorage.getSelectedStorageBackend() !== "basic_text"),
    seal: (plain) => safeStorage.encryptString(plain).toString("base64"),
    open: (sealed) => safeStorage.decryptString(Buffer.from(sealed, "base64")),
  },
  onState: (state) => broadcast(Ipc.sshState, state),
  onPush: (channel, payload) => broadcast(channel, payload),
  log: {
    info: (message) => log.info(message),
    warn: (message) => log.warn(message),
  },
  agentRuntime: {
    version: app.getVersion(),
    artifactDirectory: app.isPackaged
      ? join(process.resourcesPath, "agent-runtimes")
      : join(__dirname, "../../release/agent-runtime"),
    cacheDirectory: join(getFastVibePaths().runtimeRoot, "ssh-agent-runtimes"),
    releaseBaseUrl: process.env.FASTVIBE_AGENT_RELEASE_BASE_URL,
  },
});

const sshUiStates = new Map<string, RemoteHostConnectionState>();

/** A download/upload bar for a connect in progress; `null` removes it. */
function publishSshProgress(hostId: string, progress: RemoteTransferProgress | null): void {
  const current = sshUiStates.get(hostId) ?? { hostId, status: "connecting" as const };
  if (current.status !== "connecting") return;
  const { progress: _previous, ...rest } = current;
  const next: RemoteHostConnectionState = progress ? { ...rest, progress } : rest;
  sshUiStates.set(hostId, next);
  broadcast(Ipc.sshState, next);
  broadcast(Ipc.sshStates, [...sshUiStates.values()]);
}

function publishSshOutput(hostId: string, message: string): void {
  const current = sshUiStates.get(hostId) ?? { hostId, status: "connecting" as const };
  const output = [...(current.output ?? []), message].slice(-80);
  const next: RemoteHostConnectionState = { ...current, hostId, status: "connecting", output };
  sshUiStates.set(hostId, next);
  broadcast(Ipc.sshState, next);
  broadcast(Ipc.sshStates, [...sshUiStates.values()]);
}

const remoteConnections = new RemoteConnectionManager({
  log: {
    info: (message) => log.info(message),
    warn: (message) => log.warn(message),
  },
  onStatus: (status) => {
    const profile = sshManager.profile(status.connectionId);
    const localPort = profile?.localPort;
    const previous = sshUiStates.get(status.connectionId);
    const output = previous?.output?.length ? { output: previous.output } : {};
    const home = remoteConnections.server(status.connectionId)?.home;
    const next: RemoteHostConnectionState = status.state === "ready"
      ? { hostId: status.connectionId, serverInstanceId: status.serverInstanceId, status: "connected", ...(localPort ? { localPort } : {}), ...(home ? { home } : {}) }
      : status.state === "connecting"
        ? { hostId: status.connectionId, serverInstanceId: null, status: "connecting", ...(localPort ? { localPort } : {}) }
        : status.state === "closed"
          ? { hostId: status.connectionId, serverInstanceId: status.serverInstanceId, status: "disconnected" }
          : { hostId: status.connectionId, serverInstanceId: status.serverInstanceId, status: "error", ...(status.error ? { error: status.error } : {}), ...(status.errorCode ? { errorCode: status.errorCode as SshErrorCode } : {}), ...output };
    sshUiStates.set(status.connectionId, next);
    broadcast(Ipc.sshState, next);
    broadcast(Ipc.sshStates, [...sshUiStates.values()]);
    gateway.publishLocalSnapshot(engine.listWorkspace());
  },
  onPush: (channel, payload, serverInstanceId) => gateway.acceptNamespacedRemotePush(channel, payload, serverInstanceId),
  // A dropped tunnel (sleep, Wi-Fi change) comes back on its own. The resident Agent is
  // still running, so each attempt is the preflight's fast path: one round trip, no deploy.
  reconnect: {
    delaysMs: [1_000, 3_000, 10_000, 30_000, 60_000, 120_000],
    profile: (connectionId) => sshManager.profile(connectionId),
    onReconnected: (server) => {
      void gateway.refreshServer(server.serverInstanceId).catch((error: unknown) => {
        log.warn(`remote refresh after reconnect failed: ${String(error)}`);
      });
    },
  },
  openTransport: (profile, signal) => openSshAppTransport({
    profile,
    onOutput: (message) => publishSshOutput(profile.id, message),
    onProgress: (progress) => publishSshProgress(profile.id, progress),
    signal,
    agentRuntime: {
      version: app.getVersion(),
      artifactDirectory: app.isPackaged
        ? join(process.resourcesPath, "agent-runtimes")
        : join(__dirname, "../../release/agent-runtime"),
      cacheDirectory: join(getFastVibePaths().runtimeRoot, "ssh-agent-runtimes"),
      releaseBaseUrl: process.env.FASTVIBE_AGENT_RELEASE_BASE_URL,
    },
    log: {
      info: (message) => log.info(message),
      warn: (message) => log.warn(message),
    },
  }),
});
const gateway = new RemoteGateway({
  localDispatch: (method, payload, ctx) => dispatch(method, payload, ctx as CallerContext),
  localSnapshot: () => engine.listWorkspace(),
  localAgentConfig: () => readAgentConfig(getFastVibePaths()),
  connections: remoteConnections,
  bindingsFile: getFastVibePaths().projectBindingsFile,
  profiles: () => {
    const hosts = sshManager.hosts();
    return [...hosts.saved, ...hosts.discovered];
  },
  broadcast,
});
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
const DEFAULT_WINDOW_SIZE = { width: 1280, height: 840 } as const;
const MIN_WINDOW_SIZE = { width: 920, height: 640 } as const;
const WINDOW_STATE_SAVE_DELAY_MS = 250;

function createWindow(): void {
  const paths = getFastVibePaths();
  const restored = readWindowState(paths.windowStateFile);
  const workArea = screen.getPrimaryDisplay().workAreaSize;
  const width = clampWindowDimension(restored?.width ?? DEFAULT_WINDOW_SIZE.width, MIN_WINDOW_SIZE.width, workArea.width);
  const height = clampWindowDimension(restored?.height ?? DEFAULT_WINDOW_SIZE.height, MIN_WINDOW_SIZE.height, workArea.height);
  const window = new BrowserWindow({
    width,
    height,
    minWidth: MIN_WINDOW_SIZE.width,
    minHeight: MIN_WINDOW_SIZE.height,
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

  let stateSaveTimer: ReturnType<typeof setTimeout> | undefined;
  const persistWindowState = (): void => {
    if (window.isDestroyed()) return;
    const bounds = window.getNormalBounds();
    try {
      writeWindowState(paths.windowStateFile, {
        width: bounds.width,
        height: bounds.height,
        maximized: window.isMaximized(),
      });
    } catch (error) {
      log.warn(`window state save failed: ${String(error)}`);
    }
  };
  const scheduleWindowStateSave = (): void => {
    if (stateSaveTimer) clearTimeout(stateSaveTimer);
    stateSaveTimer = setTimeout(() => {
      stateSaveTimer = undefined;
      persistWindowState();
    }, WINDOW_STATE_SAVE_DELAY_MS);
  };

  window.on("ready-to-show", () => {
    if (restored?.maximized) window.maximize();
    window.show();
  });
  window.on("resize", scheduleWindowStateSave);
  window.on("close", () => {
    if (stateSaveTimer) clearTimeout(stateSaveTimer);
    stateSaveTimer = undefined;
    persistWindowState();
  });
  // The title bar's maximise control swaps its glyph on this; Main owns the truth
  // because the OS can also maximise the window (snap, double-click, a WM key).
  const sendWindowState = (): void => {
    if (window.isDestroyed()) return;
    window.webContents.send(Ipc.windowState, { maximized: window.isMaximized() });
  };
  const handleMaximizedStateChange = (): void => {
    sendWindowState();
    scheduleWindowStateSave();
  };
  window.on("maximize", handleMaximizedStateChange);
  window.on("unmaximize", handleMaximizedStateChange);
  // Window events are subscribed through its App Protocol session in the transport, so
  // there is no per-window `subscribe({...})` here — the hub does not know what a
  // window is, and the transport's session is what hands it pushes.
  window.on("closed", () => {
    if (stateSaveTimer) clearTimeout(stateSaveTimer);
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

function clampWindowDimension(value: number, minimum: number, available: number): number {
  return Math.min(Math.max(value, minimum), Math.max(minimum, available));
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

/**
 * The decision engine's UI-facing methods (docs/decision-layer.md §5): which decision
 * model browser use runs on, the Jev key, and reachability. `browser_task` reads the
 * config per run; sessions pick up whether to offer the tool when their tools load.
 */
function registerDecisionIpc(): void {
  const paths = () => getFastVibePaths();
  const keyState = async (): Promise<DecisionKeyState> => ({ jev: Boolean((await loadProviderKeys(paths()))[JEV_KEY_ENV]) });
  handle(Ipc.decisionGetConfig, () => readDecisionConfig(paths().decisionFile));
  handle(Ipc.decisionSaveConfig, (payload: unknown, ctx) => {
    const config = decisionModelConfigOf(payload);
    const previous = readDecisionConfig(paths().decisionFile);
    writeDecisionConfig(paths().decisionFile, config);
    // Switching the model withdraws the old one's authority: running tasks stop at their next decision.
    if (JSON.stringify(previous) !== JSON.stringify(config)) revokeBrowserTasks();
    // Each window holds its own copy, loaded once — same rule as `settings:changed`.
    broadcast(Ipc.decisionChanged, config, { except: ctx.origin });
    return config;
  });
  handle(Ipc.decisionKeyState, keyState);
  handle(Ipc.decisionSetKey, async (payload: { key?: unknown }): Promise<DecisionKeyState> => {
    const key = typeof payload?.key === "string" ? payload.key.trim() : "";
    await setProviderKey(paths(), JEV_KEY_ENV, key);
    if (!key) revokeBrowserTasks();
    return keyState();
  });
  handle(Ipc.decisionTest, async (payload: unknown): Promise<DecisionTestResult> => {
    const config: DecisionModelConfig = decisionModelConfigOf(payload);
    if (config.kind !== "jev") return { ok: false, error: uiText("未选择决策模型", "No decision model is selected") };
    const key = (await loadProviderKeys(paths()))[JEV_KEY_ENV];
    if (!key) return { ok: false, error: uiText("还没有保存 API key", "No API key is saved") };
    const result = await testJevConnection(key);
    return result.ok ? { ok: true } : { ok: false, error: result.message };
  });
}

function registerSshIpc(): void {
  handle(Ipc.sshState, () => ({ hostId: null, status: "disconnected" } satisfies RemoteHostConnectionState));
  handle(Ipc.sshStates, () => [...sshUiStates.values()]);
  handle(Ipc.sshHosts, () => sshManager.publicHosts());
  handle(Ipc.sshHostSave, (payload: { host?: RemoteHostProfile }) => {
    if (!payload?.host) throw new Error("SSH 主机配置无效");
    return sshManager.saveHost(payload.host);
  });
  handle(Ipc.sshHostRemove, async (payload: { id?: string }) => {
    const id = typeof payload?.id === "string" ? payload.id.trim() : "";
    if (!id) throw new Error("SSH 主机无效");
    await remoteConnections.disconnect(id);
    return sshManager.removeHost(id);
  });
  handle(Ipc.sshHostKeyScan, async (payload: { hostId?: string }) => {
    const hostId = typeof payload?.hostId === "string" ? payload.hostId.trim() : "";
    if (!hostId) throw new Error("SSH 主机无效");
    return sshManager.scanHostKey(hostId);
  });
  handle(Ipc.sshHostKeyTrust, (payload: { hostId?: string; fingerprints?: unknown }) => {
    const hostId = typeof payload?.hostId === "string" ? payload.hostId.trim() : "";
    const fingerprints = Array.isArray(payload?.fingerprints) ? payload.fingerprints.filter((item): item is string => typeof item === "string") : [];
    if (!hostId) throw new Error("SSH 主机无效");
    sshManager.trustHostKey(hostId, fingerprints);
  });
  handle(Ipc.sshStopAgent, async (payload: { hostId?: string }) => {
    const hostId = typeof payload?.hostId === "string" ? payload.hostId.trim() : "";
    if (!hostId) throw new Error("SSH 主机无效");
    // Disconnect first: a live tunnel to an Agent being killed would only reconnect it.
    await remoteConnections.disconnect(hostId);
    return sshManager.stopAgent(hostId);
  });
  handle(Ipc.sshPickIdentityFile, async () => {
    const result = await dialog.showOpenDialog({
      title: uiText("选择 SSH 私钥", "Choose SSH private key"),
      properties: ["openFile"],
    });
    return result.canceled || !result.filePaths[0] ? null : result.filePaths[0];
  });
  handle(Ipc.sshTest, async (payload: { hostId?: string }) => {
    const hostId = typeof payload?.hostId === "string" ? payload.hostId.trim() : "";
    if (!hostId) throw new Error("SSH 主机无效");
    return sshManager.test(hostId);
  });
  handle(Ipc.sshConnect, async (payload: { hostId?: string }) => {
    const hostId = typeof payload?.hostId === "string" ? payload.hostId.trim() : "";
    if (!hostId) throw new Error("SSH 主机无效");
    const profile = sshManager.profile(hostId);
    if (!profile) throw new Error("SSH 主机不存在");
    const connected = await remoteConnections.connect(profile);
    await gateway.refreshServer(connected.serverInstanceId);
    const state = sshUiStates.get(hostId);
    return state && connected.home ? { ...state, home: connected.home } : state;
  });
  handle(Ipc.sshDisconnect, async (payload?: { hostId?: string }) => {
    const hostId = typeof payload?.hostId === "string" ? payload.hostId.trim() : "";
    if (!hostId) throw new Error("请选择要断开的 SSH 主机");
    await remoteConnections.disconnect(hostId);
    return sshUiStates.get(hostId);
  });
}

/**
 * One in-flight refresh, shared by the hourly timer and 设置 → 关于.
 *
 * A click during the background fetch waits for that same download rather than
 * starting a second one. The snapshot is applied to the running engine only when
 * the catalog itself moved — an unchanged hour must not rebind every open session —
 * and a cold engine is left alone: its next start reads the file either way.
 */
let modelsDevInflight: Promise<AppModelsDevInfo> | null = null;

function refreshModelsDev(): Promise<AppModelsDevInfo> {
  if (modelsDevInflight) return modelsDevInflight;
  modelsDevInflight = (async () => {
    const result = await updateModelsDevSnapshot();
    if (shutdownPhase === "running" && result.changed) {
      await engine.reloadModelMetadata().catch((error: unknown) => {
        log.warn(`models.dev reload failed: ${String(error)}`);
      });
    }
    const info = modelsDevInfo(result);
    if (shutdownPhase === "running") broadcast(Ipc.modelsDevChanged, info);
    log.info(`models.dev refreshed models=${info.models} changed=${result.changed}`);
    return info;
  })().finally(() => {
    modelsDevInflight = null;
  });
  return modelsDevInflight;
}

function registerIpc(): void {
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

  handle(Ipc.engineAbortSubagent, async (payload: { subagentId: string; conversationId?: string }) => {
    await engine.abortSubagent(payload.subagentId, payload.conversationId);
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

  handle(Ipc.engineQueueAdd, async (payload: Parameters<typeof engine.enqueueMessage>[0]) => {
    return engine.enqueueMessage(payload);
  });
  handle(Ipc.engineQueueCancel, async (payload: { id: string }) => engine.cancelQueued(payload.id));
  handle(Ipc.engineQueueRecall, async (payload: { id: string }) => engine.recallQueued(payload.id));
  handle(Ipc.engineQueueSendNow, async (payload: { id: string }) => engine.sendQueuedNow(payload.id));
  handle(Ipc.engineQueueReorder, async (payload: { conversationId: string; ids: string[] }) =>
    engine.reorderQueued(payload.conversationId, payload.ids));
  handle(Ipc.engineQueueResume, async (payload: { conversationId: string }) =>
    engine.resumeQueue(payload.conversationId));

  handle(Ipc.engineCompact, async (payload?: { customInstructions?: string; conversationId?: string }) => {
    return engine.compact(payload?.customInstructions, payload?.conversationId);
  });

  handle(Ipc.engineGetCommands, async (payload?: { conversationId?: string }) => {
    return engine.getCommands(payload?.conversationId);
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

  handle(Ipc.engineGetSubagents, async (payload?: { conversationId?: string }) => {
    return engine.getSubagents(payload?.conversationId);
  });
  handle(Ipc.engineListAgentConfigs, () => engine.getAgentConfigs());
  handle(Ipc.engineSaveAgentConfig, (payload: import("@shared/types").SubagentDraft) => engine.saveAgentConfig(payload));
  handle(Ipc.engineRemoveAgentConfig, (payload: { id: string }) => engine.removeAgentConfig(payload.id));

  handle(Ipc.engineGetSubagentMessages, async (payload: { subagentId: string; conversationId?: string }) => {
    return engine.getSubagentMessages(payload.subagentId, payload.conversationId);
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

  // The SSH gateway invokes this on the headless Agent. Keep the method in the
  // desktop table for protocol coverage, but never accept it as a local write.
  handle(Ipc.engineSyncConfig, async () => {
    throw new Error("配置同步只能由 SSH Agent 接收");
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
  handle(Ipc.engineSetInterrupt, async (payload: { mode: "immediate" | "wait"; conversationId?: string }) => {
    return engine.setInterruptMode(payload.mode, payload.conversationId);
  });
  handle(Ipc.engineSetAutoCompact, async (payload: { enabled: boolean; conversationId?: string }) => {
    return engine.setAutoCompaction(payload.enabled, payload.conversationId);
  });
  handle(Ipc.engineBranch, async (payload: { entryId: string; conversationId?: string }) => {
    return engine.branch(payload.entryId, payload.conversationId);
  });
  handle(Ipc.engineFork, async (payload?: { entryId?: string; conversationId?: string }) => {
    return engine.fork(payload?.entryId, payload?.conversationId);
  });
  handle(Ipc.engineGetMessages, async (payload?: { conversationId?: string }) => {
    return engine.loadMessages(payload?.conversationId);
  });
  handle(Ipc.engineGetMessagesSince, async (payload?: { anchorEntryId?: string; conversationId?: string }) => {
    const anchor = payload?.anchorEntryId;
    if (!anchor) return { mode: "full", messages: await engine.loadMessages(payload?.conversationId) };
    return engine.loadMessagesSince(anchor, payload?.conversationId);
  });
  handle(Ipc.engineGetSnapshot, async (payload?: { conversationId?: string }) => {
    return engine.getSnapshot(payload?.conversationId);
  });
  handle(Ipc.engineGetStats, async (payload?: { conversationId?: string }) => {
    return engine.getSessionStats(payload?.conversationId);
  });
  handle(Ipc.engineSetSteering, async (payload: { mode: "all" | "one-at-a-time"; conversationId?: string }) => {
    return engine.setSteeringMode(payload.mode, payload.conversationId);
  });
  handle(Ipc.engineSetFollowUp, async (payload: { mode: "all" | "one-at-a-time"; conversationId?: string }) => {
    return engine.setFollowUpMode(payload.mode, payload.conversationId);
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
 * Route a renderer call by the remote ids it already carries. There is intentionally no
 * "currently connected SSH host": a local payload stays in the local registry, while a
 * namespaced conversation/project resolves one exact App Server. The response is put
 * back into the same opaque namespace before it reaches the renderer.
 */
async function dispatchForWindow(
  channel: string,
  payload: unknown,
  context: CallerContext,
): Promise<unknown> {
  return gateway.dispatch(channel, payload, context);
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
  wireElectronAppTransport(getAppServer());

  // `settings:get-sync` is the one call that cannot go through the table: it is read in
  // the preload world before the page runs so the first paint already has the theme,
  // and `sendSync` has no counterpart on any other transport. A remote client answers
  // the same need from its connection handshake instead.
  ipcMain.on(Ipc.settingsGetSync, (event) => {
    event.returnValue = readAppSettings(getFastVibePaths());
  });
}

type ShutdownPhase = "running" | "cleaning" | "exiting";

const SHUTDOWN_TIMEOUT_MS = 5_000;
const EXIT_FALLBACK_MS = 1_000;
let shutdownPhase: ShutdownPhase = "running";
let stopModelsDevRefresh: (() => void) | undefined;
let networkProxy: Awaited<ReturnType<typeof createNetworkProxy>> | undefined;
let settingsWrite: Promise<void> = Promise.resolve();
function queueSettingsWrite(task: () => Promise<void>): Promise<void> {
  const result = settingsWrite.then(task);
  settingsWrite = result.catch(() => undefined);
  return result;
}
let shutdownDeadline: NodeJS.Timeout | undefined;
let devParentWatch: NodeJS.Timeout | undefined;

// FastVibe is a single-window app, and one *process*: a second launch — the Dock icon, or
// opening the .app again — must bring the window that already exists forward rather than
// start a second copy holding its own engine over the same catalog and transcripts. The
// lock is taken at module scope, before anything is ready, because the process that loses
// it has to be gone before it opens a window.
//
// `electron-vite dev` relaunches the app on every main-process edit, and it terminates
// the old child asynchronously — so the new one can ask for the lock while the previous
// is still releasing it, which would leave `pnpm dev` showing an app with no window and
// no error. `ELECTRON_RENDERER_URL` is set by that dev server and by nothing else, and
// this is exactly the case where `false` is the *wrong* answer: in development a second
// window is the point, because it is how the reload is visible.
const singleInstance = Boolean(process.env.ELECTRON_RENDERER_URL) || app.requestSingleInstanceLock();

app.whenReady().then(async () => {
  if (!singleInstance) return;
  if (shutdownPhase !== "running") return;
  log.info("app ready");
  installBrowserGlobal();
  installBrowserTaskGlobal({
    completeText: (conversationId, system, user, signal) => engine.completeDecisionText(conversationId, system, user, signal),
  });
  // Registers the bridge global and an at-quit driver shutdown. The native library is
  // still not loaded here — `cua-bridge` imports it on the first `computer_*` call, so a
  // user who never touches the feature pays nothing for it.
  installComputerGlobal();
  // The grant panel is a window, so it is torn down where the other windows are, not
  // inside the bridge — which would make the bridge and the flow import each other.
  app.once("will-quit", () => cancelGrantFlow());
  applyAppIcon();
  const startupSettings = readAppSettings(getFastVibePaths());
  networkProxy = await createNetworkProxy(startupSettings);
  applyNativeTheme(startupSettings);
  applyStartupPermissionMode(getFastVibePaths());
  // Seed the sandbox/extensions' UI language and the AI 偏好语言 prompt before any
  // session starts. A first launch has no settings file yet; the renderer writes one
  // (with the OS-detected language) on boot, which re-applies these.
  applyLanguages(startupSettings);
  if (networkProxy.error) {
    log.warn(`network proxy setup failed: ${String(networkProxy.error)}`);
    dialog.showErrorBox(uiText("网络代理初始化失败", "Network proxy setup failed"), uiText(
      "已暂停客户端联网。请打开设置 → 通用 → 网络代理，修改配置后应用以重试。",
      "Client networking is paused. Open Settings → General → Network proxy and apply a configuration change to retry.",
    ));
  }
  applyKeepAwake(startupSettings);
  registerFileIconProtocol();
  // Every module that owns methods registers them first; the transport is attached
  // once, afterwards. Wiring inside `registerIpc` meant the updater's four methods —
  // registered on the next line — landed in the table after the loop had already run,
  // so they were reachable by nothing.
  registerIpc();
  registerUpdater(
    () => windows,
    () => createWindow(),
  );
  registerRemoteIpc();
  registerSshIpc();
  registerDecisionIpc();
  createAppServer({
    identity: loadOrCreateServerIdentity(getFastVibePaths().serverIdentityFile, {
      version: app.getVersion(),
      platform: process.platform,
    }),
    capabilities: APP_CAPABILITIES,
    channels: handlerChannels,
    log,
  });
  initAppServer({
    dispatch: (method, payload, context) => {
      const caller: CallerContext = {
        kind: context.kind,
        window: (context.window as BrowserWindow | null) ?? null,
        origin: context.origin,
      };
      // A remote WebSocket is already at this App Server. It must never be routed back
      // out through this desktop's gateway merely because its payload contains a local
      // conversation id. The gateway is only for Electron calls selecting a binding.
      if (context.kind === "remote") {
        const result = dispatch(method, payload, caller);
        if (shouldSyncAgentConfig(method)) return result.finally(() => void gateway.syncConfiguration());
        return result;
      }
      return gateway.dispatch(method, payload, caller);
    },
  });
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
    gateway.publishLocalSnapshot(snapshot);
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
    // Addressed to the pane that opened this shell. A build log used to reach every
    // window and every remote client, which on a phone over the tunnel meant megabytes
    // of output for a terminal it had never opened. An unknown owner (a shell started
    // before this map existed) still goes to everyone, so nothing can go missing.
    const owner = terminalOwners.get(event.id);
    broadcast(Ipc.workspaceTerminalData, event, owner ? { only: owner } : undefined);
    if (event.exited) terminalOwners.delete(event.id);
  });

  engine.onEvent((event) => {
    // Raise a desktop notice when a background chat needs the user, or when an update
    // lands. Everything else — every streamed token among them — must fall straight
    // through to the fan-out below.
    if (NOTIFIABLE_EVENTS.has(String(event.type))) raiseNotification(event);
    if (event.type === "extension_ui_request") {
      void engine.handleExtensionUi(event);
    }
    // 运行时保持唤醒: the engine broadcasts run start/end for every conversation,
    // active or not, so a background chat keeps the machine up too.
    if (event.type === "conversation_running") {
      setConversationRunning(String(event.conversationId ?? ""), event.running === true);
    }
    gateway.publishLocalEvent(event);
  });

  createWindow();
  void engine.start();
  // Warm every bound remote project in the background. Do not wait for SSH before
  // showing the window, and do not activate any conversation as catalogs arrive.
  void gateway.restoreBoundServers().then((failures) => {
    for (const failure of failures) log.warn(`remote startup connection failed server=${failure.serverInstanceId}: ${failure.error}`);
  }).catch((error: unknown) => log.warn(`remote startup restore failed: ${String(error)}`));
  // Limits and prices move faster than releases. Refresh hourly; a snapshot already
  // within the hour waits out the rest of it instead of fetching at every launch.
  stopModelsDevRefresh = startModelsDevRefresh({
    generatedAt: () => loadModelsDev().stats.generatedAt,
    refresh: () => refreshModelsDev().then(() => undefined),
    onError: (error) => {
      log.warn(`models.dev refresh failed: ${error instanceof Error ? error.message : String(error)}`);
    },
  });
  // Brought back only if it was running before, and never without a password.
  void restoreRemoteServer();

  app.on("activate", () => {
    if (shutdownPhase === "running" && BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});

/**
 * A second launch is not a second window: the lock is what makes this one process, and
 * the event is the arriving second process asking to be let in.
 */
app.on("second-instance", () => {
  if (!singleInstance || shutdownPhase !== "running") return;
  for (const window of windows) {
    if (window.isDestroyed()) continue;
    if (window.isMinimized()) window.restore();
    window.show();
    window.focus();
    return;
  }
  createWindow();
});

/**
 * End the process after one quit request, but give sessions and child processes a
 * short bounded window to shut down first. A second Cmd+Q must not be the mechanism
 * that escapes a cleanup promise which never settles.
 */
function requestShutdown(reason: string): void {
  if (shutdownPhase !== "running") return;
  shutdownPhase = "cleaning";
  log.info(`app quitting reason=${reason}`);

  if (devParentWatch) clearInterval(devParentWatch);
  devParentWatch = undefined;
  stopModelsDevRefresh?.();
  stopModelsDevRefresh = undefined;
  // Establish the deadline before calling any cleanup owner. A synchronous failure
  // must not strand the process in the cleaning phase either.
  shutdownDeadline = setTimeout(() => finishShutdown(true), SHUTDOWN_TIMEOUT_MS);

  // These are synchronous and should happen even if one of the asynchronous owners
  // below never settles.
  try {
    terminals.dispose();
  } catch (error) {
    log.warn(`terminal cleanup failed: ${String(error)}`);
  }
  try {
    clearRunningConversations();
  } catch (error) {
    log.warn(`keep-awake cleanup failed: ${String(error)}`);
  }
  try {
    stopBrowserCdp();
  } catch (error) {
    log.warn(`system browser cleanup failed: ${String(error)}`);
  }
  try {
    engine.flush();
  } catch (error) {
    log.warn(`engine flush failed: ${String(error)}`);
  }

  void Promise.allSettled([engine.stop(), stopRemoteServer(), remoteConnections.closeAll(), networkProxy?.close()]).then((results) => {
    for (const result of results) {
      if (result.status === "rejected") log.warn(`shutdown cleanup failed: ${String(result.reason)}`);
    }
    try {
      engine.flush();
    } catch (error) {
      log.warn(`final engine flush failed: ${String(error)}`);
    }
    finishShutdown(false);
  });
}

function finishShutdown(timedOut: boolean): void {
  if (shutdownPhase !== "cleaning") return;
  shutdownPhase = "exiting";
  if (shutdownDeadline) clearTimeout(shutdownDeadline);
  shutdownDeadline = undefined;
  if (timedOut) log.warn(`shutdown cleanup timed out after ${SHUTDOWN_TIMEOUT_MS}ms`);

  // Keep this timer referenced: it is the guarantee that one quit request ends the
  // process even when Electron or the updater does not complete its own exit path.
  const fallback = setTimeout(() => app.exit(0), EXIT_FALLBACK_MS);

  // On Windows/Linux quitAndInstall owns the normal exit. Keep a longer bound there,
  // since an updater handoff must not leave a Dock/taskbar process forever.
  let installing = false;
  try {
    installing = applyPendingInstall();
  } catch (error) {
    log.warn(`update handoff failed: ${String(error)}`);
  }
  if (installing) {
    clearTimeout(fallback);
    setTimeout(() => app.exit(0), 10_000);
  } else {
    app.quit();
  }
}

app.on("before-quit", (event) => {
  if (shutdownPhase === "exiting") return;
  event.preventDefault();
  requestShutdown("app request");
});

for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"] as const) {
  process.on(signal, () => requestShutdown(signal));
}

// electron-vite launches Electron as a child. Some IDE stop buttons terminate only
// that development host, leaving its child alive and visible in the Dock. A packaged
// app must not care who launched it, so this parent-liveness rule is development-only.
if (!app.isPackaged && process.env.ELECTRON_RENDERER_URL) {
  const parentPid = process.ppid;
  let launcherPid: number | undefined;
  if (process.platform !== "win32" && parentPid > 1) {
    try {
      const value = execFileSync("ps", ["-o", "ppid=", "-p", String(parentPid)], { encoding: "utf8" }).trim();
      const parsed = Number(value);
      if (Number.isSafeInteger(parsed) && parsed > 1) launcherPid = parsed;
    } catch {
      // Direct-parent tracking still covers electron-vite itself.
    }
  }
  const alive = (pid: number): boolean => {
    try {
      process.kill(pid, 0);
      return true;
    } catch (error) {
      return error instanceof Error && "code" in error && error.code === "EPERM";
    }
  };
  devParentWatch = setInterval(() => {
    if (
      parentPid <= 1 ||
      process.ppid !== parentPid ||
      !alive(parentPid) ||
      (launcherPid !== undefined && !alive(launcherPid))
    ) {
      requestShutdown("development host ended");
    }
  }, 500);
  devParentWatch.unref();
}

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
 * The two engine events a desktop notice can come from.
 *
 * A set rather than a call to `notificationForEvent`, because this is the hot path — it
 * runs once per streamed token of every reply.
 */
const NOTIFIABLE_EVENTS = new Set(["conversation_activity", "extension_ui_request"]);

/**
 * Raise one notice, if the user asked for that scenario and no window is in front.
 *
 * The wording lives here rather than in `notificationForEvent`: that function is a pure
 * scenario decision the tests load without a process environment, while every user-facing
 * string in Main goes through `uiText` so it follows 界面语言.
 *
 * The window check comes first on purpose. It is the cheap part of the gate and it is true
 * for every streamed token of a reply the user is watching, so nothing expensive —
 * resolving the paths behind `settings.json`, let alone parsing it — happens until the
 * app is genuinely in the background and an event worth noticing has actually arrived.
 */
function raiseNotification(event: Record<string, unknown>): void {
  const focused = [...windows].some((window) => !window.isDestroyed() && window.isFocused());
  if (focused) return;
  const notice = notificationForEvent(event);
  if (!notice) return;
  if (!notificationEnabled(readNotificationSettings(), notice.setting)) return;
  // A blocking prompt parks the tool until it is answered, and its panel is only drawn for
  // the conversation on screen — so without this notice a background chat could sit
  // waiting with nothing anywhere to say so.
  const request: NotificationRequest =
    notice.setting === "notifyApproval"
      ? {
          ...notice,
          title: uiText("有一个会话在等你", "A chat is waiting for you"),
          body: uiText("切换到这个会话继续处理。", "Switch to that conversation to continue."),
        }
      : {
          ...notice,
          title: notice.title ?? uiText("会话", "Chat"),
          body:
            notice.setting === "notifyError"
              ? uiText("任务出错了，可以回来看看。", "The task failed. Come back to see what happened.")
              : uiText("任务已完成，可以回来查看结果。", "The task is done. Come back to see the result."),
        };
  presentNotification(request, {
    windows: () => windows,
    createWindow: () => createWindow(),
    openConversation: (id) => engine.openConversation(id),
  });
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

async function readCommitStatusFiles(cwd: string): Promise<CommitStatusPath[]> {
  const { stdout } = await execFileAsync(
    "git",
    ["--no-optional-locks", "-C", cwd, "status", "--porcelain=v1", "-z", "--untracked-files=all"],
    { timeout: 10_000, maxBuffer: 4 * 1024 * 1024 },
  );
  return parseCommitPorcelain(stdout);
}

async function collectCommitMessageMaterial(
  cwd: string,
  files: CommitStatusPath[],
): Promise<CommitFileMaterial[]> {
  const results: CommitFileMaterial[] = new Array(files.length);
  // Read bodies from at most 128 files, rotating across top-level directories so one
  // generated subtree cannot consume the whole collection budget. Every other path
  // still reaches the planner as metadata.
  const queues = new Map<string, number[]>();
  files.forEach((file, index) => {
    const kind = classifyCommitFile(file.path);
    if (file.index === "?" || file.worktree === "?" || kind === "lock" || kind === "generated") return;
    const slash = file.path.indexOf("/");
    const area = slash > 0 ? file.path.slice(0, slash) : "root";
    const queue = queues.get(area) ?? [];
    queue.push(index);
    queues.set(area, queue);
  });
  const bodyIndexes = new Set<number>();
  while (bodyIndexes.size < 128) {
    let added = false;
    for (const queue of queues.values()) {
      const index = queue.shift();
      if (index === undefined) continue;
      bodyIndexes.add(index);
      added = true;
      if (bodyIndexes.size >= 128) break;
    }
    if (!added) break;
  }
  let cursor = 0;
  const workers = Array.from({ length: Math.min(4, files.length) }, async () => {
    for (;;) {
      const index = cursor;
      cursor += 1;
      const file = files[index];
      if (!file) return;
      const status = `${file.index}${file.worktree}`;
      const initialKind = classifyCommitFile(file.path);
      if (!bodyIndexes.has(index)) {
        results[index] = {
          path: file.displayPath,
          status,
          kind: initialKind,
          omitted: file.index === "?" || file.worktree === "?"
            ? "untracked: metadata only"
            : initialKind === "lock" || initialKind === "generated"
              ? undefined
              : "content collection limit",
        };
        continue;
      }
      // Porcelain paths are repository-root relative even when the bound workspace is
      // a subdirectory. `top` keeps the literal path anchored to that same root.
      const pathspec = `:(top,literal)${file.path}`;
      let patch = "";
      let omitted: string | undefined;
      try {
        patch = (await execFileAsync(
          "git",
          ["-C", cwd, "diff", "HEAD", "--no-ext-diff", "--no-textconv", "--unified=3", "--", pathspec],
          { timeout: 5000, maxBuffer: 128 * 1024 },
        )).stdout;
      } catch (error) {
        const partial = error && typeof error === "object" && "stdout" in error && typeof error.stdout === "string"
          ? error.stdout
          : "";
        if (partial) {
          patch = partial;
          omitted = "diff truncated";
        } else {
          const [staged, working] = await Promise.all([
            execFileAsync("git", ["-C", cwd, "diff", "--cached", "--no-ext-diff", "--no-textconv", "--unified=3", "--", pathspec], { timeout: 5000, maxBuffer: 64 * 1024 }).catch(() => ({ stdout: "" })),
            execFileAsync("git", ["-C", cwd, "diff", "--no-ext-diff", "--no-textconv", "--unified=3", "--", pathspec], { timeout: 5000, maxBuffer: 64 * 1024 }).catch(() => ({ stdout: "" })),
          ]);
          patch = `${staged.stdout}\n${working.stdout}`.trim();
          if (!patch) omitted = "diff unavailable";
        }
      }
      const stats = countPatchLines(patch);
      results[index] = {
        path: file.displayPath,
        status,
        patch,
        ...stats,
        kind: classifyCommitFile(file.path, patch),
        omitted,
      };
    }
  });
  await Promise.all(workers);
  return results.filter(Boolean);
}

function parseGitNumstat(output: string): { additions: number; deletions: number } {
  let additions = 0;
  let deletions = 0;
  for (const line of output.split(/\r?\n/)) {
    const [added, removed] = line.split("\t", 3);
    if (/^\d+$/.test(added ?? "")) additions += Number(added);
    if (/^\d+$/.test(removed ?? "")) deletions += Number(removed);
  }
  return { additions, deletions };
}

async function readGitStatus(cwd: string): Promise<GitStatus> {
  const empty: GitStatus = { cwd, isRepository: false, changed: 0, staged: 0, additions: 0, deletions: 0, files: [] };
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
    let additions = 0;
    let deletions = 0;
    try {
      const diff = await execFileAsync("git", ["-C", cwd, "diff", "--numstat", "HEAD", "--"], { timeout: 5000, maxBuffer: 256 * 1024 });
      ({ additions, deletions } = parseGitNumstat(diff.stdout));
    } catch {
      // An unborn branch has no HEAD. Its staged and unstaged layers are still useful,
      // and summing them is the closest line-level status available before first commit.
      const [stagedDiff, workingDiff] = await Promise.all([
        execFileAsync("git", ["-C", cwd, "diff", "--numstat", "--cached", "--"], { timeout: 5000, maxBuffer: 256 * 1024 }).catch(() => ({ stdout: "" })),
        execFileAsync("git", ["-C", cwd, "diff", "--numstat", "--"], { timeout: 5000, maxBuffer: 256 * 1024 }).catch(() => ({ stdout: "" })),
      ]);
      const stagedStats = parseGitNumstat(stagedDiff.stdout);
      const workingStats = parseGitNumstat(workingDiff.stdout);
      additions = stagedStats.additions + workingStats.additions;
      deletions = stagedStats.deletions + workingStats.deletions;
    }
    return { cwd, isRepository: true, branch, changed, staged, additions, deletions, ahead, behind, files };
  } catch {
    return empty;
  }
}
