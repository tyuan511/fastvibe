import { memo, useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore, type JSX, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import { HugeiconsIcon } from "@hugeicons/react";
import {
  ArrowDown01Icon,
  ArrowUp02Icon,
  Cancel01Icon,
  Folder01Icon,
  Image01Icon,
  Menu01Icon,
  PencilEdit02Icon,
  PlayIcon,
  ShieldCheckIcon,
  SparklesIcon,
  SquareIcon,
} from "@hugeicons/core-free-icons";
import { isAbortOutcome } from "@shared/abort";
import { THINKING_EFFORT_LEVELS, type ChatAttachment, type EngineModel, type ThinkingLevel } from "@shared/types";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { MessageList } from "@/components/chat/message-list";
import { PermissionDialog } from "@/components/chat/permission-dialog";
import { PermissionPanel, type PermissionResponse } from "@/components/chat/permission-panel";
import { ProviderIcon } from "@/components/provider-icon";
import { RunningMark } from "@/components/running-mark";
import { usePermissionModeSelection } from "@/components/permission-mode-provider";
import { attachmentPromptSuffix, attachmentsToImages } from "@/lib/attachments";
import { shouldQueueSubmission } from "@/lib/composer-race";
import { engine, respondPermission } from "@/lib/engine-client";
import { permissionKey, rememberPermission, usePermissionAlways } from "@/lib/permission-rules";
import { PERMISSION_MODES, permissionDescription, permissionLabel } from "@/lib/permission-modes";
import { thinkingLabel } from "@/lib/thinking-levels";
import { cn } from "@/lib/utils";
import { activePermission, useConversationWorking, useSessionStore } from "@/stores/session";
import { useSettingsStore } from "@/stores/settings";
import { ConversationMenu } from "./conversation-menu";
import { photoToAttachment } from "./images";
import { getLoadState, onLoadState, showConversation } from "./live";
import { OptionSheet, type SheetOptionGroup } from "./option-sheet";
import { navigate } from "./route";

/** The project picker's value for 无项目 (a chat in the scratch workspace). */
const NO_PROJECT = "__none__";

/**
 * What a new chat will start with, chosen before it exists.
 *
 * The desktop holds these on the engine (`#pendingModel`), which is one value for every
 * client and is dropped the moment any conversation is activated — the desktop switching
 * chats would discard the phone's pick. So the phone holds them itself and applies them
 * to the conversation it creates, before its first prompt.
 */
type Draft = { project?: string; model?: EngineModel; thinking?: ThinkingLevel };

/**
 * One conversation on the phone — or, with no id, the page a new one starts from.
 *
 * Three rows: a header (the drawer, the title, what can be done to this chat), the
 * desktop's own transcript, and at the bottom either the composer or, while the agent is
 * parked on a question, the same approval panel the desktop draws in the composer's place.
 */
export function ChatScreen({
  conversationId,
  initialProject,
  onOpenDrawer,
}: {
  conversationId: string | null;
  initialProject?: string;
  onOpenDrawer: () => void;
}): JSX.Element {
  const { t } = useTranslation("app");
  const activeId = useSessionStore((state) => state.activeId);
  const conversation = useSessionStore((state) => state.conversations.find((item) => item.id === state.activeId));
  const projects = useSessionStore((state) => state.projects);
  // 等你 somewhere other than here: the only thing worth a mark on the drawer button.
  const waitingElsewhere = useSessionStore((state) =>
    Object.entries(state.waitingForUser).some(([id, waiting]) => waiting && id !== state.activeId),
  );
  const working = useConversationWorking();
  const [draft, setDraft] = useState<Draft>({ project: initialProject });
  const load = useSyncExternalStore(onLoadState, getLoadState, getLoadState);
  const loading = load.id === conversationId && load.loading;
  const failed = load.id === conversationId ? load.error : null;
  // The chat this page is about is either the route's or, once a new chat's first send
  // created one, that one — the route follows a moment later.
  const shownId = conversationId ?? activeId;
  const projectName = projects.find((item) => item.cwd === conversation?.project)?.name;

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <header className="flex h-14 shrink-0 items-center gap-1 border-b border-border/60 px-1">
        <Button variant="ghost" size="icon-lg" aria-label={t("mobile.openDrawer")} className="relative" onClick={onOpenDrawer}>
          <HugeiconsIcon icon={Menu01Icon} strokeWidth={2} className="size-5" />
          {waitingElsewhere ? (
            <span className="absolute top-1.5 right-1.5 size-2 rounded-full bg-warning" aria-hidden="true" />
          ) : null}
        </Button>
        <div className="min-w-0 flex-1 px-1">
          <p className="flex items-center gap-2 truncate text-sm font-semibold">
            <span className="truncate">{shownId ? conversation?.title || t("mobile.untitled") : t("mobile.newChat")}</span>
            {working ? <RunningMark className="size-3.5" /> : null}
          </p>
          {shownId && projectName ? <p className="truncate text-xs text-muted-foreground">{projectName}</p> : null}
        </div>
        {shownId && conversation ? <ConversationMenu conversation={conversation} /> : null}
        {shownId ? (
          <Button variant="ghost" size="icon-lg" aria-label={t("mobile.newChat")} onClick={() => navigate({ kind: "new" })}>
            <HugeiconsIcon icon={PencilEdit02Icon} strokeWidth={2} className="size-5" />
          </Button>
        ) : null}
      </header>

      <div className="relative min-h-0 flex-1">
        {failed ? (
          <div className="flex h-full flex-col items-center justify-center gap-3 px-6 text-center">
            <p className="text-sm text-muted-foreground">{t("mobile.loadFailed", { message: failed })}</p>
            <Button variant="outline" onClick={() => void showConversation(conversationId)}>
              {t("alert.retry")}
            </Button>
          </div>
        ) : (
          <Thread loading={loading} conversationId={shownId} />
        )}
      </div>

      <BottomSlot draft={draft} onDraftChange={setDraft} />
    </div>
  );
}

