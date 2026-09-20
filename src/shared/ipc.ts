export const Ipc = {
  engineGetStatus: "engine:get-status",
  engineStart: "engine:start",
  engineStop: "engine:stop",
  enginePrompt: "engine:prompt",
  engineSteer: "engine:steer",
  engineFollowUp: "engine:follow-up",
  engineAbort: "engine:abort",
  engineAbortSubagent: "engine:abort-subagent",
  engineContinue: "engine:continue",
  engineClearQueue: "engine:clear-queue",
  engineReplaceSteering: "engine:replace-steering",
  engineQueueAdd: "engine:queue-add",
  engineQueueCancel: "engine:queue-cancel",
  engineQueueRecall: "engine:queue-recall",
  engineQueueSendNow: "engine:queue-send-now",
  engineQueueReorder: "engine:queue-reorder",
  engineQueueResume: "engine:queue-resume",
  engineCompact: "engine:compact",
  engineGetCommands: "engine:get-commands",
  engineGetExtensions: "engine:get-extensions",
  engineListExtensionPackages: "engine:list-extension-packages",
  engineInstallExtensionPackage: "engine:install-extension-package",
  engineRemoveExtensionPackage: "engine:remove-extension-package",
  engineListMarketPackages: "engine:list-market-packages",
  engineListMcpServers: "engine:list-mcp-servers",
  engineSaveMcpServers: "engine:save-mcp-servers",
  engineListSkills: "engine:list-skills",
  engineCreateSkill: "engine:create-skill",
  engineImportSkill: "engine:import-skill",
  engineRemoveSkill: "engine:remove-skill",
  engineGetSubagents: "engine:get-subagents",
  engineListAgentConfigs: "engine:list-agent-configs",
  engineSaveAgentConfig: "engine:save-agent-config",
  engineRemoveAgentConfig: "engine:remove-agent-config",
  engineGetSubagentMessages: "engine:get-subagent-messages",
  /** A retry's file checkpoint: what the last turn wrote, and undoing it. */
  engineGetCheckpoint: "engine:get-checkpoint",
  engineRestoreCheckpoint: "engine:restore-checkpoint",
  enginePermissionRespond: "engine:permission-respond",
  engineNewSession: "engine:new-session",
  engineGetState: "engine:get-state",
  engineGetRunning: "engine:get-running",
  engineGetModels: "engine:get-models",
  engineSetModel: "engine:set-model",
  engineSetThinking: "engine:set-thinking",
  engineSetInterrupt: "engine:set-interrupt",
  engineSetAutoCompact: "engine:set-auto-compact",
  engineBranch: "engine:branch",
  engineFork: "engine:fork",
  engineGetMessages: "engine:get-messages",
  /**
   * The transcript from one entry onward, for a client that already holds the rest
   * (`TranscriptTail`). What the end-of-turn reload uses, so its cost is the turn
   * rather than the whole conversation.
   */
  engineGetMessagesSince: "engine:get-messages-since",
  /** Transcript + the turn in flight, read at one instant (`ConversationSnapshot`). */
  engineGetSnapshot: "engine:get-snapshot",
  engineGetStats: "engine:get-stats",
  engineSetSteering: "engine:set-steering",
  engineSetFollowUp: "engine:set-follow-up",
  engineExportHtml: "engine:export-html",
  engineImportSources: "engine:import-sources",
  engineImportCandidates: "engine:import-candidates",
  engineImportSessions: "engine:import-sessions",
  workspacePick: "workspace:pick",
  event: "engine:event",
  status: "engine:status",
  conversationsList: "conversations:list",
  conversationsCreate: "conversations:create",
  conversationsOpen: "conversations:open",
  conversationsRename: "conversations:rename",
  conversationsDelete: "conversations:delete",
  conversationsRecordPrompt: "conversations:record-prompt",
  conversationsSetProject: "conversations:set-project",
  conversationsSearch: "conversations:search",
  conversationReady: "conversations:ready",
  /**
   * Pushed whenever the conversation/project catalog changes, to *every* client.
   *
   * The list used to be read once per client, at connect, and never again — so a chat
   * created on the desktop never appeared on the phone, a delete left a row that opened
   * nothing, and two desktop windows drifted apart the same way. A push, not a method,
   * because the client has nothing to ask about: it cannot know that something changed.
   */
  workspaceChanged: "workspace:changed",
  projectsAdd: "projects:add",
  projectsRename: "projects:rename",
  projectsRemove: "projects:remove",
  projectsReorder: "projects:reorder",
  workspaceReveal: "workspace:reveal",
  workspacePreview: "workspace:preview",
  workspaceFileIcons: "workspace:file-icons",
  workspaceReadDir: "workspace:read-dir",
  workspaceGitStatus: "workspace:git-status",
  workspaceOpenTerminal: "workspace:open-terminal",
  workspaceGitBranches: "workspace:git-branches",
  workspaceGitCheckout: "workspace:git-checkout",
  workspaceGitCreateBranch: "workspace:git-create-branch",
  workspaceGitStage: "workspace:git-stage",
  workspaceGitCommit: "workspace:git-commit",
  workspaceGitGenerateCommitMessage: "workspace:git-generate-commit-message",
  workspaceGitDiff: "workspace:git-diff",
  workspaceGitUnstage: "workspace:git-unstage",
  workspaceGitDiscard: "workspace:git-discard",
  workspaceGitPull: "workspace:git-pull",
  workspaceGitPush: "workspace:git-push",
  workspaceTerminalStart: "workspace:terminal-start",
  workspaceTerminalWrite: "workspace:terminal-write",
  workspaceTerminalResize: "workspace:terminal-resize",
  workspaceTerminalKill: "workspace:terminal-kill",
  workspaceTerminalData: "workspace:terminal-data",
  /** Main-process browser-use bridge (extension tool ↔ renderer webview). */
  browserRequest: "browser:request",
  browserResponse: "browser:response",
  browserListProfiles: "browser:list-profiles",
  browserImportProfile: "browser:import-profile",
  /** Cua Driver permission state. The tools themselves need no IPC — the driver is
   * loaded into Main, so a `computer_*` call never leaves the process. */
  computerPermissions: "computer:permissions",
  computerRequestPermissions: "computer:request-permissions",
  computerOpenSettings: "computer:open-settings",
  computerListApps: "computer:list-apps",
  /** Starts the native drag that carries FastVibe.app into the Privacy & Security list. */
  computerStartDrag: "computer:start-drag",
  enginePromptConversation: "engine:prompt-conversation",
  engineGetConversationMessages: "engine:get-conversation-messages",
  conversationsCreateSide: "conversations:create-side",
  appGetInfo: "app:get-info",
  appLog: "app:log",
  appExportLogs: "app:export-logs",
  modelsDevUpdate: "models-dev:update",
  statsUsage: "stats:usage",
  windowNew: "window:new",
  /** Window controls for the hand-drawn title bar (Windows / Linux). */
  windowMinimize: "window:minimize",
  windowToggleMaximize: "window:toggle-maximize",
  windowClose: "window:close",
  windowIsMaximized: "window:is-maximized",
  windowState: "window:state",
  settingsGet: "settings:get",
  settingsGetSync: "settings:get-sync",
  settingsSet: "settings:set",
  /** Pushed to the *other* windows after one writes, so their copy cannot go stale. */
  settingsChanged: "settings:changed",
  settingsClear: "settings:clear",
  updateGetState: "update:get-state",
  updateCheck: "update:check",
  updateDownload: "update:download",
  updateInstall: "update:install",
  updateState: "update:state",
  providersList: "providers:list",
  providersNative: "providers:native",
  providersFetch: "providers:fetch",
  providersSaveFastVibe: "providers:save-fastvibe",
  providersAdd: "providers:add",
  providersAddNative: "providers:add-native",
  providersUpdate: "providers:update",
  providersRemove: "providers:remove",
  providersRefresh: "providers:refresh",
  providersQuota: "providers:quota",
  providersTest: "providers:test",
  providersCcSwitchScan: "providers:cc-switch-scan",
  providersCcSwitchImport: "providers:cc-switch-import",
  /** Subscription (OAuth) login: start, answer a prompt, cancel, log out. */
  providersOAuthLogin: "providers:oauth-login",
  providersOAuthAnswer: "providers:oauth-answer",
  providersOAuthCancel: "providers:oauth-cancel",
  providersLogout: "providers:logout",
  providersOAuthEvent: "providers:oauth-event",
  /** 远程访问（网页/手机）: server lifecycle, credentials and devices. */
  remoteGetState: "remote:get-state",
  remoteSetPassword: "remote:set-password",
  remoteClearPassword: "remote:clear-password",
  remoteStart: "remote:start",
  remoteStop: "remote:stop",
  remoteListDevices: "remote:list-devices",
  remoteRevokeDevice: "remote:revoke-device",
  /** 内网穿透: which tunnel binaries this machine has, and which one to run. */
  remoteTunnelTools: "remote:tunnel-tools",
  remoteTunnelSet: "remote:tunnel-set",
  /** Pushed when the server starts, stops, gains a client, or the tunnel changes phase. */
  remoteState: "remote:state",
} as const;

