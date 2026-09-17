import { contextBridge, ipcRenderer } from "electron";
import { Ipc } from "@shared/ipc";
import type {
  ChatMessage,
  ConversationDeleteResult,
  ConversationOpenResult,
  ConversationSearchHit,
  ConversationSnapshot,
  ConversationReadyEvent,
  DirEntry,
  FastVibeModel,
  SessionStats,
  EngineSessionState,
  EngineStatus,
  EngineEvent,
  ProjectAddResult,
  PromptImage,
  ProviderConfig,
  ProviderModel,
  NativeProviderConfig,
  OAuthEventPayload,
  OAuthLoginResult,
  CcSwitchScan,
  SlashCommand,
  FilePreview,
  SubagentInfo,
  UsageRange,
  UsageStats,
  WorkspaceSnapshot,
  ExtensionInfo,
  ExtensionPackage,
  FileIconMapping,
  ImportCandidate,
  ImportRunResult,
  ImportSourceId,
  ImportSourceStatus,
  McpServerConfig,
  McpServerStatus,
  SkillDraft,
  SkillInfo,
  BrowserImportResult,
  BrowserProfileInfo,
  BrowserRequest,
} from "@shared/types";
import type {
  AppUpdateState,
  GitBranch,
  GitDiffSource,
  GitStatus,
  TerminalDataEvent,
  WindowChromeState,
  TerminalSessionInfo,
} from "@shared/ipc";

