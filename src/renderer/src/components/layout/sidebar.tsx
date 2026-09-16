import { useCallback, useMemo, useRef, useState, type JSX, type KeyboardEvent } from "react";
import { createPortal } from "react-dom";
import { HugeiconsIcon } from "@hugeicons/react";
import { Add01Icon, Archive04Icon, ArrowLeft01Icon, ArrowRight01Icon, Delete02Icon, Folder01Icon, Folder02Icon, FolderRootIcon, MessageSquarePlusIcon, MoreHorizontalIcon, PanelLeftCloseIcon, PencilEdit02Icon, PinIcon, PuzzleIcon, Search01Icon, Settings01Icon } from "@hugeicons/core-free-icons";
import {
  DndContext,
  DragOverlay,
  PointerSensor,
  closestCenter,
  defaultDropAnimationSideEffects,
  useDraggable,
  useDroppable,
  useSensor,
  useSensors,
  type CollisionDetection,
  type DragEndEvent,
  type DragMoveEvent,
  type DragStartEvent,
  type DropAnimation,
} from "@dnd-kit/core";
import { restrictToVerticalAxis } from "@dnd-kit/modifiers";
import { arrayMove } from "@dnd-kit/sortable";
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
import { RunningMark } from "@/components/running-mark";
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
import { useArchivedIds } from "@/stores/archive";
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

/** Section key for the project list itself, as opposed to a project's chats. */
const PROJECTS_SECTION = "projects";

type RenameTarget = { type: "session"; id: string } | { type: "project"; cwd: string };
/** Only projects can be removed; sessions are archived, never deleted. */
type DeleteTarget = { type: "project"; cwd: string; title: string };

/** What the active drag is moving: the row id and the list it belongs to. */
type ActiveDrag = { id: string; section: DragSection };

/** Settle animation for the floating row when the drop lands. */
const DROP_ANIMATION: DropAnimation = {
  duration: 200,
  easing: "cubic-bezier(0.2, 0, 0, 1)",
  sideEffects: defaultDropAnimationSideEffects({ styles: { active: { opacity: "0" } } }),
};

/** A reorderable list: its section key and the row ids in display order. */
type DragSection = { key: string; ids: string[] };
/**
 * Where the active drag would land: the section it would join and the insert index
 * (0..n) within it, plus the target row's viewport rect so the line can be painted
 * above the drag overlay. Dragging never moves rows live — the source row just fades
 * and a primary line marks the position.
 */
type DropRect = { top: number; bottom: number; left: number; width: number };
type DropIndicator = { key: string; index: number; edge: "above" | "below"; rect: DropRect };

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
 * The primary insertion line. It is a fixed-position portal painted above the drag
 * overlay (`zIndex` 999), so the floating row can never cover the line it aims at.
 */
function DropLine({ rect, edge }: { rect: DropRect; edge: "above" | "below" }): JSX.Element {
  const top = edge === "above" ? rect.top : rect.bottom;
  return createPortal(
    <div
      aria-hidden
      className="pointer-events-none fixed z-[1000] h-0.5 rounded-full bg-primary"
      style={{ top: top - 1, left: rect.left + 4, width: Math.max(0, rect.width - 8) }}
    />,
    document.body,
  );
}

/**
 * One draggable project. The listeners sit on the header row only — the sessions
 * inside are draggable too, and spreading them on the wrapper would start a project
 * drag from every session pointerdown. The header row is also the droppable, so a
 * drop targets another project's header rather than its whole (tall) expanded group.
 */
