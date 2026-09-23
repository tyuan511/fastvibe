import { lazy, memo, Suspense, useCallback, useEffect, useRef, useState, type JSX } from "react";
import { usePanelRef } from "react-resizable-panels";
import { motion } from "motion/react";
import { HugeiconsIcon } from "@hugeicons/react";
import { MessageSquarePlusIcon, PanelLeftOpenIcon, PanelRightOpenIcon } from "@hugeicons/core-free-icons";
import { useLocation, useMatch, useNavigate, useNavigationType } from "react-router";
import { Composer } from "@/components/chat/composer";
import { AddProjectDialog } from "@/components/add-project-dialog";
import { GitStatusPopover } from "@/components/chat/git-status-popover";
import { ExtensionNotices, ExtensionWidgets, GoalPanel } from "@/components/chat/extension-surface";
import { TodoPanel } from "@/components/chat/todo-list";
import { MessageList } from "@/components/chat/message-list";
import { NewSessionHero, SuggestionChips } from "@/components/chat/new-session";
import { PermissionDialog } from "@/components/chat/permission-dialog";
import { FullDiskAccessPrompt } from "@/components/full-disk-access";
import { PermissionPanel, type PermissionResponse } from "@/components/chat/permission-panel";
import { usagePercent } from "@/components/chat/session-controls";
import { Sidebar } from "@/components/layout/sidebar";
import { SidePane, disposeSidePaneTabs } from "@/components/layout/side-pane";
import { forgetFileTree } from "@/lib/file-tree-state";
import { forgetSidebarProject } from "@/lib/sidebar-project-state";
import { handleBrowserRequest } from "@/components/layout/side-pane-browser";
import { PANEL_COLLAPSE_TRANSITION } from "@/components/layout/collapsible-panel";
import { ResizableHandle, ResizablePanel, ResizablePanelGroup } from "@/components/ui/resizable";
import { CommandPalette } from "@/components/layout/command-palette";
import { TitleBar } from "@/components/layout/title-bar";
import { HAS_CUSTOM_TITLE_BAR, HAS_TRAFFIC_LIGHTS } from "@/lib/platform";
import { isRemoteRef, shouldFollowCatalogActive } from "@/lib/remote-project";
import { createConversationRefresh } from "@/lib/conversation-refresh";
import { sameServerScope } from "../../shared/server-scope.ts";
import { Toaster } from "@/components/ui/sonner";
import { toast } from "sonner";
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
import { attachmentPromptSuffix, attachmentsToImages, pastedTextAttachmentName } from "@/lib/attachments";
import {
  engine,
  getModels,
  getStatus,
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
import { resolvePath } from "@/lib/workspace-path";
import { shouldQueueSubmission } from "@/lib/composer-race";

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
  EngineModel,
  FastVibeModel,
  PermissionMode,
  PermissionRequest,
  QueuedPrompt,
  QueuedPromptPreview,
  SkillInfo,
  SlashCommand,
  WorkspaceSnapshot,
} from "@shared/types";
import { parseCompactCommand } from "@shared/slash";
import { conversationIdFromHash, conversationIdFromPath, conversationPath, workspacePath } from "@/lib/routes";
import { useSidePaneStore } from "@/stores/side-pane";
import { useAppShortcuts, useShortcutLabel } from "@/lib/use-shortcuts";
import { archiveConversations, archivedIdList, restoreConversations, useArchivedIds } from "@/stores/archive";
import { Ipc } from "@shared/ipc";
import { blockedRemotely } from "@/lib/remote-unavailable";
import { useStable } from "@/lib/use-stable";
import { isAbortOutcome } from "@shared/abort";
import { usePermissionModeSelection } from "@/components/permission-mode-provider";



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

type PersistedDraft = {
  draft: string;
  attachments: ChatAttachment[];
  model?: EngineModel;
  thinkingLevel?: string;
  permissionMode?: PermissionMode;
};

function isStoredModel(value: unknown): value is EngineModel {
  if (!value || typeof value !== "object") return false;
  const model = value as Partial<EngineModel>;
  return typeof model.provider === "string" && model.provider.length > 0 && typeof model.id === "string" && model.id.length > 0;
}

function isStoredAttachment(value: unknown): value is ChatAttachment {
  if (!value || typeof value !== "object") return false;
  const attachment = value as Partial<ChatAttachment>;
  return (
    typeof attachment.id === "string" &&
    (attachment.kind === "image" || attachment.kind === "file") &&
    typeof attachment.name === "string"
  );
}

function isStoredPermissionMode(value: unknown): value is PermissionMode {
  return value === "ask" || value === "smart" || value === "full";
}

function readDrafts(): Record<string, PersistedDraft> {
  try {
    const parsed = JSON.parse(localStorage.getItem(DRAFT_KEY) ?? "{}");
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    const drafts: Record<string, PersistedDraft> = {};
    for (const [id, value] of Object.entries(parsed)) {
      if (!value || typeof value !== "object" || Array.isArray(value)) continue;
      const item = value as Partial<PersistedDraft>;
      if (typeof item.draft !== "string") continue;
      drafts[id] = {
        draft: item.draft,
        attachments: Array.isArray(item.attachments) ? item.attachments.filter(isStoredAttachment) : [],
        ...(isStoredModel(item.model) ? { model: item.model } : {}),
        ...(typeof item.thinkingLevel === "string" ? { thinkingLevel: item.thinkingLevel } : {}),
        ...(isStoredPermissionMode(item.permissionMode) ? { permissionMode: item.permissionMode } : {}),
      };
    }
    return drafts;
  } catch {
    return {};
  }
}

