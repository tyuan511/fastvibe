import { lazy, memo, Suspense, useCallback, useEffect, useRef, useState, type JSX } from "react";
import { motion } from "motion/react";
import { HugeiconsIcon } from "@hugeicons/react";
import { AlertCircleIcon, MessageSquarePlusIcon, PanelLeftOpenIcon, PanelRightOpenIcon, Settings01Icon } from "@hugeicons/core-free-icons";
import { useLocation, useMatch, useNavigate, useNavigationType } from "react-router";
import { Composer } from "@/components/chat/composer";
import { ExtensionNotices, ExtensionWidgets, GoalPanel } from "@/components/chat/extension-surface";
import { TodoPanel } from "@/components/chat/todo-list";
import { MessageList } from "@/components/chat/message-list";
import { NewSessionHero, SuggestionChips } from "@/components/chat/new-session";
import { PermissionDialog } from "@/components/chat/permission-dialog";
import { PermissionPanel, type PermissionResponse } from "@/components/chat/permission-panel";
import { usagePercent } from "@/components/chat/session-controls";
import { Sidebar } from "@/components/layout/sidebar";
import { SidePane, disposeSidePaneTabs } from "@/components/layout/side-pane";
import { handleBrowserRequest } from "@/components/layout/side-pane-browser";
import { PANEL_COLLAPSE_TRANSITION } from "@/components/layout/collapsible-panel";
import { CommandPalette } from "@/components/layout/command-palette";
import { TitleBar } from "@/components/layout/title-bar";
import { HAS_CUSTOM_TITLE_BAR, HAS_TRAFFIC_LIGHTS } from "@/lib/platform";
import { Toaster } from "@/components/ui/sonner";
import { Alert, AlertAction, AlertDescription, AlertTitle } from "@/components/ui/alert";
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
import { attachmentPromptSuffix, attachmentsToImages } from "@/lib/attachments";
import {
  engine,
  getModels,
  getStatus,
  getSubagents,
  newSession,
  onConversationReady,
  onEvent,
  onStatus,
  respondPermission,
  setAutoCompaction,
  setInterruptMode,
  start,
} from "@/lib/engine-client";
import { dismissBootLoader } from "@/lib/boot-loader";
import { cn } from "@/lib/utils";

import { SETTINGS_SECTIONS, type SectionId } from "@/components/settings/settings-sections";
import { setSidebarCollapsed, useIsNarrowViewport, useSidebarCollapsed } from "@/lib/sidebar-visibility";
import type { DeleteConversationsResult } from "@/components/settings/archived-settings";
import { useConversationWorking, useSessionStore, working } from "@/stores/session";
import { permissionKey, rememberPermission, usePermissionAlways } from "@/lib/permission-rules";import { useSettingsStore } from "@/stores/settings";
import { useThemeSync } from "@/lib/use-theme";
import { useLanguageSync } from "@/lib/use-language";
import { useTranslation } from "react-i18next";
import type {
  ChatAttachment,
  ChatMessage,
  ConversationDeleteResult,
  ConversationOpenResult,
  FastVibeModel,
  PermissionRequest,
  QueuedPrompt,
  SkillInfo,
  SlashCommand,
  WorkspaceSnapshot,
} from "@shared/types";
import { parseCompactCommand } from "@shared/slash";
import { conversationIdFromHash, conversationIdFromPath, conversationPath, workspacePath } from "@/lib/routes";
import { useSidePaneStore } from "@/stores/side-pane";
import { useAppShortcuts, useShortcutLabel } from "@/lib/use-shortcuts";
import { archiveConversations, archivedIdList, useArchivedIds } from "@/stores/archive";
import { Ipc } from "@shared/ipc";
import { blockedRemotely } from "@/lib/remote-unavailable";



/**
 * 设置 is ten panes deep — the provider editor, the import sources, the usage charts,
 * the skill and extension managers — and none of it is reachable until the reader
 * opens the route. Eagerly imported it was a large share of the single renderer
 * chunk the app parses before it can paint. `SETTINGS_SECTIONS` stays eager (the
 * router validates `#/settings/:section` on every navigation); only the panes are
 * deferred, and they load while the route's own transition runs.
 */
const SettingsDialog = lazy(async () => ({
  default: (await import("@/components/settings/settings-dialog")).SettingsDialog,
}));

const DRAFT_KEY = "fastvibe.session-drafts";

function readDrafts(): Record<string, string> {
  try {
    const parsed = JSON.parse(localStorage.getItem(DRAFT_KEY) ?? "{}");
    return parsed && typeof parsed === "object" ? parsed as Record<string, string> : {};
  } catch {
    return {};
  }
}

function writeDraft(id: string | null, text: string): void {
  if (!id) return;
  try {
    const drafts = readDrafts();
    if (text) drafts[id] = text;
    else delete drafts[id];
    localStorage.setItem(DRAFT_KEY, JSON.stringify(drafts));
  } catch {
    // Ignore storage quota and private-mode errors.
  }
}

/**
 * Persist the composer's draft, off the keystroke.
 *
 * `writeDraft` reads *every* saved draft back, re-serialises the lot and writes it —
 * and `localStorage` is synchronous, so doing that per keystroke put a blocking disk
 * write in the middle of typing, growing with the number of conversations that have
 * a draft. A draft is a convenience, not a transaction: a short debounce is
 * invisible to the reader, and the pending write is flushed on the two events that
 * can lose it (leaving the conversation, closing the window).
 */
const DRAFT_DEBOUNCE_MS = 400;

function useDraftPersistence(activeId: string | null, draft: string): void {
  const pending = useRef<{ id: string | null; text: string } | null>(null);
  const timer = useRef<number | null>(null);

  const flush = useCallback(() => {
    if (timer.current !== null) {
      window.clearTimeout(timer.current);
      timer.current = null;
    }
    const entry = pending.current;
    pending.current = null;
    if (entry) writeDraft(entry.id, entry.text);
  }, []);

  const lastId = useRef(activeId);

  useEffect(() => {
    // A conversation switch must not lose the draft being typed into the chat being
    // left, so the pending write for the *previous* id goes out now. A keystroke
    // within the same chat just re-arms the timer — flushing here as well would make
    // the debounce a no-op and put the synchronous write back on every key.
    if (lastId.current !== activeId) {
      flush();
      lastId.current = activeId;
    }
    pending.current = { id: activeId, text: draft };
    if (timer.current === null) timer.current = window.setTimeout(flush, DRAFT_DEBOUNCE_MS);
  }, [activeId, draft, flush]);

  // `beforeunload`, not the effect cleanup: a window closing never unmounts.
  useEffect(() => {
    window.addEventListener("beforeunload", flush);
    return () => {
      window.removeEventListener("beforeunload", flush);
      flush();
    };
  }, [flush]);
}

/** Pull the active conversation's turn statistics into the store. */
function refreshStats(): void {
  const id = useSessionStore.getState().activeId;
  // With no conversation on screen the engine's active one is not ours to report:
  // its statistics would land on the empty hero as if they were this chat's.
  if (!id) return;
  void window.fastvibe.engine
    .getStats()
    .then((stats) => {
      // Statistics are conversation-scoped but carry no id of their own, so the
      // answer is only good for the chat that was on screen when it was asked for.
      if (useSessionStore.getState().activeId === id) useSessionStore.getState().setStats(stats);
    })
    .catch(() => undefined);
}

/**
 * Re-read the engine's session state for the conversation on screen.
 *
 * The reply is one IPC hop behind the user, who may have opened another chat in
 * the meantime: the state is dropped unless its conversation is still the one on
 * screen. Without the check a finished chat could adopt the answer meant for the
 * one that was just left — and the sidebar would light it up as 运行中.
 */
function reloadActiveState(): void {
  const id = useSessionStore.getState().activeId;
  if (!id) return;
  void window.fastvibe.engine
    .getState()
    .then((next) => {
      if (useSessionStore.getState().activeId === id) useSessionStore.getState().setSession(next);
    })
    .catch(() => undefined);
}

/** Same attribution rule as `reloadActiveState`, for the transcript itself. */
function reloadActiveMessages(): void {
  const id = useSessionStore.getState().activeId;
  // `getMessages` answers for whatever conversation the *engine* has active. With
  // none on screen — the hero after 归档, or a window that never opened a chat —
  // that transcript belongs to someone else and must not be painted here.
  if (!id) return;
  void window.fastvibe.engine
    .getMessages()
    .then((messages) => {
      if (useSessionStore.getState().activeId === id) useSessionStore.getState().setMessages(messages, id);
    })
    .catch(() => undefined);
}

