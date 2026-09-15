import { useEffect, useMemo, useState, type JSX } from "react";
import { HugeiconsIcon } from "@hugeicons/react";
import { Folder01Icon, MessageSquarePlusIcon, PuzzleIcon, Settings01Icon } from "@hugeicons/core-free-icons";
import {
  Command,
  CommandDialog,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
  CommandShortcut,
} from "@/components/ui/command";
import { Kbd } from "@/components/ui/kbd";
import { SETTINGS_SECTIONS, type SectionId } from "@/components/settings/settings-dialog";
import { useArchivedIds } from "@/stores/archive";
import { useShortcutLabel } from "@/lib/use-shortcuts";
import type { Conversation, ConversationSearchHit, Project } from "@shared/types";

const IS_MAC = typeof navigator !== "undefined" && /mac/i.test(navigator.userAgent);
const MOD = IS_MAC ? "⌘" : "Ctrl+";

const SETTING_KEYWORDS: Record<SectionId, string> = {
  // The 对话 pane was folded into 通用, so its keywords live here now.
  general: "外观 主题 字号 界面 发送 思考 队列 时间戳 打断",
  shortcuts: "键盘 热键 keymap",
  archived: "恢复 删除",
  usage: "token 费用 统计",
  providers: "供应商 api 密钥 模型",
  mcp: "工具",
  skills: "skill",
  extensions: "扩展 市场",
  about: "版本",
};

type ActionId = "new" | "folder" | "settings" | "extensions";

const ACTIONS: Array<{
  id: ActionId;
  label: string;
  keywords: string;
  icon: typeof MessageSquarePlusIcon;
}> = [
  { id: "new", label: "新对话", keywords: "新聊天 新建 新会话", icon: MessageSquarePlusIcon },
  { id: "folder", label: "打开文件夹", keywords: "打开项目 添加项目 文件夹", icon: Folder01Icon },
  { id: "settings", label: "设置", keywords: "偏好 通用", icon: Settings01Icon },
  { id: "extensions", label: "插件", keywords: "扩展 市场", icon: PuzzleIcon },
];

function matches(haystack: string, needle: string): boolean {
  return haystack.toLowerCase().includes(needle);
}

