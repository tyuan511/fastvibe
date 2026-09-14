import { create } from "zustand";
import type {
  ChatAttachment,
  ChatMessage,
  Conversation,
  FastVibeModel,
  EngineSessionState,
  EngineStatus,
  EngineEvent,
  PermissionRequest,
  Project,
  QueuePauseReason,
  QueuedPrompt,
  RunMode,
  FilePreview,
  SlashCommand,
  SubagentInfo,
  WorkspaceSnapshot,
} from "@shared/types";
import { applyEngineEvent } from "@/lib/apply-engine-event";
import { useSidePaneStore } from "@/stores/side-pane";

type SessionStore = {
  status: EngineStatus;
  session: EngineSessionState | null;
  models: FastVibeModel[];
  projects: Project[];
  conversations: Conversation[];
  activeId: string | null;
  messages: ChatMessage[];
  streaming: boolean;
  compacting: boolean;
  error: string | null;
  draft: string;
  commands: SlashCommand[];
  subagents: SubagentInfo[];
  permission: PermissionRequest | null;
  runMode: RunMode;
  attachments: ChatAttachment[];
  queued: QueuedPrompt[];
  queuePause: QueuePauseReason | null;
  permissionAlways: string[];
  preview: FilePreview | null;
  subagentStreams: Record<string, ChatMessage[]>;
  setStatus: (status: EngineStatus) => void;
  setSession: (session: EngineSessionState | null) => void;
  setModels: (models: FastVibeModel[]) => void;
  applySnapshot: (snapshot: WorkspaceSnapshot) => void;
  setActiveId: (activeId: string | null) => void;
  setMessages: (messages: ChatMessage[]) => void;
  setDraft: (draft: string) => void;
  setError: (error: string | null) => void;
  setCommands: (commands: SlashCommand[]) => void;
  setSubagents: (subagents: SubagentInfo[]) => void;
  setPermission: (permission: PermissionRequest | null) => void;
  setRunMode: (runMode: RunMode) => void;
  addUserMessage: (text: string, attachments?: ChatAttachment[]) => void;
  dropEmptyAssistant: () => void;
  setAttachments: (attachments: ChatAttachment[]) => void;
  enqueue: (item: QueuedPrompt) => void;
  removeQueued: (id: string) => void;
  prependQueued: (item: QueuedPrompt) => void;
  clearQueued: () => void;
  setQueuePause: (reason: QueuePauseReason | null) => void;
  rememberPermission: (key: string) => void;
  setPreview: (preview: FilePreview | null) => void;
  openPreview: (path: string) => Promise<void>;
  applyEvent: (event: EngineEvent) => void;
  resetConversation: () => void;
  setStreaming: (streaming: boolean) => void;
};

function parsePermission(event: EngineEvent): PermissionRequest | null {
  if (event.type !== "extension_ui_request") return null;
  const method = event.method;
  if (method !== "confirm" && method !== "select" && method !== "input" && method !== "editor") {
    return null;
  }
  const id = typeof event.id === "string" ? event.id : "";
  if (!id) return null;
  return {
    id,
    method,
    title: typeof event.title === "string" ? event.title : undefined,
    message: typeof event.message === "string" ? event.message : undefined,
    options: Array.isArray(event.options)
      ? event.options.filter((item): item is string => typeof item === "string")
      : undefined,
    optionDetails: Array.isArray(event.optionDetails)
      ? event.optionDetails.map((item) =>
          item && typeof item === "object" && "description" in item
            ? { description: typeof item.description === "string" ? item.description : undefined }
            : {},
        )
      : undefined,
    timeout: typeof event.timeout === "number" ? event.timeout : undefined,
  };
}