/** The transcript, subscribed on its own so a streamed token re-renders only this. */
const Thread = memo(function Thread({ loading, conversationId }: { loading: boolean; conversationId: string | null }): JSX.Element {
  const { t } = useTranslation("app");
  const messages = useSessionStore((state) => state.messages);
  const streaming = useSessionStore((state) => state.streaming);
  return (
    <MessageList
      messages={messages}
      streaming={streaming}
      conversationId={conversationId}
      loading={loading}
      loadingReplaces={loading}
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
function BottomSlot({ draft, onDraftChange }: { draft: Draft; onDraftChange: (draft: Draft) => void }): JSX.Element {
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
        <MobileComposer draft={draft} onDraftChange={onDraftChange} />
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
  return <MobileComposer draft={draft} onDraftChange={onDraftChange} />;
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function modelKey(model: EngineModel): string {
  return `${model.provider}\u0000${model.id}`;
}

function MobileComposer({ draft, onDraftChange }: { draft: Draft; onDraftChange: (draft: Draft) => void }): JSX.Element {
  const { t } = useTranslation("app");
  const activeId = useSessionStore((state) => state.activeId);
  const text = useSessionStore((state) => state.draft);
  const attachments = useSessionStore((state) => state.attachments);
  const setText = useSessionStore((state) => state.setDraft);
  const setAttachments = useSessionStore((state) => state.setAttachments);
  const working = useConversationWorking();
  const canResume = useSessionStore((state) => state.canResume) && Boolean(activeId) && !working;
  const models = useSessionStore((state) => state.models);
  const allQueued = useSessionStore((state) => state.queued);
  const queuePause = useSessionStore((state) => state.queuePause);
  const queueBehavior = useSettingsStore((state) => state.settings.queueBehavior);
  const queued = activeId ? allQueued.filter((item) => item.conversationId === activeId) : [];
  /** A prompt is busy only while the direct RPC is awaiting acceptance. */
  const sending = useRef(false);
  const fileInput = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);

  const trimmed = text.trim();
  const hasContent = trimmed.length > 0 || attachments.length > 0;
  const hasModel = models.length > 0;
  const queueing = Boolean(activeId) && (working || queued.length > 0);

  async function send(): Promise<void> {
    if (sending.current || !hasContent) return;
    if (!hasModel) {
      toast.error(t("mobile.needModel"));
      return;
    }
    sending.current = true;
    setBusy(true);
    const message = trimmed;
    const files = attachments;
    const promptText = message || t("composer.seeAttachments");
    const payload = `${promptText}${attachmentPromptSuffix(files)}`;
    const images = attachmentsToImages(files);
    const store = useSessionStore.getState();
    let id = store.activeId;
    try {
      if (!id) {
        // Created without activating: the desktop keeps the chat it is showing.
        const created = await window.fastvibe.conversations.create(draft.project, { activate: false });
        store.applySnapshot(created);
        id = created.conversation.id;
        await showConversation(id);
        await applyDraftChoices(id, draft, models);
        navigate({ kind: "chat", id }, { replace: true });
      }
      const current = useSessionStore.getState();
      const queue = shouldQueueSubmission({
        hasConversation: true,
        running: current.running[id] === true,
        hasQueuedItems: current.queued.some((item) => item.conversationId === id),
      });
      current.setComposer("", []);
      const listed = await window.fastvibe.conversations.recordPrompt(id, promptText);
      useSessionStore.getState().applySnapshot(listed);
      if (queue) {
        const next = await window.fastvibe.engine.queueAdd({
          conversationId: id,
          text: promptText,
          message: payload,
          behavior: queueBehavior,
          attachments: files,
          images,
        });
        useSessionStore.getState().setQueueState(next);
        return;
      }
      const after = useSessionStore.getState();
      if (after.activeId === id) {
        after.addUserMessage(promptText, files);
        after.setRunInterrupted(null);
        after.setCanResume(false);
      }
      const target = id;
      // Not awaited: `prompt` resolves once the engine accepts the message, which can
      // still wait out a settling run. A rejection means it was refused, so the text is
      // handed back; a run that fails after acceptance is reported by its own events.
      void engine.prompt(payload, { images, conversationId: target }).catch((error: unknown) => {
        if (isAbortOutcome(error)) return;
        const latest = useSessionStore.getState();
        if (latest.activeId === target) {
          latest.rollbackOptimisticPrompt();
          if (!latest.draft && latest.attachments.length === 0) latest.setComposer(message, files);
        }
        toast.error(t("mobile.sendFailed", { message: errorText(error) }));
      });
    } catch (error) {
      const latest = useSessionStore.getState();
      if (latest.activeId === id && !latest.draft && latest.attachments.length === 0) latest.setComposer(message, files);
      toast.error(t("mobile.sendFailed", { message: errorText(error) }));
    } finally {
      sending.current = false;
      setBusy(false);
    }
  }

  function stop(): void {
    if (!activeId) return;
    void engine.abort(activeId).catch((error: unknown) => toast.error(errorText(error)));
  }

  function resume(): void {
    if (!activeId) return;
    const store = useSessionStore.getState();
    store.setRunInterrupted(null);
    store.setCanResume(false);
    void engine.continue(activeId).catch((error: unknown) => {
      if (isAbortOutcome(error)) return;
      toast.error(errorText(error));
    });
  }

  function removeQueued(id: string): void {
    void window.fastvibe.engine
      .queueCancel(id)
      .then((next) => {
        if (next) useSessionStore.getState().setQueueState(next);
      })
      .catch((error: unknown) => toast.error(errorText(error)));
  }

  function resumeQueue(): void {
    if (!activeId) return;
    void window.fastvibe.engine
      .queueResume(activeId)
      .then((next) => useSessionStore.getState().setQueueState(next))
      .catch((error: unknown) => toast.error(errorText(error)));
  }

  async function addPhotos(files: FileList | null): Promise<void> {
    if (!files || files.length === 0) return;
    const added: ChatAttachment[] = [];
    let failures = 0;
    for (const file of Array.from(files)) {
      const attachment = await photoToAttachment(file);
      if (attachment) added.push(attachment);
      else failures += 1;
    }
    if (failures > 0) toast.error(t("mobile.imageFailed", { count: failures }));
    if (added.length > 0) setAttachments([...useSessionStore.getState().attachments, ...added]);
  }

  // One button, whichever action is the useful one right now: with something to send it
  // always sends (or queues); empty, it stops a working chat or continues a stopped one.
  const action: "send" | "stop" | "continue" = hasContent ? "send" : working ? "stop" : canResume ? "continue" : "send";

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

      {attachments.length > 0 ? (
        <div className="mb-2 flex gap-2 overflow-x-auto [scrollbar-width:none]">
          {attachments.map((item) => (
            <div key={item.id} className="relative size-16 shrink-0 overflow-hidden rounded-lg border border-border/60 bg-muted">
              {item.dataUrl ? <img src={item.dataUrl} alt={item.name} className="size-full object-cover" /> : null}
              <button
                type="button"
                aria-label={t("mobile.removeAttachment")}
                className="absolute top-0.5 right-0.5 flex size-6 items-center justify-center rounded-full bg-background/90 text-foreground shadow-sm"
                onClick={() => setAttachments(attachments.filter((other) => other.id !== item.id))}
              >
                <HugeiconsIcon icon={Cancel01Icon} strokeWidth={2} className="size-3.5" />
              </button>
            </div>
          ))}
        </div>
      ) : null}

      <ComposerChips draft={draft} onDraftChange={onDraftChange} />

      <div className="flex items-end gap-2 pb-2">
        <Button
          variant="ghost"
          size="icon-lg"
          className="size-10 shrink-0 rounded-full text-muted-foreground"
          aria-label={t("mobile.attach")}
          onClick={() => fileInput.current?.click()}
        >
          <HugeiconsIcon icon={Image01Icon} strokeWidth={2} className="size-5" />
        </Button>
        <input
          ref={fileInput}
          type="file"
          accept="image/*"
          multiple
          hidden
          onChange={(event) => {
            void addPhotos(event.target.files);
            event.target.value = "";
          }}
        />
        <Textarea
          value={text}
          onChange={(event) => setText(event.target.value)}
          onKeyDown={(event) => {
            // A soft keyboard's Enter is a newline; a hardware keyboard gets ⌘/Ctrl+Enter.
            if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
              event.preventDefault();
              void send();
            }
          }}
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
          disabled={action === "send" ? !hasContent || busy : false}
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

/**
 * Apply what the new-chat page picked to the conversation just created for it, before
 * its first prompt: the same two calls the chips make on an existing chat.
 */
async function applyDraftChoices(id: string, draft: Draft, models: ReturnType<typeof useSessionStore.getState>["models"]): Promise<void> {
  try {
    let state = null;
    if (draft.model) {
      state = await engine.setModel(draft.model.provider, draft.model.id, id);
    }
    const levels = draft.model
      ? models.find((item) => item.provider === draft.model?.provider && item.id === draft.model?.id)?.thinkingLevels
      : undefined;
    const thinking = draft.thinking && (!levels || levels.includes(draft.thinking)) ? draft.thinking : undefined;
    if (thinking) state = await engine.setThinking(thinking, id);
    if (state) useSessionStore.getState().setSession(state);
  } catch (error) {
    // The chat exists and the prompt can still go out on the default model; say what
    // did not stick rather than refusing the send.
    toast.error(errorText(error));
  }
}

type Picker = "model" | "thinking" | "permission" | "project" | null;

/**
 * The row of chips above the input: model, thinking, permission — and on a new chat,
 * the project it will run in.
 *
 * On an existing chat each choice is applied at once, to that conversation by id. On
 * the new-chat page there is no conversation yet, so they are held in `draft` and
 * applied when the first send creates one (`applyDraftChoices`).
 */
function ComposerChips({ draft, onDraftChange }: { draft: Draft; onDraftChange: (draft: Draft) => void }): JSX.Element {
  const { t } = useTranslation("app");
  const activeId = useSessionStore((state) => state.activeId);
  const session = useSessionStore((state) => state.session);
  const models = useSessionStore((state) => state.models);
  const projects = useSessionStore((state) => state.projects);
  const settings = useSettingsStore((state) => state.settings);
  const projectDefault = !activeId && draft.project ? settings.projectDefaults?.[draft.project] : undefined;
  const defaultModel = projectDefault?.model ?? settings.defaultModel;
  const defaultThinking = projectDefault?.thinkingLevel && projectDefault.thinkingLevel !== "auto"
    ? projectDefault.thinkingLevel
    : undefined;
  const permissionMode = settings.permissionMode;
  const { setPermissionMode } = usePermissionModeSelection();
  const [picker, setPicker] = useState<Picker>(null);

  const existing = Boolean(activeId);
  const currentModel: EngineModel | undefined = existing ? session?.model : draft.model ?? defaultModel;
  const catalog = currentModel
    ? models.find((item) => item.provider === currentModel.provider && item.id === currentModel.id)
    : undefined;
  const levels = (catalog?.thinkingLevels ?? []).filter((level): level is ThinkingLevel =>
    (THINKING_EFFORT_LEVELS as readonly string[]).includes(level),
  );
  const currentThinking = (existing ? session?.thinkingLevel : draft.thinking ?? defaultThinking) as ThinkingLevel | undefined;

  const modelGroups = useMemo<SheetOptionGroup[]>(() => {
    const groups = new Map<string, SheetOptionGroup>();
    for (const model of models) {
      const group = groups.get(model.provider) ?? { label: model.providerName, options: [] };
      group.options.push({
        value: modelKey(model),
        label: model.name || model.id,
        icon: <ProviderIcon provider={model.provider} className="size-4" />,
      });
      groups.set(model.provider, group);
    }
    return [...groups.values()];
  }, [models]);

  async function chooseModel(value: string): Promise<void> {
    const [provider, id] = value.split("\u0000");
    if (!provider || !id) return;
    if (!activeId) {
      onDraftChange({ ...draft, model: { provider, id } });
      return;
    }
    try {
      let next = await engine.setModel(provider, id, activeId);
      // Keep a thinking level the new model can run with, as the desktop composer does.
      const offered = models.find((item) => item.provider === provider && item.id === id)?.thinkingLevels;
      if (offered?.length && (!next.thinkingLevel || !offered.includes(next.thinkingLevel as ThinkingLevel))) {
        next = await engine.setThinking(offered.includes("high") ? "high" : offered[0], activeId);
      }
      useSessionStore.getState().setSession(next);
    } catch (error) {
      toast.error(t("errors.switchModel"), { description: errorText(error) });
    }
  }

  async function chooseThinking(value: string): Promise<void> {
    const level = value as ThinkingLevel;
    if (!activeId) {
      onDraftChange({ ...draft, thinking: level });
      return;
    }
    try {
      useSessionStore.getState().setSession(await engine.setThinking(level, activeId));
    } catch (error) {
      toast.error(t("errors.thinking"), { description: errorText(error) });
    }
  }

  const localProjects = projects.filter((item) => item.kind !== "remote");
  const projectName = draft.project ? projects.find((item) => item.cwd === draft.project)?.name ?? draft.project : null;

  return (
    <>
      <div className="-mx-3 mb-1 flex gap-1 overflow-x-auto px-3 [scrollbar-width:none]">
        {!existing ? (
          <Chip icon={<HugeiconsIcon icon={Folder01Icon} strokeWidth={2} className="size-3.5" />} onClick={() => setPicker("project")}>
            {projectName ?? t("mobile.noProject")}
          </Chip>
        ) : null}
        <Chip
          icon={currentModel ? <ProviderIcon provider={currentModel.provider} className="size-3.5" /> : null}
          onClick={() => setPicker("model")}
          disabled={models.length === 0}
        >
          {catalog?.name || currentModel?.id || t("mobile.defaultModel")}
        </Chip>
        {levels.length > 0 ? (
          <Chip icon={<HugeiconsIcon icon={SparklesIcon} strokeWidth={2} className="size-3.5" />} onClick={() => setPicker("thinking")}>
            {currentThinking ? thinkingLabel(currentThinking) : t("mobile.thinking")}
          </Chip>
        ) : null}
        <Chip icon={<HugeiconsIcon icon={ShieldCheckIcon} strokeWidth={2} className="size-3.5" />} onClick={() => setPicker("permission")}>
          {permissionLabel(permissionMode)}
        </Chip>
      </div>

      <OptionSheet
        open={picker === "model"}
        onOpenChange={(open) => setPicker(open ? "model" : null)}
        title={t("mobile.model")}
        groups={modelGroups}
        value={currentModel ? modelKey(currentModel) : null}
        onSelect={(value) => void chooseModel(value)}
      />
      <OptionSheet
        open={picker === "thinking"}
        onOpenChange={(open) => setPicker(open ? "thinking" : null)}
        title={t("mobile.thinking")}
        groups={[{ options: levels.map((level) => ({ value: level, label: thinkingLabel(level) })) }]}
        value={currentThinking ?? null}
        onSelect={(value) => void chooseThinking(value)}
      />
      <OptionSheet
        open={picker === "permission"}
        onOpenChange={(open) => setPicker(open ? "permission" : null)}
        title={t("mobile.permission")}
        description={t("mobile.permissionScope")}
        groups={[
          {
            options: PERMISSION_MODES.map((mode) => ({
              value: mode,
              label: permissionLabel(mode),
              description: permissionDescription(mode),
            })),
          },
        ]}
        value={permissionMode}
        onSelect={(value) => setPermissionMode(value as typeof permissionMode)}
      />
      <OptionSheet
        open={picker === "project"}
        onOpenChange={(open) => setPicker(open ? "project" : null)}
        title={t("mobile.project")}
        description={t("mobile.newChatHint")}
        groups={[
          {
            options: [
              { value: NO_PROJECT, label: t("mobile.noProject") },
              ...localProjects.map((item) => ({ value: item.cwd, label: item.name, description: item.cwd })),
            ],
          },
        ]}
        value={draft.project ?? NO_PROJECT}
        onSelect={(value) => onDraftChange({ ...draft, project: value === NO_PROJECT ? undefined : value })}
      />
    </>
  );
}

function Chip({
  icon,
  children,
  onClick,
  disabled,
}: {
  icon?: ReactNode;
  children: string;
  onClick: () => void;
  disabled?: boolean;
}): JSX.Element {
  return (
    <Button
      variant="ghost"
      size="sm"
      className="h-8 shrink-0 gap-1 rounded-full px-2.5 text-xs font-normal text-muted-foreground"
      disabled={disabled}
      onClick={onClick}
    >
      {icon}
      <span className="max-w-36 truncate">{children}</span>
      <HugeiconsIcon icon={ArrowDown01Icon} strokeWidth={2} className="size-3 opacity-60" />
    </Button>
  );
}
