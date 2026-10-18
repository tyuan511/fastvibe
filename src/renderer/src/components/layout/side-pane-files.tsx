import { useCallback, useEffect, useMemo, useRef, useState, type JSX, type KeyboardEvent } from "react";
import { useTranslation } from "react-i18next";
import { HugeiconsIcon } from "@hugeicons/react";
import { ArrowLeft01Icon, ArrowRight01Icon, QuoteUpIcon, SourceCodeIcon, ViewIcon } from "@hugeicons/core-free-icons";
import { editableFileText, prefersSourceEditor } from "@shared/editable-preview";
import { IconButton } from "@/components/icon-button";
import { Button } from "@/components/ui/button";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger,
} from "@/components/ui/context-menu";
import { copyPath, revealPath } from "@/components/path-menu";
import { FileTreeDialog, type FileTreeIntent } from "@/components/layout/file-tree-dialogs";
import { ScrollArea } from "@/components/ui/scroll-area";
import { FileIcon } from "@/components/file-icon";
import { PreviewSurface, previewText } from "@/components/chat/preview-panel";
import { HighlightedEditor } from "@/components/chat/highlighted-editor";
import { FileBreadcrumb } from "@/components/layout/file-breadcrumb";
import { cn } from "@/lib/utils";
import { SplitHandle, splitStyle, useSplitWidth } from "@/components/layout/split-handle";
import { fileTreeGit } from "@/lib/file-tree-git";
import { useGitStatus } from "@/lib/use-git-status";
import { useSidePaneStore, type SidePaneTab } from "@/stores/side-pane";
import { folderName } from "@shared/project-folders";
import type { DirEntry, FilePreview } from "@shared/types";

import { createTextAttachment } from "@/lib/attachments";
import { cleanError } from "@/lib/ipc-error";
import { isRemoteRef } from "@/lib/remote-project";
import { useSessionStore } from "@/stores/session";
import { toast } from "sonner";

type DirMap = Record<string, DirEntry[]>;

/** Project-relative path, or null when `path` is the project root or outside it. */
function projectRelative(cwd: string, path: string): string | null {
  const root = cwd.replace(/\\/g, "/").replace(/\/+$/, "");
  const file = path.replace(/\\/g, "/");
  const prefix = `${root}/`;
  if (!file.startsWith(prefix)) return null;
  const relative = file.slice(prefix.length);
  return relative === "" ? null : relative;
}

/**
 * The grammar the source editor should colour with.
 *
 * A Markdown or HTML file being edited is still that language — the pane's own rendering
 * of it is the other mode. A diff has no grammar of its own to edit against, so it falls
 * back to plain text rather than colouring it as one.
 */
function editorLanguage(preview: FilePreview): string | undefined {
  if (preview.kind === "code") return preview.language;
  if (preview.kind === "markdown") return "markdown";
  if (preview.kind === "html") return "html";
  return undefined;
}

/** Directories between `cwd` and `filePath` that the tree must expand to reveal the file. */
function ancestorDirs(cwd: string, filePath: string): string[] {
  const root = cwd.replace(/\\/g, "/").replace(/\/+$/, "");
  let current = filePath.replace(/\\/g, "/").replace(/\/+$/, "");
  if (current !== root && !current.startsWith(`${root}/`)) return [];
  const dirs: string[] = [];
  while (current.length > root.length) {
    const slash = current.lastIndexOf("/");
    if (slash <= root.length) break;
    current = current.slice(0, slash);
    if (current === root) break;
    dirs.push(current);
  }
  return dirs;
}

/**
 * The directory a row sits in, as the tree must re-read it after a create, rename or delete.
 *
 * Cut at the last separator and nothing else: a row's path is written by the host's
 * `path.join`, so on Windows it is `C:\proj\src` and the tree keys its listings by exactly
 * that string. Normalising to `/` here would reload a key nothing ever reads back, and the
 * rows on screen would keep showing the name that just changed. For a remote project the path
 * carries its `remote:<server>:` prefix, and trimming the last segment keeps it whole.
 */
function parentOf(path: string): string {
  const cut = Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\"));
  return cut > 0 ? path.slice(0, cut) : path;
}

