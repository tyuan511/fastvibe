import { memo, useCallback, useEffect, useRef, useState, type JSX } from "react";
import { motion } from "motion/react";
import { HugeiconsIcon } from "@hugeicons/react";
import { AlertCircleIcon, MessageSquarePlusIcon, PanelLeftOpenIcon, PanelRightOpenIcon } from "@hugeicons/core-free-icons";
import { useLocation, useMatch, useNavigate, useNavigationType } from "react-router";
import { useShallow } from "zustand/react/shallow";
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
import { UpdateBanner } from "@/components/layout/update-banner";
import { Alert, AlertAction, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { IconButton } from "@/components/icon-button";
import { attachmentPromptSuffix, attachmentsToImages } from "@/lib/attachments";
import { dismissBootLoader } from "@/lib/boot-loader";
import { cn } from "@/lib/utils";

import { SettingsDialog, SETTINGS_SECTIONS, type SectionId } from "@/components/settings/settings-dialog";
import type { DeleteConversationsResult } from "@/components/settings/archived-settings";
import { useSessionStore } from "@/stores/session";
import { useSettingsStore } from "@/stores/settings";
import { useThemeSync } from "@/lib/use-theme";
import type {
  ChatAttachment,
  ChatMessage,
  ConversationDeleteResult,
  ConversationOpenResult,
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

/**
 * macOS renders the window controls as an overlay (`hiddenInset`), so the top
 * bar has to clear them when the sidebar — which normally covers them — is
 * collapsed.
 */
const IS_MAC = typeof navigator !== "undefined" && /mac/i.test(navigator.userAgent);

function permissionKey(request: PermissionRequest): string {
  return `${request.method}:${request.title ?? ""}:${request.message ?? ""}`;
}

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

/** Pull the active conversation's turn statistics into the store. */
function refreshStats(): void {
  void window.fastvibe.engine
    .getStats()
    .then((stats) => useSessionStore.getState().setStats(stats))
    .catch(() => undefined);
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
}: {
  loading: boolean;
  onRetry: (message: ChatMessage) => void;
  onEdit: (message: ChatMessage) => void;
  showThinking: boolean;
  showTimestamp: boolean;
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
    />
  );
});

