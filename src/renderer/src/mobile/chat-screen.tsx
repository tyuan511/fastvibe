import { memo, useCallback, useEffect, useRef, useState, useSyncExternalStore, type JSX } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import { HugeiconsIcon } from "@hugeicons/react";
import { ArrowLeft01Icon, ArrowUp02Icon, Cancel01Icon, PlayIcon, SquareIcon } from "@hugeicons/core-free-icons";
import { isAbortOutcome } from "@shared/abort";
import { Button } from "@/components/ui/button";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { MessageList } from "@/components/chat/message-list";
import { PermissionDialog } from "@/components/chat/permission-dialog";
import { PermissionPanel, type PermissionResponse } from "@/components/chat/permission-panel";
import { RunningMark } from "@/components/running-mark";
import { shouldQueueSubmission } from "@/lib/composer-race";
import { engine, respondPermission } from "@/lib/engine-client";
import { permissionKey, rememberPermission, usePermissionAlways } from "@/lib/permission-rules";
import { cn } from "@/lib/utils";
import { activePermission, useConversationWorking, useSessionStore } from "@/stores/session";
import { useSettingsStore } from "@/stores/settings";
import { getLoadState, onLoadState, showConversation } from "./live";
import { backToList, navigate } from "./route";

/** The project select's value for 无项目 (a chat in the scratch workspace). */
const NO_PROJECT = "__none__";

/**
 * One conversation on the phone — or, with no id, the page a new one starts from.
 *
 * Three rows: a header that can always get back to the list, the desktop's own
 * transcript, and at the bottom either the composer or, while the agent is parked on a
 * question, the same approval panel the desktop draws in the composer's place.
 */
