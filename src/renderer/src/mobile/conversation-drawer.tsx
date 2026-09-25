import { useMemo, useState, type JSX } from "react";
import { useTranslation } from "react-i18next";
import { HugeiconsIcon } from "@hugeicons/react";
import { Alert02Icon, PencilEdit02Icon, Search01Icon } from "@hugeicons/core-free-icons";
import type { Conversation } from "@shared/types";
import { Button } from "@/components/ui/button";
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from "@/components/ui/empty";
import { Input } from "@/components/ui/input";
import { Sheet, SheetContent, SheetDescription, SheetTitle } from "@/components/ui/sheet";
import { RunningMark } from "@/components/running-mark";
import { formatRelativeTime } from "@/lib/time";
import { cn } from "@/lib/utils";
import { useArchivedIds } from "@/stores/archive";
import { useSessionStore } from "@/stores/session";
import { ConversationContextMenu } from "./conversation-menu";
import { navigate } from "./route";

/**
 * Every chat, the ones that need you first, in a drawer over the chat on screen.
 *
 * A drawer rather than a page of its own: the list is where you go *between* chats, and
 * a page cost the chat behind it — its scroll position, and a reload of its snapshot on
 * the way back. Sections rather than one list, because the question a phone is picked up
 * to answer is 「is anything stuck on me?」: a chat parked on an approval sits at the top
 * under 等你处理, running ones follow, and history comes after. A project is a filter
 * chip, not a group, because nesting would push the chat that needs you off the screen.
 */
export function ConversationDrawer({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}): JSX.Element {
  const { t } = useTranslation("app");
  const conversations = useSessionStore((state) => state.conversations);
  const projects = useSessionStore((state) => state.projects);
  const running = useSessionStore((state) => state.running);
  const waiting = useSessionStore((state) => state.waitingForUser);
  const archived = useArchivedIds();
  const [query, setQuery] = useState("");
  const [project, setProject] = useState<string | null>(null);

  const projectNames = useMemo(() => new Map(projects.map((item) => [item.cwd, item.name])), [projects]);

  // A chat with no prompt yet is a draft, which the desktop sidebar hides too — unless it
  // is already running, which a send from another client can make it before its preview
  // lands.
  const listed = useMemo(
    () =>
      conversations
        .filter((item) => item.kind !== "side-chat" && !archived.has(item.id))
        .filter((item) => Boolean(item.preview) || running[item.id] === true)
        .sort((a, b) => b.createdAt - a.createdAt || a.id.localeCompare(b.id)),
    [archived, conversations, running],
  );

  // Only projects that hold a listed chat get a chip; the rest would filter to nothing.
  const chips = useMemo(() => {
    const used = new Set(listed.map((item) => item.project).filter((cwd): cwd is string => Boolean(cwd)));
    return projects.filter((item) => used.has(item.cwd));
  }, [listed, projects]);

  const needle = query.trim().toLowerCase();
  const visible = listed.filter((item) => {
    if (project !== null && (item.project ?? "") !== project) return false;
    if (!needle) return true;
    const haystack = `${item.title} ${item.preview ?? ""} ${projectNames.get(item.project ?? "") ?? ""}`.toLowerCase();
    return haystack.includes(needle);
  });

  const waitingRows = visible.filter((item) => waiting[item.id]);
  const runningRows = visible.filter((item) => !waiting[item.id] && running[item.id]);
  const restRows = visible.filter((item) => !waiting[item.id] && !running[item.id]);

  // Picking something closes the drawer: what was asked for happens behind it, and a
  // drawer left open would make every tap a two-step.
  function pick(id: string): void {
    onOpenChange(false);
    navigate({ kind: "chat", id });
  }

  function newChat(): void {
    onOpenChange(false);
    navigate({ kind: "new", project: project || undefined });
  }

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent
        side="left"
        showCloseButton={false}
        className="w-[88vw] max-w-sm gap-0 p-0 pt-[env(safe-area-inset-top)]"
      >
        <header className="flex h-14 shrink-0 items-center gap-2 pr-2 pl-4">
          <SheetTitle className="min-w-0 flex-1 truncate text-base font-semibold">FastVibe</SheetTitle>
          <SheetDescription className="sr-only">{t("mobile.drawerDescription")}</SheetDescription>
          <Button variant="ghost" size="icon-lg" aria-label={t("mobile.newChat")} onClick={newChat}>
            <HugeiconsIcon icon={PencilEdit02Icon} strokeWidth={2} className="size-5" />
          </Button>
        </header>

        <div className="shrink-0 px-4 pb-2">
          <div className="relative">
            <HugeiconsIcon
              icon={Search01Icon}
              strokeWidth={2}
              className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground"
            />
            <Input
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder={t("mobile.search")}
              aria-label={t("mobile.search")}
              className="h-10 pl-9"
              type="search"
              enterKeyHint="search"
            />
          </div>
        </div>

        {chips.length > 0 ? (
          <div className="flex shrink-0 gap-2 overflow-x-auto px-4 pb-2 [scrollbar-width:none]">
            <Chip active={project === null} onClick={() => setProject(null)}>
              {t("mobile.allProjects")}
            </Chip>
            {chips.map((item) => (
              <Chip key={item.cwd} active={project === item.cwd} onClick={() => setProject(item.cwd)}>
                {item.name}
              </Chip>
            ))}
          </div>
        ) : null}

        <div className="safe-bottom min-h-0 flex-1 overflow-y-auto overscroll-contain">
          {visible.length === 0 ? (
            <Empty className="h-full">
              <EmptyHeader>
                <EmptyTitle>{listed.length === 0 ? t("mobile.empty") : t("mobile.noMatch")}</EmptyTitle>
                {listed.length === 0 ? <EmptyDescription>{t("mobile.emptyHint")}</EmptyDescription> : null}
              </EmptyHeader>
            </Empty>
          ) : (
            <>
              <Section title={t("mobile.sectionWaiting")} rows={waitingRows} names={projectNames} onPick={pick} onLeave={() => onOpenChange(false)} tone="warning" />
              <Section title={t("mobile.sectionRunning")} rows={runningRows} names={projectNames} onPick={pick} onLeave={() => onOpenChange(false)} />
              <Section
                title={waitingRows.length + runningRows.length > 0 ? t("mobile.sectionRecent") : null}
                rows={restRows}
                names={projectNames}
                onPick={pick}
                onLeave={() => onOpenChange(false)}
              />
            </>
          )}
        </div>
      </SheetContent>
    </Sheet>
  );
}

