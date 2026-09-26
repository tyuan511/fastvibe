import { memo, useCallback, useMemo, useRef, useState, type JSX, type KeyboardEvent } from "react";
import { useTranslation } from "react-i18next";
import { createPortal } from "react-dom";
import { toast } from "sonner";
import { HugeiconsIcon } from "@hugeicons/react";
import { Add01Icon, Alert02Icon, AlertCircleIcon, Archive04Icon, ArrowLeft01Icon, ArrowRight01Icon, Delete02Icon, Folder01Icon, Folder02Icon, FolderRootIcon, Link01Icon, Loading03Icon, MessageSquarePlusIcon, MoreHorizontalIcon, PanelLeftCloseIcon, PencilEdit02Icon, PinIcon, PuzzleIcon, Search01Icon, Settings01Icon } from "@hugeicons/core-free-icons";
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
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import { bindingStateKey, displayRemotePath, isRemoteProject, remoteProjectActivityKey } from "@/lib/remote-project";
import type { RemoteHostConnectionState } from "@shared/remote-host";
import type { Conversation, Project } from "@shared/types";

export const COLLAPSED_KEY = "fastvibe.sidebar.collapsed";
const PINNED_KEY = "fastvibe.sidebar.pinned";
/** Default visible chats under each project; the rest sit behind 展开显示. */
export const PROJECT_SESSION_LIMIT = 5;

/** Section key for the project list itself, as opposed to a project's chats. */
export const PROJECTS_SECTION = "projects";

/** Gap between the sidebar's edge and the project path hint it hosts. */
const PATH_HINT_GAP = 8;

export type RenameTarget = { type: "session"; id: string } | { type: "project"; cwd: string };
/** Only projects can be removed; sessions are archived, never deleted. */
export type DeleteTarget = { type: "project"; cwd: string; title: string };

/** What the active drag is moving: the row id and the list it belongs to. */
export type ActiveDrag = { id: string; section: DragSection };

/** Settle animation for the floating row when the drop lands. */
export const DROP_ANIMATION: DropAnimation = {
  duration: 200,
  easing: "cubic-bezier(0.2, 0, 0, 1)",
  sideEffects: defaultDropAnimationSideEffects({ styles: { active: { opacity: "0" } } }),
};

/** A reorderable list: its section key and the row ids in display order. */
export type DragSection = { key: string; ids: string[] };
/**
 * Where the active drag would land: the section it would join and the insert index
 * (0..n) within it, plus the target row's viewport rect so the line can be painted
 * above the drag overlay. Dragging never moves rows live — the source row just fades
 * and a primary line marks the position.
 */
export type DropRect = { top: number; bottom: number; left: number; width: number };
export type DropIndicator = { key: string; index: number; edge: "above" | "below"; rect: DropRect };

export function readIdSet(key: string): Set<string> {
  try {
    const raw = localStorage.getItem(key);
    const parsed = raw ? (JSON.parse(raw) as unknown) : [];
    return new Set(Array.isArray(parsed) ? parsed.filter((item) => typeof item === "string") : []);
  } catch {
    return new Set();
  }
}


/**
 * Pins are stored as `id -> pinnedAt` so the "已置顶" list can be ordered by pin
 * time. Earlier builds stored a plain id array; keep reading that shape.
 */
