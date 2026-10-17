import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type JSX } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import { HugeiconsIcon } from "@hugeicons/react";
import { Add01Icon, ArrowDown02Icon, ArrowLeft01Icon, PanelLeftCloseIcon, PanelLeftOpenIcon, ArrowUp02Icon, Delete02Icon, File01Icon, Folder01Icon, GitBranchIcon, GitCompareIcon, ListIcon, FolderTreeIcon, MinusSignIcon, RefreshIcon } from "@hugeicons/core-free-icons";
import { Button } from "@/components/ui/button";
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "@/components/ui/empty";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Sheet, SheetClose, SheetContent, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { Spinner } from "@/components/ui/spinner";
import { AlertDialog, AlertDialogContent, AlertDialogHeader, AlertDialogTitle, AlertDialogDescription, AlertDialogFooter, AlertDialogCancel, AlertDialogAction } from "@/components/ui/alert-dialog";
import { DiffView } from "@/components/chat/diff-view";
import { FileIcon } from "@/components/file-icon";
import { IconButton } from "@/components/icon-button";
import { cn } from "@/lib/utils";
import { selectGitChange, type GitChangeSelection } from "@/lib/git-change-selection";
import { parseDiff } from "@/lib/diff";
import { SplitHandle, splitStyle, useSplitWidth } from "./split-handle";
import { displayPath, resolvePath } from "@/lib/workspace-path";
import { useSessionStore } from "@/stores/session";
import { useSidePaneStore } from "@/stores/side-pane";
import type { ChatMessage, ProjectRepo } from "@shared/types";
import type { GitComparison, GitDiffSource, GitHistoryEntry, GitHistoryScope, GitStatus } from "@shared/ipc";
import { folderName } from "@shared/project-folders";
import { isRemoteRef } from "@/lib/remote-project";
import { GitChangeGroup, GitChangeList, isConflict } from "./git-change-list";
import { GitCommitForm } from "./git-commit-form";
import { performGitCommit, type GitCommitAction } from "@/lib/git-commit";
import { GitHistoryPanel, GitCommitDetails } from "./git-history";
import { ResizablePanelGroup, ResizablePanel, ResizableHandle } from "@/components/ui/resizable";

type File = GitStatus["files"][number];
type Selection = GitChangeSelection;
type View = "workspace" | "branch" | "last-turn";

// Keep unfinished commit text when switching repositories or temporarily closing the pane.
const commitDrafts = new Map<string, string>();
let preferTree = true;

function lastTurnFiles(messages: ChatMessage[]): File[] {
  const paths = new Set<string>();
  let start = messages.length - 1;
  while (start >= 0 && messages[start].role !== "user") start--;
  for (const message of messages.slice(Math.max(0, start))) for (const tool of message.tools) {
    if (tool.status === "error" || !/write|edit|apply|create/i.test(tool.name)) continue;
    const args = tool.args && typeof tool.args === "object" ? tool.args as Record<string, unknown> : {};
    const path = args.path ?? args.file_path ?? args.filename;
    if (typeof path === "string" && path) paths.add(path);
  }
  return [...paths].map((path) => ({ path, index: " ", worktree: "M" }));
}

function GitEmpty({ title, description }: { title: string; description: string }): JSX.Element {
  return <Empty className="min-h-0 flex-1 border-0"><EmptyHeader><EmptyMedia variant="icon"><HugeiconsIcon icon={GitCompareIcon} /></EmptyMedia><EmptyTitle>{title}</EmptyTitle><EmptyDescription>{description}</EmptyDescription></EmptyHeader></Empty>;
}

