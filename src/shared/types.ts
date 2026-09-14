export type EngineStatusState = "idle" | "starting" | "ready" | "needsAuth" | "error" | "missing";

export type EngineStatus = {
  state: EngineStatusState;
  binary?: string;
  cwd?: string;
  message?: string;
};

export type EngineModel = {
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

export type EngineSessionState = {
  model?: EngineModel;
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
  /** Engine-provided structured payload, e.g. `edit`'s diff or `bash`'s truncation. */
  details?: unknown;
};

/**
 * A message's content in the order the engine produced it. The SDK returns an
 * ordered `content[]` of text / thinking / toolCall parts, and models routinely
 * interleave them ("I'll look at X" → read → "now fix Y" → edit). Flattening that
 * into `{text, tools[]}` loses the sequence and renders every tool above the prose.
 */
export type MessagePart =
  | { kind: "text"; text: string }
  | { kind: "thinking"; text: string }
  | { kind: "tool"; toolId: string };

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
  /** Interleaved render order. Optional so sessions persisted before this field still load. */
  parts?: MessagePart[];
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

export type ExtensionInfo = {
  path: string;
  name: string;
  commands: number;
  tools: number;
  error?: string;
};

export type McpServerConfig = {
  id: string;
  name: string;
  enabled: boolean;
  transport: "stdio" | "http";
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  url?: string;
};

export type McpServerStatus = McpServerConfig & { connected: boolean; tools: string[]; error?: string };

export type SkillInfo = {
  name: string;
  description: string;
  filePath: string;
  baseDir: string;
  scope: "user" | "project" | "temporary";
  source: string;
  /** True when the skill lives under FastVibe's isolated agentDir/skills. */
  removable: boolean;
};

export type SkillDraft = {
  name: string;
  description: string;
  body: string;
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

export type QueuePauseReason = "stopped" | "error";

export type QueuedPrompt = {
  id: string;
  text: string;
  behavior: QueueBehavior;
  attachments?: ChatAttachment[];
};

export type RunMode = "agent" | "plan" | "goal";

export type EngineEvent = {
  type: string;
  [key: string]: unknown;
};

export type ProviderModel = {
  id: string;
  name: string;
  contextWindow: number;
  maxTokens: number;
  reasoning: boolean;
  input: string[];
  thinkingLevels?: ThinkingLevel[];
  thinkingFormat?: "openai" | "zai";
  /**
   * Where the metadata came from. `native` is a pi-coding-agent built-in model
   * (cost and request compat included); `default` means models.dev had no entry.
   */
  source?: "models.dev" | "native" | "default";
};

/** Streaming APIs offered in settings; values match pi-coding-agent's `api` field. */
export const PROVIDER_APIS = ["openai-completions", "openai-responses", "anthropic-messages"] as const;

export type ProviderApi = (typeof PROVIDER_APIS)[number];

/**
 * `builtin` is FastVibe's own endpoint, `native` is a pi-coding-agent built-in
 * provider configured with an API key, and `custom` is a user-typed endpoint.
 *
 * The distinction matters to the engine: native providers' models already live in
 * the SDK registry, so they are never written to `models.json`.
 */
export type ProviderKind = "builtin" | "native" | "custom";

export type ProviderConfig = {
  id: string;
  kind: ProviderKind;
  name: string;
  baseUrl: string;
  /** Native providers report the SDK's own api (e.g. `google-generative-ai`). */
  api: string;
  apiKeyEnv: string;
  hasKey: boolean;
  enabled: boolean;
  models: ProviderModel[];
};

/** A pi-coding-agent built-in provider offered in 添加供应商. */
export type NativeProviderConfig = {
  id: string;
  name: string;
  api: string;
  baseUrl: string;
  models: ProviderModel[];
  /** False when it needs OAuth or cloud credentials rather than a pasted key. */
  supported: boolean;
  unsupportedReason?: string;
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

export type PermissionMode = "ask" | "smart" | "full";

export type Project = {
  cwd: string;
  name: string;
  updatedAt: number;
};

export type Conversation = {
  id: string;
  title: string;
  /** Engine working directory: the project path, else the shared scratch workspace. */
  cwd: string;
  /** Bound project path. Absent when the conversation is not attached to a project. */
  project?: string;
  sessionFile?: string;
  sessionId?: string;
  updatedAt: number;
  preview?: string;
  worktree?: { path: string; branch: string };
  /** Hidden from the left sidebar; lives in the right side pane. */
  kind?: "side-chat";
  /** Parent conversation for a side-chat tab. */
  parentId?: string;
};

export type WorkspaceSnapshot = {
  projects: Project[];
  conversations: Conversation[];
  activeId?: string;
};

export type ConversationOpenResult = WorkspaceSnapshot & {
  conversation: Conversation;
  messages: ChatMessage[];
  state: EngineSessionState | null;
  status: EngineStatus;
};

export type MultiRunRequest = {
  project?: string;
  prompt: string;
  models: Array<{ provider: string; modelId: string }>;
  name?: string;
  isolate?: boolean;
};

export type MultiRunResult = WorkspaceSnapshot & {
  conversationIds: string[];
};

/** Pushed when a conversation finishes initialising in the background. */
export type ConversationReadyEvent = {
  id: string;
  messages: ChatMessage[];
  state: EngineSessionState | null;
  status: EngineStatus;
};

export type ConversationDeleteResult = WorkspaceSnapshot & {
  nextId: string | null;
};

export type ProjectAddResult = WorkspaceSnapshot & {
  project: Project;
};

/** Windows supported by the 使用统计 settings pane. */
export type UsageRange = "7d" | "30d" | "90d" | "365d" | "all";

/** One day of aggregated engine usage. `cost` is USD as reported by the provider. */
export type UsageMetrics = {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  /** Total tokens (input + output + cache), as reported by the SDK. */
  tokens: number;
  cost: number;
  /** Assistant turns, i.e. requests. Drives the activity heatmap. */
  requests: number;
  toolCalls: number;
};

export type UsageDay = UsageMetrics & { date: string };

export type UsageTotals = UsageMetrics & {
  /** Days with at least one request inside the window. */
  activeDays: number;
};

export type UsageModelBreakdown = UsageMetrics & {
  provider: string;
  model: string;
};

export type UsageStats = {
  range: UsageRange;
  /** Inclusive local-date window (`YYYY-MM-DD`) covered by `days`. */
  from: string;
  to: string;
  totals: UsageTotals;
  /** Only days with activity, ascending; gaps are filled by the renderer. */
  days: UsageDay[];
  /** Models seen in the window, highest token usage first. */
  models: UsageModelBreakdown[];
  /** Session transcripts that contributed to the totals. */
  sessions: number;
};
