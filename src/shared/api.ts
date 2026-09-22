import { Ipc } from "@shared/ipc";
import type {
  ChatMessage,
  TranscriptTail,
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
  OpenAIAccountQuota,
  GatewayBalanceResult,
  GatewayKind,
  CcSwitchScan,
  SlashCommand,
  FilePreview,
  SubagentConfig,
  SubagentDraft,
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
  ChatAttachment,
  ConversationQueueState,
  QueueBehavior,
  QueuedPromptPreview,
} from "@shared/types";
import type { RemoteHostProfile, RemoteHostConnectionState } from "@shared/remote-host";
import type {
  AppUpdateState,
  GitBranch,
  GitDiffSource,
  GitStatus,
  GitWorktree,
  TerminalDataEvent,
  WindowChromeState,
  TerminalSessionInfo,
} from "@shared/ipc";

/**
 * `window.fastvibe`, defined once for every transport that can carry it.
 *
 * The desktop preload reaches Main over Electron IPC; the web client reaches the same
 * Main over a WebSocket. Both hand the renderer an object of exactly this shape, and it
 * is built here rather than twice, because a method that exists on one side and not the
 * other is a feature that silently works on your desktop and is missing on your phone —
 * the failure you can only find while away from the machine that could fix it.
 *
 * Nothing Electron-specific belongs here. The two values no transport can express as a
 * call — the settings snapshot read before first paint, and the host platform — are
 * handed in instead.
 */

export type ApiTransport = {
  /**
   * Call one method and await its reply.
   *
   * `any` deliberately: every method below states its own return type, and that is what
   * callers are checked against. Threading a generic through would buy nothing but a
   * hundred type arguments each repeating its channel's name.
   */
  invoke: (channel: string, payload?: unknown) => Promise<any>;
  /** Fire and forget — no reply is expected, and none is waited for. */
  send: (channel: string, payload?: unknown) => void;
  /** Listen to a pushed channel. The returned function detaches the listener. */
  subscribe: (channel: string, listener: (payload: any) => void) => () => void;
  /**
   * Preferences as they were before the page ran, so the first paint already has the
   * right theme instead of flashing the default one. Electron reads it synchronously in
   * the preload world; a remote client takes it from its connection handshake.
   */
  settingsInitial: Record<string, unknown>;
  /** The host's `process.platform`, which decides whether the shell draws its own title bar. */
  platform: string;
  /**
   * Whether this bridge is a browser talking to a remote host, rather than the host's
   * own window.
   *
   * `platform` alone cannot answer that: it reports the machine Main runs on, so a
   * client connected to a Mac reads `darwin` and lays itself out for traffic lights
   * that exist in a window 300 miles away. What the layout actually needs to know is
   * whether there is any window chrome here at all, and only the transport knows.
   */
  remote: boolean;
};