/** Whether `path` is `parent` or sits below it. */
function isAtOrUnder(parent: string, path: string): boolean {
  const base = parent.replace(/\\/g, "/").replace(/\/+$/, "");
  const file = path.replace(/\\/g, "/");
  return file === base || file.startsWith(`${base}/`);
}

/** Every recorded directory at or below `base` — the listings a rename or delete took with it. */
function pruneBelow(map: DirMap, base: string): DirMap {
  const next: DirMap = {};
  for (const [key, value] of Object.entries(map)) {
    if (!isAtOrUnder(base, key)) next[key] = value;
  }
  return next;
}

function dropBelow(set: Set<string>, base: string): Set<string> {
  const next = new Set<string>();
  for (const item of set) if (!isAtOrUnder(base, item)) next.add(item);
  return next;
}

/**
 * Move the unsaved edits a rename moved.
 *
 * A draft is keyed by path, so a rename that leaves the old key behind does not merely lose
 * the mark on screen: the key outlives the file, and the day something else is created at the
 * old path — the agent, or the reader — opening it finds that orphan and offers to save it
 * over the new content.
 */
function rekeyDrafts(prev: Record<string, string>, from: string, to: string): Record<string, string> {
  const next: Record<string, string> = {};
  let changed = false;
  for (const [key, value] of Object.entries(prev)) {
    if (isAtOrUnder(from, key)) {
      next[to + key.slice(from.length)] = value;
      changed = true;
    } else {
      next[key] = value;
    }
  }
  return changed ? next : prev;
}

/** The editor speaks `\n`. Comparing against the file's CRLF would mark every save dirty. */
function editorNewlines(text: string): string {
  return text.replace(/\r\n/g, "\n");
}

function withText(preview: FilePreview, text: string): FilePreview {
  if (preview.kind === "code" || preview.kind === "markdown" || preview.kind === "html" || preview.kind === "diff") {
    return { ...preview, text };
  }
  return preview;
}

/**
 * The right pane's project file view. Narrow panes swap between the tree and the
 * open file; when the pane is wide enough the tree stays on the left and the file
 * on the right, and can be collapsed so the file uses the whole pane. The project
 * directory is not a row for single-folder projects; multiple roots have their own
 * collapsible headings. Text that is the file
 * itself can be edited and saved; a rendered office document cannot, because
 * writing it back would replace the original.
 */
