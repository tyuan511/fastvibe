import { create } from "zustand";
import type {
  ChatAttachment,
  ChatMessage,
  Conversation,
  FastVibeModel,
  OmpSessionState,
  OmpStatus,
  OmpWireEvent,
  PermissionRequest,
  Project,
  QueueBehavior,
  QueuedPrompt,
  RunMode,
  FilePreview,
  SlashCommand,
  SubagentInfo,
  WorkspaceSnapshot,
} from "@shared/types";
import { applyOmpEvent } from "@/lib/apply-omp-event";

type SessionStore = {
  status: OmpStatus;
  session: OmpSessionState | null;
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
  queueBehavior: QueueBehavior;
  attachments: ChatAttachment[];
  queued: QueuedPrompt[];
  permissionAlways: string[];
  preview: FilePreview | null;
  subagentStreams: Record<string, ChatMessage[]>;
  setStatus: (status: OmpStatus) => void;
  setSession: (session: OmpSessionState | null) => void;
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
  setQueueBehavior: (queueBehavior: QueueBehavior) => void;
  addUserMessage: (text: string, attachments?: ChatAttachment[]) => void;
  setAttachments: (attachments: ChatAttachment[]) => void;
  enqueue: (item: QueuedPrompt) => void;
  clearQueued: () => void;
  rememberPermission: (key: string) => void;
  setPreview: (preview: FilePreview | null) => void;
  openPreview: (path: string) => Promise<void>;
  applyEvent: (event: OmpWireEvent) => void;
  resetConversation: () => void;
  setStreaming: (streaming: boolean) => void;
};

function parsePermission(event: OmpWireEvent): PermissionRequest | null {
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
  queueBehavior: "followUp",
  attachments: [],
  queued: [],
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
  setQueueBehavior: (queueBehavior) => set({ queueBehavior }),
  addUserMessage: (text, attachments) =>
    set((state) => ({
      messages: [
        ...state.messages,
        {
          id: crypto.randomUUID(),
          role: "user",
          text,
          tools: [],
          createdAt: Date.now(),
          attachments,
        },
      ],
      streaming: true,
      error: null,
      attachments: [],
    })),
  setAttachments: (attachments) => set({ attachments }),
  enqueue: (item) => set((state) => ({ queued: [...state.queued, item] })),
  clearQueued: () => set({ queued: [] }),
  rememberPermission: (key) =>
    set((state) =>
      state.permissionAlways.includes(key) ? state : { permissionAlways: [...state.permissionAlways, key] },
    ),
  setPreview: (preview) => set({ preview }),
  openPreview: async (path) => {
    try {
      const preview = await window.fastvibe.workspace.preview(path);
      set({ preview });
    } catch (error) {
      set({
        preview: {
          kind: "error",
          path,
          name: path.split("/").at(-1) ?? path,
          message: error instanceof Error ? error.message : "无法预览",
        },
      });
    }
  },
  applyEvent: (event) =>
    set((state) => {
      const applied = applyOmpEvent(state.messages, event, state.streaming);
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
        queued: applied.streaming ? state.queued : [],
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
    }),
  setStreaming: (streaming) => set({ streaming }),
}));

function upsertSubagent(list: SubagentInfo[], event: OmpWireEvent): SubagentInfo[] {
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
  event: OmpWireEvent,
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
      ? (event.event as OmpWireEvent)
      : event.payload && typeof event.payload === "object"
        ? (event.payload as OmpWireEvent)
        : event;
  if (typeof nested.type !== "string" || nested.type === "subagent_event") return streams;
  const applied = applyOmpEvent(streams[id] ?? [], nested, true);
  return { ...streams, [id]: applied.messages };
}
