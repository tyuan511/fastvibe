import { useEffect, useMemo, useRef, useState, type ClipboardEvent, type DragEvent, type JSX, type KeyboardEvent, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { HugeiconsIcon } from "@hugeicons/react";
import { Add01Icon, ArrowDown01Icon, ArrowUp02Icon, AttachmentIcon, Cancel01Icon, ChartHistogramIcon, Folder01Icon, HandIcon, MagicWand02Icon, PlayIcon, ScissorIcon, Search01Icon, ShieldAlertIcon, ShieldCheckIcon, SparklesIcon, SquareIcon, Tick02Icon } from "@hugeicons/core-free-icons";
import { Button } from "@/components/ui/button";
import { IconButton } from "@/components/icon-button";
import { ProviderIcon } from "@/components/provider-icon";
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Textarea } from "@/components/ui/textarea";
import { engine } from "@/lib/engine-client";
import { Input } from "@/components/ui/input";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Separator } from "@/components/ui/separator";
import type {
  ChatAttachment,
  ContextUsage,
  FastVibeModel,
  Project,
  PermissionMode,
  QueuePauseReason,
  QueuedPrompt,
  SessionStats,
  SlashCommand,
  ThinkingLevel,
} from "@shared/types";
import { DEFAULT_THINKING_LEVELS, THINKING_LEVELS } from "@shared/types";
import { filesToAttachments } from "@/lib/attachments";
import { thinkingLabel } from "@/lib/thinking-levels";
import { useGitStatus } from "@/lib/use-git-status";
import { cn } from "@/lib/utils";
import { formatDuration } from "@/lib/time";
import { matchChord, resolveBinding } from "@/lib/shortcuts";
import { useShortcutLabel } from "@/lib/use-shortcuts";
import { permissionDescription, permissionLabel, PERMISSION_MODES } from "@/lib/permission-modes";
import { useSettingsStore } from "@/stores/settings";
import { GitBranchChip } from "./git-branch-chip";
import { AttachmentChip } from "./attachment-chip";
import { MessageQueue } from "./message-queue";
import { ExtensionStatusBadges } from "./extension-surface";

/**
 * Icons for the slash palette. Skills are offered alongside the engine's own
 * commands, and each kind gets a glyph so the list is scannable: `/skill:<name>`
 * forces a skill.
 */
const COMMAND_ICONS: Record<string, typeof SparklesIcon> = {
  skill: MagicWand02Icon,
  builtin: ScissorIcon,
};

/**
 * Extension commands that are state toggles rather than prompts. Picking one from
 * the palette fires it immediately (the mode badge flips) instead of parking the
 * command in the draft for a second Enter. A bare `/goal` only arms goal mode; the
 * user's next message becomes the objective.
 */
const INSTANT_COMMANDS = new Set(["plan", "goal"]);

function modelKey(model: { provider: string; id: string }): string {
  return `${model.provider}/${model.id}`;
}

function providerLabel(model: FastVibeModel): string {
  // `custom-<slug>` is the internal id namespace, never a display name.
  return model.providerName || model.provider.replace(/^custom-/, "");
}

function Chip({
  children,
  className,
  ...props
}: { children: ReactNode; className?: string } & React.ComponentProps<typeof Button>): JSX.Element {
  return (
    <Button
      variant="ghost"
      size="sm"
      className={cn("h-7 gap-1 rounded-full px-2 font-normal text-muted-foreground", className)}
      {...props}
    >
      {children}
    </Button>
  );
}

const CONTEXT_RING_SIZE = 14;
const CONTEXT_RING_STROKE = 2;
const CONTEXT_RING_RADIUS = (CONTEXT_RING_SIZE - CONTEXT_RING_STROKE) / 2;
const CONTEXT_RING_CIRCUMFERENCE = 2 * Math.PI * CONTEXT_RING_RADIUS;

/**
 * A chip that only ever reads: a delegated run's pane draws the composer without its
 * menus, so the model / thinking labels are shown as plain text there. A `Chip` is a
 * button and would stay in the tab order with nothing behind it.
 */
function StaticChip({ children, className }: { children: ReactNode; className?: string }): JSX.Element {
  return (
    <span
      className={cn(
        "inline-flex h-7 items-center gap-1 rounded-full px-2 text-sm font-normal text-muted-foreground",
        className,
      )}
    >
      {children}
    </span>
  );
}

function ContextUsageRing({ percent }: { percent: number }): JSX.Element {
  const clamped = Math.min(100, Math.max(0, percent));
  const offset = CONTEXT_RING_CIRCUMFERENCE * (1 - clamped / 100);
  const color =
    clamped >= 90 ? "text-destructive" : clamped >= 70 ? "text-warning" : "text-muted-foreground";

  return (
    <svg
      viewBox={`0 0 ${CONTEXT_RING_SIZE} ${CONTEXT_RING_SIZE}`}
      className="size-3.5 -rotate-90"
      aria-hidden="true"
    >
      <circle
        cx={CONTEXT_RING_SIZE / 2}
        cy={CONTEXT_RING_SIZE / 2}
        r={CONTEXT_RING_RADIUS}
        fill="none"
        stroke="var(--muted-foreground)"
        strokeOpacity={0.2}
        strokeWidth={CONTEXT_RING_STROKE}
      />
      {clamped > 0 ? (
        <circle
          cx={CONTEXT_RING_SIZE / 2}
          cy={CONTEXT_RING_SIZE / 2}
          r={CONTEXT_RING_RADIUS}
          fill="none"
          className={color}
          stroke="currentColor"
          strokeWidth={CONTEXT_RING_STROKE}
          strokeLinecap="round"
          strokeDasharray={CONTEXT_RING_CIRCUMFERENCE}
          strokeDashoffset={offset}
        />
      ) : null}
    </svg>
  );
}

