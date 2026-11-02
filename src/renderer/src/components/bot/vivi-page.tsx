import { memo, useEffect, useMemo, useRef, useState, type JSX } from "react";
import { useSearchParams } from "react-router";
import { useTranslation } from "react-i18next";
import { HugeiconsIcon } from "@hugeicons/react";
import { ArrowUp02Icon, ArrowRight01Icon, PanelLeftOpenIcon, PanelRightOpenIcon, Cancel01Icon, Folder01Icon, Task01Icon, FileEditIcon, Search01Icon } from "@hugeicons/core-free-icons";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Badge } from "@/components/ui/badge";
import { Spinner } from "@/components/ui/spinner";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Empty, EmptyHeader, EmptyMedia, EmptyTitle, EmptyDescription } from "@/components/ui/empty";
import { FastVibeMascot } from "@/components/fastvibe-mascot";
import { IconButton } from "@/components/icon-button";
import { RunningMark } from "@/components/running-mark";
import { MessageList } from "@/components/chat/message-list";
import { useSessionStore } from "@/stores/session";
import { useSidePaneStore } from "@/stores/side-pane";
import { normalizeViviSettings } from "@shared/vivi";
import { HAS_TRAFFIC_LIGHTS, IS_MAC, isTouchOnly } from "@/lib/platform";
import { engine } from "@/lib/engine-client";
import { cn } from "@/lib/utils";
import { BotQuestions } from "./bot-questions";
import { useBotSnapshot } from "./use-bot-snapshot";
import { useBotComposerState } from "./bot-composer-state";
import type { BotSubmitRequest, BotConversationMeta } from "@shared/bot";
import type { ChatMessage, ConversationSnapshot, Project } from "@shared/types";

const EMPTY_MESSAGES: ChatMessage[] = [];
const Transcript = memo(MessageList);
const STARTERS = [
  { key: "write", icon: FileEditIcon },
  { key: "research", icon: Search01Icon },
  { key: "organize", icon: Task01Icon },
] as const;

