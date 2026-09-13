import { useState, type JSX } from "react";
import {
  Bot,
  Check,
  Download,
  ListTodo,
  ListTree,
  MoreHorizontal,
  Scissors,
} from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
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
import { ScrollArea } from "@/components/ui/scroll-area";
import { Textarea } from "@/components/ui/textarea";
import type {
  ChatMessage,
  OmpSessionState,
  QueuedPrompt,
  SessionStats,
  SubagentInfo,
} from "@shared/types";
import { MessageList } from "./message-list";

/** Header dropdown holding session actions. */
export function SessionMenu({
  session,
  subagents,
  streams,
  stats,
  onCompact,
  onToggleAutoCompact,
  onToggleInterrupt,
  onToggleSteering,
  onToggleFollowUp,
  onExport,
}: {
  session: OmpSessionState | null;
  subagents: SubagentInfo[];
  streams: Record<string, ChatMessage[]>;
  stats?: SessionStats | null;
  onCompact: (instructions?: string) => void;
  onToggleAutoCompact: (enabled: boolean) => void;
  onToggleInterrupt: (mode: "immediate" | "wait") => void;
  onToggleSteering: (mode: "all" | "one-at-a-time") => void;
  onToggleFollowUp: (mode: "all" | "one-at-a-time") => void;
  onExport: () => void;
}): JSX.Element {
  const [compactOpen, setCompactOpen] = useState(false);
  const [compactHint, setCompactHint] = useState("");
  const [agentsOpen, setAgentsOpen] = useState(false);

  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger render={<Button size="icon-sm" variant="ghost" />}>
          <MoreHorizontal />
          <span className="sr-only">会话设置</span>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="w-56 min-w-56">
          <DropdownMenuGroup>
            <DropdownMenuLabel>会话</DropdownMenuLabel>
            <DropdownMenuItem onClick={() => setCompactOpen(true)}>
              <Scissors />
              压缩上下文
            </DropdownMenuItem>
            <DropdownMenuCheckboxItem
              checked={session?.autoCompactionEnabled ?? true}
              onCheckedChange={(checked) => onToggleAutoCompact(Boolean(checked))}
            >
              自动压缩
            </DropdownMenuCheckboxItem>
          </DropdownMenuGroup>
          <DropdownMenuSeparator />
          <DropdownMenuGroup>
            <DropdownMenuLabel>排队与打断</DropdownMenuLabel>
            <DropdownMenuCheckboxItem
              checked={session?.interruptMode === "wait"}
              onCheckedChange={(checked) => onToggleInterrupt(checked ? "wait" : "immediate")}
            >
              打断前等本回合结束
            </DropdownMenuCheckboxItem>
            <DropdownMenuCheckboxItem
              checked={session?.steeringMode === "all"}
              onCheckedChange={(checked) => onToggleSteering(checked ? "all" : "one-at-a-time")}
            >
              打断消息一次全部执行
            </DropdownMenuCheckboxItem>
            <DropdownMenuCheckboxItem
              checked={session?.followUpMode === "all"}
              onCheckedChange={(checked) => onToggleFollowUp(checked ? "all" : "one-at-a-time")}
            >
              稍后消息一次全部执行
            </DropdownMenuCheckboxItem>
          </DropdownMenuGroup>
          <DropdownMenuSeparator />
          <DropdownMenuGroup>
            {subagents.length > 0 ? (
              <DropdownMenuItem onClick={() => setAgentsOpen(true)}>
                <Bot />
                查看子 Agent
                <Badge variant="secondary" className="ml-auto">
                  {subagents.length}
                </Badge>
              </DropdownMenuItem>
            ) : null}
            <DropdownMenuItem onClick={onExport}>
              <Download />
              导出 HTML
            </DropdownMenuItem>
            {stats?.tokens?.total != null ? (
              <DropdownMenuLabel className="font-normal">
                {stats.tokens.total.toLocaleString()} tokens
                {typeof stats.cost === "number" ? ` · $${stats.cost.toFixed(3)}` : ""}
              </DropdownMenuLabel>
            ) : null}
          </DropdownMenuGroup>
        </DropdownMenuContent>
      </DropdownMenu>

      <Dialog open={compactOpen} onOpenChange={setCompactOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>压缩上下文</DialogTitle>
          </DialogHeader>
          <Textarea
            value={compactHint}
            placeholder="可选：压缩时希望保留的重点"
            className="min-h-24"
            onChange={(event) => setCompactHint(event.target.value)}
          />
          <DialogFooter>
            <Button variant="outline" onClick={() => setCompactOpen(false)}>
              取消
            </Button>
            <Button
              onClick={() => {
                onCompact(compactHint.trim() || undefined);
                setCompactOpen(false);
                setCompactHint("");
              }}
            >
              开始压缩
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={agentsOpen} onOpenChange={setAgentsOpen}>
        <DialogContent className="sm:max-w-2xl">
          <DialogHeader>
            <DialogTitle>子 Agent</DialogTitle>
          </DialogHeader>
          <SubagentBrowser subagents={subagents} streams={streams} />
        </DialogContent>
      </Dialog>
    </>
  );
}