export type AppModelsDevInfo = {
  models: number;
  aliases: number;
  generatedAt: number;
  /** The file the metadata was read from (the bundled index, or an updated snapshot). */
  path: string;
};

export type AppInfo = {
  version: string;
  userData: string;
  runtimeRoot: string;
  platform: string;
  modelsDev?: AppModelsDevInfo;
};

export type AppLogLevel = "debug" | "info" | "warn" | "error";

export type AppLogPayload = {
  level: AppLogLevel;
  message: string;
};

export type AppUpdateStatus =
  | "idle"
  | "disabled"
  | "checking"
  | "available"
  | "not-available"
  | "downloading"
  | "downloaded"
  | "error";

export type AppUpdateProgress = {
  percent: number;
  bytesPerSecond: number;
  transferred: number;
  total: number;
};

export type AppUpdateState = {
  status: AppUpdateStatus;
  currentVersion: string;
  availableVersion?: string;
  releaseNotes?: string;
  progress?: AppUpdateProgress;
  error?: string;
};

export type GitStatus = {
  cwd: string;
  isRepository: boolean;
  branch?: string;
  changed: number;
  staged: number;
  /** Text-line totals across the tracked working tree relative to HEAD. */
  additions: number;
  deletions: number;
  ahead?: number;
  behind?: number;
  files: Array<{ path: string; index: string; worktree: string }>;
};

