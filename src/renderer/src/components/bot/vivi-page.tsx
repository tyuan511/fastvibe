import { memo, useEffect, useMemo, useRef, useState, type JSX } from "react";
import { useSearchParams } from "react-router";
import { useTranslation } from "react-i18next";
import { HugeiconsIcon } from "@hugeicons/react";
import { PanelLeftOpenIcon, PanelRightOpenIcon, Cancel01Icon, Task01Icon, FileEditIcon, Search01Icon } from "@hugeicons/core-free-icons";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Empty, EmptyHeader, EmptyMedia, EmptyTitle, EmptyDescription } from "@/components/ui/empty";
import { FastVibeMascot } from "@/components/fastvibe-mascot";
import { IconButton } from "@/components/icon-button";
import { MessageList } from "@/components/chat/message-list";
import { Composer } from "@/components/chat/composer";
import { useSessionStore } from "@/stores/session";
import { useSettingsStore } from "@/stores/settings";
import { useSidePaneStore } from "@/stores/side-pane";
import { normalizeViviSettings } from "@shared/vivi";
import { HAS_TRAFFIC_LIGHTS } from "@/lib/platform";
import { attachmentPromptSuffix, attachmentsToImages } from "@/lib/attachments";
import { cn } from "@/lib/utils";
import { BotQuestions } from "./bot-questions";
import { useBotSnapshot } from "./use-bot-snapshot";
import { botChatMessages } from "@/lib/vivi-chat";
import { useBotComposerState } from "./bot-composer-state";
import type { BotSubmitRequest, BotConversationMeta } from "@shared/bot";
import type { EngineModel } from "@shared/types";

const Transcript = memo(MessageList);
const STARTERS = [
  { key: "write", icon: FileEditIcon },
  { key: "research", icon: Search01Icon },
  { key: "organize", icon: Task01Icon },
] as const;