function SubagentBrowser({
  subagents,
  streams,
}: {
  subagents: SubagentInfo[];
  streams: Record<string, ChatMessage[]>;
}): JSX.Element {
  const [active, setActive] = useState<string | null>(subagents[0]?.id ?? null);
  const [loaded, setLoaded] = useState<Record<string, ChatMessage[]>>({});

  async function select(id: string): Promise<void> {
    setActive(id);
    if (streams[id]?.length || loaded[id]) return;
    try {
      const messages = await window.fastvibe.omp.getSubagentMessages(id);
      setLoaded((prev) => ({ ...prev, [id]: messages }));
    } catch {
      setLoaded((prev) => ({ ...prev, [id]: [] }));
    }
  }

  const messages = active ? streams[active] ?? loaded[active] ?? [] : [];

  return (
    <div className="flex gap-3">
      <div className="w-40 shrink-0 space-y-1">
        {subagents.map((agent) => (
          <button
            key={agent.id}
            type="button"
            className={`flex w-full flex-col rounded-md px-2 py-1.5 text-left text-xs ${
              active === agent.id ? "bg-muted" : "hover:bg-muted/60"
            }`}
            onClick={() => void select(agent.id)}
          >
            <span className="truncate font-medium">{agent.name || agent.id}</span>
            <span className="truncate text-muted-foreground">
              {agent.status || agent.detail || "运行中"}
            </span>
          </button>
        ))}
      </div>
      <ScrollArea className="h-[420px] min-w-0 flex-1 rounded-lg border border-border">
        <div className="p-2">
          <MessageList messages={messages} streaming={Boolean(active && streams[active]?.length)} />
        </div>
      </ScrollArea>
    </div>
  );
}

/** Slim status strip shown only when there is a plan, queue, or running agent. */
export function RunStatusBar({
  session,
  queued,
}: {
  session: OmpSessionState | null;
  queued: QueuedPrompt[];
}): JSX.Element | null {
  const todos = session?.todoPhases?.flatMap((phase) => phase.tasks) ?? [];
  const used = usagePercent(session);
  const show = todos.length > 0 || queued.length > 0;
  const [open, setOpen] = useState(true);
  if (!show) return null;

  const done = todos.filter((task) => task.status === "completed").length;

  return (
    <div className="mx-auto mb-2 w-full max-w-3xl px-6">
      <div className="flex items-center gap-3 rounded-lg border border-border bg-card px-3 py-1.5 text-xs">
        {used != null ? (
          <span className="shrink-0 text-muted-foreground">上下文 {Math.round(used)}%</span>
        ) : null}
        {todos.length > 0 ? (
          <button
            type="button"
            className="flex items-center gap-1.5 text-muted-foreground hover:text-foreground"
            onClick={() => setOpen((value) => !value)}
          >
            <ListTodo className="size-3.5" />
            计划 {done}/{todos.length}
          </button>
        ) : null}
        {queued.length > 0 ? (
          <span className="flex items-center gap-1.5 text-muted-foreground">
            <ListTree className="size-3.5" />
            队列 {queued.length}
          </span>
        ) : null}
      </div>
      {open && todos.length > 0 ? (
        <div className="mt-1 space-y-1 rounded-lg border border-border bg-card px-3 py-2">
          {todos.map((task) => (
            <div key={task.id} className="flex items-start gap-2 text-xs">
              <span className="mt-0.5 text-muted-foreground">
                {task.status === "completed" ? (
                  <Check className="size-3.5" />
                ) : task.status === "in_progress" ? (
                  "…"
                ) : (
                  "○"
                )}
              </span>
              <span className={task.status === "completed" ? "text-muted-foreground line-through" : ""}>
                {task.content}
              </span>
            </div>
          ))}
        </div>
      ) : null}
    </div>
  );
}

export function usagePercent(session: OmpSessionState | null): number | null {
  const usage = session?.contextUsage;
  if (!usage) return null;
  if (usage.tokens != null && usage.contextWindow > 0) {
    return Math.min(999, (usage.tokens / usage.contextWindow) * 100);
  }
  if (usage.percent == null) return null;
  return usage.percent > 1.5 ? usage.percent : usage.percent * 100;
}