export type GitBranch = { name: string; current: boolean; upstream?: string };

export type GitDiffSource = "unstaged" | "staged" | "branch" | "last-turn";

export type TerminalSessionInfo = { id: string; cwd: string };

export type TerminalDataEvent = { id: string; data?: string; exited?: boolean };

/**
 * Pushed whenever the window's maximised state changes, so the title bar's control
 * can swap between 最大化 and 还原 — the OS can maximise too (snap, double-click, a
 * window-manager key), so the renderer cannot derive this from its own clicks.
 */
export type WindowChromeState = { maximized: boolean };

export type PromptRequest = {
  message: string;
  streamingBehavior?: "steer" | "followUp";
  images?: Array<{ type: "image"; data: string; mimeType: string }>;
};

export type StartRequest = {
  cwd?: string;
};

/**
 * Which tunnel is running in front of the server.
 *
 * `off` → none. `starting` → the tool is up and has not printed a URL yet. `online` →
 * `url` is the address to hand a phone. `error` → `error` says why, and `output` holds
 * the tail of what the tool itself said about it.
 */
export type RemoteTunnelProvider = "cloudflared" | "ngrok";
export type RemoteTunnelPhase = "off" | "starting" | "online" | "error";

export type RemoteTunnelState = {
  provider: RemoteTunnelProvider | null;
  phase: RemoteTunnelPhase;
  url: string | null;
  error: string | null;
  output: string[];
  /**
   * The failure was a missing or rejected credential (ngrok's authtoken).
   *
   * A flag rather than a sentence for the pane to match on, because it selects a
   * different *control*: exactly one command fixes it, and the pane puts that command on
   * screen with a copy button instead of an error the user has to interpret.
   */
  needsAuth: boolean;
};

/** One tunnel binary, as found on this machine. */
export type RemoteToolInfo = {
  installed: boolean;
  path: string | null;
  version: string | null;
  /**
   * Whether the credential this tool needs is on this machine: `true` yes, `false`
   * positively not, `null` not applicable (Cloudflare needs no account) or unknowable.
   * Only `false` is acted on, so a check that cannot tell never blocks anybody.
   */
  authenticated: boolean | null;
};

export type RemoteTunnelTools = Record<RemoteTunnelProvider, RemoteToolInfo>;

/** The remote server's state, as the settings pane and the sidebar show it. */
export type RemoteServerState = {
  running: boolean;
  host: string;
  port: number | null;
  /** A password has been set. Without one the server refuses to start at all. */
  configured: boolean;
  /** Clients connected right now. */
  clients: number;
  /** Failed logins since the last success; the throttle grows with this. */
  failedLogins: number;
  /**
   * The tunnel, which is what makes the loopback address above reachable at all.
   *
   * Part of this state rather than its own channel: the pane draws one card out of the
   * two, and two broadcasts would let it render a public URL over a stopped server for
   * as long as the second push took to arrive.
   */
  tunnel: RemoteTunnelState;
  /**
   * The provider the user chose, which outlives the process it names.
   *
   * `tunnel.provider` is null while nothing runs, so the pane's select needs somewhere
   * else to read the choice back from — otherwise a failed start resets the control to
   * 关闭 and hides the retry.
   */
  tunnelChoice: RemoteTunnelProvider | null;
};

/** One client that has logged in, without anything secret. */
export type RemoteDeviceInfo = {
  id: string;
  label: string;
  createdAt: number;
  lastSeenAt: number | null;
};
