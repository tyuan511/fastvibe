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
import { useTranslation } from "react-i18next";
import { i18n } from "@/lib/i18n";
import { SETTINGS_SECTIONS, settingsSectionLabel, type SectionId } from "@/components/settings/settings-sections";
import { useArchivedIds } from "@/stores/archive";
import { useShortcutLabel } from "@/lib/use-shortcuts";
import { IS_MAC } from "@/lib/platform";
import { clipSnippet, findMatch, splitHighlight, splitSnippetHighlight, type HighlightPart } from "@/lib/search-highlight";
import type { Conversation, ConversationSearchHit, Project } from "@shared/types";

const MOD = IS_MAC ? "⌘" : "Ctrl+";

function settingKeywords(id: SectionId): string {
  return i18n.t(`app:palette.keywords.${id}`) as string;
}

type ActionId = "new" | "folder" | "settings" | "extensions";

function actionCatalog(): Array<{
  id: ActionId;
  label: string;
  keywords: string;
  icon: typeof MessageSquarePlusIcon;
}> {
  return [
    { id: "new", label: i18n.t("app:palette.newChat") as string, keywords: i18n.t("app:palette.actionKeywords.new") as string, icon: MessageSquarePlusIcon },
    { id: "folder", label: i18n.t("app:palette.openFolder") as string, keywords: i18n.t("app:palette.actionKeywords.folder") as string, icon: Folder01Icon },
    { id: "settings", label: i18n.t("app:palette.settings") as string, keywords: i18n.t("app:palette.actionKeywords.settings") as string, icon: Settings01Icon },
    { id: "extensions", label: i18n.t("app:palette.extensions") as string, keywords: i18n.t("app:palette.actionKeywords.extensions") as string, icon: PuzzleIcon },
  ];
}

function matches(haystack: string, needle: string): boolean {
  return haystack.toLowerCase().includes(needle);
}

/**
 * The body of a chat row: which excerpt to show, and where the query sits in it.
 *
 * Two sources, one shape. Main searches the transcripts and answers with an already
 * clipped `snippet` around its own first match; the palette also matches the catalog's
 * own `title` / `preview` / project name, which is what makes a just-sent prompt findable
 * before the transcript search has anything to say about it. A preview hit has to be
 * clipped here — the preview is the first line of the conversation, and a match in the
 * middle of it would otherwise be shown as the first forty characters with nothing
 * marked in them.
 */
function bodyFor(
  item: Conversation,
  needle: string,
  hit: string | undefined,
): HighlightPart[] | undefined {
  if (!needle) return undefined;
  const snippet = (hit ?? "").replace(/\s+/g, " ").trim();
  if (snippet) return splitSnippetHighlight(snippet, needle);
  const preview = (item.preview ?? "").replace(/\s+/g, " ").trim();
  const index = findMatch(preview, needle);
  if (index < 0) return undefined;
  return splitSnippetHighlight(clipSnippet(preview, index, needle), needle);
}

/**
 * One run of a highlighted line.
 *
 * The mark is drawn with the row's own foreground colour rather than a filled accent
 * chip: on a menu row, a solid block of colour behind three characters reads as a
 * selection, and the row directly below is already highlighted when the arrow keys are
 * used. A tinted background plus the normal text colour says 「this is what you typed」
 * without competing with the selection.
 */
function Marked({ parts }: { parts: HighlightPart[] }): JSX.Element {
  return (
    <>
      {parts.map((part, index) =>
        part.match ? (
          <mark key={index} className="rounded-xs bg-warning/30 text-foreground">
            {part.text}
          </mark>
        ) : (
          <span key={index}>{part.text}</span>
        ),
      )}
    </>
  );
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
  const { t, i18n } = useTranslation("app");
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
    () => {
      const actions = actionCatalog();
      return needle ? actions.filter((item) => matches(`${item.label} ${item.keywords}`, needle)) : actions;
    },
    [needle, i18n.language],
  );

  const settings = useMemo(() => {
    if (!needle) return [];
    return SETTINGS_SECTIONS.flatMap((group) => group.items).filter((item) =>
      matches(`${i18n.t("app:palette.settingsPrefix")} ${settingsSectionLabel(item.id)} ${item.id} ${settingKeywords(item.id)}`, needle),
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
      title={t("palette.title")}
      description={t("palette.description")}
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
        <CommandInput placeholder={t("palette.placeholder")} value={query} onValueChange={setQuery} />
        <CommandList className="max-h-[min(28rem,60vh)]">
          {empty ? <CommandEmpty>{t("palette.empty")}</CommandEmpty> : null}
          {chats.length > 0 ? (
            <CommandGroup heading={t("palette.groupChats")}>
              {chats.map((item, index) => {
                const project = item.project ? projectNames.get(item.project) : undefined;
                const body = bodyFor(item, needle, hitMap.get(item.id));
                const title = item.title || t("palette.newSession");
                // A title hit is worth showing too — 「主题」 inside 设置里的主题模式 is the
                // clearest answer the palette can give — but the excerpt wins the second
                // line whenever there is one, because it is the only place a body-only
                // match can be seen at all.
                const titleParts = splitHighlight(title, needle);
                const shortcut = !needle && index < 9 ? `${MOD}${index + 1}` : undefined;
                return (
                  <CommandItem
                    key={item.id}
                    value={`chat:${item.id}`}
                    onSelect={() => selectChat(item.id)}
                    aria-current={item.id === activeId ? "true" : undefined}
                  >
                    <span className="flex min-w-0 flex-1 flex-col">
                      <span className="truncate">
                        <Marked parts={titleParts} />
                      </span>
                      {body ? (
                        <span className="truncate text-xs text-muted-foreground">
                          <Marked parts={body} />
                        </span>
                      ) : null}
                    </span>
                    {project ? (
                      <span className="max-w-32 shrink-0 truncate text-xs text-muted-foreground">{project}</span>
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
            <CommandGroup heading={t("palette.groupActions")}>
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
            <CommandGroup heading={t("palette.groupSettings")}>
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
                  <span className="min-w-0 flex-1 truncate">{settingsSectionLabel(item.id)}</span>
                </CommandItem>
              ))}
            </CommandGroup>
          ) : null}
        </CommandList>
      </Command>
    </CommandDialog>
  );
}