export function readPinned(): Record<string, number> {
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

export function persistPinned(value: Record<string, number>): void {
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

export function SectionLabel({
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
export function DropLine({ rect, edge }: { rect: DropRect; edge: "above" | "below" }): JSX.Element {
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
export function DraggableProject({
  project,
  open,
  renaming,
  connectionState,
  onOpenChange,
  onNewChat,
  onStartRename,
  onRename,
  onCancelRename,
  onReveal,
  onRemove,
  children,
}: {
  project: Project;
  open: boolean;
  renaming: boolean;
  connectionState?: RemoteHostConnectionState;
  onOpenChange: (open: boolean) => void;
  onNewChat: () => void;
  onStartRename: () => void;
  onRename: (name: string) => void;
  onCancelRename: () => void;
  onReveal: () => void;
  onRemove: () => void;
  children: React.ReactNode;
}): JSX.Element {
  const cwd = project.cwd;
  const name = project.name;
  const remote = isRemoteProject(project);
  const pathHint = project.remotePath || (remote ? displayRemotePath(cwd) : cwd);
  const bindingKey = bindingStateKey(project.bindingState);
  const activityKey = remoteProjectActivityKey(connectionState);
  const { t } = useTranslation("app");
  const { attributes, listeners, setNodeRef: setDraggableRef, setActivatorNodeRef, isDragging } = useDraggable({ id: cwd });
  const { setNodeRef: setDroppableRef } = useDroppable({ id: cwd });
  /**
   * The path hint has to clear the sidebar, not its trigger: the name's right edge
   * sits a run of hover actions inside the sidebar's, so anchoring the popup there
   * paints it back over the session list it is meant to sit beside. The trigger is
   * measured as it opens and the distance to the sidebar's edge becomes the side
   * offset, so the hint lands just past the border at any width and font size.
   */
  const pathTriggerRef = useRef<HTMLElement | null>(null);
  const [pathOffset, setPathOffset] = useState(PATH_HINT_GAP);

  function measurePathOffset(): void {
    const trigger = pathTriggerRef.current;
    // The sidebar's own edge is what the hint has to clear, so measure that rather
    // than the trigger it happens to hang off.
    const aside = trigger?.closest("aside");
    if (!trigger || !aside) return;
    setPathOffset(Math.round(aside.getBoundingClientRect().right + PATH_HINT_GAP - trigger.getBoundingClientRect().right));
  }

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
                "group/project flex h-8 pointer-coarse:h-10 touch-pan-y items-center gap-0.5 rounded-md pr-1 pl-2 transition-opacity hover:bg-sidebar-accent/50",
                isDragging && "opacity-40",
              )}
              {...attributes}
              {...listeners}
            >
              {/* The name is truncated to the sidebar width, so the header doubles
                  as the project's full path on hover. Skipped while renaming — a
                  tooltip over the inline input would cover what is being typed. */}
              <Tooltip onOpenChange={(next) => next && measurePathOffset()}>
                <TooltipTrigger
                  render={
                    <CollapsibleTrigger
                      ref={(node) => {
                        pathTriggerRef.current = node;
                      }}
                      className="flex min-w-0 flex-1 items-center gap-2.5 text-left text-sm"
                    />
                  }
                >
                  <HugeiconsIcon
                    strokeWidth={2}
                    icon={remote ? Link01Icon : open ? Folder02Icon : Folder01Icon}
                    className="size-3.5 shrink-0 text-muted-foreground"
                  />
                  {renaming ? (
                    <InlineRename value={name} onSubmit={onRename} onCancel={onCancelRename} />
                  ) : (
                    <span className="truncate">{name}</span>
                  )}
                  {remote && !renaming ? (
                    <span
                      className={cn(
                        "inline-flex shrink-0 items-center gap-1 rounded-full px-1.5 py-0.5 text-xs",
                        project.bindingState === "connecting"
                          ? "bg-primary/10 text-primary"
                          : project.bindingState === "available"
                            ? "text-muted-foreground"
                            : "bg-warning/10 text-warning",
                      )}
                      title={activityKey ? t(`sidebar.binding.${activityKey}`) : undefined}
                    >
                      {project.bindingState === "connecting" ? <HugeiconsIcon strokeWidth={2} icon={Loading03Icon} className="size-3 animate-spin" /> : null}
                      {project.bindingState && project.bindingState !== "available"
                        ? activityKey
                          ? t(`sidebar.binding.${activityKey}`)
                          : t(`sidebar.binding.${bindingKey}`)
                        : t("sidebar.remote")}
                    </span>
                  ) : null}
                </TooltipTrigger>
                {renaming ? null : (
                  <TooltipContent side="right" align="center" sideOffset={pathOffset} className="max-w-96">
                    <span className="font-mono break-all">{pathHint}</span>
                    {remote && project.bindingState && project.bindingState !== "available" ? (
                      <span className="mt-1 block text-xs text-muted-foreground">
                        {activityKey ? t(`sidebar.binding.${activityKey}`) : t(`sidebar.binding.${bindingKey}`)}
                      </span>
                    ) : null}
                  </TooltipContent>
                )}
              </Tooltip>
              {/* A touchscreen has no hover to reveal these, and an invisible button is still
                  a tappable one: a tap near the row's right edge used to create a chat or
                  open the menu from nothing on screen. So there they simply show. */}
              <div className="flex shrink-0 items-center gap-0.5 opacity-0 group-hover/project:opacity-100 focus-within:opacity-100 has-[[aria-expanded=true]]:opacity-100 pointer-coarse:opacity-100">
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
                      {t("sidebar.newChat")}
                    </DropdownMenuItem>
                    <DropdownMenuItem onClick={onStartRename}>
                      <HugeiconsIcon strokeWidth={2} icon={PencilEdit02Icon} />
                      {t("sidebar.rename")}
                    </DropdownMenuItem>
                    {remote ? null : (
                      <DropdownMenuItem onClick={onReveal}>
                        <HugeiconsIcon strokeWidth={2} icon={FolderRootIcon} />
                        {t("sidebar.reveal")}
                      </DropdownMenuItem>
                    )}
                    <DropdownMenuSeparator />
                    <DropdownMenuItem variant="destructive" onClick={onRemove}>
                      <HugeiconsIcon strokeWidth={2} icon={Delete02Icon} />
                      {t("sidebar.remove")}
                    </DropdownMenuItem>
                  </DropdownMenuContent>
                </DropdownMenu>
                <IconButton
                  size="icon-xs"
                  variant="ghost"
                  className="text-muted-foreground"
                  label={t("sidebar.newSession")}
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
            <ContextMenuItem onClick={onNewChat}>{t("sidebar.newChat")}</ContextMenuItem>
            <ContextMenuItem onClick={onStartRename}>{t("sidebar.rename")}</ContextMenuItem>
            {remote ? null : <ContextMenuItem onClick={onReveal}>{t("sidebar.reveal")}</ContextMenuItem>}
            <ContextMenuSeparator />
            <ContextMenuItem variant="destructive" onClick={onRemove}>
              {t("sidebar.remove")}
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
export function applyManualOrder(items: Conversation[], order: string[] | undefined): Conversation[] {
  if (!order || order.length === 0) return items;
  const rank = new Map<string, number>();
  order.forEach((id, index) => rank.set(id, index));
  const ranked = items.filter((item) => rank.has(item.id)).sort((a, b) => rank.get(a.id)! - rank.get(b.id)!);
  const unranked = items.filter((item) => !rank.has(item.id));
  return unranked.length > 0 ? [...unranked, ...ranked] : ranked;
}

/** Section keys under `settings.sidebarOrder`; project lists are scoped by cwd. */
export function sectionKey(kind: "pinned" | "recent"): string;
export function sectionKey(kind: "project", cwd: string): string;
export function sectionKey(kind: "pinned" | "recent" | "project", cwd?: string): string {
  return kind === "project" ? `project:${cwd ?? ""}` : kind;
}

/** The visual body of one conversation row. */
function SessionRowContent({
  item,
  active,
  isPinned,
  showSpinner,
  waiting,
  failed = false,
  renamingThis,
  leadSlot = true,
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
  /** A blocking prompt is parked on this chat: it needs the user before it can go on. */
  waiting: boolean;
  /** Its run ended abnormally while another chat was on screen (`failedInBackground`). */
  failed?: boolean;
  renamingThis: boolean;
  /** Reserve the folder-icon column so titles line up with project names. Off for 聊天. */
  leadSlot?: boolean;
  onOpen: () => void;
  onTogglePin: () => void;
  onArchive: () => void;
  onRename: (title: string) => void;
  onCancelRename: () => void;
}): JSX.Element {
  const { t } = useTranslation("app");
  return (
    <div
      className={cn(
        "group/session flex h-8 pointer-coarse:h-10 cursor-pointer items-center gap-2.5 rounded-md pr-1 pl-2 text-sm transition-colors",
        active ? "bg-sidebar-accent text-sidebar-accent-foreground" : "hover:bg-sidebar-accent/50",
      )}
      onClick={onOpen}
    >
      {/* Project chats keep an empty folder-icon column so titles line up with
          the group name. 聊天 has no parent icon, so titles sit flush left. */}
      {leadSlot ? <span className="size-3.5 shrink-0" /> : null}
      {renamingThis ? (
        <InlineRename value={item.title} onSubmit={onRename} onCancel={onCancelRename} />
      ) : (
        <>
          {/* The title spans whatever the trailing slot leaves. Idle the slot collapses
              to nothing and the title takes the whole row; the busy mark stands in the
              last action button's place (each is the last flex child, so both sit flush
              against the row's padding and share one centre) and the hover actions
              replace it rather than stack after it. The actions are also the keyboard
              route; the context menu behind the row is the pointer one. */}
          <span className="min-w-0 flex-1 truncate">{item.title}</span>
          <div className="flex shrink-0 items-center gap-0.5">
            {/* 等你 outranks 运行中: a chat parked on a prompt is technically still
                running, but the reason it is running is the user, and that is the one
                thing the row has to say. Stop lives on the composer; archiving a busy
                chat aborts it. */}
            {waiting ? (
              <span
                className="flex size-6 items-center justify-center text-warning group-hover/session:hidden group-focus-within/session:hidden"
                title={t("sidebar.waitingForYou")}
              >
                <HugeiconsIcon strokeWidth={2} icon={Alert02Icon} className="size-3.5" />
              </span>
            ) : showSpinner ? (
              <span className="flex size-6 items-center justify-center group-hover/session:hidden group-focus-within/session:hidden">
                <RunningMark />
              </span>
            ) : failed ? (
              <span
                className="flex size-6 items-center justify-center text-destructive group-hover/session:hidden group-focus-within/session:hidden"
                title={t("sidebar.stoppedAbnormally")}
              >
                <HugeiconsIcon strokeWidth={2} icon={AlertCircleIcon} className="size-3.5" />
              </span>
            ) : null}
            <div className="hidden items-center gap-0.5 group-hover/session:flex group-focus-within/session:flex">
              <IconButton
                size="icon-xs"
                variant="ghost"
                className="text-muted-foreground"
                label={isPinned ? t("sidebar.unpin") : t("sidebar.pin")}
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
                label={t("sidebar.archive")}
                onClick={(event) => {
                  event.stopPropagation();
                  onArchive();
                }}
                onPointerDown={(event) => event.stopPropagation()}
              >
                <HugeiconsIcon strokeWidth={2} icon={Archive04Icon} className="size-3.5" />
              </IconButton>
            </div>
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
export function LiftedSessionRow({ item, width }: { item: Conversation; width: number }): JSX.Element {
  return (
    <div style={{ width }} className="bg-sidebar">
      <div className="flex h-8 cursor-grabbing items-center gap-2.5 rounded-md border border-sidebar-border bg-sidebar-accent px-2 text-sm text-sidebar-accent-foreground shadow-lg">
        <span className="min-w-0 flex-1 truncate">{item.title}</span>
      </div>
    </div>
  );
}

/** The floating copy of a project header that follows the pointer while dragging. */
export function LiftedProjectRow({ name, width }: { name: string; width: number }): JSX.Element {
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
export function DraggableSession({
  item,
  active,
  isPinned,
  showSpinner,
  waiting,
  failed = false,
  renamingThis,
  leadSlot,
  onOpen,
  onTogglePin,
  onFork,
  onArchive,
  onStartRename,
  onRename,
  onCancelRename,
}: {
  item: Conversation;
  active: boolean;
  isPinned: boolean;
  showSpinner: boolean;
  /** A blocking prompt is parked on this chat: it needs the user before it can go on. */
  waiting: boolean;
  /** Its run ended abnormally while another chat was on screen (`failedInBackground`). */
  failed?: boolean;
  renamingThis: boolean;
  leadSlot?: boolean;
  onOpen: () => void;
  onTogglePin: () => void;
  onFork: () => void;
  onArchive: () => void;
  onStartRename: () => void;
  onRename: (title: string) => void;
  onCancelRename: () => void;
}): JSX.Element {
  const { t } = useTranslation("app");
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
            waiting={waiting}
            failed={failed}
            renamingThis={renamingThis}
            leadSlot={leadSlot}
            onOpen={onOpen}
            onTogglePin={onTogglePin}
            onArchive={onArchive}
            onRename={onRename}
            onCancelRename={onCancelRename}
          />
        </ContextMenuTrigger>
        <ContextMenuContent className="w-32">
          <ContextMenuItem onClick={onTogglePin}>{isPinned ? t("sidebar.unpin") : t("sidebar.pin")}</ContextMenuItem>
          <ContextMenuItem onClick={onStartRename}>{t("sidebar.rename")}</ContextMenuItem>
          <ContextMenuItem onClick={onFork}>{t("sidebar.fork")}</ContextMenuItem>
          <ContextMenuItem
            onClick={() => {
              if (!navigator.clipboard) {
                toast.error(t("sidebar.copyIdFailed"));
                return;
              }
              void navigator.clipboard
                .writeText(item.id)
                .then(() => toast.success(t("sidebar.copiedId")))
                .catch(() => toast.error(t("sidebar.copyIdFailed")));
            }}
          >
            {t("sidebar.copyId")}
          </ContextMenuItem>
          <ContextMenuSeparator />
          <ContextMenuItem onClick={onArchive}>{t("sidebar.archive")}</ContextMenuItem>
        </ContextMenuContent>
      </ContextMenu>
      </div>
    </div>
  );
}

/**
 * The chat list, held still while the shell around it re-renders.
 *
 * Memoised because it is the biggest subtree in the window that has nothing to do
 * with a conversation's progress: every project and every chat is a row, and each one
 * carries a drag-and-drop hook. It used to be rebuilt for every render of `App` —
 * which, before the composer's draft moved out of the shell, meant on every keystroke.
 * Its callback props are stabilised by the caller (`useStable`), so the default
 * shallow comparison is enough.
 */
