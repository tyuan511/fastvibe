export type EngineStatusState = "idle" | "starting" | "ready" | "error" | "missing";

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
  tokens?: {
    input?: number;
    output?: number;
    cacheRead?: number;
    cacheWrite?: number;
    total?: number;
  };
  cost?: number;
  toolCalls?: number;
  /** Number of model steps (assistant turns) taken in this conversation. */
  steps?: number;
  /** Wall-clock time in milliseconds: whole request vs. model generation vs. tools. */
  timing?: { totalMs: number; modelMs: number; toolMs: number };
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
  /**
   * Which conversation this snapshot describes.
   *
   * A state reply travels one IPC hop, so it can arrive after the user opened
   * another chat. The renderer keys its sidebar run map per conversation and
   * refuses to let a reply speak for a chat it does not belong to.
   */
  conversationId?: string;
  model?: EngineModel;
  thinkingLevel?: string;
  isStreaming: boolean;
  /**
   * The engine's own run flag: true from the run's first `agent_start` to the
   * `agent_settled` that closes its whole post-run sequence.
   *
   * `agent_end` is deliberately *not* the end of it: the SDK fires that event before
   * it retries a failed request (after an exponential backoff), auto-compacts, or
   * continues with messages an `agent_end` handler queued — and each of those starts
   * another `agent_start` inside the same run. Ending the flag at `agent_end`
   * reported a chat as idle for the whole retry/compaction window and re-lit it when
   * the next attempt began.
   *
   * A compaction is reported separately (`isCompacting`): it is work too, and the
   * sidebar's 运行中 mark covers both, so the renderer unions them.
   */
  running?: boolean;
  /**
   * A compaction of this conversation is in flight.
   *
   * The SDK also compacts with no run at all (`/compact`, and the threshold check a
   * fresh prompt runs before it is sent), so this is what says a chat the run flag
   * does not cover is still busy.
   */
  isCompacting?: boolean;
  /**
   * The transcript is parked on a message the engine can continue from.
   *
   * This is the composer's 继续 control: an abnormal stop (a failure, a user abort, an
   * output-limit truncation, or a turn cut off before its first token) leaves the
   * transcript on a message `continueTurn` can re-enter from — see `canResumeRun`.
   *
   * It is derived from the transcript rather than from a live event on purpose. The
   * event that reports an abort is a transient stream payload a client can miss
   * entirely (a background chat, a window reload, a socket that was gone), and the
   * affordance then depended on having watched it happen. The transcript survives all
   * three, so the button reappears however this client got here.
   *
   * A run *in flight* is resumable by this rule too — `session.messages` only grows on
   * `message_end`, so mid-run it ends on a `toolResult` awaiting the next round trip —
   * so the reader must pair it with 「this chat is idle」 (`running` / `isCompacting`),
   * which is what the composer does.
   */
  canResume?: boolean;
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
 * Wall-clock bounds of one thinking block, measured by Main as it streamed. The
 * engine's transcript records a single request-start timestamp per assistant
 * message, so these bounds are the only record of how long a block thought — and
 * because they are instants rather than a duration, the elapsed time can be
 * recomputed at any point (including while the block is still open, from `now`).
 */
export type ThinkingTiming = { startedAt: number; endedAt?: number };

/**
 * A message's content in the order the engine produced it. The SDK returns an
 * ordered `content[]` of text / thinking / toolCall parts, and models routinely
 * interleave them ("I'll look at X" → read → "now fix Y" → edit). Flattening that
 * into `{text, tools[]}` loses the sequence and renders every tool above the prose.
 */
export type MessagePart =
  | { kind: "text"; text: string }
  | ({ kind: "thinking"; text: string } & Partial<ThinkingTiming>)
  /**
   * A model switch, drawn as a divider reading 「模型已切换至 <to>」. It is a *part*
   * rather than a row of its own because a switch lands mid-reply as often as between
   * turns: consecutive engine messages of one reply are merged into a single row, so the
   * divider belongs between two parts of the reply that spans the switch — and a row
   * would split that reply into two blocks (two footers), while a part keeps it one turn.
   * It exists only where the new model actually ran, and both sides are derived from the
   * replies themselves (`#insertModelSwitches` / `#announceModelUse` in
   * `src/main/pi/process-manager.ts`), so a pick that no reply followed draws nothing.
   */
  | { kind: "model"; from?: EngineModel; to: EngineModel }
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
  /** In-memory text for a long paste represented as a file-style chip. */
  text?: string;
};