export const useSessionStore = create<SessionStore>((set) => ({
  status: { state: "idle" },
  session: null,
  models: [],
  projects: [],
  conversations: [],
  activeId: null,
  messages: [],
  streaming: false,
  compacting: false,
  error: null,
  draft: "",
  commands: [],
  subagents: [],
  permission: null,
  runMode: "agent",
  attachments: [],
  queued: [],
  queuePause: null,
  permissionAlways: [],
  preview: null,
  subagentStreams: {},
  setStatus: (status) => set({ status, error: status.state === "error" ? status.message ?? null : null }),
  setSession: (session) =>
    set({
      session,
      streaming: session?.isStreaming ?? false,
      compacting: session?.isCompacting ?? false,
    }),
  setModels: (models) => set({ models }),
  applySnapshot: (snapshot) =>
    set({
      projects: snapshot.projects,
      conversations: snapshot.conversations,
    }),
  setActiveId: (activeId) => set({ activeId }),
  setMessages: (messages) => set({ messages, streaming: false }),
  setDraft: (draft) => set({ draft }),
  setError: (error) => set({ error }),
  setCommands: (commands) => set({ commands }),
  setSubagents: (subagents) => set({ subagents }),
  setPermission: (permission) => set({ permission }),
  setRunMode: (runMode) => set({ runMode }),
  addUserMessage: (text, attachments) =>
    set((state) => ({
      messages: [
        ...state.messages,
        {
          id: crypto.randomUUID(),
          role: "user",
          text,
          tools: [],
          parts: text ? [{ kind: "text", text }] : [],
          createdAt: Date.now(),
          attachments,
        },
        {
          id: crypto.randomUUID(),
          role: "assistant",
          text: "",
          tools: [],
          parts: [],
          createdAt: Date.now(),
        },
      ],
      streaming: true,
      error: null,
      attachments: [],
    })),
  dropEmptyAssistant: () =>
    set((state) => {
      const last = state.messages.at(-1);
      if (
        last?.role === "assistant" &&
        !last.text &&
        !last.thinking &&
        last.tools.length === 0
      ) {
        return { messages: state.messages.slice(0, -1), streaming: false };
      }
      return { streaming: false };
    }),
  setAttachments: (attachments) => set({ attachments }),
  enqueue: (item) => set((state) => ({ queued: [...state.queued, item] })),
  removeQueued: (id) => set((state) => ({ queued: state.queued.filter((item) => item.id !== id) })),
  prependQueued: (item) => set((state) => ({ queued: [item, ...state.queued] })),
  clearQueued: () => set({ queued: [], queuePause: null }),
  setQueuePause: (queuePause) => set({ queuePause }),
  rememberPermission: (key) =>
    set((state) =>
      state.permissionAlways.includes(key) ? state : { permissionAlways: [...state.permissionAlways, key] },
    ),
  setPreview: (preview) => set({ preview }),
  openPreview: async (path) => {
    try {
      const preview = await window.fastvibe.workspace.preview(path);
      set({ preview });
      useSidePaneStore.getState().openCodeViewer(preview);
    } catch (error) {
      const preview: FilePreview = {
        kind: "error",
        path,
        name: path.split("/").at(-1) ?? path,
        message: error instanceof Error ? error.message : "无法预览",
      };
      set({ preview });
      useSidePaneStore.getState().openCodeViewer(preview);
    }
  },
  applyEvent: (event) =>
    set((state) => {
      const applied = applyEngineEvent(state.messages, event, state.streaming);
      const permission = parsePermission(event);
      const compacting =
        event.type === "compaction_start" || event.type === "auto_compaction_start"
          ? true
          : event.type === "compaction_end" || event.type === "auto_compaction_end"
            ? false
            : state.compacting;
      const subagents = upsertSubagent(state.subagents, event);
      const subagentStreams = applySubagentStream(state.subagentStreams, event);
      return {
        messages: applied.messages,
        streaming: applied.streaming,
        compacting,
        permission: permission ?? state.permission,
        subagents,
        subagentStreams,
      };
    }),
  resetConversation: () =>
    set({
      messages: [],
      streaming: false,
      compacting: false,
      error: null,
      activeId: null,
      permission: null,
      subagents: [],
      subagentStreams: {},
      preview: null,
      queued: [],
      queuePause: null,
    }),
  setStreaming: (streaming) => set({ streaming }),
}));

function upsertSubagent(list: SubagentInfo[], event: EngineEvent): SubagentInfo[] {
  if (event.type !== "subagent_lifecycle" && event.type !== "subagent_progress") return list;
  const id = typeof event.subagentId === "string" ? event.subagentId : typeof event.id === "string" ? event.id : "";
  if (!id) return list;
  const next: SubagentInfo = {
    id,
    name: typeof event.name === "string" ? event.name : list.find((item) => item.id === id)?.name,
    status: typeof event.status === "string" ? event.status : list.find((item) => item.id === id)?.status,
    detail:
      typeof event.detail === "string"
        ? event.detail
        : typeof event.progress === "string"
          ? event.progress
          : list.find((item) => item.id === id)?.detail,
  };
  if (list.some((item) => item.id === id)) {
    return list.map((item) => (item.id === id ? { ...item, ...next } : item));
  }
  return [next, ...list];
}

function applySubagentStream(
  streams: Record<string, ChatMessage[]>,
  event: EngineEvent,
): Record<string, ChatMessage[]> {
  if (event.type !== "subagent_event") return streams;
  const id =
    typeof event.subagentId === "string"
      ? event.subagentId
      : typeof event.id === "string"
        ? event.id
        : "";
  if (!id) return streams;
  const nested =
    event.event && typeof event.event === "object"
      ? (event.event as EngineEvent)
      : event.payload && typeof event.payload === "object"
        ? (event.payload as EngineEvent)
        : event;
  if (typeof nested.type !== "string" || nested.type === "subagent_event") return streams;
  const applied = applyEngineEvent(streams[id] ?? [], nested, true);
  return { ...streams, [id]: applied.messages };
}
