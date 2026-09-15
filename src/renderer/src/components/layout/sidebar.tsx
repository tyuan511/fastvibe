import { useMemo, useRef, useState, type JSX, type KeyboardEvent } from "react";
import { HugeiconsIcon } from "@hugeicons/react";
import { Add01Icon, Archive04Icon, Cancel01Icon, Delete02Icon, Folder01Icon, Folder02Icon, FolderRootIcon, MessageSquarePlusIcon, MoreHorizontalIcon, PencilEdit02Icon, PinIcon, Search01Icon, Settings01Icon, Store01Icon } from "@hugeicons/core-free-icons";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { IconButton } from "@/components/icon-button";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger,
} from "@/components/ui/context-menu";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { ScrollArea } from "@/components/ui/scroll-area";
import { ResizeHandle } from "@/components/resize-handle";
import { AppLogo } from "@/components/app-logo";
import { cn } from "@/lib/utils";
import { clampSidebarWidth, readSidebarWidth, writeSidebarWidth, SIDEBAR_MIN_WIDTH } from "@/lib/sidebar-width";
import { archiveConversations, useArchivedIds } from "@/stores/archive";
import { useSettingsStore } from "@/stores/settings";
import type { Conversation, Project } from "@shared/types";

const COLLAPSED_KEY = "fastvibe.sidebar.collapsed";
const PINNED_KEY = "fastvibe.sidebar.pinned";

type RenameTarget = { type: "session"; id: string } | { type: "project"; cwd: string };
/** Only projects can be removed; sessions are archived, never deleted. */
type DeleteTarget = { type: "project"; cwd: string; title: string };

function SessionBusyMark(): JSX.Element {
  return (
    <span className="flex size-3.5 shrink-0 items-center justify-center" role="status" aria-label="运行中">
      <svg
        viewBox="0 0 16 16"
        className="size-3 animate-[spin_0.7s_linear_infinite] text-muted-foreground"
        fill="none"
      >
        <circle cx="8" cy="8" r="6" stroke="currentColor" strokeWidth="1.5" opacity="0.15" />
        <path d="M14 8a6 6 0 0 0-6-6" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
      </svg>
    </span>
  );
}

function readIdSet(key: string): Set<string> {
  try {
    const raw = localStorage.getItem(key);
    const parsed = raw ? (JSON.parse(raw) as unknown) : [];
    return new Set(Array.isArray(parsed) ? parsed.filter((item) => typeof item === "string") : []);
  } catch {
    return new Set();
  }
}

function persistIdSet(key: string, value: Set<string>): void {
  localStorage.setItem(key, JSON.stringify([...value]));
}

/**
 * Pins are stored as `id -> pinnedAt` so the "已置顶" list can be ordered by pin
 * time. Earlier builds stored a plain id array; keep reading that shape.
 */
function readPinned(): Record<string, number> {
  try {
    const raw = localStorage.getItem(PINNED_KEY);
    const parsed = raw ? (JSON.parse(raw) as unknown) : {};
    if (Array.isArray(parsed)) {
      const out: Record<string, number> = {};
      for (const id of parsed) if (typeof id === "string") out[id] = 0;
      return out;
    }
    if (parsed && typeof parsed === "object") {
      const out: Record<string, number> = {};
      for (const [id, at] of Object.entries(parsed)) {
        if (typeof at === "number") out[id] = at;
      }
      return out;
    }
    return {};
  } catch {
    return {};
  }
}

function persistPinned(value: Record<string, number>): void {
  localStorage.setItem(PINNED_KEY, JSON.stringify(value));
}

function matchesSession(item: Conversation, needle: string): boolean {
  return `${item.title} ${item.preview ?? ""}`.toLowerCase().includes(needle);
}