export type ChatMessage = {
  id: string;
  role: "user" | "assistant" | "system";
  text: string;
  thinking?: string;
  tools: ToolCallBlock[];
  /** Interleaved render order. Optional so sessions persisted before this field still load. */
  parts?: MessagePart[];
  /**
   * The engine records one timestamp per message — the moment the *request* started
   * — so `createdAt` is when a reply began, not when it finished. This is that
   * completion instant, measured when the message was persisted to its session
   * entry, so a footer can report the end time and the elapsed duration.
   */
  completedAt?: number;
  createdAt: number;
  kind?: "message" | "notice" | "compact" | "custom";
  /** Extension custom message (`pi.sendMessage`): the plugin's own type id. */
  customType?: string;
  /** Structured spans of the extension's registered message renderer. */
  runs?: TuiRun[][];
  attachments?: ChatAttachment[];
  /** Model/request failure for this assistant turn. Absent on success or user abort. */
  error?: string;
  /** A transient provider failure that the engine is currently retrying. */
  retry?: {
    attempt: number;
    maxAttempts?: number;
    delayMs?: number;
    error?: string;
  };
  /** Present when `kind` is `"compact"`: running / finished / cancelled compaction. */
  compact?: CompactInfo;
};

export type CompactReason = "manual" | "threshold" | "overflow";

export type CompactStatus = "running" | "done" | "aborted" | "error";

export type CompactInfo = {
  status: CompactStatus;
  reason?: CompactReason;
  tokensBefore?: number;
  tokensAfter?: number;
  error?: string;
};

export type SlashCommand = {
  name: string;
  description?: string;
  source?: string;
  aliases?: string[];
};

export type SubagentConfig = {
  /** Stable role id used in the subagent tool and custom agent filename. */
  id: string;
  name: string;
  description: string;
  tools: string[];
  /** provider/model, or undefined to inherit the parent agent's model. */
  model?: string;
  /** Reasoning effort. Legacy templates without one migrate to `medium`. */
  thinkingLevel: ThinkingLevel;
  systemPrompt: string;
  source: "builtin" | "custom";
};

export type SubagentDraft = {
  /** Omit for a new custom agent. Builtins may only update model/reasoning overrides. */
  id?: string;
  name: string;
  description: string;
  tools: string[];
  model?: string;
  thinkingLevel?: ThinkingLevel;
  systemPrompt: string;
};

export type SubagentInfo = {
  id: string;
  /** The conversation whose tool call spawned this run; scopes it to its own pane. */
  conversationId?: string;
  /** Stable role identifier when this run comes from a built-in agent. */
  agent?: string;
  name?: string;
  description?: string;
  mode?: "single" | "parallel" | "chain" | string;
  status?: string;
  detail?: string;
  progress?: number;
  startedAt?: number;
  endedAt?: number;
  error?: string;
  /**
   * The run's own session, so its pane can draw the read-only composer the main
   * thread has: which model it is on, its thinking level, and how full its context
   * window is. Pushed as `subagent_state` (the window moves every turn), never
   * derived from the transcript — the engine holds these, not the messages.
   */
  model?: EngineModel;
  thinkingLevel?: string;
  contextUsage?: ContextUsage;
};

export type ExtensionInfo = {
  path: string;
  name: string;
  commands: number;
  tools: number;
  error?: string;
};

/**
 * A pi package installed into FastVibe's isolated agentDir (see ExtensionManager).
 * `source` is the pi package spec (`npm:<name>`, `git:<url>`, …) as written to the
 * SDK's own settings.json — never FastVibe's `settings.json`.
 */
export type ExtensionPackage = {
  source: string;
  scope: "user" | "project";
  installedPath?: string;
  /** Bundled with FastVibe and auto-installed on first launch. */
  builtin: boolean;
  /** True while a configured package's extension files load in the active session. */
  loaded?: boolean;
  commands?: number;
  tools?: number;
  error?: string;
};

/** One entry of pi's public package catalog (https://pi.dev/packages). */
export type MarketPackage = {
  name: string;
  description: string;
  author?: string;
  types: string[];
  downloads?: number;
  /** Epoch millis of the last publish, from the card's `data-package-date`. */
  updatedAt?: number;
  version?: string;
  npmUrl?: string;
  repoUrl?: string;
};

export type MarketPackageQuery = {
  query?: string;
  /** extension | skill | theme | prompt; empty means all. */
  type?: string;
  sort?: "downloads" | "recent" | "name";
  page?: number;
};