export function CommandPalette({
  open,
  conversations,
  projects,
  activeId,
  onOpenChange,
  onSelectChat,
  onNewChat,
  onAddProject,
  onOpenSettings,
}: {
  open: boolean;
  conversations: Conversation[];
  projects: Project[];
  activeId: string | null;
  onOpenChange: (open: boolean) => void;
  onSelectChat: (id: string) => void;
  onNewChat: () => void;
  onAddProject: () => void;
  onOpenSettings: (section: SectionId) => void;
}): JSX.Element {
  const [query, setQuery] = useState("");
  const [hits, setHits] = useState<ConversationSearchHit[]>([]);
  const archived = useArchivedIds();
  const newChatShortcut = useShortcutLabel("newChat");
  const openFolderShortcut = useShortcutLabel("openFolder");
  const settingsShortcut = useShortcutLabel("settings");
  const actionShortcuts: Partial<Record<ActionId, string | undefined>> = {
    new: newChatShortcut,
    folder: openFolderShortcut,
    settings: settingsShortcut,
  };
  const projectNames = useMemo(
    () => new Map(projects.map((project) => [project.cwd, project.name])),
    [projects],
  );

  useEffect(() => {
    if (!open) {
      setQuery("");
      setHits([]);
    }
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const needle = query.trim();
    if (needle.length < 2) {
      setHits([]);
      return;
    }
    let cancelled = false;
    const timer = window.setTimeout(() => {
      void window.fastvibe.conversations
        .search(needle)
        .then((next) => {
          if (!cancelled) setHits(next);
        })
        .catch(() => {
          if (!cancelled) setHits([]);
        });
    }, 180);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [open, query]);

  const listed = useMemo(
    () =>
      conversations
        .filter((item) => item.preview && !archived.has(item.id))
        .sort((a, b) => b.createdAt - a.createdAt || a.id.localeCompare(b.id)),
    [conversations, archived],
  );

  const hitMap = useMemo(() => new Map(hits.map((hit) => [hit.id, hit.snippet])), [hits]);
  const needle = query.trim().toLowerCase();

  const chats = useMemo(() => {
    if (!needle) return listed.slice(0, 9);
    return listed.filter((item) => {
      if (hitMap.has(item.id)) return true;
      const project = projectNames.get(item.project ?? "") ?? "";
      return matches(`${item.title} ${item.preview ?? ""} ${project}`, needle);
    });
  }, [listed, needle, hitMap, projectNames]);

  const actions = useMemo(
    () => (needle ? ACTIONS.filter((item) => matches(`${item.label} ${item.keywords}`, needle)) : ACTIONS),
    [needle],
  );

  const settings = useMemo(() => {
    if (!needle) return [];
    return SETTINGS_SECTIONS.flatMap((group) => group.items).filter((item) =>
      matches(`设置 ${item.label} ${item.id} ${SETTING_KEYWORDS[item.id]}`, needle),
    );
  }, [needle]);

  function close(): void {
    onOpenChange(false);
  }

  function selectChat(id: string): void {
    close();
    onSelectChat(id);
  }

  function runAction(id: ActionId): void {
    close();
    if (id === "new") onNewChat();
    else if (id === "folder") onAddProject();
    else if (id === "settings") onOpenSettings("general");
    else onOpenSettings("extensions");
  }

  const empty = chats.length === 0 && actions.length === 0 && settings.length === 0;

  return (
    <CommandDialog
      open={open}
      onOpenChange={onOpenChange}
      title="搜索"
      description="搜索对话、快捷操作和设置"
      className="sm:max-w-lg"
    >
      <Command
        shouldFilter={false}
        onKeyDown={(event) => {
          if (!needle && (event.metaKey || event.ctrlKey) && event.key >= "1" && event.key <= "9") {
            const item = chats[Number(event.key) - 1];
            if (!item) return;
            event.preventDefault();
            selectChat(item.id);
          }
        }}
      >
        <CommandInput placeholder="搜索聊天" value={query} onValueChange={setQuery} />
        <CommandList className="max-h-[min(28rem,60vh)]">
          {empty ? <CommandEmpty>没有匹配的结果</CommandEmpty> : null}
          {chats.length > 0 ? (
            <CommandGroup heading="聊天">
              {chats.map((item, index) => {
                const project = item.project ? projectNames.get(item.project) : undefined;
                const snippet = hitMap.get(item.id);
                const titleHit = needle.length > 0 && matches(item.title, needle);
                const hint = snippet && needle && !titleHit ? snippet : project;
                const shortcut = !needle && index < 9 ? `${MOD}${index + 1}` : undefined;
                return (
                  <CommandItem
                    key={item.id}
                    value={`chat:${item.id}`}
                    onSelect={() => selectChat(item.id)}
                    aria-current={item.id === activeId ? "true" : undefined}
                  >
                    <span className="min-w-0 flex-1 truncate">{item.title || "新会话"}</span>
                    {hint ? (
                      <span className="max-w-32 shrink-0 truncate text-xs text-muted-foreground">{hint}</span>
                    ) : null}
                    {shortcut ? (
                      <CommandShortcut>
                        <Kbd>{shortcut}</Kbd>
                      </CommandShortcut>
                    ) : null}
                  </CommandItem>
                );
              })}
            </CommandGroup>
          ) : null}
          {actions.length > 0 ? (
            <CommandGroup heading="快捷操作">
              {actions.map((item) => (
                <CommandItem key={item.id} value={`action:${item.id}`} onSelect={() => runAction(item.id)}>
                  <HugeiconsIcon strokeWidth={2} icon={item.icon} className="size-3.5 text-muted-foreground" />
                  <span className="min-w-0 flex-1 truncate">{item.label}</span>
                  {actionShortcuts[item.id] ? (
                    <CommandShortcut>
                      <Kbd>{actionShortcuts[item.id]}</Kbd>
                    </CommandShortcut>
                  ) : null}
                </CommandItem>
              ))}
            </CommandGroup>
          ) : null}
          {settings.length > 0 ? (
            <CommandGroup heading="设置">
              {settings.map((item) => (
                <CommandItem
                  key={item.id}
                  value={`setting:${item.id}`}
                  onSelect={() => {
                    close();
                    onOpenSettings(item.id);
                  }}
                >
                  <span className="flex size-3.5 items-center justify-center text-muted-foreground [&_svg]:size-3.5">
                    {item.icon}
                  </span>
                  <span className="min-w-0 flex-1 truncate">{item.label}</span>
                </CommandItem>
              ))}
            </CommandGroup>
          ) : null}
        </CommandList>
      </Command>
    </CommandDialog>
  );
}
