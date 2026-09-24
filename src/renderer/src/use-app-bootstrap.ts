import { useEffect, type MutableRefObject } from "react";
import type { NavigateFunction } from "react-router";
import { toast } from "sonner";
import { i18n } from "@/lib/i18n";
import { engine, getStatus, onConversationReady, onEvent, onStatus } from "@/lib/engine-client";
import { createConversationRefresh } from "@/lib/conversation-refresh";
import { conversationIdFromHash, conversationPath } from "@/lib/routes";
import { resolvePath } from "@/lib/workspace-path";
import { isRemoteRef, shouldFollowCatalogActive } from "@/lib/remote-project";
import { useSessionStore, working } from "@/stores/session";
import { useSidePaneStore } from "@/stores/side-pane";
import type { ConversationOpenResult, EngineEvent, EngineSessionState, EngineStatus, SlashCommand, WorkspaceSnapshot } from "@shared/types";

const { refreshStats, reloadActiveState, reloadActiveMessages } = createConversationRefresh(engine, useSessionStore.getState);

export type AppBootstrapArgs = {
  setStatus: (status: EngineStatus) => void;
  setEngineKnown: (known: boolean) => void;
  applyList: (snapshot: WorkspaceSnapshot) => void;
  applyOpen: (result: ConversationOpenResult) => void;
  navigate: NavigateFunction;
  restoreId: MutableRefObject<string | null>;
  followedActiveId: MutableRefObject<string | null | undefined>;
  intendedActiveId: MutableRefObject<string | null>;
  openLatest: MutableRefObject<((id: string, source?: "user" | "history" | "remote") => Promise<void>) | null>;
  abortInFlight: MutableRefObject<Map<string, Promise<void>>>;
  applyEvent: (event: EngineEvent) => void;
  setCommands: (commands: SlashCommand[]) => void;
  applySnapshot: (snapshot: WorkspaceSnapshot) => void;
  setSession: (session: EngineSessionState | null) => void;
};