function Chip({ active, onClick, children }: { active: boolean; onClick: () => void; children: string }): JSX.Element {
  return (
    <Button
      variant={active ? "secondary" : "outline"}
      size="sm"
      className={cn("h-8 shrink-0 rounded-full px-3", active && "font-medium")}
      aria-pressed={active}
      onClick={onClick}
    >
      <span className="max-w-40 truncate">{children}</span>
    </Button>
  );
}

function Section({
  title,
  rows,
  names,
  onPick,
  onLeave,
  tone,
}: {
  title: string | null;
  rows: Conversation[];
  names: Map<string, string>;
  onPick: (id: string) => void;
  onLeave: () => void;
  tone?: "warning";
}): JSX.Element | null {
  if (rows.length === 0) return null;
  return (
    <section className="pb-2">
      {title ? (
        <h2 className={cn("px-4 pt-3 pb-1 text-xs font-medium text-muted-foreground", tone === "warning" && "text-warning")}>
          {title}
        </h2>
      ) : null}
      <ul>
        {rows.map((item) => (
          <li key={item.id}>
            <ConversationRow
              conversation={item}
              projectName={item.project ? names.get(item.project) : undefined}
              onPick={onPick}
              onLeave={onLeave}
            />
          </li>
        ))}
      </ul>
    </section>
  );
}

function ConversationRow({
  conversation,
  projectName,
  onPick,
  onLeave,
}: {
  conversation: Conversation;
  projectName?: string;
  onPick: (id: string) => void;
  onLeave: () => void;
}): JSX.Element {
  const { t } = useTranslation("app");
  const running = useSessionStore((state) => state.running[conversation.id] === true);
  const waiting = useSessionStore((state) => state.waitingForUser[conversation.id] === true);
  const current = useSessionStore((state) => state.activeId === conversation.id);
  const detail = [projectName, conversation.preview].filter(Boolean).join(" · ");
  return (
    <ConversationContextMenu conversation={conversation} onLeave={onLeave}>
      <button
        type="button"
        aria-current={current ? "page" : undefined}
        className={cn(
          "flex w-full items-center gap-3 px-4 py-3 text-left active:bg-muted/60",
          current && "bg-muted/70",
        )}
        onClick={() => onPick(conversation.id)}
      >
        <div className="min-w-0 flex-1">
          <div className="flex items-baseline gap-2">
            <span className="min-w-0 flex-1 truncate text-sm font-medium">{conversation.title || t("mobile.untitled")}</span>
            <span className="shrink-0 text-xs text-muted-foreground">{formatRelativeTime(conversation.updatedAt)}</span>
          </div>
          {detail ? <p className="mt-0.5 truncate text-xs text-muted-foreground">{detail}</p> : null}
        </div>
        {waiting ? (
          <span className="flex shrink-0 items-center gap-1 text-xs font-medium text-warning">
            <HugeiconsIcon icon={Alert02Icon} strokeWidth={2} className="size-4" />
            {t("mobile.waiting")}
          </span>
        ) : running ? (
          <RunningMark className="size-4" />
        ) : null}
      </button>
    </ConversationContextMenu>
  );
}