function DraggableProject({
  cwd,
  name,
  open,
  renaming,
  onOpenChange,
  onNewChat,
  onStartRename,
  onRename,
  onCancelRename,
  onReveal,
  onRemove,
  children,
}: {
  cwd: string;
  name: string;
  open: boolean;
  renaming: boolean;
  onOpenChange: (open: boolean) => void;
  onNewChat: () => void;
  onStartRename: () => void;
  onRename: (name: string) => void;
  onCancelRename: () => void;
  onReveal: () => void;
  onRemove: () => void;
  children: React.ReactNode;
}): JSX.Element {
  const { listeners, setNodeRef: setDraggableRef, setActivatorNodeRef, isDragging } = useDraggable({ id: cwd });
  const { setNodeRef: setDroppableRef } = useDroppable({ id: cwd });
  return (
    <div className="relative">
      <Collapsible open={open} onOpenChange={onOpenChange}>
        <ContextMenu>
          <ContextMenuTrigger className="w-full">
            {/* Both refs sit on the header row: the droppable so the above/below
                midpoint tracks a 32px row, and the draggable so the active rect used
                for that midpoint is the header rather than the whole expanded group. */}
            <div
              ref={(node) => {
                setDraggableRef(node);
                setDroppableRef(node);
                setActivatorNodeRef(node);
              }}
              className={cn(
                "group/project flex h-8 touch-pan-y items-center gap-0.5 rounded-md pr-1 pl-2 transition-opacity hover:bg-sidebar-accent/50",
                isDragging && "opacity-40",
              )}
              {...listeners}
            >
              <CollapsibleTrigger className="flex min-w-0 flex-1 items-center gap-2.5 text-left text-sm">
                <HugeiconsIcon
                  strokeWidth={2}
                  icon={open ? Folder02Icon : Folder01Icon}
                  className="size-3.5 shrink-0 text-muted-foreground"
                />
                {renaming ? (
                  <InlineRename value={name} onSubmit={onRename} onCancel={onCancelRename} />
                ) : (
                  <span className="truncate">{name}</span>
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
                    <DropdownMenuItem onClick={onNewChat}>
                      <HugeiconsIcon strokeWidth={2} icon={Add01Icon} />
                      新建对话
                    </DropdownMenuItem>
                    <DropdownMenuItem onClick={onStartRename}>
                      <HugeiconsIcon strokeWidth={2} icon={PencilEdit02Icon} />
                      重命名
                    </DropdownMenuItem>
                    <DropdownMenuItem onClick={onReveal}>
                      <HugeiconsIcon strokeWidth={2} icon={FolderRootIcon} />
                      在访达中显示
                    </DropdownMenuItem>
                    <DropdownMenuSeparator />
                    <DropdownMenuItem variant="destructive" onClick={onRemove}>
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
                    onOpenChange(true);
                    onNewChat();
                  }}
                >
                  <HugeiconsIcon strokeWidth={2} icon={PencilEdit02Icon} className="size-3.5" />
                </IconButton>
              </div>
            </div>
          </ContextMenuTrigger>
          <ContextMenuContent className="w-40">
            <ContextMenuItem onClick={onNewChat}>新建对话</ContextMenuItem>
            <ContextMenuItem onClick={onStartRename}>重命名</ContextMenuItem>
            <ContextMenuItem onClick={onReveal}>在访达中显示</ContextMenuItem>
            <ContextMenuSeparator />
            <ContextMenuItem variant="destructive" onClick={onRemove}>
              从列表移除
            </ContextMenuItem>
          </ContextMenuContent>
        </ContextMenu>
        <CollapsibleContent>{children}</CollapsibleContent>
      </Collapsible>
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

/** The visual body of one conversation row. */
function SessionRowContent({
  item,
  active,
  isPinned,
  showSpinner,
  renamingThis,
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
      )}
      onClick={onOpen}
    >
      {/* Leading slot: the busy mark while running, otherwise an empty spacer of the
          same width so session titles stay aligned with project names. */}
      <span className="flex size-3.5 shrink-0 items-center justify-center">
        {showSpinner ? <RunningMark /> : null}
      </span>
      {renamingThis ? (
        <InlineRename value={item.title} onSubmit={onRename} onCancel={onCancelRename} />
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
        </>
      )}
    </div>
  );
}

/**
 * The floating copy of a conversation that follows the pointer while dragging. It is
 * chrome-only (no interactions) and carries the app's elevation so the row reads as
 * "picked up" rather than as part of the list.
 */
function LiftedSessionRow({ item, width }: { item: Conversation; width: number }): JSX.Element {
  return (
    <div style={{ width }} className="bg-sidebar">
      <div className="flex h-8 cursor-grabbing items-center gap-2.5 rounded-md border border-sidebar-border bg-sidebar-accent px-2 text-sm text-sidebar-accent-foreground shadow-lg">
        <span className="min-w-0 flex-1 truncate">{item.title}</span>
      </div>
    </div>
  );
}

/** The floating copy of a project header that follows the pointer while dragging. */
function LiftedProjectRow({ name, width }: { name: string; width: number }): JSX.Element {
  return (
    <div style={{ width }} className="bg-sidebar">
      <div className="flex h-8 cursor-grabbing items-center gap-2.5 rounded-md border border-sidebar-border bg-sidebar-accent px-2 text-sm text-sidebar-accent-foreground shadow-lg">
        <HugeiconsIcon strokeWidth={2} icon={Folder01Icon} className="size-3.5 shrink-0 text-muted-foreground" />
        <span className="min-w-0 flex-1 truncate">{name}</span>
      </div>
    </div>
  );
}