/** Boot, catalog follow, and the live engine subscription. Split out of `App` so the shell stays the layout. */
export function useAppBootstrap(args: AppBootstrapArgs): void {
  const {
    setStatus,
    setEngineKnown,
    applyList,
    applyOpen,
    navigate,
    restoreId,
    followedActiveId,
    intendedActiveId,
    openLatest,
    abortInFlight,
    applyEvent,
    setCommands,
    applySnapshot,
    setSession,
  } = args;
  useEffect(() => {
    void getStatus().then((next) => {
      setStatus(next);
      setEngineKnown(true);
    });
    // A fresh window has no run history: ask the engine which conversations are
    // still working so their spinners survive a reload.
    void window.fastvibe.engine
      .getRunning()
      .then((ids) => useSessionStore.getState().setRunningConversations(ids))
      .catch(() => undefined);
    void window.fastvibe.conversations.list().then((snapshot) => {
      applyList(snapshot);
      const pending = conversationIdFromHash() ?? snapshot.activeId;
      if (
        pending &&
        useSessionStore.getState().status.state === "ready" &&
        !useSessionStore.getState().activeId
      ) {
        restoreId.current = null;
        void window.fastvibe.conversations
          .open(pending)
          .then((opened) => {
            applyOpen(opened);
            if (!window.location.hash.includes("/settings") && conversationIdFromHash() !== pending) {
              navigate(conversationPath(pending), { replace: true });
            }
          })
          .catch(() => undefined);
      } else {
        restoreId.current = pending ?? null;
      }
    });
    const offStatus = onStatus(setStatus);
    // Background conversation init finished: fill in the transcript, unless the
    // user already sent a message (then their optimistic thread wins and engine
    // events will replace it).
    const offReady = onConversationReady((payload) => {
      const store = useSessionStore.getState();
      // Seed the sidebar's run indicator even for conversations that are not on screen.
      // `working` unions the two things the mark covers — a run (`running`, which now
      // spans the whole run: `agent_start` through `agent_settled`, retries and
      // auto-compaction included) and the compaction that can run with no run at all.
      store.setConversationRunning(payload.id, working(payload.state));
      if (store.activeId !== payload.id || store.streaming) return;
      store.setMessages(payload.messages, payload.id);
      store.setSession(payload.state);
      store.setStatus(payload.status);
      store.setExtensionStatus(payload.id, payload.extensionStatus ?? {});
    });
    /**
     * The catalog, whenever anything changes it — this window, a second window, or a
     * phone over remote access.
     *
     * `applySnapshot` takes the projects and the conversations only; the active
     * conversation is followed separately below, because adopting it is a *navigation*
     * and has to go through the same path a click does.
     */
    const offWorkspace = window.fastvibe.conversations.onChanged((snapshot) => {
      applyList(snapshot);
      const next = snapshot.activeId ?? null;
      // A remote catalog change republishes the same local active id. Nothing
      // navigated; following it would leave the remote conversation just created.
      if (next === followedActiveId.current) return;
      followedActiveId.current = next;
      const current = useSessionStore.getState().activeId;
      // Equality is what stops this from echoing: the client that made the change is
      // already there, and Main's `setActive` is a no-op for an unchanged id, so no
      // push follows the open this one is about to do. A local id is also not a
      // reason to leave a remote conversation — that push is this machine's catalog,
      // not the chat on screen.
      if (!next || !shouldFollowCatalogActive({ next, current, intended: intendedActiveId.current })) return;
      void openLatest.current?.(next, "remote");
    });
    const offEvent = onEvent((event) => {
      // An extension command replaced the session (plan-mode's fresh handoff):
      // follow the conversation the engine created and seeded.
      if (event.type === "conversation_opened" && event.result && typeof event.result === "object") {
        const opened = event.result as ConversationOpenResult;
        const openedId = opened.conversation?.id;
        const viewing = useSessionStore.getState().activeId;
        // A local session replacement must not steal a remote conversation. The
        // remote server's own `conversation_opened` is not relayed; this is the
        // local engine, and its active chat is not the one on screen.
        if (
          typeof openedId === "string"
          && !isRemoteRef(openedId)
          && (isRemoteRef(viewing) || isRemoteRef(intendedActiveId.current))
        ) {
          return;
        }
        applyOpen(opened);
        if (conversationIdFromHash() !== opened.conversation.id) {
          navigate(conversationPath(opened.conversation.id));
        }
        return;
      }
      const conversationId = typeof event.conversationId === "string" ? event.conversationId : null;
      // Run state is broadcast for every conversation so the sidebar keeps showing
      // which chats are working, even while the user is looking at another one.
      if (event.type === "conversation_running" && conversationId) {
        useSessionStore.getState().setConversationRunning(conversationId, event.running === true);
        // A failed/timeout Stop stays as a barrier until Main explicitly confirms
        // that the conversation is idle. This also releases a barrier kept after a
        // timeout when the SDK eventually settles on its own.
        if (event.running !== true) abortInFlight.current.delete(conversationId);
      }
      // A chat whose run ended abnormally — failed, cut off at the output limit, or
      // stopped by anything but the user — while another one is on screen. Main's
      // system notification only fires when no window is focused, so this used to be
      // silent: the row just lost its 运行中 mark, exactly as a finished chat does. The
      // row keeps a mark until the chat is opened; the toast says which one and goes there.
      if (event.type === "conversation_activity" && conversationId && event.status === "failed") {
        const store = useSessionStore.getState();
        if (conversationId !== store.activeId) {
          store.markFailedInBackground(conversationId);
          const title = typeof event.title === "string" && event.title ? event.title : i18n.t("app:workspace.newChat");
          toast.error(i18n.t("app:sidebar.backgroundStopped", { title }), {
            id: `stopped:${conversationId}`,
            action: {
              label: i18n.t("app:sidebar.backgroundStoppedOpen"),
              onClick: () => void openLatest.current?.(conversationId),
            },
          });
        }
      }
      // Queue state is Main-owned and applies for every conversation. It must cross
      // the focus filter so a background drain, failure or second window stays visible.
      if (event.type === "queue_changed" && event.queue && typeof event.queue === "object") {
        useSessionStore.getState().setQueueState(event.queue as import("@shared/types").ConversationQueueState);
        return;
      }
      if (event.type === "queue_delivered") {
        useSessionStore.getState().applyEvent(event);
        return;
      }
      // A queued message the engine could not send. The queue row only says it paused;
      // this is the one place the reason reaches the user, whichever chat it was in.
      if (event.type === "queue_error" && conversationId) {
        const store = useSessionStore.getState();
        const description = typeof event.message === "string" && event.message ? event.message : undefined;
        if (conversationId === store.activeId) {
          toast.error(i18n.t("chat:queue.sendFailed"), { id: `queue-error:${conversationId}`, description });
        } else {
          store.markFailedInBackground(conversationId);
          const title = store.conversations.find((item) => item.id === conversationId)?.title || i18n.t("app:workspace.newChat");
          toast.error(i18n.t("app:sidebar.backgroundStopped", { title }), {
            id: `stopped:${conversationId}`,
            description,
            action: {
              label: i18n.t("app:sidebar.backgroundStoppedOpen"),
              onClick: () => void openLatest.current?.(conversationId),
            },
          });
        }
        return;
      }
      // Blocking prompts and their withdrawal are handled for *every* conversation
      // before the focus routing below, which sends a background chat's events to the
      // side-pane store. A tool approval is not transcript content: it is the signal
      // that this chat needs the user, and the sidebar mark and the notification both
      // have to see it even though its panel is only drawn for the chat on screen.
      if (event.type === "extension_ui_request" || event.type === "extension_ui_dismiss") {
        useSessionStore.getState().applyEvent(event);
        if (conversationId && conversationId !== useSessionStore.getState().activeId) {
          useSidePaneStore.getState().applyConversationEvent(conversationId, event);
        }
        return;
      }
      if (event.type === "conversation_renamed" && event.snapshot && typeof event.snapshot === "object") {
        applyList(event.snapshot as WorkspaceSnapshot);
      }
      const currentId = useSessionStore.getState().activeId;
      // Subagent traffic feeds the shared subagent store, not a conversation, and a
      // parent run keeps streaming after the user switches chats: apply it before
      // the focus routing so every run's tab stays live either way. Each run owns a
      // tab (`subagent:<toolCallId>:<index>`), keyed to the conversation that
      // spawned it, so two chats delegating at once never share a view.
      if (event.type === "subagent_event" || event.type === "subagent_state" || event.type === "subagent_lifecycle" || event.type === "subagent_progress") {
        applyEvent(event);
        // A lifecycle event is where a run gets its tab (created, not focused).
        // Per-token `subagent_event`s and state pushes only feed the transcript / the
        // pane's read-only composer, which the session store already keys by run id —
        // no side-pane write per token.
        if (event.type !== "subagent_event" && event.type !== "subagent_state") {
          const subagentId = typeof event.subagentId === "string" ? event.subagentId : "";
          if (subagentId) {
            const info = useSessionStore.getState().subagents.find((item) => item.id === subagentId);
            useSidePaneStore.getState().registerSubagent(subagentId, {
              conversationId: typeof event.conversationId === "string" ? event.conversationId : info?.conversationId,
              title: info?.name || info?.agent,
              status: typeof event.status === "string" ? event.status : info?.status,
              brief: info?.detail,
            });
          }
        }
        return;
      }
      if (conversationId && currentId && conversationId !== currentId) {
        useSidePaneStore.getState().applyConversationEvent(conversationId, event);
        return;
      }
      applyEvent(event);
      // Message/stat reloads are expensive (the engine replays the whole
      // transcript), so only do them when the transcript actually changed.
      if (
        event.type === "agent_end" ||
        event.type === "agent_settled" ||
        event.type === "compaction_end" ||
        event.type === "auto_compaction_end"
      ) {
        reloadActiveState();
        // A failed turn is already on the optimistic assistant. Reloading here races
        // auto-retry (which drops the error message from engine state) and would
        // blank the bubble we just filled in.
        const failed =
          event.type === "agent_end" &&
          Array.isArray(event.messages) &&
          event.messages.some(
            (item) =>
              item &&
              typeof item === "object" &&
              "stopReason" in item &&
              (item as { stopReason?: unknown }).stopReason === "error",
          );
        // A cancelled/failed compact only exists on the live card; reloading would
        // drop it because the engine never wrote a compaction entry.
        const compactFailed =
          (event.type === "compaction_end" || event.type === "auto_compaction_end") &&
          (event.aborted === true || Boolean(event.errorMessage));
        if (!failed && !compactFailed) reloadActiveMessages();
        refreshStats();
      } else if (event.type === "model_changed" || event.type === "thinking_level_changed") {
        reloadActiveState();
      }
      // The composer's context ring reads `session.contextUsage`, which only a state
      // reply carries — and the engine derives it from the messages it holds. A run
      // grows the context at every turn boundary (each LLM round trip, tool calls
      // included), so the ring has to be re-read there too: only the run boundaries
      // above did it, which left the ring frozen at whatever the chat was opened with
      // for the length of a long task. Switching away and back appeared to "fix" it
      // because `conversations.open` returns a fresh state.
      if (event.type === "turn_end") reloadActiveState();
      if (event.type === "available_commands_update") {
        const raw = Array.isArray(event.commands) ? event.commands : [];
        setCommands(
          raw.flatMap((item) => {
            if (!item || typeof item !== "object" || !("name" in item) || typeof item.name !== "string") return [];
            return [{ name: item.name, description: "description" in item && typeof item.description === "string" ? item.description : undefined }];
          }),
        );
      }
      if (event.type === "tool_execution_end" || event.type === "toolcall_end") {
        // Tool time and token totals advance during a run; keep the popover live.
        refreshStats();
        const name = String(event.toolName ?? event.name ?? "");
        const args = event.args ?? event.arguments;
        const path =
          args && typeof args === "object" && args !== null
            ? String(
                (args as Record<string, unknown>).path ??
                  (args as Record<string, unknown>).file_path ??
                  (args as Record<string, unknown>).filename ??
                  "",
              )
            : "";
        // Only surface files the agent wrote to: auto-previewing every `read`
        // fired an IPC file read plus a full app re-render on the hottest path.
        if (path && /write|edit|apply|create/i.test(name)) {
          // De-dupe against the *active chat's* file view, so a write in one
          // conversation still reveals the file when another one previews it too.
          // Compare the resolved path: after the first preview the tab stores the
          // absolute file, while tool args stay relative.
          const store = useSessionStore.getState();
          const cwd = store.conversations.find((item) => item.id === store.activeId)?.cwd;
          const resolved = resolvePath(path, cwd);
          if (useSidePaneStore.getState().filesPreviewPath() !== resolved) void store.openPreview(path);
        }
      }
    });
    return () => {
      offStatus();
      offReady();
      offEvent();
      offWorkspace();
    };
  }, [applyEvent, applySnapshot, setSession, setStatus]);
}