export type MarketPackagePage = {
  packages: MarketPackage[];
  query: string;
  type: string;
  sort: string;
  page: number;
  total?: number;
  totalPages?: number;
};

/**
 * Lookup tables from the Material Icon Theme package: names/extensions map to an
 * icon name served under the `fastvibe-icon` scheme. `file`/`folder` are fallbacks.
 */
/** One entry in a directory listing for the right-hand file tree. */
export type DirEntry = {
  name: string;
  path: string;
  kind: "file" | "directory";
};

export type FileIconMapping = {
  /** Lowercased extension (may contain dots, e.g. `d.ts`) → icon name. */
  fileExtensions: Record<string, string>;
  /** Lowercased file name → icon name. */
  fileNames: Record<string, string>;
  file: string;
  folder: string;
  folderExpanded: string;
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

/** A local Chromium profile that can be used as the source for browser data import. */
export type BrowserProfileInfo = {
  id: string;
  browser: string;
  name: string;
  path: string;
  cookiePath: string;
};

/**
 * One browser-use request. The tool schema in the `browser-use` extension, the
 * main-process bridge and the side pane's webview all speak exactly this, so a
 * new field has to be added here once — a copy that lags behind is what made
 * `ref` / `newTab` reach the renderer untyped.
 *
 * `ref` is stamped by a snapshot (`data-fv-ref`), `newTab` forces a second tab
 * instead of navigating the one on screen, and `timeoutMs` is the main-process
 * bridge's budget for the whole round trip.
 * `conversationId` is stamped by the host so a background chat's `browser_open`
 * lands in that chat's side pane instead of hijacking the one on screen.
 */
export type BrowserRequest = {
  action: string;
  tabId?: string;
  url?: string;
  selector?: string;
  ref?: string;
  text?: string;
  key?: string;
  script?: string;
  newTab?: boolean;
  timeoutMs?: number;
  conversationId?: string;
};

/**
 * One `computer_*` tool call on its way to Cua Driver.
 *
 * A flat bag rather than a discriminated union, matching `BrowserRequest`: the extension
 * that builds these is loaded from outside the bundle and cannot import this file, so the
 * type documents the contract for the main-process half and nothing enforces it across
 * the boundary anyway.
 */
export type ComputerRequest = {
  action: string;
  /**
   * For `action: "batch"`: the sequence to run, in order, stopping at the first failure.
   *
   * Driving a GUI one tool call at a time costs a model round trip, a confirmation and a
   * screenshot per click. A sequence collapses the predictable runs into one call.
   */
  steps?: ComputerRequest[];
  /** Process id of the target app, from `computer_list_apps`. */
  pid?: number;
  /** Window id as a decimal string — the driver's ids are `bigint` and JSON is not. */
  windowId?: string;
  x?: number;
  y?: number;
  text?: string;
  key?: string;
  keys?: string[];
  modifiers?: string[];
  /** Opaque handle for an element from `computer_window_state`, preferred over x/y. */
  elementToken?: string;
  button?: "left" | "right" | "middle";
  count?: number;
  direction?: "up" | "down" | "left" | "right";
  amount?: number;
  /** Menu item path, e.g. ["File", "Save"]. */
  path?: string[];
  query?: string;
  /** Opt in to stealing focus. Background delivery is the default. */
  foreground?: boolean;
  includeScreenshot?: boolean;
  maxElements?: number;
  onScreenOnly?: boolean;
  timeoutMs?: number;
  conversationId?: string;
};

export type ComputerResult = {
  text: string;
  /** Base64 payloads, shaped like the SDK's own image content parts. */
  images: Array<{ mimeType: string; data: string }>;
  structured?: string;
};

/**
 * Whether this machine will let FastVibe drive it.
 *
 * `ready` is the only field a caller should branch on; the two booleans exist so the UI
 * can name the toggle that is still off rather than saying "permission denied".
 *
 * `available` is a different question from `ready`: it is false when the native engine
 * could not be loaded at all (an architecture with no native package), where no amount
 * of granting will help and the UI should say so instead of offering a button.
 */
export type ComputerPermissionStatus = {
  platform: string;
  accessibility: boolean;
  screenRecording: boolean;
  ready: boolean;
  available: boolean;
  /** Why the engine is unavailable, when it is. */
  error?: string;
};

/** The two macOS grants the driver needs, named as `ComputerPermissionStatus` keys. */
export type GrantPermission = "accessibility" | "screenRecording";

/**
 * Where the guided grant flow has got to.
 *
 * `step`/`total` count the permissions this run still had to collect when it started, so
 * a machine that already had Screen Recording reports 1/1 rather than a misleading 2/2.
 */
export type GrantFlowState = {
  active: boolean;
  permission?: GrantPermission;
  step: number;
  total: number;
};

/** One running application, as the Settings allow-list picker lists them. */
export type ComputerAppInfo = {
  pid: number;
  name: string;
  bundleId?: string;
  active: boolean;
};

/**
 * 电脑操控 preferences.
 *
 * Read by the bridge on every call rather than cached, so flipping a switch applies to
 * a run that is already going — the same contract the permission modes have.
 */
export type ComputerSettings = {
  /** Master switch. Off means the `computer_*` tools refuse before touching the driver. */
  enabled: boolean;
  /** Clipboard is shared by every application, so it gets its own switch. */
  clipboard: boolean;
  /** Prefer delivery that does not take focus from whatever the user is doing. */
  preferBackground: boolean;
  /**
   * Applications whose windows never raise a confirmation, by bundle id (macOS) or
   * executable name. "Always allowed" in the sense of the confirmation dialog only —
   * it does not widen what the tools can do.
   */
  allowedApps: string[];
};

export type BrowserImportResult = {
  browser: string;
  profile: string;
  cookies: number;
  encryptedCookiesSkipped: number;
  message: string;
};

/** Transient extension notice, surfaced from `ctx.ui.notify()`. */
export type ExtensionNoticeLevel = "info" | "warning" | "error";

export type ExtensionNotice = {
  id: string;
  message: string;
  level: ExtensionNoticeLevel;
  createdAt: number;
};

/**
 * One styled span of a TUI line. `fg`/`bg` are pi theme color names resolved to
 * the app's semantic tokens; `color`/`bgColor` are raw CSS fallbacks for colors
 * the theme has no name for (e.g. a plugin's own chalk output).
 */
export type TuiRun = {
  text: string;
  fg?: string;
  bg?: string;
  color?: string;
  bgColor?: string;
  bold?: boolean;
  dim?: boolean;
  italic?: boolean;
  underline?: boolean;
  strike?: boolean;
};

/**
 * A widget an extension set via `ctx.ui.setWidget()`. String arrays carry `lines`;
 * a pi-tui component factory is rendered host-side into `runs` so the GUI shows
 * the same dashboard the terminal would.
 */
export type ExtensionWidget = {
  key: string;
  lines: string[];
  runs?: TuiRun[][];
  placement?: string;
};

/** One entry of a `questions` prompt (FastVibe's single-panel multi-question UI). */
export type PermissionQuestion = {
  question: string;
  header?: string;
  options?: string[];
  optionDetails?: Array<{ description?: string }>;
  allowOther?: boolean;
};

export type PermissionRequest = {
  id: string;
  /** Conversation that owns the blocking extension request. */
  conversationId?: string;
  method: "confirm" | "select" | "input" | "editor" | "questions" | "plan_review" | "custom";
  title?: string;
  message?: string;
  /** Placeholder for `input` dialogs. */
  placeholder?: string;
  options?: string[];
  optionDetails?: Array<{ description?: string }>;
  /** Multi-question payload for `method: "questions"`. */
  questions?: PermissionQuestion[];
  timeout?: number;
  /** Plan document metadata shown by the plan review panel. */
  plan?: { path: string; title: string; summary: string };
};

export type QueueBehavior = "steer" | "followUp";

export type QueuePauseReason = "stopped" | "error";

export type QueuedPrompt = {
  /** Stable Main-issued identity; queue operations always address this id. */
  id: string;
  conversationId: string;
  /** Text shown in the queue tray. */
  text: string;
  behavior: QueueBehavior;
  attachments?: ChatAttachment[];
  /** True while the exact message object is still waiting in the SDK queue. */
  sending?: boolean;
  /** True only after the SDK agent loop has dequeued the object for injection. */
  claimed?: boolean;
  /** Exact engine payload, retained so a pending item survives a process restart. */
  sentText?: string;
};

export type ConversationQueueState = {
  conversationId: string;
  /** Monotonic Main revision; clients ignore an older RPC reply after a newer push. */
  revision: number;
  items: QueuedPrompt[];
  pause: QueuePauseReason | null;
};

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
  /**
   * Per-model streaming API. Absent means "inherit the provider's api" — a gateway
   * can serve `/chat/completions` and `/responses` models under one base URL, so a
   * single provider-level api is not always enough.
   */
  api?: ProviderApi;
  /**
   * Provider-side value for a thinking level, i.e. pi-ai's `thinkingLevelMap`. Only
   * set where the provider names a level differently — and, because pi only offers
   * `xhigh`/`max` when mapped, it always carries an entry for those two levels.
   */
  effortMap?: Partial<Record<ThinkingLevel, string>>;
  /** Price per million tokens, as reported by models.dev. Absent means unknown. */
  cost?: ModelCost;
  /**
   * Long-context price steps, ascending. `cost` is the entry price — what a request
   * whose prompt fits the first threshold pays — and each tier replaces it once the
   * prompt grows past its `over`. Empty for the (majority) models with a flat price.
   */
  costTiers?: CostTier[];
  /**
   * Set when the user tuned a model (name, protocol, context, output) in the edit
   * dialog. A later 同步模型 keeps those fields instead of restoring the fetched
   * values, so a re-fetch cannot silently undo the edit.
   */
  edited?: boolean;
  thinkingFormat?: "openai" | "zai";
  /**
   * Where the metadata came from. `native` is a pi-coding-agent built-in model
   * (cost and request compat included); `default` means models.dev had no entry.
   */
  source?: "models.dev" | "native" | "default";
};

