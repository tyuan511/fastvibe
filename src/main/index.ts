import { app, BrowserWindow, dialog, ipcMain, nativeImage, protocol, safeStorage, screen, session, shell } from "electron";
import type { WebContents } from "electron";
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { Ipc, type AppModelsDevInfo } from "@shared/ipc";
import { broadcast } from "./ipc/broadcast";
import { dispatch, handle, handlerChannels, type CallerContext } from "./ipc/registry";
import { registerRemoteIpc, restoreRemoteServer, stopRemoteServer } from "./remote";
import { runAppConfig } from "./app-config";
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
import { installBrowserTaskGlobal } from "./pi/browser-task-runner";
import { installComputerTaskGlobal } from "./pi/computer-task-runner";
import { installDecisionScenarioGlobals } from "./pi/decision-scenarios";
import { installDecisionTaskDependencies, revokeDecisionTasks } from "./pi/decision-task-runner";
import { loadProviderKeys, setProviderKey } from "./engine/providers";
import { presentNotification, readNotificationSettings } from "./engine/notifications";
import { readAgentConfig } from "./engine/runtime-config";
import { notificationEnabled, notificationForEvent, type NotificationRequest } from "@shared/notifications";
import { applyLanguages } from "./engine/ai-language";
import { uiText } from "./engine/ui-text";
import { applyShellPath } from "./engine/shell-path";
import { exportLogs, initLogger, log, writeRendererLog } from "./engine/logger";
import { applyKeepAwake, clearRunningConversations, setConversationRunning } from "./engine/keep-awake";
import { createNetworkProxy } from "./engine/network-proxy";
import {
  getFileIconMapping,
  registerFileIconProtocol,
  registerFileIconScheme,
} from "./engine/file-icons";
import { applyPendingInstall, registerUpdater, scheduleUpdateCheck } from "./updater";
import { PiProcessManager } from "./pi/process-manager";
import { applyAppIcon, createDesktopWindow, windowOrigin } from "./desktop-window";
import { registerDesktopIpc } from "./ipc/desktop-handlers";
import { MemoryManager } from "./engine/memory";
import { TerminalSessions } from "./engine/terminal-sessions";
import { SshManager, openSshAppTransport } from "./ssh/ssh-manager";
import { readAgentRuntimeSource, type AgentRuntimeSource } from "./ssh/agent-runtime";
import { RemoteConnectionManager } from "./remote/connection-manager";
import { RemoteGateway, shouldSyncAgentConfig } from "./remote/gateway";
import { createAppServer, initAppServer, getAppServer } from "./app-server/runtime";
import { loadOrCreateServerIdentity } from "./server/identity";
import { APP_CAPABILITIES, conversationScope } from "@shared/app-protocol";
import { wireElectronAppTransport } from "./transport/electron";
import type { RemoteHostConnectionActivity, RemoteHostProfile, RemoteHostConnectionState, RemoteTransferProgress, SshErrorCode } from "@shared/remote-host";
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

function bundledAgentRuntime(): AgentRuntimeSource {
  const metadata = app.isPackaged
    ? join(app.getAppPath(), "agent-runtimes", "agent-runtime.json")
    : join(__dirname, "../../release/agent-runtime/agent-runtime.json");
  try {
    return readAgentRuntimeSource(metadata);
  } catch (error) {
    // A development checkout may not have built the Linux runtime yet. Keep the desktop
    // usable and make an SSH attempt fail with the actionable metadata error instead of
    // silently using the desktop version as a fake runtime version.
    log.warn(`Agent runtime metadata unavailable at ${metadata}: ${String(error)}`);
    return { release: "agent-runtime-v0", targets: {} };
  }
}

const agentRuntime = bundledAgentRuntime();
const paths = getFastVibePaths();
const memory = new MemoryManager(paths);
const engine = new PiProcessManager(paths, memory);
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
    ...agentRuntime,
    artifactDirectory: app.isPackaged
      ? join(app.getAppPath(), "agent-runtimes")
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
  const next: RemoteHostConnectionState = progress ? { ...rest, activity: progress.phase, progress } : rest;
  sshUiStates.set(hostId, next);
  broadcast(Ipc.sshState, next);
  broadcast(Ipc.sshStates, [...sshUiStates.values()]);
}

function publishSshActivity(hostId: string, activity: RemoteHostConnectionActivity): void {
  const current = sshUiStates.get(hostId) ?? { hostId, status: "connecting" as const };
  if (current.status !== "connecting") return;
  const { progress: _previous, ...rest } = current;
  const next: RemoteHostConnectionState = { ...rest, activity };
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
    onActivity: (activity) => publishSshActivity(profile.id, activity),
    signal,
    agentRuntime: {
      ...agentRuntime,
      artifactDirectory: app.isPackaged
        ? join(app.getAppPath(), "agent-runtimes")
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
const windows = new Set<BrowserWindow>();
function createWindow(): void {
  createDesktopWindow(windows);
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
    if (JSON.stringify(previous) !== JSON.stringify(config)) revokeDecisionTasks();
    // Each window holds its own copy, loaded once — same rule as `settings:changed`.
    broadcast(Ipc.decisionChanged, config, { except: ctx.origin });
    return config;
  });
  handle(Ipc.decisionKeyState, keyState);
  handle(Ipc.decisionSetKey, async (payload: { key?: unknown }): Promise<DecisionKeyState> => {
    const key = typeof payload?.key === "string" ? payload.key.trim() : "";
    // A new key is checked before it is stored. A failed check leaves the previous key in place.
    if (key) {
      const result = await testJevConnection(key);
      if (!result.ok) throw new Error(uiText(`API key 验证失败：${result.message}`, `API key check failed: ${result.message}`));
    }
    await setProviderKey(paths(), JEV_KEY_ENV, key);
    if (!key) revokeDecisionTasks();
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
  installDecisionTaskDependencies({
    completeText: (conversationId, system, user, signal) => engine.completeDecisionText(conversationId, system, user, signal),
  });
  installBrowserTaskGlobal();
  installComputerTaskGlobal();
  installDecisionScenarioGlobals();
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
  // once, afterwards. Wiring inside `registerDesktopIpc` meant the updater's four methods —
  // registered on the next line — landed in the table after the loop had already run,
  // so they were reachable by nothing.
  registerDesktopIpc({
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
  });
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
  engine.memory.onChange((state) => broadcast(Ipc.memoryChanged, state));
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
  // A background chat's live stream, for the clients that asked for it by name — the
  // phone page watching a conversation the desktop is not showing. Published straight
  // to the App Server rather than through `broadcast`, so it reaches those subscribers
  // and never the windows.
  // The `fastvibe_config_*` tools: the agent filling in FastVibe's own settings panes.
  engine.setAppConfigHost(runAppConfig);
  engine.setStreamWatch({
    isWatched: (conversationId) => getAppServer().hasNamedSubscriber(conversationScope(conversationId)),
    publish: (event) => {
      getAppServer().publish(Ipc.event, event, { namedOnly: true });
    },
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

