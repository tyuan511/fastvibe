import type { ChatMessage, ConversationSnapshot } from "./types.ts";

export const VIVI_BOT_ID = "vivi";
export type BotConversationRole = "router" | "worker";
export type BotInputSource = "user" | "router" | "answer" | "resume" | "report";
export type BotInputStatus = "queued" | "running" | "accepted" | "completed" | "failed" | "canceled" | "uncertain";
export type BotAttentionStatus = "pending" | "resolved" | "withdrawn";
export type BotResultStatus = "idle" | "ready" | "blocked" | "failed" | "uncertain";
export type BotDeliveryStatus = "pending" | "injected" | "delivered" | "failed";

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
  runId?: string;
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
  error?: string;
};
export type BotActivity = { running: boolean; waiting: boolean; conversationId?: string };
export type BotChanged = { revision: number; conversationId?: string; activity?: BotActivity; delivery?: BotDelivery };
export type BotExecutionOutcome = { status: "completed" | "failed" | "interrupted"; text: string; error?: string };

export type BotSubmitRequest = {
  requestId: string;
  text: string;
  conversationId?: string;
  project?: string;
  images?: unknown[];
  behavior?: string;
  taskId?: string;
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
  createConversation: (...args: any[]) => Promise<{ conversationId: string } | string>;
  execute: (...args: any[]) => Promise<BotExecutionOutcome>;
  snapshot(conversationId: string): Promise<ConversationSnapshot>;
  messages(conversationId: string): Promise<ChatMessage[]>;
  abort(conversationId: string): Promise<void>;
  resolveProject(project?: string): string;
  changed(event: BotChanged): void;
};

export interface BotApi {
  getWorkSnapshot?(): Promise<any>;
  submit(input: BotSubmitRequest): Promise<any>;
  createWork?(input: { requestId: string; title: string; text: string; project?: string }): Promise<any>;
  report?(input: BotReportRequest): Promise<any>;
  ask?(input: { conversationId: string; requestId?: string; question: string }): Promise<any>;
  /** Migration-only compatibility surface. New code must use getWorkSnapshot/stopConversation. */
  getSnapshot?(): Promise<any>;
  getTask?(input: { taskId: string; attemptId?: string }): Promise<any>;
  stopTask?(input: { taskId: string }): Promise<any>;
  retryTask?(input: { taskId: string }): Promise<any>;
  retryRun?(input: { runId: string }): Promise<any>;
  answer(input: { attentionId?: string; questionId?: string; answer: string }): Promise<any>;

  stopConversation(input: { conversationId: string; callerConversationId?: string }): Promise<any>;
  continueConversation(input: { conversationId: string }): Promise<any>;
  stopAll(): Promise<any>;
  getActivity(): Promise<BotActivity>;
  onChanged(listener: (event: BotChanged) => void): () => void;
  onNavigate(listener: (target: { conversationId?: string; runId?: string }) => void): () => void;
};

export type BotReport = LegacyBotReport;
export type BotCreateTask = LegacyBotCreateTask;
export type BotQuestion = LegacyBotQuestion;
export type BotTask = LegacyBotTask;
export type BotRun = LegacyBotRun;
export type BotAttempt = LegacyBotAttempt;
export type BotSnapshot = LegacyBotSnapshot;
export type BotTaskDetail = LegacyBotTaskDetail;

export type BotContext = {
  role: BotConversationRole;
  active: boolean;
  phase: "running" | "reported" | "waiting" | "inactive";
  conversationId?: string;
  runId?: string;
  taskId?: string;
  attemptId?: string;
  tasks?: LegacyBotTask[];
  questions?: LegacyBotQuestion[];
};


export type LegacyBotTask = { id: string; runId: string; title: string; status: string; report?: LegacyBotReport; conversationId?: string; [key: string]: unknown };
export type LegacyBotRun = { id: string; [key: string]: unknown };
export type LegacyBotAttempt = { id: string; taskId: string; conversationId?: string; [key: string]: unknown };
export type LegacyBotQuestion = { id: string; taskId: string; question: string; status?: string; [key: string]: unknown };
export type LegacyBotSnapshot = { revision: number; [key: string]: unknown };
export type LegacyBotTaskDetail = { task: LegacyBotTask; [key: string]: unknown };
export type LegacyBotReport = { outcome: "completed" | "blocked" | "failed"; summary: string; evidence: string[]; artifacts: string[] };
export type LegacyBotCreateTask = { title: string; objective: string; acceptance: string; project?: string; dependsOn?: string[] };
export type LegacyBotExecutionOutcome = BotExecutionOutcome;
