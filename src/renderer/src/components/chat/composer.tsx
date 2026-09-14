import { useEffect, useMemo, useRef, useState, type ClipboardEvent, type DragEvent, type JSX, type KeyboardEvent, type ReactNode } from "react";
import {
  ArrowUp,
  ChevronDown,
  FolderOpen,
  Hand,
  Mic,
  Plus,
  Search,
  Paperclip,
  ShieldAlert,
  ShieldCheck,
  Sparkles,
  Square,
  X,
} from "lucide-react";
import { Button } from "@/components/ui/button";
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
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Textarea } from "@/components/ui/textarea";
import { Input } from "@/components/ui/input";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import type {
  ChatAttachment,
  ContextUsage,
  FastVibeModel,
  Project,
  PermissionMode,
  QueueBehavior,
  QueuedPrompt,
  SlashCommand,
  ThinkingLevel,
} from "@shared/types";
import { filesToAttachments } from "@/lib/attachments";
import { cn } from "@/lib/utils";

const THINKING_LABELS: Record<ThinkingLevel, string> = {
  off: "关闭推理",
  minimal: "极低",
  low: "低",
  medium: "中",
  high: "高",
  xhigh: "极高",
  max: "最大",
};

const QUEUE_LABELS: Record<QueueBehavior, string> = {
  followUp: "完成后执行",
  steer: "立即打断",
};

const PERMISSION_LABELS: Record<PermissionMode, string> = {
  ask: "请求批准",
  smart: "帮我批准",
  full: "完全访问权限",
};

const PERMISSION_DESCRIPTIONS: Record<PermissionMode, string> = {
  ask: "编辑外部文件和使用互联网时始终询问",
  smart: "仅对检测到的风险操作请求批准",
  full: "可不受限制地访问互联网和你电脑上的任何文件",
};

const FALLBACK_THINKING: ThinkingLevel[] = ["off", "low", "medium", "high", "max"];