export function ChatScreen({
  conversationId,
  initialProject,
}: {
  conversationId: string | null;
  initialProject?: string;
}): JSX.Element {
  const { t } = useTranslation("app");
  const activeId = useSessionStore((state) => state.activeId);
  const conversation = useSessionStore((state) => state.conversations.find((item) => item.id === state.activeId));
  const projects = useSessionStore((state) => state.projects);
  const working = useConversationWorking();
  const [project, setProject] = useState<string>(initialProject ?? NO_PROJECT);
  const load = useSyncExternalStore(onLoadState, getLoadState, getLoadState);
  const loading = load.id === conversationId && load.loading;
  const failed = load.id === conversationId ? load.error : null;
  // The chat this page is about is either the route's or, once a new chat's first send
  // created one, that one — the route follows a moment later.
  const shownId = conversationId ?? activeId;

  const projectName = projects.find((item) => item.cwd === conversation?.project)?.name;
  const localProjects = projects.filter((item) => item.kind !== "remote");
  const projectItems: Record<string, string> = {
    [NO_PROJECT]: t("mobile.noProject"),
    ...Object.fromEntries(localProjects.map((item) => [item.cwd, item.name])),
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <header className="flex h-14 shrink-0 items-center gap-1 border-b border-border/60 pr-4 pl-1">
        <Button variant="ghost" size="icon-lg" aria-label={t("mobile.back")} onClick={backToList}>
          <HugeiconsIcon icon={ArrowLeft01Icon} strokeWidth={2} className="size-5" />
        </Button>
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm font-semibold">
            {shownId ? conversation?.title || t("mobile.untitled") : t("mobile.newChat")}
          </p>
          {shownId && projectName ? <p className="truncate text-xs text-muted-foreground">{projectName}</p> : null}
        </div>
        {working ? <RunningMark className="size-4" /> : null}
      </header>

      {!shownId ? (
        <div className="shrink-0 border-b border-border/60 px-4 py-3">
          <Select items={projectItems} value={project} onValueChange={(next) => setProject(String(next))}>
            <SelectTrigger className="h-10 w-full" aria-label={t("mobile.project")}>
              <SelectValue className="truncate" />
            </SelectTrigger>
            <SelectContent>
              {Object.entries(projectItems).map(([value, label]) => (
                <SelectItem key={value} value={value}>
                  {label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <p className="mt-2 text-xs text-muted-foreground">{t("mobile.newChatHint")}</p>
        </div>
      ) : null}

      <div className="relative min-h-0 flex-1">
        {failed ? (
          <div className="flex h-full flex-col items-center justify-center gap-3 px-6 text-center">
            <p className="text-sm text-muted-foreground">{t("mobile.loadFailed", { message: failed })}</p>
            <Button variant="outline" onClick={() => void showConversation(conversationId)}>
              {t("alert.retry")}
            </Button>
          </div>
        ) : (
          <Thread loading={loading} />
        )}
      </div>

      <BottomSlot project={project === NO_PROJECT ? undefined : project} />
    </div>
  );
}

/** The transcript, subscribed on its own so a streamed token re-renders only this. */
const Thread = memo(function Thread({ loading }: { loading: boolean }): JSX.Element {
  const { t } = useTranslation("app");
  const messages = useSessionStore((state) => state.messages);
  const streaming = useSessionStore((state) => state.streaming);
  const showThinking = useSettingsStore((state) => state.settings.showThinking);
  const showTimestamp = useSettingsStore((state) => state.settings.showTimestamps);
  const collapseRuns = useSettingsStore((state) => state.settings.collapseRuns);
  return (
    <MessageList
      messages={messages}
      streaming={streaming}
      loading={loading}
      loadingReplaces={loading}
      showThinking={showThinking}
      showTimestamp={showTimestamp}
      collapseRuns={collapseRuns}
      emptyState={
        <div className="flex h-full items-center justify-center text-sm text-muted-foreground">{t("mobile.emptyChat")}</div>
      }
    />
  );
});

/**
 * The composer, or the question the agent is waiting on.
 *
 * A remembered 始终允许 (or 完全访问) is answered here without drawing anything, the
 * same rule the desktop shell applies: the phone may well be the only client looking
 * at a chat that runs in the background on the desktop.
 */
function BottomSlot({ project }: { project?: string }): JSX.Element {
  const permission = useSessionStore((state) => activePermission(state.pendingPermissions, state.activeId));
  const resolvePermission = useSessionStore((state) => state.resolvePermission);
  const permissionMode = useSettingsStore((state) => state.settings.permissionMode);
  const always = usePermissionAlways();
  const autoApproved =
    permission?.method === "confirm" && (permissionMode === "full" || always.includes(permissionKey(permission)));

  useEffect(() => {
    if (!permission || !autoApproved) return;
    void respondPermission({ id: permission.id, confirmed: true });
    resolvePermission(permission.id);
  }, [autoApproved, permission, resolvePermission]);

  const respond = useCallback(
    (payload: PermissionResponse) => {
      if (payload.always && permission) rememberPermission(permissionKey(permission));
      void respondPermission(payload);
      resolvePermission(payload.id);
    },
    [permission, resolvePermission],
  );

  if (permission && !autoApproved && permission.method === "editor") {
    return (
      <>
        <PermissionDialog request={permission} onRespond={respond} />
        <MobileComposer project={project} />
      </>
    );
  }
  if (permission && !autoApproved) {
    return (
      <div className="safe-bottom shrink-0 border-t border-border/60 pt-2">
        <PermissionPanel key={permission.id} request={permission} onRespond={respond} />
      </div>
    );
  }
  return <MobileComposer project={project} />;
}

function MobileComposer({ project }: { project?: string }): JSX.Element {
  const { t } = useTranslation("app");
  const activeId = useSessionStore((state) => state.activeId);
  const draft = useSessionStore((state) => state.draft);
  const setDraft = useSessionStore((state) => state.setDraft);
  const working = useConversationWorking();
  const canResume = useSessionStore((state) => state.canResume) && Boolean(activeId) && !working;
  const hasModel = useSessionStore((state) => state.models.length > 0);
  const allQueued = useSessionStore((state) => state.queued);
  const queuePause = useSessionStore((state) => state.queuePause);
  const queueBehavior = useSettingsStore((state) => state.settings.queueBehavior);
  const queued = activeId ? allQueued.filter((item) => item.conversationId === activeId) : [];
  const sending = useRef(false);
  const [busy, setBusy] = useState(false);

  const text = draft.trim();
  const queueing = Boolean(activeId) && (working || queued.length > 0);

  async function send(): Promise<void> {
    if (sending.current || !text) return;
    if (!hasModel) {
      toast.error(t("mobile.needModel"));
      return;
    }
    sending.current = true;
    setBusy(true);
    const message = text;
    const store = useSessionStore.getState();
    let id = store.activeId;
    try {
      if (!id) {
        // Created without activating: the desktop keeps the chat it is showing.
        const created = await window.fastvibe.conversations.create(project, { activate: false });
        store.applySnapshot(created);
        id = created.conversation.id;
        await showConversation(id);
        navigate({ kind: "chat", id }, { replace: true });
      }
      const current = useSessionStore.getState();
      const queue = shouldQueueSubmission({
        hasConversation: true,
        running: current.running[id] === true,
        hasQueuedItems: current.queued.some((item) => item.conversationId === id),
      });
      current.setComposer("", []);
      const listed = await window.fastvibe.conversations.recordPrompt(id, message);
      useSessionStore.getState().applySnapshot(listed);
      if (queue) {
        const next = await window.fastvibe.engine.queueAdd({
          conversationId: id,
          text: message,
          message,
          behavior: queueBehavior,
        });
        useSessionStore.getState().setQueueState(next);
        return;
      }
      const after = useSessionStore.getState();
      if (after.activeId === id) {
        after.addUserMessage(message);
        after.setRunInterrupted(null);
        after.setCanResume(false);
      }
      const target = id;
      // Not awaited: `prompt` resolves when the whole run is over.
      void engine.prompt(message, { conversationId: target }).catch((error: unknown) => {
        if (isAbortOutcome(error)) return;
        const latest = useSessionStore.getState();
        if (latest.activeId === target) {
          latest.rollbackOptimisticPrompt();
          if (!latest.draft) latest.setComposer(message, []);
        }
        toast.error(t("mobile.sendFailed", { message: error instanceof Error ? error.message : String(error) }));
      });
    } catch (error) {
      const latest = useSessionStore.getState();
      if (latest.activeId === id && !latest.draft) latest.setComposer(message, []);
      toast.error(t("mobile.sendFailed", { message: error instanceof Error ? error.message : String(error) }));
    } finally {
      sending.current = false;
      setBusy(false);
    }
  }

  function stop(): void {
    if (!activeId) return;
    void engine.abort(activeId).catch((error: unknown) => {
      toast.error(error instanceof Error ? error.message : String(error));
    });
  }

  function resume(): void {
    if (!activeId) return;
    const store = useSessionStore.getState();
    store.setRunInterrupted(null);
    store.setCanResume(false);
    void engine.continue(activeId).catch((error: unknown) => {
      if (isAbortOutcome(error)) return;
      toast.error(error instanceof Error ? error.message : String(error));
    });
  }

  function removeQueued(id: string): void {
    void window.fastvibe.engine
      .queueCancel(id)
      .then((next) => {
        if (next) useSessionStore.getState().setQueueState(next);
      })
      .catch((error: unknown) => toast.error(error instanceof Error ? error.message : String(error)));
  }

  function resumeQueue(): void {
    if (!activeId) return;
    void window.fastvibe.engine
      .queueResume(activeId)
      .then((next) => useSessionStore.getState().setQueueState(next))
      .catch((error: unknown) => toast.error(error instanceof Error ? error.message : String(error)));
  }

  // One button, whichever action is the useful one right now: with text in the box it
  // always sends (or queues); empty, it stops a working chat or continues a stopped one.
  const action: "send" | "stop" | "continue" = text ? "send" : working ? "stop" : canResume ? "continue" : "send";

  return (
    <div className="safe-bottom shrink-0 border-t border-border/60 bg-background px-3 pt-2">
      {queued.length > 0 ? (
        <div className="mb-2 rounded-lg border border-border/60 bg-muted/40 px-3 py-2">
          <div className="flex items-center gap-2 text-xs text-muted-foreground">
            <span className="flex-1">
              {queuePause ? t("mobile.queuePaused") : t("mobile.queued", { count: queued.length })}
            </span>
            {queuePause ? (
              <Button size="xs" variant="outline" onClick={resumeQueue}>
                {t("mobile.resumeQueue")}
              </Button>
            ) : null}
          </div>
          <ul className="mt-1 max-h-28 overflow-y-auto">
            {queued.map((item) => (
              <li key={item.id} className="flex items-center gap-2 py-0.5">
                <span className="min-w-0 flex-1 truncate text-sm">{item.text}</span>
                <Button
                  size="icon-sm"
                  variant="ghost"
                  aria-label={t("mobile.removeQueued")}
                  disabled={item.claimed}
                  onClick={() => removeQueued(item.id)}
                >
                  <HugeiconsIcon icon={Cancel01Icon} strokeWidth={2} />
                </Button>
              </li>
            ))}
          </ul>
        </div>
      ) : null}
      <div className="flex items-end gap-2 pb-2">
        <Textarea
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          placeholder={
            !hasModel ? t("mobile.needModel") : queueing ? t("mobile.placeholderQueue") : t("mobile.placeholder")
          }
          aria-label={t("mobile.placeholder")}
          rows={1}
          enterKeyHint="enter"
          className="max-h-40 min-h-10 flex-1 resize-none rounded-2xl py-2"
        />
        <Button
          size="icon-lg"
          className={cn("size-10 shrink-0 rounded-full", action === "stop" && "bg-foreground text-background hover:bg-foreground/80")}
          aria-label={t(`mobile.${action}`)}
          disabled={action === "send" ? !text || busy : false}
          onClick={() => {
            if (action === "stop") stop();
            else if (action === "continue") resume();
            else void send();
          }}
        >
          <HugeiconsIcon
            icon={action === "stop" ? SquareIcon : action === "continue" ? PlayIcon : ArrowUp02Icon}
            strokeWidth={2}
            className="size-5"
          />
        </Button>
      </div>
    </div>
  );
}