export function SidePaneGit({ cwd: sessionCwd, folders, projectCwd, onError, focusPath, focusCwd, focusRevision, focusSource, onFocusHandled }: {
  cwd?: string; folders?: string[]; projectCwd?: string; onError: (message: string) => void;
  focusPath?: string; focusCwd?: string; focusRevision?: number; focusSource?: GitDiffSource; onFocusHandled?: () => void;
}): JSX.Element {
  const { t } = useTranslation("sidepane");
  const [repos, setRepos] = useState<ProjectRepo[]>([]);
  const [picked, setPicked] = useState<string>();
  const folderKey = folders?.join("\0") ?? "";
  useEffect(() => { if (focusCwd) setPicked(focusCwd); }, [focusCwd, focusRevision]);
  useEffect(() => {
    setRepos([]);
    if (!projectCwd || !folders || folders.length < 2) return;
    let cancelled = false;
    void window.fastvibe.projects.repos(projectCwd).then((list) => { if (!cancelled) setRepos(list); }).catch(() => {});
    return () => { cancelled = true; };
  }, [projectCwd, folderKey]);
  const cwd = picked && repos.some((repo) => repo.root === picked) ? picked : repos.find((repo) => repo.root === sessionCwd || repo.folders.includes(sessionCwd ?? ""))?.root ?? sessionCwd;
  if (!cwd) return <GitEmpty title={t("git.unboundTitle")} description={t("git.unboundDesc")} />;
  return <div className="flex min-h-0 min-w-0 flex-1 flex-col">
    {repos.length >= 2 ? <div className="flex shrink-0 gap-1 overflow-x-auto border-b border-border p-1">{repos.map((repo) => <Button key={repo.root} size="xs" variant={cwd === repo.root ? "secondary" : "ghost"} title={repo.root} onClick={() => setPicked(repo.root)}>{folderName(repo.folders[0] ?? repo.root)}{repo.branch ? ` · ${repo.branch}` : ""}</Button>)}</div> : null}
    <RepositoryChanges key={cwd} cwd={cwd} onError={onError} focusPath={focusPath} focusSource={focusSource} focusRevision={focusRevision} onFocusHandled={onFocusHandled} />
  </div>;
}