export function App(): JSX.Element {
  // Applies light/dark theme selection (and reacts to OS changes in system mode).
  useThemeSync();
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
  const inputHistory = useSessionStore(
    useShallow((state) =>
      state.messages
        .filter((item) => item.role === "user")
        .map((item) => item.text)
        .filter(Boolean),
    ),
  );
  const hasTranscript = useSessionStore((state) =>
    state.messages.some((item) => item.role === "user" || item.role === "assistant"),
  );
  const streaming = useSessionStore((state) => state.streaming);
  const running = useSessionStore((state) => state.running);
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
  const compacting = useSessionStore((state) => state.compacting);
  const setCommands = useSessionStore((state) => state.setCommands);
  const setSubagents = useSessionStore((state) => state.setSubagents);
  const setPermission = useSessionStore((state) => state.setPermission);
  const attachments = useSessionStore((state) => state.attachments);
  const queued = useSessionStore((state) => state.queued);
  const permissionAlways = useSessionStore((state) => state.permissionAlways);
  const setAttachments = useSessionStore((state) => state.setAttachments);
  const queuePause = useSessionStore((state) => state.queuePause);
  const enqueue = useSessionStore((state) => state.enqueue);
  const removeQueued = useSessionStore((state) => state.removeQueued);
  const setQueuedOrder = useSessionStore((state) => state.setQueuedOrder);
  const prependQueued = useSessionStore((state) => state.prependQueued);
  const clearQueued = useSessionStore((state) => state.clearQueued);
  const setQueuePause = useSessionStore((state) => state.setQueuePause);
  const runInterrupted = useSessionStore((state) => state.runInterrupted);
  const setRunInterrupted = useSessionStore((state) => state.setRunInterrupted);
  const rememberPermission = useSessionStore((state) => state.rememberPermission);
  const restoreId = useRef<string | null>(null);
  const draining = useRef(false);
  // Settings lives at #/settings/<section>; no match means we are in the app.
  const settingsMatch = useMatch("/settings/*");
  const location = useLocation();
  const navigationType = useNavigationType();
  const navigate = useNavigate();
  const initialLocationKey = useRef(location.key);
  const settingsOpen = Boolean(settingsMatch);
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
  // `getStatus()` is async, so until it resolves the store still holds the "idle"
  // placeholder. Track whether the real status has landed: the shell shows the F
  // loader (and keeps the boot splash up) until it has.
  const [engineKnown, setEngineKnown] = useState(false);
  // Bumped whenever a fresh conversation is started so the composer grabs focus.
  const [composerFocus, setComposerFocus] = useState(0);
  // Skills the engine can load, surfaced by the composer's 技能 picker. Refetched
  // after 设置 → 技能 closes so a newly added skill shows up without a restart.
  const [skills, setSkills] = useState<SkillInfo[]>([]);

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
  const sidebarCollapsed = settings.sidebarCollapsed ?? false;
  const archivedIds = useArchivedIds();
  const toggleSidebarShortcut = useShortcutLabel("toggleSidebar");
  const toggleSidePaneShortcut = useShortcutLabel("toggleSidePane");
  const newChatShortcut = useShortcutLabel("newChat");

  useEffect(() => {
    void window.fastvibe.engine.getStatus().then((next) => {
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
    const offStatus = window.fastvibe.engine.onStatus(setStatus);
    // Background conversation init finished: fill in the transcript, unless the
    // user already sent a message (then their optimistic thread wins and engine
    // events will replace it).
    const offReady = window.fastvibe.engine.onConversationReady((payload) => {
      const store = useSessionStore.getState();
      // Seed the sidebar's run indicator even for conversations that are not on screen.
      store.setConversationRunning(payload.id, payload.state?.isStreaming ?? false);
      if (store.activeId !== payload.id || store.streaming) return;
      store.setMessages(payload.messages);
      store.setSession(payload.state);
      store.setStatus(payload.status);
    });
    const offEvent = window.fastvibe.engine.onEvent((event) => {
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
      if (event.type === "conversation_renamed" && event.snapshot && typeof event.snapshot === "object") {
        useSessionStore.getState().applySnapshot(event.snapshot as WorkspaceSnapshot);
      }
      const currentId = useSessionStore.getState().activeId;
      // Subagent traffic feeds the shared subagent store, not a conversation, and a
      // parent run keeps streaming after the user switches chats: apply it before
      // the focus routing so every run's tab stays live either way. Each run owns a
      // tab (`subagent:<toolCallId>:<index>`), keyed to the conversation that
      // spawned it, so two chats delegating at once never share a view.
      if (event.type === "subagent_event" || event.type === "subagent_lifecycle" || event.type === "subagent_progress") {
        applyEvent(event);
        // A lifecycle event is where a run gets its tab (created, not focused).
        // Per-token `subagent_event`s only feed the transcript, which the session
        // store already keys by run id — no side-pane write per token.
        if (event.type !== "subagent_event") {
          const subagentId = typeof event.subagentId === "string" ? event.subagentId : "";
          if (subagentId) {
            const info = useSessionStore.getState().subagents.find((item) => item.id === subagentId);
            useSidePaneStore.getState().registerSubagent(subagentId, {
              conversationId: typeof event.conversationId === "string" ? event.conversationId : info?.conversationId,
              title: info?.name || info?.agent,
              status: typeof event.status === "string" ? event.status : info?.status,
            });
          }
          void window.fastvibe.engine.getSubagents().then(setSubagents).catch(() => undefined);
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
        void window.fastvibe.engine.getState().then(setSession).catch(() => undefined);
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
        if (!failed && !compactFailed) {
          void window.fastvibe.engine.getMessages().then(setMessages).catch(() => undefined);
        }
        refreshStats();
      } else if (event.type === "model_changed" || event.type === "thinking_level_changed") {
        void window.fastvibe.engine.getState().then(setSession).catch(() => undefined);
      }
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
      const send =
        document.querySelector<HTMLButtonElement>('[aria-label="发送"]') ??
        document.querySelector<HTMLButtonElement>('[aria-label="加入队列"]');
      if (!send || send.disabled) return false;
      send.click();
    },
    stop: () => {
      // Esc during a run stops it — but never while an overlay owns the keyboard:
      // command palette, settings, or an extension prompt (there Esc cancels).
      if (commandOpen || settingsOpen) return false;
      const store = useSessionStore.getState();
      if (!store.streaming || store.permission) return false;
      document.querySelector<HTMLButtonElement>('[aria-label="停止"]')?.click();
    },
    prevChat: () => {
      setCommandOpen(false);
      return cycleChat(-1);
    },
    nextChat: () => {
      setCommandOpen(false);
      return cycleChat(1);
    },
    toggleSidebar: () => updateSettings({ sidebarCollapsed: !sidebarCollapsed }),
    toggleSidePane: () => togglePane(),
  });

  useEffect(() => {
    if (status.state !== "ready") return;
    void window.fastvibe.engine.setAutoCompaction(settings.autoCompact).catch(() => undefined);
    void window.fastvibe.engine.setInterruptMode(settings.interruptMode).catch(() => undefined);
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
    void window.fastvibe.engine.setAutoCompaction(settings.autoCompact).catch(() => undefined);
  }, [settings.autoCompact, status.state]);

  useEffect(() => {
    if (status.state !== "ready") return;
    void window.fastvibe.engine.setInterruptMode(settings.interruptMode).catch(() => undefined);
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
    // The model list is expensive (~1.5s in the engine) and only changes when
    // providers change, so fetch it once rather than on every engine start.
    if (useSessionStore.getState().models.length === 0) {
      void window.fastvibe.engine
        .getModels()
        .then(setModels)
        .catch(() => undefined);
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
    void window.fastvibe.engine.respondPermission({ id: permission.id, confirmed: true });
    setPermission(null);
  }, [permission, permissionAlways, setPermission, settings.permissionMode]);

  // Shared by the inline panel (confirm/select/input/questions) and the modal (editor).
  const handlePermissionRespond = useCallback(
    (payload: PermissionResponse) => {
      if (payload.always && permission) rememberPermission(permissionKey(permission));
      void window.fastvibe.engine.respondPermission(payload);
      setPermission(null);
    },
    [permission, rememberPermission, setPermission],
  );

  // Sending is allowed while the engine is still coming up: the prompt waits
  // behind initialisation, which the user experiences as reply latency. `needsAuth`
  // is deliberately included — no provider is a normal first-run state, not a
  // blocker, and the composer's model menu is how you go and configure one.
  const canChat =
    status.state === "ready" ||
    status.state === "starting" ||
    status.state === "idle" ||
    status.state === "needsAuth";
  const active = conversations.find((item) => item.id === activeId);
  const activeProject = projects.find((item) => item.cwd === active?.project);
  const banner =
    status.state === "missing" || status.state === "error"
      ? "暂时无法开始对话，请稍后重试。"
      : error
        ? error
        : null;
  // Unbound conversations run in a hidden scratch dir, so never surface that path.
  const workspaceLabel = activeProject?.name ?? "无项目";

  useEffect(() => {
    writeDraft(activeId, draft);
  }, [activeId, draft]);

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

  function applyOpen(result: ConversationOpenResult): void {
    applySnapshot(result);
    setActiveId(result.conversation.id);
    setMessages(result.messages);
    setSession(result.state);
    setStatus(result.status);
    setDraft(readDrafts()[result.conversation.id] ?? "");
    setError(null);
    clearQueued();
    setRunInterrupted(null);
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
    const text = draft.trim();
    const currentAttachments = useSessionStore.getState().attachments;
    if ((!text && currentAttachments.length === 0) || !canChat) return;
    const compact = parseCompactCommand(text);
    if (compact) {
      if (!activeId) return;
      setDraft("");
      try {
        await window.fastvibe.engine.compact(compact.instructions);
        void window.fastvibe.engine.getState().then(setSession).catch(() => undefined);
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      }
      return;
    }
    let conversationId = activeId;
    if (!conversationId) {
      const created = await window.fastvibe.conversations.create(active?.project);
      applyOpen(created);
      conversationId = created.conversation.id;
      revealConversation(conversationId);
    }
    setDraft("");
    const promptText = text || currentAttachments.map((item) => item.name).join("、");
    const nextList = await window.fastvibe.conversations.recordPrompt(conversationId, promptText);
    applyList(nextList);
    if (streaming) {
      if (settings.queueBehavior === "steer") {
        setAttachments([]);
        try {
          await dispatchPrompt(text, currentAttachments, "steer");
        } catch (err) {
          setError(err instanceof Error ? err.message : String(err));
        }
      } else {
        enqueue({
          id: crypto.randomUUID(),
          text: promptText,
          behavior: "followUp",
          attachments: currentAttachments,
        });
        setAttachments([]);
        setQueuePause(null);
      }
      return;
    }
    addUserMessage(promptText, currentAttachments);
    // A fresh prompt supersedes an interrupted turn: drop the resume affordance now
    // so the button does not linger until the engine's `agent_start` lands.
    setRunInterrupted(null);
    try {
      await dispatchPrompt(text, currentAttachments, "prompt");
    } catch (err) {
      dropEmptyAssistant();
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  async function dispatchPrompt(
    text: string,
    files: ChatAttachment[],
    mode: "prompt" | "steer",
  ): Promise<void> {
    const payload = `${text || "请查看附件"}${attachmentPromptSuffix(files)}`;
    const images = attachmentsToImages(files);
    if (mode === "steer") await window.fastvibe.engine.steer(payload, images);
    else await window.fastvibe.engine.prompt(payload, { images });
    void window.fastvibe.engine.getState().then(setSession).catch(() => undefined);
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

  function handleRemoveQueued(id: string): void {
    removeQueued(id);
  }

  function handleEditQueued(id: string): void {
    const item = useSessionStore.getState().queued.find((entry) => entry.id === id);
    if (!item || draft.trim()) return;
    removeQueued(id);
    setDraft(item.text);
    if (item.attachments?.length) setAttachments(item.attachments);
  }

  async function handleSendQueuedNow(id: string): Promise<void> {
    const item = useSessionStore.getState().queued.find((entry) => entry.id === id);
    if (!item) return;
    removeQueued(id);
    if (useSessionStore.getState().streaming) {
      try {
        await dispatchPrompt(item.text, item.attachments ?? [], "steer");
      } catch (err) {
        prependQueued(item);
        setError(err instanceof Error ? err.message : String(err));
      }
      return;
    }
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
        await window.fastvibe.engine.clearQueue();
      } catch {
        // older engines may not support clear_queue
      }
      await window.fastvibe.engine.abort();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setStreaming(false);
      void window.fastvibe.engine.getState().then(setSession).catch(() => undefined);
    }
  }

  /**
   * Continue the interrupted turn. The engine re-enters the loop from the transcript
   * (no new user message), and the queue stays held: resume must not flush queued
   * follow-ups onto a half-finished reply. Once the resumed run starts, `agent_start`
   * clears `runInterrupted` and unpauses nothing — the queue only resumes when the
   * user explicitly continues it (or a later clean turn ends).
   */
  async function handleResumeRun(): Promise<void> {
    if (!canChat) return;
    setRunInterrupted(null);
    try {
      await window.fastvibe.engine.continue();
    } catch (err) {
      setRunInterrupted("error");
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      void window.fastvibe.engine.getState().then(setSession).catch(() => undefined);
    }
  }

  // Each dispatch resolves only once its whole run finishes, so drain the queue in
  // a loop. A one-shot effect would stop after the first item: resetting `draining`
  // in `.finally` does not re-render, so the next queued message would never fire.
  useEffect(() => {
    if (streaming || queuePause || queued.length === 0 || draining.current) return;
    draining.current = true;
    void (async () => {
      try {
        for (;;) {
          const state = useSessionStore.getState();
          if (state.queuePause || state.queued.length === 0 || state.streaming) break;
          await drainQueued(state.queued[0]);
        }
      } finally {
        draining.current = false;
      }
    })();
  }, [streaming, queuePause, queued]);

  // Stable identities so the memoised transcript rows do not re-render (or hold a
  // stale closure) when unrelated shell state changes.
  const handleRetry = useCallback(async (message: ChatMessage): Promise<void> => {
    const current = useSessionStore.getState();
    const source =
      message.role === "user"
        ? message
        : [...current.messages].reverse().find((item) => item.role === "user" && item.createdAt <= message.createdAt);
    const text = source?.text?.trim();
    if (!text || !canChat) return;
    if (current.streaming) {
      try {
        await window.fastvibe.engine.abort();
      } catch {
        // ignore
      }
    }
    // Retry replaces its turn rather than appending a second copy: drop the source
    // user message and everything after it, then send it again. Branching rewinds
    // the engine to the same point; if the id cannot be resolved locally the trim
    // still keeps the transcript from stacking a duplicate.
    const sourceIndex = source ? current.messages.findIndex((item) => item.id === source.id) : -1;
    const trimmed = sourceIndex >= 0 ? current.messages.slice(0, sourceIndex) : current.messages;
    if (source?.id) {
      try {
        setMessages(await window.fastvibe.engine.branch(source.id));
      } catch {
        setMessages(trimmed);
      }
    } else {
      setMessages(trimmed);
    }
    setDraft("");
    addUserMessage(text, source?.attachments);
    try {
      await window.fastvibe.engine.prompt(text, {
        images: source?.attachments ? attachmentsToImages(source.attachments) : undefined,
      });
      void window.fastvibe.engine.getState().then(setSession).catch(() => undefined);
    } catch (err) {
      dropEmptyAssistant();
      setError(err instanceof Error ? err.message : String(err));
    }
  }, [canChat, setMessages, setDraft, addUserMessage, dropEmptyAssistant, setError, setSession]);

  const handleEdit = useCallback(async (message: ChatMessage): Promise<void> => {
    if (message.id) {
      try {
        setMessages(await window.fastvibe.engine.branch(message.id));
      } catch {
        // A turn sent in this window has no session entry yet: rewrite it by
        // dropping it (and its reply) locally, matching what branching would do.
        const index = useSessionStore.getState().messages.findIndex((item) => item.id === message.id);
        if (index >= 0) setMessages(useSessionStore.getState().messages.slice(0, index));
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
          void window.fastvibe.engine.getStatus().then(setStatus).catch(() => undefined);
          void window.fastvibe.engine.getState().then(setSession).catch(() => undefined);
        }
        setMessages([]);
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

  async function handleOpen(id: string, source: "user" | "history" = "user"): Promise<void> {
    const store = useSessionStore.getState();
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
    try {
      const added = await window.fastvibe.projects.add();
      if (!added) return;
      applyList(added);
      setStatus(await window.fastvibe.engine.getStatus());
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
      for (const id of doomed) disposeSidePaneTabs(useSidePaneStore.getState().forgetScope(id));
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
      void window.fastvibe.engine.getStatus().then(setStatus).catch(() => undefined);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  async function handlePickWorkspace(): Promise<void> {
    const picked = await window.fastvibe.workspace.pick();
    if (!picked) return;
    setStatus(picked.status);
    applyList(await window.fastvibe.conversations.list());
    await handleSetProject(picked.cwd);
  }

  async function handleModelChange(provider: string, modelId: string): Promise<void> {
    try {
      let next = await window.fastvibe.engine.setModel(provider, modelId);
      const catalog = models.find((item) => item.provider === provider && item.id === modelId);
      const levels = catalog?.thinkingLevels;
      if (levels?.length && (!next.thinkingLevel || !levels.includes(next.thinkingLevel as never))) {
        next = await window.fastvibe.engine.setThinking(levels.includes("high") ? "high" : levels[0]);
      }
      setSession(next);
    } catch {
      setError("切换模型失败，请稍后重试。");
    }
  }

  async function handleThinkingChange(level: string): Promise<void> {
    try {
      const next = await window.fastvibe.engine.setThinking(level);
      setSession(next);
    } catch {
      setError("无法设置推理强度。");
    }
  }

  const headerTitle = active ? active.title : "新会话";
  // A conversation with no preview yet is still a "new session": it has no title
  // or content to put in the top bar, so the bar is dropped and the project
  // binding is surfaced above the composer instead.
  const isNewSession = !active?.preview;
  // `needsAuth` is not a loading state, so the F only covers a real start — plus
  // the window before `getStatus()` lands, which the boot splash is already covering.
  const loading = empty && (!engineKnown || status.state === "starting");
  // A fresh conversation swaps the transcript for the centred greeting hero.
  const showHero = empty && !loading;

  const bannerNode = (
    <>
      {banner ? (
        <div className="mx-auto mb-2 w-full max-w-3xl px-6">
          <Alert variant="destructive">
            <HugeiconsIcon strokeWidth={2} icon={AlertCircleIcon} />
            <AlertTitle>出了点问题</AlertTitle>
            <AlertDescription>{banner}</AlertDescription>
            {status.state === "missing" || status.state === "error" ? (
              <AlertAction>
                <Button
                  size="xs"
                  variant="outline"
                  onClick={() => void window.fastvibe.engine.start(status.cwd)}
                >
                  重试
                </Button>
              </AlertAction>
            ) : null}
          </Alert>
        </div>
      ) : null}
      <UpdateBanner />
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
      compacting={compacting}
      placeholder={canChat ? "随心输入" : "准备中…"}
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
      onRemoveQueued={handleRemoveQueued}
      onEditQueued={handleEditQueued}
      onSendQueuedNow={(id) => void handleSendQueuedNow(id)}
      onReorderQueued={setQueuedOrder}
      onResumeQueue={() => setQueuePause(null)}
      runInterrupted={runInterrupted !== null}
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
    <div className="flex h-full bg-background">
      <Sidebar
        projects={projects}
        conversations={conversations}
        activeId={activeId}
        running={running}
        onNewChat={(cwd) => void handleNewChat(cwd)}
        onOpen={(id) => void handleOpen(id)}
        onArchive={(id) => void handleArchiveSession(id)}
        onAddProject={() => void handleAddProject()}
        onRenameSession={(id, title) => void handleRenameSession(id, title)}
        onRenameProject={(cwd, name) => void handleRenameProject(cwd, name)}
        onRemoveProject={(cwd) => void handleRemoveProject(cwd)}
        onRevealProject={(cwd) => void window.fastvibe.workspace.reveal(cwd)}
        onReorderProjects={(cwds) => void handleReorderProjects(cwds)}
        onOpenSettings={() => navigate("/settings/general")}
        onOpenMarket={() => navigate("/settings/extensions")}
        onSearch={() => setCommandOpen(true)}
      />
      <main className={cn("flex min-w-0 flex-1 flex-col", !paneCollapsed && paneMaximized && "hidden")}>
        <motion.header
          initial={false}
          // Expanded: the collapse control lives on the sidebar, next to the
          // traffic lights. Collapsed: inset this bar on macOS so the expand
          // control, title and lights share one vertically centred row.
          animate={{ paddingLeft: sidebarCollapsed && IS_MAC ? "5.5rem" : "1rem" }}
          transition={PANEL_COLLAPSE_TRANSITION}
          className="drag-region flex h-11 items-center justify-between pr-4"
        >
          <div className="no-drag flex min-w-0 flex-1 items-center gap-1 pr-3">
            {sidebarCollapsed ? (
              <div className="flex items-center gap-1">
                <IconButton
                  size="icon-sm"
                  variant="ghost"
                  label="展开侧边栏"
                  shortcut={toggleSidebarShortcut}
                  onClick={() => updateSettings({ sidebarCollapsed: false })}
                >
                  <HugeiconsIcon strokeWidth={2} icon={PanelLeftOpenIcon} />
                </IconButton>
                <IconButton
                  size="icon-sm"
                  variant="ghost"
                  label="新对话"
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
                label="展开侧边面板"
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
            <GoalPanel className="pb-2" disabled={streaming} />
            <TodoPanel className="pb-2" />
            {composerSlot}
            <SuggestionChips onSelect={setDraft} />
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
              />
            </div>
            {/* Everything under the transcript shares its column: the transcript's
                scroller reserves a scrollbar gutter, so this box reserves the same one
                (`transcript-gutter`) and both columns land on the same edges. */}
            <div className="transcript-gutter overflow-hidden">
              {bannerNode}
              <ExtensionWidgets className="pb-2" />
              <GoalPanel className="pb-2" disabled={streaming} />
              <TodoPanel className="pb-2" />
              {composerSlot}
            </div>
          </>
        )}
      </main>
      <SidePane
        cwd={activeProject?.cwd}
        project={active?.project}
        parentId={activeId ?? undefined}
        canSideChat={Boolean(activeId && hasTranscript)}
        onNewChat={() => void handleNewChat()}
        onError={setError}
      />
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
        onProvidersChanged={() => {
          void window.fastvibe.engine.getModels().then(setModels).catch(() => undefined);
          void window.fastvibe.engine.getState().then(setSession).catch(() => undefined);
        }}
      />
      <CommandPalette
        open={commandOpen}
        conversations={conversations}
        projects={projects}
        activeId={activeId}
        onOpenChange={setCommandOpen}
        onSelectChat={(id) => void handleOpen(id)}
        onNewChat={() => void handleNewChat()}
        onAddProject={() => void handleAddProject()}
        onOpenSettings={(section) => navigate(`/settings/${section}`)}
      />
      <PermissionDialog
        key={pendingDialog?.id ?? "permission"}
        request={pendingDialog}
        onRespond={handlePermissionRespond}
      />
      <ExtensionNotices />
    </div>
  );
}
