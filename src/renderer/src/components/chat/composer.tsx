import { useMemo, useRef, useState, type DragEvent, type JSX, type KeyboardEvent, type ReactNode } from "react";
import {
  ArrowUp,
  ChevronDown,
  FolderOpen,
  ListTodo,
  Paperclip,
  Sparkles,
  Square,
  Target,
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
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Textarea } from "@/components/ui/textarea";
import type {
  ChatAttachment,
  FastVibeModel,
  Project,
  QueueBehavior,
  RunMode,
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

const RUN_MODE_LABELS: Record<RunMode, string> = {
  agent: "对话",
  plan: "计划",
  goal: "目标",
};

const QUEUE_LABELS: Record<QueueBehavior, string> = {
  followUp: "完成后执行",
  steer: "立即打断",
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
  runMode,
  queueBehavior,
  queuedCount,
  attachments,
  onChange,
  onSubmit,
  onAbort,
  onPickWorkspace,
  onSelectProject,
  onModelChange,
  onThinkingChange,
  onRunModeChange,
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
  runMode: RunMode;
  queueBehavior: QueueBehavior;
  queuedCount?: number;
  attachments: ChatAttachment[];
  onChange: (value: string) => void;
  onSubmit: () => void;
  onAbort: () => void;
  onPickWorkspace: () => void;
  onSelectProject: (project: string | null) => void;
  onModelChange: (provider: string, modelId: string) => void;
  onThinkingChange: (level: string) => void;
  onRunModeChange: (mode: RunMode) => void;
  onQueueBehaviorChange: (behavior: QueueBehavior) => void;
  onAttachmentsChange: (attachments: ChatAttachment[]) => void;
  sendOnEnter?: boolean;
}): JSX.Element {
  const fileRef = useRef<HTMLInputElement>(null);
  const [dragging, setDragging] = useState(false);
  const slash = useMemo(() => {
    if (!/^\/[^\s]*$/.test(value)) return [];
    const q = value.slice(1).toLowerCase();
    return commands
      .filter((item) => {
        const hay = `${item.name} ${(item.aliases ?? []).join(" ")}`.toLowerCase();
        return !q || hay.includes(q);
      })
      .slice(0, 8);
  }, [commands, value]);

  function handleKeyDown(event: KeyboardEvent<HTMLTextAreaElement>): void {
    if (event.key === "Tab" && slash[0]) {
      event.preventDefault();
      onChange(`/${slash[0].name} `);
      return;
    }
    if (event.key === "Enter" && !event.shiftKey) {
      if (!sendOnEnter && !event.metaKey && !event.ctrlKey) return;
      event.preventDefault();
      onSubmit();
    }
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
        <div className="mb-2 overflow-hidden rounded-xl border border-border bg-popover shadow-sm">
          {slash.map((item) => (
            <button
              key={item.name}
              type="button"
              className="flex w-full items-start gap-2 px-3 py-2 text-left text-sm hover:bg-muted"
              onClick={() => onChange(`/${item.name} `)}
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

      <div className="mb-1.5 ml-1 flex items-center gap-0.5">
        <DropdownMenu>
          <DropdownMenuTrigger
            render={
              <button
                type="button"
                className="flex items-center gap-1.5 rounded-md px-1.5 py-1 text-[12px] text-muted-foreground hover:bg-muted hover:text-foreground"
              />
            }
          >
            <FolderOpen className="size-3.5" />
            {workspaceLabel}
            <ChevronDown className="size-3" />
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start" className="max-h-80 w-64 min-w-64 overflow-y-auto">
            <DropdownMenuGroup>
              <DropdownMenuLabel>项目</DropdownMenuLabel>
              {projects.length === 0 ? (
                <DropdownMenuLabel className="font-normal">还没有项目</DropdownMenuLabel>
              ) : (
                projects.map((item) => (
                  <DropdownMenuCheckboxItem
                    key={item.cwd}
                    checked={item.cwd === project}
                    onCheckedChange={() => onSelectProject(item.cwd)}
                  >
                    <span className="truncate">{item.name}</span>
                  </DropdownMenuCheckboxItem>
                ))
              )}
            </DropdownMenuGroup>
            <DropdownMenuSeparator />
            <DropdownMenuGroup>
              <DropdownMenuItem onClick={onPickWorkspace}>
                <FolderOpen />
                打开项目…
              </DropdownMenuItem>
            </DropdownMenuGroup>
          </DropdownMenuContent>
        </DropdownMenu>
        {project ? (
          <button
            type="button"
            className="rounded-md px-1 py-1 text-muted-foreground hover:bg-muted hover:text-foreground"
            onClick={() => onSelectProject(null)}
            aria-label="清除项目"
            title="清除项目"
          >
            <X className="size-3.5" />
          </button>
        ) : null}
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
          value={value}
          disabled={disabled}
          placeholder={placeholder ?? "随心输入"}
          className="max-h-56 min-h-[52px] resize-none border-0 bg-transparent px-4 pt-3.5 text-[13.5px] leading-6 shadow-none focus-visible:ring-0 disabled:bg-transparent disabled:opacity-100 dark:bg-transparent"
          onChange={(event) => onChange(event.target.value)}
          onKeyDown={handleKeyDown}
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

          <DropdownMenu>
            <DropdownMenuTrigger
              render={
                <Chip>
                  {RUN_MODE_LABELS[runMode]}
                  <ChevronDown className="size-3" />
                </Chip>
              }
            />
            <DropdownMenuContent align="start" className="w-32 min-w-32">
              <DropdownMenuGroup>
                <DropdownMenuLabel>执行模式</DropdownMenuLabel>
                <DropdownMenuCheckboxItem
                  checked={runMode === "agent"}
                  onCheckedChange={() => onRunModeChange("agent")}
                >
                  对话
                </DropdownMenuCheckboxItem>
                <DropdownMenuCheckboxItem
                  checked={runMode === "plan"}
                  onCheckedChange={() => onRunModeChange("plan")}
                >
                  <ListTodo />
                  计划
                </DropdownMenuCheckboxItem>
                <DropdownMenuCheckboxItem
                  checked={runMode === "goal"}
                  onCheckedChange={() => onRunModeChange("goal")}
                >
                  <Target />
                  目标
                </DropdownMenuCheckboxItem>
              </DropdownMenuGroup>
            </DropdownMenuContent>
          </DropdownMenu>

          {typeof queuedCount === "number" && queuedCount > 0 ? (
            <span className="rounded-full bg-muted px-2 py-1 text-[11px] text-muted-foreground">
              队列 {queuedCount}
            </span>
          ) : null}

          <div className="flex-1" />

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
              disabled={disabled || (!value.trim() && attachments.length === 0)}
              onClick={onSubmit}
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