const api = {
  engine: {
    getStatus: (): Promise<EngineStatus> => ipcRenderer.invoke(Ipc.engineGetStatus),
    start: (cwd?: string): Promise<EngineStatus> => ipcRenderer.invoke(Ipc.engineStart, { cwd }),
    stop: (): Promise<EngineStatus> => ipcRenderer.invoke(Ipc.engineStop),
    prompt: (
      message: string,
      options?: {
        streamingBehavior?: "steer" | "followUp";
        images?: PromptImage[];
        /** Omitted by single-window callers, which mean "the chat on screen". */
        conversationId?: string;
      },
    ): Promise<void> => ipcRenderer.invoke(Ipc.enginePrompt, { message, ...options }),
    steer: (message: string, images?: PromptImage[], conversationId?: string): Promise<void> =>
      ipcRenderer.invoke(Ipc.engineSteer, { message, images, conversationId }),
    followUp: (message: string, images?: PromptImage[], conversationId?: string): Promise<void> =>
      ipcRenderer.invoke(Ipc.engineFollowUp, { message, images, conversationId }),
    /** Stop one chat's run. Called with no id, the engine falls back to its active chat. */
    abort: (conversationId?: string): Promise<void> => ipcRenderer.invoke(Ipc.engineAbort, { conversationId }),
    /** Stop one delegated run, leaving its parent chat's own run alone. */
    abortSubagent: (subagentId: string): Promise<void> =>
      ipcRenderer.invoke(Ipc.engineAbortSubagent, { subagentId }),
    /** Resume the interrupted turn from the transcript, with no new user message. */
    continue: (conversationId?: string): Promise<void> =>
      ipcRenderer.invoke(Ipc.engineContinue, { conversationId }),
    clearQueue: (conversationId?: string): Promise<{ steering: string[]; followUp: string[] }> =>
      ipcRenderer.invoke(Ipc.engineClearQueue, { conversationId }),
    replaceSteering: (
      items: Array<{ text: string; images?: PromptImage[] }>,
      conversationId?: string,
    ): Promise<void> => ipcRenderer.invoke(Ipc.engineReplaceSteering, { items, conversationId }),
    compact: (customInstructions?: string, conversationId?: string): Promise<EngineSessionState> =>
      ipcRenderer.invoke(Ipc.engineCompact, { customInstructions, conversationId }),
    getCommands: (): Promise<SlashCommand[]> => ipcRenderer.invoke(Ipc.engineGetCommands),
    getExtensions: (): Promise<ExtensionInfo[]> => ipcRenderer.invoke(Ipc.engineGetExtensions),
    listExtensionPackages: (): Promise<ExtensionPackage[]> =>
      ipcRenderer.invoke(Ipc.engineListExtensionPackages),
    installExtensionPackage: (source: string): Promise<ExtensionPackage[]> =>
      ipcRenderer.invoke(Ipc.engineInstallExtensionPackage, { source }),
    removeExtensionPackage: (source: string): Promise<ExtensionPackage[]> =>
      ipcRenderer.invoke(Ipc.engineRemoveExtensionPackage, { source }),
    listMarketPackages: (query?: import("@shared/types").MarketPackageQuery): Promise<import("@shared/types").MarketPackagePage> =>
      ipcRenderer.invoke(Ipc.engineListMarketPackages, query),
    listMcpServers: (): Promise<McpServerStatus[]> => ipcRenderer.invoke(Ipc.engineListMcpServers),
    saveMcpServers: (configs: McpServerConfig[]): Promise<McpServerStatus[]> => ipcRenderer.invoke(Ipc.engineSaveMcpServers, { configs }),
    listSkills: (): Promise<SkillInfo[]> => ipcRenderer.invoke(Ipc.engineListSkills),
    createSkill: (draft: SkillDraft): Promise<SkillInfo[]> => ipcRenderer.invoke(Ipc.engineCreateSkill, draft),
    importSkill: (): Promise<SkillInfo[] | null> => ipcRenderer.invoke(Ipc.engineImportSkill),
    removeSkill: (name: string): Promise<SkillInfo[]> => ipcRenderer.invoke(Ipc.engineRemoveSkill, { name }),
    getSubagents: (): Promise<SubagentInfo[]> => ipcRenderer.invoke(Ipc.engineGetSubagents),
    getSubagentMessages: (subagentId: string): Promise<ChatMessage[]> =>
      ipcRenderer.invoke(Ipc.engineGetSubagentMessages, { subagentId }),
    /** A retry's file checkpoint, so the dialog can offer to unwind the workspace too. */
    getCheckpoint: (conversationId: string): Promise<{ paths: string[]; createdAt: number } | null> =>
      ipcRenderer.invoke(Ipc.engineGetCheckpoint, { conversationId }),
    restoreCheckpoint: (
      conversationId: string,
    ): Promise<{ restored: number; removed: number; skipped: number }> =>
      ipcRenderer.invoke(Ipc.engineRestoreCheckpoint, { conversationId }),
    respondPermission: (payload: {
      id: string;
      confirmed?: boolean;
      value?: string;
      cancelled?: boolean;
      /** Answers for a `questions` prompt, positionally matching its question list. */
      answers?: Array<string | null>;
    }): Promise<void> => ipcRenderer.invoke(Ipc.enginePermissionRespond, payload),
    newSession: (): Promise<void> => ipcRenderer.invoke(Ipc.engineNewSession),
    getState: (conversationId?: string): Promise<EngineSessionState> =>
      ipcRenderer.invoke(Ipc.engineGetState, { conversationId }),
    getRunning: (): Promise<string[]> => ipcRenderer.invoke(Ipc.engineGetRunning),
    getModels: (): Promise<FastVibeModel[]> => ipcRenderer.invoke(Ipc.engineGetModels),
    setModel: (provider: string, modelId: string, conversationId?: string): Promise<EngineSessionState> =>
      ipcRenderer.invoke(Ipc.engineSetModel, { provider, modelId, conversationId }),
    setThinking: (level: string, conversationId?: string): Promise<EngineSessionState> =>
      ipcRenderer.invoke(Ipc.engineSetThinking, { level, conversationId }),
    setInterruptMode: (mode: "immediate" | "wait"): Promise<EngineSessionState> =>
      ipcRenderer.invoke(Ipc.engineSetInterrupt, { mode }),
    setAutoCompaction: (enabled: boolean): Promise<EngineSessionState> =>
      ipcRenderer.invoke(Ipc.engineSetAutoCompact, { enabled }),
    branch: (entryId: string, conversationId?: string): Promise<ChatMessage[]> =>
      ipcRenderer.invoke(Ipc.engineBranch, { entryId, conversationId }),
    getMessages: (conversationId?: string): Promise<ChatMessage[]> =>
      ipcRenderer.invoke(Ipc.engineGetMessages, { conversationId }),
    /**
     * Transcript plus the turn in flight, taken at one instant. What a client reads to
     * rebuild a conversation exactly — including one whose run is still going.
     */
    getSnapshot: (conversationId?: string): Promise<ConversationSnapshot> =>
      ipcRenderer.invoke(Ipc.engineGetSnapshot, { conversationId }),
    getStats: (conversationId?: string): Promise<SessionStats> =>
      ipcRenderer.invoke(Ipc.engineGetStats, { conversationId }),
    setSteeringMode: (mode: "all" | "one-at-a-time"): Promise<EngineSessionState> =>
      ipcRenderer.invoke(Ipc.engineSetSteering, { mode }),
    setFollowUpMode: (mode: "all" | "one-at-a-time"): Promise<EngineSessionState> =>
      ipcRenderer.invoke(Ipc.engineSetFollowUp, { mode }),
    exportHtml: (): Promise<string | undefined> => ipcRenderer.invoke(Ipc.engineExportHtml),
    /** 设置 → 导入: the other agents on this machine and their sessions. */
    importSources: (): Promise<ImportSourceStatus[]> => ipcRenderer.invoke(Ipc.engineImportSources),
    importCandidates: (source: ImportSourceId): Promise<ImportCandidate[]> =>
      ipcRenderer.invoke(Ipc.engineImportCandidates, { source }),
    importSessions: (source: ImportSourceId, ids: string[]): Promise<ImportRunResult> =>
      ipcRenderer.invoke(Ipc.engineImportSessions, { source, ids }),
    promptConversation: (id: string, message: string, images?: PromptImage[]): Promise<void> =>
      ipcRenderer.invoke(Ipc.enginePromptConversation, { id, message, images }),
    getConversationMessages: (id: string): Promise<ChatMessage[]> =>
      ipcRenderer.invoke(Ipc.engineGetConversationMessages, { id }),
    onEvent: (listener: (event: EngineEvent) => void): (() => void) => {
      const handler = (_event: unknown, payload: EngineEvent): void => listener(payload);
      ipcRenderer.on(Ipc.event, handler);
      return () => ipcRenderer.removeListener(Ipc.event, handler);
    },
    onStatus: (listener: (status: EngineStatus) => void): (() => void) => {
      const handler = (_event: unknown, payload: EngineStatus): void => listener(payload);
      ipcRenderer.on(Ipc.status, handler);
      return () => ipcRenderer.removeListener(Ipc.status, handler);
    },
    onConversationReady: (listener: (payload: ConversationReadyEvent) => void): (() => void) => {
      const handler = (_event: unknown, payload: ConversationReadyEvent): void => listener(payload);
      ipcRenderer.on(Ipc.conversationReady, handler);
      return () => ipcRenderer.removeListener(Ipc.conversationReady, handler);
    },
  },
  providers: {
    list: (): Promise<ProviderConfig[]> => ipcRenderer.invoke(Ipc.providersList),
    native: (): Promise<NativeProviderConfig[]> => ipcRenderer.invoke(Ipc.providersNative),
    addNative: (payload: {
      id: string;
      apiKey: string;
      models: ProviderModel[];
    }): Promise<ProviderConfig[]> => ipcRenderer.invoke(Ipc.providersAddNative, payload),
    fetch: (baseUrl: string, apiKey: string, api?: string): Promise<ProviderModel[]> =>
      ipcRenderer.invoke(Ipc.providersFetch, { baseUrl, apiKey, api }),
    saveFastVibe: (apiKey: string, models: ProviderModel[]): Promise<ProviderConfig[]> =>
      ipcRenderer.invoke(Ipc.providersSaveFastVibe, { apiKey, models }),
    add: (payload: {
      name: string;
      baseUrl: string;
      apiKey: string;
      api?: import("@shared/types").ProviderApi;
      models: ProviderModel[];
    }): Promise<ProviderConfig[]> => ipcRenderer.invoke(Ipc.providersAdd, payload),
    update: (payload: {
      id: string;
      name?: string;
      baseUrl?: string;
      api?: import("@shared/types").ProviderApi;
      enabled?: boolean;
      apiKey?: string;
      models?: ProviderModel[];
    }): Promise<ProviderConfig[]> => ipcRenderer.invoke(Ipc.providersUpdate, payload),
    remove: (id: string): Promise<ProviderConfig[]> => ipcRenderer.invoke(Ipc.providersRemove, { id }),
    refresh: (id: string): Promise<ProviderModel[]> =>
      ipcRenderer.invoke(Ipc.providersRefresh, { id }),
    scanCcSwitch: (): Promise<CcSwitchScan> =>
      ipcRenderer.invoke(Ipc.providersCcSwitchScan),
    importCcSwitch: (ids: string[]): Promise<ProviderConfig[]> =>
      ipcRenderer.invoke(Ipc.providersCcSwitchImport, { ids }),
    /**
     * Subscription (OAuth) login. Resolves only once the whole flow is over, so the
     * caller can await it and still receive `onOAuthEvent` updates meanwhile.
     */
    oauthLogin: (id: string): Promise<OAuthLoginResult> =>
      ipcRenderer.invoke(Ipc.providersOAuthLogin, { id }),
    oauthAnswer: (payload: { id: string; promptId: string; value: string }): Promise<void> =>
      ipcRenderer.invoke(Ipc.providersOAuthAnswer, payload),
    oauthCancel: (id: string): Promise<void> => ipcRenderer.invoke(Ipc.providersOAuthCancel, { id }),
    logout: (id: string): Promise<ProviderConfig[]> => ipcRenderer.invoke(Ipc.providersLogout, { id }),
    onOAuthEvent: (listener: (payload: OAuthEventPayload) => void): (() => void) => {
      const handler = (_event: unknown, payload: OAuthEventPayload): void => listener(payload);
      ipcRenderer.on(Ipc.providersOAuthEvent, handler);
      return () => ipcRenderer.removeListener(Ipc.providersOAuthEvent, handler);
    },
  },
  conversations: {
    list: (): Promise<WorkspaceSnapshot> => ipcRenderer.invoke(Ipc.conversationsList),
    create: (project?: string): Promise<ConversationOpenResult> =>
      ipcRenderer.invoke(Ipc.conversationsCreate, { project }),
    open: (id: string): Promise<ConversationOpenResult> =>
      ipcRenderer.invoke(Ipc.conversationsOpen, { id }),
    rename: (id: string, title: string): Promise<WorkspaceSnapshot> =>
      ipcRenderer.invoke(Ipc.conversationsRename, { id, title }),
    delete: (id: string): Promise<ConversationDeleteResult> =>
      ipcRenderer.invoke(Ipc.conversationsDelete, { id }),
    recordPrompt: (id: string, text: string): Promise<WorkspaceSnapshot> =>
      ipcRenderer.invoke(Ipc.conversationsRecordPrompt, { id, text }),
    setProject: (id: string, project: string | null): Promise<WorkspaceSnapshot> =>
      ipcRenderer.invoke(Ipc.conversationsSetProject, { id, project }),
    createSide: (payload: { project?: string; parentId?: string; title?: string }): Promise<ConversationOpenResult> =>
      ipcRenderer.invoke(Ipc.conversationsCreateSide, payload),
    search: (query: string): Promise<ConversationSearchHit[]> =>
      ipcRenderer.invoke(Ipc.conversationsSearch, { query }),
  },
  projects: {
    add: (): Promise<ProjectAddResult | null> => ipcRenderer.invoke(Ipc.projectsAdd),
    rename: (cwd: string, name: string): Promise<WorkspaceSnapshot> =>
      ipcRenderer.invoke(Ipc.projectsRename, { cwd, name }),
    remove: (cwd: string): Promise<ConversationDeleteResult> =>
      ipcRenderer.invoke(Ipc.projectsRemove, { cwd }),
    /** Persist a drag-reordered project list; the new order is the sidebar order. */
    reorder: (cwds: string[]): Promise<WorkspaceSnapshot> =>
      ipcRenderer.invoke(Ipc.projectsReorder, { cwds }),
  },
  workspace: {
    pick: (): Promise<{ cwd: string; status: EngineStatus } | null> =>
      ipcRenderer.invoke(Ipc.workspacePick),
    reveal: (cwd: string): Promise<void> => ipcRenderer.invoke(Ipc.workspaceReveal, { cwd }),
    preview: (path: string): Promise<FilePreview> => ipcRenderer.invoke(Ipc.workspacePreview, { path }),
    fileIcons: (): Promise<FileIconMapping> => ipcRenderer.invoke(Ipc.workspaceFileIcons),
    readDir: (path: string): Promise<DirEntry[]> => ipcRenderer.invoke(Ipc.workspaceReadDir, { path }),
    gitStatus: (cwd: string): Promise<GitStatus> => ipcRenderer.invoke(Ipc.workspaceGitStatus, { cwd }),
    openTerminal: (cwd: string): Promise<void> => ipcRenderer.invoke(Ipc.workspaceOpenTerminal, { cwd }),
    gitBranches: (cwd: string): Promise<GitBranch[]> => ipcRenderer.invoke(Ipc.workspaceGitBranches, { cwd }),
    gitCheckout: (cwd: string, branch: string): Promise<GitStatus> => ipcRenderer.invoke(Ipc.workspaceGitCheckout, { cwd, branch }),
    gitCreateBranch: (cwd: string, branch: string): Promise<GitStatus> => ipcRenderer.invoke(Ipc.workspaceGitCreateBranch, { cwd, branch }),
    gitStage: (cwd: string, paths?: string[], all?: boolean): Promise<GitStatus> => ipcRenderer.invoke(Ipc.workspaceGitStage, { cwd, paths, all }),
    gitCommit: (cwd: string, message: string): Promise<GitStatus> => ipcRenderer.invoke(Ipc.workspaceGitCommit, { cwd, message }),
    gitDiff: (cwd: string, path?: string, source?: GitDiffSource): Promise<string> =>
      ipcRenderer.invoke(Ipc.workspaceGitDiff, { cwd, path, source }),
    gitUnstage: (cwd: string, paths: string[]): Promise<GitStatus> =>
      ipcRenderer.invoke(Ipc.workspaceGitUnstage, { cwd, paths }),
    gitDiscard: (cwd: string, paths: string[]): Promise<GitStatus> =>
      ipcRenderer.invoke(Ipc.workspaceGitDiscard, { cwd, paths }),
    gitPull: (cwd: string): Promise<GitStatus> => ipcRenderer.invoke(Ipc.workspaceGitPull, { cwd }),
    gitPush: (cwd: string): Promise<GitStatus> => ipcRenderer.invoke(Ipc.workspaceGitPush, { cwd }),
    terminalStart: (cwd?: string, size?: { cols?: number; rows?: number }): Promise<TerminalSessionInfo> =>
      ipcRenderer.invoke(Ipc.workspaceTerminalStart, { cwd, ...size }),
    terminalWrite: (id: string, data: string): Promise<void> => ipcRenderer.invoke(Ipc.workspaceTerminalWrite, { id, data }),
    terminalResize: (id: string, cols: number, rows: number): Promise<void> =>
      ipcRenderer.invoke(Ipc.workspaceTerminalResize, { id, cols, rows }),
    terminalKill: (id: string): Promise<void> => ipcRenderer.invoke(Ipc.workspaceTerminalKill, { id }),
    onTerminalData: (listener: (event: TerminalDataEvent) => void): (() => void) => {
      const handler = (_event: unknown, payload: TerminalDataEvent): void => listener(payload);
      ipcRenderer.on(Ipc.workspaceTerminalData, handler);
      return () => ipcRenderer.removeListener(Ipc.workspaceTerminalData, handler);
    },
  },
  app: {
    getInfo: (): Promise<import("@shared/ipc").AppInfo> => ipcRenderer.invoke(Ipc.appGetInfo),
    /**
     * Read before paint, so the shell can decide whether it draws a title bar
     * (`lib/platform.ts`) instead of guessing from the user agent.
     */
    platform: process.platform,
    log: (payload: import("@shared/ipc").AppLogPayload): void => {
      ipcRenderer.send(Ipc.appLog, payload);
    },
    exportLogs: (): Promise<string | undefined> => ipcRenderer.invoke(Ipc.appExportLogs),
    updateModelsDev: (): Promise<import("@shared/ipc").AppModelsDevInfo> =>
      ipcRenderer.invoke(Ipc.modelsDevUpdate),
    newWindow: (): Promise<void> => ipcRenderer.invoke(Ipc.windowNew),
  },
  /** The hand-drawn title bar's window controls (Windows / Linux only). */
  window: {
    minimize: (): Promise<void> => ipcRenderer.invoke(Ipc.windowMinimize),
    toggleMaximize: (): Promise<void> => ipcRenderer.invoke(Ipc.windowToggleMaximize),
    close: (): Promise<void> => ipcRenderer.invoke(Ipc.windowClose),
    isMaximized: (): Promise<boolean> => ipcRenderer.invoke(Ipc.windowIsMaximized),
    onState: (listener: (state: WindowChromeState) => void): (() => void) => {
      const handler = (_event: unknown, payload: WindowChromeState): void => listener(payload);
      ipcRenderer.on(Ipc.windowState, handler);
      return () => ipcRenderer.removeListener(Ipc.windowState, handler);
    },
  },
  updater: {
    getState: (): Promise<AppUpdateState> => ipcRenderer.invoke(Ipc.updateGetState),
    check: (): Promise<AppUpdateState> => ipcRenderer.invoke(Ipc.updateCheck),
    download: (): Promise<AppUpdateState> => ipcRenderer.invoke(Ipc.updateDownload),
    install: (): Promise<AppUpdateState> => ipcRenderer.invoke(Ipc.updateInstall),
    onState: (listener: (state: AppUpdateState) => void): (() => void) => {
      const handler = (_event: unknown, payload: AppUpdateState): void => listener(payload);
      ipcRenderer.on(Ipc.updateState, handler);
      return () => ipcRenderer.removeListener(Ipc.updateState, handler);
    },
  },
  settings: {
    /**
     * Snapshot captured in the preload world before the page runs, so the
     * renderer store can apply the theme on first paint without waiting on IPC.
     */
    initial: (ipcRenderer.sendSync(Ipc.settingsGetSync) ?? {}) as Record<string, unknown>,
    load: (): Promise<Record<string, unknown>> => ipcRenderer.invoke(Ipc.settingsGet),
    save: (settings: Record<string, unknown>): Promise<void> => ipcRenderer.invoke(Ipc.settingsSet, settings),
    clear: (): Promise<void> => ipcRenderer.invoke(Ipc.settingsClear),
    /**
     * A write made by *another* window. Each window holds its own copy of the
     * preferences, so without this two open windows drifted apart and overwrote each
     * other's changes with their stale copy on the next save.
     */
    onChanged: (listener: (settings: Record<string, unknown>) => void): (() => void) => {
      const handler = (_event: unknown, settings: Record<string, unknown>): void => listener(settings);
      ipcRenderer.on(Ipc.settingsChanged, handler);
      return () => ipcRenderer.removeListener(Ipc.settingsChanged, handler);
    },
  },
  /** 远程访问：把这台机器上的 agent 通过网页开放给其他设备。 */
  remote: {
    getState: (): Promise<import("@shared/ipc").RemoteServerState> => ipcRenderer.invoke(Ipc.remoteGetState),
    setPassword: (password: string): Promise<import("@shared/ipc").RemoteServerState> =>
      ipcRenderer.invoke(Ipc.remoteSetPassword, { password }),
    clearPassword: (): Promise<import("@shared/ipc").RemoteServerState> => ipcRenderer.invoke(Ipc.remoteClearPassword),
    start: (port?: number): Promise<import("@shared/ipc").RemoteServerState> =>
      ipcRenderer.invoke(Ipc.remoteStart, { port }),
    stop: (): Promise<import("@shared/ipc").RemoteServerState> => ipcRenderer.invoke(Ipc.remoteStop),
    listDevices: (): Promise<import("@shared/ipc").RemoteDeviceInfo[]> => ipcRenderer.invoke(Ipc.remoteListDevices),
    revokeDevice: (id: string): Promise<import("@shared/ipc").RemoteDeviceInfo[]> =>
      ipcRenderer.invoke(Ipc.remoteRevokeDevice, { id }),
    onState: (listener: (state: import("@shared/ipc").RemoteServerState) => void): (() => void) => {
      const handler = (_event: unknown, payload: import("@shared/ipc").RemoteServerState): void => listener(payload);
      ipcRenderer.on(Ipc.remoteState, handler);
      return () => ipcRenderer.removeListener(Ipc.remoteState, handler);
    },
  },
  stats: {
    usage: (range: UsageRange): Promise<UsageStats> => ipcRenderer.invoke(Ipc.statsUsage, { range }),
  },
  browser: {
    listProfiles: (): Promise<BrowserProfileInfo[]> => ipcRenderer.invoke(Ipc.browserListProfiles),
    importProfile: (profile: BrowserProfileInfo): Promise<BrowserImportResult> => ipcRenderer.invoke(Ipc.browserImportProfile, { profile }),
    onRequest: (listener: (payload: { id: string; request: BrowserRequest }) => void): (() => void) => {
      const handler = (_event: unknown, payload: { id: string; request: BrowserRequest }): void => listener(payload);
      ipcRenderer.on(Ipc.browserRequest, handler);
      return () => ipcRenderer.removeListener(Ipc.browserRequest, handler);
    },
    respond: (payload: { id: string; ok: boolean; result?: unknown; error?: string }): void => {
      ipcRenderer.send(Ipc.browserResponse, payload);
    },
  },
};

export type FastVibeApi = typeof api;

contextBridge.exposeInMainWorld("fastvibe", api);