/** Compact `45.5K` / `1.2M` counts for the statistics rows. */
function formatCount(value: number | null | undefined): string {
  if (value == null || !Number.isFinite(value)) return "—";
  const abs = Math.abs(value);
  if (abs >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`;
  if (abs >= 1_000) return `${(value / 1_000).toFixed(1)}K`;
  return String(Math.round(value));
}

function formatSpeed(tokens: number, ms: number | undefined): string {
  if (!ms || ms <= 0 || tokens <= 0) return "—";
  return `~${Math.round(tokens / (ms / 1000))} tok/s`;
}

function StatRow({ label, value, className }: { label: string; value: string; className?: string }): JSX.Element {
  return (
    <div className="flex items-baseline justify-between gap-3">
      <dt className="text-muted-foreground">{label}</dt>
      <dd className={cn("font-medium tabular-nums", className)}>{value}</dd>
    </div>
  );
}

/**
 * The context ring's popover: context-window usage on top, then the current
 * conversation's turn statistics (speed, timing, tokens, cache hit, cost).
 */
function ContextUsagePanel({
  percent,
  used,
  window: windowTokens,
  stats,
}: {
  percent: number;
  used: number | null;
  window: number;
  stats?: SessionStats | null;
}): JSX.Element {
  const { t } = useTranslation("chat");
  const clamped = Math.min(100, Math.max(0, percent));
  const barColor = clamped >= 90 ? "bg-destructive" : clamped >= 70 ? "bg-warning" : "bg-primary";
  const remaining = Math.max(0, windowTokens - (used ?? 0));
  // A number nobody acts on is just decoration: past 70% the popover says *what*
  // happens next (the engine compacts on its own), and past 90% that it is about to.
  // The ring alone only ever said how full the window was.
  const proximity = clamped >= 90 ? "imminent" : clamped >= 70 ? "close" : null;

  const tokens = stats?.tokens;
  const input = tokens?.input ?? 0;
  const output = tokens?.output ?? 0;
  const cacheRead = tokens?.cacheRead ?? 0;
  const timing = stats?.timing;
  const cacheBase = input + cacheRead;
  const cacheHit = cacheBase > 0 ? Math.round((cacheRead / cacheBase) * 100) : null;

  return (
    <div className="space-y-2.5">
      <div className="space-y-2">
        <div className="flex items-center justify-between">
          <span className="text-sm font-medium">{t("composer.contextWindow")}</span>
          <span
            className={cn(
              "text-sm font-semibold tabular-nums",
              clamped >= 90 ? "text-destructive" : clamped >= 70 ? "text-warning" : "text-foreground",
            )}
          >
            {percent}%
          </span>
        </div>
        <div className="h-1.5 overflow-hidden rounded-full bg-muted">
          <div className={cn("h-full rounded-full transition-[width]", barColor)} style={{ width: `${clamped}%` }} />
        </div>
        <div className="flex items-center justify-between text-xs text-muted-foreground">
          <span className="tabular-nums">{t("composer.used", { count: formatCount(used) })}</span>
          <span className="tabular-nums">
            {t("composer.remaining", { remaining: formatCount(remaining), window: formatCount(windowTokens) })}
          </span>
        </div>
        {proximity ? (
          <p
            className={cn(
              "rounded-md px-2 py-1.5 text-xs",
              proximity === "imminent" ? "bg-destructive/10 text-destructive" : "bg-warning/10 text-warning",
            )}
          >
            {t(proximity === "imminent" ? "composer.contextImminent" : "composer.contextClose")}
          </p>
        ) : null}
      </div>

      {stats ? (
        <>
          <Separator />
          <div className="flex items-center gap-1.5 text-xs font-medium tracking-wide text-muted-foreground">
            <HugeiconsIcon strokeWidth={2} icon={ChartHistogramIcon} className="size-3.5" />
            {t("composer.turnStats")}
          </div>
          <dl className="space-y-1.5 text-xs">
            <StatRow label={t("composer.speed")} value={formatSpeed(output, timing?.modelMs)} />
            <StatRow label={t("composer.modelTime")} value={formatDuration(timing?.modelMs) || "—"} />
            <StatRow label={t("composer.toolTime")} value={formatDuration(timing?.toolMs) || "—"} />
            <StatRow label={t("composer.steps")} value={stats.steps != null ? String(stats.steps) : "—"} />
            <StatRow label="Token" value={`${formatCount(input)} ↑ · ${formatCount(output)} ↓`} />
            <StatRow
              label={t("composer.cacheHit")}
              value={cacheHit != null ? `${cacheHit}%` : "—"}
              className={cacheHit != null && cacheHit > 0 ? "text-success" : undefined}
            />
            <StatRow label={t("composer.cost")} value={`$${(stats.cost ?? 0).toFixed(3)}`} />
          </dl>
        </>
      ) : null}
    </div>
  );
}

export function Composer({
  value,
  disabled,
  streaming,
  working,
  placeholder,
  models,
  model,
  thinkingLevel,
  workspaceLabel,
  projects,
  project,
  newSession,
  hideProjectPicker = false,
  commands,
  permissionMode,
  queued,
  queuePause,
  attachments,
  history,
  contextPercent,
  contextUsage,
  stats,
  onChange,
  onSubmit,
  onAbort,
  onPickWorkspace,
  onSelectProject,
  onModelChange,
  onManageModels,
  onThinkingChange,
  onPermissionModeChange,
  onAttachmentsChange,
  onRemoveQueued,
  onEditQueued,
  onSendQueuedNow,
  onRecallQueued,
  onReorderQueued,
  onResumeQueue,
  runInterrupted = false,
  onResumeRun,
  sendOnEnter = true,
  focusSignal,
  className,
  readOnly = false,
}: {
  value: string;
  disabled: boolean;
  /**
   * A run is in flight for this conversation, so a send is *queued* rather than
   * started as a fresh turn. This is the flag the send path itself uses (the send
   * button's label and the placeholder describe where the message will go), not the
   * busy mark — see `working`.
   */
  streaming: boolean;
  /**
   * 「this conversation is still working」 — the same verdict the sidebar's 运行中 mark
   * carries: a run (through its retries and the compaction that follows it) *or* a
   * compaction with no run at all. Drives the stop button and the badges, so a chat
   * is never shown as busy in one place and idle in another.
   */
  working: boolean;
  placeholder?: string;
  models: FastVibeModel[];
  model?: { provider: string; id: string };
  thinkingLevel?: string;
  workspaceLabel: string;
  projects: Project[];
  project?: string;
  /** New sessions have no top bar, so the project binding is shown above the input. */
  newSession?: boolean;
  /** Hide the project chip entirely (auxiliary chats inherit the parent workspace). */
  hideProjectPicker?: boolean;
  commands: SlashCommand[];
  permissionMode: PermissionMode;
  onPermissionModeChange: (mode: PermissionMode) => void;
  queued: QueuedPrompt[];
  queuePause: QueuePauseReason | null;
  attachments: ChatAttachment[];
  /**
   * Past prompts for ↑/↓ recall, read on demand.
   *
   * A getter rather than an array: deriving it means walking the whole transcript,
   * and as a subscribed value that ran on every store update — so every keystroke
   * (the draft lives in the same store) and every streamed batch allocated a fresh
   * array of every prompt in the conversation for a list only these two keys read.
   */
  history: () => string[];
  contextPercent?: number | null;
  contextUsage?: ContextUsage | null;
  /** Turn statistics for the active conversation; shown under the context ring. */
  stats?: SessionStats | null;
  onChange: (value: string) => void;
  onSubmit: () => void;
  onAbort: () => void;
  onPickWorkspace: () => void;
  onSelectProject: (project: string | null) => void;
  onModelChange: (provider: string, modelId: string) => void;
  /** Opens Settings → 模型管理, where providers and their models are configured. */
  onManageModels: () => void;
  onThinkingChange: (level: string) => void;
  onAttachmentsChange: (attachments: ChatAttachment[]) => void;
  onRemoveQueued: (id: string) => void;
  onEditQueued: (id: string) => void;
  onSendQueuedNow: (id: string) => void;
  onRecallQueued: (id: string) => void;
  onReorderQueued: (ids: string[]) => void;
  onResumeQueue: () => void;
  /** The last run stopped early (user abort or failure): offer a resume control. */
  runInterrupted?: boolean;
  /** Continue the interrupted turn from the transcript, with no new user message. */
  onResumeRun?: () => void;
  sendOnEnter?: boolean;
  /** Increment to move the caret into the textarea (new sessions focus the composer). */
  focusSignal?: number;
  className?: string;
  /**
   * The composer is being shown for a run the user cannot steer — a delegated run's
   * pane. The input is locked and every control that would change the run (attach,
   * permission, the model / thinking menus) is dropped; what stays is what is
   * *readable*: the context ring with its popover, the model and thinking chips as
   * plain labels, and the stop button while the run is in flight.
   */
  readOnly?: boolean;
}): JSX.Element {
  const { t } = useTranslation("chat");
  const fileRef = useRef<HTMLInputElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const [dragging, setDragging] = useState(false);
  const [slashIndex, setSlashIndex] = useState(0);
  const [slashDismissed, setSlashDismissed] = useState(false);
  const [histIndex, setHistIndex] = useState<number | null>(null);
  const [projectOpen, setProjectOpen] = useState(false);
  const [projectQuery, setProjectQuery] = useState("");
  const histDraft = useRef("");
  const sendBinding = useSettingsStore((state) => resolveBinding("send", state.settings.shortcuts));
  const sendShortcut = useShortcutLabel("send");
  const stopShortcut = useShortcutLabel("stop");

  // The composer survives session switches, so a plain autoFocus never re-fires.
  // A changing signal (new chat, app launch) pulls focus back to the input.
  useEffect(() => {
    if (focusSignal === undefined) return;
    const frame = requestAnimationFrame(() => textareaRef.current?.focus());
    return () => cancelAnimationFrame(frame);
  }, [focusSignal]);

  const slash = useMemo(() => {
    if (slashDismissed || !/^\/[^\s]*$/.test(value)) return [];
    const q = value.slice(1).toLowerCase();
    return commands
      .filter((item) => {
        const hay = `${item.name} ${item.description ?? ""} ${(item.aliases ?? []).join(" ")}`.toLowerCase();
        return !q || hay.includes(q);
      })
      .slice(0, 8);
  }, [commands, slashDismissed, value]);

  useEffect(() => {
    setSlashIndex(0);
  }, [value]);

  function applySlash(command: SlashCommand): void {
    // Toggles like `/plan` act the moment they are chosen: clear the draft and run
    // the command so the mode badge appears below the composer, instead of leaving
    // `/plan` in the box for the user to send.
    if (command.source === "extension" && INSTANT_COMMANDS.has(command.name)) {
      onChange("");
      setSlashDismissed(true);
      void engine.prompt(`/${command.name}`).catch(() => undefined);
      requestAnimationFrame(() => textareaRef.current?.focus());
      return;
    }
    onChange(`/${command.name} `);
    setSlashDismissed(true);
  }

  function handleKeyDown(event: KeyboardEvent<HTMLTextAreaElement>): void {
    if (event.nativeEvent.isComposing || event.key === "Process") return;

    if (slash.length > 0) {
      if (event.key === "ArrowDown") {
        event.preventDefault();
        setSlashIndex((index) => (index + 1) % slash.length);
        return;
      }
      if (event.key === "ArrowUp") {
        event.preventDefault();
        setSlashIndex((index) => (index - 1 + slash.length) % slash.length);
        return;
      }
      if (event.key === "Tab" || event.key === "Enter") {
        event.preventDefault();
        const item = slash[slashIndex] ?? slash[0];
        // While the palette is open Enter/Tab confirms the highlighted suggestion.
        // A state toggle runs at once; anything else lands in the draft so its
        // arguments can be typed, and a second Enter sends it.
        applySlash(item);
        return;
      }
      if (event.key === "Escape") {
        event.preventDefault();
        setSlashDismissed(true);
        return;
      }
    }

    if (event.key === "ArrowUp" || event.key === "ArrowDown") {
      const el = event.currentTarget;
      const atFirstLine = !value.slice(0, el.selectionStart).includes("\n");
      const atLastLine = !value.slice(el.selectionEnd).includes("\n");
      const past = history();
      if (event.key === "ArrowUp" && atFirstLine && past.length > 0) {
        event.preventDefault();
        if (histIndex === null) {
          histDraft.current = value;
          const next = past.length - 1;
          setHistIndex(next);
          onChange(past[next] ?? "");
        } else if (histIndex > 0) {
          const next = histIndex - 1;
          setHistIndex(next);
          onChange(past[next] ?? "");
        }
        return;
      }
      if (event.key === "ArrowDown" && atLastLine && histIndex !== null) {
        event.preventDefault();
        if (histIndex < past.length - 1) {
          const next = histIndex + 1;
          setHistIndex(next);
          onChange(past[next] ?? "");
        } else {
          setHistIndex(null);
          onChange(histDraft.current);
        }
        return;
      }
    }

    if (sendBinding && matchChord(event.nativeEvent, sendBinding)) {
      event.preventDefault();
      // A held Enter repeats the keydown: the first one sends, the rest must not
      // queue the same prompt again.
      if (!event.repeat) submit();
      return;
    }
    if (
      sendOnEnter &&
      event.key === "Enter" &&
      !event.shiftKey &&
      !event.metaKey &&
      !event.ctrlKey &&
      !event.altKey
    ) {
      event.preventDefault();
      if (!event.repeat) submit();
    }
  }

  function submit(): void {
    onSubmit();
    setHistIndex(null);
    setSlashDismissed(false);
    requestAnimationFrame(() => textareaRef.current?.focus());
  }

  const selected = model ? modelKey(model) : undefined;
  const selectedModel = models.find((item) => model && modelKey(item) === selected);
  // The menu only ever offers levels FastVibe is willing to request, i.e. never `off`.
  // The chip still names whatever the session is actually on — a restored conversation
  // or a model that does not think at all reports `off`, and saying 低 there would lie.
  const thinkingOptions = selectedModel?.thinkingLevels?.length
    ? selectedModel.thinkingLevels
    : DEFAULT_THINKING_LEVELS;
  const thinkingValue = (THINKING_LEVELS as readonly string[]).includes(thinkingLevel ?? "")
    ? (thinkingLevel as ThinkingLevel)
    : thinkingOptions[0];
  const modelsByProvider = useMemo(() => {
    const groups: { id: string; name: string; models: FastVibeModel[] }[] = [];
    const index = new Map<string, number>();
    for (const item of models) {
      const existing = index.get(item.provider);
      if (existing === undefined) {
        index.set(item.provider, groups.length);
        groups.push({ id: item.provider, name: providerLabel(item), models: [item] });
      } else {
        groups[existing].models.push(item);
      }
    }
    return groups;
  }, [models]);
  const hasContent = Boolean(value.trim() || attachments.length > 0);
  const filteredProjects = useMemo(() => {
    const query = projectQuery.trim().toLowerCase();
    if (!query) return projects;
    return projects.filter((item) => `${item.name} ${item.cwd}`.toLowerCase().includes(query));
  }, [projectQuery, projects]);
  // `project` is the workspace cwd, so it is also what git answers for. The
  // refresh key covers both a finished turn (the agent may have committed or
  // created a branch) and an explicit switch from the branch picker.
  const [gitEpoch, setGitEpoch] = useState(0);
  const gitStatus = useGitStatus(project, `${streaming ? "streaming" : "idle"}:${gitEpoch}`);
  const git = gitStatus?.isRepository && gitStatus.branch ? gitStatus : null;
  // Project/branch chips only belong to an empty conversation. Once a message
  // has been sent the top bar carries the title, so the chips are dropped.
  const showWorkspace = Boolean(newSession);
  const showProjectPicker = showWorkspace && !hideProjectPicker;

  const contextUsed = contextUsage?.tokens ?? (
    contextUsage?.contextWindow && typeof contextPercent === "number"
      ? (contextPercent / 100) * contextUsage.contextWindow
      : null
  );
  const contextWindow = contextUsage?.contextWindow ?? 0;
  const contextUsedPercent = typeof contextPercent === "number" ? Math.round(contextPercent) : null;

  async function addFiles(list: FileList | File[]): Promise<void> {
    const next = await filesToAttachments([...list]);
    if (next.length === 0) return;
    onAttachmentsChange([...attachments, ...next]);
  }

  function handleDrop(event: DragEvent<HTMLDivElement>): void {
    event.preventDefault();
    setDragging(false);
    if (event.dataTransfer.files.length > 0) void addFiles(event.dataTransfer.files);
  }

  function handlePaste(event: ClipboardEvent<HTMLTextAreaElement>): void {
    const files = [...event.clipboardData.files];
    if (files.length === 0) return;
    event.preventDefault();
    void addFiles(files);
  }

  function handleChange(next: string): void {
    setSlashDismissed(false);
    setHistIndex(null);
    onChange(next);
  }

  return (
    <div
      className={cn("@container/composer mx-auto w-full max-w-3xl px-6 pb-5", className)}
      onDragOver={(event) => {
        event.preventDefault();
        setDragging(true);
      }}
      onDragLeave={() => setDragging(false)}
      onDrop={handleDrop}
    >
      {slash.length > 0 ? (
        <div className="mb-2 overflow-hidden rounded-xl border border-border bg-popover shadow-sm" role="listbox">
          {slash.map((item, index) => (
            <button
              key={item.name}
              type="button"
              role="option"
              aria-selected={index === slashIndex}
              className={cn(
                "flex w-full items-center gap-2 px-3 py-2 text-left text-sm",
                index === slashIndex ? "bg-muted" : "hover:bg-muted/60",
              )}
              onMouseEnter={() => setSlashIndex(index)}
              onClick={() => applySlash(item)}
            >
              <HugeiconsIcon
                strokeWidth={2}
                icon={COMMAND_ICONS[item.source ?? ""] ?? SparklesIcon}
                className="size-3.5 shrink-0 text-muted-foreground"
              />
              <span className="flex min-w-0 flex-1 items-baseline gap-2">
                <span className="shrink-0 font-medium">/{item.name}</span>
                {item.description ? (
                  <span className="min-w-0 truncate text-xs text-muted-foreground">{item.description}</span>
                ) : null}
              </span>
            </button>
          ))}
        </div>
      ) : null}

      {showWorkspace && (showProjectPicker || git) ? (
        <div className="mb-2 flex items-center gap-0.5 px-1.5">
          {showProjectPicker ? (
            <Popover
              open={projectOpen}
              onOpenChange={(open) => {
                setProjectOpen(open);
                if (!open) setProjectQuery("");
              }}
            >
              <PopoverTrigger
                render={
                  <button
                    type="button"
                    className="group flex h-7 max-w-56 items-center gap-1.5 rounded-full px-2 text-sm text-muted-foreground transition-colors hover:bg-muted hover:text-foreground aria-expanded:bg-muted aria-expanded:text-foreground"
                  />
                }
              >
                <span
                  className={cn("relative size-3.5 shrink-0", project && "cursor-pointer rounded-full hover:bg-muted-foreground/20")}
                  aria-label={project ? t("composer.clearProject") : undefined}
                  title={project ? t("composer.clearProject") : undefined}
                  onClick={project ? (event) => {
                    event.preventDefault();
                    event.stopPropagation();
                    onSelectProject(null);
                  } : undefined}
                >
                  <HugeiconsIcon strokeWidth={1.8} icon={Folder01Icon} className={cn("absolute inset-0 size-3.5 transition-opacity", project && "group-hover:opacity-0")} />
                  {project ? <HugeiconsIcon strokeWidth={1.8} icon={Cancel01Icon} className="absolute inset-0 size-3.5 opacity-0 transition-opacity group-hover:opacity-100" /> : null}
                </span>
                <span className="max-w-44 truncate">{project ? projects.find((item) => item.cwd === project)?.name ?? workspaceLabel : t("composer.pickProject")}</span>
                <HugeiconsIcon strokeWidth={1.8} icon={ArrowDown01Icon} className="size-3 shrink-0" />
              </PopoverTrigger>
              <PopoverContent align="start" side="top" sideOffset={12} className="w-70 gap-0 rounded-xl p-1 shadow-lg">
                <div className="relative mb-0.5 px-0.5 pt-0.5">
                  <HugeiconsIcon strokeWidth={2} icon={Search01Icon} className="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
                  <Input
                    autoFocus
                    value={projectQuery}
                    placeholder={t("composer.searchProject")}
                    className="h-7 rounded-md border-0 bg-transparent pl-6.5 text-sm shadow-none focus-visible:ring-0"
                    onChange={(event) => setProjectQuery(event.target.value)}
                  />
                </div>
                <div className="max-h-52 overflow-y-auto">
                  {filteredProjects.length > 0 ? filteredProjects.map((item) => (
                    <button
                      key={item.cwd}
                      type="button"
                      className={cn(
                        "flex w-full items-center gap-1.5 rounded-md px-2 py-1 text-left text-sm transition-colors hover:bg-muted",
                        item.cwd === project && "bg-muted font-medium",
                      )}
                      onClick={() => {
                        onSelectProject(item.cwd);
                        setProjectOpen(false);
                      }}
                    >
                      <HugeiconsIcon strokeWidth={2} icon={Folder01Icon} className="size-3.5 shrink-0 text-muted-foreground" />
                      <span className="truncate">{item.name}</span>
                    </button>
                  )) : (
                    <div className="px-2 py-1.5 text-sm text-muted-foreground">{t("composer.noProject")}</div>
                  )}
                </div>
                <div className="my-0.5 border-t border-border" />
                <button
                  type="button"
                  className="flex w-full items-center gap-1.5 rounded-md px-2 py-1 text-left text-sm text-muted-foreground hover:bg-muted hover:text-foreground"
                  onClick={() => {
                    setProjectOpen(false);
                    onPickWorkspace();
                  }}
                >
                  <HugeiconsIcon strokeWidth={2} icon={Add01Icon} className="size-3.5" />
                  <span>{t("composer.newProject")}</span>
                </button>
              </PopoverContent>
            </Popover>
          ) : null}
          {git ? (
            <GitBranchChip status={git} onBranchChange={() => setGitEpoch((value) => value + 1)} />
          ) : null}
        </div>
      ) : null}

      <MessageQueue
        items={queued}
        pauseReason={queuePause}
        draft={value}
        onRemove={onRemoveQueued}
        onEdit={onEditQueued}
        onSendNow={onSendQueuedNow}
        onRecall={onRecallQueued}
        onReorder={onReorderQueued}
        onResume={onResumeQueue}
      />

      <div
        className={cn(
          "relative z-10 rounded-[22px] border border-border bg-card shadow-sm transition-colors focus-within:border-ring",
          dragging && "ring-2 ring-ring",
        )}
      >
        <input
          ref={fileRef}
          type="file"
          multiple
          className="hidden"
          onChange={(event) => {
            if (event.target.files) void addFiles(event.target.files);
            event.target.value = "";
          }}
        />

        {attachments.length > 0 ? (
          <div className="flex flex-wrap gap-1.5 px-3 pt-3">
            {attachments.map((item) => (
              <AttachmentChip
                key={item.id}
                item={item}
                onRemove={() => onAttachmentsChange(attachments.filter((entry) => entry.id !== item.id))}
              />
            ))}
          </div>
        ) : null}

        <Textarea
          ref={textareaRef}
          rows={1}
          value={value}
          disabled={disabled || readOnly}
          placeholder={streaming ? t("composer.placeholderQueued") : placeholder ?? t("composer.placeholder")}
          className={cn(
            "field-sizing-content max-h-56 min-h-13 resize-none border-0 bg-transparent px-4 text-sm leading-6 shadow-none focus-visible:ring-0 disabled:bg-transparent disabled:opacity-100 dark:bg-transparent",
            attachments.length > 0 ? "pt-2" : "pt-3.5",
          )}
          onChange={(event) => handleChange(event.target.value)}
          onKeyDown={handleKeyDown}
          onPaste={handlePaste}
        />

        <div className="flex items-center gap-1 px-2.5 pb-2.5">
          {readOnly ? null : (
            <IconButton
              size="icon-sm"
              variant="ghost"
              className="rounded-full text-muted-foreground"
              label={t("composer.attach")}
              disabled={disabled}
              onClick={() => fileRef.current?.click()}
            >
              <HugeiconsIcon strokeWidth={2} icon={AttachmentIcon} />
            </IconButton>
          )}

          {readOnly ? null : (
            <DropdownMenu>
              <DropdownMenuTrigger
              render={
                <Chip
                  className={
                    permissionMode === "full"
                      ? "text-destructive hover:bg-destructive/10 hover:text-destructive"
                      : undefined
                  }
                >
                  <HugeiconsIcon strokeWidth={2} icon={ShieldAlertIcon} className="size-4" />
                  <span className="hidden @min-[27.5rem]/composer:inline">{permissionLabel(permissionMode)}</span>
                  <HugeiconsIcon strokeWidth={2} icon={ArrowDown01Icon} className="size-3" />
                </Chip>
              }
            />
            <DropdownMenuContent align="start" className="w-75 min-w-75 p-1">
              <DropdownMenuGroup>
                <DropdownMenuLabel className="px-1.5 py-1 text-xs text-muted-foreground">
                  {t("composer.permissionAsk")}
                </DropdownMenuLabel>
              </DropdownMenuGroup>
              <DropdownMenuRadioGroup
                value={permissionMode}
                onValueChange={(value) => onPermissionModeChange(value as PermissionMode)}
              >
                {PERMISSION_MODES.map((mode) => {
                  const modeIcon = mode === "ask" ? HandIcon : mode === "smart" ? ShieldAlertIcon : ShieldCheckIcon;
                  return (
                    <DropdownMenuRadioItem
                      key={mode}
                      value={mode}
                      closeOnClick
                      className={cn(
                        "items-start gap-1.5 rounded-lg px-1.5 py-1.5 pr-7",
                        mode === permissionMode &&
                        mode === "full" && "text-destructive focus:text-destructive",
                      )}
                    >
                      <HugeiconsIcon strokeWidth={2} icon={modeIcon} className="mt-0.5 size-3.5 shrink-0" />
                      <span className="min-w-0">
                        <span className="block text-sm font-medium leading-4">{permissionLabel(mode)}</span>
                        <span className="mt-0.5 block text-xs font-normal leading-3.5 text-muted-foreground">
                          {permissionDescription(mode)}
                        </span>
                      </span>
                    </DropdownMenuRadioItem>
                  );
                })}
              </DropdownMenuRadioGroup>
            </DropdownMenuContent>
            </DropdownMenu>
          )}

          {readOnly ? null : <ExtensionStatusBadges disabled={working} />}

          <div className="flex-1" />

          {contextUsedPercent != null && contextWindow > 0 ? (
            <span className="hidden @min-[27.5rem]/composer:contents">
              <Popover>
                <PopoverTrigger
                  render={
                    <button
                      type="button"
                      className="flex size-7 items-center justify-center rounded-full text-muted-foreground transition-colors hover:bg-muted hover:text-foreground aria-expanded:bg-muted aria-expanded:text-foreground"
                      aria-label={t("composer.contextStats")}
                    />
                  }
                >
                  <ContextUsageRing percent={contextUsedPercent} />
                </PopoverTrigger>
                <PopoverContent side="top" align="end" sideOffset={10} className="w-72 gap-0 p-3.5">
                  <ContextUsagePanel
                    percent={contextUsedPercent}
                    used={contextUsed}
                    window={contextWindow}
                    stats={stats}
                  />
                </PopoverContent>
              </Popover>
            </span>
          ) : null}

          {readOnly ? (
            <StaticChip className="max-w-40 @min-[22rem]/composer:max-w-72">
              <span className="truncate">
                {selectedModel ? (
                  <>
                    <span className="hidden @min-[40rem]/composer:inline">
                      {providerLabel(selectedModel)}/{selectedModel.id}
                    </span>
                    <span className="@min-[40rem]/composer:hidden">
                      {selectedModel.name || selectedModel.id}
                    </span>
                  </>
                ) : model ? (
                  // A role may pin a model this install has no catalog entry for; the
                  // pane still says which one the run is on rather than claiming none.
                  <span className="truncate">
                    {model.provider}/{model.id}
                  </span>
                ) : (
                  <span>{t("composer.noModels")}</span>
                )}
              </span>
            </StaticChip>
          ) : (
          <div className="relative">
            <DropdownMenu>
              <DropdownMenuTrigger
                render={
                  <Chip className="max-w-40 @min-[22rem]/composer:max-w-72">
                    <span className="truncate">
                      {selectedModel ? (
                        <>
                          <span className="hidden @min-[40rem]/composer:inline">
                            {providerLabel(selectedModel)}/{selectedModel.id}
                          </span>
                          <span className="@min-[40rem]/composer:hidden">
                            {selectedModel.name || selectedModel.id}
                          </span>
                        </>
                      ) : (
                        // With nothing configured there is nothing to choose, so the chip
                        // names what it is for instead — its popover says 暂无模型 and
                        // hands the user to 供应商.
                        <span className={models.length === 0 ? "text-muted-foreground" : undefined}>
                          {models.length === 0 ? t("composer.addModel") : t("composer.pickModel")}
                        </span>
                      )}
                    </span>
                    <HugeiconsIcon strokeWidth={2} icon={ArrowDown01Icon} className="size-3" />
                  </Chip>
                }
              />
              <DropdownMenuContent align="end" className="min-w-44">
                {models.length === 0 ? (
                  // `DropdownMenuLabel` is Base UI's `Menu.GroupLabel` and throws out of a
                  // group — which it did here, unmounting the whole app the moment this
                  // menu was opened on an install with no models.
                  <DropdownMenuGroup>
                    <DropdownMenuLabel className="font-normal text-muted-foreground">{t("composer.noModels")}</DropdownMenuLabel>
                  </DropdownMenuGroup>
                ) : (
                  modelsByProvider.map((group) => {
                    const selectedInGroup = group.models.some((item) => modelKey(item) === selected);
                    return (
                      <DropdownMenuSub key={group.id}>
                        <DropdownMenuSubTrigger>
                          <span className="flex min-w-0 flex-1 items-center gap-2">
                            <ProviderIcon provider={group.id} />
                            <span className="min-w-0 truncate">{group.name}</span>
                            <span className="ml-auto flex size-4 shrink-0 items-center justify-center">
                              {selectedInGroup ? (
                                <HugeiconsIcon icon={Tick02Icon} strokeWidth={2} className="size-4" />
                              ) : null}
                            </span>
                          </span>
                        </DropdownMenuSubTrigger>
                        <DropdownMenuSubContent align="start" side="right" className="min-w-52">
                          {group.models.map((item) => (
                            <DropdownMenuCheckboxItem
                              key={modelKey(item)}
                              checked={modelKey(item) === selected}
                              onCheckedChange={() => onModelChange(item.provider, item.id)}
                            >
                              <span className="truncate">{item.name || item.id}</span>
                            </DropdownMenuCheckboxItem>
                          ))}
                        </DropdownMenuSubContent>
                      </DropdownMenuSub>
                    );
                  })
                )}
                <DropdownMenuSeparator />
                <DropdownMenuItem onClick={onManageModels}>{t("composer.manageModels")}</DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
          )}

          {readOnly ? (
            <StaticChip>{thinkingLabel(thinkingValue)}</StaticChip>
          ) : (
          <span className="hidden @min-[27.5rem]/composer:contents">
            <DropdownMenu>
              <DropdownMenuTrigger
                render={
                  <Chip>
                    {thinkingLabel(thinkingValue)}
                    <HugeiconsIcon strokeWidth={2} icon={ArrowDown01Icon} className="size-3" />
                  </Chip>
                }
              />
              <DropdownMenuContent align="end" className="w-36 min-w-36">
                <DropdownMenuGroup>
                  <DropdownMenuLabel>{t("composer.thinking")}</DropdownMenuLabel>
                  {thinkingOptions.map((level) => (
                    <DropdownMenuCheckboxItem
                      key={level}
                      checked={level === thinkingValue}
                      onCheckedChange={() => onThinkingChange(level)}
                    >
                      {thinkingLabel(level)}
                    </DropdownMenuCheckboxItem>
                  ))}
                </DropdownMenuGroup>
              </DropdownMenuContent>
            </DropdownMenu>
          </span>
          )}

          {/* A run and a compaction are stopped the same way, so the mark that decides
              whether there is something to stop is `working`, not `streaming`: a manual
              `/compact` has no run behind it and used to leave nothing to click. */}
          {readOnly ? (
            working && !hasContent ? (
              <IconButton
                size="icon-sm"
                variant="destructive"
                className="rounded-full"
                label={t("composer.stop")}
                data-fv-action="stop"
                shortcut={stopShortcut}
                onClick={onAbort}
              >
                <HugeiconsIcon strokeWidth={2} icon={SquareIcon} className="size-3.5 fill-current" />
              </IconButton>
            ) : null
          ) : (working && !hasContent) ? (
            <IconButton
              size="icon-sm"
              variant="destructive"
              className="rounded-full"
              label={t("composer.stop")}
              data-fv-action="stop"
              shortcut={stopShortcut}
              onClick={onAbort}
            >
              <HugeiconsIcon strokeWidth={2} icon={SquareIcon} className="size-3.5 fill-current" />
            </IconButton>
          ) : runInterrupted && !hasContent ? (
            // An interrupted run leaves the caret empty; the primary action resumes
            // the turn instead of sending, so a follow-up is never sent in its place.
            <IconButton
              size="icon-sm"
              variant="default"
              className="rounded-full"
              label={t("composer.resume")}
              onClick={() => onResumeRun?.()}
            >
              <HugeiconsIcon strokeWidth={2} icon={PlayIcon} className="size-3.5 fill-current" />
            </IconButton>
          ) : (
            <IconButton
              size="icon-sm"
              variant="default"
              className="rounded-full"
              label={streaming ? t("composer.queue") : t("composer.send")}
              data-fv-action="send"
              shortcut={sendShortcut}
              disabled={disabled || !hasContent}
              onClick={submit}
            >
              <HugeiconsIcon strokeWidth={2} icon={ArrowUp02Icon} />
            </IconButton>
          )}
        </div>      </div>
    </div>
  );
}