function writeDraft(id: string | null, state: PersistedDraft): void {
  if (!id) return;
  try {
    const drafts = readDrafts();
    const hasPayload = Boolean(
      state.draft ||
      state.attachments.length > 0 ||
      state.model ||
      state.thinkingLevel ||
      state.permissionMode,
    );
    if (hasPayload) drafts[id] = state;
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

function useDraftPersistence(
  activeId: string | null,
  draft: string,
  attachments: ChatAttachment[],
  model: EngineModel | undefined,
  thinkingLevel: string | undefined,
  permissionMode: PermissionMode,
  emptySession: boolean,
): void {
  const pending = useRef<{ id: string | null; state: PersistedDraft } | null>(null);
  const timer = useRef<number | null>(null);

  const flush = useCallback(() => {
    if (timer.current !== null) {
      window.clearTimeout(timer.current);
      timer.current = null;
    }
    const entry = pending.current;
    pending.current = null;
    if (entry) writeDraft(entry.id, entry.state);
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
    pending.current = {
      id: activeId,
      state: {
        draft,
        attachments,
        // Model, thinking strength and permission are meaningful as a bundle for an
        // empty project session. A completed chat keeps only its ordinary composer
        // draft, so opening history cannot silently change its controls.
        ...(emptySession && model ? { model } : {}),
        ...(emptySession && thinkingLevel ? { thinkingLevel } : {}),
        ...(emptySession ? { permissionMode } : {}),
      },
    };
    if (timer.current === null) timer.current = window.setTimeout(flush, DRAFT_DEBOUNCE_MS);
  }, [activeId, attachments, draft, emptySession, flush, model, permissionMode, thinkingLevel]);

  // `beforeunload`, not the effect cleanup: a window closing never unmounts.
  useEffect(() => {
    window.addEventListener("beforeunload", flush);
    return () => {
      window.removeEventListener("beforeunload", flush);
      flush();
    };
  }, [flush]);
}

// Capture the displayed conversation for both routing and reply ownership. Calling
// the raw bridge without an id reads Main's local active chat, even while a remote
// conversation is on screen — and used to replace that remote transcript every turn.
// The incremental tail read (`getMessagesSince`) lives in the same module.
const { refreshStats, reloadActiveState, reloadActiveMessages } =
  createConversationRefresh(engine, useSessionStore.getState);

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
  loadingReplaces = false,
  onRetry,
  onEdit,
  onFork,
  showThinking,
  showTimestamp,
  collapseRuns,
}: {
  loading: boolean;
  /** Show the loader in place of whatever transcript is already on screen. */
  loadingReplaces?: boolean;
  onRetry: (message: ChatMessage) => void;
  onEdit: (message: ChatMessage, text: string) => void;
  onFork: (entryId: string) => void;
  showThinking: boolean;
  showTimestamp: boolean;
  collapseRuns: boolean;
}): JSX.Element {
  const messages = useSessionStore((state) => state.messages);
  const streaming = useSessionStore((state) => state.streaming);
  const activeId = useSessionStore((state) => state.activeId);
  const addSelectionToConversation = useCallback((text: string) => {
    const store = useSessionStore.getState();
    const attachment: ChatAttachment = {
      id: crypto.randomUUID(),
      kind: "file",
      name: pastedTextAttachmentName(text),
      mimeType: "text/plain",
      text,
    };
    store.setComposer(store.draft, [...store.attachments, attachment]);
  }, []);
  const askSelectionInSideChat = useCallback((text: string) => {
    if (!activeId) return;
    const sidePane = useSidePaneStore.getState();
    const attachment: ChatAttachment = {
      id: crypto.randomUUID(),
      kind: "file",
      name: pastedTextAttachmentName(text),
      mimeType: "text/plain",
      text,
    };
    sidePane.openSideChat(
      activeId,
      sidePane.nextSideChatOrdinal(activeId),
      text,
      true,
      [attachment],
    );
  }, [activeId]);
  return (
    <MessageList
      messages={messages}
      streaming={streaming}
      loading={loading}
      loadingReplaces={loadingReplaces}
      onRetry={onRetry}
      onEdit={onEdit}
      onFork={onFork}
      onAddSelectionToConversation={activeId ? addSelectionToConversation : undefined}
      onAskSelectionInSideChat={activeId ? askSelectionInSideChat : undefined}
      showThinking={showThinking}
      showTimestamp={showTimestamp}
      collapseRuns={collapseRuns}
    />
  );
});

/**
 * The composer's own subscription to what is being typed.
 *
 * `draft` and `attachments` change on every keystroke, and `App` is the shell: the
 * sidebar, the transcript, the side pane and every dialog are built in its render, so
 * reading them there re-rendered all of it per character — a cost that grows with the
 * number of conversations in the sidebar and the number of rows mounted in the thread.
 * The composer's element is built by `render` instead, so a keystroke re-renders this
 * and the composer alone. The same trick `MessageThread` uses for the transcript.
 */
function ComposerSlot({
  render,
}: {
  render: (draft: string, attachments: ChatAttachment[]) => JSX.Element;
}): JSX.Element {
  const draft = useSessionStore((state) => state.draft);
  const attachments = useSessionStore((state) => state.attachments);
  return render(draft, attachments);
}

/**
 * Draft persistence, kept out of the shell for the same reason — and out of the
 * composer's own slot, which an extension prompt takes over while a question is
 * parked, so the debounce is not torn down and re-armed by an approval.
 */
