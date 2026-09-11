export type OmpStatusState = "idle" | "starting" | "ready" | "needsAuth" | "error" | "missing";

export type OmpStatus = {
  state: OmpStatusState;
  binary?: string;
  cwd?: string;
  message?: string;
};

export type OmpModel = {
  provider: string;
  id: string;
};

export type SessionStats = {
  tokens?: { input?: number; output?: number; total?: number };
  cost?: number;
  toolCalls?: number;
};

export type ContextUsage = {
  tokens: number | null;
  contextWindow: number;
  percent: number | null;
};

export type TodoTask = {
  id: string;
  content: string;
  status: "pending" | "in_progress" | "completed" | "cancelled" | string;
};

export type TodoPhase = {
  id: string;
  name: string;
  tasks: TodoTask[];
};

export type OmpSessionState = {
  model?: OmpModel;
  thinkingLevel?: string;
  isStreaming: boolean;
  isCompacting?: boolean;
  sessionFile?: string;
  sessionId?: string;
  sessionName?: string;
  messageCount?: number;
  queuedMessageCount?: number;
  autoCompactionEnabled?: boolean;
  contextUsage?: ContextUsage;
  todoPhases?: TodoPhase[];
  steeringMode?: string;
  followUpMode?: string;
  interruptMode?: string;
};

export type ToolCallStatus = "running" | "done" | "error";

export type ToolCallBlock = {
  id: string;
  name: string;
  args?: unknown;
  result?: string;
  status: ToolCallStatus;
};

export type PromptImage = {
  type: "image";
  data: string;
  mimeType: string;
};

export type ChatAttachment = {
  id: string;
  kind: "image" | "file";
  name: string;
  mimeType?: string;
  dataUrl?: string;
  path?: string;
};

export type ChatMessage = {
  id: string;
  role: "user" | "assistant" | "system";
  text: string;
  thinking?: string;
  tools: ToolCallBlock[];
  createdAt: number;
  kind?: "message" | "notice" | "compact" | "goal";
  attachments?: ChatAttachment[];
};

export type SlashCommand = {
  name: string;
  description?: string;
  source?: string;
  aliases?: string[];
};

export type SubagentInfo = {
  id: string;
  name?: string;
  status?: string;
  detail?: string;
};

export type FilePreview =
  | { kind: "image"; path: string; name: string; dataUrl: string }
  | { kind: "pdf"; path: string; name: string; dataUrl: string }
  | { kind: "markdown"; path: string; name: string; text: string }
  | { kind: "html"; path: string; name: string; text: string }
  | { kind: "csv"; path: string; name: string; rows: string[][] }
  | { kind: "diff"; path: string; name: string; text: string }
  | { kind: "code"; path: string; name: string; language: string; text: string }
  | { kind: "binary"; path: string; name: string; size: number }
  | { kind: "error"; path: string; name: string; message: string };

export type PermissionRequest = {
  id: string;
  method: "confirm" | "select" | "input" | "editor";
  title?: string;
  message?: string;
  options?: string[];
  optionDetails?: Array<{ description?: string }>;
  timeout?: number;
};

export type QueueBehavior = "steer" | "followUp";

export type QueuedPrompt = {
  id: string;
  text: string;
  behavior: QueueBehavior;
};

export type RunMode = "agent" | "plan" | "goal";

export type OmpWireEvent = {
  type: string;
  [key: string]: unknown;
};

export type MacModelInput = "text" | "image" | "video" | "file";

export type ProviderModel = {
  id: string;
  name: string;
  contextWindow: number;
  maxTokens: number;
  reasoning: boolean;
  input: string[];
  thinkingLevels?: ThinkingLevel[];
  thinkingFormat?: "openai" | "zai";
  /** Where the metadata came from, shown in the editor. */
  source?: "builtin" | "models.dev" | "default" | "manual";
};

export type ProviderConfig = {
  id: string;
  kind: "builtin" | "custom";
  name: string;
  baseUrl: string;
  api: "openai-completions";
  apiKeyEnv: string;
  hasKey: boolean;
  models: ProviderModel[];
};

export type ProviderDraft = {
  name: string;
  baseUrl: string;
  apiKey: string;
};

export type ModelCandidate = ProviderModel;

export type FastVibeModel = {
  provider: string;
  id: string;
  name: string;
  thinkingLevels?: ThinkingLevel[];
};

export type ThinkingLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";

export type Project = {
  cwd: string;
  name: string;
  updatedAt: number;
};

export type Conversation = {
  id: string;
  title: string;
  /** Engine working directory. Always set: the project path, else a per-conversation temp dir. */
  cwd: string;
  /** Bound project path. Absent when the conversation is not attached to a project. */
  project?: string;
  sessionFile?: string;
  sessionId?: string;
  updatedAt: number;
  preview?: string;
};

export type WorkspaceSnapshot = {
  projects: Project[];
  conversations: Conversation[];
  activeId?: string;
};

export type ConversationOpenResult = WorkspaceSnapshot & {
  conversation: Conversation;
  messages: ChatMessage[];
  state: OmpSessionState | null;
  status: OmpStatus;
};

export type ConversationDeleteResult = WorkspaceSnapshot & {
  nextId: string | null;
};

export type ProjectAddResult = WorkspaceSnapshot & {
  project: Project;
};
