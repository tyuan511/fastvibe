import { useMemo, useRef, useState, type JSX, type KeyboardEvent } from "react";
import {
  ChevronRight,
  Folder,
  FolderOpen,
  FolderPlus,
  MessageSquarePlus,
  MoreHorizontal,
  Pencil,
  Plus,
  Search,
  Settings,
  Trash2,
  X,
} from "lucide-react";
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
import { Spinner } from "@/components/ui/spinner";
import appIcon from "@/assets/app-icon.png";
import { cn } from "@/lib/utils";
import type { Conversation, Project } from "@shared/types";

const COLLAPSED_KEY = "fastvibe.sidebar.collapsed";

type RenameTarget = { type: "session"; id: string } | { type: "project"; cwd: string };
type DeleteTarget =
  | { type: "session"; id: string; title: string }
  | { type: "project"; cwd: string; title: string };

function readCollapsed(): Set<string> {
  try {
    const raw = localStorage.getItem(COLLAPSED_KEY);
    const parsed = raw ? (JSON.parse(raw) as unknown) : [];
    return new Set(Array.isArray(parsed) ? parsed.filter((item) => typeof item === "string") : []);
  } catch {
    return new Set();
  }
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

function SectionLabel({ children }: { children: React.ReactNode }): JSX.Element {
  return (
    <div className="px-2 pt-4 pb-1 text-[11px] font-medium tracking-wide text-muted-foreground">
      {children}
    </div>
  );
}

export function Sidebar({
  projects,
  conversations,
  activeId,
  streaming,
  onNewChat,
  onOpen,
  onAddProject,
  onRenameSession,
  onDeleteSession,
  onRenameProject,
  onRemoveProject,
  onRevealProject,
  onOpenSettings,
}: {
  projects: Project[];
  conversations: Conversation[];
  activeId: string | null;
  streaming: boolean;
  onNewChat: (cwd?: string) => void;
  onOpen: (id: string) => void;
  onAddProject: () => void;
  onRenameSession: (id: string, title: string) => void;
  onDeleteSession: (id: string) => void;
  onRenameProject: (cwd: string, name: string) => void;
  onRemoveProject: (cwd: string) => void;
  onRevealProject: (cwd: string) => void;
  onOpenSettings: () => void;
}): JSX.Element {
  const [query, setQuery] = useState("");
  const [searchOpen, setSearchOpen] = useState(false);
  const [collapsed, setCollapsed] = useState<Set<string>>(readCollapsed);
  const [renaming, setRenaming] = useState<RenameTarget | null>(null);
  const [pendingDelete, setPendingDelete] = useState<DeleteTarget | null>(null);

  function setOpen(cwd: string, open: boolean): void {
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (open) next.delete(cwd);
      else next.add(cwd);
      localStorage.setItem(COLLAPSED_KEY, JSON.stringify([...next]));
      return next;
    });
  }

  const q = query.trim().toLowerCase();

  const groups = useMemo(() => {
    const byProject = new Map<string, Conversation[]>();
    for (const item of conversations) {
      if (!item.project) continue;
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
        result.push({ cwd: project.cwd, name: project.name, items: filtered });
      }
    }
    return result;
  }, [conversations, projects, q]);

  // Conversations with no project live here so they stay reachable without a project group.
  const recent = useMemo(() => {
    return conversations
      .filter((item) => !item.project)
      .filter((item) =>
        !q ? true : `${item.title} ${item.preview ?? ""}`.toLowerCase().includes(q),
      );
  }, [conversations, q]);

  function renderSession(item: Conversation, indent: boolean): JSX.Element {
    const active = item.id === activeId;
    const renamingThis = renaming?.type === "session" && renaming.id === item.id;
    return (
      <ContextMenu key={item.id}>
        <ContextMenuTrigger className="w-full">
          <div
            className={cn(
              "group/session flex h-8 cursor-pointer items-center gap-2 rounded-md pr-1 text-[13px] transition-colors",
              indent ? "pl-7" : "pl-2",
              active ? "bg-sidebar-accent text-sidebar-accent-foreground" : "hover:bg-sidebar-accent/50",
            )}
            onClick={() => onOpen(item.id)}
          >
            {active && streaming ? <Spinner className="size-3.5 shrink-0" /> : null}
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
                <DropdownMenu>
                  <DropdownMenuTrigger
                    render={
                      <Button
                        size="icon-xs"
                        variant="ghost"
                        className="hidden shrink-0 group-hover/session:inline-flex"
                      />
                    }
                    onClick={(event) => event.stopPropagation()}
                    onPointerDown={(event) => event.stopPropagation()}
                  >
                    <MoreHorizontal />
                  </DropdownMenuTrigger>
                  <DropdownMenuContent align="end" className="w-32 min-w-32">
                    <DropdownMenuItem onClick={() => setRenaming({ type: "session", id: item.id })}>
                      <Pencil />
                      重命名
                    </DropdownMenuItem>
                    <DropdownMenuItem
                      variant="destructive"
                      onClick={() => setPendingDelete({ type: "session", id: item.id, title: item.title })}
                    >
                      <Trash2 />
                      删除
                    </DropdownMenuItem>
                  </DropdownMenuContent>
                </DropdownMenu>
              </>
            )}
          </div>
        </ContextMenuTrigger>
        <ContextMenuContent className="w-32">
          <ContextMenuItem onClick={() => setRenaming({ type: "session", id: item.id })}>重命名</ContextMenuItem>
          <ContextMenuItem
            variant="destructive"
            onClick={() => setPendingDelete({ type: "session", id: item.id, title: item.title })}
          >
            删除
          </ContextMenuItem>
        </ContextMenuContent>
      </ContextMenu>
    );
  }

  return (
    <aside className="flex w-64 shrink-0 flex-col border-r border-sidebar-border bg-sidebar text-sidebar-foreground">
      <div className="drag-region h-10" />

      <div className="no-drag px-2">
        <div className="flex h-8 items-center justify-between">
          <div className="flex items-center gap-2 px-2">
            <img src={appIcon} alt="" className="size-5 rounded-md" />
            <span className="text-[13px] font-semibold tracking-tight">FastVibe</span>
          </div>
          <div className="flex items-center gap-0.5">
            <Button
              size="icon-sm"
              variant="ghost"
              className="text-muted-foreground"
              onClick={() => {
                setSearchOpen((value) => !value);
                if (searchOpen) setQuery("");
              }}
              aria-label="搜索"
            >
              {searchOpen ? <X /> : <Search />}
            </Button>
            <Button
              size="icon-sm"
              variant="ghost"
              className="text-muted-foreground"
              onClick={() => onNewChat()}
              aria-label="新对话"
            >
              <MessageSquarePlus />
            </Button>
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
            <MessageSquarePlus className="size-4 text-muted-foreground" />
            新对话
          </button>
          <button
            type="button"
            className="flex h-8 w-full items-center gap-2.5 rounded-md px-2 text-[13px] hover:bg-sidebar-accent/50"
            onClick={onAddProject}
          >
            <FolderPlus className="size-4 text-muted-foreground" />
            打开项目
          </button>
        </div>
      </div>

      <ScrollArea className="no-drag min-h-0 flex-1">
        <div className="px-2 pb-2">
          <SectionLabel>项目</SectionLabel>
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
                            <ChevronRight
                              className={cn(
                                "size-3.5 shrink-0 text-muted-foreground transition-transform",
                                open && "rotate-90",
                              )}
                            />
                            {open ? (
                              <FolderOpen className="size-4 shrink-0 text-muted-foreground" />
                            ) : (
                              <Folder className="size-4 shrink-0 text-muted-foreground" />
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
                          <div className="flex shrink-0 items-center opacity-0 group-hover/project:opacity-100 focus-within:opacity-100">
                              <Button
                                size="icon-xs"
                                variant="ghost"
                                className="text-muted-foreground"
                                onClick={(event) => {
                                  event.stopPropagation();
                                  setOpen(group.cwd, true);
                                  onNewChat(group.cwd);
                                }}
                                aria-label="在该项目中新建"
                              >
                                <Plus />
                              </Button>
                              <DropdownMenu>
                                <DropdownMenuTrigger
                                  render={<Button size="icon-xs" variant="ghost" className="text-muted-foreground" />}
                                  onClick={(event) => event.stopPropagation()}
                                  onPointerDown={(event) => event.stopPropagation()}
                                >
                                  <MoreHorizontal />
                                </DropdownMenuTrigger>
                                <DropdownMenuContent align="end" className="w-40 min-w-40">
                                  <DropdownMenuItem onClick={() => onNewChat(group.cwd)}>
                                    <Plus />
                                    新建对话
                                  </DropdownMenuItem>
                                  <DropdownMenuItem onClick={() => setRenaming({ type: "project", cwd: group.cwd })}>
                                    <Pencil />
                                    重命名
                                  </DropdownMenuItem>
                                  <DropdownMenuItem onClick={() => onRevealProject(group.cwd)}>
                                    <FolderOpen />
                                    在访达中显示
                                  </DropdownMenuItem>
                                  <DropdownMenuSeparator />
                                  <DropdownMenuItem
                                    variant="destructive"
                                    onClick={() =>
                                      setPendingDelete({ type: "project", cwd: group.cwd, title: group.name })
                                    }
                                  >
                                    <Trash2 />
                                    从列表移除
                                  </DropdownMenuItem>
                                </DropdownMenuContent>
                              </DropdownMenu>
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
                          <p className="py-1 pl-7 text-[12px] text-muted-foreground">暂无对话</p>
                        ) : (
                          group.items.map((item) => renderSession(item, true))
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
              <div className="space-y-0.5">{recent.map((item) => renderSession(item, false))}</div>
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
          <Settings className="size-4 text-muted-foreground" />
          设置
        </button>
      </div>

      <AlertDialog open={pendingDelete !== null} onOpenChange={(open) => !open && setPendingDelete(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {pendingDelete?.type === "project" ? "从列表移除项目？" : "删除对话？"}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {pendingDelete?.type === "project"
                ? `「${pendingDelete.title}」下的对话会从列表中移除，不会删除磁盘上的项目文件。`
                : `「${pendingDelete?.title ?? ""}」将从列表中删除。`}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>取消</AlertDialogCancel>
            <AlertDialogAction
              variant="destructive"
              onClick={() => {
                if (!pendingDelete) return;
                if (pendingDelete.type === "project") onRemoveProject(pendingDelete.cwd);
                else onDeleteSession(pendingDelete.id);
                setPendingDelete(null);
              }}
            >
              {pendingDelete?.type === "project" ? "移除" : "删除"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </aside>
  );
}