/** Streaming APIs offered in settings; values match pi-coding-agent's `api` field. */
export const PROVIDER_APIS = ["openai-completions", "openai-responses", "anthropic-messages", "google-generative-ai"] as const;

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
  /**
   * A stored OAuth credential, i.e. a subscription login (`/login`'s equivalent).
   * Kept apart from `hasKey` because the two are different credentials: an API key
   * sits in the engine's in-memory overlay and is read *before* the stored token, so
   * a provider holding both is billing the key, not the subscription.
   */
  hasOAuth: boolean;
  /** False for a built-in the SDK only exposes behind a subscription login. */
  supportsKey: boolean;
  /** The subscription login this provider offers, when the SDK ships one. */
  oauth?: NativeProviderOAuth;
  enabled: boolean;
  models: ProviderModel[];
};

/** One rolling allowance returned for a ChatGPT-backed OpenAI Codex account. */
export type OpenAIQuotaWindow = {
  id: string;
  /** Primary/secondary identify the account-wide windows; additional is model-specific. */
  kind: "primary" | "secondary" | "additional";
  /** Provider-supplied name for an additional model-specific allowance. */
  name?: string;
  usedPercent: number;
  /** Epoch milliseconds. */
  resetAt?: number;
  windowSeconds?: number;
};

/** Account allowance shown only on the two first-party OpenAI provider pages. */
export type OpenAIAccountQuota =
  | {
      providerId: "openai-codex";
      kind: "codex";
      fetchedAt: number;
      plan?: string;
      windows: OpenAIQuotaWindow[];
      credits?: { balance?: number; hasCredits?: boolean; unlimited?: boolean };
    }
  | {
      providerId: "openai";
      kind: "api-credits";
      fetchedAt: number;
      totalGranted: number;
      totalUsed: number;
      totalAvailable: number;
      /** Epoch milliseconds for the next expiring credit grant. */
      nextExpiry?: number;
    };

