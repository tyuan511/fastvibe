import type { ChatAttachment, ChatMessage, ConversationSnapshot, PromptImage } from "./types.ts";

export const VIVI_BOT_ID = "vivi";
export type BotConversationRole = "router" | "worker";
export type BotInputSource = "user" | "router" | "answer" | "resume" | "report";
export type BotInputStatus = "queued" | "running" | "accepted" | "completed" | "failed" | "canceled" | "uncertain";
export type BotAttentionStatus = "pending" | "resolved" | "withdrawn";
export type BotResultStatus = "idle" | "ready" | "blocked" | "failed" | "uncertain";
export type BotDeliveryStatus = "pending" | "injected" | "delivered" | "failed";

export type BotChatMessage = {
  id: string;
  conversationId: string;
  role: "user" | "assistant";
  text: string;
  attachments?: ChatAttachment[];
  inputId?: string;
  createdAt: number;
};
export type BotConversationMeta = {
  conversationId: string;
  role: BotConversationRole;
  owner: typeof VIVI_BOT_ID;
  creationKey: string;
  epoch: number;
  paused: boolean;
  createdAt: number;
  updatedAt: number;
  title?: string;
  project?: string;
};
export type BotInput = {
  id: string;
  conversationId: string;
  epoch: number;
  source: BotInputSource;
  text: string;
  images?: PromptImage[];
  status: BotInputStatus;
  createdAt: number;
  error?: string;
};
export type BotAttention = {
  id: string;
  conversationId: string;
  inputId?: string;
  epoch: number;
  question: string;
  answer?: string;
  status: BotAttentionStatus;
  createdAt: number;
};
export type BotResult = {
  id: string;
  conversationId: string;
  inputId?: string;
  epoch: number;
  status: BotResultStatus;
  summary?: string;
  evidence?: string[];
  artifacts?: string[];
  createdAt: number;
};
export type BotDelivery = {
  id: string;
  conversationId: string;
  targetConversationId: string;
  status: BotDeliveryStatus;
  text: string;
  resultId?: string;
  createdAt: number;
};
export type WorkSnapshot = {
  revision: number;
  routerConversationId?: string;
  conversations: BotConversationMeta[];
  attention: BotAttention[];
  results: BotResult[];
  deliveries: BotDelivery[];
  messages: BotChatMessage[];
  error?: string;
};
export type BotActivity = { running: boolean; waiting: boolean; conversationId?: string };
export type BotChanged = { revision: number; conversationId?: string; activity?: BotActivity; delivery?: Pick<BotDelivery, "id" | "conversationId" | "text">; message?: Pick<BotChatMessage, "id" | "conversationId" | "role" | "text"> };
export type BotExecutionOutcome = { status: "completed" | "failed" | "interrupted"; text: string; error?: string };

export type BotSubmitRequest = {
  requestId: string;
  text: string;
  conversationId?: string;
  images?: PromptImage[];
  behavior?: string;
};
export type BotReportRequest = {
  conversationId: string;
  requestId?: string;
  outcome?: BotResultStatus;
  summary: string;
  evidence?: string[];
  artifacts?: string[];
};

export type BotHost = {
  createConversation(input: { kind: BotConversationRole; key: string }): Promise<{ conversationId: string }>;
  execute(input: { conversationId: string; requestId: string; text: string; images?: PromptImage[]; epoch: number; signal: AbortSignal }): Promise<BotExecutionOutcome>;
  snapshot(conversationId: string): Promise<ConversationSnapshot>;
  messages(conversationId: string): Promise<ChatMessage[]>;
  abort(conversationId: string): Promise<void>;
  resolveProject(): string;
  changed(event: BotChanged): void;
};

export interface BotApi {
  getWorkSnapshot(): Promise<WorkSnapshot>;
  submit(input: BotSubmitRequest): Promise<WorkSnapshot>;
  createWork(input: { requestId: string; title: string; text: string }): Promise<BotConversationMeta>;
  report(input: BotReportRequest): Promise<BotResult>;
  ask(input: { conversationId: string; requestId?: string; question: string }): Promise<BotAttention>;
  answer(input: { attentionId: string; answer: string }): Promise<WorkSnapshot>;
  stopConversation(input: { conversationId: string; callerConversationId?: string }): Promise<WorkSnapshot>;
  continueConversation(input: { conversationId: string }): Promise<WorkSnapshot>;
  stopAll(): Promise<WorkSnapshot>;
  getActivity(): Promise<BotActivity>;
  onChanged(listener: (event: BotChanged) => void): () => void;
  onNavigate(listener: (target: { conversationId?: string }) => void): () => void;
}

export type BotContext = {
  role: BotConversationRole;
  conversationId: string;
  active: boolean;
  phase: "running" | "reported" | "waiting" | "inactive";
  input?: { requestId: string };
  conversations?: BotConversationMeta[];
};
