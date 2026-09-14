import { useEffect, useMemo, useState, type JSX, type ReactNode } from "react";
import { HugeiconsIcon } from "@hugeicons/react";
import {
  ArrowDown01Icon,
  ArrowRight01Icon,
  BotIcon,
  Flag01Icon,
  Folder01Icon,
  ArrowShrink02Icon,
  ListChecksIcon,
  MoreHorizontalIcon,
  SquareTerminalIcon,
} from "@hugeicons/core-free-icons";
import { Button } from "@/components/ui/button";
import { IconButton } from "@/components/icon-button";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import { compactTodos, latestTodos, type TodoItem } from "@/lib/todos";
import { argString, familyOf, unwrapShellCommand } from "@/lib/tool-presentation";
import type { ChatMessage, RunMode, SubagentInfo } from "@shared/types";
import { SubagentBrowser } from "./session-controls";
import { TodoRow } from "./todo-list";

type DisplayMode = "auto" | "panel" | "mini";
type VisualMode = "panel" | "mini";

const MODE_KEY = "fastvibe.summary-panel-mode";
const START = new Map<string, number>();

function readMode(): DisplayMode {
  try {
    const raw = localStorage.getItem(MODE_KEY);
    if (raw === "panel" || raw === "mini" || raw === "auto") return raw;
  } catch {
    // ignore
  }
  return "auto";
}

function writeMode(mode: DisplayMode): void {
  try {
    localStorage.setItem(MODE_KEY, mode);
  } catch {
    // ignore
  }
}

function rememberStart(id: string): number {
  const existing = START.get(id);
  if (existing) return existing;
  const now = Date.now();
  START.set(id, now);
  return now;
}

function pruneStarts(live: Set<string>): void {
  for (const id of START.keys()) {
    if (!live.has(id)) START.delete(id);
  }
}

function formatElapsed(seconds: number): string {
  const total = Math.max(0, Math.floor(seconds));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const rest = total % 60;
  const parts: string[] = [];
  if (hours > 0) parts.push(`${hours}小时`);
  if (minutes > 0) parts.push(`${minutes}分`);
  if (rest > 0 || parts.length === 0) parts.push(`${rest}秒`);
  return parts.join(" ");
}

function latestGoal(messages: ChatMessage[]): { text: string; createdAt: number } | null {
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i];
    if (message.kind === "goal" && message.text.trim()) {
      return { text: message.text.trim(), createdAt: message.createdAt };
    }
  }
  return null;
}

function goalTurns(
  messages: ChatMessage[],
  since: number,
  currentIncomplete: boolean,
): Array<{ iteration: number; title: string; completed: boolean }> {
  const turns: Array<{ iteration: number; title: string; completed: boolean }> = [];
  let index = 0;
  for (const message of messages) {
    if (message.createdAt < since || message.role !== "assistant") continue;
    const title = message.text.trim().split("\n").find((line) => line.trim())?.trim();
    if (!title && message.tools.length === 0) continue;
    index += 1;
    turns.push({
      iteration: index,
      title: title ? title.slice(0, 80) : `第 ${index} 次迭代`,
      completed: true,
    });
  }
  if (turns.length > 0 && currentIncomplete) turns[turns.length - 1]!.completed = false;
  return turns;
}

function runningTerminals(messages: ChatMessage[]): Array<{ id: string; title: string }> {
  const list: Array<{ id: string; title: string }> = [];
  for (const message of messages) {
    for (const tool of message.tools) {
      if (tool.status !== "running" || familyOf(tool.name) !== "terminal") continue;
      const command = argString(tool.args, ["command", "cmd", "script", "parsed_cmd"]);
      list.push({ id: tool.id, title: unwrapShellCommand(command) || tool.name });
    }
  }
  return list;
}

function isLiveAgent(agent: SubagentInfo): boolean {
  const status = (agent.status ?? "").toLowerCase();
  if (!status) return true;
  return !/^(done|completed|ended|error|failed|cancelled|canceled|stopped)$/.test(status);
}

