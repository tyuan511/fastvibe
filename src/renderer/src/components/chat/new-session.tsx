import { useMemo, type JSX } from "react";
import { useTranslation } from "react-i18next";
import { i18n } from "@/lib/i18n";
import { HugeiconsIcon } from "@hugeicons/react";
import { Alert02Icon, ArrowRight01Icon, Clock01Icon } from "@hugeicons/core-free-icons";
import { AppLogo } from "@/components/app-logo";
import { RunningMark } from "@/components/running-mark";
import { Kbd } from "@/components/ui/kbd";
import { useArchivedIds } from "@/stores/archive";
import { useSessionStore } from "@/stores/session";
import { useShortcutLabel } from "@/lib/use-shortcuts";
import { formatRelativeTime } from "@/lib/time";
import type { Conversation } from "@shared/types";

/** Warm, time-aware greeting. Pure so it stays easy to reason about and reuse. */
export function greetingForHour(hour: number): string {
  if (hour >= 5 && hour < 11) return i18n.t("chat:newSession.morning") as string;
  if (hour >= 11 && hour < 13) return i18n.t("chat:newSession.noon") as string;
  if (hour >= 13 && hour < 18) return i18n.t("chat:newSession.afternoon") as string;
  if (hour >= 18 && hour < 23) return i18n.t("chat:newSession.evening") as string;
  return i18n.t("chat:newSession.night") as string;
}

/** Greeting shown above the composer on a brand-new conversation. */
export function NewSessionHero(): JSX.Element {
  useTranslation("chat");
  return (
    <div className="flex flex-col items-center gap-4 px-6 text-center">
      <AppLogo className="size-12 rounded-xl shadow-sm" />
      <h2 className="text-2xl font-semibold tracking-tight">
        {greetingForHour(new Date().getHours())}
      </h2>
    </div>
  );
}

const RECENT_LIMIT = 4;

/**
 * The chats the user was last working in, scoped like the composer: the project the new
 * chat is bound to, else the chats bound to no project. Side chats, empty drafts,
 * archived chats and the draft on screen are left out — the same rules the sidebar uses.
 */
function useRecentWork(project: string | undefined, exclude: string | null): Conversation[] {
  const conversations = useSessionStore((state) => state.conversations);
  const archived = useArchivedIds();
  return useMemo(
    () =>
      conversations
        .filter((item) =>
          item.id !== exclude &&
          item.preview &&
          item.kind !== "side-chat" &&
          !archived.has(item.id) &&
          (item.project ?? undefined) === project,
        )
        .sort((a, b) => b.updatedAt - a.updatedAt)
        .slice(0, RECENT_LIMIT),
    [conversations, archived, project, exclude],
  );
}

/**
 * What sits under the composer on a fresh conversation: a way back into recent work
 * (the sidebar may be collapsed, or a drawer on a phone) and the composer's own
 * affordances, which are otherwise invisible until somebody types the right key.
 */
export function NewSessionFooter({
  project,
  projectName,
  onOpen,
}: {
  project?: string;
  projectName?: string;
  onOpen: (id: string) => void;
}): JSX.Element | null {
  const { t } = useTranslation("chat");
  const activeId = useSessionStore((state) => state.activeId);
  const running = useSessionStore((state) => state.running);
  const pending = useSessionStore((state) => state.pendingPermissions);
  const recent = useRecentWork(project, activeId);
  const searchKey = useShortcutLabel("commandPalette");

  return (
    <div className="flex w-full max-w-3xl flex-col gap-5 px-6">
      {recent.length > 0 ? (
        <section className="flex flex-col gap-1">
          <div className="flex items-center gap-1.5 px-3 text-xs text-muted-foreground">
            <HugeiconsIcon strokeWidth={2} icon={Clock01Icon} className="size-3.5" />
            <span className="truncate">
              {projectName ? t("newSession.recentIn", { name: projectName }) : t("newSession.recent")}
            </span>
          </div>
          <ul className="flex flex-col">
            {recent.map((item) => {
              const waiting = (pending[item.id]?.length ?? 0) > 0;
              const busy = running[item.id] === true;
              return (
                <li key={item.id}>
                  <button
                    type="button"
                    onClick={() => onOpen(item.id)}
                    className="group flex w-full items-center gap-3 rounded-lg px-3 py-2 text-left text-sm transition-colors hover:bg-muted pointer-coarse:py-2.5"
                  >
                    <span className="min-w-0 flex-1 truncate">{item.title}</span>
                    {waiting ? (
                      <span className="flex shrink-0 items-center gap-1 text-xs text-warning">
                        <HugeiconsIcon strokeWidth={2} icon={Alert02Icon} className="size-3" />
                        {t("newSession.waiting")}
                      </span>
                    ) : busy ? (
                      <RunningMark />
                    ) : (
                      <span className="shrink-0 text-xs text-muted-foreground tabular-nums">
                        {formatRelativeTime(item.updatedAt)}
                      </span>
                    )}
                    <HugeiconsIcon
                      strokeWidth={2}
                      icon={ArrowRight01Icon}
                      className="size-3.5 shrink-0 text-muted-foreground opacity-0 transition-opacity group-hover:opacity-100 pointer-coarse:hidden"
                    />
                  </button>
                </li>
              );
            })}
          </ul>
        </section>
      ) : null}
      <div className="flex flex-wrap items-center justify-center gap-x-4 gap-y-2 text-xs text-muted-foreground pointer-coarse:hidden">
        <span className="flex items-center gap-1.5"><Kbd>/</Kbd>{t("newSession.hintSlash")}</span>
        {project ? <span className="flex items-center gap-1.5"><Kbd>@</Kbd>{t("newSession.hintMention")}</span> : null}
        {searchKey ? <span className="flex items-center gap-1.5"><Kbd>{searchKey}</Kbd>{t("newSession.hintSearch")}</span> : null}
      </div>
    </div>
  );
}