/** A provider CC Switch can hand FastVibe. Keys stay in Main. */
export type CcSwitchCandidate = {
  id: string;
  name: string;
  appLabel: string;
  baseUrl: string;
  api: ProviderApi;
  modelCount: number;
  importable: boolean;
  reason?: string;
};

export type CcSwitchScan = {
  found: boolean;
  path: string;
  candidates: CcSwitchCandidate[];
};

/**
 * The subscription (OAuth) login a pi-coding-agent built-in provider advertises.
 * Everything here comes from the SDK's own provider definition, so an SDK upgrade
 * that adds or renames a login reaches the UI without a change in FastVibe.
 */
export type NativeProviderOAuth = {
  /** e.g. `Anthropic (Claude Pro/Max)`. */
  name: string;
  /** True when the login is backed by a provider subscription rather than a key mint. */
  isSubscription: boolean;
  /** Button copy the SDK suggests, e.g. `Sign in with Kimi Code`. */
  loginLabel?: string;
  /**
   * Set when the login's usage does **not** draw on the subscription's included
   * limits but is billed per token elsewhere — `url` is where the account enables
   * and checks that balance.
   *
   * A Claude Pro/Max login is the one that works this way: a third-party harness's
   * request is charged against the account's «extra usage» balance, and refused
   * outright while that balance is not enabled (`third-party apps not draw from your
   * extra usage`). Absent for a login that simply bills through its own subscription
   * (Copilot, ChatGPT, Kimi, Grok).
   */
  extraUsage?: { url: string };
};