function FoldTrigger({ label, items }: { label: string; items: TodoItem[] }): JSX.Element {
  const [open, setOpen] = useState(false);
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger
        render={
          <button
            type="button"
            className="flex h-8 w-full min-w-0 items-center gap-2 rounded-lg px-2 text-left text-[12.5px] text-muted-foreground hover:bg-muted/60"
          />
        }
      >
        <HugeiconsIcon strokeWidth={2} icon={Folder01Icon} className="size-3.5 shrink-0" />
        <span className="min-w-0 truncate">{label}</span>
      </PopoverTrigger>
      <PopoverContent align="start" side="left" sideOffset={4} className="w-80 max-w-[min(20rem,calc(100vw-2rem))] gap-0 rounded-xl p-3">
        <p className="flex h-8 shrink-0 items-center px-2 text-[12.5px] text-muted-foreground">{label}</p>
        <ul className="max-h-[min(24rem,calc(100dvh-2rem))] min-h-0 space-y-0 overflow-y-auto pr-1">
          {items.map((item) => (
            <li key={item.id}>
              <TodoRow item={item} compact />
            </li>
          ))}
        </ul>
      </PopoverContent>
    </Popover>
  );
}

function foldLabel(group: "preceding" | "following", items: TodoItem[]): string {
  const allDone = items.every((item) => item.status === "completed" || item.status === "cancelled");
  const allPending = items.every((item) => item.status === "pending");
  if (group === "preceding") return allDone ? `已完成 ${items.length} 项` : `前面 ${items.length} 项`;
  return allPending ? `待处理 ${items.length} 项` : `后面 ${items.length} 项`;
}

function Section({
  title,
  trailing,
  separated = false,
  defaultOpen = true,
  maxHeight,
  children,
}: {
  title: string;
  trailing?: ReactNode;
  separated?: boolean;
  defaultOpen?: boolean;
  maxHeight?: string;
  children: ReactNode;
}): JSX.Element {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <Collapsible
      open={open}
      onOpenChange={setOpen}
      className={cn("min-w-0 flex-none", separated && "border-t border-border pt-2")}
    >
      <div className="mb-0.5 flex h-8 min-w-0 items-center gap-1.5 px-2 pr-8">
        <CollapsibleTrigger className="group flex min-w-0 shrink-0 items-center gap-1 text-left">
          <span className="shrink-0 text-[12.5px] text-muted-foreground">{title}</span>
          <HugeiconsIcon
            strokeWidth={2}
            icon={open ? ArrowDown01Icon : ArrowRight01Icon}
            className="size-3.5 shrink-0 text-muted-foreground opacity-0 transition-opacity group-hover:opacity-100"
          />
        </CollapsibleTrigger>
        {trailing ? (
          <div className="inline-flex min-w-0 max-w-full shrink items-center gap-1.5 text-[11.5px] text-muted-foreground">
            {trailing}
          </div>
        ) : null}
      </div>
      <CollapsibleContent>
        {maxHeight ? <div className={cn("min-h-0 overflow-x-hidden overflow-y-auto pr-1", maxHeight)}>{children}</div> : children}
      </CollapsibleContent>
    </Collapsible>
  );
}

function MiniRow({ icon, children }: { icon: ReactNode; children: ReactNode }): JSX.Element {
  return (
    <span className="flex min-w-0 items-center gap-2 px-2.5 py-1.5">
      <span className="shrink-0 text-foreground [&_svg]:size-4">{icon}</span>
      <span className="flex min-w-0 items-center gap-1.5 text-[12.5px]">{children}</span>
    </span>
  );
}

/**
 * Floating summary: 目标 / 进程 / 终端 / 智能体. Git lives in the right side pane.
 */