function InlineRename({
  value,
  onSubmit,
  onCancel,
}: {
  value: string;
  onSubmit: (next: string) => void;
  onCancel: () => void;
}): JSX.Element {
  const [draft, setDraft] = useState(value);
  const done = useRef(false);

  function finish(next: string): void {
    if (done.current) return;
    done.current = true;
    const trimmed = next.trim();
    if (!trimmed || trimmed === value) onCancel();
    else onSubmit(trimmed);
  }

  function handleKeyDown(event: KeyboardEvent<HTMLInputElement>): void {
    if (event.key === "Enter") {
      event.preventDefault();
      finish(draft);
    }
    if (event.key === "Escape") {
      event.preventDefault();
      done.current = true;
      onCancel();
    }
  }

  return (
    <Input
      autoFocus
      value={draft}
      className="h-6 px-1.5 text-xs"
      onChange={(event) => setDraft(event.target.value)}
      onKeyDown={handleKeyDown}
      onBlur={() => finish(draft)}
      onClick={(event) => event.stopPropagation()}
      onPointerDown={(event) => event.stopPropagation()}
    />
  );
}

function SectionLabel({
  children,
  action,
}: {
  children: React.ReactNode;
  action?: React.ReactNode;
}): JSX.Element {
  return (
    <div className="group/section mt-3 flex items-center justify-between pr-1 pl-2 text-[11px] font-medium tracking-wide text-muted-foreground">
      <span className="py-1">{children}</span>
      {action}
    </div>
  );
}