export function ViviPage({ projects, sidebarCollapsed, onExpandSidebar, onManageModels }: {
  projects: Project[];
  sidebarCollapsed: boolean;
  onExpandSidebar: () => void;
  onManageModels: () => void;
}): JSX.Element {
  const { t } = useTranslation("app");
  const { snapshot, loading, error, adopt, refresh } = useBotSnapshot();
  const [search, setSearch] = useSearchParams();
  const [router, setRouter] = useState<ConversationSnapshot | null>(null);
  const [activity, setActivity] = useState({ running: false, waiting: false });
  const draft = useBotComposerState((state) => state.draft);
  const project = useBotComposerState((state) => state.project);
  const sending = useBotComposerState((state) => state.sending);
  const actionError = useBotComposerState((state) => state.error);
  const setDraft = useBotComposerState((state) => state.setDraft);
  const setProject = useBotComposerState((state) => state.setProject);
  const setActionError = (value: string | null) => useBotComposerState.setState({ error: value });
  const [stopping, setStopping] = useState(false);
  const sendLock = useRef(false);
  const editor = useRef<HTMLTextAreaElement>(null);
  const hasModels = useSessionStore((state) => state.models.length > 0);
  const paneCollapsed = useSidePaneStore((state) => state.collapsed);
  const openWork = useSidePaneStore((state) => state.openBotTasks);
  const [palette, setPalette] = useState(() => normalizeViviSettings(window.fastvibe.settings.initial).palette);
  const localProjects = useMemo(() => projects.filter((item) => item.kind !== "remote"), [projects]);
  const routerId = snapshot?.routerConversationId;
  const workers = useMemo(() => (snapshot?.conversations ?? []).filter((item) => item.role === "worker"), [snapshot]);
  const targetId = search.get("followup") || search.get("conversation");
  const target = workers.find((item) => item.conversationId === targetId);
  const questions = snapshot?.attention ?? [];
  const targetTitle = target?.title ?? "";
  const messages = router?.messages ?? EMPTY_MESSAGES;
  const empty = !loading && messages.length === 0;
  const working = activity.running;
  const mood = questions.length ? "waiting" : working ? "working" : "idle";
  const status = questions.length ? t("viviBot.waitingCount", { count: questions.length }) : working ? t("viviBot.thinking") : t("viviBot.ready");

  useEffect(() => window.fastvibe.settings.onChanged((settings) => setPalette(normalizeViviSettings(settings).palette)), []);
  useEffect(() => {
    let alive = true;
    if (!routerId) { setRouter(null); return () => { alive = false; }; }
    void engine.getSnapshot(routerId).then((value) => { if (alive) setRouter(value); }).catch(() => { if (alive) setRouter(null); });
    return () => { alive = false; };
  }, [routerId, snapshot?.revision, activity.running]);
  useEffect(() => {
    let alive = true;
    const read = () => void window.fastvibe.bot.getActivity().then((value) => { if (alive) setActivity(value); }).catch(() => undefined);
    read();
    const off = window.fastvibe.bot.onChanged(read);
    return () => { alive = false; off(); };
  }, []);
  useEffect(() => {
    if (project && !localProjects.some((item) => item.cwd === project)) setProject("");
  }, [project, localProjects, setProject]);
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
    if (sendLock.current || sending || !hasModels || !draft.trim()) return;
    const text = draft.trim();
    const chosenProject = target ? undefined : project || undefined;
    const previous = useBotComposerState.getState().request;
    const request: BotSubmitRequest = previous && previous.text === text && previous.conversationId === target?.conversationId && previous.project === chosenProject
      ? previous
      : { requestId: crypto.randomUUID(), text, ...(chosenProject ? { project: chosenProject } : {}), ...(target ? { conversationId: target.conversationId } : {}) };
    useBotComposerState.setState({ request, sending: true, error: null });
    sendLock.current = true;
    try {
      const next = await window.fastvibe.bot.submit(request);
      adopt(next);
      const current = useBotComposerState.getState();
      if (current.request?.requestId === request.requestId) useBotComposerState.setState({ request: null, ...(current.draft.trim() === text ? { draft: "" } : {}) });
      if (!target) setDraft("");
      setSearch((currentParams) => { const nextParams = new URLSearchParams(currentParams); nextParams.delete("followup"); return nextParams; }, { replace: true });
      refresh();
    } catch (cause) { setActionError(cause instanceof Error ? cause.message : String(cause)); }
    finally { sendLock.current = false; useBotComposerState.setState({ sending: false }); }
  };
  const stopAll = async (): Promise<void> => {
    if (stopping) return;
    setStopping(true); setActionError(null);
    try { adopt(await window.fastvibe.bot.stopAll()); } catch (cause) { setActionError(cause instanceof Error ? cause.message : String(cause)); }
    finally { setStopping(false); }
  };

  return <main className="@container/vivi relative flex min-h-0 min-w-0 flex-1 flex-col" data-vivi-workspace>
    <header className={cn("drag-region flex h-11 shrink-0 items-center gap-2 px-4", sidebarCollapsed && HAS_TRAFFIC_LIGHTS && "pl-[calc(5.5rem+8px)]")}>
      {sidebarCollapsed ? <IconButton className="no-drag" variant="ghost" size="icon-sm" label={t("workspace.expandSidebar")} onClick={onExpandSidebar}><HugeiconsIcon strokeWidth={2} icon={PanelLeftOpenIcon} /></IconButton> : null}
      <FastVibeMascot size="size-6" palette={palette} status={mood} motion={false} />
      <h1 className="text-sm font-semibold">Vivi</h1>
      <span className="hidden items-center gap-1.5 text-xs text-muted-foreground @min-[28rem]/vivi:flex"><span aria-hidden className={cn("ml-1 size-1.5 rounded-full", questions.length ? "bg-warning" : working ? "bg-primary" : "bg-success")} />{status}</span>
      <div className="no-drag ml-auto flex shrink-0 items-center gap-1">
        <Button variant="ghost" size="sm" className="gap-1.5 text-muted-foreground" onClick={openWork}><HugeiconsIcon strokeWidth={2} icon={Task01Icon} className="size-4" /><span>{t("viviBot.tasks")}</span>{workers.length ? <Badge variant="secondary" className="h-4.5 min-w-4.5 px-1 text-xs tabular-nums">{workers.length}</Badge> : null}</Button>
        {paneCollapsed ? <IconButton size="icon-sm" variant="ghost" label={t("workspace.expandSidePane")} onClick={() => useSidePaneStore.getState().setCollapsed(false)}><HugeiconsIcon strokeWidth={2} icon={PanelRightOpenIcon} /></IconButton> : null}
      </div>
    </header>
    {error ? <div className="mx-auto flex w-full max-w-3xl items-center gap-3 px-6 py-3"><p role="alert" className="min-w-0 flex-1 wrap-anywhere text-sm text-destructive">{error}</p><Button variant="outline" size="sm" onClick={refresh}>{t("viviBot.retry")}</Button></div> : null}
    <div className="relative min-h-0 flex-1"><Transcript cwd={null} messages={messages} conversationId={routerId ?? "vivi"} streaming={router?.running ?? false} loading={loading} emptyState={<Empty className="h-full gap-6 pb-8"><EmptyHeader className="max-w-md gap-3"><EmptyMedia className="relative mb-1"><span aria-hidden className="absolute inset-0 scale-150 rounded-full bg-primary/5 blur-2xl" /><FastVibeMascot size="size-20" palette={palette} status="idle" /></EmptyMedia><EmptyTitle className="text-2xl font-semibold tracking-tight">{t("viviBot.greeting")}</EmptyTitle><EmptyDescription className="max-w-sm text-sm leading-6">{t("viviBot.description")}</EmptyDescription></EmptyHeader>{hasModels ? <div className="flex max-w-lg flex-wrap justify-center gap-2">{STARTERS.map(({ key, icon }) => <Button key={key} type="button" variant="outline" size="sm" className="h-auto gap-2 rounded-xl bg-card/60 px-3 py-2 font-normal text-muted-foreground shadow-none hover:text-foreground" disabled={sending} onClick={() => { setDraft(t(`viviBot.starters.${key}.prompt`)); editor.current?.focus(); }}><HugeiconsIcon strokeWidth={1.8} icon={icon} className="size-3.5" />{t(`viviBot.starters.${key}.label`)}</Button>)}</div> : <Button variant="outline" size="sm" onClick={onManageModels}>{t("viviBot.addModels")}</Button>}</Empty>} /></div>
    <div className="safe-bottom transcript-gutter shrink-0 px-4 pb-3 sm:px-6"><div className="mx-auto w-full max-w-3xl">
      {questions.length ? <div className="mb-3 max-h-[min(20rem,40dvh)] overflow-y-auto"><BotQuestions questions={questions} limit={1} onAnswer={answer} /></div> : null}
      {working || workers.some((item) => item.paused) ? <div className="mb-2 flex min-w-0 items-center gap-1 px-1"><Button type="button" variant="ghost" size="sm" className="min-w-0 flex-1 justify-start gap-2 text-muted-foreground" onClick={openWork}>{working ? <RunningMark className="size-3.5 text-primary" /> : <HugeiconsIcon strokeWidth={2} icon={Task01Icon} className="size-3.5" />}<span className="truncate">{status}</span><HugeiconsIcon strokeWidth={2} icon={ArrowRight01Icon} className="size-3.5 shrink-0" /></Button><Button type="button" size="xs" variant="ghost" className="shrink-0 text-muted-foreground" disabled={stopping} onClick={() => void stopAll()}>{stopping ? <Spinner /> : null}{t("viviBot.stopAll")}</Button></div> : null}
      {actionError || snapshot?.error ? <p role="alert" className="mb-2 wrap-anywhere text-sm text-destructive">{actionError || snapshot?.error}</p> : null}
      <form className="glass-rim relative rounded-[1.375rem] border border-border bg-card shadow-sm transition-colors focus-within:border-ring" onSubmit={(event) => { event.preventDefault(); void submit(); }}>
        {target ? <div className="flex min-w-0 items-center gap-2 px-3 pt-3 text-xs"><Badge variant="secondary" className="min-w-0 truncate">{targetTitle}</Badge><IconButton type="button" size="icon-xs" variant="ghost" label={t("viviBot.clearTarget")} disabled={sending} onClick={() => setSearch((current) => { const next = new URLSearchParams(current); next.delete("followup"); return next; }, { replace: true })}><HugeiconsIcon strokeWidth={2} icon={Cancel01Icon} /></IconButton></div> : null}
        <Textarea ref={editor} rows={1} value={draft} onChange={(event) => setDraft(event.target.value)} disabled={!hasModels || sending} placeholder={t(!hasModels ? "viviBot.noModel" : target ? "viviBot.supplementPlaceholder" : "viviBot.placeholder")} aria-label={t("viviBot.placeholder")} className="field-sizing-content min-h-16 max-h-48 resize-none border-0 bg-transparent px-4 pt-3.5 pb-2 text-sm leading-6 shadow-none focus-visible:ring-0 disabled:bg-transparent disabled:opacity-100 dark:bg-transparent dark:disabled:bg-transparent" onKeyDown={(event) => { if (event.key !== "Enter" || event.nativeEvent.isComposing) return; const modified = IS_MAC ? event.metaKey : event.ctrlKey; if (modified || (!event.shiftKey && !isTouchOnly())) { event.preventDefault(); void submit(); } }} />
        <div className="flex min-w-0 items-center gap-2 px-2.5 pb-2.5"><HugeiconsIcon strokeWidth={1.8} icon={Folder01Icon} className="ml-1 size-3.5 shrink-0 text-muted-foreground" /><Select value={project || "__vivi_outputs__"} onValueChange={(value) => setProject(value === "__vivi_outputs__" ? "" : value ?? "")} disabled={sending || Boolean(target)}><SelectTrigger size="sm" className="h-7 min-w-0 max-w-56 gap-1.5 border-0 bg-transparent pl-0 text-xs text-muted-foreground shadow-none"><SelectValue>{project ? localProjects.find((item) => item.cwd === project)?.name : t("viviBot.ownWorkspace")}</SelectValue></SelectTrigger><SelectContent side="top"><SelectItem value="__vivi_outputs__">{t("viviBot.ownWorkspace")}</SelectItem>{localProjects.map((item) => <SelectItem key={item.cwd} value={item.cwd}>{item.name}</SelectItem>)}</SelectContent></Select>{!hasModels ? <Button type="button" variant="outline" size="sm" className="ml-auto" onClick={onManageModels}>{t("viviBot.addModels")}</Button> : <IconButton type="submit" size="icon-sm" className="ml-auto shrink-0 rounded-full" disabled={sending || !draft.trim()} label={t("viviBot.send")}>{sending ? <Spinner /> : <HugeiconsIcon strokeWidth={2} icon={ArrowUp02Icon} />}</IconButton>}</div>
      </form><p className={cn("mt-2 text-center text-xs leading-5 text-muted-foreground/70", !empty && "hidden sm:block")}>{t("viviBot.backgroundHint")}</p>
    </div></div>
  </main>;
}
