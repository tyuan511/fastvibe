import { useCallback, useMemo, useRef, useState, type CSSProperties, type JSX, type KeyboardEvent } from "react";
import { HugeiconsIcon } from "@hugeicons/react";
import { Add01Icon, Archive04Icon, ArrowLeft01Icon, ArrowRight01Icon, Delete02Icon, DragDropVerticalIcon, Folder01Icon, Folder02Icon, FolderRootIcon, MessageSquarePlusIcon, MoreHorizontalIcon, PanelLeftCloseIcon, PencilEdit02Icon, PinIcon, PuzzleIcon, Search01Icon, Settings01Icon } from "@hugeicons/core-free-icons";
import {
  DndContext,
  DragOverlay,
  PointerSensor,
  closestCenter,
  defaultDropAnimationSideEffects,
  useSensor,
  useSensors,
  type CollisionDetection,
  type DragEndEvent,
  type DragStartEvent,
  type DropAnimation,
} from "@dnd-kit/core";
import { restrictToVerticalAxis } from "@dnd-kit/modifiers";
import { SortableContext, arrayMove, useSortable, verticalListSortingStrategy } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
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
import { CollapsiblePanel } from "@/components/layout/collapsible-panel";
import { AppLogo } from "@/components/app-logo";
import { cn } from "@/lib/utils";
import { clampSidebarWidth, readSidebarWidth, writeSidebarWidth, SIDEBAR_MIN_WIDTH } from "@/lib/sidebar-width";
import { archiveConversations, useArchivedIds } from "@/stores/archive";
import { useSettingsStore } from "@/stores/settings";
import { useShortcutLabel } from "@/lib/use-shortcuts";
import { useHistoryNav } from "@/lib/use-history-nav";
import type { Conversation, Project } from "@shared/types";

/**
 * macOS traffic lights overlay the sidebar's title bar (`hiddenInset`). Inset
 * the collapse control so it sits on the same row, just past the lights.
 */
const IS_MAC = typeof navigator !== "undefined" && /mac/i.test(navigator.userAgent);

const COLLAPSED_KEY = "fastvibe.sidebar.collapsed";
const PINNED_KEY = "fastvibe.sidebar.pinned";

type RenameTarget = { type: "session"; id: string } | { type: "project"; cwd: string };
/** Only projects can be removed; sessions are archived, never deleted. */
type DeleteTarget = { type: "project"; cwd: string; title: string };

/** Slow, ease-out settle for displaced rows so a drop glides instead of snapping. */
const REORDER_TRANSITION = { duration: 220, easing: "cubic-bezier(0.2, 0, 0, 1)" };
const DROP_ANIMATION: DropAnimation = {
  duration: 250,
  easing: "cubic-bezier(0.2, 0, 0, 1)",
  sideEffects: defaultDropAnimationSideEffects({ styles: { active: { opacity: "0.4" } } }),
};

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
    <div className="group/section mt-3 flex items-center justify-between pr-1 pl-2 text-xs font-medium tracking-wide text-muted-foreground">
      <span className="py-1">{children}</span>
      {action}
    </div>
  );
}

/**
 * Manual order wins for conversations the user has dragged; everything else keeps
 * the section's default sort and floats to the top, so a freshly created (or newly
 * pinned) chat appears first until it is dragged into place.
 */
function applyManualOrder(items: Conversation[], order: string[] | undefined): Conversation[] {
  if (!order || order.length === 0) return items;
  const rank = new Map<string, number>();
  order.forEach((id, index) => rank.set(id, index));
  const ranked = items.filter((item) => rank.has(item.id)).sort((a, b) => rank.get(a.id)! - rank.get(b.id)!);
  const unranked = items.filter((item) => !rank.has(item.id));
  return unranked.length > 0 ? [...unranked, ...ranked] : ranked;
}

/** Section keys under `settings.sidebarOrder`; project lists are scoped by cwd. */
function sectionKey(kind: "pinned" | "recent"): string;
function sectionKey(kind: "project", cwd: string): string;
function sectionKey(kind: "pinned" | "recent" | "project", cwd?: string): string {
  return kind === "project" ? `project:${cwd ?? ""}` : kind;
}