/**
 * The models this install can actually chat with.
 *
 * The store holds the list the engine reported once ready and after every 供应商 edit,
 * so a send normally costs nothing; an empty list is re-checked against the engine,
 * because "no models" is the one condition that has to stop a prompt before a
 * conversation is created only for it to fail.
 */
async function availableModels(): Promise<FastVibeModel[]> {
  const cached = useSessionStore.getState().models;
  if (cached.length > 0) return cached;
  const next = await getModels().catch((): FastVibeModel[] => []);
  useSessionStore.getState().setModels(next);
  return next;
}

/**
 * Subscribes to the transcript itself so a streamed token re-renders only the
 * message list — not the whole shell (sidebar, composer, side pane). App used to
 * read `messages` directly, which re-rendered the entire tree on every token.
 */
const MessageThread = memo(function MessageThread({
  loading,
  onRetry,
  onEdit,
  showThinking,
  showTimestamp,
  collapseRuns,
  findOpen,
  onCloseFind,
  findQuery,
  onFindQueryConsumed,
}: {
  loading: boolean;
  onRetry: (message: ChatMessage) => void;
  onEdit: (message: ChatMessage) => void;
  showThinking: boolean;
  showTimestamp: boolean;
  collapseRuns: boolean;
  findOpen: boolean;
  onCloseFind: () => void;
  findQuery: string | null;
  onFindQueryConsumed: () => void;
}): JSX.Element {
  const messages = useSessionStore((state) => state.messages);
  const streaming = useSessionStore((state) => state.streaming);
  return (
    <MessageList
      messages={messages}
      streaming={streaming}
      loading={loading}
      onRetry={onRetry}
      onEdit={onEdit}
      showThinking={showThinking}
      showTimestamp={showTimestamp}
      collapseRuns={collapseRuns}
      findOpen={findOpen}
      onCloseFind={onCloseFind}
      findQuery={findQuery}
      onFindQueryConsumed={onFindQueryConsumed}
    />
  );
});

