import { contextBridge, ipcRenderer } from "electron";
import { Ipc } from "@shared/ipc";
import type {
  ChatMessage,
  ConversationDeleteResult,
  ConversationOpenResult,
  ConversationReadyEvent,
  FastVibeModel,
  SessionStats,
  OmpSessionState,
  OmpStatus,
  OmpWireEvent,
  ProjectAddResult,
  PromptImage,
  ProviderConfig,
  ProviderModel,
  SlashCommand,
  FilePreview,
  SubagentInfo,
  WorkspaceSnapshot,
} from "@shared/types";
import type { GitStatus } from "@shared/ipc";

const api = {
  omp: {
    getStatus: (): Promise<OmpStatus> => ipcRenderer.invoke(Ipc.ompGetStatus),
    start: (cwd?: string): Promise<OmpStatus> => ipcRenderer.invoke(Ipc.ompStart, { cwd }),
    stop: (): Promise<OmpStatus> => ipcRenderer.invoke(Ipc.ompStop),
    prompt: (
      message: string,
      options?: { streamingBehavior?: "steer" | "followUp"; images?: PromptImage[] },
    ): Promise<void> => ipcRenderer.invoke(Ipc.ompPrompt, { message, ...options }),
    steer: (message: string, images?: PromptImage[]): Promise<void> =>
      ipcRenderer.invoke(Ipc.ompSteer, { message, images }),
    followUp: (message: string, images?: PromptImage[]): Promise<void> =>
      ipcRenderer.invoke(Ipc.ompFollowUp, { message, images }),
    abort: (): Promise<void> => ipcRenderer.invoke(Ipc.ompAbort),
    clearQueue: (): Promise<{ steering: string[]; followUp: string[] }> =>
      ipcRenderer.invoke(Ipc.ompClearQueue),
    compact: (customInstructions?: string): Promise<OmpSessionState> =>
      ipcRenderer.invoke(Ipc.ompCompact, { customInstructions }),
    getCommands: (): Promise<SlashCommand[]> => ipcRenderer.invoke(Ipc.ompGetCommands),
    getSubagents: (): Promise<SubagentInfo[]> => ipcRenderer.invoke(Ipc.ompGetSubagents),
    getSubagentMessages: (subagentId: string): Promise<ChatMessage[]> =>
      ipcRenderer.invoke(Ipc.ompGetSubagentMessages, { subagentId }),
    respondPermission: (payload: {
      id: string;
      confirmed?: boolean;
      value?: string;
      cancelled?: boolean;
    }): Promise<void> => ipcRenderer.invoke(Ipc.ompPermissionRespond, payload),
    newSession: (): Promise<void> => ipcRenderer.invoke(Ipc.ompNewSession),
    getState: (): Promise<OmpSessionState> => ipcRenderer.invoke(Ipc.ompGetState),
    getModels: (): Promise<FastVibeModel[]> => ipcRenderer.invoke(Ipc.ompGetModels),
    setModel: (provider: string, modelId: string): Promise<OmpSessionState> =>
      ipcRenderer.invoke(Ipc.ompSetModel, { provider, modelId }),
    setThinking: (level: string): Promise<OmpSessionState> =>
      ipcRenderer.invoke(Ipc.ompSetThinking, { level }),
    setInterruptMode: (mode: "immediate" | "wait"): Promise<OmpSessionState> =>
      ipcRenderer.invoke(Ipc.ompSetInterrupt, { mode }),
    setAutoCompaction: (enabled: boolean): Promise<OmpSessionState> =>
      ipcRenderer.invoke(Ipc.ompSetAutoCompact, { enabled }),
    branch: (entryId: string): Promise<ChatMessage[]> => ipcRenderer.invoke(Ipc.ompBranch, { entryId }),
    getMessages: (): Promise<ChatMessage[]> => ipcRenderer.invoke(Ipc.ompGetMessages),
    getStats: (): Promise<SessionStats> => ipcRenderer.invoke(Ipc.ompGetStats),
    setSteeringMode: (mode: "all" | "one-at-a-time"): Promise<OmpSessionState> =>
      ipcRenderer.invoke(Ipc.ompSetSteering, { mode }),
    setFollowUpMode: (mode: "all" | "one-at-a-time"): Promise<OmpSessionState> =>
      ipcRenderer.invoke(Ipc.ompSetFollowUp, { mode }),
    exportHtml: (): Promise<string | undefined> => ipcRenderer.invoke(Ipc.ompExportHtml),
    onEvent: (listener: (event: OmpWireEvent) => void): (() => void) => {
      const handler = (_event: unknown, payload: OmpWireEvent): void => listener(payload);
      ipcRenderer.on(Ipc.event, handler);
      return () => ipcRenderer.removeListener(Ipc.event, handler);
    },
    onStatus: (listener: (status: OmpStatus) => void): (() => void) => {
      const handler = (_event: unknown, payload: OmpStatus): void => listener(payload);
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
    fetch: (baseUrl: string, apiKey: string): Promise<ProviderModel[]> =>
      ipcRenderer.invoke(Ipc.providersFetch, { baseUrl, apiKey }),
    saveFastVibe: (apiKey: string, models: ProviderModel[]): Promise<ProviderConfig[]> =>
      ipcRenderer.invoke(Ipc.providersSaveFastVibe, { apiKey, models }),
    add: (payload: {
      name: string;
      baseUrl: string;
      apiKey: string;
      models: ProviderModel[];
    }): Promise<ProviderConfig[]> => ipcRenderer.invoke(Ipc.providersAdd, payload),
    update: (payload: {
      id: string;
      name?: string;
      baseUrl?: string;
      apiKey?: string;
      models?: ProviderModel[];
    }): Promise<ProviderConfig[]> => ipcRenderer.invoke(Ipc.providersUpdate, payload),
    remove: (id: string): Promise<ProviderConfig[]> => ipcRenderer.invoke(Ipc.providersRemove, { id }),
    refresh: (id: string): Promise<ProviderModel[]> =>
      ipcRenderer.invoke(Ipc.providersRefresh, { id }),
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
  },
  projects: {
    add: (): Promise<ProjectAddResult | null> => ipcRenderer.invoke(Ipc.projectsAdd),
    rename: (cwd: string, name: string): Promise<WorkspaceSnapshot> =>
      ipcRenderer.invoke(Ipc.projectsRename, { cwd, name }),
    remove: (cwd: string): Promise<ConversationDeleteResult> =>
      ipcRenderer.invoke(Ipc.projectsRemove, { cwd }),
  },
  workspace: {
    pick: (): Promise<{ cwd: string; status: OmpStatus } | null> =>
      ipcRenderer.invoke(Ipc.workspacePick),
    reveal: (cwd: string): Promise<void> => ipcRenderer.invoke(Ipc.workspaceReveal, { cwd }),
    preview: (path: string): Promise<FilePreview> => ipcRenderer.invoke(Ipc.workspacePreview, { path }),
    gitStatus: (cwd: string): Promise<GitStatus> => ipcRenderer.invoke(Ipc.workspaceGitStatus, { cwd }),
  },
  app: {
    getInfo: (): Promise<import("@shared/ipc").AppInfo> => ipcRenderer.invoke(Ipc.appGetInfo),
  },
};

export type FastVibeApi = typeof api;

contextBridge.exposeInMainWorld("fastvibe", api);