export function Sidebar({
  projects,
  conversations,
  activeId,
  running,
  onNewChat,
  onOpen,
  onAddProject,
  onRenameSession,
  onRenameProject,
  onRemoveProject,
  onRevealProject,
  onOpenSettings,
  onOpenMarket,
}: {
  projects: Project[];
  conversations: Conversation[];
  activeId: string | null;
  running: Record<string, boolean>;
  onNewChat: (cwd?: string) => void;
  onOpen: (id: string) => void;
  onAddProject: () => void;
  onRenameSession: (id: string, title: string) => void;
  onRenameProject: (cwd: string, name: string) => void;
  onRemoveProject: (cwd: string) => void;
  onRevealProject: (cwd: string) => void;
  onOpenSettings: () => void;
  onOpenMarket: () => void;
}): JSX.Element | null {
  const [query, setQuery] = useState("");
  const [searchOpen, setSearchOpen] = useState(false);
  const [width, setWidth] = useState(readSidebarWidth);
  const sidebarCollapsed = useSettingsStore((state) => state.settings.sidebarCollapsed ?? false);
  const updateSettings = useSettingsStore((state) => state.update);
  const [collapsed, setCollapsed] = useState<Set<string>>(() => readIdSet(COLLAPSED_KEY));
  const [pinned, setPinned] = useState<Record<string, number>>(() => readPinned());
  // Shared with Settings → 归档对话, where archived chats can be restored or deleted.
  const archived = useArchivedIds();
  const [renaming, setRenaming] = useState<RenameTarget | null>(null);
  const [pendingDelete, setPendingDelete] = useState<DeleteTarget | null>(null);
  const startWidth = useRef(width);
  // Set once the drag has crossed the minimum, so the collapsing branch fires a
  // single settings write instead of one per mousemove until the drag ends.
  const collapsing = useRef(false);

  /** Live width while dragging; only written to disk once the drag ends. */
  function applyWidth(next: number): void {
    setWidth(clampSidebarWidth(next));
  }

  function setOpen(cwd: string, open: boolean): void {
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (open) next.delete(cwd);
      else next.add(cwd);
      persistIdSet(COLLAPSED_KEY, next);
      return next;
    });
  }

  function togglePinned(id: string): void {
    setPinned((prev) => {
      const next = { ...prev };
      if (id in next) delete next[id];
      else next[id] = Date.now();
      persistPinned(next);
      return next;
    });
  }

  /** Archived conversations are hidden from every list: Settings → 归档对话 manages them. */
  function archiveSession(id: string): void {
    archiveConversations(id);
  }

  function sortSessions(items: Conversation[]): Conversation[] {
    // Creation order, not activity order: opening or renaming a chat must not
    // make it jump to the top of the list.
    return [...items].sort((a, b) => b.createdAt - a.createdAt || a.id.localeCompare(b.id));
  }

  const q = query.trim().toLowerCase();

  const pinnedItems = useMemo(() => {
    const items = conversations.filter(
      (item) => item.preview && pinned[item.id] !== undefined && !archived.has(item.id),
    );
    const filtered = q ? items.filter((item) => matchesSession(item, q)) : items;
    return [...filtered].sort(
      (a, b) => (pinned[b.id] ?? 0) - (pinned[a.id] ?? 0) || b.createdAt - a.createdAt || a.id.localeCompare(b.id),
    );
  }, [conversations, pinned, archived, q]);

  const groups = useMemo(() => {
    const byProject = new Map<string, Conversation[]>();
    for (const item of conversations) {
      if (!item.project || !item.preview) continue;
      // Pinned chats live in the dedicated "已置顶" area, archived ones are hidden.
      if (pinned[item.id] !== undefined || archived.has(item.id)) continue;
      const list = byProject.get(item.project) ?? [];
      list.push(item);
      byProject.set(item.project, list);
    }

    const result: Array<{ cwd: string; name: string; items: Conversation[] }> = [];
    for (const project of projects) {
      const items = byProject.get(project.cwd) ?? [];
      const projectHit = !q || project.name.toLowerCase().includes(q) || project.cwd.toLowerCase().includes(q);
      const filtered = projectHit
        ? items
        : items.filter((item) => `${item.title} ${item.preview ?? ""}`.toLowerCase().includes(q));
      if (!q || projectHit || filtered.length > 0) {
        result.push({ cwd: project.cwd, name: project.name, items: sortSessions(filtered) });
      }
    }
    return result;
  }, [conversations, pinned, archived, projects, q]);

  // Conversations with no project live here so they stay reachable without a project group.
  const recent = useMemo(() => {
    const unbound = conversations
      .filter((item) => !item.project && item.preview)
      .filter((item) => pinned[item.id] === undefined && !archived.has(item.id))
      .filter((item) => !q || matchesSession(item, q));
    return sortSessions(unbound);
  }, [conversations, pinned, archived, q]);

  function renderSession(item: Conversation): JSX.Element {
    const active = item.id === activeId;
    const renamingThis = renaming?.type === "session" && renaming.id === item.id;
    const isPinned = pinned[item.id] !== undefined;
    // The per-conversation map survives switching/new chats, so a session that is
    // still working keeps its spinner even when it is not the active one.
    const showSpinner = running[item.id] === true;
    return (
      <ContextMenu key={item.id}>
        <ContextMenuTrigger className="w-full">
          <div
            className={cn(
              "group/session flex h-8 cursor-pointer items-center gap-2.5 rounded-md pr-1 pl-2 text-[13px] transition-colors",
              active ? "bg-sidebar-accent text-sidebar-accent-foreground" : "hover:bg-sidebar-accent/50",
            )}
            onClick={() => onOpen(item.id)}
          >
            {/* Reserved slot keeps session titles aligned with project names. */}
            {showSpinner ? <SessionBusyMark /> : <span className="size-3.5 shrink-0" />}
            {renamingThis ? (
              <InlineRename
                value={item.title}
                onSubmit={(title) => {
                  onRenameSession(item.id, title);
                  setRenaming(null);
                }}
                onCancel={() => setRenaming(null)}
              />
            ) : (
              <>
                <span className="min-w-0 flex-1 truncate">{item.title}</span>
                <div className="flex shrink-0 items-center gap-0.5 opacity-0 group-hover/session:opacity-100 focus-within:opacity-100">
                  <IconButton
                    size="icon-xs"
                    variant="ghost"
                    className="text-muted-foreground"
                    label={isPinned ? "取消置顶" : "置顶"}
                    onClick={(event) => {
                      event.stopPropagation();
                      togglePinned(item.id);
                    }}
                    onPointerDown={(event) => event.stopPropagation()}
                  >
                    <HugeiconsIcon strokeWidth={2} icon={PinIcon} className={cn("size-3.5", isPinned && "fill-current")} />
                  </IconButton>
                  <IconButton
                    size="icon-xs"
                    variant="ghost"
                    className="text-muted-foreground"
                    label="归档"
                    onClick={(event) => {
                      event.stopPropagation();
                      archiveSession(item.id);
                    }}
                    onPointerDown={(event) => event.stopPropagation()}
                  >
                    <HugeiconsIcon strokeWidth={2} icon={Archive04Icon} className="size-3.5" />
                  </IconButton>
                </div>
              </>
            )}
          </div>
        </ContextMenuTrigger>
        <ContextMenuContent className="w-32">
          <ContextMenuItem onClick={() => togglePinned(item.id)}>
            {isPinned ? "取消置顶" : "置顶"}
          </ContextMenuItem>
          <ContextMenuItem onClick={() => setRenaming({ type: "session", id: item.id })}>重命名</ContextMenuItem>
          <ContextMenuItem onClick={() => archiveSession(item.id)}>归档</ContextMenuItem>
        </ContextMenuContent>
      </ContextMenu>
    );
  }

  // Collapsed (dragged below the minimum width, or via the header toggle): the
  // sidebar is removed from the layout rather than shrunk to a sliver.
  if (sidebarCollapsed) return null;

  return (
    <aside
      className="relative flex shrink-0 flex-col border-r border-sidebar-border bg-sidebar text-sidebar-foreground"
      style={{ width }}
    >
      <ResizeHandle
        side="right"
        onDragStart={() => {
          startWidth.current = width;
          collapsing.current = false;
        }}
        onDrag={(delta) => {
          const next = startWidth.current + delta;
          // Dragging past the minimum collapses the sidebar instead of clamping
          // to it; the header toggle (or dragging back out) restores the width.
          if (next < SIDEBAR_MIN_WIDTH) {
            if (!collapsing.current) {
              collapsing.current = true;
              updateSettings({ sidebarCollapsed: true });
            }
            return;
          }
          applyWidth(next);
        }}
        onDragEnd={(delta) => {
          const next = startWidth.current + delta;
          if (next >= SIDEBAR_MIN_WIDTH) writeSidebarWidth(next);
        }}
      />
      <div className="drag-region h-10" />

      <div className="no-drag px-2">
        <div className="flex h-8 items-center justify-between">
          <div className="flex items-center gap-2 px-2">
            <AppLogo className="size-5 shrink-0 rounded-md" />
            <span className="text-[13px] font-semibold tracking-tight">FastVibe</span>
          </div>
          <div className="flex items-center gap-0.5">
            <IconButton
              size="icon-sm"
              variant="ghost"
              className="text-muted-foreground"
              label={searchOpen ? "关闭搜索" : "搜索"}
              onClick={() => {
                setSearchOpen((value) => !value);
                if (searchOpen) setQuery("");
              }}
            >
              {searchOpen ? <HugeiconsIcon strokeWidth={2} icon={Cancel01Icon} /> : <HugeiconsIcon strokeWidth={2} icon={Search01Icon} />}
            </IconButton>
          </div>
        </div>

        {searchOpen ? (
          <div className="pb-1">
            <Input
              autoFocus
              value={query}
              placeholder="搜索项目或对话"
              className="h-8 text-xs"
              onChange={(event) => setQuery(event.target.value)}
            />
          </div>
        ) : null}

        <div className="mt-1 space-y-0.5">
          <button
            type="button"
            className="flex h-8 w-full items-center gap-2.5 rounded-md px-2 text-[13px] hover:bg-sidebar-accent/50"
            onClick={() => onNewChat()}
          >
            <HugeiconsIcon strokeWidth={2} icon={MessageSquarePlusIcon} className="size-3.5 text-muted-foreground" />
            新对话
          </button>
          <button
            type="button"
            className="flex h-8 w-full items-center gap-2.5 rounded-md px-2 text-[13px] hover:bg-sidebar-accent/50"
            onClick={onOpenMarket}
          >
            <HugeiconsIcon strokeWidth={2} icon={Store01Icon} className="size-3.5 text-muted-foreground" />
            插件市场
          </button>
        </div>
      </div>

      <ScrollArea className="no-drag min-h-0 flex-1">
        <div className="px-2 pb-2">
          {pinnedItems.length > 0 ? (
            <>
              <SectionLabel>已置顶</SectionLabel>
              <div className="space-y-0.5">{pinnedItems.map((item) => renderSession(item))}</div>
            </>
          ) : null}

          <SectionLabel
            action={
              <IconButton
                size="icon-xs"
                variant="ghost"
                label="新项目"
                className="text-muted-foreground opacity-0 transition-opacity focus-visible:opacity-100 group-hover/section:opacity-100"
                onClick={onAddProject}
              >
                <HugeiconsIcon strokeWidth={2} icon={Add01Icon} className="size-3.5" />
              </IconButton>
            }
          >
            项目
          </SectionLabel>
          {groups.length === 0 ? (
            <p className="px-2 py-2 text-[12px] text-muted-foreground">还没有项目</p>
          ) : (
            <div className="space-y-0.5">
              {groups.map((group) => {
                const open = !collapsed.has(group.cwd);
                const renamingProject = renaming?.type === "project" && renaming.cwd === group.cwd;
                return (
                  <Collapsible
                    key={group.cwd}
                    open={open}
                    onOpenChange={(next) => setOpen(group.cwd, next)}
                  >
                    <ContextMenu>
                      <ContextMenuTrigger className="w-full">
                        <div className="group/project flex h-8 items-center gap-0.5 rounded-md pr-1 pl-2 hover:bg-sidebar-accent/50">
                          <CollapsibleTrigger className="flex min-w-0 flex-1 items-center gap-2.5 text-left text-[13px]">
                            {open ? (
                              <HugeiconsIcon strokeWidth={2} icon={Folder02Icon} className="size-3.5 shrink-0 text-muted-foreground" />
                            ) : (
                              <HugeiconsIcon strokeWidth={2} icon={Folder01Icon} className="size-3.5 shrink-0 text-muted-foreground" />
                            )}
                            {renamingProject ? (
                              <InlineRename
                                value={group.name}
                                onSubmit={(name) => {
                                  onRenameProject(group.cwd, name);
                                  setRenaming(null);
                                }}
                                onCancel={() => setRenaming(null)}
                              />
                            ) : (
                              <span className="truncate">{group.name}</span>
                            )}
                          </CollapsibleTrigger>
                          <div className="flex shrink-0 items-center gap-0.5 opacity-0 group-hover/project:opacity-100 focus-within:opacity-100 has-[[aria-expanded=true]]:opacity-100">
                            <DropdownMenu>
                              <DropdownMenuTrigger
                                render={<Button size="icon-xs" variant="ghost" className="text-muted-foreground" />}
                                onClick={(event) => event.stopPropagation()}
                                onPointerDown={(event) => event.stopPropagation()}
                              >
                                <HugeiconsIcon strokeWidth={2} icon={MoreHorizontalIcon} className="size-3.5" />
                              </DropdownMenuTrigger>
                              <DropdownMenuContent align="end" className="w-40 min-w-40">
                                <DropdownMenuItem onClick={() => onNewChat(group.cwd)}>
                                  <HugeiconsIcon strokeWidth={2} icon={Add01Icon} />
                                  新建对话
                                </DropdownMenuItem>
                                <DropdownMenuItem onClick={() => setRenaming({ type: "project", cwd: group.cwd })}>
                                  <HugeiconsIcon strokeWidth={2} icon={PencilEdit02Icon} />
                                  重命名
                                </DropdownMenuItem>
                                <DropdownMenuItem onClick={() => onRevealProject(group.cwd)}>
                                  <HugeiconsIcon strokeWidth={2} icon={FolderRootIcon} />
                                  在访达中显示
                                </DropdownMenuItem>
                                <DropdownMenuSeparator />
                                <DropdownMenuItem
                                  variant="destructive"
                                  onClick={() =>
                                    setPendingDelete({ type: "project", cwd: group.cwd, title: group.name })
                                  }
                                >
                                  <HugeiconsIcon strokeWidth={2} icon={Delete02Icon} />
                                  从列表移除
                                </DropdownMenuItem>
                              </DropdownMenuContent>
                            </DropdownMenu>
                            <IconButton
                              size="icon-xs"
                              variant="ghost"
                              className="text-muted-foreground"
                              label="新建会话"
                              onClick={(event) => {
                                event.stopPropagation();
                                setOpen(group.cwd, true);
                                onNewChat(group.cwd);
                              }}
                            >
                              <HugeiconsIcon strokeWidth={2} icon={PencilEdit02Icon} className="size-3.5" />
                            </IconButton>
                          </div>
                        </div>
                      </ContextMenuTrigger>
                      <ContextMenuContent className="w-40">
                        <ContextMenuItem onClick={() => onNewChat(group.cwd)}>新建对话</ContextMenuItem>
                        <ContextMenuItem onClick={() => setRenaming({ type: "project", cwd: group.cwd })}>
                          重命名
                        </ContextMenuItem>
                        <ContextMenuItem onClick={() => onRevealProject(group.cwd)}>在访达中显示</ContextMenuItem>
                        <ContextMenuSeparator />
                        <ContextMenuItem
                          variant="destructive"
                          onClick={() =>
                            setPendingDelete({ type: "project", cwd: group.cwd, title: group.name })
                          }
                        >
                          从列表移除
                        </ContextMenuItem>
                      </ContextMenuContent>
                    </ContextMenu>
                    <CollapsibleContent>
                      <div className="space-y-0.5">
                        {group.items.length === 0 ? (
                          <p className="flex h-8 items-center gap-2.5 pl-2 text-[12px] text-muted-foreground">
                            <span className="size-3.5 shrink-0" />
                            暂无对话
                          </p>
                        ) : (
                          group.items.map((item) => renderSession(item))
                        )}
                      </div>
                    </CollapsibleContent>
                  </Collapsible>
                );
              })}
            </div>
          )}

          {recent.length > 0 ? (
            <>
              <SectionLabel>最近</SectionLabel>
              <div className="space-y-0.5">{recent.map((item) => renderSession(item))}</div>
            </>
          ) : null}
        </div>
      </ScrollArea>

      <div className="no-drag p-2">
        <button
          type="button"
          className="flex h-8 w-full items-center gap-2.5 rounded-md px-2 text-[13px] hover:bg-sidebar-accent/50"
          onClick={onOpenSettings}
        >
          <HugeiconsIcon strokeWidth={2} icon={Settings01Icon} className="size-3.5 text-muted-foreground" />
          设置
        </button>
      </div>

      <AlertDialog open={pendingDelete !== null} onOpenChange={(open) => !open && setPendingDelete(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>从列表移除项目？</AlertDialogTitle>
            <AlertDialogDescription>
              {`「${pendingDelete?.title ?? ""}」下的对话会从列表中移除，不会删除磁盘上的项目文件。`}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>取消</AlertDialogCancel>
            <AlertDialogAction
              variant="destructive"
              onClick={() => {
                if (!pendingDelete) return;
                onRemoveProject(pendingDelete.cwd);
                setPendingDelete(null);
              }}
            >
              移除
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </aside>
  );
}