export function ViviPage({ mainModel, sidebarCollapsed, onExpandSidebar, onManageModels }: {
  mainModel?: EngineModel;
  sidebarCollapsed: boolean;
  onExpandSidebar: () => void;
  onManageModels: () => void;
}): JSX.Element {
  const { t } = useTranslation("app");
  const { snapshot, loading, error, adopt, refresh } = useBotSnapshot();
  const [search, setSearch] = useSearchParams();
  const draft = useBotComposerState((state) => state.draft);
  const attachments = useBotComposerState((state) => state.attachments);
  const sending = useBotComposerState((state) => state.sending);
  const actionError = useBotComposerState((state) => state.error);
  const setDraft = useBotComposerState((state) => state.setDraft);
  const setAttachments = useBotComposerState((state) => state.setAttachments);
  const setActionError = (value: string | null) => useBotComposerState.setState({ error: value });
  const sendLock = useRef(false);
  const hasMainModel = Boolean(mainModel);
  const commands = useSessionStore((state) => state.commands);
  const sendOnEnter = useSettingsStore((state) => state.settings.sendOnEnter);
  const paneCollapsed = useSidePaneStore((state) => state.collapsed);
  const openWork = useSidePaneStore((state) => state.openBotTasks);
  const [palette, setPalette] = useState(() => normalizeViviSettings(window.fastvibe.settings.initial).palette);
  const routerId = snapshot?.routerConversationId;
  const workers = useMemo(() => (snapshot?.conversations ?? []).filter((item) => item.role === "worker"), [snapshot]);
  const targetId = search.get("followup") || search.get("conversation");
  const target = workers.find((item) => item.conversationId === targetId);
  const questions = snapshot?.attention ?? [];
  const targetTitle = target?.title ?? "";
  const messages = useMemo(() => botChatMessages(snapshot?.messages ?? []), [snapshot?.messages]);
  const empty = !loading && messages.length === 0;
  const mood = questions.length ? "waiting" : "idle";
  const status = questions.length ? t("viviBot.waitingCount", { count: questions.length }) : t("viviBot.ready");
  const feedbackError = actionError || (snapshot?.error ? t("viviBot.executionFailed") : null);

  useEffect(() => window.fastvibe.settings.onChanged((settings) => setPalette(normalizeViviSettings(settings).palette)), []);
  useEffect(() => {
    if (!snapshot) return;
    const conversationId = search.get("conversation") || search.get("task") || search.get("run");
    if (!conversationId) return;
    const conversation = workers.find((item) => item.conversationId === conversationId);
    if (conversation) useSidePaneStore.getState().openBotConversation(conversation.conversationId, conversation.title);
    else openWork();
    setSearch((current) => { const next = new URLSearchParams(current); next.delete("conversation"); next.delete("task"); next.delete("run"); return next; }, { replace: true });
  }, [snapshot, workers, openWork, search, setSearch]);

  const answer = async (attentionId: string, value: string): Promise<void> => {
    const next = await window.fastvibe.bot.answer({ attentionId, answer: value });
    adopt(next); refresh();
  };
  const submit = async (): Promise<void> => {
    if (sendLock.current || sending || !hasMainModel || (!draft.trim() && attachments.length === 0)) return;
    const text = draft.trim();
    const promptText = `${text}${attachmentPromptSuffix(attachments)}`;
    const images = attachmentsToImages(attachments);
    const previous = useBotComposerState.getState().request;
    const request: BotSubmitRequest = previous && previous.text === promptText && previous.conversationId === target?.conversationId && JSON.stringify(previous.images ?? []) === JSON.stringify(images)
      ? previous
      : { requestId: crypto.randomUUID(), text: promptText, ...(images.length ? { images } : {}), ...(target ? { conversationId: target.conversationId } : {}) };
    useBotComposerState.setState({ request, sending: true, error: null });
    sendLock.current = true;
    try {
      const next = await window.fastvibe.bot.submit(request);
      adopt(next);
      const current = useBotComposerState.getState();
      if (current.request?.requestId === request.requestId) useBotComposerState.setState({ request: null, ...(current.draft.trim() === text ? { draft: "", attachments: [] } : {}) });
      setSearch((currentParams) => { const nextParams = new URLSearchParams(currentParams); nextParams.delete("followup"); return nextParams; }, { replace: true });
      refresh();
    } catch (cause) { setActionError(cause instanceof Error ? cause.message : String(cause)); }
    finally { sendLock.current = false; useBotComposerState.setState({ sending: false }); }
  };
  return <main className="@container/vivi relative flex min-h-0 min-w-0 flex-1 flex-col" data-vivi-workspace>
    <header className={cn("drag-region flex h-11 shrink-0 items-center gap-2 px-4", sidebarCollapsed && HAS_TRAFFIC_LIGHTS && "pl-[calc(5.5rem+8px)]")}>
      {sidebarCollapsed ? <IconButton className="no-drag" variant="ghost" size="icon-sm" label={t("workspace.expandSidebar")} onClick={onExpandSidebar}><HugeiconsIcon strokeWidth={2} icon={PanelLeftOpenIcon} /></IconButton> : null}
      <FastVibeMascot size="size-6" palette={palette} status={mood} motion={false} />
      <h1 className="text-sm font-semibold">Vivi</h1>
      {questions.length ? <span className="hidden items-center gap-1.5 text-xs text-muted-foreground @min-[28rem]/vivi:flex"><span aria-hidden className="ml-1 size-1.5 rounded-full bg-warning" />{status}</span> : null}
      <div className="no-drag ml-auto flex shrink-0 items-center gap-1">
        <Button variant="ghost" size="sm" className="gap-1.5 text-muted-foreground" onClick={openWork}><HugeiconsIcon strokeWidth={2} icon={Task01Icon} className="size-4" /><span>{t("viviBot.tasks")}</span>{workers.length ? <Badge variant="secondary" className="h-4.5 min-w-4.5 px-1 text-xs tabular-nums">{workers.length}</Badge> : null}</Button>
        {paneCollapsed ? <IconButton size="icon-sm" variant="ghost" label={t("workspace.expandSidePane")} onClick={() => useSidePaneStore.getState().setCollapsed(false)}><HugeiconsIcon strokeWidth={2} icon={PanelRightOpenIcon} /></IconButton> : null}
      </div>
    </header>
    {error ? <div className="mx-auto flex w-full max-w-3xl items-center gap-3 px-6 py-3"><p role="alert" className="min-w-0 flex-1 wrap-anywhere text-sm text-destructive">{error}</p><Button variant="outline" size="sm" onClick={refresh}>{t("viviBot.retry")}</Button></div> : null}
    <div className="relative min-h-0 flex-1"><Transcript cwd={null} messages={messages} conversationId={routerId ?? "vivi"} streaming={false} loading={loading} emptyState={<Empty className="h-full gap-6 pb-8"><EmptyHeader className="max-w-md gap-3"><EmptyMedia className="relative mb-1"><span aria-hidden className="absolute inset-0 scale-150 rounded-full bg-primary/5 blur-2xl" /><FastVibeMascot size="size-20" palette={palette} status="idle" /></EmptyMedia><EmptyTitle className="text-2xl font-semibold tracking-tight">{t("viviBot.greeting")}</EmptyTitle><EmptyDescription className="max-w-sm text-sm leading-6">{t("viviBot.description")}</EmptyDescription></EmptyHeader>{hasMainModel ? <div className="flex max-w-lg flex-wrap justify-center gap-2">{STARTERS.map(({ key, icon }) => <Button key={key} type="button" variant="outline" size="sm" className="h-auto gap-2 rounded-xl bg-card/60 px-3 py-2 font-normal text-muted-foreground shadow-none hover:text-foreground" disabled={sending} onClick={() => setDraft(t(`viviBot.starters.${key}.prompt`))}><HugeiconsIcon strokeWidth={1.8} icon={icon} className="size-3.5" />{t(`viviBot.starters.${key}.label`)}</Button>)}</div> : <Button variant="outline" size="sm" onClick={onManageModels}>{t("viviBot.addModels")}</Button>}</Empty>} /></div>
    <div className="safe-bottom transcript-gutter shrink-0 px-4 pb-3 sm:px-6"><div className="mx-auto w-full max-w-3xl">
      {questions.length ? <div className="mb-3 max-h-[min(20rem,40dvh)] overflow-y-auto"><BotQuestions questions={questions} limit={1} onAnswer={answer} /></div> : null}
      {feedbackError ? <p role="alert" className="mb-2 wrap-anywhere text-sm text-destructive">{feedbackError}</p> : null}
      <div className="relative">
        {target ? <div className="flex min-w-0 items-center gap-2 px-3 pt-3 text-xs"><Badge variant="secondary" className="min-w-0 truncate">{targetTitle}</Badge><IconButton type="button" size="icon-xs" variant="ghost" label={t("viviBot.clearTarget")} disabled={sending} onClick={() => setSearch((current) => { const next = new URLSearchParams(current); next.delete("followup"); return next; }, { replace: true })}><HugeiconsIcon strokeWidth={2} icon={Cancel01Icon} /></IconButton></div> : null}
        <Composer
          className="px-0 pb-0"
          value={draft}
          disabled={!hasMainModel || sending}
          streaming={false}
          working={false}
          placeholder={t(!hasMainModel ? "viviBot.noModel" : target ? "viviBot.supplementPlaceholder" : "viviBot.placeholder")}
          models={[]}
          model={mainModel}
          thinkingLevel={undefined}
          workspaceLabel={t("viviBot.ownWorkspace")}
          projects={[]}
          project={undefined}
          newSession={false}
          hideModelPicker
          commands={commands}
          queued={[]}
          queuePause={null}
          attachments={attachments}
          history={() => messages.filter((message) => message.role === "user").map((message) => message.text)}
          contextPercent={undefined}
          contextUsage={undefined}
          stats={null}
          onChange={setDraft}
          onSubmit={() => void submit()}
          onAbort={() => undefined}
          onPickWorkspace={() => undefined}
          onSelectProject={() => undefined}
          onModelChange={() => undefined}
          onManageModels={onManageModels}
          onThinkingChange={() => undefined}
          onAttachmentsChange={setAttachments}
          onRemoveQueued={() => undefined}
          onEditQueued={() => undefined}
          onSendQueuedNow={() => undefined}
          onRecallQueued={() => undefined}
          onReorderQueued={() => undefined}
          onResumeQueue={() => undefined}
          canResume={false}
          onResumeRun={() => undefined}
          sendOnEnter={sendOnEnter}
        />
      </div><p className={cn("mt-2 text-center text-xs leading-5 text-muted-foreground/70", !empty && "hidden sm:block")}>{t("viviBot.backgroundHint")}</p>
    </div></div>
  </main>;
}