/** The visual body of one conversation row, shared by the sortable list and the drag overlay. */
function SessionRowContent({
  item,
  active,
  isPinned,
  showSpinner,
  renamingThis,
  overlay,
  onOpen,
  onTogglePin,
  onArchive,
  onRename,
  onCancelRename,
}: {
  item: Conversation;
  active: boolean;
  isPinned: boolean;
  showSpinner: boolean;
  renamingThis: boolean;
  overlay?: boolean;
  onOpen: () => void;
  onTogglePin: () => void;
  onArchive: () => void;
  onRename: (title: string) => void;
  onCancelRename: () => void;
}): JSX.Element {
  return (
    <div
      className={cn(
        "group/session flex h-8 cursor-pointer items-center gap-2.5 rounded-md pr-1 pl-2 text-sm transition-colors",
        active ? "bg-sidebar-accent text-sidebar-accent-foreground" : "hover:bg-sidebar-accent/50",
        overlay && "bg-sidebar-accent text-sidebar-accent-foreground shadow-lg ring-1 ring-border",
      )}
      onClick={onOpen}
    >
      {/* Leading slot: the busy mark, or the drag affordance on hover. Keeping it
          fixed-width leaves session titles aligned with project names. */}
      <span className="flex size-3.5 shrink-0 items-center justify-center">
        {showSpinner ? (
          <SessionBusyMark />
        ) : (
          <HugeiconsIcon
            strokeWidth={2}
            icon={DragDropVerticalIcon}
            className={cn(
              "size-3.5 text-muted-foreground transition-opacity",
              overlay ? "opacity-70" : "opacity-0 group-hover/session:opacity-70",
            )}
          />
        )}
      </span>
      {renamingThis ? (
        <InlineRename value={item.title} onSubmit={onRename} onCancel={onCancelRename} />
      ) : (
        <>
          <span className="min-w-0 flex-1 truncate">{item.title}</span>
          {overlay ? null : (
            <div className="flex shrink-0 items-center gap-0.5 opacity-0 group-hover/session:opacity-100 focus-within:opacity-100">
              <IconButton
                size="icon-xs"
                variant="ghost"
                className="text-muted-foreground"
                label={isPinned ? "取消置顶" : "置顶"}
                onClick={(event) => {
                  event.stopPropagation();
                  onTogglePin();
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
                  onArchive();
                }}
                onPointerDown={(event) => event.stopPropagation()}
              >
                <HugeiconsIcon strokeWidth={2} icon={Archive04Icon} className="size-3.5" />
              </IconButton>
            </div>
          )}
        </>
      )}
    </div>
  );
}

/**
 * One draggable conversation. dnd-kit's transform/transition animate the neighbours
 * out of the way while `DragOverlay` follows the pointer, so the row itself is
 * hidden during the drag and the overlay carries the moving chrome.
 */