export function SidePaneFiles({
  tab,
  cwd,
  roots,
  remote,
  onError,
}: {
  tab: SidePaneTab;
  cwd?: string;
  roots?: string[];
  remote?: boolean;
  onError: (message: string) => void;
}): JSX.Element {
  const treeRoots = roots && roots.length > 0 ? roots : cwd ? [cwd] : [];
  const rootsKey = treeRoots.join("\0");
  const { t } = useTranslation("sidepane");
  const patchTab = useSidePaneStore((state) => state.patchTab);
  const [children, setChildren] = useState<DirMap>({});
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [collapsedRoots, setCollapsedRoots] = useState<Set<string>>(new Set());
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [saving, setSaving] = useState(false);
  // The one thing the tree's context menu is about to do, and why it could not be done.
  const [intent, setIntent] = useState<FileTreeIntent | null>(null);
  const [intentError, setIntentError] = useState<string | undefined>();
  const [intentBusy, setIntentBusy] = useState(false);
  const [gitEpoch, setGitEpoch] = useState(0);
  const streaming = useSessionStore((state) => state.streaming);
  const gitRefreshKey = `${streaming}:${gitEpoch}`;
  const split = useSplitWidth("files", 224);
  const preview = tab.preview;
  const previewPath = preview?.path ?? null;
  // A new file picks its own default (source for code, rendered for Markdown).
  // Keeping the previous file's toggle would hide a document the reader just opened.
  const [modeFor, setModeFor] = useState<string | null>(previewPath);
  const [editingPath, setEditingPath] = useState<string | null>(
    preview && prefersSourceEditor(preview) ? preview.path : null,
  );
  if (previewPath !== modeFor) {
    setModeFor(previewPath);
    setEditingPath(preview && previewPath && prefersSourceEditor(preview) ? previewPath : null);
  }
  const openPath = useRef(tab.path);
  openPath.current = tab.path;
  // A file opened from this tree (or its breadcrumb) must not collapse the folders
  // the reader just walked. A preview click from the transcript is the other path.
  const openedHere = useRef<string | null>(null);

  const loadDir = useCallback(async (path: string): Promise<void> => {
    try {
      const entries = await window.fastvibe.workspace.readDir(path);
      setChildren((prev) => ({ ...prev, [path]: entries }));
    } catch {
      setChildren((prev) => ({ ...prev, [path]: [] }));
    }
  }, []);

  // A project opens collapsed. Previously expanded folders are not brought back:
  // opening a file should not dump the whole tree open.
  useEffect(() => {
    setChildren({});
    setExpanded(new Set());
    setCollapsedRoots(new Set());
    for (const root of treeRoots) void loadDir(root);
  }, [rootsKey, loadDir]);

  // A preview click (or a file already on the tab when it mounts) reveals only that
  // file. A click inside this tree sets `openedHere` and leaves the folders as they are.
  useEffect(() => {
    const path = tab.path;
    const root = treeRoots.find((item) => path === item || (path?.startsWith(item.endsWith("/") ? item : `${item}/`) ?? false));
    if (!root || !path) return;
    if (openedHere.current === path) {
      openedHere.current = null;
      return;
    }
    setCollapsedRoots((prev) => {
      if (!prev.has(root)) return prev;
      const next = new Set(prev);
      next.delete(root);
      return next;
    });
    const dirs = ancestorDirs(root, path);
    setExpanded(new Set(dirs));
    for (const dir of dirs) void loadDir(dir);
  }, [rootsKey, tab.path, loadDir]);

  function refreshTree(): void {
    setGitEpoch((value) => value + 1);
    for (const root of treeRoots) void loadDir(root);
    for (const dir of expanded) void loadDir(dir);
  }

  function toggleDir(path: string): void {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });
    if (!children[path]) void loadDir(path);
  }

  async function openFile(path: string): Promise<void> {
    try {
      const next = await window.fastvibe.workspace.preview(path);
      openedHere.current = path;
      patchTab(tab.id, { path, preview: next, title: next.name });
      const saved = editableFileText(next);
      if (saved === null) return;
      const baseline = editorNewlines(saved);
      setDrafts((prev) => {
        if (prev[path] === undefined || prev[path] !== baseline) return prev;
        const rest = { ...prev };
        delete rest[path];
        return rest;
      });
    } catch (error) {
      onError(error instanceof Error ? error.message : t("files.previewFailed"));
    }
  }

  function clearPreview(): void {
    patchTab(tab.id, { path: undefined, preview: undefined });
  }

  /** Open the dialog for a menu action, without the reason a previous attempt failed. */
  function openIntent(next: FileTreeIntent): void {
    setIntentError(undefined);
    setIntent(next);
  }

  /**
   * What this tab holds *now*, not what it held when the menu was opened.
   *
   * A dialog sits between the click and the result, and a transcript click, a resource-panel
   * open, or the phone following the active chat can all move this tab's preview meanwhile.
   * `patchTab` resolves the tab by id in the active scope, so writing back from the render-time
   * `tab` would repaint a file the reader has since opened away with a snapshot of the old one.
   */
  function livePreview(): FilePreview | undefined {
    const current = useSidePaneStore.getState().tabs.find((item) => item.id === tab.id);
    return current?.preview;
  }

  /**
   * Run what the menu asked for, then bring the tree and the open file along.
   *
   * A failure leaves the dialog open with its reason (`files.opFailed` only when the host
   * said nothing): the usual cause is a name that is already taken, and the fix is to edit
   * the field still on screen rather than start over.
   */
  async function submitIntent(name: string): Promise<void> {
    if (!intent || intentBusy) return;
    const current = intent;
    setIntentBusy(true);
    try {
      if (current.kind === "create") {
        const entry = await window.fastvibe.workspace.createEntry({
          cwd: current.cwd,
          path: current.parent,
          name,
          kind: current.entryKind,
        });
        // The folder the reader created in is opened so the new row is where they look.
        setExpanded((prev) => new Set(prev).add(current.parent));
        void loadDir(current.parent);
        setGitEpoch((value) => value + 1);
        setIntent(null);
        setIntentError(undefined);
        if (entry.kind === "file") void openFile(entry.path);
        return;
      }
      if (current.kind === "rename") {
        const entry = await window.fastvibe.workspace.renameEntry({ cwd: current.cwd, path: current.path, name });
        void loadDir(current.parent);
        setGitEpoch((value) => value + 1);
        // Its own draft, and every draft inside it when a folder moved.
        setDrafts((prev) => rekeyDrafts(prev, current.path, entry.path));
        const opened = livePreview();
        if (entry.kind === "directory") {
          // Its rows and open folders were read under the old name; the next toggle re-reads.
          setChildren((prev) => pruneBelow(prev, current.path));
          setExpanded((prev) => dropBelow(prev, current.path));
          if (opened && isAtOrUnder(current.path, opened.path)) clearPreview();
        } else if (opened && opened.path === current.path) {
          // The file on screen changed its name, not its bytes: keep showing it.
          patchTab(tab.id, {
            path: entry.path,
            title: entry.name,
            preview: { ...opened, path: entry.path, name: entry.name },
          });
        }
        setIntent(null);
        setIntentError(undefined);
        return;
      }
      await window.fastvibe.workspace.deleteEntry({ cwd: current.cwd, path: current.path });
      void loadDir(current.parent);
      setGitEpoch((value) => value + 1);
      setChildren((prev) => pruneBelow(prev, current.path));
      setExpanded((prev) => dropBelow(prev, current.path));
      const openedAfterDelete = livePreview();
      if (openedAfterDelete && isAtOrUnder(current.path, openedAfterDelete.path)) clearPreview();
      setDrafts((prev) => {
        const rest: Record<string, string> = {};
        let changed = false;
        for (const [key, value] of Object.entries(prev)) {
          if (isAtOrUnder(current.path, key)) changed = true;
          else rest[key] = value;
        }
        return changed ? rest : prev;
      });
      setIntent(null);
      setIntentError(undefined);
    } catch (error) {
      setIntentError(error instanceof Error ? error.message : t("files.opFailed"));
    } finally {
      setIntentBusy(false);
    }
  }

  function changeDraft(path: string, text: string, baseline: string): void {
    setDrafts((prev) => {
      if (text === baseline) {
        if (!(path in prev)) return prev;
        const rest = { ...prev };
        delete rest[path];
        return rest;
      }
      if (prev[path] === text) return prev;
      return { ...prev, [path]: text };
    });
  }

  async function saveFile(): Promise<void> {
    if (!preview || saving) return;
    const draft = drafts[preview.path];
    if (draft === undefined) return;
    const savedPath = preview.path;
    setSaving(true);
    try {
      await window.fastvibe.workspace.writeFile(savedPath, draft);
      setGitEpoch((value) => value + 1);
      if (openPath.current === savedPath) patchTab(tab.id, { preview: withText(preview, draft) });
      setDrafts((prev) => {
        if (prev[savedPath] !== draft) return prev;
        const rest = { ...prev };
        delete rest[savedPath];
        return rest;
      });
    } catch (error) {
      onError(error instanceof Error ? error.message : t("files.saveFailed"));
    } finally {
      setSaving(false);
    }
  }

  if (!cwd) {
    if (preview) {
      return (
        <FilePreviewPane
          preview={preview}
          draft={drafts[preview.path]}
          editing={editingPath === preview.path}
          onEdit={(editing) => setEditingPath(editing ? preview.path : null)}
          onDraft={(text, baseline) => changeDraft(preview.path, text, baseline)}
          onSave={() => void saveFile()}
          onBack={clearPreview}
          onOpenFile={(path) => void openFile(path)}
        />
      );
    }
    return (
      <div className="flex min-h-0 flex-1 items-center justify-center px-8 text-center text-xs leading-5 text-muted-foreground">
        {t("files.unbound")}
      </div>
    );
  }

  const dirty = new Set(Object.keys(drafts));

  return (
    <div className="@container/files flex min-h-0 flex-1 flex-col">
      <div className="flex min-h-0 flex-1 flex-col @min-[32rem]/files:flex-row">
        {/* The tree is always there beside an open file, at the width the splitter was
            dragged to (224px by default) and never collapsed away: the open file takes the
            rest of the pane, so the tree costs nothing a collapse would give back, and a
            column the reader had to reopen is one that can be left hiding the whole pane.
            A narrow pane swaps the two instead. */}
        <div
          style={splitStyle(split.width)}
          className={cn(
            "min-h-0 flex-col",
            preview ? "hidden" : "flex flex-1",
            "@min-[32rem]/files:flex @min-[32rem]/files:w-(--split-w) @min-[32rem]/files:max-w-[75%] @min-[32rem]/files:flex-none",
          )}
        >
          <ScrollArea className="h-full min-h-0 flex-1">
            <div className="flex min-h-full flex-col">
              <div className="py-1.5">
                {treeRoots.map((root) => {
                  const multiple = treeRoots.length > 1;
                  const open = !collapsedRoots.has(root);
                  const tree = (
                    <GitTreeRoot
                      dir={root}
                      depth={multiple ? 1 : 0}
                      children={children}
                      expanded={expanded}
                      selected={preview?.path}
                      dirty={dirty}
                      cwd={root}
                      remote={remote}
                      refreshKey={gitRefreshKey}
                      onToggle={toggleDir}
                      onOpen={openFile}
                      onRefresh={refreshTree}
                      onIntent={openIntent}
                    />
                  );
                  if (!multiple) return <div key={root}>{tree}</div>;
                  return (
                    <Collapsible key={root} open={open} onOpenChange={(value) => {
                      setCollapsedRoots((prev) => {
                        const next = new Set(prev);
                        if (value) next.delete(root);
                        else next.add(root);
                        return next;
                      });
                    }} className="mx-1 mt-1 first:mt-0">
                      <CollapsibleTrigger title={root} render={<Button variant="ghost" className="h-8 w-full justify-start gap-2 bg-muted/60 px-2 text-sm font-medium text-foreground" />}>
                        <HugeiconsIcon icon={ArrowRight01Icon} strokeWidth={2} className={cn("size-3 shrink-0 text-muted-foreground", open && "rotate-90")} />
                        <FileIcon name={folderName(root)} kind="folder" expanded={open} />
                        <span className="min-w-0 flex-1 truncate text-left">{folderName(root)}</span>
                        {root === treeRoots[0] ? <span className="shrink-0 text-xs font-normal text-muted-foreground">{t("files.primary")}</span> : null}
                      </CollapsibleTrigger>
                      <CollapsibleContent>{tree}</CollapsibleContent>
                    </Collapsible>
                  );
                })}
              </div>
              {/* Blank space under the list is the project root. With several folders that
                  space belongs to all of them, so it offers nothing that has to pick one —
                  the folder rows themselves do, and say where the new thing lands. */}
              <ContextMenu>
                <ContextMenuTrigger className="min-h-8 w-full flex-1" />
                <ContextMenuContent className="w-44">
                  <PathContextItems
                    path={cwd}
                    cwd={cwd}
                    kind="directory"
                    name={folderName(cwd)}
                    remote={remote}
                    allowCreate={treeRoots.length === 1}
                    onIntent={openIntent}
                    onRefresh={refreshTree}
                  />
                </ContextMenuContent>
              </ContextMenu>
            </div>
          </ScrollArea>
        </div>
        <SplitHandle listSide="start" label={t("files.resize")} className="hidden @min-[32rem]/files:block" {...split} />
        {preview ? (
          <FilePreviewPane
            preview={preview}
            draft={drafts[preview.path]}
            editing={editingPath === preview.path}
            root={cwd}
            onEdit={(editing) => setEditingPath(editing ? preview.path : null)}
            onDraft={(text, baseline) => changeDraft(preview.path, text, baseline)}
            onSave={() => void saveFile()}
            onBack={clearPreview}
            onOpenFile={(path) => void openFile(path)}
            backClassName="@min-[32rem]/files:hidden"
          />
        ) : (
          <div className="hidden min-h-0 min-w-0 flex-1 items-center justify-center px-8 text-center text-xs leading-5 text-muted-foreground @min-[32rem]/files:flex">
            {t("files.pick")}
          </div>
        )}
      </div>
      {intent ? (
        <FileTreeDialog
          intent={intent}
          busy={intentBusy}
          error={intentError}
          onSubmit={(name) => void submitIntent(name)}
          onCancel={() => { setIntent(null); setIntentError(undefined); }}
        />
      ) : null}
    </div>
  );
}