/**
 * One draggable conversation. Nothing moves live: the row fades out while it is in
 * flight and a drop line marks where it will land (see `DropLine`).
 */
function DraggableSession({
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
  const { listeners, setNodeRef, isDragging } = useDraggable({ id: item.id });
  const { setNodeRef: setDroppableRef } = useDroppable({ id: item.id });
  return (
    // pan-y lets a touchscreen scroll the list; mouse drag is unaffected (the
    // PointerSensor only needs `touch-action` for touch pointers).
    <div
      ref={(node) => {
        setNodeRef(node);
        setDroppableRef(node);
      }}
      {...listeners}
      className="relative touch-pan-y"
    >
      <div className={cn("transition-opacity", isDragging && "opacity-40")}>
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
  onArchive,
  onAddProject,
  onRenameSession,
  onRenameProject,
  onRemoveProject,
  onRevealProject,
  onReorderProjects,
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
  /** Hides the chat from every list; the shell also closes it when it is on screen. */
  onArchive: (id: string) => void;
  onAddProject: () => void;
  onRenameSession: (id: string, title: string) => void;
  onRenameProject: (cwd: string, name: string) => void;
  onRemoveProject: (cwd: string) => void;
  onRevealProject: (cwd: string) => void;
  /** Persists a drag-reordered project list; the catalog owns the order. */
  onReorderProjects: (cwds: string[]) => void;
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
  const [drop, setDrop] = useState<DropIndicator | null>(null);
  const [drag, setDrag] = useState<ActiveDrag | null>(null);
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

  // Maps every draggable row to the section it lives in, so a drag can only ever
  // reorder within its own list. Projects are one list of their own, under `projects`.
  const sections = useMemo(() => {
    const map = new Map<string, DragSection>();
    const record = (key: string, ids: string[]): void => {
      const section: DragSection = { key, ids };
      for (const id of ids) map.set(id, section);
    };
    record(sectionKey("pinned"), pinnedItems.map((item) => item.id));
    for (const group of groups) record(group.key, group.items.map((item) => item.id));
    record(sectionKey("recent"), recent.map((item) => item.id));
    record(PROJECTS_SECTION, groups.map((group) => group.cwd));
    return map;
  }, [pinnedItems, groups, recent]);

  // Rows are the droppables; a drag only considers the rows of its own section, so
  // the insertion line can never appear in another list. `closestCenter` over the
  // rows' own rects keeps the target stable as the pointer moves.
  const collisionDetection = useCallback<CollisionDetection>(
    (args) => {
      const section = sections.get(String(args.active.id));
      if (!section) return [];
      const allowed = new Set(section.ids);
      return closestCenter({
        ...args,
        droppableContainers: args.droppableContainers.filter((container) => allowed.has(String(container.id))),
      });
    },
    [sections],
  );

  function handleDragStart(event: DragStartEvent): void {
    const section = sections.get(String(event.active.id));
    if (!section) return;
    setDrag({ id: String(event.active.id), section });
    setDrop(null);
  }

  /** Turn the row under the pointer into an insert position. The dragged row's centre
   *  compared to the target row's centre decides whether the line sits above or below,
   *  so the index is expressed in the current (unmoving) list. A position that would
   *  leave the list unchanged (the dragged row's own slot, above or below) is not a
   *  real drop, so it reports no indicator and draws no line.
   */
  function indicatorFor(event: DragMoveEvent | DragEndEvent): DropIndicator | null {
    const section = sections.get(String(event.active.id));
    if (!section || !event.over) return null;
    const overIndex = section.ids.indexOf(String(event.over.id));
    if (overIndex < 0) return null;
    const overRect = event.over.rect;
    const activeRect = event.active.rect.current.translated;
    const activeMiddle = activeRect ? activeRect.top + activeRect.height / 2 : overRect.top;
    const below = activeMiddle > overRect.top + overRect.height / 2;
    const index = below ? overIndex + 1 : overIndex;
    const from = section.ids.indexOf(String(event.active.id));
    // `index === from` is just above the source and `index === from + 1` just below
    // it; both resolve back to the same slot, so the drag would be a no-op.
    if (from >= 0 && (index === from || index === from + 1)) return null;
    return {
      key: section.key,
      index,
      edge: below ? "below" : "above",
      rect: { top: overRect.top, bottom: overRect.bottom, left: overRect.left, width: overRect.width },
    };
  }

  function handleDragEnd(event: DragEndEvent): void {
    const indicator = indicatorFor(event);
    setDrag(null);
    setDrop(null);
    if (!indicator) return;
    const section = sections.get(String(event.active.id));
    if (!section) return;
    const from = section.ids.indexOf(String(event.active.id));
    if (from < 0) return;
    // The indicator counts insert positions in the current list, so dropping below
    // the source itself shifts by one once the source is lifted out.
    const to = indicator.index > from ? indicator.index - 1 : indicator.index;
    if (to === from) return;
    const next = arrayMove(section.ids, from, to);
    // Projects are persisted in the catalog; every conversation section keeps its
    // order under its own `sidebarOrder` key, so a drag inside one list cannot
    // disturb 置顶, 最近 or any other project.
    if (section.key === PROJECTS_SECTION) onReorderProjects(next);
    else updateSettings({ sidebarOrder: { ...(sidebarOrder ?? {}), [section.key]: next } });
  }

  function renderSession(item: Conversation): JSX.Element {
    return (
      <DraggableSession
        key={item.id}
        item={item}
        active={item.id === activeId}
        isPinned={pinned[item.id] !== undefined}
        showSpinner={running[item.id] === true}
        renamingThis={renaming?.type === "session" && renaming.id === item.id}
        onOpen={() => onOpen(item.id)}
        onTogglePin={() => togglePinned(item.id)}
        onArchive={() => onArchive(item.id)}
        onStartRename={() => setRenaming({ type: "session", id: item.id })}
        onRename={(title) => {
          onRenameSession(item.id, title);
          setRenaming(null);
        }}
        onCancelRename={() => setRenaming(null)}
      />
    );
  }

  function renderSessionList(items: Conversation[]): JSX.Element {
    return <div className="space-y-0.5">{items.map((item) => renderSession(item))}</div>;
  }

  const dragSection = drag?.section ?? null;
  const draggingItem = dragSection && drag ? conversations.find((item) => item.id === drag.id) ?? null : null;
  const draggingProject = dragSection?.key === PROJECTS_SECTION && drag ? groups.find((group) => group.cwd === drag.id) ?? null : null;

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
        onDragMove={(event) => setDrop(indicatorFor(event))}
        onDragEnd={handleDragEnd}
        onDragCancel={() => {
          setDrag(null);
          setDrop(null);
        }}
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
                {renderSessionList(pinnedItems)}
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
                {groups.map((group, index) => {
                  const open = !collapsed.has(group.cwd);
                  const renamingProject = renaming?.type === "project" && renaming.cwd === group.cwd;
                  return (
                    <DraggableProject
                      key={group.cwd}
                      cwd={group.cwd}
                      name={group.name}
                      open={open}
                      renaming={renamingProject}
                      onOpenChange={(next) => setOpen(group.cwd, next)}
                      onNewChat={() => onNewChat(group.cwd)}
                      onStartRename={() => setRenaming({ type: "project", cwd: group.cwd })}
                      onRename={(next) => {
                        onRenameProject(group.cwd, next);
                        setRenaming(null);
                      }}
                      onCancelRename={() => setRenaming(null)}
                      onReveal={() => onRevealProject(group.cwd)}
                      onRemove={() => setPendingDelete({ type: "project", cwd: group.cwd, title: group.name })}
                    >
                      {group.items.length === 0 ? (
                        <p className="flex h-8 items-center gap-2.5 pl-2 text-xs text-muted-foreground">
                          <span className="size-3.5 shrink-0" />
                          暂无对话
                        </p>
                      ) : (
                        renderSessionList(group.items)
                      )}
                    </DraggableProject>
                  );
                })}
              </div>
            )}

            {recent.length > 0 ? (
              <>
                <SectionLabel>最近</SectionLabel>
                {renderSessionList(recent)}
              </>
            ) : null}
          </div>
        </ScrollArea>
        {drop ? <DropLine rect={drop.rect} edge={drop.edge} /> : null}
        <DragOverlay dropAnimation={DROP_ANIMATION}>
          {draggingProject ? (
            <LiftedProjectRow name={draggingProject.name} width={width - 16} />
          ) : draggingItem ? (
            <LiftedSessionRow item={draggingItem} width={width - 16} />
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