/** A pi-coding-agent built-in provider offered in 添加供应商. */
export type NativeProviderConfig = {
  id: string;
  name: string;
  api: string;
  baseUrl: string;
  models: ProviderModel[];
  /** Configurable by pasting an API key. */
  supportsKey: boolean;
  /** A subscription login, when the SDK provider declares one. */
  oauth?: NativeProviderOAuth;
  /** False when neither a key nor a login can configure it (cloud credentials only). */
  supported: boolean;
  unsupportedReason?: string;
};

/**
 * One line of an in-flight OAuth login, mirroring pi-ai's `AuthEvent` plus the
 * prompt round-trip FastVibe has to carry across IPC.
 *
 * `auth_url` / `device_code` are the two «send the user to the provider» shapes;
 * a flow can use either, and the host opens the URL in the system browser as well
 * as showing it, so a headless/misconfigured browser is still recoverable by hand.
 */
export type OAuthEvent =
  | { type: "auth_url"; url: string; instructions?: string }
  | {
      type: "device_code";
      userCode: string;
      verificationUri: string;
      intervalSeconds?: number;
      expiresInSeconds?: number;
    }
  | { type: "info"; message: string; links?: readonly { url: string; label?: string }[] }
  | { type: "progress"; message: string }
  /** The flow is waiting for an answer; `prompt.id` addresses the reply. */
  | { type: "prompt"; prompt: OAuthPrompt }
  /** A prompt the flow no longer needs — the loopback callback won the race. */
  | { type: "prompt_cancelled"; promptId: string };

export type OAuthPrompt = {
  id: string;
  kind: "text" | "secret" | "manual_code" | "select";
  message: string;
  placeholder?: string;
  /** Present for `select`, whose answer is the chosen option's `id`. */
  options?: readonly { id: string; label: string; description?: string }[];
};

export type OAuthEventPayload = { id: string; event: OAuthEvent };

export type OAuthLoginResult = { ok: boolean; error?: string };

export type ProviderDraft = {
  name: string;
  baseUrl: string;
  apiKey: string;
};

export type ModelCandidate = ProviderModel;

/** Price per million tokens. Written to `models.json`, where the engine prices a run. */
export type ModelCost = {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
};

/**
 * One step of a long-context price ladder: a request whose prompt exceeds `over`
 * tokens is billed at `cost` instead of the model's entry price.
 */
export type CostTier = {
  /** Prompt-token threshold (input plus both cache buckets) the step starts above. */
  over: number;
  cost: ModelCost;
};

/**
 * A model's list price: the entry price plus any long-context ladder. Everything the
 * app needs to price a turn, and the shape `priceUsage` takes.
 */
export type ModelPrice = {
  cost?: ModelCost;
  costTiers?: CostTier[];
};

export type FastVibeModel = {
  provider: string;
  /** Display name of the provider, e.g. `FastVibe` / `Packy`. */
  providerName: string;
  id: string;
  name: string;
  thinkingLevels?: ThinkingLevel[];
};

/**
 * The thinking levels this app can request, matching pi-ai's own set. `xhigh` and
 * `max` are the two top levels: pi only offers either when the model maps it, so
 * both always carry an `effortMap` entry (see `providers.ts`).
 */
export const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;

export type ThinkingLevel = (typeof THINKING_LEVELS)[number];

/**
 * The levels a model can actually be tuned for, i.e. everything but `off`. `off` is
 * deliberately not among them: FastVibe never asks a provider to *disable* thinking.
 * A model that thinks by default 400s on `reasoning: false` / `thinking: disabled`,
 * and the engine's own default already covers "the model decides", so the option is
 * not stored per model, not mapped in `models.json` and not offered in any menu.
 */
export const THINKING_EFFORT_LEVELS: ThinkingLevel[] = ["minimal", "low", "medium", "high", "xhigh", "max"];

/** Effort menu a model without its own levels falls back to. */
export const DEFAULT_THINKING_LEVELS: ThinkingLevel[] = ["low", "medium", "high"];

/** Input modality bits shared by `ProviderModel.input` and the engine's `models.json`. */
export const INPUT_MODALITIES = ["text", "image", "video", "file"] as const;