function FilePreviewPane({
  preview,
  draft,
  editing,
  root,
  onEdit,
  onDraft,
  onSave,
  onBack,
  onOpenFile,
  backClassName,
}: {
  preview: FilePreview;
  draft?: string;
  editing: boolean;
  /** The project directory, so the breadcrumb can drop everything above it. */
  root?: string;
  onEdit: (editing: boolean) => void;
  onDraft: (text: string, baseline: string) => void;
  onSave: () => void;
  onBack: () => void;
  /** A crumb popover opened another file. */
  onOpenFile: (path: string) => void;
  backClassName?: string;
}): JSX.Element {
  const { t } = useTranslation("sidepane");
  const saved = editableFileText(preview);
  const baseline = saved === null ? undefined : editorNewlines(saved);
  const editable = baseline !== undefined;
  const value = draft ?? baseline ?? "";
  const dirty = draft !== undefined && draft !== baseline;
  const shown = draft !== undefined && saved !== null ? withText(preview, draft) : preview;
  const text = previewText(shown);
  const source = editing && editable;
  const [officeLive, setOfficeLive] = useState(false);
  const canCite = preview.kind === "office" && preview.format !== "xlsx" && !isRemoteRef(preview.path) && officeLive;

  function attachSelection(code: string): void {
    const store = useSessionStore.getState();
    if (!store.activeId) return;
    store.setComposer(store.draft, [...store.attachments, createTextAttachment(code, preview.name)]);
    toast.success(t("files.attached"));
  }

  function citeOfficeSelection(): void {
    const store = useSessionStore.getState();
    if (!store.activeId) {
      toast.error(t("files.citeNoConversation"));
      return;
    }
    void window.fastvibe.office
      .selection(preview.path)
      .then((result) => {
        const current = useSessionStore.getState();
        current.setComposer(current.draft, [...current.attachments, createTextAttachment(result.text, preview.name)]);
        toast.success(t("files.attached"));
      })
      .catch((error: unknown) => toast.error(cleanError(error)));
  }

  function onKeyDown(event: KeyboardEvent<HTMLDivElement>): void {
    if (!(event.metaKey || event.ctrlKey) || event.key.toLowerCase() !== "s") return;
    event.preventDefault();
    if (dirty) onSave();
  }

  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col" onKeyDown={onKeyDown}>
      <div className="flex h-10 shrink-0 items-center gap-1.5 border-b border-border px-2">
        <IconButton
          size="icon-xs"
          variant="ghost"
          label={t("files.back")}
          className={backClassName}
          onClick={onBack}
        >
          <HugeiconsIcon strokeWidth={2} icon={ArrowLeft01Icon} />
        </IconButton>
        {/* The path leads the header: the tree beside it is for browsing, and this says
            where the file on screen actually is — and is how a reader moves between
            folders once one is open. */}
        <FileBreadcrumb
          filePath={preview.path}
          root={root}
          onOpenFile={onOpenFile}
        />
        {dirty ? <span className="size-1.5 shrink-0 rounded-full bg-warning" title={t("files.unsaved")} /> : null}
        {/* The source toggle is the only control left. It keeps its own width so the
            path can use the rest of the row. */}
        <div className="flex shrink-0 items-center gap-1.5">
          {canCite ? (
            <Button type="button" size="xs" variant="outline" onClick={citeOfficeSelection}>
              <HugeiconsIcon strokeWidth={2} icon={QuoteUpIcon} />
              {t("files.citeSelection")}
            </Button>
          ) : null}
          {editable ? (
            // The one control the viewer keeps, at the end of the row: it names what the
            // click will show — a `</>` while the document is rendered, an eye while the
            // source is. Saving is ⌘S; a button for it is a second way to do what the
            // keyboard already does.
            <IconButton
              size="icon-xs"
              variant="ghost"
              aria-pressed={source}
              label={source ? t("files.previewMode") : t("files.viewSource")}
              onClick={() => onEdit(!source)}
            >
              <HugeiconsIcon strokeWidth={2} icon={source ? ViewIcon : SourceCodeIcon} />
            </IconButton>
          ) : null}
        </div>
      </div>
      {source && baseline !== undefined ? (
        <HighlightedEditor
          value={value}
          language={editorLanguage(preview)}
          wrap={preview.kind === "markdown" || preview.kind === "html"}
          label={preview.name}
          onChange={(text) => onDraft(text, baseline)}
        />
      ) : (
        <PreviewSurface
          preview={shown}
          document
          onRetry={() => onOpenFile(preview.path)}
          officeLive={preview.kind === "office" && !isRemoteRef(preview.path)}
          onOfficeLive={setOfficeLive}
          onAttachToContext={text !== undefined ? attachSelection : undefined}
        />
      )}
    </div>
  );
}

