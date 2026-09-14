import { useEffect, useMemo, useRef, useState, type JSX } from "react";
import { HugeiconsIcon } from "@hugeicons/react";
import { AlertCircleIcon, PanelRightCloseIcon, PanelRightOpenIcon } from "@hugeicons/core-free-icons";
import { useMatch, useNavigate } from "react-router";
import { Composer } from "@/components/chat/composer";
import { MessageList } from "@/components/chat/message-list";
import { NewSessionHero, SuggestionChips } from "@/components/chat/new-session";
import { PermissionDialog } from "@/components/chat/permission-dialog";
import { usagePercent } from "@/components/chat/session-controls";
import { SummaryPanel } from "@/components/chat/summary-panel";
import { Sidebar } from "@/components/layout/sidebar";
import { SidePane } from "@/components/layout/side-pane";
import { SessionSwitcher } from "@/components/layout/session-switcher";
import { Alert, AlertAction, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { IconButton } from "@/components/icon-button";
import { attachmentPromptSuffix, attachmentsToImages } from "@/lib/attachments";

import { SettingsDialog, SETTINGS_SECTIONS, type SectionId } from "@/components/settings/settings-dialog";
import { useSessionStore } from "@/stores/session";
import { useSettingsStore } from "@/stores/settings";
import { useThemeSync } from "@/lib/use-theme";
import type {
  ChatAttachment,
  ChatMessage,
  ConversationOpenResult,
  PermissionRequest,
  QueuedPrompt,
  WorkspaceSnapshot,
} from "@shared/types";
import { useSidePaneStore } from "@/stores/side-pane";

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

export function App(): JSX.Element {
  // Applies light/dark theme selection (and reacts to OS changes in system mode).
  useThemeSync();
  const status = useSessionStore((state) => state.status);
  const session = useSessionStore((state) => state.session);
  const models = useSessionStore((state) => state.models);
  const projects = useSessionStore((state) => state.projects);
  const conversations = useSessionStore((state) => state.conversations);
  const activeId = useSessionStore((state) => state.activeId);
  const messages = useSessionStore((state) => state.messages);
  const streaming = useSessionStore((state) => state.streaming);
  const draft = useSessionStore((state) => state.draft);
  const error = useSessionStore((state) => state.error);
  const setStatus = useSessionStore((state) => state.setStatus);
  const setSession = useSessionStore((state) => state.setSession);
  const setModels = useSessionStore((state) => state.setModels);
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
  const subagents = useSessionStore((state) => state.subagents);
  const permission = useSessionStore((state) => state.permission);
  const runMode = useSessionStore((state) => state.runMode);
  const compacting = useSessionStore((state) => state.compacting);
  const setCommands = useSessionStore((state) => state.setCommands);
  const setSubagents = useSessionStore((state) => state.setSubagents);
  const setPermission = useSessionStore((state) => state.setPermission);
  const setRunMode = useSessionStore((state) => state.setRunMode);
  const attachments = useSessionStore((state) => state.attachments);
  const queued = useSessionStore((state) => state.queued);
  const permissionAlways = useSessionStore((state) => state.permissionAlways);
  const setAttachments = useSessionStore((state) => state.setAttachments);
  const queuePause = useSessionStore((state) => state.queuePause);
  const enqueue = useSessionStore((state) => state.enqueue);
  const removeQueued = useSessionStore((state) => state.removeQueued);
  const prependQueued = useSessionStore((state) => state.prependQueued);
  const clearQueued = useSessionStore((state) => state.clearQueued);
  const setQueuePause = useSessionStore((state) => state.setQueuePause);
  const rememberPermission = useSessionStore((state) => state.rememberPermission);
  const subagentStreams = useSessionStore((state) => state.subagentStreams);
  const restoreId = useRef<string | null>(null);
  const draining = useRef(false);
  // Settings lives at #/settings/<section>; no match means we are in the app.
  const settingsMatch = useMatch("/settings/*");
  const navigate = useNavigate();
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
  const [switcherOpen, setSwitcherOpen] = useState(false);
  const paneCollapsed = useSidePaneStore((state) => state.collapsed);
  const togglePane = useSidePaneStore((state) => state.toggle);
  const settings = useSettingsStore((state) => state.settings);
  const updateSettings = useSettingsStore((state) => state.update);
  // Stable identity so the composer does not re-render on every streamed token.
  const inputHistory = useMemo(
    () => messages.filter((item) => item.role === "user").map((item) => item.text).filter(Boolean),
    [messages],
  );

  useEffect(() => {
    void window.fastvibe.engine.getStatus().then(setStatus);
    void window.fastvibe.conversations.list().then((snapshot) => {
      applySnapshot(snapshot);
      const pending = snapshot.activeId;
      if (
        pending &&
        useSessionStore.getState().status.state === "ready" &&
        !useSessionStore.getState().activeId
      ) {
        restoreId.current = null;
        void window.fastvibe.conversations.open(pending).then(applyOpen).catch(() => undefined);
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
      if (store.activeId !== payload.id || store.streaming) return;
      store.setMessages(payload.messages);
      store.setSession(payload.state);
      store.setStatus(payload.status);
    });
    const offEvent = window.fastvibe.engine.onEvent((event) => {
      const conversationId = typeof event.conversationId === "string" ? event.conversationId : null;
      const currentId = useSessionStore.getState().activeId;
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
        void window.fastvibe.engine.getMessages().then(setMessages).catch(() => undefined);
      } else if (
        event.type === "model_changed" ||
        event.type === "thinking_level_changed" ||
        event.type === "goal_updated"
      ) {
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
      if (event.type === "subagent_lifecycle" || event.type === "subagent_progress") {
        void window.fastvibe.engine.getSubagents().then(setSubagents).catch(() => undefined);
      }
      if (event.type === "tool_execution_end" || event.type === "toolcall_end") {
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
          const store = useSessionStore.getState();
          if (store.preview?.path !== path) void store.openPreview(path);
        }
      }
    });
    return () => {
      offStatus();
      offReady();
      offEvent();
    };
  }, [applyEvent, applySnapshot, setSession, setStatus]);

  useEffect(() => {
    function onKey(event: KeyboardEvent): void {
      if (event.key === "Escape" && useSessionStore.getState().streaming) {
        event.preventDefault();
        document.querySelector<HTMLButtonElement>('[aria-label="停止"]')?.click();
      }
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
        event.preventDefault();
        setSwitcherOpen(true);
      }
      if ((event.metaKey || event.ctrlKey) && event.shiftKey && event.key.toLowerCase() === "n") {
        event.preventDefault();
        void window.fastvibe.app.newWindow();
      }
      if ((event.metaKey || event.ctrlKey) && event.key === "Enter") {
        event.preventDefault();
        const send =
          document.querySelector<HTMLButtonElement>('[aria-label="发送"]') ??
          document.querySelector<HTMLButtonElement>('[aria-label="加入队列"]');
        send?.click();
      }
      if (event.ctrlKey && event.altKey && event.key.toLowerCase() === "b") {
        event.preventDefault();
        useSidePaneStore.getState().toggle();
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  useEffect(() => {
    setRunMode(settings.runMode);
    // apply persisted preferences once on mount
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

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
        .then(applyOpen)
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
        ? "发送失败，请稍后重试。"
        : null;
  // Unbound conversations run in a hidden scratch dir, so never surface that path.
  const workspaceLabel = activeProject?.name ?? "无项目";

  useEffect(() => {
    writeDraft(activeId, draft);
  }, [activeId, draft]);

  function applyOpen(result: ConversationOpenResult): void {
    applySnapshot(result);
    setActiveId(result.conversation.id);
    setMessages(result.messages);
    setSession(result.state);
    setStatus(result.status);
    setDraft(readDrafts()[result.conversation.id] ?? "");
    setError(null);
    clearQueued();
  }

  function applyList(snapshot: WorkspaceSnapshot): void {
    applySnapshot(snapshot);
  }

  function wrapPrompt(text: string): string {
    if (text.startsWith("/")) return text;
    if (runMode === "plan") {
      const has = commands.some((item) => item.name === "plan" || item.name === "skill:plan");
      return has ? `/plan ${text}` : `请先制定可执行计划，列出步骤后再动手。任务：\n${text}`;
    }
    if (runMode === "goal") {
      const has = commands.some((item) => item.name === "goal" || item.name === "skill:goal");
      return has ? `/goal ${text}` : `请进入目标模式：拆解目标、持续执行直到完成，并在过程中更新进度。目标：\n${text}`;
    }
    return text;
  }

  async function handleSubmit(): Promise<void> {
    const text = draft.trim();
    const currentAttachments = useSessionStore.getState().attachments;
    if ((!text && currentAttachments.length === 0) || !canChat) return;
    let conversationId = activeId;
    if (!conversationId) {
      const created = await window.fastvibe.conversations.create(active?.project);
      applyOpen(created);
      conversationId = created.conversation.id;
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
    const payload = `${wrapPrompt(text || "请查看附件")}${attachmentPromptSuffix(files)}`;
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

  useEffect(() => {
    if (streaming || queuePause || queued.length === 0 || draining.current) return;
    const next = queued[0];
    draining.current = true;
    void drainQueued(next).finally(() => {
      draining.current = false;
    });
  }, [streaming, queuePause, queued]);

  async function handleRetry(message: ChatMessage): Promise<void> {
    const source =
      message.role === "user"
        ? message
        : [...messages].reverse().find((item) => item.role === "user" && item.createdAt <= message.createdAt);
    const text = source?.text?.trim();
    if (!text || !canChat) return;
    if (streaming) {
      try {
        await window.fastvibe.engine.abort();
      } catch {
        // ignore
      }
    }
    if (source?.id) {
      try {
        setMessages(await window.fastvibe.engine.branch(source.id));
      } catch {
        // local-only ids cannot branch
      }
    }
    setDraft("");
    addUserMessage(text, source?.attachments);
    try {
      await window.fastvibe.engine.prompt(wrapPrompt(text), {
        images: source?.attachments ? attachmentsToImages(source.attachments) : undefined,
      });
      void window.fastvibe.engine.getState().then(setSession).catch(() => undefined);
    } catch (err) {
      dropEmptyAssistant();
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  async function handleEdit(message: ChatMessage): Promise<void> {
    if (message.id) {
      try {
        setMessages(await window.fastvibe.engine.branch(message.id));
      } catch {
        // ignore
      }
    }
    setDraft(message.text);
  }

  async function discardDraft(id: string | null | undefined): Promise<void> {
    if (!id) return;
    const item = useSessionStore.getState().conversations.find((entry) => entry.id === id);
    if (!item || item.preview) return;
    try {
      applyList(await window.fastvibe.conversations.delete(id));
    } catch {
      // Draft cleanup is best-effort.
    }
  }

  /** Empty chats stay off the sidebar until the first prompt is sent. */
  async function handleNewChat(project?: string): Promise<void> {
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
        return;
      }
      const previousId = activeId;
      const created = await window.fastvibe.conversations.create(project);
      applyOpen(created);
      await discardDraft(previousId);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  async function handleOpen(id: string): Promise<void> {
    const store = useSessionStore.getState();
    // Re-opening the active chat is pointless once it has content or a reply is
    // streaming, but it is how an empty/failed conversation gets retried.
    if (id === store.activeId && (store.messages.length > 0 || store.streaming)) return;
    const previousId = store.activeId;
    try {
      const opened = await window.fastvibe.conversations.open(id);
      applyOpen(opened);
      if (previousId && previousId !== id) await discardDraft(previousId);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }

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

  async function handleRenameProject(cwd: string, name: string): Promise<void> {
    try {
      applyList(await window.fastvibe.projects.rename(cwd, name));
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  async function handleRemoveProject(cwd: string): Promise<void> {
    try {
      const result = await window.fastvibe.projects.remove(cwd);
      applyList(result);
      if (result.nextId) {
        applyOpen(await window.fastvibe.conversations.open(result.nextId));
      } else if (active?.project === cwd) {
        resetConversation();
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  /**
   * Bind the active conversation to a project, or clear it to "无项目". A new
   * session has no conversation row yet, so picking a project creates one —
   * unbound sessions stay hidden from the sidebar until their first prompt.
   */
  async function handleSetProject(project: string | null): Promise<void> {
    try {
      if (!activeId) {
        applyOpen(await window.fastvibe.conversations.create(project ?? undefined));
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

  const headerTitle = active
    ? [activeProject?.name, active.title].filter(Boolean).join(" / ")
    : "新会话";
  // A conversation with no preview yet is still a "new session": it has no title
  // or content to put in the top bar, so the bar is dropped and the project
  // binding is surfaced above the composer instead.
  const isNewSession = !active?.preview;
  // `needsAuth` is not a loading state, so the spinner only covers a real start.
  const loading = status.state === "starting" && messages.length === 0;
  // A fresh conversation swaps the transcript for the centred greeting hero.
  const showHero = messages.length === 0 && !loading;

  const bannerNode = banner ? (
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
  ) : null;

  const composer = (
    <Composer
      value={draft}
      disabled={!canChat}
      streaming={streaming}
      placeholder={canChat ? "随心输入" : "准备中…"}
      models={models}
      model={session?.model}
      thinkingLevel={session?.thinkingLevel}
      workspaceLabel={workspaceLabel}
      projects={projects}
      project={active?.project}
      newSession={isNewSession}
      commands={commands}
      permissionMode={settings.permissionMode}
      onPermissionModeChange={(mode) => updateSettings({ permissionMode: mode })}
      queued={queued}
      queuePause={queuePause}
      attachments={attachments}
      history={inputHistory}
      contextPercent={usagePercent(session)}
      contextUsage={session?.contextUsage}
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
      onResumeQueue={() => setQueuePause(null)}
      sendOnEnter={settings.sendOnEnter}
      onManageModels={() => navigate("/settings/providers")}
    />
  );

  return (
    <div className="flex h-full bg-background">
      <Sidebar
        projects={projects}
        conversations={conversations}
        activeId={activeId}
        streaming={streaming}
        onNewChat={(cwd) => void handleNewChat(cwd)}
        onOpen={(id) => void handleOpen(id)}
        onAddProject={() => void handleAddProject()}
        onRenameSession={(id, title) => void handleRenameSession(id, title)}
        onRenameProject={(cwd, name) => void handleRenameProject(cwd, name)}
        onRemoveProject={(cwd) => void handleRemoveProject(cwd)}
        onRevealProject={(cwd) => void window.fastvibe.workspace.reveal(cwd)}
        onOpenSettings={() => navigate("/settings/general")}
      />
      <main className="flex min-w-0 flex-1 flex-col">
        <header className="drag-region flex h-11 items-center justify-between px-4">
          {isNewSession ? <div /> : <div className="no-drag ml-2 truncate text-[12.5px] text-muted-foreground">{headerTitle}</div>}
          <div className="no-drag flex items-center gap-1">
            <IconButton
              size="icon-sm"
              variant="ghost"
              label={paneCollapsed ? "展开侧边面板" : "收起侧边面板"}
              shortcut="⌃⌥B"
              onClick={togglePane}
            >
              <HugeiconsIcon strokeWidth={2} icon={paneCollapsed ? PanelRightOpenIcon : PanelRightCloseIcon} />
            </IconButton>
          </div>
        </header>
        {showHero ? (
          // New conversation: the greeting hero sits above the composer and the
          // suggestion chips below it, with the group centred like the reference.
          <div className="flex min-h-0 w-full flex-1 flex-col items-center justify-center gap-6">
            {bannerNode}
            <NewSessionHero />
            {composer}
            <SuggestionChips onSelect={setDraft} />
          </div>
        ) : (
          <>
            <div className="relative min-h-0 flex-1">
              <MessageList
                messages={messages}
                streaming={streaming}
                loading={loading}
                onRetry={(message) => void handleRetry(message)}
                onEdit={(message) => void handleEdit(message)}
                showThinking={settings.showThinking}
                showTimestamp={settings.showTimestamps}
              />
              <SummaryPanel
                messages={messages}
                streaming={streaming}
                runMode={runMode}
                subagents={subagents}
                streams={subagentStreams}
              />
            </div>
            {bannerNode}
            {composer}
          </>
        )}
      </main>
      <SidePane
        cwd={activeProject?.cwd}
        project={active?.project}
        parentId={activeId ?? undefined}
        messages={messages}
        canSideChat={Boolean(activeId && messages.some((item) => item.role === "user" || item.role === "assistant"))}
        onError={setError}
      />
      <SettingsDialog
        open={settingsOpen}
        onOpenChange={(open) => navigate(open ? "/settings/general" : "/")}
        section={settingsSection}
        onProvidersChanged={() => {
          void window.fastvibe.engine.getModels().then(setModels).catch(() => undefined);
          void window.fastvibe.engine.getState().then(setSession).catch(() => undefined);
        }}
      />
      <SessionSwitcher
        open={switcherOpen}
        conversations={conversations}
        projects={projects}
        activeId={activeId}
        onOpenChange={setSwitcherOpen}
        onSelect={(id) => void handleOpen(id)}
      />
      <PermissionDialog
        key={permission?.id ?? "permission"}
        request={permission}
        onRespond={(payload) => {
          if (payload.always && permission) rememberPermission(permissionKey(permission));
          void window.fastvibe.engine.respondPermission(payload);
          setPermission(null);
        }}
      />
    </div>
  );
}