export type InputModality = (typeof INPUT_MODALITIES)[number];

export type PermissionMode = "ask" | "smart" | "full";

/**
 * 系统通知: which desktop notifications the app may raise.
 *
 * `done` = a run finished, `approval` = a chat is parked on a tool approval while the
 * window is unfocused, `off` = none. Main reads the value from `settings.json` on every
 * event so a change lands immediately; an absent or malformed value means `done`.
 */
export const NOTIFICATION_PREFERENCES = ["done", "approval", "off"] as const;

export type NotificationPreference = (typeof NOTIFICATION_PREFERENCES)[number];

export function isNotificationPreference(value: unknown): value is NotificationPreference {
  return typeof value === "string" && (NOTIFICATION_PREFERENCES as readonly string[]).includes(value);
}

export type Project = {
  cwd: string;
  name: string;
  /** When the project was first added. Drives the sidebar's default order, which
   *  must not change when a chat inside it is opened, renamed, or updated. */
  createdAt: number;
  /** Last mutation time (rename, new conversation, …). Not used for ordering. */
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
  /** When the conversation was first created. Drives sidebar order, which must not
   *  change when a chat is merely opened, renamed, or updated. */
  createdAt: number;
  /** Last mutation time (title, project, session file, …). Not used for ordering. */
  updatedAt: number;
  preview?: string;
  /**
   * Set when the chat was imported from another agent, so re-importing the same
   * foreign session is recognisable instead of silently duplicating it.
   */
  importedFrom?: { source: ImportSourceId; sourceId: string };
  worktree?: { path: string; branch: string };
  /** Hidden from the left sidebar; lives in the right side pane. */
  kind?: "side-chat";
  /** Parent conversation for a side-chat tab. */
  parentId?: string;
  /** User chose this title; do not replace it with an auto-generated one. */
  titleManual?: boolean;
};

/** A conversation whose transcript matched a command-palette query. */
export type ConversationSearchHit = {
  id: string;
  /** Short excerpt around the first match, for the palette's secondary line. */
  snippet?: string;
};

export type WorkspaceSnapshot = {
  projects: Project[];
  conversations: Conversation[];
  activeId?: string;
};

/**
 * One conversation as it stands right now — everything needed to draw it, including a
 * turn still in flight.
 *
 * `messages` already carries the turn's content: the engine appends the reply being
 * streamed as a trailing `running:` row, with its unfinished tool calls marked running.
 * What it cannot carry is state that never becomes a message — a prompt parked waiting
 * for an answer, a notice, a todo list, a retry banner — and that is what the other two
 * fields are for. **`turnEvents` therefore holds no stream deltas**: replaying those
 * onto a transcript that has already accumulated them would draw the reply twice.
 *
 * Every field is read at one instant, so they cannot disagree with each other.
 */
/**
 * A transcript read that only carries what the reader is missing.
 *
 * `tail` starts at `anchorId` — a row the reader already has — so it is spliced in
 * from that row and everything above keeps the identity (and therefore the rendered
 * output) it already had. `full` is the whole transcript, for when the anchor is no
 * longer on the branch at all.
 */
export type TranscriptTail =
  | { mode: "tail"; anchorId: string; messages: ChatMessage[] }
  | { mode: "full"; messages: ChatMessage[] };

export type ConversationSnapshot = {
  conversationId: string | null;
  /** The transcript, including the reply in flight while `running`. */
  messages: ChatMessage[];
  /** Whether a run or a compaction is in flight for this conversation. */
  running: boolean;
  /** Main-owned durable message queue at the same instant as the transcript. */
  queue: ConversationQueueState;
  /**
   * Extension prompts parked waiting for a human, as the `extension_ui_request` events
   * that announced them. A prompt is delivered only as an event, so without these a
   * client that connected afterwards would show a chat that had silently stopped.
   */
  pendingUi: Array<Record<string, unknown>>;
  /**
   * The current turn's non-transcript events, oldest first, for the client to fold with
   * the same reducer it uses for live ones. Empty when nothing is running.
   */
  turnEvents: Array<Record<string, unknown>>;
  /**
   * The turn produced more of those than are kept. `turnEvents` is then incomplete and
   * must not be replayed — re-read the snapshot once `running` goes false.
   */
  overflowed: boolean;
  /**
   * Highest event number in existence when this was taken. A caller that subscribes
   * afterwards drops events at or below it and applies the rest.
   */
  seq: number;
};