type TreeLevelProps = {
  dir: string;
  depth: number;
  children: DirMap;
  expanded: Set<string>;
  selected?: string;
  dirty: Set<string>;
  cwd: string;
  remote?: boolean;
  git: ReturnType<typeof fileTreeGit>;
  onToggle: (path: string) => void;
  onOpen: (path: string) => void;
  onRefresh: () => void;
  onIntent: (intent: FileTreeIntent) => void;
};

/** Each project folder can be in a different repository, including on an SSH host. */
function GitTreeRoot({ refreshKey, ...props }: Omit<TreeLevelProps, "git"> & { refreshKey: string }): JSX.Element {
  const status = useGitStatus(props.cwd, refreshKey);
  const git = useMemo(() => fileTreeGit(status), [status]);
  return <TreeLevel {...props} git={git} />;
}

function TreeLevel({
  dir,
  depth,
  children,
  expanded,
  selected,
  dirty,
  cwd,
  remote,
  git,
  onToggle,
  onOpen,
  onRefresh,
  onIntent,
}: TreeLevelProps): JSX.Element {
  const { t } = useTranslation("sidepane");
  const entries = children[dir] ?? [];
  return (
    <>
      {entries.map((entry) => {
        const isDir = entry.kind === "directory";
        const open = isDir && expanded.has(entry.path);
        const active = !isDir && selected === entry.path;
        const unsaved = !isDir && dirty.has(entry.path);
        const relative = projectRelative(cwd, entry.path) ?? "";
        const decoration = (isDir ? git.directories : git.files).get(relative);
        const gitLabel = decoration ? (isDir ? t("files.gitChanges") : t(decoration.label)) : undefined;
        return (
          <div key={entry.path}>
            {/* An indent guide per level. The line is drawn on the trailing edge of the
                indent slot so it passes through the parent folder icon, not to its left. */}
            <ContextMenu>
              <ContextMenuTrigger className="block w-full">
                <button
                  type="button"
                  aria-current={active ? "true" : undefined}
                  className={cn("chat-tree-row", active && "is-active")}
                  title={gitLabel ? `${entry.path} · ${gitLabel}` : entry.path}
                  onClick={() => (isDir ? onToggle(entry.path) : onOpen(entry.path))}
                >
                  <span aria-hidden className="chat-tree-guides">
                    {Array.from({ length: depth }, (_, level) => (
                      <span key={level} />
                    ))}
                  </span>
                  <FileIcon name={entry.name} kind={isDir ? "folder" : "file"} expanded={open} />
                  <span className={cn("min-w-0 flex-1 truncate", decoration?.tone)}>{entry.name}</span>
                  {unsaved ? (
                    <span className="size-1.5 shrink-0 rounded-full bg-warning" title={t("files.unsaved")} />
                  ) : null}
                  {decoration ? (
                    <span
                      className={cn("flex w-4 shrink-0 items-center justify-center text-xs font-medium", decoration.tone)}
                      title={gitLabel}
                      aria-label={gitLabel}
                    >
                      {isDir ? <span aria-hidden className="size-1.5 rounded-full bg-current" /> : decoration.badge}
                    </span>
                  ) : null}
                </button>
              </ContextMenuTrigger>
              <ContextMenuContent className="w-44">
                <PathContextItems
                  path={entry.path}
                  cwd={cwd}
                  name={entry.name}
                  kind={entry.kind}
                  remote={remote}
                  onOpen={isDir ? undefined : () => onOpen(entry.path)}
                  onIntent={onIntent}
                  onRefresh={onRefresh}
                />
              </ContextMenuContent>
            </ContextMenu>
            {open ? (
              <TreeLevel
                dir={entry.path}
                depth={depth + 1}
                children={children}
                expanded={expanded}
                selected={selected}
                dirty={dirty}
                cwd={cwd}
                remote={remote}
                git={git}
                onToggle={onToggle}
                onOpen={onOpen}
                onRefresh={onRefresh}
                onIntent={onIntent}
              />
            ) : null}
          </div>
        );
      })}
    </>
  );
}

