export const Ipc = {
  ompGetStatus: "omp:get-status",
  ompStart: "omp:start",
  ompStop: "omp:stop",
  ompPrompt: "omp:prompt",
  ompSteer: "omp:steer",
  ompFollowUp: "omp:follow-up",
  ompAbort: "omp:abort",
  ompClearQueue: "omp:clear-queue",
  ompCompact: "omp:compact",
  ompGetCommands: "omp:get-commands",
  ompGetExtensions: "omp:get-extensions",
  ompGetSubagents: "omp:get-subagents",
  ompGetSubagentMessages: "omp:get-subagent-messages",
  ompPermissionRespond: "omp:permission-respond",
  ompNewSession: "omp:new-session",
  ompGetState: "omp:get-state",
  ompGetModels: "omp:get-models",
  ompSetModel: "omp:set-model",
  ompSetThinking: "omp:set-thinking",
  ompSetInterrupt: "omp:set-interrupt",
  ompSetAutoCompact: "omp:set-auto-compact",
  ompBranch: "omp:branch",
  ompGetMessages: "omp:get-messages",
  ompGetStats: "omp:get-stats",
  ompSetSteering: "omp:set-steering",
  ompSetFollowUp: "omp:set-follow-up",
  ompExportHtml: "omp:export-html",
  workspacePick: "workspace:pick",
  event: "omp:event",
  status: "omp:status",
  conversationsList: "conversations:list",
  conversationsCreate: "conversations:create",
  conversationsOpen: "conversations:open",
  conversationsRename: "conversations:rename",
  conversationsDelete: "conversations:delete",
  conversationsRecordPrompt: "conversations:record-prompt",
  conversationsSetProject: "conversations:set-project",
  conversationReady: "conversations:ready",
  projectsAdd: "projects:add",
  projectsRename: "projects:rename",
  projectsRemove: "projects:remove",
  workspaceReveal: "workspace:reveal",
  workspacePreview: "workspace:preview",
  workspaceGitStatus: "workspace:git-status",
  workspaceOpenTerminal: "workspace:open-terminal",
  workspaceGitBranches: "workspace:git-branches",
  workspaceGitCheckout: "workspace:git-checkout",
  workspaceGitCreateBranch: "workspace:git-create-branch",
  workspaceGitStage: "workspace:git-stage",
  workspaceGitCommit: "workspace:git-commit",
  workspaceGitDiff: "workspace:git-diff",
  workspaceGitPull: "workspace:git-pull",
  workspaceGitPush: "workspace:git-push",
  appGetInfo: "app:get-info",
  windowNew: "window:new",
  providersList: "providers:list",
  providersFetch: "providers:fetch",
  providersSaveFastVibe: "providers:save-fastvibe",
  providersAdd: "providers:add",
  providersUpdate: "providers:update",
  providersRemove: "providers:remove",
  providersRefresh: "providers:refresh",
  providersTest: "providers:test",
} as const;

export type AppInfo = {
  version: string;
  userData: string;
  runtimeRoot: string;
  platform: string;
  modelsDev?: {
    models: number;
    aliases: number;
    generatedAt: number;
    path: string;
  };
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

export type PromptRequest = {
  message: string;
  streamingBehavior?: "steer" | "followUp";
  images?: Array<{ type: "image"; data: string; mimeType: string }>;
};

export type StartRequest = {
  cwd?: string;
};