export type ConversationOpenResult = WorkspaceSnapshot & {
  conversation: Conversation;
  messages: ChatMessage[];
  state: EngineSessionState | null;
  status: EngineStatus;
  /**
   * The extension statuses this conversation's session already holds.
   *
   * An extension publishes `setStatus` from `session_start` (the goal extension
   * restoring an objective), which fires while the session is being created — on a
   * cold start that is before any window is listening. Riding the open/ready reply
   * delivers it with the transcript instead, and only to the conversation it belongs
   * to. Absent/empty means nothing was published.
   */
  extensionStatus?: Record<string, string>;
  /** Main-owned durable queue, included so reload/open never starts from an empty tray. */
  queue: ConversationQueueState;
};

/** Pushed when a conversation finishes initialising in the background. */
export type ConversationReadyEvent = {
  id: string;
  messages: ChatMessage[];
  state: EngineSessionState | null;
  status: EngineStatus;
  /** Same replay as `ConversationOpenResult.extensionStatus`. */
  extensionStatus?: Record<string, string>;
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
  /** Provider id, e.g. `fastvibe` / `custom-provider`. What the transcript recorded. */
  provider: string;
  /**
   * The provider's display name, resolved from `providers.json` at read time.
   * Absent when the provider that served these turns no longer exists.
   */
  providerName?: string;
  model: string;
  /** Per-day model usage for the trend chart; absent only in older responses. */
  days?: UsageDay[];
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
  /** Longest span between turns in one session, in minutes. */
  longestSessionMinutes: number;
  /** Consecutive active days ending today, and the longest such run. */
  currentStreak: number;
  longestStreak: number;
};

/**
 * The other agents FastVibe can pull sessions from. Deliberately a closed list:
 * each id has a hand-written adapter, and the 导入 pane names them by product
 * (Claude Code, Codex, …) rather than by file format.
 */
export type ImportSourceId = "claude-code" | "codex" | "opencode" | "zcode" | "pi";

/**
 * What one adapter found on disk.
 *
 * A source whose data root is absent is not in the list at all, so every entry here is
 * something the user can actually import from (`sessionCount` may still be 0). There is
 * deliberately no `root` field: it existed only so an absent row could say where it had
 * looked, and that row no longer exists.
 */
export type ImportSourceStatus = {
  id: ImportSourceId;
  /** Product name, shown next to the brand mark. */
  name: string;
  sessionCount: number;
  /**
   * How many of `sessionCount` the source itself marks as archived. Those are still
   * importable but the picker folds them away by default, so the row says how many
   * are behind the 显示已归档 switch.
   */
  archivedCount?: number;
  /** Newest session timestamp in the source, if any. */
  latestAt?: number;
  /** Set when the source cannot be read at all (not installed, unreadable). */
  reason?: string;
};

/** One importable session, as listed in the picker. */
export type ImportCandidate = {
  /** Id inside the source; with `source` it is the re-import key. */
  id: string;
  source: ImportSourceId;
  title: string;
  /** Original working directory, which may no longer exist. */
  cwd?: string;
  createdAt: number;
  updatedAt: number;
  /** Messages the session would import, when the source can say so cheaply. Absent for
   * Codex, where counting means parsing 1000+ rollouts. */
  messageCount?: number;
  /** Transcript size on disk. Absent for opencode, whose payload size cannot be summed
   * without reading every part blob — a cost the settings list must not pay. */
  bytes?: number;
  /** Already imported into FastVibe once. */
  imported: boolean;
  /** Hidden by its source agent (Codex 归档, opencode time_archived). Folded away in
   * the picker unless 显示已归档 is on. */
  archived?: boolean;
  /** Non-fatal caveat, e.g. 已跳过子 agent 轨迹. */
  note?: string;
};

/** Outcome for a single session. Failures are per-session, never all-or-nothing. */
export type ImportOutcome = {
  id: string;
  title: string;
  ok: boolean;
  /** Written user/assistant/toolResult entries. */
  messages?: number;
  /** What the adapter dropped, for the report. */
  skipped?: string[];
  /** Where the session landed: the original project, or the scratch workspace. */
  cwd?: string;
  conversationId?: string;
  error?: string;
};

export type ImportRunResult = {
  source: ImportSourceId;
  outcomes: ImportOutcome[];
  /** The refreshed catalog, so the shell's sidebar picks the new chats up. */
  snapshot: WorkspaceSnapshot;
};
