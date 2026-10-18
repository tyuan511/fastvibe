import { useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { HugeiconsIcon } from "@hugeicons/react";
import { AiExpandIcon, ArrowRight01Icon, BotIcon, ComputerIcon, Copy01Icon, Folder01Icon, GitBranchIcon, GitCompareIcon } from "@hugeicons/core-free-icons";
import { toast } from "sonner";
import { conversationOutputs } from "@shared/conversation-outputs";
import { folderName, projectFolderPaths } from "@shared/project-folders";
import type { GitStatus } from "@shared/ipc";
import type { Conversation, Project } from "@shared/types";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { Popover, PopoverContent, PopoverTitle, PopoverTrigger } from "@/components/ui/popover";
import { IconButton } from "@/components/icon-button";
import { FileIcon } from "@/components/file-icon";
import { RunningMark } from "@/components/running-mark";
import { TodoRow } from "@/components/chat/todo-list";
import { activeTodo } from "@/lib/todos";
import { useConversationTodo } from "@/lib/use-conversation-todo";
import { conversationAgents, resourceAgentFinished, type ResourceAgent } from "@/lib/conversation-resources";
import { subagentStatusText } from "@/lib/subagent-status";
import { displayPath, resolvePath } from "@/lib/workspace-path";
import { displayRemotePath, isRemoteProject } from "@/lib/remote-project";
import { readGitStatus, useGitStatus } from "@/lib/use-git-status";
import { cn } from "@/lib/utils";
import { useSessionStore, useConversationWorking } from "@/stores/session";
import { useSettingsStore } from "@/stores/settings";
import { useDagStore } from "@/stores/dag";
import { useSidePaneStore } from "@/stores/side-pane";
import { useTranscriptNavigation } from "@/stores/transcript-navigation";
import { useIsNarrowViewport } from "@/lib/sidebar-visibility";

const ROW = "h-auto min-h-8 w-full justify-start gap-2 rounded-md px-2 py-1.5 text-left font-normal";
const DISCLOSURE = "aria-expanded:bg-transparent aria-expanded:text-muted-foreground";
// Resources are a workspace pane, so both presentations use the sidebar material
// rather than the denser fill and raised shadow of menus and dialogs.
const RESOURCE_SURFACE = "resource-surface w-[300px] max-w-[calc(100vw-1rem)] gap-0 p-0 text-sm";

function ResourceSection({ title, description, summary, collapsed, defaultOpen = true, children }: {
  title: string; description?: string; summary?: ReactNode; collapsed?: ReactNode; defaultOpen?: boolean; children: ReactNode;
}) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <Collapsible open={open} onOpenChange={setOpen} className="py-2 first:pt-0 last:pb-0">
      <CollapsibleTrigger title={description} render={<Button variant="ghost" className={cn(ROW, DISCLOSURE, "text-muted-foreground hover:bg-transparent dark:hover:bg-transparent")} />}>
        <span className="flex-1">{title}</span>
        <span className="text-xs font-normal text-muted-foreground tabular-nums">{summary}</span>
        <HugeiconsIcon icon={ArrowRight01Icon} strokeWidth={2} className={cn("size-3.5 text-muted-foreground/60 transition-transform", open && "rotate-90")} />
      </CollapsibleTrigger>
      {!open ? collapsed : null}
      <CollapsibleContent>{children}</CollapsibleContent>
    </Collapsible>
  );
}

function More({ count, expanded, onClick }: { count: number; expanded: boolean; onClick: () => void }) {
  const { t } = useTranslation("sidepane");
  return <Button variant="ghost" size="sm" aria-expanded={expanded} className="w-full text-xs text-muted-foreground" onClick={onClick}>{expanded ? t("resources.less") : t("resources.more", { count })}</Button>;
}

function Finished({ count, children }: { count: number; children: ReactNode }) {
  const { t } = useTranslation("sidepane");
  const [open, setOpen] = useState(false);
  if (!count) return null;
  return <Collapsible open={open} onOpenChange={setOpen}>
    <CollapsibleTrigger render={<Button variant="ghost" className={cn(ROW, DISCLOSURE, "text-xs text-muted-foreground")} />}>
      <HugeiconsIcon icon={ArrowRight01Icon} strokeWidth={2} className={cn("size-3.5", open && "rotate-90")} />
      {t("resources.finished", { count })}
    </CollapsibleTrigger>
    <CollapsibleContent>{children}</CollapsibleContent>
  </Collapsible>;
}

