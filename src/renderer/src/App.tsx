import { useEffect, useMemo, useRef, useState, type JSX } from "react";
import { AlertCircleIcon, GitBranch } from "lucide-react";
import { ConnectForm } from "@/components/auth/connect-form";
import { Composer } from "@/components/chat/composer";
import { MessageList } from "@/components/chat/message-list";
import { PermissionDialog } from "@/components/chat/permission-dialog";
import { PreviewPanel } from "@/components/chat/preview-panel";
import { RunStatusBar, SessionMenu, usagePercent } from "@/components/chat/session-controls";
import { Sidebar } from "@/components/layout/sidebar";
import { SessionSwitcher } from "@/components/layout/session-switcher";
import { GitStatusDialog } from "@/components/layout/git-status-dialog";
import { StatusPill } from "@/components/layout/status-pill";
import { Alert, AlertAction, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { attachmentPromptSuffix, attachmentsToImages } from "@/lib/attachments";
import { SettingsDialog } from "@/components/settings/settings-dialog";
import { useSessionStore } from "@/stores/session";
import { useSettingsStore } from "@/stores/settings";
import type {
  ChatMessage,
  ConversationOpenResult,
  PermissionRequest,
  SessionStats,
  WorkspaceSnapshot,
} from "@shared/types";
import type { GitStatus } from "@shared/ipc";

function permissionKey(request: PermissionRequest): string {
  return `${request.method}:${request.title ?? ""}:${request.message ?? ""}`;
}

export function App(): JSX.Element {
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
  const queueBehavior = useSessionStore((state) => state.queueBehavior);
  const compacting = useSessionStore((state) => state.compacting);
  const setCommands = useSessionStore((state) => state.setCommands);
  const setSubagents = useSessionStore((state) => state.setSubagents);
  const setPermission = useSessionStore((state) => state.setPermission);
  const setRunMode = useSessionStore((state) => state.setRunMode);
  const setQueueBehavior = useSessionStore((state) => state.setQueueBehavior);
  const attachments = useSessionStore((state) => state.attachments);
  const queued = useSessionStore((state) => state.queued);
  const permissionAlways = useSessionStore((state) => state.permissionAlways);
  const setAttachments = useSessionStore((state) => state.setAttachments);
  const enqueue = useSessionStore((state) => state.enqueue);
  const clearQueued = useSessionStore((state) => state.clearQueued);
  const rememberPermission = useSessionStore((state) => state.rememberPermission);
  const preview = useSessionStore((state) => state.preview);
  const subagentStreams = useSessionStore((state) => state.subagentStreams);
  const setPreview = useSessionStore((state) => state.setPreview);
  const restoreId = useRef<string | null>(null);
  const [stats, setStats] = useState<SessionStats | null>(null);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [switcherOpen, setSwitcherOpen] = useState(false);
  const [gitDialogOpen, setGitDialogOpen] = useState(false);
  const [gitStatus, setGitStatus] = useState<GitStatus | null>(null);
  const settings = useSettingsStore((state) => state.settings);
  const updateSettings = useSettingsStore((state) => state.update);
  // Stable identity so the composer does not re-render on every streamed token.
  const inputHistory = useMemo(
    () => messages.filter((item) => item.role === "user").map((item) => item.text).filter(Boolean),
    [messages],
  );

  useEffect(() => {
    void window.fastvibe.omp.getStatus().then(setStatus);
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
    const offStatus = window.fastvibe.omp.onStatus(setStatus);
    // Background conversation init finished: fill in the transcript, unless the
    // user already sent a message (then their optimistic thread wins and engine
    // events will replace it).
    const offReady = window.fastvibe.omp.onConversationReady((payload) => {
      const store = useSessionStore.getState();
      if (store.activeId !== payload.id || store.streaming) return;
      store.setMessages(payload.messages);
      store.setSession(payload.state);
      store.setStatus(payload.status);
    });
    const offEvent = window.fastvibe.omp.onEvent((event) => {
      applyEvent(event);
      if (event.type === "agent_end" || event.type === "tool_execution_end" || event.type === "toolcall_end") {
        const state = useSessionStore.getState();
        const current = state.conversations.find((item) => item.id === state.activeId);
        if (current?.project) void window.fastvibe.workspace.gitStatus(current.project).then(setGitStatus).catch(() => undefined);
      }
      // Message/stat reloads are expensive (the engine replays the whole
      // transcript), so only do them when the transcript actually changed.
      if (
        event.type === "agent_end" ||
        event.type === "agent_settled" ||
        event.type === "compaction_end" ||
        event.type === "auto_compaction_end"
      ) {
        void window.fastvibe.omp.getState().then(setSession).catch(() => undefined);
        void window.fastvibe.omp.getMessages().then(setMessages).catch(() => undefined);
        void window.fastvibe.omp.getStats().then(setStats).catch(() => undefined);
      } else if (
        event.type === "model_changed" ||
        event.type === "thinking_level_changed" ||
        event.type === "goal_updated"
      ) {
        void window.fastvibe.omp.getState().then(setSession).catch(() => undefined);
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
        void window.fastvibe.omp.getSubagents().then(setSubagents).catch(() => undefined);
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
      if ((event.metaKey || event.ctrlKey) && event.key === "Enter") {
        event.preventDefault();
        const send =
          document.querySelector<HTMLButtonElement>('[aria-label="发送"]') ??
          document.querySelector<HTMLButtonElement>('[aria-label="加入队列"]');
        send?.click();
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  useEffect(() => {
    setRunMode(settings.runMode);
    setQueueBehavior(settings.queueBehavior);
    // apply persisted preferences once on mount
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (status.state !== "ready") return;
    void window.fastvibe.omp.setAutoCompaction(settings.autoCompact).catch(() => undefined);
    void window.fastvibe.omp.setInterruptMode(settings.interruptMode).catch(() => undefined);
    if (settings.thinkingLevel !== "auto") {
      void window.fastvibe.omp
        .setThinking(settings.thinkingLevel)
        .then(setSession)
        .catch(() => undefined);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [status.state]);

  useEffect(() => {
    if (status.state !== "ready") return;
    void window.fastvibe.omp.setAutoCompaction(settings.autoCompact).catch(() => undefined);
  }, [settings.autoCompact, status.state]);

  useEffect(() => {
    if (status.state !== "ready") return;
    void window.fastvibe.omp.setInterruptMode(settings.interruptMode).catch(() => undefined);
  }, [settings.interruptMode, status.state]);

  useEffect(() => {
    if (status.state !== "ready" || settings.thinkingLevel === "auto") return;
    void window.fastvibe.omp
      .setThinking(settings.thinkingLevel)
      .then(setSession)
      .catch(() => undefined);
  }, [settings.thinkingLevel, status.state, setSession]);

  useEffect(() => {
    if (status.state !== "ready") return;
    void window.fastvibe.omp
      .getState()
      .then(setSession)
      .catch(() => undefined);
    // The model list is expensive (~1.5s in the engine) and only changes when
    // providers change, so fetch it once rather than on every engine start.
    if (useSessionStore.getState().models.length === 0) {
      void window.fastvibe.omp
        .getModels()
        .then(setModels)
        .catch(() => undefined);
    }
    void window.fastvibe.omp
      .getCommands()
      .then(setCommands)
      .catch(() => undefined);
    void window.fastvibe.omp
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
    void window.fastvibe.omp.respondPermission({ id: permission.id, confirmed: true });
    setPermission(null);
  }, [permission, permissionAlways, setPermission, settings.permissionMode]);

  // Sending is allowed while the engine is still coming up: the prompt waits
  // behind initialisation, which the user experiences as reply latency.
  const canChat =
    status.state === "ready" || status.state === "starting" || status.state === "idle";
  const active = conversations.find((item) => item.id === activeId);
  const activeProject = projects.find((item) => item.cwd === active?.project);
  const banner =
    status.state === "needsAuth"
      ? null
      : status.state === "missing" || status.state === "error"
        ? "暂时无法开始对话，请稍后重试。"
        : error
          ? "发送失败，请稍后重试。"
          : null;
  // Unbound conversations run in a hidden scratch dir, so never surface that path.
  const workspaceLabel = activeProject?.name ?? "无项目";

  useEffect(() => {
    if (!activeProject) {
      setGitStatus(null);
      return;
    }
    let cancelled = false;
    void window.fastvibe.workspace.gitStatus(activeProject.cwd).then((next) => {
      if (!cancelled) setGitStatus(next);
    }).catch(() => {
      if (!cancelled) setGitStatus(null);
    });
    return () => { cancelled = true; };
  }, [activeProject?.cwd]);

  function applyOpen(result: ConversationOpenResult): void {
    applySnapshot(result);
    setActiveId(result.conversation.id);
    setMessages(result.messages);
    setSession(result.state);
    setStatus(result.status);
    setDraft("");
    setError(null);
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
      // Reuse the active conversation's project, else the most recent project; undefined = unbound.
      const created = await window.fastvibe.conversations.create(active?.project ?? projects[0]?.cwd);
      applyOpen(created);
      conversationId = created.conversation.id;
    }
    setDraft("");
    const promptText = text || currentAttachments.map((item) => item.name).join("、");
    if (streaming) {
      enqueue({ id: crypto.randomUUID(), text: promptText, behavior: queueBehavior });
      setAttachments([]);
    } else {
      addUserMessage(promptText, currentAttachments);
    }
    const nextList = await window.fastvibe.conversations.recordPrompt(conversationId, promptText);
    applyList(nextList);
    const payload = `${wrapPrompt(text || "请查看附件")}${attachmentPromptSuffix(currentAttachments)}`;
    const images = attachmentsToImages(currentAttachments);
    try {
      if (streaming) {
        if (queueBehavior === "steer") await window.fastvibe.omp.steer(payload, images);
        else await window.fastvibe.omp.followUp(payload, images);
      } else {
        await window.fastvibe.omp.prompt(payload, { images });
      }
      void window.fastvibe.omp.getState().then(setSession).catch(() => undefined);
    } catch (err) {
      if (!streaming) dropEmptyAssistant();
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  async function handleAbort(): Promise<void> {
    try {
      try {
        const queued = await window.fastvibe.omp.clearQueue();
        const restored = [...queued.steering, ...queued.followUp].join("\n");
        if (restored && !draft.trim()) setDraft(restored);
      } catch {
        // older engines may not support clear_queue
      }
      await window.fastvibe.omp.abort();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setStreaming(false);
      clearQueued();
      void window.fastvibe.omp.getState().then(setSession).catch(() => undefined);
    }
  }

  async function handleCompact(instructions?: string): Promise<void> {
    try {
      const next = await window.fastvibe.omp.compact(instructions);
      setSession(next);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  async function handleRetry(message: ChatMessage): Promise<void> {
    const source =
      message.role === "user"
        ? message
        : [...messages].reverse().find((item) => item.role === "user" && item.createdAt <= message.createdAt);
    const text = source?.text?.trim();
    if (!text || !canChat) return;
    if (streaming) {
      try {
        await window.fastvibe.omp.abort();
      } catch {
        // ignore
      }
    }
    if (source?.id) {
      try {
        setMessages(await window.fastvibe.omp.branch(source.id));
      } catch {
        // local-only ids cannot branch
      }
    }
    setDraft("");
    addUserMessage(text, source?.attachments);
    try {
      await window.fastvibe.omp.prompt(wrapPrompt(text), {
        images: source?.attachments ? attachmentsToImages(source.attachments) : undefined,
      });
      void window.fastvibe.omp.getState().then(setSession).catch(() => undefined);
    } catch (err) {
      dropEmptyAssistant();
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  async function handleEdit(message: ChatMessage): Promise<void> {
    if (message.id) {
      try {
        setMessages(await window.fastvibe.omp.branch(message.id));
      } catch {
        // ignore
      }
    }
    setDraft(message.text);
  }

  /** Without a project, the new conversation is unbound and shows up under 最近. */
  async function handleNewChat(project?: string): Promise<void> {
    try {
      const created = await window.fastvibe.conversations.create(project);
      applyOpen(created);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  async function handleOpen(id: string): Promise<void> {
    const store = useSessionStore.getState();
    // Re-opening the active chat is pointless once it has content or a reply is
    // streaming, but it is how an empty/failed conversation gets retried.
    if (id === store.activeId && (store.messages.length > 0 || store.streaming)) return;
    try {
      const opened = await window.fastvibe.conversations.open(id);
      applyOpen(opened);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  async function handleAddProject(): Promise<void> {
    try {
      const added = await window.fastvibe.projects.add();
      if (!added) return;
      applyList(added);
      setStatus(await window.fastvibe.omp.getStatus());
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

  async function handleDeleteSession(id: string): Promise<void> {
    try {
      const result = await window.fastvibe.conversations.delete(id);
      applyList(result);
      if (result.nextId) {
        applyOpen(await window.fastvibe.conversations.open(result.nextId));
      } else if (id === activeId) {
        resetConversation();
      }
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

  /** Bind the active conversation to a project, or clear it to "无项目". */
  async function handleSetProject(project: string | null): Promise<void> {
    if (!activeId) return;
    try {
      const snapshot = await window.fastvibe.conversations.setProject(activeId, project);
      applyList(snapshot);
      void window.fastvibe.omp.getStatus().then(setStatus).catch(() => undefined);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  async function handlePickWorkspace(): Promise<void> {
    const picked = await window.fastvibe.workspace.pick();
    if (!picked) return;
    setStatus(picked.status);
    applyList(await window.fastvibe.conversations.list());
    if (activeId) await handleSetProject(picked.cwd);
  }

  async function handleModelChange(provider: string, modelId: string): Promise<void> {
    try {
      let next = await window.fastvibe.omp.setModel(provider, modelId);
      const catalog = models.find((item) => item.provider === provider && item.id === modelId);
      const levels = catalog?.thinkingLevels;
      if (levels?.length && (!next.thinkingLevel || !levels.includes(next.thinkingLevel as never))) {
        next = await window.fastvibe.omp.setThinking(levels.includes("high") ? "high" : levels[0]);
      }
      setSession(next);
    } catch {
      setError("切换模型失败，请稍后重试。");
    }
  }

  async function handleThinkingChange(level: string): Promise<void> {
    try {
      const next = await window.fastvibe.omp.setThinking(level);
      setSession(next);
    } catch {
      setError("无法设置推理强度。");
    }
  }

  const headerTitle = active
    ? [activeProject?.name, active.title].filter(Boolean).join(" / ")
    : "新会话";

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
        onDeleteSession={(id) => void handleDeleteSession(id)}
        onRenameProject={(cwd, name) => void handleRenameProject(cwd, name)}
        onRemoveProject={(cwd) => void handleRemoveProject(cwd)}
        onRevealProject={(cwd) => void window.fastvibe.workspace.reveal(cwd)}
        onOpenSettings={() => setSettingsOpen(true)}
      />
      <main className="flex min-w-0 flex-1 flex-col">
        <header className="drag-region flex h-11 items-center justify-between px-4">
          <div className="no-drag ml-2 truncate text-[12.5px] text-muted-foreground">{headerTitle}</div>
          <div className="no-drag flex items-center gap-1.5">
            {permission ? <span className="text-[11px] text-amber-700">待确认</span> : null}
            {gitStatus?.isRepository ? (
              <button type="button" className="hidden items-center gap-1 rounded-md px-1.5 text-[11px] text-muted-foreground hover:bg-accent sm:flex" title={`${gitStatus.changed} 个改动`} onClick={() => setGitDialogOpen(true)}>
                <GitBranch className="size-3" />
                {gitStatus.branch ?? "HEAD"}
                {gitStatus.changed > 0 ? <span className="text-amber-700">· {gitStatus.changed}</span> : null}
              </button>
            ) : null}
            <StatusPill status={status} session={session} />
            {status.state === "needsAuth" ? null : (
              <SessionMenu
                session={session}
                subagents={subagents}
                streams={subagentStreams}
                stats={stats}
                onCompact={(instructions) => void handleCompact(instructions)}
                onToggleAutoCompact={(enabled) => {
                  void window.fastvibe.omp.setAutoCompaction(enabled).then(setSession).catch(() => setError("无法切换自动压缩"));
                }}
                onToggleInterrupt={(mode) => {
                  void window.fastvibe.omp.setInterruptMode(mode).then(setSession).catch(() => setError("无法切换打断方式"));
                }}
                onToggleSteering={(mode) => {
                  void window.fastvibe.omp.setSteeringMode(mode).then(setSession).catch(() => setError("无法切换打断队列"));
                }}
                onToggleFollowUp={(mode) => {
                  void window.fastvibe.omp.setFollowUpMode(mode).then(setSession).catch(() => setError("无法切换稍后队列"));
                }}
                onExport={() => {
                  void window.fastvibe.omp.exportHtml().catch(() => setError("导出失败"));
                }}
              />
            )}
          </div>
        </header>
        <div className="min-h-0 flex-1">
          {status.state === "needsAuth" ? (
            <ConnectForm onConnected={() => setError(null)} />
          ) : (
            <MessageList
              messages={messages}
              streaming={streaming}
              loading={status.state === "starting" && messages.length === 0}
              onRetry={(message) => void handleRetry(message)}
              onEdit={(message) => void handleEdit(message)}
              showThinking={settings.showThinking}
              showTimestamp={settings.showTimestamps}
              onSuggestion={(prompt) => setDraft(prompt)}
            />
          )}
        </div>
        {status.state === "needsAuth" ? null : (
          <RunStatusBar session={session} queued={queued} />
        )}
        {banner ? (
          <div className="mx-auto mb-2 w-full max-w-3xl px-6">
            <Alert variant="destructive">
              <AlertCircleIcon />
              <AlertTitle>出了点问题</AlertTitle>
              <AlertDescription>{banner}</AlertDescription>
              {status.state === "missing" || status.state === "error" ? (
                <AlertAction>
                  <Button
                    size="xs"
                    variant="outline"
                    onClick={() => void window.fastvibe.omp.start(status.cwd)}
                  >
                    重试
                  </Button>
                </AlertAction>
              ) : null}
            </Alert>
          </div>
        ) : null}
        {status.state === "needsAuth" ? null : (
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
            commands={commands}
            permissionMode={settings.permissionMode}
            onPermissionModeChange={(mode) => updateSettings({ permissionMode: mode })}
            queueBehavior={queueBehavior}
            queued={queued}
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
            onQueueBehaviorChange={setQueueBehavior}
            onAttachmentsChange={setAttachments}
            sendOnEnter={settings.sendOnEnter}
          />
        )}
      </main>
      {preview ? <PreviewPanel preview={preview} onClose={() => setPreview(null)} /> : null}
      <SettingsDialog
        open={settingsOpen}
        onOpenChange={setSettingsOpen}
        status={status}
        session={session}
        models={models}
        project={activeProject?.cwd}
        onRenameSession={(id, title) => void handleRenameSession(id, title)}
        onProvidersChanged={() => {
          void window.fastvibe.omp.getModels().then(setModels).catch(() => undefined);
          void window.fastvibe.omp.getState().then(setSession).catch(() => undefined);
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
      <GitStatusDialog open={gitDialogOpen} status={gitStatus} onOpenChange={setGitDialogOpen} />
      <PermissionDialog
        key={permission?.id ?? "permission"}
        request={permission}
        onRespond={(payload) => {
          if (payload.always && permission) rememberPermission(permissionKey(permission));
          void window.fastvibe.omp.respondPermission(payload);
          setPermission(null);
        }}
      />
    </div>
  );
}
