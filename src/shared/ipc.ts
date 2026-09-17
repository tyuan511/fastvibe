export const Ipc = {
  engineGetStatus: "engine:get-status",
  engineStart: "engine:start",
  engineStop: "engine:stop",
  enginePrompt: "engine:prompt",
  engineSteer: "engine:steer",
  engineFollowUp: "engine:follow-up",
  engineAbort: "engine:abort",
  engineContinue: "engine:continue",
  engineClearQueue: "engine:clear-queue",
  engineReplaceSteering: "engine:replace-steering",
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
  engineGetSubagentMessages: "engine:get-subagent-messages",
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
  engineGetMessages: "engine:get-messages",
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
  enginePromptConversation: "engine:prompt-conversation",
  engineGetConversationMessages: "engine:get-conversation-messages",
  conversationsCreateSide: "conversations:create-side",
  appGetInfo: "app:get-info",
  appLog: "app:log",
  appExportLogs: "app:export-logs",
  modelsDevUpdate: "models-dev:update",
  statsUsage: "stats:usage",
  windowNew: "window:new",
  settingsGet: "settings:get",
  settingsGetSync: "settings:get-sync",
  settingsSet: "settings:set",
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
  providersTest: "providers:test",
  providersCcSwitchScan: "providers:cc-switch-scan",
  providersCcSwitchImport: "providers:cc-switch-import",
  /** Subscription (OAuth) login: start, answer a prompt, cancel, log out. */
  providersOAuthLogin: "providers:oauth-login",
  providersOAuthAnswer: "providers:oauth-answer",
  providersOAuthCancel: "providers:oauth-cancel",
  providersLogout: "providers:logout",
  providersOAuthEvent: "providers:oauth-event",
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
  ahead?: number;
  behind?: number;
  files: Array<{ path: string; index: string; worktree: string }>;
};

export type GitBranch = { name: string; current: boolean; upstream?: string };

export type GitDiffSource = "unstaged" | "staged" | "branch" | "last-turn";

export type TerminalSessionInfo = { id: string; cwd: string };

export type TerminalDataEvent = { id: string; data?: string; exited?: boolean };

export type PromptRequest = {
  message: string;
  streamingBehavior?: "steer" | "followUp";
  images?: Array<{ type: "image"; data: string; mimeType: string }>;
};

export type StartRequest = {
  cwd?: string;
};