function RepositoryRow({ status, onClose }: { status: GitStatus; onClose: () => void }) {
  const { t } = useTranslation("sidepane");
  const narrow = useIsNarrowViewport();
  const cwd = status.cwd;
  return <Button variant="ghost" className={ROW} disabled={narrow} title={displayRemotePath(cwd)} onClick={() => {
    useSidePaneStore.getState().openGit(cwd);
    onClose();
  }}>
    <HugeiconsIcon icon={GitCompareIcon} strokeWidth={2} className="size-4 shrink-0 text-muted-foreground" />
    <span className="min-w-0 flex-1">
      <span className="block truncate text-sm">{folderName(displayRemotePath(cwd))}</span>
      <span className="block truncate text-xs text-muted-foreground">{status.branch} · {status.changed ? t("git.changedCount", { count: status.changed }) : t("git.clean")}</span>
    </span>
    {status.changed > 0 ? <span className="shrink-0 text-xs tabular-nums"><span className="text-success">+{status.additions}</span> <span className="text-destructive">−{status.deletions}</span></span> : null}
  </Button>;
}

function Repositories({ roots, working, onClose }: { roots: string[]; working: boolean; onClose: () => void }) {
  const { t } = useTranslation("sidepane");
  const [statuses, setStatuses] = useState<GitStatus[]>([]);
  const rootsKey = roots.join("\0");
  useEffect(() => {
    let cancelled = false;
    const refresh = () => {
      if (document.hidden) return;
      void Promise.all(roots.map((root) => readGitStatus(root))).then((next) => {
        if (!cancelled) setStatuses(next.filter((status) => status.isRepository));
      });
    };
    refresh();
    const timer = window.setInterval(refresh, 10_000);
    window.addEventListener("focus", refresh);
    return () => { cancelled = true; window.clearInterval(timer); window.removeEventListener("focus", refresh); };
  }, [rootsKey, working]);
  const visible = statuses.filter((status) => roots.includes(status.cwd));
  if (!visible.length) return null;
  return <ResourceSection title={t("resources.changes")} description={t("resources.changesDescription")}>
    {visible.map((status) => <RepositoryRow key={status.cwd} status={status} onClose={onClose} />)}
  </ResourceSection>;
}

function Environment({ conversation, project, onClose }: { conversation: Conversation; project?: Project; onClose: () => void }) {
  const { t } = useTranslation("sidepane");
  const remote = isRemoteProject(project);
  const narrow = useIsNarrowViewport();
  const [host, setHost] = useState<string>();
  const status = useGitStatus(conversation.cwd);
  useEffect(() => {
    if (!remote) return;
    let cancelled = false;
    void Promise.all([window.fastvibe.ssh.hosts(), window.fastvibe.ssh.states()]).then(([hosts, states]) => {
      const hostId = states.find((state) => state.serverInstanceId === project?.serverInstanceId)?.hostId;
      const profile = [...hosts.saved, ...hosts.discovered].find((item) => item.id === hostId);
      if (!cancelled) setHost(profile?.label || profile?.host);
    }).catch(() => undefined);
    return () => { cancelled = true; };
  }, [remote, project?.serverInstanceId]);
  const path = displayRemotePath(conversation.cwd);
  return <ResourceSection title={t("resources.environment")}>
    <div className="flex items-center gap-2 px-2 py-1.5 text-sm">
      <HugeiconsIcon icon={ComputerIcon} strokeWidth={2} className="size-4 shrink-0 text-muted-foreground" />
      <span className="truncate">{remote ? host || t("resources.ssh") : t("resources.local")}</span>
    </div>
    <Button variant="ghost" className={cn(ROW, "group")} title={path} aria-label={t("resources.copyDirectory", { path })} onClick={() => {
      void navigator.clipboard.writeText(path).then(() => toast.success(t("resources.copied"))).catch(() => toast.error(t("resources.copyFailed")));
    }}>
      <HugeiconsIcon icon={Folder01Icon} strokeWidth={2} className="size-4 shrink-0 text-muted-foreground" />
      <span className="min-w-0 flex-1 truncate">{path}</span>
      <HugeiconsIcon icon={Copy01Icon} strokeWidth={2} className="size-3.5 shrink-0 text-muted-foreground opacity-0 group-hover:opacity-100 group-focus-visible:opacity-100" />
    </Button>
    {status?.isRepository && status.branch ? <Button variant="ghost" className={ROW} disabled={narrow} title={t("resources.openBranch", { branch: status.branch })} onClick={() => {
      useSidePaneStore.getState().openGit(conversation.cwd, "current");
      onClose();
    }}>
      <HugeiconsIcon icon={GitBranchIcon} strokeWidth={2} className="size-4 shrink-0 text-muted-foreground" />
      <span className="truncate">{status.branch}</span>
      {conversation.worktree ? <span className="ml-auto text-xs text-muted-foreground">{t("resources.worktree")}</span> : null}
    </Button> : null}
  </ResourceSection>;
}