function SortableSession({
  item,
  active,
  isPinned,
  showSpinner,
  renamingThis,
  onOpen,
  onTogglePin,
  onArchive,
  onStartRename,
  onRename,
  onCancelRename,
}: {
  item: Conversation;
  active: boolean;
  isPinned: boolean;
  showSpinner: boolean;
  renamingThis: boolean;
  onOpen: () => void;
  onTogglePin: () => void;
  onArchive: () => void;
  onStartRename: () => void;
  onRename: (title: string) => void;
  onCancelRename: () => void;
}): JSX.Element {
  const { listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: item.id,
    transition: REORDER_TRANSITION,
  });
  const style: CSSProperties = {
    transform: CSS.Transform.toString(transform),
    transition,
    // The overlay draws the moving row; the source only holds its place.
    opacity: isDragging ? 0 : undefined,
    position: "relative",
    zIndex: isDragging ? 10 : undefined,
  };
  return (
    // pan-y lets a touchscreen scroll the list; mouse drag is unaffected (the
    // PointerSensor only needs `touch-action` for touch pointers).
    <div ref={setNodeRef} style={style} {...listeners} className="touch-pan-y">
      <ContextMenu>
        <ContextMenuTrigger className="w-full">
          <SessionRowContent
            item={item}
            active={active}
            isPinned={isPinned}
            showSpinner={showSpinner}
            renamingThis={renamingThis}
            onOpen={onOpen}
            onTogglePin={onTogglePin}
            onArchive={onArchive}
            onRename={onRename}
            onCancelRename={onCancelRename}
          />
        </ContextMenuTrigger>
        <ContextMenuContent className="w-32">
          <ContextMenuItem onClick={onTogglePin}>{isPinned ? "取消置顶" : "置顶"}</ContextMenuItem>
          <ContextMenuItem onClick={onStartRename}>重命名</ContextMenuItem>
          <ContextMenuItem onClick={onArchive}>归档</ContextMenuItem>
        </ContextMenuContent>
      </ContextMenu>
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
  onSearch,
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
  onSearch: () => void;
}): JSX.Element {
  const [width, setWidth] = useState(readSidebarWidth);
  const sidebarCollapsed = useSettingsStore((state) => state.settings.sidebarCollapsed ?? false);
  const sidebarOrder = useSettingsStore((state) => state.settings.sidebarOrder);
  const updateSettings = useSettingsStore((state) => state.update);
  const toggleSidebarShortcut = useShortcutLabel("toggleSidebar");
  const { canBack, canForward, back, forward } = useHistoryNav();
  const [collapsed, setCollapsed] = useState<Set<string>>(() => readIdSet(COLLAPSED_KEY));
  const [pinned, setPinned] = useState<Record<string, number>>(() => readPinned());
  // Shared with Settings → 归档对话, where archived chats can be restored or deleted.
  const archived = useArchivedIds();
  const [renaming, setRenaming] = useState<RenameTarget | null>(null);
  const [pendingDelete, setPendingDelete] = useState<DeleteTarget | null>(null);
  const [activeDragId, setActiveDragId] = useState<string | null>(null);
  const startWidth = useRef(width);
  // Set once the drag has crossed the minimum, so the collapsing branch fires a
  // single settings write instead of one per mousemove until the drag ends.
  const collapsing = useRef(false);
  // Live splitter drags skip the spring so the edge tracks the pointer.
  const [resizing, setResizing] = useState(false);
  const sensors = useSensors(
    // A small threshold keeps a plain click (open the chat) from starting a drag,
    // and lets the row's nested pin/archive buttons stop propagation untouched.
    useSensor(PointerSensor, { activationConstraint: { distance: 5 } }),
  );

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

  const pinnedItems = useMemo(() => {
    const items = conversations.filter(
      (item) => item.preview && pinned[item.id] !== undefined && !archived.has(item.id),
    );
    const sorted = [...items].sort(
      (a, b) => (pinned[b.id] ?? 0) - (pinned[a.id] ?? 0) || b.createdAt - a.createdAt || a.id.localeCompare(b.id),
    );
    return applyManualOrder(sorted, sidebarOrder?.[sectionKey("pinned")]);
  }, [conversations, pinned, archived, sidebarOrder]);

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

    const result: Array<{ cwd: string; name: string; items: Conversation[]; key: string }> = [];
    for (const project of projects) {
      const items = byProject.get(project.cwd) ?? [];
      const key = sectionKey("project", project.cwd);
      result.push({
        cwd: project.cwd,
        name: project.name,
        key,
        items: applyManualOrder(sortSessions(items), sidebarOrder?.[key]),
      });
    }
    return result;
  }, [conversations, pinned, archived, projects, sidebarOrder]);

  // Conversations with no project live here so they stay reachable without a project group.
  const recent = useMemo(() => {
    const unbound = conversations
      .filter((item) => !item.project && item.preview)
      .filter((item) => pinned[item.id] === undefined && !archived.has(item.id));
    return applyManualOrder(sortSessions(unbound), sidebarOrder?.[sectionKey("recent")]);
  }, [conversations, pinned, archived, sidebarOrder]);

  // Maps every rendered conversation to the section it lives in, so a drag can only
  // ever reorder within its own list and the drop is scoped to those siblings.
  const sections = useMemo(() => {
    const map = new Map<string, { key: string; items: Conversation[] }>();
    const record = (key: string, items: Conversation[]): void => {
      for (const item of items) map.set(item.id, { key, items });
    };
    record(sectionKey("pinned"), pinnedItems);
    for (const group of groups) record(group.key, group.items);
    record(sectionKey("recent"), recent);
    return map;
  }, [pinnedItems, groups, recent]);

  const collisionDetection = useCallback<CollisionDetection>(
    (args) => {
      const section = sections.get(String(args.active.id));
      if (!section) return closestCenter(args);
      const allowed = new Set(section.items.map((item) => item.id));
      return closestCenter({
        ...args,
        droppableContainers: args.droppableContainers.filter((container) => allowed.has(String(container.id))),
      });
    },
    [sections],
  );

  function handleDragStart(event: DragStartEvent): void {
    setActiveDragId(String(event.active.id));
  }

  function handleDragEnd(event: DragEndEvent): void {
    setActiveDragId(null);
    const { active, over } = event;
    if (!over || active.id === over.id) return;
    const section = sections.get(String(active.id));
    if (!section) return;
    const ids = section.items.map((item) => item.id);
    const from = ids.indexOf(String(active.id));
    const to = ids.indexOf(String(over.id));
    if (from < 0 || to < 0) return;
    // Persist only this section's list under its own key, so a drag inside one
    // project cannot disturb 置顶, 最近 or any other project.
    updateSettings({
      sidebarOrder: { ...(sidebarOrder ?? {}), [section.key]: arrayMove(ids, from, to) },
    });
  }

  const activeItem = activeDragId ? conversations.find((item) => item.id === activeDragId) ?? null : null;

  function renderSession(item: Conversation): JSX.Element {
    return (
      <SortableSession
        key={item.id}
        item={item}
        active={item.id === activeId}
        isPinned={pinned[item.id] !== undefined}
        showSpinner={running[item.id] === true}
        renamingThis={renaming?.type === "session" && renaming.id === item.id}
        onOpen={() => onOpen(item.id)}
        onTogglePin={() => togglePinned(item.id)}
        onArchive={() => archiveSession(item.id)}
        onStartRename={() => setRenaming({ type: "session", id: item.id })}
        onRename={(title) => {
          onRenameSession(item.id, title);
          setRenaming(null);
        }}
        onCancelRename={() => setRenaming(null)}
      />
    );
  }

  // Collapsed (dragged below the minimum width, or via the header toggle): the
  // sidebar clips to width 0 rather than shrinking to a sliver. The inner
  // aside keeps its expanded width so the spring is a clip, not a reflow.
  return (
    <CollapsiblePanel collapsed={sidebarCollapsed} width={width} side="left" instant={resizing}>
    <aside className="relative flex h-full min-h-0 w-full flex-col border-r border-sidebar-border bg-sidebar text-sidebar-foreground">
      <ResizeHandle
        side="right"
        onDragStart={() => {
          startWidth.current = width;
          collapsing.current = false;
          setResizing(true);
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
          setResizing(false);
          const next = startWidth.current + delta;
          if (next >= SIDEBAR_MIN_WIDTH) writeSidebarWidth(next);
        }}
      />
      <div
        className={cn(
          "drag-region flex h-11 shrink-0 items-center gap-0.5",
          IS_MAC ? "pl-22" : "pl-2",
        )}
      >
        <IconButton
          size="icon-sm"
          variant="ghost"
          className="no-drag text-muted-foreground"
          label="收起侧边栏"
          shortcut={toggleSidebarShortcut}
          onClick={() => updateSettings({ sidebarCollapsed: true })}
        >
          <HugeiconsIcon strokeWidth={2} icon={PanelLeftCloseIcon} />
        </IconButton>
        <IconButton
          size="icon-sm"
          variant="ghost"
          className="no-drag text-muted-foreground"
          label="后退"
          disabled={!canBack}
          onClick={back}
        >
          <HugeiconsIcon strokeWidth={2} icon={ArrowLeft01Icon} />
        </IconButton>
        <IconButton
          size="icon-sm"
          variant="ghost"
          className="no-drag text-muted-foreground"
          label="前进"
          disabled={!canForward}
          onClick={forward}
        >
          <HugeiconsIcon strokeWidth={2} icon={ArrowRight01Icon} />
        </IconButton>
      </div>

      <DndContext
        sensors={sensors}
        collisionDetection={collisionDetection}
        modifiers={[restrictToVerticalAxis]}
        onDragStart={handleDragStart}
        onDragEnd={handleDragEnd}
        onDragCancel={() => setActiveDragId(null)}
      >
        <div className="no-drag px-2">
          <div className="flex h-8 items-center justify-between">
            <div className="flex items-center gap-2 px-2">
              <AppLogo className="size-5 shrink-0 rounded-md" />
              <span className="text-sm font-semibold tracking-tight">FastVibe</span>
            </div>
            <div className="flex items-center gap-0.5">
              <IconButton
                size="icon-sm"
                variant="ghost"
                className="text-muted-foreground"
                label="搜索"
                shortcut={typeof navigator !== "undefined" && /mac/i.test(navigator.userAgent) ? "⌘K" : "Ctrl+K"}
                onClick={onSearch}
              >
                <HugeiconsIcon strokeWidth={2} icon={Search01Icon} />
              </IconButton>
            </div>
          </div>

          <div className="mt-1 space-y-0.5">
            <button
              type="button"
              className="flex h-8 w-full items-center gap-2.5 rounded-md px-2 text-sm hover:bg-sidebar-accent/50"
              onClick={() => onNewChat()}
            >
              <HugeiconsIcon strokeWidth={2} icon={MessageSquarePlusIcon} className="size-3.5 text-muted-foreground" />
              新对话
            </button>
            <button
              type="button"
              className="flex h-8 w-full items-center gap-2.5 rounded-md px-2 text-sm hover:bg-sidebar-accent/50"
              onClick={onOpenMarket}
            >
              <HugeiconsIcon strokeWidth={2} icon={PuzzleIcon} className="size-3.5 text-muted-foreground" />
              插件
            </button>
          </div>
        </div>

        <ScrollArea className="no-drag min-h-0 flex-1">
          <div className="px-2 pb-2">
            {pinnedItems.length > 0 ? (
              <>
                <SectionLabel>已置顶</SectionLabel>
                <SortableContext items={pinnedItems.map((item) => item.id)} strategy={verticalListSortingStrategy}>
                  <div className="space-y-0.5">{pinnedItems.map((item) => renderSession(item))}</div>
                </SortableContext>
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
              <p className="px-2 py-2 text-xs text-muted-foreground">还没有项目</p>
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
                            <CollapsibleTrigger className="flex min-w-0 flex-1 items-center gap-2.5 text-left text-sm">
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
                        <SortableContext items={group.items.map((item) => item.id)} strategy={verticalListSortingStrategy}>
                          <div className="space-y-0.5">
                            {group.items.length === 0 ? (
                              <p className="flex h-8 items-center gap-2.5 pl-2 text-xs text-muted-foreground">
                                <span className="size-3.5 shrink-0" />
                                暂无对话
                              </p>
                            ) : (
                              group.items.map((item) => renderSession(item))
                            )}
                          </div>
                        </SortableContext>
                      </CollapsibleContent>
                    </Collapsible>
                  );
                })}
              </div>
            )}

            {recent.length > 0 ? (
              <>
                <SectionLabel>最近</SectionLabel>
                <SortableContext items={recent.map((item) => item.id)} strategy={verticalListSortingStrategy}>
                  <div className="space-y-0.5">{recent.map((item) => renderSession(item))}</div>
                </SortableContext>
              </>
            ) : null}
          </div>
        </ScrollArea>
        <DragOverlay dropAnimation={DROP_ANIMATION}>
          {activeItem ? (
            <div style={{ width: width - 16 }}>
              <SessionRowContent
                overlay
                item={activeItem}
                active
                isPinned={pinned[activeItem.id] !== undefined}
                showSpinner={running[activeItem.id] === true}
                renamingThis={false}
                onOpen={() => undefined}
                onTogglePin={() => undefined}
                onArchive={() => undefined}
                onRename={() => undefined}
                onCancelRename={() => undefined}
              />
            </div>
          ) : null}
        </DragOverlay>
      </DndContext>

      <div className="no-drag p-2">
        <button
          type="button"
          className="flex h-8 w-full items-center gap-2.5 rounded-md px-2 text-sm hover:bg-sidebar-accent/50"
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
    </CollapsiblePanel>
  );
}