export function App(): JSX.Element {
  // Applies light/dark theme selection (and reacts to OS changes in system mode).
  useThemeSync();
  useLanguageSync();
  // Another window's preference write. Every window keeps its own copy of
  // `settings.json`, so without this they drifted (two themes, two font sizes) and
  // the next save from either one silently reverted the other's change.
  useEffect(() => window.fastvibe.settings.onChanged((next) => useSettingsStore.getState().applyRemote(next)), []);
  const { t } = useTranslation("app");
  useEffect(() => {
    return window.fastvibe.browser.onRequest(({ id, request }) => {
      void handleBrowserRequest(request)
        .then((result) => window.fastvibe.browser.respond({ id, ok: true, result }))
        .catch((error: unknown) => window.fastvibe.browser.respond({ id, ok: false, error: error instanceof Error ? error.message : String(error) }));
    });
  }, []);
  const status = useSessionStore((state) => state.status);
  const session = useSessionStore((state) => state.session);
  const models = useSessionStore((state) => state.models);
  const projects = useSessionStore((state) => state.projects);
  const conversations = useSessionStore((state) => state.conversations);
  const activeId = useSessionStore((state) => state.activeId);
  // `messages` is intentionally not subscribed here: the array changes on every
  // streamed token. Derive only the stable facts the shell needs, and let
  // `MessageThread` read the transcript itself.
  const empty = useSessionStore((state) => state.messages.length === 0);
  // Read on demand from the composer's ↑/↓ handler rather than subscribed: see the
  // `history` prop on `Composer`.
  const inputHistory = useCallback(
    () =>
      useSessionStore
        .getState()
        .messages.filter((item) => item.role === "user")
        .map((item) => item.text)
        .filter(Boolean),
    [],
  );
  const hasTranscript = useSessionStore((state) =>
    state.messages.some((item) => item.role === "user" || item.role === "assistant"),
  );
  const streaming = useSessionStore((state) => state.streaming);
  // The busy mark for this chat, exactly as the sidebar draws it (`running[id]`, a run
  // or a compaction). Displays read this one; `streaming` is left to the two places
  // where the subject is a *run*: the transcript's caret/working row, and whether a
  // send is queued or starts a turn.
  const conversationWorking = useConversationWorking();
  /**
   * Whether the composer's primary action is 继续 rather than 发送: Main says the
   * transcript is parked on a message the engine can re-enter from, this chat is idle,
   * and there is a chat on screen to continue — a run in flight is resumable by that
   * same rule, so the two must be read together or a working chat would offer 继续
   * instead of 停止; and the empty hero has no conversation, so 继续 there would reach
   * for whatever session the engine last held.
   */
  const resumable = useSessionStore((state) => state.canResume);
  const canResume = Boolean(activeId) && resumable && !conversationWorking;
  const running = useSessionStore((state) => state.running);
  const waitingForUser = useSessionStore((state) => state.waitingForUser);
  const stats = useSessionStore((state) => state.stats);
  const draft = useSessionStore((state) => state.draft);
  const error = useSessionStore((state) => state.error);
  const setStatus = useSessionStore((state) => state.setStatus);
  const setSession = useSessionStore((state) => state.setSession);
  const setModels = useSessionStore((state) => state.setModels);
  const setStats = useSessionStore((state) => state.setStats);
  const applySnapshot = useSessionStore((state) => state.applySnapshot);
  const setActiveId = useSessionStore((state) => state.setActiveId);
  const setMessages = useSessionStore((state) => state.setMessages);
  const setDraft = useSessionStore((state) => state.setDraft);
  const setError = useSessionStore((state) => state.setError);
  const addUserMessage = useSessionStore((state) => state.addUserMessage);
  const applyEvent = useSessionStore((state) => state.applyEvent);
  const setStreaming = useSessionStore((state) => state.setStreaming);
  const dropEmptyAssistant = useSessionStore((state) => state.dropEmptyAssistant);
  const resetConversation = useSessionStore((state) => state.resetConversation);
  const commands = useSessionStore((state) => state.commands);
  const permission = useSessionStore((state) => state.permission);
  const setCommands = useSessionStore((state) => state.setCommands);
  const setSubagents = useSessionStore((state) => state.setSubagents);
  const resolvePermission = useSessionStore((state) => state.resolvePermission);
  const attachments = useSessionStore((state) => state.attachments);
  const queued = useSessionStore((state) => state.queued);
  const permissionAlways = usePermissionAlways();
  const setAttachments = useSessionStore((state) => state.setAttachments);
  const queuePause = useSessionStore((state) => state.queuePause);
  const enqueue = useSessionStore((state) => state.enqueue);
  const removeQueued = useSessionStore((state) => state.removeQueued);
  const setQueuedOrder = useSessionStore((state) => state.setQueuedOrder);
  const prependQueued = useSessionStore((state) => state.prependQueued);
  const markQueuedSending = useSessionStore((state) => state.markQueuedSending);
  const unmarkQueuedSending = useSessionStore((state) => state.unmarkQueuedSending);
  const unmarkAllQueuedSending = useSessionStore((state) => state.unmarkAllQueuedSending);
  const clearQueued = useSessionStore((state) => state.clearQueued);
  const setQueuePause = useSessionStore((state) => state.setQueuePause);
  const setRunInterrupted = useSessionStore((state) => state.setRunInterrupted);
  const setCanResume = useSessionStore((state) => state.setCanResume);
  const restoreId = useRef<string | null>(null);
  const draining = useRef(false);
  // One send at a time. A second click / Enter while this send is still being handed
  // over is not a second message — see `handleSubmit`.
  const submitting = useRef(false);
  // Settings lives at #/settings/<section>; no match means we are in the app.
  const settingsMatch = useMatch("/settings/*");
  const location = useLocation();
  const navigationType = useNavigationType();
  const navigate = useNavigate();
  const initialLocationKey = useRef(location.key);
  const settingsOpen = Boolean(settingsMatch);
  // Latches on: the lazy chunk is fetched the first time 设置 is opened, and the
  // dialog stays mounted after so closing it still animates.
  const [settingsMounted, setSettingsMounted] = useState(false);
  useEffect(() => {
    if (settingsOpen) setSettingsMounted(true);
  }, [settingsOpen]);
  // The wildcard is "" for a bare /settings and the section name otherwise.
  const routeSection = settingsMatch?.params["*"] || undefined;
  const settingsSection = SETTINGS_SECTIONS.flatMap((group) => group.items).some((item) => item.id === routeSection)
    ? (routeSection as SectionId)
    : undefined;

  // Normalise /settings and /settings/unknown onto a real pane.
  useEffect(() => {
    if (settingsOpen && !settingsSection) navigate("/settings/general", { replace: true });
  }, [settingsOpen, settingsSection, navigate]);
  const [commandOpen, setCommandOpen] = useState(false);
  /** 在会话中查找 (Cmd+F) over the open transcript. */
  const [findOpen, setFindOpen] = useState(false);
  /**
   * A query the find bar should open with — set when the palette opens a chat from a
   * body search hit, so the match is on screen rather than just «this chat contains it».
   */
  const [pendingFind, setPendingFind] = useState<string | null>(null);
  // `getStatus()` is async, so until it resolves the store still holds the "idle"
  // placeholder. Track whether the real status has landed: the shell shows the F
  // loader (and keeps the boot splash up) until it has.
  const [engineKnown, setEngineKnown] = useState(false);
  // Bumped whenever a fresh conversation is started so the composer grabs focus.
  const [composerFocus, setComposerFocus] = useState(0);
  // Skills the engine can load, surfaced by the composer's 技能 picker. Refetched
  // after 设置 → 技能 closes so a newly added skill shows up without a restart.
  const [skills, setSkills] = useState<SkillInfo[]>([]);
  // Set when a send was refused because no model is configured: the composer's own
  // menu is the fix, so the shell says so and offers the way there.
  const [needsModel, setNeedsModel] = useState(false);
  // Whether the engine has answered the model question. Until it does, an empty list
  // means 还没问到; after that it means the install has no model to chat with.
  const [modelsLoaded, setModelsLoaded] = useState(false);

  // Hand the pre-JS boot splash off to the shell only once the engine has settled.
  // While it is still starting, the static splash *is* the app's loader, so fading
  // it earlier would flash a second loader (or a still-empty shell) underneath it.
  useEffect(() => {
    if (!engineKnown || status.state === "starting") return;
    dismissBootLoader();
  }, [engineKnown, status.state]);
  const paneCollapsed = useSidePaneStore((state) => state.collapsed);
  const paneMaximized = useSidePaneStore((state) => state.maximized);
  const togglePane = useSidePaneStore((state) => state.toggle);
  const settings = useSettingsStore((state) => state.settings);
  const updateSettings = useSettingsStore((state) => state.update);
  const sidebarCollapsed = useSidebarCollapsed();
  // A phone has no width to give the sidebar or the right pane; the first overlays
  // (`CollapsiblePanel overlay`) and the second is simply not there.
  const narrow = useIsNarrowViewport();
  const archivedIds = useArchivedIds();
  const toggleSidebarShortcut = useShortcutLabel("toggleSidebar");
  const toggleSidePaneShortcut = useShortcutLabel("toggleSidePane");  const newChatShortcut = useShortcutLabel("newChat");

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
      applySnapshot(snapshot);
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
    const offEvent = onEvent((event) => {
      // An extension command replaced the session (plan-mode's fresh handoff):
      // follow the conversation the engine created and seeded.
      if (event.type === "conversation_opened" && event.result && typeof event.result === "object") {
        const opened = event.result as ConversationOpenResult;
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
        useSessionStore.getState().applySnapshot(event.snapshot as WorkspaceSnapshot);
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
          void getSubagents().then(setSubagents).catch(() => undefined);
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
          const store = useSessionStore.getState();
          if (useSidePaneStore.getState().filesPreviewPath() !== path) void store.openPreview(path);
        }
      }
    });
    return () => {
      offStatus();
      offReady();
      offEvent();
    };
  }, [applyEvent, applySnapshot, setSession, setStatus]);

  function listedChatIds(): string[] {
    return conversations
      .filter((item) => item.preview && !archivedIds.has(item.id))
      .sort((a, b) => b.createdAt - a.createdAt || a.id.localeCompare(b.id))
      .map((item) => item.id);
  }

  function cycleChat(delta: number): boolean {
    const ids = listedChatIds();
    if (ids.length === 0) return false;
    const current = useSessionStore.getState().activeId;
    const index = current ? ids.indexOf(current) : -1;
    const next = ids[(index + delta + ids.length) % ids.length];
    if (!next || next === current) return false;
    void handleOpen(next);
    return true;
  }

  useAppShortcuts({
    commandPalette: () => setCommandOpen((open) => !open),
    settings: () => {
      if (!settingsOpen) navigate("/settings/general");
    },
    newWindow: () => {
      if (blockedRemotely(Ipc.windowNew)) return;
      void window.fastvibe.app.newWindow();
    },
    newChat: () => {
      setCommandOpen(false);
      void handleNewChat();
    },
    openFolder: () => {
      setCommandOpen(false);
      if (settingsOpen) navigate(workspacePath(activeId));
      void handleAddProject();
    },
    focusComposer: () => {
      setCommandOpen(false);
      if (settingsOpen) navigate(workspacePath(activeId));
      setComposerFocus((value) => value + 1);
    },
    send: (event) => {
      const target = event.target;
      if (target instanceof HTMLElement) {
        const tag = target.tagName;
        if (tag === "INPUT" || tag === "SELECT" || target.isContentEditable) return false;
      }
      // The composer owns the send button; the stable data attribute keeps the shortcut
      // working whatever language the label is rendered in.
      const send = document.querySelector<HTMLButtonElement>('[data-fv-action="send"]');
      if (!send || send.disabled) return false;
      send.click();
    },
    stop: () => {
      // Esc while the chat is working stops it — but never while an overlay owns the
      // keyboard: command palette, settings, or an extension prompt (there Esc cancels).
      // The gate is the same busy mark the stop button itself is drawn from (`working`),
      // read fresh here: this handler is registered once, and a chat that is compacting
      // has something to stop even though no run is streaming.
      if (commandOpen || settingsOpen) return false;
      const store = useSessionStore.getState();
      const busy = Boolean(store.activeId && store.running[store.activeId]);
      if (!busy || store.permission) return false;
      document.querySelector<HTMLButtonElement>('[data-fv-action="stop"]')?.click();
    },
    prevChat: () => {
      setCommandOpen(false);
      return cycleChat(-1);
    },
    nextChat: () => {
      setCommandOpen(false);
      return cycleChat(1);
    },
    toggleSidebar: () => setSidebarCollapsed(!sidebarCollapsed),
    toggleSidePane: () => togglePane(),
    findInConversation: () => setFindOpen((open) => !open),
  });

  useEffect(() => {
    if (status.state !== "ready") return;
    void setAutoCompaction(settings.autoCompact).catch(() => undefined);
    void setInterruptMode(settings.interruptMode).catch(() => undefined);
    if (settings.thinkingLevel !== "auto") {
      void window.fastvibe.engine
        .setThinking(settings.thinkingLevel)
        .then(setSession)
        .catch(() => undefined);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [status.state]);

  useEffect(() => {
    if (status.state !== "ready") return;
    void setAutoCompaction(settings.autoCompact).catch(() => undefined);
  }, [settings.autoCompact, status.state]);

  useEffect(() => {
    if (status.state !== "ready") return;
    void setInterruptMode(settings.interruptMode).catch(() => undefined);
  }, [settings.interruptMode, status.state]);

  useEffect(() => {
    if (status.state !== "ready" || settings.thinkingLevel === "auto") return;
    void window.fastvibe.engine
      .setThinking(settings.thinkingLevel)
      .then(setSession)
      .catch(() => undefined);
  }, [settings.thinkingLevel, status.state, setSession]);

  useEffect(() => {
    if (status.state !== "ready") return;
    void window.fastvibe.engine
      .getState()
      .then(setSession)
      .catch(() => undefined);
    refreshStats();
    // The model list only changes when providers change, so fetch it once per engine
    // start rather than on every status flip. `modelsLoaded` records that the answer
    // has landed: an empty list then means 没有模型 rather than 还没问到.
    if (useSessionStore.getState().models.length === 0) {
      void window.fastvibe.engine
        .getModels()
        .then(setModels)
        .catch(() => undefined)
        .finally(() => setModelsLoaded(true));
    } else {
      setModelsLoaded(true);
    }
    void window.fastvibe.engine
      .getCommands()
      .then(setCommands)
      .catch(() => undefined);
    void window.fastvibe.engine
      .getSubagents()
      .then(setSubagents)
      .catch(() => undefined);
    const pending = restoreId.current;
    if (pending && !useSessionStore.getState().activeId) {
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
    }
  }, [setModels, setSession, status.state]);

  useEffect(() => {
    if (!permission || permission.method !== "confirm") return;
    const key = permissionKey(permission);
    if (settings.permissionMode !== "full" && !permissionAlways.includes(key)) return;
    void respondPermission({ id: permission.id, confirmed: true });
    resolvePermission(permission.id);
  }, [permission, permissionAlways, resolvePermission, settings.permissionMode]);

  // Shared by the inline panel (confirm/select/input/questions) and the modal (editor).
  const handlePermissionRespond = useCallback(
    (payload: PermissionResponse) => {
      if (payload.always && permission) rememberPermission(permissionKey(permission));
      void respondPermission(payload);
      // The panel is gone the moment it is answered; the queue decides what is next.
      resolvePermission(payload.id);
    },
    [permission, resolvePermission],
  );

  // Sending is allowed while the engine is still coming up: the prompt waits
  // behind initialisation, which the user experiences as reply latency. A model is
  // what cannot be waited out — with none there is nothing to send with, so the
  // composer goes read-only until 设置 → 供应商 gives it one (the model chip's own
  // popover is that way in).
  const hasModel = models.length > 0;
  const canChat =
    hasModel &&
    (status.state === "ready" || status.state === "starting" || status.state === "idle");
  const active = conversations.find((item) => item.id === activeId);
  const activeProject = projects.find((item) => item.cwd === active?.project);
  const banner =
    status.state === "missing" || status.state === "error"
      ? t("errors.cannotStart")
      : error
        ? error
        : null;
  // Unbound conversations run in a hidden scratch dir, so never surface that path.
  const workspaceLabel = activeProject?.name ?? t("workspace.noProject");

  useDraftPersistence(activeId, draft);

  // The composer's `/` palette lists skills: re-list when 设置 → 技能 is left (the
  // shell stays mounted behind that route) and when the conversation switches,
  // since project skills are discovered from the active workspace.
  useEffect(() => {
    if (settingsOpen) return;
    void window.fastvibe.engine
      .listSkills()
      .then(setSkills)
      .catch(() => undefined);
  }, [settingsOpen, active?.project]);

  // The nudge exists to explain a refused send — once a model is configured there is
  // nothing left to explain, and 供应商 hands the refreshed list over itself.
  useEffect(() => {
    if (models.length > 0) setNeedsModel(false);
  }, [models.length]);

  function applyOpen(result: ConversationOpenResult): void {
    applySnapshot(result);
    setActiveId(result.conversation.id);
    setMessages(result.messages, result.conversation.id);
    setSession(result.state);
    setStatus(result.status);
    // The goal (or plan mode) this conversation already had, replayed by the engine:
    // its own `setStatus` fired during session creation, which on a cold start is
    // before this window was listening.
    useSessionStore.getState().setExtensionStatus(result.conversation.id, result.extensionStatus ?? {});
    setDraft(readDrafts()[result.conversation.id] ?? "");
    setError(null);
    clearQueued();
    setRunInterrupted(null);
    // `canResume` is deliberately not touched here: it is not a leftover of the chat
    // being left, it is part of the state reply `setSession` just adopted — and
    // clearing it would hide the 继续 button on exactly the chat that came back from
    // an abort.
    // Drop the previous chat's numbers before the new ones arrive.
    useSessionStore.getState().setStats(null);
    refreshStats();
  }

  /** Push or replace the conversation URL so back/forward walk real history. */
  function revealConversation(id: string, replace = false): void {
    const path = conversationPath(id);
    if (location.pathname === path) return;
    navigate(path, { replace });
  }

  function applyList(snapshot: WorkspaceSnapshot): void {
    applySnapshot(snapshot);
  }

  async function handleSubmit(): Promise<void> {
    // One send owns the composer. Between consuming it and the engine accepting the
    // prompt there are IPC hops (`availableModels`, `conversations.create`,
    // `recordPrompt`), and Main can be busy streaming another conversation for tens
    // or hundreds of ms — a second click or Enter in that window used to send the
    // same prompt again, without its text (`请查看附件` + the same attachments).
    if (submitting.current) return;
    const text = draft.trim();
    const currentAttachments = useSessionStore.getState().attachments;
    if ((!text && currentAttachments.length === 0) || !canChat) return;
    const compact = parseCompactCommand(text);
    if (compact) {
      if (!activeId) return;
      setDraft("");
      try {
        await engine.compact(compact.instructions);
        void engine.getState().then(setSession).catch(() => undefined);
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      }
      return;
    }
    submitting.current = true;
    try {
      // Nothing to run a turn on: keep the draft and ask for a model. Creating the
      // conversation first would leave a chat whose prompt the engine then refuses.
      if ((await availableModels()).length === 0) {
        setNeedsModel(true);
        return;
      }
      // The text the engine will actually receive, and therefore also the text the
      // row shows: they used to differ (file names in the bubble, `请查看附件` in the
      // engine), so re-reading the transcript silently rewrote the message.
      const promptText = text || t("composer.seeAttachments");
      // Consume the composer before any further await: from here the draft and the
      // attachments belong to this call, so a second click finds an empty composer
      // (and a disabled send button) instead of re-sending the same prompt without
      // its text.
      setDraft("");
      setAttachments([]);
      let conversationId = activeId;
      if (!conversationId) {
        const created = await window.fastvibe.conversations.create(active?.project);
        applyOpen(created);
        conversationId = created.conversation.id;
        revealConversation(conversationId);
      }
      const nextList = await window.fastvibe.conversations.recordPrompt(conversationId, promptText);
      applyList(nextList);
      if (streaming) {
        setQueuePause(null);
        if (settings.queueBehavior === "steer") {
          const id = crypto.randomUUID();
          const payload = `${promptText}${attachmentPromptSuffix(currentAttachments)}`;
          enqueue({
            id,
            text: promptText,
            behavior: "steer",
            attachments: currentAttachments,
            sending: true,
            sentText: payload,
          });
          // Not awaited: `steer()` waits for the run when the engine has already
          // settled, and the guard must not stay held for the length of a run.
          void window.fastvibe.engine
            .steer(payload, attachmentsToImages(currentAttachments))
            .then(() => engine.getState().then(setSession).catch(() => undefined))
            .catch((err: unknown) => {
              unmarkQueuedSending(id);
              setError(err instanceof Error ? err.message : String(err));
            });
        } else {
          enqueue({
            id: crypto.randomUUID(),
            text: promptText,
            behavior: "followUp",
            attachments: currentAttachments,
          });
        }
        return;
      }
      addUserMessage(promptText, currentAttachments);
      // A fresh prompt supersedes an interrupted turn: drop the resume affordance now
      // so the button does not linger until the engine's `agent_start` lands.
      setRunInterrupted(null);
      setCanResume(false);
      // Not awaited either: `prompt()` resolves only when the whole run is over, and
      // holding the guard until then would refuse every follow-up sent mid-run.
      void dispatchPrompt(text, currentAttachments, "prompt").catch((err: unknown) => {
        dropEmptyAssistant();
        setError(err instanceof Error ? err.message : String(err));
      });
    } catch (err) {
      // Nothing reached the engine: hand the composer back what this call consumed.
      setDraft(text);
      setAttachments(currentAttachments);
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      submitting.current = false;
    }
  }

  async function dispatchPrompt(
    text: string,
    files: ChatAttachment[],
    mode: "prompt" | "steer",
  ): Promise<void> {
    const payload = `${text || t("composer.seeAttachments")}${attachmentPromptSuffix(files)}`;
    const images = attachmentsToImages(files);
    if (mode === "steer") await engine.steer(payload, images);
    else await engine.prompt(payload, { images });
    void engine.getState().then(setSession).catch(() => undefined);
  }

  async function drainQueued(item: QueuedPrompt): Promise<void> {
    removeQueued(item.id);
    addUserMessage(item.text, item.attachments);
    try {
      await dispatchPrompt(item.text, item.attachments ?? [], "prompt");
    } catch (err) {
      dropEmptyAssistant();
      prependQueued(item);
      setQueuePause("error");
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  async function replaceEngineSteering(exceptId?: string): Promise<void> {
    const remaining = useSessionStore
      .getState()
      .queued.filter((item) => item.sending && item.id !== exceptId);
    try {
      await engine.replaceSteering(
        remaining.map((item) => ({
          text: item.sentText ?? item.text,
          images: attachmentsToImages(item.attachments ?? []),
        })),
      );
    } catch {
      // The engine may already have drained the item; the tray still updates.
    }
  }

  async function handleRemoveQueued(id: string): Promise<void> {
    const item = useSessionStore.getState().queued.find((entry) => entry.id === id);
    if (item?.sending) await replaceEngineSteering(id);
    removeQueued(id);
  }

  function handleEditQueued(id: string): void {
    const item = useSessionStore.getState().queued.find((entry) => entry.id === id);
    if (!item || item.sending || draft.trim()) return;
    removeQueued(id);
    setDraft(item.text);
    if (item.attachments?.length) setAttachments(item.attachments);
  }

  async function handleRecallQueued(id: string): Promise<void> {
    const item = useSessionStore.getState().queued.find((entry) => entry.id === id);
    if (!item?.sending) return;
    await replaceEngineSteering(id);
    unmarkQueuedSending(id);
  }

  async function handleSendQueuedNow(id: string): Promise<void> {
    const item = useSessionStore.getState().queued.find((entry) => entry.id === id);
    if (!item || item.sending) return;
    if (useSessionStore.getState().streaming) {
      const payload = `${item.text || t("composer.seeAttachments")}${attachmentPromptSuffix(item.attachments ?? [])}`;
      markQueuedSending(id, payload);
      try {
        await engine.steer(payload, attachmentsToImages(item.attachments ?? []));
        void engine.getState().then(setSession).catch(() => undefined);
      } catch (err) {
        unmarkQueuedSending(id);
        setError(err instanceof Error ? err.message : String(err));
      }
      return;
    }
    removeQueued(id);
    addUserMessage(item.text, item.attachments);
    try {
      await dispatchPrompt(item.text, item.attachments ?? [], "prompt");
    } catch (err) {
      dropEmptyAssistant();
      prependQueued(item);
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  async function handleAbort(): Promise<void> {
    const pending = useSessionStore.getState().queued;
    if (pending.length > 0) setQueuePause("stopped");
    try {
      try {
        await engine.clearQueue();
      } catch {
        // older engines may not support clear_queue
      }
      unmarkAllQueuedSending();
      await engine.abort();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setStreaming(false);
      void engine.getState().then(setSession).catch(() => undefined);
    }
  }

  /**
   * Continue the interrupted turn. The engine re-enters the loop from the transcript
   * (no new user message), and the queue stays held: resume must not flush queued
   * follow-ups onto a half-finished reply. Once the resumed run starts, `agent_start`
   * clears `runInterrupted` and unpauses nothing — the queue only resumes when the
   * user explicitly continues it (or a later clean turn ends).
   *
   * `canResume` is dropped here rather than left to the engine's reply: the flag is
   * derived state, and clicking 继续 twice inside one IPC round trip would otherwise
   * call `continueTurn` on a session the SDK already considers busy.
   */
  async function handleResumeRun(): Promise<void> {
    if (!canChat) return;
    setRunInterrupted(null);
    setCanResume(false);
    try {
      await engine.continue();
    } catch (err) {
      setRunInterrupted("error");
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      void engine.getState().then(setSession).catch(() => undefined);
    }
  }

  // Each dispatch resolves only once its whole run finishes, so drain the queue in
  // a loop. A one-shot effect would stop after the first item: resetting `draining`
  // in `.finally` does not re-render, so the next queued message would never fire.
  useEffect(() => {
    if (streaming || queuePause || !queued.some((item) => !item.sending) || draining.current) return;
    draining.current = true;
    void (async () => {
      try {
        for (;;) {
          const state = useSessionStore.getState();
          if (state.queuePause || state.streaming) break;
          const next = state.queued.find((item) => !item.sending);
          if (!next) break;
          await drainQueued(next);
        }
      } finally {
        draining.current = false;
      }
    })();
  }, [streaming, queuePause, queued]);

  /**
   * Stop a chat from the sidebar without opening it.
   *
   * The stop button only ever addressed the active conversation, so a `/goal` run
   * left spinning in the background had to be opened before it could be stopped.
   * The id is passed explicitly for the same reason as everywhere else: the chat
   * being stopped is not necessarily the one on screen.
   */
  const handleStopConversation = useCallback(async (id: string): Promise<void> => {
    try {
      await engine.abort(id);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, []);

  // Stable identities so the memoised transcript rows do not re-render (or hold a
  // stale closure) when unrelated shell state changes.
  /**
   * A retry whose turn also changed files, held until the user decides about them.
   *
   * Only the *decision* is deferred: the checkpoint is read first, and when the turn
   * wrote nothing (`null`) the retry runs immediately with no extra step. Winding the
   * working tree back is not something to do silently — the user may have edited those
   * same files by hand since — but not offering it at all was worse: 「重试这一轮」
   * re-ran the prompt against code the failed attempt had already changed.
   */
  const [retryRewind, setRetryRewind] = useState<{ message: ChatMessage; paths: string[] } | null>(null);
  /** One retry at a time: the transcript's 重试 button stays mounted while it works. */
  const retrying = useRef(false);

  const runRetry = useCallback(async (message: ChatMessage): Promise<void> => {
    if (retrying.current) return;
    retrying.current = true;
    try {
      const current = useSessionStore.getState();
      const owner = current.activeId;
      const source =
        message.role === "user"
          ? message
          : [...current.messages].reverse().find((item) => item.role === "user" && item.createdAt <= message.createdAt);
      const text = source?.text?.trim();
      if (!text || !canChat) return;
      if (current.streaming) {
        try {
          await engine.abort();
        } catch {
          // ignore
        }
      }
      // Every step below acts on whatever conversation the engine has active, and a
      // branch/send is a round trip the user can switch chats in the middle of. Bail
      // out rather than rewind (and re-send into) a chat they moved to.
      if (useSessionStore.getState().activeId !== owner) return;
      // Retry replaces its turn rather than appending a second copy: drop the source
      // user message and everything after it, then send it again. Branching rewinds
      // the engine to the same point; if the id cannot be resolved locally the trim
      // still keeps the transcript from stacking a duplicate.
      const sourceIndex = source ? current.messages.findIndex((item) => item.id === source.id) : -1;
      const trimmed = sourceIndex >= 0 ? current.messages.slice(0, sourceIndex) : current.messages;
      if (source?.id) {
        try {
          const branch = await engine.branch(source.id);
          if (useSessionStore.getState().activeId !== owner) return;
          setMessages(branch, owner ?? undefined);
        } catch {
          setMessages(trimmed, owner ?? undefined);
        }
      } else {
        setMessages(trimmed, owner ?? undefined);
      }
      setDraft("");
      addUserMessage(text, source?.attachments);
      try {
        await engine.prompt(text, {
          images: source?.attachments ? attachmentsToImages(source.attachments) : undefined,
        });
        void engine.getState().then(setSession).catch(() => undefined);
      } catch (err) {
        dropEmptyAssistant();
        setError(err instanceof Error ? err.message : String(err));
      }
    } finally {
      retrying.current = false;
    }
  }, [canChat, setMessages, setDraft, addUserMessage, dropEmptyAssistant, setError, setSession]);

  const handleRetry = useCallback(async (message: ChatMessage): Promise<void> => {
    // Ask about the workspace before touching the transcript, so a cancelled retry
    // leaves everything exactly as it was.
    const owner = useSessionStore.getState().activeId;
    if (owner) {
      const checkpoint = await window.fastvibe.engine.getCheckpoint(owner).catch(() => null);
      if (checkpoint && checkpoint.paths.length > 0) {
        setRetryRewind({ message, paths: checkpoint.paths });
        return;
      }
    }
    await runRetry(message);
  }, [runRetry]);

  const handleEdit = useCallback(async (message: ChatMessage): Promise<void> => {
    const owner = useSessionStore.getState().activeId;
    if (message.id) {
      try {
        const branch = await engine.branch(message.id);
        // Branching rewrites the engine's active session; if the user switched
        // chats while it ran, the result no longer describes the chat on screen.
        if (useSessionStore.getState().activeId !== owner) return;
        setMessages(branch, owner ?? undefined);
      } catch {
        // A turn sent in this window has no session entry yet: rewrite it by
        // dropping it (and its reply) locally, matching what branching would do.
        const current = useSessionStore.getState();
        if (current.activeId !== owner) return;
        const index = current.messages.findIndex((item) => item.id === message.id);
        if (index >= 0) setMessages(current.messages.slice(0, index), owner ?? undefined);
      }
    }
    setDraft(message.text);
  }, [setMessages, setDraft]);

  async function discardDraft(id: string | null | undefined): Promise<void> {
    if (!id) return;
    const item = useSessionStore.getState().conversations.find((entry) => entry.id === id);
    if (!item || item.preview) return;
    try {
      applyList(await window.fastvibe.conversations.delete(id));
      disposeSidePaneTabs(useSidePaneStore.getState().forgetScope(id));
      useSessionStore.getState().forgetConversationExtensionState(id);
    } catch {
      // Draft cleanup is best-effort.
    }
  }

  /** Empty chats stay off the sidebar until the first prompt is sent. */
  async function handleNewChat(project?: string): Promise<void> {
    setComposerFocus((value) => value + 1);
    try {
      const current = conversations.find((item) => item.id === activeId);
      if (current && !current.preview) {
        if ((current.project ?? undefined) !== (project || undefined)) {
          applyList(await window.fastvibe.conversations.setProject(current.id, project ?? null));
          void getStatus().then(setStatus).catch(() => undefined);
          void engine.getState().then(setSession).catch(() => undefined);
        }
        setMessages([], current.id);
        setDraft(readDrafts()[current.id] ?? "");
        setError(null);
        revealConversation(current.id);
        return;
      }
      const previousId = activeId;
      const created = await window.fastvibe.conversations.create(project);
      applyOpen(created);
      revealConversation(created.conversation.id);
      await discardDraft(previousId);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  async function handleOpen(id: string, source: "user" | "history" = "user", findQuery?: string): Promise<void> {
    const store = useSessionStore.getState();
    // A search hit opens the chat *and* the find bar on the query that found it: the
    // palette can say which conversation matched, but only the transcript can show
    // where, and scrolling there by hand is the work the search was meant to save.
    if (findQuery) {
      setPendingFind(findQuery);
      setFindOpen(true);
    }
    // Re-opening the active chat is pointless once it has content or a reply is
    // streaming, but it is how an empty/failed conversation gets retried.
    if (id === store.activeId && (store.messages.length > 0 || store.streaming)) {
      if (source === "user") revealConversation(id);
      return;
    }
    const previousId = store.activeId;
    try {
      const opened = await window.fastvibe.conversations.open(id);
      applyOpen(opened);
      if (source === "user") revealConversation(id);
      if (previousId && previousId !== id) await discardDraft(previousId);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  // Back/forward (and the mouse side buttons) POP the hash history. Open the
  // conversation the URL now names, without pushing another entry.
  useEffect(() => {
    if (location.key === initialLocationKey.current) return;
    if (navigationType !== "POP") return;
    const id = conversationIdFromPath(location.pathname);
    if (!id || id === useSessionStore.getState().activeId) return;
    void handleOpen(id, "history");
  }, [location.key, location.pathname, navigationType]);

  async function handleAddProject(): Promise<void> {
    // The picker would open on the machine running the server, where nobody is looking,
    // and the promise would never settle. Guarded here because three different controls
    // reach this one function.
    if (blockedRemotely(Ipc.projectsAdd)) return;
    try {
      const added = await window.fastvibe.projects.add();
      if (!added) return;
      applyList(added);
      setStatus(await getStatus());
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  async function handleRenameSession(id: string, title: string): Promise<void> {
    try {
      applyList(await window.fastvibe.conversations.rename(id, title));
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  /**
   * 归档 only hides the chat from every list; the transcript stays on disk. When the
   * chat being archived is the one on screen it has to leave the screen too —
   * otherwise the sidebar loses a row while the thread it points at stays open.
   * Follow the newest chat still listed, or fall back to a fresh session.
   */
  async function handleArchiveSession(id: string): Promise<void> {
    archiveConversations(id);
    // An archived chat is hidden from every list, so its pane state goes with it:
    // the tabs' shells and browser views must not outlive the chat they served.
    disposeSidePaneTabs(useSidePaneStore.getState().forgetScope(id));
    if (id !== useSessionStore.getState().activeId) return;
    const hidden = new Set(archivedIdList());
    hidden.add(id);
    const next = conversations
      .filter((item) => item.preview && !hidden.has(item.id))
      .sort((a, b) => b.createdAt - a.createdAt || a.id.localeCompare(b.id))[0];
    if (next) {
      try {
        applyOpen(await window.fastvibe.conversations.open(next.id));
        revealConversation(next.id, true);
        return;
      } catch {
        // Fall through: the archived chat must not stay on screen even if the
        // replacement cannot be opened.
      }
    }
    resetConversation();
    if (location.pathname.startsWith("/c/")) navigate("/", { replace: true });
  }

  async function handleRenameProject(cwd: string, name: string): Promise<void> {
    try {
      applyList(await window.fastvibe.projects.rename(cwd, name));
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  /**
   * Persist a drag-reordered project list. The catalog owns the order (unlike the
   * conversation sections, which live in `sidebarOrder`), so the drop is applied to
   * the store first — otherwise dnd-kit resets its transforms before the IPC reply
   * lands and the rows visibly snap back — then written through.
   */
  async function handleReorderProjects(cwds: string[]): Promise<void> {
    const { projects: current, conversations: list, activeId: currentActiveId } = useSessionStore.getState();
    const rank = new Map(cwds.map((cwd, index) => [cwd, index]));
    const reordered = [...current].sort((a, b) => {
      const left = rank.get(a.cwd);
      const right = rank.get(b.cwd);
      if (left === undefined && right === undefined) return 0;
      if (left === undefined) return 1;
      if (right === undefined) return -1;
      return left - right;
    });
    const restore = { projects: current, conversations: list, activeId: currentActiveId ?? undefined };
    applySnapshot({ ...restore, projects: reordered });
    try {
      applyList(await window.fastvibe.projects.reorder(cwds));
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      applySnapshot(restore);
    }
  }

  async function handleRemoveProject(cwd: string): Promise<void> {
    try {
      // The catalog drops the project's conversations with it; their panes go too.
      const doomed = useSessionStore.getState().conversations.filter((item) => item.project === cwd).map((item) => item.id);
      const result = await window.fastvibe.projects.remove(cwd);
      applyList(result);
      for (const id of doomed) {
        disposeSidePaneTabs(useSidePaneStore.getState().forgetScope(id));
        useSessionStore.getState().forgetConversationExtensionState(id);
      }
      if (result.nextId) {
        applyOpen(await window.fastvibe.conversations.open(result.nextId));
        revealConversation(result.nextId, true);
      } else if (active?.project === cwd) {
        resetConversation();
        if (location.pathname.startsWith("/c/")) navigate("/", { replace: true });
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  /**
   * Delete conversations from Settings → 归档对话. Returns the ids the engine really
   * deleted, so the pane only un-archives those; failures are reported back (and
   * shown in the shell banner) instead of being silently dropped.
   */
  async function handleDeleteConversations(ids: string[]): Promise<DeleteConversationsResult> {
    const deleted: string[] = [];
    let error: string | undefined;
    let result: ConversationDeleteResult | null = null;
    for (const id of ids) {
      try {
        result = await window.fastvibe.conversations.delete(id);
        deleted.push(id);
        disposeSidePaneTabs(useSidePaneStore.getState().forgetScope(id));
        useSessionStore.getState().forgetConversationExtensionState(id);
      } catch (err) {
        error = err instanceof Error ? err.message : String(err);
      }
    }
    if (error) setError(error);
    if (!result) return { deleted, error };
    applyList(result);
    if (ids.includes(activeId ?? "") && deleted.length > 0) {
      // The chat on screen was deleted: fall through to whatever the catalog promoted.
      if (result.nextId) {
        applyOpen(await window.fastvibe.conversations.open(result.nextId));
        revealConversation(result.nextId, true);
      } else {
        resetConversation();
        if (location.pathname.startsWith("/c/")) navigate("/", { replace: true });
      }
    }
    return { deleted, error };
  }

  /**
   * Bind the active conversation to a project, or clear it to "无项目". A new
   * session has no conversation row yet, so picking a project creates one —
   * unbound sessions stay hidden from the sidebar until their first prompt.
   */
  async function handleSetProject(project: string | null): Promise<void> {
    try {
      if (!activeId) {
        const created = await window.fastvibe.conversations.create(project ?? undefined);
        applyOpen(created);
        revealConversation(created.conversation.id);
        return;
      }
      const snapshot = await window.fastvibe.conversations.setProject(activeId, project);
      applyList(snapshot);
      void getStatus().then(setStatus).catch(() => undefined);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  async function handlePickWorkspace(): Promise<void> {
    if (blockedRemotely(Ipc.workspacePick)) return;
    const picked = await window.fastvibe.workspace.pick();
    if (!picked) return;
    setStatus(picked.status);
    applyList(await window.fastvibe.conversations.list());
    await handleSetProject(picked.cwd);
  }

  async function handleModelChange(provider: string, modelId: string): Promise<void> {
    try {
      let next = await engine.setModel(provider, modelId);
      const catalog = models.find((item) => item.provider === provider && item.id === modelId);
      const levels = catalog?.thinkingLevels;
      if (levels?.length && (!next.thinkingLevel || !levels.includes(next.thinkingLevel as never))) {
        next = await engine.setThinking(levels.includes("high") ? "high" : levels[0]);
      }
      setSession(next);
      // Deliberately no transcript re-read here. Nothing about the chat changed yet —
      // the pick is announced as a divider only when a reply actually runs on it (Main
      // emits `model_changed` from the assistant `message_start`), so reading the
      // transcript now would only invite a divider for a switch that has not happened.
    } catch {
      setError(t("errors.switchModel"));
    }
  }

  async function handleThinkingChange(level: string): Promise<void> {
    try {
      const next = await engine.setThinking(level);
      setSession(next);
    } catch {
      setError(t("errors.thinking"));
    }
  }

  const headerTitle = active ? active.title : t("workspace.newSession");
  // A conversation with no preview yet is still a "new session": it has no title
  // or content to put in the top bar, so the bar is dropped and the project
  // binding is surfaced above the composer instead.
  const isNewSession = !active?.preview;
  // `loading` is the engine coming up, never the model question — plus the window
  // before `getStatus()` lands, which the boot splash is already covering.
  const loading = empty && (!engineKnown || status.state === "starting");
  // A fresh conversation swaps the transcript for the centred greeting hero.
  const showHero = empty && !loading;

  const bannerNode = (
    <>
      {needsModel ? (
        <div className="mx-auto mb-2 w-full max-w-3xl px-6">
          <Alert>
            <HugeiconsIcon strokeWidth={2} icon={Settings01Icon} />
            <AlertTitle>{t("alert.noModelTitle")}</AlertTitle>
            <AlertDescription>{t("alert.noModelDesc")}</AlertDescription>
            <AlertAction>
              <Button size="xs" variant="outline" onClick={() => navigate("/settings/providers")}>
                {t("alert.goSettings")}
              </Button>
            </AlertAction>
          </Alert>
        </div>
      ) : null}
      {banner ? (
        <div className="mx-auto mb-2 w-full max-w-3xl px-6">
          <Alert variant="destructive">
            <HugeiconsIcon strokeWidth={2} icon={AlertCircleIcon} />
            <AlertTitle>{t("alert.problemTitle")}</AlertTitle>
            <AlertDescription>{banner}</AlertDescription>
            {status.state === "missing" || status.state === "error" ? (
              <AlertAction>
                <Button
                  size="xs"
                  variant="outline"
                  onClick={() => void start(status.cwd)}
                >
                  {t("alert.retry")}
                </Button>
              </AlertAction>
            ) : null}
          </Alert>
        </div>
      ) : null}
    </>
  );

  // The composer's `/` palette: one entry per installed skill, then the engine's
  // own commands (extension commands, prompt templates, …). `getCommands()` does
  // not enumerate skill commands yet, so those are appended here.
  const engineCommandNames = new Set(commands.map((command) => command.name));
  const paletteCommands: SlashCommand[] = [
    ...skills
      .filter((item) => !engineCommandNames.has(`skill:${item.name}`))
      .map((item) => ({
        name: `skill:${item.name}`,
        description: item.description,
        source: "skill",
      })),
    ...commands,
  ];

  const composer = (
    <Composer
      value={draft}
      disabled={!canChat}
      streaming={streaming}
      working={conversationWorking}
      placeholder={canChat ? t("composer.ready") : modelsLoaded && !hasModel ? t("composer.needModel") : t("composer.preparing")}
      models={models}
      model={session?.model}
      thinkingLevel={session?.thinkingLevel}
      workspaceLabel={workspaceLabel}
      projects={projects}
      project={active?.project}
      newSession={isNewSession}
      commands={paletteCommands}
      permissionMode={settings.permissionMode}
      onPermissionModeChange={(mode) => updateSettings({ permissionMode: mode })}
      queued={queued}
      queuePause={queuePause}
      attachments={attachments}
      history={inputHistory}
      contextPercent={usagePercent(session)}
      contextUsage={session?.contextUsage}
      stats={stats}
      onChange={setDraft}
      onSubmit={() => void handleSubmit()}
      onAbort={() => void handleAbort()}
      onPickWorkspace={() => void handlePickWorkspace()}
      onSelectProject={(project) => void handleSetProject(project)}
      onModelChange={(provider, modelId) => void handleModelChange(provider, modelId)}
      onThinkingChange={(level) => void handleThinkingChange(level)}
      onAttachmentsChange={setAttachments}
      onRemoveQueued={(id) => void handleRemoveQueued(id)}
      onEditQueued={handleEditQueued}
      onSendQueuedNow={(id) => void handleSendQueuedNow(id)}
      onRecallQueued={(id) => void handleRecallQueued(id)}
      onReorderQueued={setQueuedOrder}
      onResumeQueue={() => setQueuePause(null)}
      canResume={canResume}
      onResumeRun={() => void handleResumeRun()}
      sendOnEnter={settings.sendOnEnter}
      focusSignal={composerFocus}
      onManageModels={() => navigate("/settings/providers")}
    />
  );

  // An extension prompt takes over the composer's slot instead of opening a modal
  // (see PermissionPanel): `confirm` approvals, the agent's `select`/`input`
  // questions, and the paged `questions` form render inline; only `editor`
  // (multi-line prefill) stays a dialog. `full`/remembered approvals are answered
  // by the effect above, so they never reach the panel.
  const confirmAutoApproved =
    permission?.method === "confirm" &&
    (settings.permissionMode === "full" || permissionAlways.includes(permissionKey(permission)));
  const pendingPanel = permission && permission.method !== "editor" && !confirmAutoApproved ? permission : null;
  const pendingDialog = permission && permission.method === "editor" ? permission : null;
  const composerSlot = pendingPanel ? (
    <PermissionPanel key={pendingPanel.id} request={pendingPanel} onRespond={handlePermissionRespond} />
  ) : (
    composer
  );

  return (
    <div className="flex h-full flex-col bg-background">
      {/* Above everything, including the settings overlay: a refused click is most
          likely to happen in there, and the notice has to be where the click was. */}
      <Toaster />
      {/* Windows and Linux draw the window's own bar here, above the split, so the
          controls the OS used to provide are never missing and never fight the
          sidebar or the right pane for the window's top-right corner. */}
      {HAS_CUSTOM_TITLE_BAR ? <TitleBar onSearch={() => setCommandOpen(true)} /> : null}
      <div className="relative flex min-h-0 flex-1">
        {/* The drawer's backdrop. Only on a narrow layout, and only while it is open:
            tapping the conversation behind it is how a phone expects to dismiss it. */}
        {narrow && !sidebarCollapsed ? (
          <button
            type="button"
            aria-label={t("sidebar.collapseSidebar")}
            className="absolute inset-0 z-40 bg-black/40"
            onClick={() => setSidebarCollapsed(true)}
          />
        ) : null}
        <Sidebar
          projects={projects}
          conversations={conversations}
          activeId={activeId}
          running={running}
          waitingForUser={waitingForUser}
          onNewChat={(cwd) => void handleNewChat(cwd)}
          onOpen={(id) => void handleOpen(id)}
          onArchive={(id) => void handleArchiveSession(id)}
          onStop={(id) => void handleStopConversation(id)}
          onAddProject={() => void handleAddProject()}
          onRenameSession={(id, title) => void handleRenameSession(id, title)}
          onRenameProject={(cwd, name) => void handleRenameProject(cwd, name)}
          onRemoveProject={(cwd) => void handleRemoveProject(cwd)}
          onRevealProject={(cwd) => {
            if (blockedRemotely(Ipc.workspaceReveal)) return;
            void window.fastvibe.workspace.reveal(cwd);
          }}
          onReorderProjects={(cwds) => void handleReorderProjects(cwds)}
          onOpenSettings={() => navigate("/settings/general")}
          onOpenMarket={() => navigate("/settings/extensions")}
          onSearch={() => setCommandOpen(true)}
        />
        <main className={cn("flex min-w-0 flex-1 flex-col", !paneCollapsed && paneMaximized && "hidden")}>
          <motion.header
            initial={false}
            // Expanded: the collapse control lives on the sidebar, next to the
            // traffic lights — or in the window's title bar, where there is one.
            // Collapsed: inset this bar on macOS so the expand control, title and
            // lights share one vertically centred row.
            animate={{ paddingLeft: sidebarCollapsed && HAS_TRAFFIC_LIGHTS ? "5.5rem" : "1rem" }}
            transition={PANEL_COLLAPSE_TRANSITION}
            className="drag-region flex h-11 items-center justify-between pr-4"
          >
            <div className="no-drag flex min-w-0 flex-1 items-center gap-1 pr-3">
              {sidebarCollapsed ? (
                <div className="flex items-center gap-1">
                  {/* With a title bar of our own the sidebar's toggle lives up there,
                      on the same screen as this one; two of them read as a bug. */}
                  {HAS_CUSTOM_TITLE_BAR ? null : (
                    <IconButton
                      size="icon-sm"
                      variant="ghost"
                      label={t("workspace.expandSidebar")}
                      shortcut={toggleSidebarShortcut}
                      onClick={() => setSidebarCollapsed(false)}
                    >
                      <HugeiconsIcon strokeWidth={2} icon={PanelLeftOpenIcon} />
                    </IconButton>
                  )}
                  <IconButton
                    size="icon-sm"
                    variant="ghost"
                    label={t("workspace.newChat")}
                    shortcut={newChatShortcut}
                    onClick={() => void handleNewChat()}
                  >
                    <HugeiconsIcon strokeWidth={2} icon={MessageSquarePlusIcon} />
                  </IconButton>
                </div>
              ) : null}
              {sidebarCollapsed && !isNewSession ? (
                <span className="mx-1.5 h-4 w-px shrink-0 bg-border" aria-hidden />
              ) : null}
              {isNewSession ? null : (
                <h1 className="min-w-0 truncate text-sm font-semibold text-foreground" title={headerTitle}>
                  {headerTitle}
                </h1>
              )}
            </div>
            {paneCollapsed ? (
              <div className="no-drag flex items-center">
                <IconButton
                  size="icon-sm"
                  variant="ghost"
                  label={t("workspace.expandSidePane")}
                  shortcut={toggleSidePaneShortcut}
                  onClick={togglePane}
                >
                  <HugeiconsIcon strokeWidth={2} icon={PanelRightOpenIcon} />
                </IconButton>
              </div>
            ) : null}
          </motion.header>
          {showHero ? (
            // New conversation: the greeting hero sits above the composer and the
            // suggestion chips below it, with the group centred like the reference.
            <div className="flex min-h-0 w-full flex-1 flex-col items-center justify-center gap-6">
              {bannerNode}
              <NewSessionHero />
              <ExtensionWidgets className="pb-2" />
              <GoalPanel className="pb-2" disabled={conversationWorking} />
              <TodoPanel className="pb-2" />
              {composerSlot}
              {/* The suggestion chips write the draft, which a model-less composer refuses to
                  type — offering them there would fill a box the user cannot send from. */}
              {hasModel ? <SuggestionChips onSelect={setDraft} /> : null}
            </div>
          ) : (
            <>
              <div className="relative min-h-0 flex-1">
                <MessageThread
                  loading={loading}
                  onRetry={handleRetry}
                  onEdit={handleEdit}
                  showThinking={settings.showThinking}
                  showTimestamp={settings.showTimestamps}
                  collapseRuns={settings.collapseRuns}
                  findOpen={findOpen}
                  onCloseFind={() => setFindOpen(false)}
                  findQuery={pendingFind}
                  onFindQueryConsumed={() => setPendingFind(null)}
                />
              </div>
              {/* Everything under the transcript shares its column: the transcript's
                  scroller reserves a scrollbar gutter, so this box reserves the same one
                  (`transcript-gutter`) and both columns land on the same edges. */}
              <div className="safe-bottom transcript-gutter overflow-hidden">
                {bannerNode}
                <ExtensionWidgets className="pb-2" />
                <GoalPanel className="pb-2" disabled={conversationWorking} />
                <TodoPanel className="pb-2" />
                {composerSlot}
              </div>
            </>
          )}
        </main>
        {/* Terminal, git diffs, the file tree and the embedded browser all want room a
            phone does not have — and the browser pane has no webview to drive out here
            at all. The conversation is what a narrow screen is for. */}
        {narrow ? null : (
          <SidePane
            cwd={activeProject?.cwd}
            project={active?.project}
            parentId={activeId ?? undefined}
            canSideChat={Boolean(activeId && hasTranscript)}
            onNewChat={() => void handleNewChat()}
            onError={setError}
          />
        )}
      </div>
      {/* Mounted from the first time 设置 is opened and left mounted after, so the
          dialog keeps its own close animation and a section switch costs nothing. */}
      {settingsMounted ? (
        <Suspense fallback={null}>
          <SettingsDialog
            open={settingsOpen}
            onOpenChange={(open) => {
              if (open) {
                navigate("/settings/general");
                return;
              }
              if ((window.history.state?.idx ?? 0) > 0) navigate(-1);
              else navigate(workspacePath(activeId), { replace: true });
            }}
            section={settingsSection}
            models={models}
            onDeleteConversations={handleDeleteConversations}
            onImported={(snapshot) => applySnapshot(snapshot)}
            onProvidersChanged={() => {
              void getModels().then(setModels).catch(() => undefined);
              void engine.getState().then(setSession).catch(() => undefined);
            }}
          />
        </Suspense>
      ) : null}
      <CommandPalette
        open={commandOpen}
        conversations={conversations}
        projects={projects}
        activeId={activeId}
        onOpenChange={setCommandOpen}
        onSelectChat={(id, findQuery) => void handleOpen(id, "user", findQuery)}
        onNewChat={() => void handleNewChat()}
        onAddProject={() => void handleAddProject()}
        onOpenSettings={(section) => navigate(`/settings/${section}`)}
      />
      <PermissionDialog
        key={pendingDialog?.id ?? "permission"}
        request={pendingDialog}
        onRespond={handlePermissionRespond}
      />
      {/* 重试时询问文件回退. A retry rewinds the conversation, and this is the same
          question for the working tree the turn wrote — asked, not assumed, because
          the user may have touched those files by hand since. */}
      <AlertDialog open={retryRewind !== null} onOpenChange={(open) => { if (!open) setRetryRewind(null); }}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t("rewind.title")}</AlertDialogTitle>
            <AlertDialogDescription>
              {t("rewind.description", { count: retryRewind?.paths.length ?? 0 })}
            </AlertDialogDescription>
          </AlertDialogHeader>
          {retryRewind ? (
            <ul className="max-h-40 space-y-0.5 overflow-y-auto text-xs text-muted-foreground">
              {retryRewind.paths.map((path) => (
                <li key={path} className="truncate font-mono" title={path}>
                  {path}
                </li>
              ))}
            </ul>
          ) : null}
          <AlertDialogFooter>
            {/* "Keep the file changes" still retries — it answers the *file* question,
                not whether to retry at all. A Cancel that only closed the dialog made
                the whole 重试 click a no-op the moment a turn had written a file. */}
            <AlertDialogCancel
              onClick={() => {
                const pending = retryRewind;
                setRetryRewind(null);
                if (pending) void runRetry(pending.message);
              }}
            >
              {t("rewind.keep")}
            </AlertDialogCancel>
            <AlertDialogAction
              onClick={() => {
                const pending = retryRewind;
                setRetryRewind(null);
                if (!pending) return;
                // The chat this retry belongs to, captured now: the restore is a round
                // trip and the user can switch chats while it runs.
                const owner = useSessionStore.getState().activeId;
                void (async () => {
                  if (owner) {
                    try {
                      const result = await window.fastvibe.engine.restoreCheckpoint(owner);
                      // A file the turn created but could not be put back (binary, too
                      // large, or a path git will not hand over) must be said out loud —
                      // silently "reverting" and then retrying on a half-restored tree is
                      // the failure this whole feature exists to prevent.
                      if (result.skipped > 0) {
                        setError(t("rewind.partial", { count: result.skipped }));
                      }
                    } catch (err) {
                      setError(err instanceof Error ? err.message : String(err));
                    }
                  }
                  await runRetry(pending.message);
                })();
              }}
            >
              {t("rewind.revert")}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
      <ExtensionNotices />
    </div>
  );
}