function DraftKeeper(): null {
  const activeId = useSessionStore((state) => state.activeId);
  const draft = useSessionStore((state) => state.draft);
  const attachments = useSessionStore((state) => state.attachments);
  const model = useSessionStore((state) => state.session?.model);
  const thinkingLevel = useSessionStore((state) => state.session?.thinkingLevel);
  const permissionMode = useSettingsStore((state) => state.settings.permissionMode);
  const emptySession = useSessionStore((state) => {
    const conversation = state.conversations.find((item) => item.id === state.activeId);
    return Boolean(conversation && !conversation.preview);
  });
  useDraftPersistence(activeId, draft, attachments, model, thinkingLevel, permissionMode, emptySession);
  return null;
}

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
  const setStatus = useSessionStore((state) => state.setStatus);
  const setSession = useSessionStore((state) => state.setSession);
  const setModels = useSessionStore((state) => state.setModels);
  const setStats = useSessionStore((state) => state.setStats);
  const applySnapshot = useSessionStore((state) => state.applySnapshot);
  const setActiveId = useSessionStore((state) => state.setActiveId);
  const setMessages = useSessionStore((state) => state.setMessages);
  const setDraft = useSessionStore((state) => state.setDraft);
  const setStoreError = useSessionStore((state) => state.setError);
  const setError = useCallback(
    (message: string | null) => {
      if (message) toast.error(message);
      else setStoreError(null);
    },
    [setStoreError],
  );
  const addUserMessage = useSessionStore((state) => state.addUserMessage);
  const applyEvent = useSessionStore((state) => state.applyEvent);
  const setStreaming = useSessionStore((state) => state.setStreaming);
  const dropEmptyAssistant = useSessionStore((state) => state.dropEmptyAssistant);
  const rollbackOptimisticPrompt = useSessionStore((state) => state.rollbackOptimisticPrompt);
  const resetConversation = useSessionStore((state) => state.resetConversation);
  const commands = useSessionStore((state) => state.commands);
  const permission = useSessionStore((state) => state.permission);
  const setCommands = useSessionStore((state) => state.setCommands);
  const setSubagents = useSessionStore((state) => state.setSubagents);
  const resolvePermission = useSessionStore((state) => state.resolvePermission);
  const allQueued = useSessionStore((state) => state.queued);
  const queued = activeId
    ? allQueued.filter((item) => item.conversationId === activeId)
    : [];
  const permissionAlways = usePermissionAlways();
  const setAttachments = useSessionStore((state) => state.setAttachments);
  const setComposer = useSessionStore((state) => state.setComposer);
  const restoreComposer = useSessionStore((state) => state.restoreComposer);
  const queuePause = useSessionStore((state) => state.queuePause);
  const setQueueState = useSessionStore((state) => state.setQueueState);
  const setRunInterrupted = useSessionStore((state) => state.setRunInterrupted);
  const setCanResume = useSessionStore((state) => state.setCanResume);
  const restoreId = useRef<string | null>(null);
  /**
   * The latest `handleOpen`, so the `workspace:changed` subscription below can mount
   * once and still call the current one.
   *
   * Calling the mount-time closure instead would reach a `revealConversation` holding
   * the pathname as it was at mount, which compares wrong forever and pushes a history
   * entry for a route the app is already on.
   */
  const openLatest = useRef<((id: string, source?: "user" | "history" | "remote") => Promise<void>) | null>(null);
  /**
   * The conversation this client believes it should be showing.
   *
   * Not the same as `activeId`, which is where it *has arrived*. The gap between the
   * two is the whole reason this exists: `openConversation` in Main marks the catalog
   * active before it loads the transcript, so the `workspace:changed` push (debounced
   * 40ms) routinely overtakes the reply to the very call that caused it. A client
   * comparing the push against `activeId` alone sees an id it has not reached yet,
   * decides someone else must have switched, and fires a second identical open — a
   * duplicate transcript fetch on every switch, which over a tunnel is the expensive
   * kind. Claiming the id before the call closes that window, and keeps two pushes in
   * quick succession (the open, then the abandoned-draft cleanup) from doing it either.
   */
  const intendedActiveId = useRef<string | null>(null);
  // The catalog push always carries this machine's own active conversation, even when
  // the change came from a remote server. Following it on every push would yank the
  // view back to that local chat whenever a remote project gained a conversation.
  // Only a push whose active id actually changed is someone else navigating, and a
  // local id never pulls the window off a remote conversation.
  const followedActiveId = useRef<string | null | undefined>(undefined);
  // Bumped on every open/create so a slow remote transcript cannot land after the
  // user has already moved on, and so the loader is cleared only by the latest one.
  const openingTicket = useRef(0);
  const [opening, setOpening] = useState(false);
  const [openingId, setOpeningId] = useState<string | null>(null);
  // Invalidates model/thinking restoration from an older conversation open. A slow
  // provider reply must never overwrite a choice made after the user switched again.
  const openGeneration = useRef(0);
  // One send at a time. A second click / Enter while this send is still being handed
  // over is not a second message — see `handleSubmit`.
  const submitting = useRef(false);
  // A send made while Stop is still settling must wait for that stop, then start a
  // fresh run rather than being mistaken for a follow-up to the run being stopped.
  const abortInFlight = useRef(new Map<string, Promise<void>>());
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
  const [addProjectOpen, setAddProjectOpen] = useState(false);
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
  const { setPermissionMode } = usePermissionModeSelection();
  const updateSettings = useSettingsStore((state) => state.update);
  const sidebarCollapsed = useSidebarCollapsed();
  // A phone has no width to give the sidebar or the right pane; the first overlays
  // (`CollapsiblePanel overlay`) and the second is simply not there.
  const narrow = useIsNarrowViewport();
  const archivedIds = useArchivedIds();
  // Maximised hands the window to the side pane. Emptying the conversation column
  // rather than unmounting it keeps the shell one three-panel group the library can
  // undo, and keeps the transcript (and its scroll position) where it was.
  //
  // Two details. A frame's delay, because the pane lifts its own size ceiling in
  // response to this flag and that lands a render later: empty the column first and the
  // pane is still capped at two thirds, which hands the leftover back to the sidebar.
  // And `resize` rather than the library's `collapse`, because a collapsible column is
  // one a stray End or Enter on a splitter can park, and the conversation is the one
  // panel that must never disappear on a keypress.
  const conversationPanel = usePanelRef();
  const conversationWidth = useRef<number | null>(null);
  useEffect(() => {
    const frame = requestAnimationFrame(() => {
      const panel = conversationPanel.current;
      if (!panel) return;
      if (paneMaximized) {
        // A share, not pixels: the column keeps its proportion if the window is
        // resized while the pane owns it.
        conversationWidth.current = panel.getSize().asPercentage;
        panel.resize(0);
      } else if (conversationWidth.current !== null) {
        panel.resize(`${conversationWidth.current}%`);
        conversationWidth.current = null;
      }
    });
    return () => cancelAnimationFrame(frame);
  }, [paneMaximized]);
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
    /**
     * The catalog, whenever anything changes it — this window, a second window, or a
     * phone over remote access.
     *
     * `applySnapshot` takes the projects and the conversations only; the active
     * conversation is followed separately below, because adopting it is a *navigation*
     * and has to go through the same path a click does.
     */
    const offWorkspace = window.fastvibe.conversations.onChanged((snapshot) => {
      applySnapshot(snapshot);
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
  });

  useEffect(() => {
    if (status.state !== "ready") return;
    void setAutoCompaction(settings.autoCompact).catch(() => undefined);
    void setInterruptMode(settings.interruptMode).catch(() => undefined);
    if (settings.thinkingLevel !== "auto") {
      void engine
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
    void engine
      .setThinking(settings.thinkingLevel)
      .then(setSession)
      .catch(() => undefined);
  }, [settings.thinkingLevel, status.state, setSession]);

  useEffect(() => {
    if (status.state !== "ready") return;
    void engine
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
  // Unbound conversations run in a hidden scratch dir, so never surface that path.
  const workspaceLabel = activeProject?.name ?? t("workspace.noProject");

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

  // Global engine failures and the model-less first-run nudge belong in the toast
  // layer, rather than taking space from the transcript and composer.
  useEffect(() => {
    if (!engineKnown || status.state === "starting") return;
    if (status.state === "missing" || status.state === "error") {
      toast.error(t("errors.cannotStart"), {
        id: "engine-start-error",
        action: {
          label: t("alert.retry"),
          onClick: () => void start(status.cwd),
        },
      });
    }
  }, [engineKnown, status.state, status.cwd, t]);

  useEffect(() => {
    if (models.length > 0) setNeedsModel(false);
  }, [models.length]);

  useEffect(() => {
    if (!needsModel) return;
    toast.info(t("alert.noModelTitle"), {
      id: "no-model",
      description: t("alert.noModelDesc"),
      action: {
        label: t("alert.goSettings"),
        onClick: () => navigate("/settings/providers"),
      },
    });
  }, [needsModel, navigate, t]);

  function applyOpen(result: ConversationOpenResult): void {
    applySnapshot(result);
    // Every path that makes a conversation active locally ends here — a click, a new
    // chat, a side chat, plan mode's handoff — so this is where the claim is kept
    // honest for the ones that could not know the id before they called.
    intendedActiveId.current = result.conversation.id;
    const generation = ++openGeneration.current;
    const savedComposer = useSessionStore.getState().composerDrafts[result.conversation.id];
    const persisted = readDrafts()[result.conversation.id];
    const emptySession = !result.conversation.preview;
    const restorePersistedState = emptySession && !savedComposer;
    // Hydrate the visible session state synchronously as well as correcting Main below.
    // Otherwise DraftKeeper could see Main's default model for one render and overwrite
    // the project's saved choice before the asynchronous setModel call returned. An
    // in-memory composer is newer than localStorage, so it wins on same-window switches.
    const restoredState = restorePersistedState && result.state
      ? {
          ...result.state,
          ...(persisted?.model ? { model: persisted.model } : {}),
          ...(persisted?.thinkingLevel ? { thinkingLevel: persisted.thinkingLevel } : {}),
        }
      : result.state;
    setActiveId(result.conversation.id);
    setMessages(result.messages, result.conversation.id);
    setSession(restoredState);
    setStatus(result.status);
    setQueueState(result.queue);
    // The goal (or plan mode) this conversation already had, replayed by the engine:
    // its own `setStatus` fired during session creation, which on a cold start is
    // before this window was listening.
    useSessionStore.getState().setExtensionStatus(result.conversation.id, result.extensionStatus ?? {});
    // In-memory composer state is newer than the debounced localStorage write and
    // includes attachments. Only hydrate from disk the first time this window opens it.
    if (!savedComposer) {
      setComposer(persisted?.draft ?? "", persisted?.attachments ?? []);
    }
    if (emptySession && persisted?.permissionMode && persisted.permissionMode !== settings.permissionMode) {
      // The normal permission picker still owns the full-access confirmation. A saved
      // full choice is therefore restored through the same guarded path, never by
      // writing the sandbox setting directly.
      setPermissionMode(persisted.permissionMode);
    }
    if (restorePersistedState && (persisted?.model || persisted?.thinkingLevel)) {
      // Keep the two SDK mutations ordered: changing the model re-clamps thinking,
      // so a concurrent restore could let the model response overwrite the saved
      // thinking level again.
      void (async () => {
        let next = result.state;
        const current = (): boolean =>
          openGeneration.current === generation && useSessionStore.getState().activeId === result.conversation.id;
        if (!current()) return;
        if (persisted.model) {
          try {
            next = await engine.setModel(persisted.model.provider, persisted.model.id, result.conversation.id);
          } catch {
            // The provider may have been removed since this draft was saved; retain
            // Main's authoritative state rather than the invalid saved model.
          }
        }
        if (!current()) return;
        if (persisted.thinkingLevel) {
          try {
            next = await engine.setThinking(persisted.thinkingLevel, result.conversation.id);
          } catch {
            // The model may no longer support the saved thinking level.
          }
        }
        if (next && current()) setSession(next);
      })();
    }
    setError(null);
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
    // Reserve the send before any await, including waiting for Stop. Otherwise two
    // Enter presses can both resume after the same abort and submit twice.
    submitting.current = true;
    let consumedOwner: string | null = null;
    let consumedVersion: number | undefined;
    let submitOwner: string | null = null;
    let text = "";
    let currentAttachments: ChatAttachment[] = [];
    let queuePreview: QueuedPromptPreview | undefined;
    try {
      // Stop and Send are separate UI events. If Send wins the renderer race, wait for
      // Main to finish the stop instead of putting this fresh prompt into the queue of
      // the run the user just stopped. Re-read the composer after the await: the user
      // may have edited it while the stop was settling.
      const initialOwner = useSessionStore.getState().activeId;
      const abortPromise = initialOwner ? abortInFlight.current.get(initialOwner) : undefined;
      if (abortPromise) {
        try {
          await abortPromise;
        } catch {
          // handleAbort already reported the failed stop. Do not send into a session
          // whose termination was not confirmed.
          return;
        }
        if (useSessionStore.getState().activeId !== initialOwner) return;
      }

      const submitState = useSessionStore.getState();
      submitOwner = submitState.activeId;
      text = submitState.draft.trim();
      const queueAtSubmit = shouldQueueSubmission({
        hasConversation: submitOwner !== null,
        running: Boolean(submitOwner && submitState.running[submitOwner]),
        hasQueuedItems: Boolean(
          submitOwner && submitState.queued.some((item) => item.conversationId === submitOwner),
        ),
        stopConfirmed: Boolean(abortPromise),
      });
      const queueBehavior = settings.queueBehavior;
      currentAttachments = submitState.attachments;
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
      // Nothing to run a turn on: keep the draft and ask for a model. Creating the
      // conversation first would leave a chat whose prompt the engine then refuses.
      if ((await availableModels()).length === 0) {
        if (useSessionStore.getState().activeId === submitOwner) setNeedsModel(true);
        return;
      }
      // An await above may have crossed a chat switch. This submission still belongs
      // to the composer it captured; it must not clear or send the incoming chat's draft.
      if (useSessionStore.getState().activeId !== submitOwner) return;
      // The text the engine will actually receive, and therefore also the text the
      // row shows: they used to differ (file names in the bubble, `请查看附件` in the
      // engine), so re-reading the transcript silently rewrote the message.
      const promptText = text || t("composer.seeAttachments");
      // Consume the composer before any further await: from here the draft and the
      // attachments belong to this call, so a second click finds an empty composer
      // (and a disabled send button) instead of re-sending the same prompt without
      // its text.
      setComposer("", []);
      let conversationId = submitOwner;
      if (!conversationId) {
        const created = await window.fastvibe.conversations.create(active?.project);
        applyOpen(created);
        conversationId = created.conversation.id;
        revealConversation(conversationId);
      }
      consumedOwner = conversationId;
      consumedVersion = useSessionStore.getState().composerDrafts[conversationId]?.version;
      const beforePrompt = useSessionStore.getState().conversations.find((item) => item.id === conversationId);
      const nextList = await window.fastvibe.conversations.recordPrompt(conversationId, promptText);
      applyList(nextList);
      const afterPrompt = nextList.conversations.find((item) => item.id === conversationId);
      if (beforePrompt && afterPrompt) {
        queuePreview = {
          previousTitle: beforePrompt.title,
          previousPreview: beforePrompt.preview,
          nextTitle: afterPrompt.title,
          nextPreview: afterPrompt.preview,
        };
      }
      // Queue semantics belong to the instant Send was pressed. A stop can settle the
      // run during recordPrompt; routing an actual follow-up through prompt() would
      // restart it and a late renderer reply could also erase Main's stopped pause.
      // A send that raced Stop waited above and is intentionally a fresh prompt.
      if (queueAtSubmit) {
        const payload = `${promptText}${attachmentPromptSuffix(currentAttachments)}`;
        try {
          const queue = await window.fastvibe.engine.queueAdd({
            conversationId,
            text: promptText,
            message: payload,
            behavior: queueBehavior,
            attachments: currentAttachments,
            images: attachmentsToImages(currentAttachments),
            preview: queuePreview,
          });
          setQueueState(queue);
        } catch (err) {
          // Main never accepted the item. Restore only the composer this submission
          // consumed; a chat switch gives ownership to a different draft.
          if (consumedVersion !== undefined) {
            restoreComposer(conversationId, text, currentAttachments, consumedVersion);
          }
          if (queuePreview) {
            void window.fastvibe.conversations
              .restorePrompt({
                id: conversationId,
                expectedTitle: queuePreview.nextTitle,
                expectedPreview: queuePreview.nextPreview,
                title: queuePreview.previousTitle,
                preview: queuePreview.previousPreview,
              })
              .then(applyList)
              .catch(() => undefined);
          }
          if (useSessionStore.getState().activeId === conversationId) {
            setError(err instanceof Error ? err.message : String(err));
          }
        }
        return;
      }
      // recordPrompt is another switch-sized IPC hop. Sending still belongs to the
      // captured conversation, but its optimistic row must never land in the chat
      // that is on screen now (nor clear that chat's attachments).
      const stillActive = useSessionStore.getState().activeId === conversationId;
      if (stillActive) addUserMessage(promptText, currentAttachments);
      // A fresh prompt supersedes an interrupted turn: drop the resume affordance now
      // so the button does not linger until the engine's `agent_start` lands.
      if (stillActive) {
        setRunInterrupted(null);
        setCanResume(false);
      }
      // Not awaited either: `prompt()` resolves only when the whole run is over, and
      // holding the guard until then would refuse every follow-up sent mid-run.
      void dispatchPrompt(text, currentAttachments, conversationId).catch((err: unknown) => {
        // Stop rejects some transports with the original AbortError. The engine has
        // already retained the interrupted turn, so rolling it back or showing a red
        // toast would misreport an intentional cancellation as a failed send.
        if (isAbortOutcome(err)) return;
        if (stillActive && useSessionStore.getState().activeId === conversationId) {
          rollbackOptimisticPrompt();
          setError(err instanceof Error ? err.message : String(err));
        }
        if (consumedVersion !== undefined) {
          restoreComposer(conversationId, text, currentAttachments, consumedVersion);
        }
      });
    } catch (err) {
      // Nothing reached the engine: hand back only the composer this call consumed.
      if (consumedOwner && consumedVersion !== undefined) {
        restoreComposer(consumedOwner, text, currentAttachments, consumedVersion);
      } else if (useSessionStore.getState().activeId === submitOwner) {
        setComposer(text, currentAttachments);
      }
      if (useSessionStore.getState().activeId === (consumedOwner ?? submitOwner)) {
        setError(err instanceof Error ? err.message : String(err));
      }
    } finally {
      submitting.current = false;
    }
  }

  async function dispatchPrompt(
    text: string,
    files: ChatAttachment[],
    conversationId: string,
  ): Promise<void> {
    const payload = `${text || t("composer.seeAttachments")}${attachmentPromptSuffix(files)}`;
    const images = attachmentsToImages(files);
    await engine.prompt(payload, { images, conversationId });
    void engine
      .getState(conversationId)
      .then((next) => {
        if (useSessionStore.getState().activeId === conversationId) setSession(next);
      })
      .catch(() => undefined);
  }

  function queueActionError(err: unknown, conversationId?: string): void {
    if (!conversationId || useSessionStore.getState().activeId === conversationId) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  async function handleRemoveQueued(id: string): Promise<void> {
    const owner = useSessionStore.getState().queued.find((entry) => entry.id === id)?.conversationId;
    try {
      const queue = await window.fastvibe.engine.queueCancel(id);
      if (queue) setQueueState(queue);
    } catch (err) {
      queueActionError(err, owner);
    }
  }

  function handleEditQueued(id: string): void {
    const state = useSessionStore.getState();
    const item = state.queued.find((entry) => entry.id === id);
    // A queued item replaces the whole composer payload. Existing files count as a
    // draft just as much as text does; silently overwriting them loses user input.
    if (!item || item.sending || state.draft.trim() || state.attachments.length > 0) return;
    const previous = { draft: state.draft, attachments: state.attachments };
    // Reserve the payload before asking Main to delete the queue row. If the user
    // switches chats, this reservation follows its owner and is waiting on return.
    setComposer(item.text, item.attachments ?? []);
    const reservedVersion = useSessionStore.getState().composerDrafts[item.conversationId]?.version;
    void window.fastvibe.engine.queueCancel(id).then((queue) => {
      if (!queue) {
        if (reservedVersion !== undefined) {
          restoreComposer(item.conversationId, previous.draft, previous.attachments, reservedVersion);
        }
        return;
      }
      setQueueState(queue);
    }).catch((err: unknown) => {
      if (reservedVersion !== undefined) {
        restoreComposer(item.conversationId, previous.draft, previous.attachments, reservedVersion);
      }
      queueActionError(err, item.conversationId);
    });
  }

  async function handleRecallQueued(id: string): Promise<void> {
    const owner = useSessionStore.getState().queued.find((entry) => entry.id === id)?.conversationId;
    try {
      const queue = await window.fastvibe.engine.queueRecall(id);
      if (queue) setQueueState(queue);
    } catch (err) {
      queueActionError(err, owner);
    }
  }

  async function handleSendQueuedNow(id: string): Promise<void> {
    const owner = useSessionStore.getState().queued.find((entry) => entry.id === id)?.conversationId;
    try {
      const queue = await window.fastvibe.engine.queueSendNow(id);
      if (queue) setQueueState(queue);
    } catch (err) {
      queueActionError(err, owner);
    }
  }

  function handleReorderQueued(ids: string[]): void {
    const conversationId = useSessionStore.getState().activeId;
    if (!conversationId) return;
    void window.fastvibe.engine.queueReorder(conversationId, ids).then(setQueueState)
      .catch((err: unknown) => setError(err instanceof Error ? err.message : String(err)));
  }

  function handleResumeQueue(): void {
    const conversationId = useSessionStore.getState().activeId;
    if (!conversationId) return;
    void window.fastvibe.engine.queueResume(conversationId).then(setQueueState)
      .catch((err: unknown) => setError(err instanceof Error ? err.message : String(err)));
  }

  async function handleAbort(): Promise<void> {
    const conversationId = useSessionStore.getState().activeId;
    if (!conversationId) return;

    // Publish the promise before awaiting it so a concurrent Send can establish an
    // ordering point. The promise rejects on an unconfirmed stop; Send then leaves
    // the composer alone instead of racing a still-running SDK session.
    let abortConfirmed = false;
    const abortPromise = (async (): Promise<void> => {
      await engine.abort(conversationId);
      abortConfirmed = true;
      if (useSessionStore.getState().activeId === conversationId) setStreaming(false);
      void engine
        .getState(conversationId)
        .then((next) => {
          if (useSessionStore.getState().activeId === conversationId) setSession(next);
        })
        .catch(() => undefined);
    })();
    abortInFlight.current.set(conversationId, abortPromise);
    try {
      await abortPromise;
    } catch (err) {
      if (useSessionStore.getState().activeId === conversationId) {
        setError(err instanceof Error ? err.message : String(err));
      }
    } finally {
      // Keep a failed stop as a barrier until the running=false event arrives. A
      // later Send must not infer that the SDK is idle just because a timeout fired.
      if (abortConfirmed && abortInFlight.current.get(conversationId) === abortPromise) {
        abortInFlight.current.delete(conversationId);
      }
    }
  }

  /**
   * Continue the interrupted turn. The engine re-enters the loop from the transcript
   * (no new user message), and the queue stays held: resume must not flush queued
   * follow-ups onto a half-finished reply. Once the resumed run starts, `agent_start`
   * clears `runInterrupted` and unpauses no held row — the queue only resumes when the
   * user explicitly continues it (立即 / 继续发送). Main does drop a pause that holds
   * nothing, so a Send made during the resumed run queues without a stop notice.
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
      if (!isAbortOutcome(err)) {
        setRunInterrupted("error");
        setError(err instanceof Error ? err.message : String(err));
      }
    } finally {
      void engine.getState().then(setSession).catch(() => undefined);
    }
  }

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
      const hasAttachmentMetadata = text.includes("<fastvibe-attachments>") || text.includes("<fastvibe-pasted-text>");
      const payload = hasAttachmentMetadata ? text : `${text}${attachmentPromptSuffix(source?.attachments ?? [])}`;
      try {
        await engine.prompt(payload, {
          images: source?.attachments ? attachmentsToImages(source.attachments) : undefined,
        });
        void engine.getState().then(setSession).catch(() => undefined);
      } catch (err) {
        if (!isAbortOutcome(err)) {
          dropEmptyAssistant();
          setError(err instanceof Error ? err.message : String(err));
        }
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

  const handleFork = useCallback(async (conversationId: string, entryId?: string): Promise<void> => {
    try {
      const forked = await engine.fork(entryId, conversationId);
      applyOpen(forked);
      revealConversation(forked.conversation.id);
    } catch (err) {
      toast.error(t("errors.fork"), {
        description: err instanceof Error ? err.message : String(err),
      });
    }
  }, [t]);

  // Stable for MessageThread/ChatMessageRow memoisation; resolve the owner at click
  // time so a stale toolbar can never fork the conversation now on screen by mistake.
  const handleForkFromEntry = useCallback((entryId: string): void => {
    const owner = useSessionStore.getState().activeId;
    if (owner) void handleFork(owner, entryId);
  }, [handleFork]);

  const handleEdit = useCallback(async (message: ChatMessage, editedText: string): Promise<void> => {
    const owner = useSessionStore.getState().activeId;
    const text = editedText.trim();
    if (!owner || !text || !canChat) return;

    // Entering edit mode is purely local: the original turn remains visible while the
    // user changes the prompt. Only this submit path branches the transcript and starts
    // the replacement turn, so cancelling an inline edit cannot lose the last round.
    const attachments = message.attachments ?? [];
    const promptText = `${text}${attachmentPromptSuffix(attachments)}`;
    const current = useSessionStore.getState();
    if (current.activeId !== owner) return;
    const sourceIndex = current.messages.findIndex((item) => item.id === message.id);
    const trimmed = sourceIndex >= 0 ? current.messages.slice(0, sourceIndex) : current.messages;

    let branched = trimmed;
    if (message.id) {
      try {
        branched = await engine.branch(message.id, owner);
      } catch {
        // A prompt that was just sent may not have been persisted as an entry yet.
        // The local trim still gives the replacement turn the same visible shape.
      }
    }
    if (useSessionStore.getState().activeId !== owner) return;
    setMessages(branched, owner);
    setRunInterrupted(null);
    setCanResume(false);
    addUserMessage(promptText, attachments);
    try {
      await engine.prompt(promptText, {
        images: attachmentsToImages(attachments),
        conversationId: owner,
      });
      void engine.getState(owner).then(setSession).catch(() => undefined);
    } catch (err) {
      if (!isAbortOutcome(err)) {
        dropEmptyAssistant();
        setError(err instanceof Error ? err.message : String(err));
      }
    }
  }, [addUserMessage, canChat, dropEmptyAssistant, setError, setMessages, setRunInterrupted, setCanResume, setSession]);

  /**
   * Mark a transcript fetch in flight.
   *
   * Remote opens wait on a tunnel, so the thread shows a loader instead of the chat
   * being left. Every open bumps the ticket: a reply that belongs to an older one
   * must not paint over the conversation the user has since asked for.
   */
  function beginOpening(id: string | null, showLoader: boolean): number {
    const ticket = openingTicket.current + 1;
    openingTicket.current = ticket;
    setOpening(showLoader);
    setOpeningId(showLoader ? id : null);
    return ticket;
  }

  function openingStillCurrent(ticket: number): boolean {
    return openingTicket.current === ticket;
  }

  function endOpening(ticket: number): void {
    if (!openingStillCurrent(ticket)) return;
    setOpening(false);
    setOpeningId(null);
  }

  /** Empty chats stay off the sidebar until the first prompt is sent. */
  async function handleNewChat(project?: string): Promise<void> {
    setComposerFocus((value) => value + 1);
    let ticket = 0;
    try {
      const current = conversations.find((item) => item.id === activeId);
      // An empty draft can be reused only on the server that already owns it. A remote
      // project is not a folder this conversation can be moved into — that call is
      // refused, and it is what made 新建远程会话 fail while a local draft was open.
      if (current && !current.preview && sameServerScope(current.id, project) && (current.project ?? undefined) === (project || undefined)) {
        ticket = beginOpening(current.id, false);
        setMessages([], current.id);
        setError(null);
        revealConversation(current.id);
        return;
      }
      // Main reuses the unfinished conversation for this project. Do not retarget the
      // current empty chat: its draft belongs to its old project and must remain there.
      ticket = beginOpening(null, isRemoteRef(project));
      const created = await window.fastvibe.conversations.create(project);
      if (!openingStillCurrent(ticket)) return;
      applyOpen(created);
      revealConversation(created.conversation.id);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      if (ticket) endOpening(ticket);
    }
  }

  /**
   * Open a conversation.
   *
   * `source` only decides what happens to the URL. A click pushes a history entry; a
   * back/forward POP has already changed the route and must not push another; a
   * `"remote"` follow — another window or a phone opened this chat — replaces, because
   * the jump was not this person's navigation and should not sit in their back stack.
   * Everything else is the same path on purpose: a followed switch reloads the
   * transcript while leaving the project's unfinished composer session intact, which
   * keeps the two clients from ending up in states that differ in ways nobody chose.
   */
  async function handleOpen(
    id: string,
    source: "user" | "history" | "remote" = "user",
  ): Promise<void> {
    const store = useSessionStore.getState();
    // Re-opening the active chat is pointless once it has content or a reply is
    // streaming, but it is how an empty/failed conversation gets retried.
    if (id === store.activeId && (store.messages.length > 0 || store.streaming)) {
      beginOpening(id, false);
      intendedActiveId.current = id;
      if (source === "user") revealConversation(id);
      return;
    }
    // Claimed before the hop, not after: the push this call is about to cause can beat
    // its own reply back here (see `intendedActiveId`).
    intendedActiveId.current = id;
    const ticket = beginOpening(id, isRemoteRef(id));
    try {
      const opened = await window.fastvibe.conversations.open(id);
      if (!openingStillCurrent(ticket)) return;
      applyOpen(opened);
      if (source === "user") revealConversation(id);
      else if (source === "remote") revealConversation(id, true);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      endOpening(ticket);
    }
  }

  // Handed to the `workspace:changed` subscription, which mounts once and would
  // otherwise be holding the first render's closure.
  useEffect(() => {
    openLatest.current = handleOpen;
  });

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

  function handleAddRemoteProject(): void {
    setAddProjectOpen(true);
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
   *
   * A run in flight is stopped here: the sidebar has no stop control, so hiding a
   * busy chat without aborting would leave it consuming tokens behind a row the user
   * can no longer reach. The composer's stop is the only explicit one; archive is
   * the implicit one.
   */
  /**
   * Delete an abandoned empty draft.
   *
   * An empty conversation stays off the sidebar until its first prompt, so opening a
   * different chat (or project) leaves it as an invisible row. Discarding it here is
   * best-effort: a failure must not block the navigation that already happened.
   */
  async function discardDraft(id: string | null | undefined): Promise<void> {
    if (!id) return;
    const item = useSessionStore.getState().conversations.find((entry) => entry.id === id);
    if (!item || item.preview) return;
    try {
      applyList(await window.fastvibe.conversations.delete(id));
      disposeSidePaneTabs(useSidePaneStore.getState().forgetScope(id));
      useSidePaneStore.getState().forgetWidths([id]);
      useSessionStore.getState().forgetConversationExtensionState(id);
    } catch {
      // Best-effort cleanup of a draft nothing points at any more.
    }
  }

  async function handleArchiveSession(id: string): Promise<void> {
    const busy = useSessionStore.getState().running[id] === true;
    const title = useSessionStore.getState().conversations.find((item) => item.id === id)?.title || t("workspace.newChat");
    archiveConversations(id);
    // The row simply vanishes, so say where it went — and offer the way back, since a
    // context-menu slip is the usual way a chat gets archived by accident.
    toast.success(t("sidebar.archived", { title }), {
      id: `archived:${id}`,
      action: { label: t("sidebar.undo"), onClick: () => restoreConversations(id) },
    });
    if (busy) {
      void (async () => {
        try {
          await engine.abort(id);
        } catch (err) {
          setError(err instanceof Error ? err.message : String(err));
        }
      })();
    }
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
    const name = useSessionStore.getState().projects.find((item) => item.cwd === cwd)?.name ?? cwd;
    try {
      // The catalog drops the project's conversations with it; their panes go too.
      const doomed = useSessionStore.getState().conversations.filter((item) => item.project === cwd).map((item) => item.id);
      const result = await window.fastvibe.projects.remove(cwd);
      applyList(result);
      for (const id of doomed) {
        disposeSidePaneTabs(useSidePaneStore.getState().forgetScope(id));
        useSessionStore.getState().forgetConversationExtensionState(id);
      }
      useSidePaneStore.getState().forgetWidths(doomed);
      forgetFileTree(cwd);
      forgetSidebarProject(cwd);
      toast.success(t("sidebar.projectRemoved", { name }));
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
        useSidePaneStore.getState().forgetWidths([id]);
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
      const current = conversations.find((item) => item.id === activeId);
      // A conversation can only be moved within the server that owns it. Picking a
      // project on another server creates a conversation there instead — retargeting
      // this one is refused by the gateway.
      if (!current || !current.preview || !sameServerScope(current.id, project)) {
        // Project selection on the hero is a switch between project-owned empty
        // sessions, not a mutation that would strand the current project's draft.
        const previousId = activeId;
        const ticket = beginOpening(null, isRemoteRef(project));
        try {
          const created = await window.fastvibe.conversations.create(project ?? undefined);
          if (!openingStillCurrent(ticket)) return;
          applyOpen(created);
          revealConversation(created.conversation.id);
          await discardDraft(previousId);
        } finally {
          endOpening(ticket);
        }
        return;
      }
      if ((current.project ?? null) === project) return;
      const snapshot = await window.fastvibe.conversations.setProject(activeId!, project);
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
    openGeneration.current += 1;
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
    openGeneration.current += 1;
    try {
      const next = await engine.setThinking(level);
      setSession(next);
    } catch {
      setError(t("errors.thinking"));
    }
  }

  const pendingConversation = openingId
    ? conversations.find((item) => item.id === openingId) ?? null
    : null;
  const headerTitle = opening && !pendingConversation
    ? t("workspace.loadingConversation")
    : (pendingConversation ?? active)?.title ?? t("workspace.newSession");
  // A conversation with no preview yet is still a "new session": it has no title
  // or content to put in the top bar, so the bar is dropped and the project
  // binding is surfaced above the composer instead. A remote open in flight is not
  // that — the transcript is on its way, and the hero would hide the loader.
  const isNewSession = !opening && !active?.preview;
  // `loading` is the engine coming up, never the model question — plus the window
  // before `getStatus()` lands, which the boot splash is already covering.
  const loading = empty && (!engineKnown || status.state === "starting");
  // A fresh conversation swaps the transcript for the centred greeting hero.
  const showHero = empty && !loading && !opening;

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

  /**
   * Stable identities for the shell's two biggest subtrees.
   *
   * `Sidebar` and `SidePane` are memoised, and the handlers below are the only props
   * they take that would otherwise be new on every render of this component — which
   * would have made those memos do nothing at all. `useStable` fixes the identity
   * while still calling the newest closure, so neither subtree is rebuilt for a
   * transcript reload, a stats refresh or a run flag flipping.
   */
  const onSidebarNewChat = useStable((cwd?: string) => void handleNewChat(cwd));
  const onSidebarOpen = useStable((id: string) => void handleOpen(id));
  const onSidebarFork = useStable((id: string) => void handleFork(id));
  const onSidebarArchive = useStable((id: string) => void handleArchiveSession(id));
  const onSidebarAddProject = useStable(() => void handleAddProject());
  const onSidebarAddRemoteProject = useStable(() => handleAddRemoteProject());
  const onSidebarRenameSession = useStable((id: string, title: string) => void handleRenameSession(id, title));
  const onSidebarRenameProject = useStable((cwd: string, name: string) => void handleRenameProject(cwd, name));
  const onSidebarRemoveProject = useStable((cwd: string) => void handleRemoveProject(cwd));
  const onSidebarRevealProject = useStable((cwd: string) => {
    if (blockedRemotely(Ipc.workspaceReveal)) return;
    void window.fastvibe.workspace.reveal(cwd);
  });
  const onSidebarReorderProjects = useStable((cwds: string[]) => void handleReorderProjects(cwds));
  const onSidebarOpenSettings = useStable(() => navigate("/settings/general"));
  const onSidebarOpenMarket = useStable(() => navigate("/settings/extensions"));
  const onSidebarSearch = useStable(() => setCommandOpen(true));
  const onSidePaneNewChat = useStable(() => void handleNewChat());

  const composer = (
    <ComposerSlot
      render={(draft, attachments) => (
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
          onPermissionModeChange={setPermissionMode}
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
          onReorderQueued={handleReorderQueued}
          onResumeQueue={handleResumeQueue}
          canResume={canResume}
          onResumeRun={() => void handleResumeRun()}
          sendOnEnter={settings.sendOnEnter}
          focusSignal={composerFocus}
          onManageModels={() => navigate("/settings/providers")}
        />
      )}
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
      <AddProjectDialog
        open={addProjectOpen}
        onOpenChange={setAddProjectOpen}
        onAdded={(snapshot) => {
          applyList(snapshot);
          void getStatus().then(setStatus).catch(() => undefined);
        }}
      />
      {/* Above everything, including the settings overlay: a refused click is most
          likely to happen in there, and the notice has to be where the click was. */}
      <Toaster />
      {/* Windows and Linux draw the window's own bar here, above the split, so the
          controls the OS used to provide are never missing and never fight the
          sidebar or the right pane for the window's top-right corner. */}
      {HAS_CUSTOM_TITLE_BAR ? <TitleBar onSearch={() => setCommandOpen(true)} /> : null}
      {/* Draws nothing; it is where the draft's debounced write lives, outside the
          composer's slot so a parked approval does not take it down with it. */}
      <DraftKeeper />
      {/*
       * The three columns are one resizable group: the library owns who is how wide,
       * the stores own who is open. Splitters are only rendered where there is a
       * column on both sides to trade width with — a collapsed sidebar or side pane
       * has no edge to drag, and on a narrow layout the sidebar is a full-screen
       * drawer with nothing to give back.
       */}
      <div className="relative flex min-h-0 flex-1">
        <ResizablePanelGroup>
          {/* No backdrop: the drawer covers the whole viewport, so there is no dimmed
              conversation behind it to tap. The button that was here sat under a
              full-screen panel and could never be reached — the sidebar's own
              「收起」 is what closes it. */}
          <Sidebar
            projects={projects}
            conversations={conversations}
            activeId={openingId ?? activeId}
            running={running}
            waitingForUser={waitingForUser}
            onNewChat={onSidebarNewChat}
            onOpen={onSidebarOpen}
            onFork={onSidebarFork}
            onArchive={onSidebarArchive}
            onAddProject={onSidebarAddProject}
            onAddRemoteProject={onSidebarAddRemoteProject}
            onRenameSession={onSidebarRenameSession}
            onRenameProject={onSidebarRenameProject}
            onRemoveProject={onSidebarRemoveProject}
            onRevealProject={onSidebarRevealProject}
            onReorderProjects={onSidebarReorderProjects}
            onOpenSettings={onSidebarOpenSettings}
            onOpenMarket={onSidebarOpenMarket}
            onSearch={onSidebarSearch}
          />
          {narrow || sidebarCollapsed ? null : <ResizableHandle />}
          <ResizablePanel
            id="conversation"
            minSize={0}
            panelRef={conversationPanel}
            inert={paneMaximized || undefined}
            aria-hidden={paneMaximized || undefined}
          >
            <main className="flex min-h-0 min-w-0 flex-1 flex-col">
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
                  <>
                    {/* The project prefix is the first thing to go on a phone: it is
                        `shrink-0`, so beside the diff chip it squeezed the chat's own
                        title down to nothing. The drawer already says which project. */}
                    {activeProject && !narrow ? (
                      <>
                        <span className="max-w-32 shrink-0 truncate text-sm text-muted-foreground" title={activeProject.name}>
                          {activeProject.name}
                        </span>
                        <span className="shrink-0 text-sm text-muted-foreground" aria-hidden>/</span>
                      </>
                    ) : null}
                    <h1 className="min-w-0 truncate text-sm font-semibold text-foreground" title={headerTitle}>
                      {headerTitle}
                    </h1>
                    <GitStatusPopover
                      key={`${activeId ?? ""}:${active?.cwd ?? ""}`}
                      cwd={active?.project ? active.cwd : undefined}
                      conversationId={activeId ?? undefined}
                      worktree={active?.worktree}
                      refreshKey={conversationWorking}
                      canReview={!narrow}
                    />
                  </>
                )}
              </div>
              {/* A narrow layout renders no side pane at all, so this would open nothing. */}
              {paneCollapsed && !narrow ? (
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
                    loading={loading || opening}
                    loadingReplaces={opening}
                    onRetry={handleRetry}
                    onEdit={handleEdit}
                    onFork={handleForkFromEntry}
                    showThinking={settings.showThinking}
                    showTimestamp={settings.showTimestamps}
                    collapseRuns={settings.collapseRuns}
                  />
                </div>
                {/* Everything under the transcript shares its column: the transcript's
                    scroller reserves a scrollbar gutter, so this box reserves the same one
                    (`transcript-gutter`) and both columns land on the same edges. */}
                <div className="safe-bottom transcript-gutter overflow-hidden">
                  <ExtensionWidgets className="pb-2" />
                  <GoalPanel className="pb-2" disabled={conversationWorking} />
                  <TodoPanel className="pb-2" />
                  {composerSlot}
                </div>
              </>
            )}
            </main>
          </ResizablePanel>
          {/* Terminal, git diffs, the file tree and the embedded browser all want room a
              phone does not have — and the browser pane has no webview to drive out here
              at all. The conversation is what a narrow screen is for. A maximised pane
              has swallowed the conversation column, so its splitter has nothing to
              resize against either. */}
          {narrow || paneCollapsed || paneMaximized ? null : <ResizableHandle />}
          {narrow ? null : (
            <SidePane
              cwd={active?.project ? active.cwd : activeProject?.cwd}
              project={active?.project}
              parentId={activeId ?? undefined}
              canSideChat={Boolean(activeId && hasTranscript)}
              onNewChat={onSidePaneNewChat}
              onError={setError}
            />
          )}
        </ResizablePanelGroup>
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
        onSelectChat={(id) => void handleOpen(id, "user")}
        onNewChat={() => void handleNewChat()}
        onAddProject={() => void handleAddProject()}
        onOpenSettings={(section) => navigate(`/settings/${section}`)}
      />
      <PermissionDialog
        key={pendingDialog?.id ?? "permission"}
        request={pendingDialog}
        onRespond={handlePermissionRespond}
      />
      <FullDiskAccessPrompt />
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
                      } else if (result.restored + result.removed > 0) {
                        toast.success(t("rewind.restored", { count: result.restored + result.removed }));
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