/**
 * Right-click actions for a tree row, the project header, or the empty list.
 *
 * The file operations are the reason this menu is wider than a path's: they are the ones a
 * reader would otherwise reach for a terminal to do. Each names the project root it belongs
 * to, and the host refuses anything outside it.
 */
function PathContextItems({
  path,
  cwd,
  name,
  kind,
  remote,
  allowCreate = true,
  onOpen,
  onIntent,
  onRefresh,
}: {
  path: string;
  cwd: string;
  /** The row's own name, which the rename field and the delete confirmation both show. */
  name: string;
  kind: DirEntry["kind"];
  remote?: boolean;
  /** False for the shared blank area of a multi-folder project. */
  allowCreate?: boolean;
  onOpen?: () => void;
  onIntent: (intent: FileTreeIntent) => void;
  onRefresh: () => void;
}): JSX.Element {
  const { t } = useTranslation("sidepane");
  const relative = projectRelative(cwd, path);
  // The project directory itself: it has no row to rename and cannot be deleted from under
  // the pane, but new things still go inside it.
  const isRoot = relative === null;
  const parent = parentOf(path);
  return (
    <>
      {onOpen ? <ContextMenuItem onClick={onOpen}>{t("files.open")}</ContextMenuItem> : null}
      {isRoot ? null : (
        <>
          <ContextMenuItem onClick={() => onIntent({ kind: "rename", cwd, path, parent, name })}>
            {t("files.rename")}
          </ContextMenuItem>
          <ContextMenuItem
            variant="destructive"
            onClick={() => onIntent({ kind: "delete", cwd, path, parent, name, entryKind: kind, remote })}
          >
            {t("files.delete")}
          </ContextMenuItem>
        </>
      )}
      {kind === "directory" && allowCreate ? (
        <>
          {isRoot ? null : <ContextMenuSeparator />}
          <ContextMenuItem onClick={() => onIntent({ kind: "create", cwd, parent: path, entryKind: "file" })}>
            {t("files.newFile")}
          </ContextMenuItem>
          <ContextMenuItem onClick={() => onIntent({ kind: "create", cwd, parent: path, entryKind: "directory" })}>
            {t("files.newFolder")}
          </ContextMenuItem>
        </>
      ) : null}
      <ContextMenuSeparator />
      {remote ? null : (
        <ContextMenuItem onClick={() => void revealPath(path, t("files.notFound"))}>
          {t("files.reveal")}
        </ContextMenuItem>
      )}
      <ContextMenuItem onClick={() => void copyPath(path, t("files.pathCopied"))}>
        {t("files.copyPath")}
      </ContextMenuItem>
      {relative ? (
        <ContextMenuItem onClick={() => void copyPath(relative, t("files.pathCopied"))}>
          {t("files.copyRelativePath")}
        </ContextMenuItem>
      ) : null}
      <ContextMenuSeparator />
      <ContextMenuItem onClick={onRefresh}>{t("files.refresh")}</ContextMenuItem>
    </>
  );
}