function ResourceBody({ conversation, project, onClose }: { conversation: Conversation; project?: Project; onClose: () => void }) {
  const { t } = useTranslation("sidepane");
  const narrow = useIsNarrowViewport();
  const messages = useSessionStore((state) => state.messages);
  const registry = useSessionStore((state) => state.subagents);
  const graph = useDagStore((state) => state.graphs[conversation.id]);
  const working = useConversationWorking();
  // Same display rule as the panel above the composer: an abandoned checklist is not
  // a resource of the current turn, so it does not get a section here either.
  const todo = useConversationTodo();
  const agents = useMemo(() => conversationAgents(conversation.id, messages, registry, graph?.nodes ?? []), [conversation.id, messages, registry, graph]);
  const outputs = useMemo(() => conversationOutputs(messages, (path) => resolvePath(path, conversation.cwd)), [messages, conversation.cwd]);
  const [moreOutputs, setMoreOutputs] = useState(false);
  const [moreAgents, setMoreAgents] = useState(false);
  const [moreFinishedAgents, setMoreFinishedAgents] = useState(false);
  const [repos, setRepos] = useState<string[]>([conversation.cwd]);
  const folderKey = project ? projectFolderPaths(project).join("\0") : "";
  useEffect(() => {
    setRepos([conversation.cwd]);
    if (!project || isRemoteProject(project) || !project.folders?.length) return;
    let cancelled = false;
    void window.fastvibe.projects.repos(project.cwd).then((list) => {
      if (cancelled) return;
      const roots = conversation.worktree
        ? [conversation.cwd, ...list.filter((repo) => !repo.folders.includes(project.cwd)).map((repo) => repo.root)]
        : list.map((repo) => repo.root);
      setRepos([...new Set(roots.length ? roots : [conversation.cwd])]);
    }).catch(() => undefined);
    return () => { cancelled = true; };
  }, [conversation.cwd, conversation.worktree, project?.cwd, folderKey]);

  const jump = (entryId: string): void => {
    const pane = useSidePaneStore.getState();
    if (pane.maximized) pane.toggleMaximized();
    useTranscriptNavigation.getState().jump(conversation.id, entryId);
    onClose();
  };
  const openOutput = async (path: string): Promise<void> => {
    onClose();
    try {
      const preview = await window.fastvibe.workspace.preview(path);
      if (useSessionStore.getState().activeId === conversation.id) useSidePaneStore.getState().openFilePreview(preview);
    } catch (error) {
      if (useSessionStore.getState().activeId === conversation.id) toast.error(error instanceof Error ? error.message : t("resources.previewFailed"));
    }
  };
  const agentRow = (agent: ResourceAgent) => {
    const live = agent.status === "running" && agent.info?.phase !== "waiting";
    const attention = agent.info?.phase === "waiting" || ["blocked", "failed", "error"].includes(agent.status);
    const label = agent.node && (agent.status !== "running" || !agent.info)
      ? t("dag.status." + agent.node.status) : subagentStatusText(agent.info, agent.status);
    return <Button key={agent.id} variant="ghost" className={ROW} disabled={narrow && !agent.node} title={agent.brief} onClick={() => {
      const pane = useSidePaneStore.getState();
      if (agent.node && narrow) useDagStore.getState().openViewer(conversation.id, agent.node.id);
      else if (agent.node) pane.openDagNode(conversation.id, agent.node);
      else pane.openSubagent(agent.id, { conversationId: conversation.id, title: agent.name, status: agent.status, brief: agent.brief });
      onClose();
    }}>
      {live ? <RunningMark /> : <HugeiconsIcon icon={BotIcon} strokeWidth={2} className={cn("size-4 shrink-0 text-muted-foreground", attention && "text-warning")} />}
      <span className="min-w-0 flex-1"><span className="block truncate text-sm">{agent.name}</span>{agent.brief ? <span className="block truncate text-xs text-muted-foreground">{agent.brief}</span> : null}</span>
      <span className={cn("shrink-0 text-xs text-muted-foreground", attention && "text-warning")}>{label}</span>
    </Button>;
  };
  const activeAgents = agents.filter((agent) => !resourceAgentFinished(agent));
  const finishedAgents = agents.filter(resourceAgentFinished);
  const currentTodo = todo ? activeTodo(todo.items) : undefined;
  const done = todo ? todo.items.filter((item) => item.status === "completed").length : 0;
  return <div className="divide-y divide-border/50">
    <Environment conversation={conversation} project={project} onClose={onClose} />
    {todo ? <ResourceSection title={t("resources.todos")} defaultOpen={false}
      summary={t("resources.progress", { done, total: todo.items.length })}
      collapsed={currentTodo ? <div className="px-1 pb-1"><TodoRow item={currentTodo} compact live /></div> : undefined}>
      <div className="px-2">{todo.items.map((item) => <TodoRow key={item.id} item={item} live />)}</div>
    </ResourceSection> : null}
    {agents.length ? <ResourceSection title={t("resources.agents")} summary={agents.length}>
      {activeAgents.slice(0, moreAgents ? undefined : 5).map(agentRow)}
      {activeAgents.length > 5 ? <More count={activeAgents.length - 5} expanded={moreAgents} onClick={() => setMoreAgents((value) => !value)} /> : null}
      <Finished count={finishedAgents.length}>
        {finishedAgents.slice(0, moreFinishedAgents ? undefined : 5).map(agentRow)}
        {finishedAgents.length > 5 ? <More count={finishedAgents.length - 5} expanded={moreFinishedAgents} onClick={() => setMoreFinishedAgents((value) => !value)} /> : null}
      </Finished>
    </ResourceSection> : null}
    {outputs.length ? <ResourceSection title={t("resources.outputs")} summary={outputs.length}>
      {outputs.slice(0, moreOutputs ? undefined : 5).map((output) => <div key={output.path} className="group flex min-w-0 items-center rounded-md hover:bg-muted focus-within:bg-muted dark:hover:bg-muted/50 dark:focus-within:bg-muted/50">
        <Button variant="ghost" className={cn(ROW, "min-w-0 flex-1 hover:bg-transparent dark:hover:bg-transparent")} disabled={narrow} title={displayRemotePath(output.path)} onClick={() => void openOutput(output.path)}>
          <FileIcon name={output.path} className="size-4 shrink-0" />
          <span className="min-w-0 truncate">{output.title || displayPath(output.path, conversation.cwd)}</span>
        </Button>
        <IconButton size="icon-xs" variant="ghost" label={t("resources.jump")} onClick={() => jump(output.entryId)} className="mr-1 shrink-0 text-muted-foreground opacity-0 hover:bg-transparent group-hover:opacity-100 group-focus-within:opacity-100 pointer-coarse:opacity-100 dark:hover:bg-transparent">
          <HugeiconsIcon icon={ArrowRight01Icon} strokeWidth={2} />
        </IconButton>
      </div>)}
      {outputs.length > 5 ? <More count={outputs.length - 5} expanded={moreOutputs} onClick={() => setMoreOutputs((value) => !value)} /> : null}
    </ResourceSection> : null}
    <Repositories roots={repos} working={working} onClose={onClose} />
  </div>;
}