/** Build the bridge object for one transport. */
export function createFastVibeApi(t: ApiTransport) {
  const api = {
    engine: {
      getStatus: (): Promise<EngineStatus> => t.invoke(Ipc.engineGetStatus),
      start: (cwd?: string): Promise<EngineStatus> => t.invoke(Ipc.engineStart, { cwd }),
      stop: (): Promise<EngineStatus> => t.invoke(Ipc.engineStop),
      prompt: (
        message: string,
        options?: {
          streamingBehavior?: "steer" | "followUp";
          images?: PromptImage[];
          /** Omitted by single-window callers, which mean "the chat on screen". */
          conversationId?: string;
        },
      ): Promise<void> => t.invoke(Ipc.enginePrompt, { message, ...options }),
      steer: (message: string, images?: PromptImage[], conversationId?: string): Promise<void> =>
        t.invoke(Ipc.engineSteer, { message, images, conversationId }),
      followUp: (message: string, images?: PromptImage[], conversationId?: string): Promise<void> =>
        t.invoke(Ipc.engineFollowUp, { message, images, conversationId }),
      /** Stop one chat's run. Called with no id, the engine falls back to its active chat. */
      abort: (conversationId?: string): Promise<void> => t.invoke(Ipc.engineAbort, { conversationId }),
      /** Stop one delegated run, leaving its parent chat's own run alone. */
      abortSubagent: (subagentId: string, conversationId?: string): Promise<void> =>
        t.invoke(Ipc.engineAbortSubagent, { subagentId, conversationId }),
      /** Resume the interrupted turn from the transcript, with no new user message. */
      continue: (conversationId?: string): Promise<void> =>
        t.invoke(Ipc.engineContinue, { conversationId }),
      clearQueue: (conversationId?: string): Promise<{ steering: string[]; followUp: string[] }> =>
        t.invoke(Ipc.engineClearQueue, { conversationId }),
      replaceSteering: (
        items: Array<{ text: string; images?: PromptImage[] }>,
        conversationId?: string,
      ): Promise<void> => t.invoke(Ipc.engineReplaceSteering, { items, conversationId }),
      queueAdd: (payload: {
        conversationId: string;
        text: string;
        message: string;
        behavior: QueueBehavior;
        attachments?: ChatAttachment[];
        images?: PromptImage[];
        preview?: QueuedPromptPreview;
      }): Promise<ConversationQueueState> => t.invoke(Ipc.engineQueueAdd, payload),
      queueCancel: (id: string): Promise<ConversationQueueState | null> =>
        t.invoke(Ipc.engineQueueCancel, { id }),
      queueRecall: (id: string): Promise<ConversationQueueState | null> =>
        t.invoke(Ipc.engineQueueRecall, { id }),
      queueSendNow: (id: string): Promise<ConversationQueueState | null> =>
        t.invoke(Ipc.engineQueueSendNow, { id }),
      queueReorder: (conversationId: string, ids: string[]): Promise<ConversationQueueState> =>
        t.invoke(Ipc.engineQueueReorder, { conversationId, ids }),
      queueResume: (conversationId: string): Promise<ConversationQueueState> =>
        t.invoke(Ipc.engineQueueResume, { conversationId }),
      compact: (customInstructions?: string, conversationId?: string): Promise<EngineSessionState> =>
        t.invoke(Ipc.engineCompact, { customInstructions, conversationId }),
      getCommands: (conversationId?: string): Promise<SlashCommand[]> =>
        t.invoke(Ipc.engineGetCommands, { conversationId }),
      getExtensions: (): Promise<ExtensionInfo[]> => t.invoke(Ipc.engineGetExtensions),
      listExtensionPackages: (): Promise<ExtensionPackage[]> =>
        t.invoke(Ipc.engineListExtensionPackages),
      installExtensionPackage: (source: string): Promise<ExtensionPackage[]> =>
        t.invoke(Ipc.engineInstallExtensionPackage, { source }),
      removeExtensionPackage: (source: string): Promise<ExtensionPackage[]> =>
        t.invoke(Ipc.engineRemoveExtensionPackage, { source }),
      listMarketPackages: (query?: import("@shared/types").MarketPackageQuery): Promise<import("@shared/types").MarketPackagePage> =>
        t.invoke(Ipc.engineListMarketPackages, query),
      listMcpServers: (): Promise<McpServerStatus[]> => t.invoke(Ipc.engineListMcpServers),
      saveMcpServers: (configs: McpServerConfig[]): Promise<McpServerStatus[]> => t.invoke(Ipc.engineSaveMcpServers, { configs }),
      listSkills: (): Promise<SkillInfo[]> => t.invoke(Ipc.engineListSkills),
      createSkill: (draft: SkillDraft): Promise<SkillInfo[]> => t.invoke(Ipc.engineCreateSkill, draft),
      importSkill: (): Promise<SkillInfo[] | null> => t.invoke(Ipc.engineImportSkill),
      removeSkill: (name: string): Promise<SkillInfo[]> => t.invoke(Ipc.engineRemoveSkill, { name }),
      getSubagents: (conversationId?: string): Promise<SubagentInfo[]> =>
        t.invoke(Ipc.engineGetSubagents, { conversationId }),
      listAgentConfigs: (): Promise<SubagentConfig[]> => t.invoke(Ipc.engineListAgentConfigs),
      saveAgentConfig: (draft: SubagentDraft): Promise<SubagentConfig[]> =>
        t.invoke(Ipc.engineSaveAgentConfig, draft),
      removeAgentConfig: (id: string): Promise<SubagentConfig[]> =>
        t.invoke(Ipc.engineRemoveAgentConfig, { id }),
      getSubagentMessages: (subagentId: string, conversationId?: string): Promise<ChatMessage[]> =>
        t.invoke(Ipc.engineGetSubagentMessages, { subagentId, conversationId }),
      /** A retry's file checkpoint, so the dialog can offer to unwind the workspace too. */
      getCheckpoint: (conversationId: string): Promise<{ paths: string[]; createdAt: number } | null> =>
        t.invoke(Ipc.engineGetCheckpoint, { conversationId }),
      restoreCheckpoint: (
        conversationId: string,
      ): Promise<{ restored: number; removed: number; skipped: number }> =>
        t.invoke(Ipc.engineRestoreCheckpoint, { conversationId }),
      respondPermission: (payload: {
        id: string;
        confirmed?: boolean;
        value?: string;
        cancelled?: boolean;
        /** Answers for a `questions` prompt, positionally matching its question list. */
        answers?: Array<string | null>;
        /** Plan review action and optional revision feedback. */
        planAction?: "approve" | "revise" | "ignore";
      }): Promise<void> => t.invoke(Ipc.enginePermissionRespond, payload),
      newSession: (): Promise<void> => t.invoke(Ipc.engineNewSession),
      getState: (conversationId?: string): Promise<EngineSessionState> =>
        t.invoke(Ipc.engineGetState, { conversationId }),
      getRunning: (): Promise<string[]> => t.invoke(Ipc.engineGetRunning),
      getModels: (conversationId?: string): Promise<FastVibeModel[]> =>
        t.invoke(Ipc.engineGetModels, { conversationId }),
      setModel: (provider: string, modelId: string, conversationId?: string): Promise<EngineSessionState> =>
        t.invoke(Ipc.engineSetModel, { provider, modelId, conversationId }),
      setThinking: (level: string, conversationId?: string): Promise<EngineSessionState> =>
        t.invoke(Ipc.engineSetThinking, { level, conversationId }),
      setInterruptMode: (mode: "immediate" | "wait", conversationId?: string): Promise<EngineSessionState> =>
        t.invoke(Ipc.engineSetInterrupt, { mode, conversationId }),
      setAutoCompaction: (enabled: boolean, conversationId?: string): Promise<EngineSessionState> =>
        t.invoke(Ipc.engineSetAutoCompact, { enabled, conversationId }),
      branch: (entryId: string, conversationId?: string): Promise<ChatMessage[]> =>
        t.invoke(Ipc.engineBranch, { entryId, conversationId }),
      fork: (entryId?: string, conversationId?: string): Promise<ConversationOpenResult> =>
        t.invoke(Ipc.engineFork, { entryId, conversationId }),
      getMessages: (conversationId?: string): Promise<ChatMessage[]> =>
        t.invoke(Ipc.engineGetMessages, { conversationId }),
      /**
       * The transcript from `anchorEntryId` onward. The reply says whether the anchor
       * was still on the branch (`tail`) or the whole transcript had to be sent
       * (`full`, after an edit/retry/fork rewound past it).
       */
      getMessagesSince: (anchorEntryId: string, conversationId?: string): Promise<TranscriptTail> =>
        t.invoke(Ipc.engineGetMessagesSince, { anchorEntryId, conversationId }),
      /**
       * Transcript plus the turn in flight, taken at one instant. What a client reads to
       * rebuild a conversation exactly — including one whose run is still going.
       */
      getSnapshot: (conversationId?: string): Promise<ConversationSnapshot> =>
        t.invoke(Ipc.engineGetSnapshot, { conversationId }),
      getStats: (conversationId?: string): Promise<SessionStats> =>
        t.invoke(Ipc.engineGetStats, { conversationId }),
      setSteeringMode: (mode: "all" | "one-at-a-time", conversationId?: string): Promise<EngineSessionState> =>
        t.invoke(Ipc.engineSetSteering, { mode, conversationId }),
      setFollowUpMode: (mode: "all" | "one-at-a-time", conversationId?: string): Promise<EngineSessionState> =>
        t.invoke(Ipc.engineSetFollowUp, { mode, conversationId }),
      exportHtml: (): Promise<string | undefined> => t.invoke(Ipc.engineExportHtml),
      /** 设置 → 导入: the other agents on this machine and their sessions. */
      importSources: (): Promise<ImportSourceStatus[]> => t.invoke(Ipc.engineImportSources),
      importCandidates: (source: ImportSourceId): Promise<ImportCandidate[]> =>
        t.invoke(Ipc.engineImportCandidates, { source }),
      importSessions: (source: ImportSourceId, ids: string[]): Promise<ImportRunResult> =>
        t.invoke(Ipc.engineImportSessions, { source, ids }),
      promptConversation: (id: string, message: string, images?: PromptImage[]): Promise<void> =>
        t.invoke(Ipc.enginePromptConversation, { id, message, images }),
      getConversationMessages: (id: string): Promise<ChatMessage[]> =>
        t.invoke(Ipc.engineGetConversationMessages, { id }),
      onEvent: (listener: (event: EngineEvent) => void): (() => void) => t.subscribe(Ipc.event, listener),
      onStatus: (listener: (status: EngineStatus) => void): (() => void) => t.subscribe(Ipc.status, listener),
      onConversationReady: (listener: (payload: ConversationReadyEvent) => void): (() => void) => t.subscribe(Ipc.conversationReady, listener),
    },
    providers: {
      list: (): Promise<ProviderConfig[]> => t.invoke(Ipc.providersList),
      native: (): Promise<NativeProviderConfig[]> => t.invoke(Ipc.providersNative),
      addNative: (payload: {
        id: string;
        apiKey: string;
        models: ProviderModel[];
      }): Promise<ProviderConfig[]> => t.invoke(Ipc.providersAddNative, payload),
      fetch: (baseUrl: string, apiKey: string, api?: string): Promise<ProviderModel[]> =>
        t.invoke(Ipc.providersFetch, { baseUrl, apiKey, api }),
      saveFastVibe: (apiKey: string, models: ProviderModel[]): Promise<ProviderConfig[]> =>
        t.invoke(Ipc.providersSaveFastVibe, { apiKey, models }),
      add: (payload: {
        name: string;
        baseUrl: string;
        apiKey: string;
        api?: import("@shared/types").ProviderApi;
        /** What `probeGateway` reported, so the new entry starts identified. */
        gateway?: GatewayKind;
        models: ProviderModel[];
      }): Promise<ProviderConfig[]> => t.invoke(Ipc.providersAdd, payload),
      update: (payload: {
        id: string;
        name?: string;
        baseUrl?: string;
        api?: import("@shared/types").ProviderApi;
        enabled?: boolean;
        apiKey?: string;
        models?: ProviderModel[];
      }): Promise<ProviderConfig[]> => t.invoke(Ipc.providersUpdate, payload),
      remove: (id: string): Promise<ProviderConfig[]> => t.invoke(Ipc.providersRemove, { id }),
      refresh: (id: string): Promise<ProviderModel[]> =>
        t.invoke(Ipc.providersRefresh, { id }),
      quota: (id: "openai" | "openai-codex", force = false): Promise<OpenAIAccountQuota> =>
        t.invoke(Ipc.providersQuota, { id, force }),
      /**
       * Which relay software answers at a Base URL. Undefined means "not identified",
       * which is the ordinary answer for any OpenAI-compatible gateway.
       */
      probeGateway: (baseUrl: string): Promise<GatewayKind | undefined> =>
        t.invoke(Ipc.providersProbeGateway, { baseUrl }),
      /** The 余额 a custom provider's own panel reports for the stored key. */
      gatewayBalance: (id: string, force = false): Promise<GatewayBalanceResult> =>
        t.invoke(Ipc.providersGatewayBalance, { id, force }),
      /**
       * The panel credential a new-api balance needs. Write-only: an empty token clears
       * it, and nothing ever reads it back across this bridge.
       */
      setGatewayCredentials: (payload: { id: string; accessToken: string; userId: string }): Promise<void> =>
        t.invoke(Ipc.providersGatewayCredentials, payload),
      /** Probe a stored provider's endpoint, remember what it is, and report the verdict. */
      identifyGateway: (id: string): Promise<GatewayKind | undefined> =>
        t.invoke(Ipc.providersIdentifyGateway, { id }),
      scanCcSwitch: (): Promise<CcSwitchScan> =>
        t.invoke(Ipc.providersCcSwitchScan),
      importCcSwitch: (ids: string[]): Promise<ProviderConfig[]> =>
        t.invoke(Ipc.providersCcSwitchImport, { ids }),
      /**
       * Subscription (OAuth) login. Resolves only once the whole flow is over, so the
       * caller can await it and still receive `onOAuthEvent` updates meanwhile.
       */
      oauthLogin: (id: string): Promise<OAuthLoginResult> =>
        t.invoke(Ipc.providersOAuthLogin, { id }),
      oauthAnswer: (payload: { id: string; promptId: string; value: string }): Promise<void> =>
        t.invoke(Ipc.providersOAuthAnswer, payload),
      oauthCancel: (id: string): Promise<void> => t.invoke(Ipc.providersOAuthCancel, { id }),
      logout: (id: string): Promise<ProviderConfig[]> => t.invoke(Ipc.providersLogout, { id }),
      onOAuthEvent: (listener: (payload: OAuthEventPayload) => void): (() => void) => t.subscribe(Ipc.providersOAuthEvent, listener),
    },
    conversations: {
      list: (): Promise<WorkspaceSnapshot> => t.invoke(Ipc.conversationsList),
      create: (project?: string): Promise<ConversationOpenResult> =>
        t.invoke(Ipc.conversationsCreate, { project }),
      open: (id: string): Promise<ConversationOpenResult> =>
        t.invoke(Ipc.conversationsOpen, { id }),
      rename: (id: string, title: string): Promise<WorkspaceSnapshot> =>
        t.invoke(Ipc.conversationsRename, { id, title }),
      delete: (id: string): Promise<ConversationDeleteResult> =>
        t.invoke(Ipc.conversationsDelete, { id }),
      recordPrompt: (id: string, text: string): Promise<WorkspaceSnapshot> =>
        t.invoke(Ipc.conversationsRecordPrompt, { id, text }),
      restorePrompt: (payload: { id: string; expectedTitle: string; expectedPreview?: string; title: string; preview?: string }): Promise<WorkspaceSnapshot> =>
        t.invoke(Ipc.conversationsRestorePrompt, payload),
      setProject: (id: string, project: string | null): Promise<WorkspaceSnapshot> =>
        t.invoke(Ipc.conversationsSetProject, { id, project }),
      createWorktree: (id: string, options?: { path?: string; branch?: string; label?: string }): Promise<WorkspaceSnapshot> =>
        t.invoke(Ipc.conversationsCreateWorktree, { id, ...options }),
      bindWorktree: (id: string, path: string): Promise<WorkspaceSnapshot> =>
        t.invoke(Ipc.conversationsBindWorktree, { id, path }),
      unbindWorktree: (id: string, options?: { remove?: boolean }): Promise<WorkspaceSnapshot> =>
        t.invoke(Ipc.conversationsUnbindWorktree, { id, ...options }),
      listWorktrees: (id: string): Promise<GitWorktree[]> =>
        t.invoke(Ipc.conversationsListWorktrees, { id }),
      createSide: (payload: { project?: string; parentId?: string; title?: string }): Promise<ConversationOpenResult> =>
        t.invoke(Ipc.conversationsCreateSide, payload),
      search: (query: string): Promise<ConversationSearchHit[]> =>
        t.invoke(Ipc.conversationsSearch, { query }),
      /**
       * The catalog changed somewhere — another window, or a phone over remote access.
       *
       * Sent to every client including the one whose call caused it, which is the
       * simpler contract and costs nothing: the originator already holds the same
       * snapshot as the call's own result, so applying it again changes nothing.
       */
      onChanged: (listener: (snapshot: WorkspaceSnapshot) => void): (() => void) =>
        t.subscribe(Ipc.workspaceChanged, listener),
    },
    projects: {
      add: (): Promise<ProjectAddResult | null> => t.invoke(Ipc.projectsAdd),
      addRemote: (
        cwd: string,
        options?: { hostId?: string; serverInstanceId?: string; workspaceId?: string; name?: string },
      ): Promise<ProjectAddResult> => t.invoke(Ipc.projectsAddRemote, { cwd, ...options }),
      rename: (cwd: string, name: string): Promise<WorkspaceSnapshot> =>
        t.invoke(Ipc.projectsRename, { cwd, name }),
      remove: (cwd: string): Promise<ConversationDeleteResult> =>
        t.invoke(Ipc.projectsRemove, { cwd }),
      /** Persist a drag-reordered project list; the new order is the sidebar order. */
      reorder: (cwds: string[]): Promise<WorkspaceSnapshot> =>
        t.invoke(Ipc.projectsReorder, { cwds }),
    },
    workspace: {
      pick: (): Promise<{ cwd: string; status: EngineStatus } | null> =>
        t.invoke(Ipc.workspacePick),
      reveal: (cwd: string): Promise<void> => t.invoke(Ipc.workspaceReveal, { cwd }),
      preview: (path: string): Promise<FilePreview> => t.invoke(Ipc.workspacePreview, { path }),
      fileIcons: (): Promise<FileIconMapping> => t.invoke(Ipc.workspaceFileIcons),
      readDir: (path: string): Promise<DirEntry[]> => t.invoke(Ipc.workspaceReadDir, { path }),
      gitStatus: (cwd: string): Promise<GitStatus> => t.invoke(Ipc.workspaceGitStatus, { cwd }),
      openTerminal: (cwd: string): Promise<void> => t.invoke(Ipc.workspaceOpenTerminal, { cwd }),
      gitBranches: (cwd: string): Promise<GitBranch[]> => t.invoke(Ipc.workspaceGitBranches, { cwd }),
      gitCheckout: (cwd: string, branch: string): Promise<GitStatus> => t.invoke(Ipc.workspaceGitCheckout, { cwd, branch }),
      gitCreateBranch: (cwd: string, branch: string): Promise<GitStatus> => t.invoke(Ipc.workspaceGitCreateBranch, { cwd, branch }),
      gitStage: (cwd: string, paths?: string[], all?: boolean): Promise<GitStatus> => t.invoke(Ipc.workspaceGitStage, { cwd, paths, all }),
      gitCommit: (cwd: string, message: string): Promise<GitStatus> => t.invoke(Ipc.workspaceGitCommit, { cwd, message }),
      gitGenerateCommitMessage: (cwd: string, conversationId?: string): Promise<string> =>
        t.invoke(Ipc.workspaceGitGenerateCommitMessage, { cwd, conversationId }),
      gitDiff: (cwd: string, path?: string, source?: GitDiffSource): Promise<string> =>
        t.invoke(Ipc.workspaceGitDiff, { cwd, path, source }),
      gitUnstage: (cwd: string, paths: string[]): Promise<GitStatus> =>
        t.invoke(Ipc.workspaceGitUnstage, { cwd, paths }),
      gitDiscard: (cwd: string, paths: string[]): Promise<GitStatus> =>
        t.invoke(Ipc.workspaceGitDiscard, { cwd, paths }),
      gitPull: (cwd: string): Promise<GitStatus> => t.invoke(Ipc.workspaceGitPull, { cwd }),
      gitPush: (cwd: string): Promise<GitStatus> => t.invoke(Ipc.workspaceGitPush, { cwd }),
      terminalStart: (cwd?: string, size?: { cols?: number; rows?: number }): Promise<TerminalSessionInfo> =>
        t.invoke(Ipc.workspaceTerminalStart, { cwd, ...size }),
      terminalWrite: (id: string, data: string): Promise<void> => t.invoke(Ipc.workspaceTerminalWrite, { id, data }),
      terminalResize: (id: string, cols: number, rows: number): Promise<void> =>
        t.invoke(Ipc.workspaceTerminalResize, { id, cols, rows }),
      terminalKill: (id: string): Promise<void> => t.invoke(Ipc.workspaceTerminalKill, { id }),
      onTerminalData: (listener: (event: TerminalDataEvent) => void): (() => void) => t.subscribe(Ipc.workspaceTerminalData, listener),
    },
    app: {
      getInfo: (): Promise<import("@shared/ipc").AppInfo> => t.invoke(Ipc.appGetInfo),
      /**
       * Read before paint, so the shell can decide whether it draws a title bar
       * (`lib/platform.ts`) instead of guessing from the user agent.
       */
      platform: t.platform,
      /** True in the browser client. Window chrome and OS keys hang off this. */
      remote: t.remote,
      log: (payload: import("@shared/ipc").AppLogPayload): void => {
        t.send(Ipc.appLog, payload);
      },
      exportLogs: (): Promise<string | undefined> => t.invoke(Ipc.appExportLogs),
      updateModelsDev: (): Promise<import("@shared/ipc").AppModelsDevInfo> =>
        t.invoke(Ipc.modelsDevUpdate),
      onModelsDev: (listener: (info: import("@shared/ipc").AppModelsDevInfo) => void): (() => void) =>
        t.subscribe(Ipc.modelsDevChanged, listener),
      newWindow: (): Promise<void> => t.invoke(Ipc.windowNew),
    },
    /** The hand-drawn title bar's window controls (Windows / Linux only). */
    window: {
      minimize: (): Promise<void> => t.invoke(Ipc.windowMinimize),
      toggleMaximize: (): Promise<void> => t.invoke(Ipc.windowToggleMaximize),
      close: (): Promise<void> => t.invoke(Ipc.windowClose),
      isMaximized: (): Promise<boolean> => t.invoke(Ipc.windowIsMaximized),
      onState: (listener: (state: WindowChromeState) => void): (() => void) => t.subscribe(Ipc.windowState, listener),
    },
    updater: {
      getState: (): Promise<AppUpdateState> => t.invoke(Ipc.updateGetState),
      check: (): Promise<AppUpdateState> => t.invoke(Ipc.updateCheck),
      download: (): Promise<AppUpdateState> => t.invoke(Ipc.updateDownload),
      install: (): Promise<AppUpdateState> => t.invoke(Ipc.updateInstall),
      onState: (listener: (state: AppUpdateState) => void): (() => void) => t.subscribe(Ipc.updateState, listener),
    },
    settings: {
      /**
       * Snapshot captured in the preload world before the page runs, so the
       * renderer store can apply the theme on first paint without waiting on IPC.
       */
      initial: t.settingsInitial,
      load: (): Promise<Record<string, unknown>> => t.invoke(Ipc.settingsGet),
      save: (settings: Record<string, unknown>): Promise<void> => t.invoke(Ipc.settingsSet, settings),
      clear: (): Promise<void> => t.invoke(Ipc.settingsClear),
      /**
       * A write made by *another* window. Each window holds its own copy of the
       * preferences, so without this two open windows drifted apart and overwrote each
       * other's changes with their stale copy on the next save.
       */
      onChanged: (listener: (settings: Record<string, unknown>) => void): (() => void) => t.subscribe(Ipc.settingsChanged, listener),
    },
    ssh: {
      hosts: (): Promise<{ saved: RemoteHostProfile[]; discovered: RemoteHostProfile[] }> => t.invoke(Ipc.sshHosts),
      saveHost: (host: RemoteHostProfile): Promise<{ saved: RemoteHostProfile[]; discovered: RemoteHostProfile[] }> =>
        t.invoke(Ipc.sshHostSave, { host }),
      removeHost: (id: string): Promise<{ saved: RemoteHostProfile[]; discovered: RemoteHostProfile[] }> =>
        t.invoke(Ipc.sshHostRemove, { id }),
      pickIdentityFile: (): Promise<string | null> => t.invoke(Ipc.sshPickIdentityFile),
      connect: (hostId: string): Promise<RemoteHostConnectionState> => t.invoke(Ipc.sshConnect, { hostId }),
      disconnect: (hostId?: string): Promise<RemoteHostConnectionState> =>
        t.invoke(Ipc.sshDisconnect, hostId ? { hostId } : undefined),
      state: (): Promise<RemoteHostConnectionState> => t.invoke(Ipc.sshState),
      states: (): Promise<RemoteHostConnectionState[]> => t.invoke(Ipc.sshStates),
      onState: (listener: (state: RemoteHostConnectionState) => void): (() => void) => t.subscribe(Ipc.sshState, listener),
      onStates: (listener: (states: RemoteHostConnectionState[]) => void): (() => void) =>
        t.subscribe(Ipc.sshStates, listener),
    },
    /** 远程访问：把这台机器上的 agent 通过网页开放给其他设备。 */
    remote: {
      getState: (): Promise<import("@shared/ipc").RemoteServerState> => t.invoke(Ipc.remoteGetState),
      setPassword: (password: string): Promise<import("@shared/ipc").RemoteServerState> =>
        t.invoke(Ipc.remoteSetPassword, { password }),
      clearPassword: (): Promise<import("@shared/ipc").RemoteServerState> => t.invoke(Ipc.remoteClearPassword),
      start: (port?: number): Promise<import("@shared/ipc").RemoteServerState> =>
        t.invoke(Ipc.remoteStart, { port }),
      stop: (): Promise<import("@shared/ipc").RemoteServerState> => t.invoke(Ipc.remoteStop),
      listDevices: (): Promise<import("@shared/ipc").RemoteDeviceInfo[]> => t.invoke(Ipc.remoteListDevices),
      revokeDevice: (id: string): Promise<import("@shared/ipc").RemoteDeviceInfo[]> =>
        t.invoke(Ipc.remoteRevokeDevice, { id }),
      tunnelTools: (): Promise<import("@shared/ipc").RemoteTunnelTools> => t.invoke(Ipc.remoteTunnelTools),
      /** Pick a tunnel, or `null` for none. Re-picking the current one restarts it. */
      setTunnel: (
        provider: import("@shared/ipc").RemoteTunnelProvider | null,
      ): Promise<import("@shared/ipc").RemoteServerState> => t.invoke(Ipc.remoteTunnelSet, { provider }),
      onState: (listener: (state: import("@shared/ipc").RemoteServerState) => void): (() => void) => t.subscribe(Ipc.remoteState, listener),
    },
    stats: {
      usage: (range: UsageRange): Promise<UsageStats> => t.invoke(Ipc.statsUsage, { range }),
    },
    computer: {
      permissions: (): Promise<import("@shared/types").ComputerPermissionStatus> => t.invoke(Ipc.computerPermissions),
      requestPermissions: (): Promise<import("@shared/types").ComputerPermissionStatus> =>
        t.invoke(Ipc.computerRequestPermissions),
      openSettings: (): Promise<void> => t.invoke(Ipc.computerOpenSettings),
      listApps: (): Promise<import("@shared/types").ComputerAppInfo[]> => t.invoke(Ipc.computerListApps),
      startDrag: (): Promise<void> => t.invoke(Ipc.computerStartDrag),
      startGrantFlow: (): Promise<import("@shared/types").GrantFlowState> => t.invoke(Ipc.computerStartGrantFlow),
      cancelGrantFlow: (): Promise<void> => t.invoke(Ipc.computerCancelGrantFlow),
      getGrantFlow: (): Promise<import("@shared/types").GrantFlowState> => t.invoke(Ipc.computerGetGrantFlow),
      onGrantFlowState: (listener: (state: import("@shared/types").GrantFlowState) => void): (() => void) =>
        t.subscribe(Ipc.computerGrantFlowState, listener),
    },
    browser: {
      listProfiles: (): Promise<BrowserProfileInfo[]> => t.invoke(Ipc.browserListProfiles),
      importProfile: (profile: BrowserProfileInfo): Promise<BrowserImportResult> => t.invoke(Ipc.browserImportProfile, { profile }),
      onRequest: (listener: (payload: { id: string; request: BrowserRequest }) => void): (() => void) => t.subscribe(Ipc.browserRequest, listener),
      respond: (payload: { id: string; ok: boolean; result?: unknown; error?: string }): void => {
        t.send(Ipc.browserResponse, payload);
      },
    },
  };

  return api;
}

export type FastVibeApi = ReturnType<typeof createFastVibeApi>;