function RepositoryChanges({ cwd, onError, focusPath, focusSource, focusRevision, onFocusHandled }: { cwd: string; onError: (message: string) => void; focusPath?: string; focusSource?: GitDiffSource; focusRevision?: number; onFocusHandled?: () => void }): JSX.Element {
  const { t } = useTranslation("sidepane");
  const messages = useSessionStore((state) => state.messages);
  const streaming = useSessionStore((state) => state.streaming);
  const [status, setStatus] = useState<GitStatus | null>(null);
  const [view, setView] = useState<View>(focusSource === "branch" || focusSource === "last-turn" ? focusSource : "workspace");
  const [commit, setCommit] = useState<GitHistoryEntry>();
  const [comparison, setComparison] = useState<GitComparison>();
  const [comparisonError, setComparisonError] = useState("");
  const [selection, setSelection] = useState<Selection>();
  const paneRef = useRef<HTMLDivElement>(null);
  const treeToggleRef = useRef<HTMLButtonElement>(null);
  const drawerCloseRef = useRef<HTMLButtonElement>(null);
  const [paneBounds, setPaneBounds] = useState({ left: 0, width: 0 });
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const narrow = paneBounds.width > 0 && paneBounds.width < 576;
  const sidebarOpen = narrow ? drawerOpen : !sidebarCollapsed;
  const [message, setMessage] = useState(() => commitDrafts.get(cwd) ?? "");
  const [tree, setTree] = useState(preferTree);
  const [diffMode, setDiffMode] = useState<"unified" | "split">("unified");
  const [wrap, setWrap] = useState(true);
  const [historyOpen, setHistoryOpen] = useState(true);
  const [historyScope, setHistoryScope] = useState<GitHistoryScope>("all");
  const [busy, setBusy] = useState<string>();
  const [reloading, setReloading] = useState(false);
  const [epoch, setEpoch] = useState(0);
  const [historyEpoch, setHistoryEpoch] = useState(0);
  const [discard, setDiscard] = useState<File>();
  const busyRef = useRef(false);
  const request = useRef(0);
  const alive = useRef(true);
  const split = useSplitWidth("git", 240);
  useLayoutEffect(() => {
    const pane = paneRef.current;
    if (!pane) return;
    const measure = (): void => {
      const { left, width } = pane.getBoundingClientRect();
      setPaneBounds((old) => old.left === left && old.width === width ? old : { left, width });
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(pane);
    window.addEventListener("resize", measure);
    return () => { observer.disconnect(); window.removeEventListener("resize", measure); };
  }, [status?.isRepository]);
  useEffect(() => { setDrawerOpen(false); }, [narrow]);

  const lastTurn = useMemo(() => lastTurnFiles(messages), [messages]);
  const reload = useCallback(async () => {
    if (busyRef.current) return;
    const version = ++request.current;
    setReloading(true);
    try {
      const next = await window.fastvibe.workspace.gitStatus(cwd);
      if (alive.current && version === request.current) { setStatus(next); setEpoch((n) => n + 1); }
    } catch (cause) {
      if (alive.current && version === request.current) onError(cause instanceof Error ? cause.message : t("git.statusFailed"));
    } finally { if (alive.current && version === request.current) setReloading(false); }
  }, [cwd, onError, t]);
  const reloadRef = useRef(reload);
  reloadRef.current = reload;
  useEffect(() => {
    alive.current = true;
    const refresh = (): void => { if (!document.hidden) void reloadRef.current(); };
    const timer = window.setInterval(refresh, 15_000);
    window.addEventListener("focus", refresh);
    document.addEventListener("visibilitychange", refresh);
    return () => { alive.current = false; request.current++; clearInterval(timer); window.removeEventListener("focus", refresh); document.removeEventListener("visibilitychange", refresh); };
  }, [cwd]);
  useEffect(() => { void reloadRef.current(); }, [streaming]);

  useEffect(() => {
    if (!focusPath) return;
    const source = focusSource ?? "unstaged";
    setView(source === "branch" || source === "last-turn" ? source : "workspace");
    setCommit(undefined);
    setDrawerOpen(false);
    setSelection({ file: { path: focusPath, index: source === "staged" ? "M" : " ", worktree: "M" }, source });
    onFocusHandled?.();
  }, [focusPath, focusSource, focusRevision]);

  useEffect(() => {
    if (view !== "branch" && !commit) { setComparison(undefined); setComparisonError(""); return; }
    let cancelled = false;
    setComparison(undefined);
    setComparisonError("");
    void window.fastvibe.workspace.gitComparison(cwd, commit?.hash).then((next) => { if (!cancelled) setComparison(next); }).catch((cause) => { if (!cancelled) setComparisonError(cause instanceof Error ? cause.message : t("git.comparisonFailed")); });
    return () => { cancelled = true; };
  }, [cwd, view, commit?.hash, commit ? 0 : epoch]);


  async function run(kind: string, action: () => Promise<GitStatus>, done?: string): Promise<boolean> {
    if (busyRef.current) return false;
    busyRef.current = true;
    request.current++;
    setReloading(false);
    setBusy(kind);
    try {
      const next = await action();
      if (alive.current) { setStatus(next); setEpoch((n) => n + 1); if (["commit", "pull", "push"].includes(kind)) setHistoryEpoch((n) => n + 1); if (done) toast.success(done); }
      return true;
    } catch (cause) {
      if (alive.current) onError(cause instanceof Error ? cause.message : t("git.actionFailed"));
      return false;
    } finally { busyRef.current = false; if (alive.current) setBusy(undefined); }
  }
  const stage = (paths: string[]): void => { void run("stage", () => window.fastvibe.workspace.gitStage(cwd, paths)); };
  const unstage = (paths: string[]): void => { void run("unstage", () => window.fastvibe.workspace.gitUnstage(cwd, paths)); };
  async function generateMessage(): Promise<void> {
    if (busyRef.current || !status?.changed) return;
    busyRef.current = true;
    request.current++;
    setReloading(false);
    setBusy("generate");
    const conversationId = useSessionStore.getState().activeId;
    const original = message;
    try {
      const generated = await window.fastvibe.workspace.gitGenerateCommitMessage(cwd, conversationId ?? undefined, status.staged > 0);
      if (alive.current && useSessionStore.getState().activeId === conversationId && (commitDrafts.get(cwd) ?? "") === original) {
        setMessage(generated);
        commitDrafts.set(cwd, generated);
      }
    } catch (cause) {
      if (alive.current) onError(cause instanceof Error ? cause.message : t("git.generateFailed"));
    } finally {
      busyRef.current = false;
      if (alive.current) setBusy(undefined);
    }
  }

  async function submit(action: GitCommitAction = "commit"): Promise<void> {
    if (!status || status.files.some(isConflict) || busyRef.current) return;
    const original = message;
    const subject = original.trim();
    if (action !== "amend" && (!subject || !status.staged)) return;
    busyRef.current = true;
    request.current++;
    setReloading(false);
    setBusy(action);
    const outcome = await performGitCommit(action, subject, {
      commit: (text, options) => window.fastvibe.workspace.gitCommit(cwd, text, options),
      pull: () => window.fastvibe.workspace.gitPull(cwd),
      push: () => window.fastvibe.workspace.gitPush(cwd),
    }, (next) => {
      if ((commitDrafts.get(cwd) ?? "") === original) commitDrafts.delete(cwd);
      if (!alive.current) return;
      setMessage("");
      setStatus(next);
      setEpoch((n) => n + 1);
      setHistoryEpoch((n) => n + 1);
    });
    busyRef.current = false;
    if (!alive.current) return;
    setBusy(undefined);
    if (outcome.status) {
      setStatus(outcome.status);
      setEpoch((n) => n + 1);
      setHistoryEpoch((n) => n + 1);
    }
    if (outcome.ok) {
      const key = action === "amend" ? "git.amendDone" : action === "commit-push" ? "git.commitPushDone" : action === "commit-sync" ? "git.commitSyncDone" : "git.commitDone";
      toast.success(t(key, { subject }));
    } else {
      const detail = outcome.error instanceof Error ? outcome.error.message : t("git.actionFailed");
      onError(outcome.phase === "commit" ? detail : t(action === "commit-sync" ? "git.syncAfterCommitFailed" : "git.pushAfterCommitFailed", { error: detail }));
      void reloadRef.current();
    }
  }
  const groups = useMemo(() => {
    if (commit || view === "branch") return [{ id: "comparison", title: commit ? t("git.commitFiles") : t("git.branch"), source: "branch" as GitDiffSource, files: comparison?.files ?? [] }];
    if (view === "last-turn") return [{ id: "last-turn", title: t("git.lastTurn"), source: "last-turn" as GitDiffSource, files: lastTurn }];
    const files = status?.files ?? [];
    return [
      { id: "conflicts", title: t("git.conflicts"), source: "unstaged" as GitDiffSource, files: files.filter(isConflict) },
      { id: "staged", title: t("git.staged"), source: "staged" as GitDiffSource, files: files.filter((file) => !isConflict(file) && file.index !== " " && file.index !== "?") },
      { id: "unstaged", title: t("git.changes"), source: "unstaged" as GitDiffSource, files: files.filter((file) => !isConflict(file) && (file.worktree !== " " || file.index === "?")) },
    ];
  }, [status, view, commit, comparison, lastTurn, t]);
  // A staged file can occur in both groups. Keep its source with the selection.
  const candidates = groups.filter((group) => group.source === selection?.source).flatMap((group) => group.files);
  const currentFile = selection && (candidates.find((file) => file.path === selection.file.path)
    ?? (/^(?:[A-Za-z]:)?\//.test(selection.file.path) ? candidates.find((file) => resolvePath(file.path, cwd) === selection.file.path) : undefined));
  const selectionReady = !!status && (!(view === "branch" || commit) || !!comparison);
  useEffect(() => {
    if (!selectionReady || focusPath) return;
    setSelection((current) => selectGitChange(groups, current, cwd, commit?.hash));
  }, [groups, selectionReady, focusPath, cwd, commit?.hash]);
  const selected = selection && { ...selection, file: currentFile ?? selection.file };
  function changeView(next: View): void { setView(next); setCommit(undefined); setSelection(undefined); setDrawerOpen(false); }

  if (status && !status.isRepository) return <GitEmpty title={t("git.notRepoTitle")} description={t("git.notRepoDesc")} />;
  const fileCount = groups.reduce((sum, group) => sum + group.files.length, 0);
  const sidebarContent = <div className="flex min-h-0 flex-1 flex-col">
        {view === "workspace" && !commit ? <GitCommitForm
          message={message}
          branch={status?.branch ?? "HEAD"}
          busy={busy}
          canCommit={!!message.trim() && !!status?.staged && !status.files.some(isConflict)}
          canAmend={!!status?.isRepository && !status.files.some(isConflict)}
          canGenerate={!!status?.changed}
          onChange={(next) => { setMessage(next); commitDrafts.set(cwd, next); }}
          onGenerate={() => void generateMessage()}
          onCommit={(action) => void submit(action)}
        /> : null}
        {commit ? <div className="shrink-0 border-b border-border p-2">
          <Button size="xs" variant="ghost" className="mb-1 px-0" onClick={() => changeView("workspace")}><HugeiconsIcon icon={ArrowLeft01Icon} />{t("git.backToWorkspace")}</Button>
          <p className="line-clamp-2 text-xs font-medium" title={commit.subject}>{commit.subject}</p><p className="mt-1 truncate text-[10px] text-muted-foreground">{commit.hash.slice(0, 7)} · {commit.author}</p>
        </div> : null}
        <div className="min-h-0 flex-1">
        <ResizablePanelGroup orientation="vertical">
        <ResizablePanel defaultSize="64%" minSize={100}>
        <ScrollArea className="min-h-0 flex-1">
          {!status || ((view === "branch" || commit) && !comparison && !comparisonError) ? <div className="flex justify-center py-8"><Spinner /></div> : comparisonError ? <p role="alert" className="px-3 py-4 text-xs text-destructive">{view === "branch" && !commit ? t("git.branchUnavailable") : t("git.comparisonFailed")}<span className="mt-1 block break-words text-muted-foreground">{comparisonError}</span></p> : <div className="pb-2">
            {groups.map((group) => {
              if (!group.files.length) return null;
              const editable = view === "workspace" && !commit;
              return <GitChangeGroup key={group.id} title={group.title} count={group.files.length} action={editable && group.id !== "conflicts" ? <IconButton size="icon-xs" variant="ghost" label={t(group.source === "staged" ? "git.unstageAll" : "git.stageAll")} disabled={!!busy} onClick={() => (group.source === "staged" ? unstage : stage)(group.files.map((file) => file.path))}><HugeiconsIcon icon={group.source === "staged" ? MinusSignIcon : Add01Icon} /></IconButton> : undefined}>
                <GitChangeList files={group.files} label={group.title} cwd={cwd} source={group.source} selected={selection?.source === group.source ? selection.file.path : undefined} tree={tree} busy={!!busy} onSelect={(file) => { setSelection({ file, source: group.source, revision: commit?.hash }); setDrawerOpen(false); }} onStage={editable && group.source === "unstaged" ? stage : undefined} onUnstage={editable && group.source === "staged" ? unstage : undefined} onDiscard={editable && group.source === "unstaged" ? setDiscard : undefined} />
              </GitChangeGroup>;
            })}
            {!fileCount ? <p className="px-3 py-8 text-center text-xs text-muted-foreground">{t(view === "workspace" && !commit ? "git.clean" : "git.noDiff")}</p> : null}
          </div>}
        </ScrollArea>
        </ResizablePanel>
        <ResizableHandle aria-label={t("git.resizeHistory")} className="h-px w-full cursor-row-resize bg-border after:top-[-4px] after:right-0 after:bottom-[-4px] after:left-0" />
        <ResizablePanel defaultSize="36%" minSize={historyOpen ? 110 : 32} maxSize={historyOpen ? "75%" : 32}>
          <GitHistoryPanel cwd={cwd} epoch={historyEpoch} scope={historyScope} onScopeChange={setHistoryScope} selected={commit?.hash} open={historyOpen} onOpenChange={setHistoryOpen} onSelect={(next) => { setDrawerOpen(false); setCommit(next); if (next.hash === commit?.hash) return; setComparison(undefined); setComparisonError(""); setSelection(undefined); }} />
        </ResizablePanel>
        </ResizablePanelGroup>
        </div>
  </div>;
  return <div ref={paneRef} className="@container/git flex min-h-0 min-w-0 flex-1 flex-col">
    <div className="flex h-9 shrink-0 items-center gap-1 border-b border-border px-2">
      <IconButton ref={treeToggleRef} size="icon-xs" variant="ghost" label={t(sidebarOpen ? "files.hideTree" : "files.showTree")} aria-expanded={sidebarOpen} onClick={() => narrow ? setDrawerOpen(!drawerOpen) : setSidebarCollapsed(!sidebarCollapsed)}><HugeiconsIcon icon={sidebarOpen ? PanelLeftCloseIcon : PanelLeftOpenIcon} /></IconButton>
      <HugeiconsIcon icon={GitBranchIcon} className="size-3.5 text-muted-foreground" />
      <span className="min-w-0 flex-1 truncate text-xs font-medium">{status?.branch ?? "HEAD"}</span>
      {status?.behind ? <span className="text-xs text-muted-foreground">↓{status.behind}</span> : null}
      {status?.ahead ? <span className="text-xs text-muted-foreground">↑{status.ahead}</span> : null}
      <IconButton size="icon-xs" variant="ghost" label={t("git.pull")} disabled={!!busy} onClick={() => void run("pull", () => window.fastvibe.workspace.gitPull(cwd), t("git.pullDone", { branch: status?.branch }))}>{busy === "pull" ? <Spinner /> : <HugeiconsIcon icon={ArrowDown02Icon} />}</IconButton>
      <IconButton size="icon-xs" variant="ghost" label={t("git.push")} disabled={!!busy} onClick={() => void run("push", () => window.fastvibe.workspace.gitPush(cwd), t("git.pushDone", { branch: status?.branch }))}>{busy === "push" ? <Spinner /> : <HugeiconsIcon icon={ArrowUp02Icon} />}</IconButton>
      <IconButton size="icon-xs" variant="ghost" label={t(tree ? "git.listView" : "git.treeView")} onClick={() => { preferTree = !tree; setTree(!tree); }}><HugeiconsIcon icon={tree ? ListIcon : FolderTreeIcon} /></IconButton>
      <IconButton size="icon-xs" variant="ghost" label={t("git.refresh")} disabled={!!busy || reloading} onClick={() => { void reload(); setHistoryEpoch((n) => n + 1); }}><HugeiconsIcon icon={RefreshIcon} className={cn(reloading && "animate-spin")} /></IconButton>
    </div>
    <div className="flex min-h-0 flex-1">
      {!narrow ? <div style={splitStyle(split.width)} className={cn("min-h-0 w-(--split-w) max-w-[42%] flex-none flex-col", sidebarCollapsed ? "hidden" : "flex")}>{sidebarContent}</div> : null}
      {!narrow && !sidebarCollapsed ? <SplitHandle listSide="start" maxWidthRatio={0.42} label={t("git.resize")} {...split} commit={(width) => {
        if (width < 180) { split.commit(240); setSidebarCollapsed(true); treeToggleRef.current?.focus(); }
        else split.commit(width);
      }} /> : null}
      <div className="flex min-h-0 min-w-0 flex-1 flex-col">
      {commit ? <GitCommitDetails key={commit.hash} commit={commit} count={comparison?.files.length} /> : null}
      {selected ? <DiffPane key={`${selected.source}:${selected.revision ?? ""}:${selected.file.path}`} cwd={cwd} selection={selected} mode={diffMode} setMode={setDiffMode} wrap={wrap} setWrap={setWrap} epoch={epoch} busy={!!busy} onStage={view === "workspace" && !commit && selected.source === "unstaged" ? () => stage([selected.file.path]) : undefined} onUnstage={selected.source === "staged" ? () => unstage([selected.file.path]) : undefined} onDiscard={view === "workspace" && !commit && selected.source === "unstaged" && !isConflict(selected.file) ? () => setDiscard(selected.file) : undefined} onError={onError} /> : <div className="flex min-w-0 flex-1 items-center justify-center p-8 text-xs text-muted-foreground">{commit ? (!comparison && !comparisonError ? <Spinner /> : t(comparisonError ? "git.comparisonFailed" : "git.emptyCommit")) : !status ? <Spinner /> : t(fileCount ? "git.pickDiff" : "git.clean")}</div>}
      </div>
    </div>
    {narrow ? <Sheet open={drawerOpen} onOpenChange={setDrawerOpen}>
      <SheetContent
        side="left"
        showCloseButton={false}
        initialFocus={drawerCloseRef}
        finalFocus={treeToggleRef}
        aria-describedby={undefined}
        className="gap-0 border-border p-0"
        style={{ left: paneBounds.left, top: 0, bottom: 0, width: Math.min(320, Math.max(0, paneBounds.width - 32)), height: "100dvh" }}
      >
        <SheetHeader className="h-9 shrink-0 flex-row items-center gap-1 border-b border-border px-2 py-0">
          <SheetTitle className="min-w-0 flex-1 text-xs">{t("git.changedFiles")}</SheetTitle>
          <IconButton size="icon-xs" variant="ghost" label={t(tree ? "git.listView" : "git.treeView")} onClick={() => { preferTree = !tree; setTree(!tree); }}><HugeiconsIcon icon={tree ? ListIcon : FolderTreeIcon} /></IconButton>
          <SheetClose render={<IconButton ref={drawerCloseRef} size="icon-xs" variant="ghost" label={t("files.hideTree")}><HugeiconsIcon icon={PanelLeftCloseIcon} /></IconButton>} />
        </SheetHeader>
        {sidebarContent}
      </SheetContent>
    </Sheet> : null}
    <AlertDialog open={!!discard} onOpenChange={(open) => { if (!open) setDiscard(undefined); }}>
      <AlertDialogContent><AlertDialogHeader><AlertDialogTitle>{t("git.discardTitle")}</AlertDialogTitle><AlertDialogDescription>{t(discard?.index === "?" ? "git.discardUntracked" : "git.discardDescription", { path: discard?.path })}</AlertDialogDescription></AlertDialogHeader><AlertDialogFooter><AlertDialogCancel>{t("git.cancel")}</AlertDialogCancel><AlertDialogAction variant="destructive" disabled={!!busy} onClick={() => { const file = discard; setDiscard(undefined); if (file) void run("discard", () => window.fastvibe.workspace.gitDiscard(cwd, [file.path]), t("git.discardDone", { path: file.path })); }}>{t("git.discard")}</AlertDialogAction></AlertDialogFooter></AlertDialogContent>
    </AlertDialog>
  </div>;
}

function DiffPane({ cwd, selection, mode, setMode, wrap, setWrap, epoch, busy, onStage, onUnstage, onDiscard, onError }: { cwd: string; selection: Selection; mode: "unified" | "split"; setMode: (mode: "unified" | "split") => void; wrap: boolean; setWrap: (wrap: boolean) => void; epoch: number; busy: boolean; onStage?: () => void; onUnstage?: () => void; onDiscard?: () => void; onError: (message: string) => void }): JSX.Element {
  const { t } = useTranslation("sidepane");
  const displayMode = mode;
  const [diff, setDiff] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);
  const [hunk, setHunk] = useState(-1);
  const previousDiff = useRef("");
  const activeConversation = useSessionStore((state) => state.activeId);
  const owner = useRef(activeConversation);
  const mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  owner.current = activeConversation;
  const name = selection.file.path.split(/[\\/]/).pop() ?? selection.file.path;
  useEffect(() => {
    let cancelled = false;
    setLoading(true); setError("");
    void window.fastvibe.workspace.gitDiff(cwd, selection.file.path, selection.source, selection.revision).then((text) => { if (!cancelled) { setDiff(text); if (text !== previousDiff.current) setHunk(-1); previousDiff.current = text; } }).catch((cause) => { if (!cancelled) { setDiff(""); setError(cause instanceof Error ? cause.message : t("git.diffFailed")); } }).finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [cwd, selection.file.path, selection.source, selection.revision, selection.revision ? 0 : epoch]);
  const parsed = useMemo(() => parseDiff(diff), [diff]);
  const hunks = parsed.rows.filter((row) => row.kind === "hunk").length;
  const added = parsed.rows.filter((row) => row.kind === "added").length;
  const removed = parsed.rows.filter((row) => row.kind === "removed").length;
  async function openFile(): Promise<void> {
    try { const conversation = owner.current; const preview = await window.fastvibe.workspace.preview(resolvePath(selection.file.path, cwd)); if (mounted.current && conversation === useSessionStore.getState().activeId) useSidePaneStore.getState().openFilePreview(preview); }
    catch (cause) { if (mounted.current) onError(cause instanceof Error ? cause.message : t("git.openFailed")); }
  }
  return <div className="@container/diff flex min-h-0 min-w-0 flex-1 flex-col">
    <div className="flex h-9 shrink-0 items-center gap-1 border-b border-border px-2">
      <FileIcon name={name} /><span title={displayPath(selection.file.path, cwd)} className="min-w-0 flex-1 truncate text-xs font-medium">{displayPath(selection.file.path, cwd)}</span>
      {added ? <span className="text-xs tabular-nums text-success">+{added}</span> : null}{removed ? <span className="text-xs tabular-nums text-destructive">−{removed}</span> : null}
      {onStage ? <IconButton size="icon-xs" variant="ghost" label={t("git.stage")} disabled={busy} onClick={onStage}><HugeiconsIcon icon={Add01Icon} /></IconButton> : null}
      {onUnstage ? <IconButton size="icon-xs" variant="ghost" label={t("git.unstage")} disabled={busy} onClick={onUnstage}><HugeiconsIcon icon={MinusSignIcon} /></IconButton> : null}
      {onDiscard ? <IconButton size="icon-xs" variant="ghost" label={t("git.discard")} disabled={busy} onClick={onDiscard}><HugeiconsIcon icon={Delete02Icon} /></IconButton> : null}
      <IconButton size="icon-xs" variant="ghost" label={t("git.openFile")} onClick={() => void openFile()}><HugeiconsIcon icon={File01Icon} /></IconButton>
      {!isRemoteRef(cwd) ? <IconButton size="icon-xs" variant="ghost" label={t("git.reveal")} onClick={() => void window.fastvibe.workspace.reveal(resolvePath(selection.file.path, cwd))}><HugeiconsIcon icon={Folder01Icon} /></IconButton> : null}
    </div>
    <div className="flex min-h-8 shrink-0 flex-wrap items-center gap-1 border-b border-border px-2 py-1">
      <Button size="xs" variant="ghost" className="h-6 px-1.5 text-[11px]" onClick={() => setMode(displayMode === "split" ? "unified" : "split")}>{t(displayMode === "split" ? "git.splitDiff" : "git.unifiedDiff")}</Button>
      <Button size="xs" variant={wrap ? "secondary" : "ghost"} className="h-6 px-1.5 text-[11px]" aria-pressed={wrap} onClick={() => setWrap(!wrap)}>{t("git.wrap")}</Button>
      <span className="ml-auto text-[10px] tabular-nums text-muted-foreground">{hunks ? `${hunk < 0 ? 0 : hunk + 1}/${hunks}` : ""}</span>
      <IconButton size="icon-xs" variant="ghost" label={t("git.previousChange")} disabled={!hunks || loading} onClick={() => setHunk((n) => (n < 0 ? hunks - 1 : (n + hunks - 1) % hunks))}><HugeiconsIcon icon={ArrowUp02Icon} /></IconButton>
      <IconButton size="icon-xs" variant="ghost" label={t("git.nextChange")} disabled={!hunks || loading} onClick={() => setHunk((n) => (n + 1) % hunks)}><HugeiconsIcon icon={ArrowDown02Icon} /></IconButton>
    </div>
    {displayMode === "split" ? <div className="grid shrink-0 grid-cols-2 border-b border-border bg-muted/30 text-[10px] text-muted-foreground"><span className="border-r border-border px-3 py-1">{t(selection.source === "unstaged" ? "git.indexVersion" : selection.source === "staged" || selection.source === "last-turn" ? "git.headVersion" : "git.baseVersion")}</span><span className="px-3 py-1">{selection.revision ? selection.revision.slice(0, 7) : t(selection.source === "staged" ? "git.indexVersion" : selection.source === "branch" ? "git.headVersion" : "git.workingVersion")}</span></div> : null}
    <div className="min-h-0 min-w-0 flex-1 overflow-auto">
      {loading && !diff ? <div className="flex justify-center py-10"><Spinner /></div> : error ? <p role="alert" className="p-4 text-xs text-destructive">{error}</p> : diff ? <DiffView text={diff} hideFileHeaders mode={displayMode} wrap={wrap} activeHunk={hunk} className="mt-0 max-h-none overflow-visible rounded-none border-0" /> : <p className="p-8 text-center text-xs text-muted-foreground">{t("git.noDiff")}</p>}
    </div>
  </div>;
}
