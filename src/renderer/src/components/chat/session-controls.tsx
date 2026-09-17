import { useState, type JSX } from "react";
import { useTranslation } from "react-i18next";
import { HugeiconsIcon } from "@hugeicons/react";
import { BotIcon, Download01Icon, MoreHorizontalIcon, ScissorIcon } from "@hugeicons/core-free-icons";
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
  EngineSessionState,
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
  session: EngineSessionState | null;
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
  const { t } = useTranslation("chat");
  const [compactOpen, setCompactOpen] = useState(false);
  const [compactHint, setCompactHint] = useState("");
  const [agentsOpen, setAgentsOpen] = useState(false);

  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger render={<Button size="icon-sm" variant="ghost" />}>
          <HugeiconsIcon strokeWidth={2} icon={MoreHorizontalIcon} />
          <span className="sr-only">{t("session.settings")}</span>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="w-56 min-w-56">
          <DropdownMenuGroup>
            <DropdownMenuLabel>{t("session.session")}</DropdownMenuLabel>
            <DropdownMenuItem onClick={() => setCompactOpen(true)}>
              <HugeiconsIcon strokeWidth={2} icon={ScissorIcon} />
              {t("session.compact")}
            </DropdownMenuItem>
            <DropdownMenuCheckboxItem
              checked={session?.autoCompactionEnabled ?? true}
              onCheckedChange={(checked) => onToggleAutoCompact(Boolean(checked))}
            >
              {t("session.autoCompact")}
            </DropdownMenuCheckboxItem>
          </DropdownMenuGroup>
          <DropdownMenuSeparator />
          <DropdownMenuGroup>
            <DropdownMenuLabel>{t("session.queueInterrupt")}</DropdownMenuLabel>
            <DropdownMenuCheckboxItem
              checked={session?.interruptMode === "wait"}
              onCheckedChange={(checked) => onToggleInterrupt(checked ? "wait" : "immediate")}
            >
              {t("session.waitTurn")}
            </DropdownMenuCheckboxItem>
            <DropdownMenuCheckboxItem
              checked={session?.steeringMode === "all"}
              onCheckedChange={(checked) => onToggleSteering(checked ? "all" : "one-at-a-time")}
            >
              {t("session.steerAll")}
            </DropdownMenuCheckboxItem>
            <DropdownMenuCheckboxItem
              checked={session?.followUpMode === "all"}
              onCheckedChange={(checked) => onToggleFollowUp(checked ? "all" : "one-at-a-time")}
            >
              {t("session.followUpAll")}
            </DropdownMenuCheckboxItem>
          </DropdownMenuGroup>
          <DropdownMenuSeparator />
          <DropdownMenuGroup>
            {subagents.length > 0 ? (
              <DropdownMenuItem onClick={() => setAgentsOpen(true)}>
                <HugeiconsIcon strokeWidth={2} icon={BotIcon} />
                {t("session.viewSubagents")}
                <Badge variant="secondary" className="ml-auto">
                  {subagents.length}
                </Badge>
              </DropdownMenuItem>
            ) : null}
            <DropdownMenuItem onClick={onExport}>
              <HugeiconsIcon strokeWidth={2} icon={Download01Icon} />
              {t("session.exportHtml")}
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
            <DialogTitle>{t("session.compactTitle")}</DialogTitle>
          </DialogHeader>
          <Textarea
            value={compactHint}
            placeholder={t("session.compactPlaceholder")}
            className="min-h-24"
            onChange={(event) => setCompactHint(event.target.value)}
          />
          <DialogFooter>
            <Button variant="outline" onClick={() => setCompactOpen(false)}>
              {t("session.cancel")}
            </Button>
            <Button
              onClick={() => {
                onCompact(compactHint.trim() || undefined);
                setCompactOpen(false);
                setCompactHint("");
              }}
            >
              {t("session.startCompact")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={agentsOpen} onOpenChange={setAgentsOpen}>
        <DialogContent className="sm:max-w-2xl">
          <DialogHeader>
            <DialogTitle>{t("session.subagents")}</DialogTitle>
          </DialogHeader>
          <SubagentBrowser subagents={subagents} streams={streams} />
        </DialogContent>
      </Dialog>
    </>
  );
}

export function SubagentBrowser({
  subagents,
  streams,
  initialId,
}: {
  subagents: SubagentInfo[];
  streams: Record<string, ChatMessage[]>;
  initialId?: string | null;
}): JSX.Element {
  const { t } = useTranslation("chat");
  const [active, setActive] = useState<string | null>(initialId ?? subagents[0]?.id ?? null);
  const [loaded, setLoaded] = useState<Record<string, ChatMessage[]>>({});

  async function select(id: string): Promise<void> {
    setActive(id);
    if (streams[id]?.length || loaded[id]) return;
    try {
      const messages = await window.fastvibe.engine.getSubagentMessages(id);
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
              {agent.status || agent.detail || t("session.running")}
            </span>
            {agent.progress != null ? (
              <span className="mt-1 h-1 overflow-hidden rounded-full bg-muted">
                <span className="block h-full bg-primary" style={{ width: `${Math.max(0, Math.min(100, agent.progress))}%` }} />
              </span>
            ) : null}
            {agent.error ? <span className="truncate text-destructive">{agent.error}</span> : null}
          </button>
        ))}
      </div>
      <ScrollArea className="h-105 min-w-0 flex-1 rounded-lg border border-border">
        <div className="p-2">
          <MessageList messages={messages} streaming={Boolean(active && streams[active]?.length)} />
        </div>
      </ScrollArea>
    </div>
  );
}

export function usagePercent(session: EngineSessionState | null): number | null {
  const usage = session?.contextUsage;
  if (!usage) return null;
  if (usage.tokens != null && usage.contextWindow > 0) {
    return Math.min(999, (usage.tokens / usage.contextWindow) * 100);
  }
  if (usage.percent == null) return null;
  return usage.percent > 1.5 ? usage.percent : usage.percent * 100;
}