function modelKey(model: { provider: string; id: string }): string {
  return `${model.provider}/${model.id}`;
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

export function Composer({
  value,
  disabled,
  streaming,
  placeholder,
  models,
  model,
  thinkingLevel,
  workspaceLabel,
  projects,
  project,
  commands,
  permissionMode,
  queueBehavior,
  queued,
  attachments,
  history,
  contextPercent,
  contextUsage,
  onChange,
  onSubmit,
  onAbort,
  onPickWorkspace,
  onSelectProject,
  onModelChange,
  onThinkingChange,
  onPermissionModeChange,
  onQueueBehaviorChange,
  onAttachmentsChange,
  sendOnEnter = true,
}: {
  value: string;
  disabled: boolean;
  streaming: boolean;
  placeholder?: string;
  models: FastVibeModel[];
  model?: { provider: string; id: string };
  thinkingLevel?: string;
  workspaceLabel: string;
  projects: Project[];
  project?: string;
  commands: SlashCommand[];
  permissionMode: PermissionMode;
  onPermissionModeChange: (mode: PermissionMode) => void;
  queueBehavior: QueueBehavior;
  queued: QueuedPrompt[];
  attachments: ChatAttachment[];
  history: string[];
  contextPercent?: number | null;
  contextUsage?: ContextUsage | null;
  onChange: (value: string) => void;
  onSubmit: () => void;
  onAbort: () => void;
  onPickWorkspace: () => void;
  onSelectProject: (project: string | null) => void;
  onModelChange: (provider: string, modelId: string) => void;
  onThinkingChange: (level: string) => void;
  onQueueBehaviorChange: (behavior: QueueBehavior) => void;
  onAttachmentsChange: (attachments: ChatAttachment[]) => void;
  sendOnEnter?: boolean;
}): JSX.Element {
  const fileRef = useRef<HTMLInputElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const [dragging, setDragging] = useState(false);
  const [slashIndex, setSlashIndex] = useState(0);
  const [slashDismissed, setSlashDismissed] = useState(false);
  const [histIndex, setHistIndex] = useState<number | null>(null);
  const [projectOpen, setProjectOpen] = useState(false);
  const [projectQuery, setProjectQuery] = useState("");
  const histDraft = useRef("");
  const recognitionRef = useRef<{ start: () => void; stop: () => void; onresult: ((event: unknown) => void) | null; onend: (() => void) | null } | null>(null);
  const voiceBaseRef = useRef("");
  const [listening, setListening] = useState(false);

  useEffect(() => () => {
    recognitionRef.current?.stop();
    recognitionRef.current = null;
  }, []);

  function toggleVoice(): void {
    if (listening) {
      recognitionRef.current?.stop();
      return;
    }
    const Speech = (window as unknown as { SpeechRecognition?: new () => typeof recognitionRef.current; webkitSpeechRecognition?: new () => typeof recognitionRef.current }).SpeechRecognition
      ?? (window as unknown as { webkitSpeechRecognition?: new () => typeof recognitionRef.current }).webkitSpeechRecognition;
    if (!Speech) return;
    const recognition = new Speech() as NonNullable<typeof recognitionRef.current>;
    voiceBaseRef.current = value;
    recognition.onresult = (event) => {
      const result = event as { results?: ArrayLike<{ 0?: { transcript?: string }; isFinal?: boolean }> };
      const transcript = Array.from(result.results ?? []).map((item) => item[0]?.transcript ?? "").join("");
      if (transcript) onChange(`${voiceBaseRef.current}${voiceBaseRef.current && !voiceBaseRef.current.endsWith(" ") ? " " : ""}${transcript}`);
    };
    recognition.onend = () => { setListening(false); recognitionRef.current = null; };
    recognitionRef.current = recognition;
    setListening(true);
    recognition.start();
  }

  const slash = useMemo(() => {
    if (slashDismissed || !/^\/[^\s]*$/.test(value)) return [];
    const q = value.slice(1).toLowerCase();
    return commands
      .filter((item) => {
        const hay = `${item.name} ${(item.aliases ?? []).join(" ")}`.toLowerCase();
        return !q || hay.includes(q);
      })
      .slice(0, 8);
  }, [commands, slashDismissed, value]);

  useEffect(() => {
    setSlashIndex(0);
  }, [value]);

  function applySlash(name: string): void {
    onChange(`/${name} `);
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
        applySlash(slash[slashIndex]?.name ?? slash[0].name);
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
      if (event.key === "ArrowUp" && atFirstLine && history.length > 0) {
        event.preventDefault();
        if (histIndex === null) {
          histDraft.current = value;
          const next = history.length - 1;
          setHistIndex(next);
          onChange(history[next] ?? "");
        } else if (histIndex > 0) {
          const next = histIndex - 1;
          setHistIndex(next);
          onChange(history[next] ?? "");
        }
        return;
      }
      if (event.key === "ArrowDown" && atLastLine && histIndex !== null) {
        event.preventDefault();
        if (histIndex < history.length - 1) {
          const next = histIndex + 1;
          setHistIndex(next);
          onChange(history[next] ?? "");
        } else {
          setHistIndex(null);
          onChange(histDraft.current);
        }
        return;
      }
    }

    if (event.key === "Enter" && !event.shiftKey) {
      if (!sendOnEnter && !event.metaKey && !event.ctrlKey) return;
      event.preventDefault();
      submit();
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
  const thinkingOptions = selectedModel?.thinkingLevels?.length
    ? selectedModel.thinkingLevels
    : FALLBACK_THINKING;
  const thinkingValue = thinkingOptions.includes(thinkingLevel as ThinkingLevel)
    ? (thinkingLevel as ThinkingLevel)
    : thinkingOptions[0];
  const modelLabel = selectedModel?.name || selectedModel?.id || "选择模型";
  const hasContent = Boolean(value.trim() || attachments.length > 0);
  const filteredProjects = useMemo(() => {
    const query = projectQuery.trim().toLowerCase();
    if (!query) return projects;
    return projects.filter((item) => `${item.name} ${item.cwd}`.toLowerCase().includes(query));
  }, [projectQuery, projects]);

  function formatTokens(value: number | null | undefined): string {
    if (value == null || !Number.isFinite(value)) return "—";
    if (value >= 1000) return `${Math.round(value / 1000)}k`;
    return String(Math.round(value));
  }

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
      className="mx-auto w-full max-w-3xl px-6 pb-5"
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
                "flex w-full items-start gap-2 px-3 py-2 text-left text-sm",
                index === slashIndex ? "bg-muted" : "hover:bg-muted/60",
              )}
              onMouseEnter={() => setSlashIndex(index)}
              onClick={() => applySlash(item.name)}
            >
              <Sparkles className="mt-0.5 size-3.5 text-muted-foreground" />
              <span className="min-w-0">
                <span className="font-medium">/{item.name}</span>
                {item.description ? (
                  <span className="ml-2 text-xs text-muted-foreground">{item.description}</span>
                ) : null}
              </span>
            </button>
          ))}
        </div>
      ) : null}

      {queued.length > 0 ? (
        <div className="mb-2 space-y-1">
          {queued.map((item) => (
            <div
              key={item.id}
              className="flex items-center gap-2 rounded-lg border border-border bg-muted/40 px-2.5 py-1.5 text-[12px]"
            >
              <span className="min-w-0 flex-1 truncate">{item.text}</span>
              <span className="shrink-0 text-[11px] text-muted-foreground">{QUEUE_LABELS[item.behavior]}</span>
            </div>
          ))}
        </div>
      ) : null}

      {attachments.length > 0 ? (
        <div className="mb-2 flex flex-wrap gap-1.5">
          {attachments.map((item) => (
            <span
              key={item.id}
              className="flex items-center gap-1 rounded-md border border-border bg-muted/50 px-1.5 py-1 text-[11px]"
            >
              {item.kind === "image" && item.dataUrl ? (
                <img src={item.dataUrl} alt="" className="size-6 rounded object-cover" />
              ) : null}
              <span className="max-w-28 truncate">{item.name}</span>
              <button
                type="button"
                className="text-muted-foreground hover:text-foreground"
                onClick={() => onAttachmentsChange(attachments.filter((entry) => entry.id !== item.id))}
              >
                ×
              </button>
            </span>
          ))}
        </div>
      ) : null}

      <div className="mb-1.5 ml-1 flex items-center gap-1">
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
                className={cn(
                  "group flex h-8 items-center gap-1.5 rounded-full px-2.5 text-[13px] text-muted-foreground transition-colors hover:bg-muted hover:text-foreground",
                  project && "bg-muted/70 text-foreground",
                )}
              />
            }
          >
            <span
              className={cn("relative size-4 shrink-0", project && "cursor-pointer rounded-full hover:bg-muted-foreground/20")}
              aria-label={project ? "清除项目" : undefined}
              title={project ? "清除项目" : undefined}
              onClick={project ? (event) => {
                event.preventDefault();
                event.stopPropagation();
                onSelectProject(null);
              } : undefined}
            >
              <FolderOpen className={cn("absolute inset-0 size-4 transition-opacity", project && "group-hover:opacity-0")} />
              {project ? <X className="absolute inset-0 size-4 opacity-0 transition-opacity group-hover:opacity-100" /> : null}
            </span>
            <span className="max-w-48 truncate">{project ? projects.find((item) => item.cwd === project)?.name ?? workspaceLabel : "选择项目"}</span>
            {!project ? (
              <ChevronDown className="size-3.5" />
            ) : null}
          </PopoverTrigger>
          <PopoverContent align="start" side="top" sideOffset={6} className="w-[300px] gap-0 rounded-2xl p-1.5 shadow-lg">
            <div className="relative mb-0.5">
              <Search className="pointer-events-none absolute left-2 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
              <Input
                autoFocus
                value={projectQuery}
                placeholder="搜索项目"
                className="h-8 rounded-lg border-0 bg-transparent pl-7 text-sm shadow-none focus-visible:ring-0"
                onChange={(event) => setProjectQuery(event.target.value)}
              />
            </div>
            <div className="max-h-52 overflow-y-auto">
              {filteredProjects.length > 0 ? filteredProjects.map((item) => (
                <button
                  key={item.cwd}
                  type="button"
                  className={cn(
                    "flex w-full items-center gap-1.5 rounded-lg px-2 py-1.5 text-left text-sm transition-colors hover:bg-muted",
                    item.cwd === project && "bg-muted font-medium",
                  )}
                  onClick={() => {
                    onSelectProject(item.cwd);
                    setProjectOpen(false);
                  }}
                >
                  <FolderOpen className="size-4 shrink-0 text-muted-foreground" />
                  <span className="truncate">{item.name}</span>
                </button>
              )) : (
                <div className="px-2 py-2 text-sm text-muted-foreground">没有匹配的项目</div>
              )}
            </div>
            <div className="my-0.5 border-t border-border" />
            <button
              type="button"
              className="flex w-full items-center gap-1.5 rounded-lg px-2 py-1.5 text-left text-sm text-muted-foreground hover:bg-muted hover:text-foreground"
              onClick={() => {
                setProjectOpen(false);
                onPickWorkspace();
              }}
            >
              <Plus className="size-4" />
              <span>新建项目</span>
            </button>
          </PopoverContent>
        </Popover>
      </div>

      <div
        className={cn(
          "rounded-[22px] border border-border bg-card shadow-sm transition-colors focus-within:border-ring",
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
        <Textarea
          ref={textareaRef}
          rows={1}
          value={value}
          disabled={disabled}
          placeholder={placeholder ?? "随心输入"}
          className="field-sizing-content max-h-56 min-h-[52px] resize-none border-0 bg-transparent px-4 pt-3.5 text-[13.5px] leading-6 shadow-none focus-visible:ring-0 disabled:bg-transparent disabled:opacity-100 dark:bg-transparent"
          onChange={(event) => handleChange(event.target.value)}
          onKeyDown={handleKeyDown}
          onPaste={handlePaste}
        />

        <div className="flex items-center gap-1 px-2.5 pb-2.5">
          <Button
            size="icon-sm"
            variant="ghost"
            className="rounded-full text-muted-foreground"
            disabled={disabled}
            onClick={() => fileRef.current?.click()}
            aria-label="添加附件"
          >
            <Paperclip />
          </Button>
          <Button size="icon-sm" variant="ghost" className={cn("rounded-full text-muted-foreground", listening && "bg-red-50 text-red-600 dark:bg-red-950/30")} disabled={disabled} onClick={toggleVoice} aria-label={listening ? "停止语音输入" : "语音输入"} title={listening ? "停止语音输入" : "语音输入"}>
            <Mic />
          </Button>

          <DropdownMenu>
            <DropdownMenuTrigger
              render={
                <Chip className="text-orange-600 hover:bg-orange-50 hover:text-orange-700 dark:hover:bg-orange-950/30">
                  <ShieldAlert className="size-4" />
                  {PERMISSION_LABELS[permissionMode]}
                  <ChevronDown className="size-3" />
                </Chip>
              }
            />
            <DropdownMenuContent align="start" className="w-[300px] min-w-[300px] p-1">
              <DropdownMenuGroup>
                <DropdownMenuLabel className="px-1.5 py-1 text-xs text-muted-foreground">
                  应如何批准 ChatGPT 操作？
                </DropdownMenuLabel>
              </DropdownMenuGroup>
              <DropdownMenuRadioGroup
                value={permissionMode}
                onValueChange={(value) => onPermissionModeChange(value as PermissionMode)}
              >
                {(["ask", "smart", "full"] as PermissionMode[]).map((mode) => {
                  const Icon = mode === "ask" ? Hand : mode === "smart" ? ShieldAlert : ShieldCheck;
                  return (
                    <DropdownMenuRadioItem
                      key={mode}
                      value={mode}
                      className={cn(
                        "items-start gap-1.5 rounded-lg px-1.5 py-1.5 pr-7",
                        mode === permissionMode && "text-orange-600 focus:text-orange-600",
                      )}
                    >
                      <Icon className="mt-0.5 size-3.5 shrink-0" />
                      <span className="min-w-0">
                        <span className="block text-[13px] font-medium leading-4">{PERMISSION_LABELS[mode]}</span>
                        <span className="mt-0.5 block text-[11px] font-normal leading-3.5 text-muted-foreground">
                          {PERMISSION_DESCRIPTIONS[mode]}
                        </span>
                      </span>
                    </DropdownMenuRadioItem>
                  );
                })}
              </DropdownMenuRadioGroup>
            </DropdownMenuContent>
          </DropdownMenu>

          <div className="flex-1" />

          {contextUsedPercent != null && contextWindow > 0 ? (
            <div className="group relative">
              <div className="pointer-events-none absolute bottom-[calc(100%+12px)] right-0 z-20 w-48 rounded-2xl border border-border bg-popover px-4 py-3 text-center text-sm shadow-lg opacity-0 transition-opacity group-hover:opacity-100">
                <div className="font-semibold text-muted-foreground">背景信息窗口：</div>
                <div className="mt-1 leading-5">
                  {contextUsedPercent}% 已用（剩余 {Math.max(0, 100 - contextUsedPercent)}%）
                </div>
                <div className="leading-5">已用 {formatTokens(contextUsed)} 标记，共 {formatTokens(contextWindow)}</div>
              </div>
              <button
                type="button"
                className="flex size-7 items-center justify-center rounded-full text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
                aria-label="查看上下文窗口使用情况"
              >
                <span
                  className="size-3.5 rounded-full border-2 border-muted-foreground/20"
                  style={{ borderTopColor: "var(--muted-foreground)" }}
                  aria-hidden="true"
                />
              </button>
            </div>
          ) : null}

          <div className="relative">
            <DropdownMenu>
              <DropdownMenuTrigger
                render={
                  <Chip className="max-w-52">
                    <span className="truncate">{modelLabel}</span>
                    <ChevronDown className="size-3" />
                  </Chip>
                }
              />
              <DropdownMenuContent align="end" className="max-h-80 w-64 min-w-64 overflow-y-auto">
                <DropdownMenuGroup>
                  <DropdownMenuLabel>模型</DropdownMenuLabel>
                  {models.length === 0 ? (
                    <DropdownMenuLabel className="font-normal">暂无可用模型</DropdownMenuLabel>
                  ) : (
                    models.map((item) => (
                      <DropdownMenuCheckboxItem
                        key={modelKey(item)}
                        checked={modelKey(item) === selected}
                        onCheckedChange={() => onModelChange(item.provider, item.id)}
                      >
                        <span className="truncate">{item.name || item.id}</span>
                      </DropdownMenuCheckboxItem>
                    ))
                  )}
                </DropdownMenuGroup>
              </DropdownMenuContent>
            </DropdownMenu>
          </div>

          <DropdownMenu>
            <DropdownMenuTrigger
              render={
                <Chip>
                  {THINKING_LABELS[thinkingValue]}
                  <ChevronDown className="size-3" />
                </Chip>
              }
            />
            <DropdownMenuContent align="end" className="w-36 min-w-36">
              <DropdownMenuGroup>
                <DropdownMenuLabel>推理强度</DropdownMenuLabel>
                {thinkingOptions.map((level) => (
                  <DropdownMenuCheckboxItem
                    key={level}
                    checked={level === thinkingValue}
                    onCheckedChange={() => onThinkingChange(level)}
                  >
                    {THINKING_LABELS[level]}
                  </DropdownMenuCheckboxItem>
                ))}
              </DropdownMenuGroup>
            </DropdownMenuContent>
          </DropdownMenu>

          {streaming ? (
            <DropdownMenu>
              <DropdownMenuTrigger
                render={
                  <Chip>
                    {QUEUE_LABELS[queueBehavior]}
                    <ChevronDown className="size-3" />
                  </Chip>
                }
              />
              <DropdownMenuContent align="end" className="w-36 min-w-36">
                <DropdownMenuGroup>
                  <DropdownMenuLabel>发送方式</DropdownMenuLabel>
                  <DropdownMenuCheckboxItem
                    checked={queueBehavior === "followUp"}
                    onCheckedChange={() => onQueueBehaviorChange("followUp")}
                  >
                    完成后执行
                  </DropdownMenuCheckboxItem>
                  <DropdownMenuCheckboxItem
                    checked={queueBehavior === "steer"}
                    onCheckedChange={() => onQueueBehaviorChange("steer")}
                  >
                    立即打断
                  </DropdownMenuCheckboxItem>
                </DropdownMenuGroup>
              </DropdownMenuContent>
            </DropdownMenu>
          ) : null}

          {streaming && hasContent ? (
            <Button
              size="icon-sm"
              variant="default"
              className="rounded-full"
              disabled={disabled}
              onClick={submit}
              aria-label="加入队列"
            >
              <ArrowUp />
            </Button>
          ) : null}

          {streaming ? (
            <Button
              size="icon-sm"
              variant="secondary"
              className="rounded-full"
              onClick={onAbort}
              aria-label="停止"
            >
              <Square className="size-3.5 fill-current" />
            </Button>
          ) : (
            <Button
              size="icon-sm"
              variant="default"
              className="rounded-full"
              disabled={disabled || !hasContent}
              onClick={submit}
              aria-label="发送"
            >
              <ArrowUp />
            </Button>
          )}
        </div>
      </div>
    </div>
  );
}