/** A centered 48rem chat needs a 300px panel plus a 1rem outside inset in
 * each gutter: the docking threshold is 50rem + 600px. The panel stays 300px
 * wide, including when the UI font size changes.
 * Observe the actual column and a rem-sized probe: splitters and font changes
 * matter just as much as window resizing. The trigger belongs only to this
 * conversation header; it never migrates into a detail pane. */
export function ConversationResources({ disabled = false }: { disabled?: boolean }) {
  const { t } = useTranslation("sidepane");
  const conversation = useSessionStore((state) => state.conversations.find((item) => item.id === state.activeId));
  const project = useSessionStore((state) => state.projects.find((item) => item.cwd === conversation?.project));
  const [openFor, setOpenFor] = useState<string | null>(null);
  const [docked, setDocked] = useState(false);
  const requestedOpen = useSettingsStore((state) => state.settings.resourcePanelOpen !== false);
  const sizeProbe = useRef<HTMLSpanElement>(null);
  useLayoutEffect(() => {
    const probe = sizeProbe.current;
    const host = probe?.closest<HTMLElement>("[data-conversation-resources-host]");
    if (!probe || !host) return;
    let previous: boolean | undefined;
    const measure = (): void => {
      const next = host.clientWidth >= probe.getBoundingClientRect().width;
      if (previous === next) return;
      previous = next;
      // Resize dismisses only the transient popover. The saved user preference
      // stays intact, so a panel hidden for lack of room returns when room does.
      setOpenFor(null);
      setDocked(next);
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(host);
    observer.observe(probe);
    return () => observer.disconnect();
  }, [conversation?.id]);
  useLayoutEffect(() => { setOpenFor(null); }, [conversation?.id, disabled]);
  useLayoutEffect(() => { if (!requestedOpen) setOpenFor(null); }, [requestedOpen]);
  if (!conversation) return null;
  const open = !disabled && requestedOpen && openFor === conversation.id;
  const showDocked = !disabled && requestedOpen;
  const rememberOpen = (value: boolean): void => {
    const settings = useSettingsStore.getState();
    if (settings.settings.resourcePanelOpen !== value) settings.update({ resourcePanelOpen: value });
  };
  const body = <ResourceBody key={conversation.id + ":" + conversation.cwd} conversation={conversation} project={project} onClose={() => setOpenFor(null)} />;
  return <>
    {/* Clip the measurement probe so it cannot create horizontal overflow. */}
    <span aria-hidden className="pointer-events-none absolute h-0 w-0 overflow-hidden"><span ref={sizeProbe} className="block h-0 w-[calc(50rem+600px)]" /></span>
    {docked ? <>
      <IconButton size="icon-sm" variant="ghost" label={t("resources.title")} disabled={disabled}
        aria-expanded={showDocked} className="no-drag text-muted-foreground"
        onClick={() => rememberOpen(!requestedOpen)}>
        <HugeiconsIcon icon={AiExpandIcon} strokeWidth={2} />
      </IconButton>
      {showDocked ? <Card
        role="complementary"
        aria-label={t("resources.title")}
        data-overlay-surface
        data-resource-presentation="docked"
        className={cn("no-drag absolute top-12 right-4 z-20 max-h-[calc(100%-4rem)] ring-0", RESOURCE_SURFACE)}
      >
        <div className="min-h-0 max-h-[min(75vh,42rem)] overflow-y-auto overscroll-contain px-3 py-2">{body}</div>
      </Card> : null}
    </> : (
      <Popover open={open} onOpenChange={(value, details) => {
        setOpenFor(value ? conversation.id : null);
        // Only intentional interactions change the persisted preference. Focus
        // loss, mode switches and navigation are temporary dismissals.
        if (["trigger-press", "close-press", "outside-press", "escape-key"].includes(details.reason)) rememberOpen(value);
      }}>
        <PopoverTrigger render={<IconButton size="icon-sm" variant="ghost" label={t("resources.title")} disabled={disabled} className="no-drag text-muted-foreground"><HugeiconsIcon icon={AiExpandIcon} strokeWidth={2} /></IconButton>} />
        <PopoverContent align="end" sideOffset={8} data-resource-presentation="popover" className={RESOURCE_SURFACE}>
          <PopoverTitle className="sr-only">{t("resources.title")}</PopoverTitle>
          <div className="min-h-0 max-h-[min(75vh,42rem)] overflow-y-auto overscroll-contain px-3 py-2">
            {open ? body : null}
          </div>
        </PopoverContent>
      </Popover>
    )}
  </>;
}