export function SummaryPanel({
  messages,
  streaming,
  runMode,
  subagents,
  streams,
}: {
  messages: ChatMessage[];
  streaming: boolean;
  runMode: RunMode;
  subagents: SubagentInfo[];
  streams: Record<string, ChatMessage[]>;
}): JSX.Element | null {
  const [mode, setMode] = useState<DisplayMode>(readMode);
  const [override, setOverride] = useState<VisualMode | null>(null);
  const [wide, setWide] = useState(() => (typeof window === "undefined" ? true : window.matchMedia("(min-width: 1280px)").matches));
  const [now, setNow] = useState(() => Date.now());
  const [agentOpen, setAgentOpen] = useState<string | null>(null);

  useEffect(() => {
    const media = window.matchMedia("(min-width: 1280px)");
    const onChange = () => setWide(media.matches);
    onChange();
    media.addEventListener("change", onChange);
    return () => media.removeEventListener("change", onChange);
  }, []);

  const todos = useMemo(() => latestTodos(messages), [messages]);
  const goal = useMemo(() => latestGoal(messages), [messages]);
  const terminals = useMemo(() => runningTerminals(messages), [messages]);
  const agents = useMemo(() => subagents.filter(isLiveAgent), [subagents]);
  const turns = useMemo(
    () => (goal ? goalTurns(messages, goal.createdAt, streaming || runMode === "goal") : []),
    [goal, messages, streaming, runMode],
  );

  const live = goal || todos.length > 0 || terminals.length > 0 || agents.length > 0;
  const ticking = Boolean(goal && (streaming || runMode === "goal")) || terminals.length > 0 || agents.length > 0;

  useEffect(() => {
    if (!ticking) return;
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [ticking]);

  const liveIds = useMemo(() => {
    const ids = new Set<string>();
    for (const item of terminals) ids.add(`term:${item.id}`);
    for (const agent of agents) ids.add(`agent:${agent.id}`);
    return ids;
  }, [terminals, agents]);

  useEffect(() => {
    pruneStarts(liveIds);
  }, [liveIds]);

  if (messages.length === 0 || !live) return null;

  const visual: VisualMode = override ?? (mode === "auto" ? (wide ? "panel" : "mini") : mode);
  const done = todos.filter((item) => item.status === "completed").length;
  const allDone = todos.length > 0 && done >= todos.length;
  const folded = compactTodos(todos);
  const currentTodo = todos.find((item) => item.status === "in_progress") ?? todos.find((item) => item.status !== "completed" && item.status !== "cancelled");
  const lastTodo = todos.filter((item) => item.status === "completed").at(-1);
  const goalActive = Boolean(goal) && (streaming || runMode === "goal");
  const goalEnd = goalActive ? now : (messages.at(-1)?.createdAt ?? goal?.createdAt ?? now);
  const goalElapsed = goal ? formatElapsed((goalEnd - goal.createdAt) / 1000) : "";

  function handleMode(next: string): void {
    const value = next === "panel" || next === "mini" || next === "auto" ? next : "auto";
    setOverride(null);
    setMode(value);
    writeMode(value);
  }

  const mini = currentTodo ? (
    <MiniRow icon={<HugeiconsIcon strokeWidth={2} icon={ListChecksIcon} />}>
      <span className="min-w-0 truncate">{currentTodo.content}</span>
    </MiniRow>
  ) : goal && goalActive ? (
    <MiniRow icon={<HugeiconsIcon strokeWidth={2} icon={Flag01Icon} />}>
      <span className="min-w-0 truncate">{goal.text}</span>
    </MiniRow>
  ) : goal ? (
    <MiniRow icon={<HugeiconsIcon strokeWidth={2} icon={Flag01Icon} />}>
      <span className="min-w-0 truncate">{goal.text}</span>
    </MiniRow>
  ) : lastTodo ? (
    <MiniRow icon={<HugeiconsIcon strokeWidth={2} icon={ListChecksIcon} />}>
      <span className="min-w-0 truncate">{lastTodo.content}</span>
    </MiniRow>
  ) : todos.length > 0 ? (
    <MiniRow icon={<HugeiconsIcon strokeWidth={2} icon={ListChecksIcon} />}>
      <span className="min-w-0 truncate">进程</span>
      <span className="shrink-0 text-muted-foreground">{done}/{todos.length}</span>
    </MiniRow>
  ) : agents.length > 0 ? (
    <MiniRow icon={<HugeiconsIcon strokeWidth={2} icon={BotIcon} />}>
      <span className="shrink-0">{agents.length === 1 ? "1 运行" : `${agents.length} 运行`}</span>
    </MiniRow>
  ) : terminals.length > 0 ? (
    <MiniRow icon={<HugeiconsIcon strokeWidth={2} icon={SquareTerminalIcon} />}>
      <span className="shrink-0">{terminals.length === 1 ? "1 个后台运行" : `${terminals.length} 个后台运行`}</span>
    </MiniRow>
  ) : null;

  const sections: JSX.Element[] = [];
  if (goal) {
    sections.push(
      <Section
        key="goal"
        title="目标"
        separated={sections.length > 0}
        trailing={
          <>
            <span className="shrink-0 tabular-nums">{goalElapsed}</span>
          </>
        }
        maxHeight="max-h-48"
      >
        <div className="space-y-0">
          {(turns.length > 0 ? turns : [{ iteration: 1, title: goal.text, completed: !goalActive }]).map((turn) => (
            <div
              key={turn.iteration}
              className="flex min-w-0 items-start gap-2 rounded-lg px-2 py-2 hover:bg-muted/60"
              title={turn.title}
            >
              {turn.completed ? (
                <span className="flex size-4 shrink-0 items-center justify-center rounded-full border border-success text-[10px] tabular-nums text-success">
                  {turn.iteration}
                </span>
              ) : (
                <HugeiconsIcon strokeWidth={2} icon={Flag01Icon} className="size-4 shrink-0 text-muted-foreground" />
              )}
              <p className="line-clamp-3 min-w-0 flex-1 text-[12.5px] leading-4 text-foreground">{turn.title}</p>
            </div>
          ))}
        </div>
      </Section>,
    );
  }
  if (todos.length > 0) {
    sections.push(
      <Section
        key="todo"
        title="进程"
        separated={sections.length > 0}
        trailing={<span className={cn("tabular-nums", allDone ? "text-success" : "text-muted-foreground")}>{done}/{todos.length}</span>}
        maxHeight="max-h-80"
      >
        <ul className="space-y-0 pb-1">
          {folded.compact && folded.preceding.length > 0 ? (
            <li>
              <FoldTrigger label={foldLabel("preceding", folded.preceding)} items={folded.preceding} />
            </li>
          ) : null}
          {folded.focus.map((item) => (
            <li key={item.id}>
              <TodoRow item={item} compact />
            </li>
          ))}
          {folded.compact && folded.following.length > 0 ? (
            <li>
              <FoldTrigger label={foldLabel("following", folded.following)} items={folded.following} />
            </li>
          ) : null}
        </ul>
      </Section>,
    );
  }
  if (terminals.length > 0) {
    const longest = Math.max(
      1,
      ...terminals.map((item) => Math.floor((now - rememberStart(`term:${item.id}`)) / 1000)),
    );
    sections.push(
      <Section
        key="term"
        title="终端"
        separated={sections.length > 0}
        defaultOpen={false}
        trailing={
          <>
            <span className="min-w-0 truncate">{formatElapsed(longest)}</span>
            <span className="shrink-0">·</span>
            <span className="shrink-0">{terminals.length === 1 ? "1 个后台运行" : `${terminals.length} 个后台运行`}</span>
          </>
        }
        maxHeight="max-h-48"
      >
        <ul className="space-y-0">
          {terminals.map((item) => (
            <li key={item.id} className="flex min-w-0 items-start gap-2 rounded-lg px-2 py-2 hover:bg-muted/60">
              <HugeiconsIcon strokeWidth={2} icon={SquareTerminalIcon} className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
              <div className="min-w-0 flex-1">
                <p className="line-clamp-2 text-[12.5px] leading-5 text-foreground">{item.title}</p>
                <p className="mt-1 text-[11.5px] tabular-nums text-muted-foreground">
                  {formatElapsed((now - rememberStart(`term:${item.id}`)) / 1000)}
                </p>
              </div>
            </li>
          ))}
        </ul>
      </Section>,
    );
  }
  if (agents.length > 0) {
    const longest = Math.max(
      1,
      ...agents.map((agent) => Math.floor((now - rememberStart(`agent:${agent.id}`)) / 1000)),
    );
    sections.push(
      <Section
        key="agent"
        title="智能体"
        separated={sections.length > 0}
        defaultOpen={false}
        trailing={
          <>
            <span className="min-w-0 truncate">{formatElapsed(longest)}</span>
            <span className="shrink-0">·</span>
            <span className="shrink-0">{agents.length === 1 ? "1 运行" : `${agents.length} 运行`}</span>
          </>
        }
        maxHeight="max-h-48"
      >
        <ul className="space-y-0">
          {agents.map((agent) => (
            <li key={agent.id}>
              <button
                type="button"
                className="flex w-full min-w-0 items-start gap-2 rounded-lg px-2 py-2 text-left hover:bg-muted/60"
                onClick={() => setAgentOpen(agent.id)}
              >
                <HugeiconsIcon strokeWidth={2} icon={BotIcon} className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
                <div className="min-w-0 flex-1">
                  <p className="line-clamp-2 text-[12.5px] leading-5 text-foreground">{agent.name || agent.id}</p>
                  <p className="mt-1 text-[11.5px] text-muted-foreground">
                    <span className="tabular-nums">{formatElapsed((now - rememberStart(`agent:${agent.id}`)) / 1000)}</span>
                    {agent.status || agent.detail ? <span> · {agent.status || agent.detail}</span> : null}
                  </p>
                </div>
              </button>
            </li>
          ))}
        </ul>
      </Section>,
    );
  }

  return (
    <>
      <div className="pointer-events-none absolute top-0 right-0 z-20 flex justify-end px-4 pt-3">
        <aside
          aria-label="状态"
          data-state={visual}
          className={cn(
            "pointer-events-auto relative overflow-hidden rounded-2xl border border-border bg-popover text-foreground shadow-md",
            visual === "mini"
              ? "inline-flex h-8 w-max max-w-[calc(100vw-1.5rem)] flex-col"
              : "flex max-h-[min(64dvh,32rem)] w-80 max-w-[calc(100vw-1.5rem)] flex-col",
          )}
        >
          {visual === "panel" ? (
            <div className="absolute top-3 right-3 z-10 flex items-center gap-1">
              <DropdownMenu>
                <DropdownMenuTrigger
                  render={
                    <Button type="button" variant="ghost" size="icon-xs" className="size-6" aria-label="状态面板展开策略" title="状态面板展开策略" />
                  }
                >
                  <HugeiconsIcon strokeWidth={2} icon={MoreHorizontalIcon} className="size-3.5" />
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end" side="bottom" className="w-44 min-w-44">
                  <DropdownMenuRadioGroup value={mode} onValueChange={handleMode}>
                    <DropdownMenuRadioItem value="auto">自动展开</DropdownMenuRadioItem>
                    <DropdownMenuRadioItem value="panel">始终展开</DropdownMenuRadioItem>
                    <DropdownMenuRadioItem value="mini">始终收起</DropdownMenuRadioItem>
                  </DropdownMenuRadioGroup>
                </DropdownMenuContent>
              </DropdownMenu>
              <IconButton
                type="button"
                variant="ghost"
                size="icon-xs"
                className="size-6"
                label="收起为胶囊"
                onClick={() => setOverride("mini")}
              >
                <HugeiconsIcon strokeWidth={2} icon={ArrowShrink02Icon} className="size-3.5" />
              </IconButton>
            </div>
          ) : null}

          {visual === "mini" ? (
            <Tooltip>
              <TooltipTrigger
                render={
                  <button
                    type="button"
                    aria-label="展开状态"
                    className="group inline-flex w-max max-w-80 cursor-pointer flex-col items-stretch text-left hover:bg-muted/60"
                    onClick={() => setOverride("panel")}
                  />
                }
              >
                {mini}
              </TooltipTrigger>
              <TooltipContent side="left">展开状态</TooltipContent>
            </Tooltip>
          ) : (
            <div className="flex min-h-0 flex-1 flex-col gap-2 overflow-x-hidden overflow-y-auto p-2 pt-8">
              {sections}
            </div>
          )}
        </aside>
      </div>

      <Dialog open={Boolean(agentOpen)} onOpenChange={(open) => { if (!open) setAgentOpen(null); }}>
        <DialogContent className="sm:max-w-2xl">
          <DialogHeader>
            <DialogTitle>子 Agent</DialogTitle>
          </DialogHeader>
          <SubagentBrowser subagents={subagents} streams={streams} initialId={agentOpen} />
        </DialogContent>
      </Dialog>
    </>
  );
}
