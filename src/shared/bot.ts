import type { ChatAttachment, ChatMessage, ConversationSnapshot, PromptImage } from "./types.ts";

export const VIVI_BOT_ID = "vivi";
export type BotConversationRole = "router" | "worker";
export type BotInputSource = "user" | "router" | "answer" | "resume" | "report";
export type BotInputStatus = "queued" | "running" | "accepted" | "completed" | "failed" | "canceled" | "uncertain";
export type BotAttentionStatus = "pending" | "resolved" | "withdrawn";
export type BotResultStatus = "idle" | "ready" | "blocked" | "failed" | "uncertain";
export type BotDeliveryStatus = "pending" | "injected" | "delivered" | "failed";

export type BotProgressPhase = "accepted" | "understanding" | "planning" | "delegating" | "working" | "waiting" | "summarizing" | "completed" | "failed" | "interrupted" | "paused" | "idle";
export type BotProgressUpdate = {
  phase: "understanding" | "planning" | "working" | "summarizing";
  text: string;
  /** A real intermediate accomplishment, not a heartbeat or a promise. */
  milestone?: boolean;
};
export type BotProgressRequest = BotProgressUpdate & { conversationId: string; requestId?: string; epoch?: number };
export type BotProgress = {
  conversationId: string;
  inputId?: string;
  rootInputId?: string;
  role: BotConversationRole;
  title?: string;
  phase: BotProgressPhase;
  detail?: string;
  startedAt: number;
  updatedAt: number;
  queuedCount: number;
  result?: BotResult;
};

export type BotChatMessage = {
  id: string;
  conversationId: string;
  role: "user" | "assistant";
  text: string;
  attachments?: ChatAttachment[];
  inputId?: string;
  createdAt: number;
  kind?: "message" | "progress" | "status" | "result";
  title?: string;
  result?: BotResult;
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
  startedAt?: number;
  completedAt?: number;
  rootInputId?: string;
  intent?: "status";
  /** Result updates explicitly included in a resumed Router turn. */
  deliveryIds?: string[];
  progress?: BotProgressUpdate & { updatedAt: number };
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
  /** Derived from durable input receipts; optional for older hosts. */
  progress?: BotProgress[];
  error?: string;
};
export type BotActivity = { running: boolean; waiting: boolean; conversationId?: string };
export type BotChanged = {
  revision: number;
  conversationId?: string;
  activity?: BotActivity;
  delivery?: Pick<BotDelivery, "id" | "conversationId" | "text">;
  /** Explicit Router replies only; progress/status/result rows are read via the snapshot. */
  message?: Pick<BotChatMessage, "id" | "conversationId" | "role" | "text">;
};
export type BotExecutionOutcome = { status: "completed" | "failed" | "interrupted"; text: string; error?: string };

export type BotSubmitRequest = {
  requestId: string;
  text: string;
  conversationId?: string;
  images?: PromptImage[];
  behavior?: string;
  intent?: "status";
};
export type BotReportRequest = {
  conversationId: string;
  requestId?: string;
  epoch?: number;
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
  input?: { requestId: string; epoch?: number };
  conversations?: BotConversationMeta[];
  progress?: BotProgress[];
  results?: BotResult[];
  attention?: BotAttention[];
};
