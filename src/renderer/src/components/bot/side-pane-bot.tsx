import { useCallback, useEffect, useRef, useState, type JSX } from "react";
import { useTranslation } from "react-i18next";
import { HugeiconsIcon } from "@hugeicons/react";
import { Folder01Icon } from "@hugeicons/core-free-icons";
import { Badge } from "@/components/ui/badge";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";
import { Composer } from "@/components/chat/composer";
import { MessageList } from "@/components/chat/message-list";
import { useSessionStore } from "@/stores/session";
import { useSettingsStore } from "@/stores/settings";
import { useSidePaneStore, type SidePaneTab } from "@/stores/side-pane";
import { engine, getCommands, onEvent } from "@/lib/engine-client";
import { attachmentPromptSuffix, attachmentsToImages } from "@/lib/attachments";
import { BotConversationAvatar } from "./bot-conversation-avatar";
import { botConversationCards } from "@/lib/bot-conversation-card";
import { viviConversationMessages } from "@/lib/vivi-chat";
import { folderName, ConversationCard } from "./bot-status";
import { useBotSnapshot } from "./use-bot-snapshot";
import type { BotConversationMeta } from "@shared/bot";
import type { ChatAttachment, ConversationSnapshot, EngineSessionState } from "@shared/types";

function useConversationData(conversationId: string) {
  const [data, setData] = useState<{ snapshot: ConversationSnapshot; state: EngineSessionState } | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const serial = useRef(0);
  const read = useCallback(async () => {
    const token = ++serial.current;
    try {
      const [snapshot, state] = await Promise.all([engine.getSnapshot(conversationId), engine.getState(conversationId)]);
      if (token === serial.current) { setData({ snapshot, state }); setError(null); setLoading(false); }
    } catch (cause) { if (token === serial.current) { setError(cause instanceof Error ? cause.message : String(cause)); setLoading(false); } }
  }, [conversationId]);
  useEffect(() => {
    setLoading(true); void read();
    const off = onEvent((event) => { if (event.conversationId === conversationId) void read(); });
    return off;
  }, [conversationId, read]);
  return { data, loading, error };
}

function titleOf(conversation: BotConversationMeta): string { return conversation.title || conversation.conversationId; }

export function SidePaneBotTasks(): JSX.Element {
  const { t } = useTranslation("sidepane");
  const { snapshot, loading, error } = useBotSnapshot();
  const open = useSidePaneStore((state) => state.openBotConversation);
  const [, refreshClock] = useState(0);
  useEffect(() => {
    const timer = window.setInterval(() => refreshClock((value) => value + 1), 60_000);
    return () => window.clearInterval(timer);
  }, []);
  const conversations = snapshot ? botConversationCards(snapshot) : [];
  return <div className="min-h-0 flex-1 overflow-y-auto p-3">
    {error && !snapshot ? <p role="alert" className="wrap-anywhere py-2 text-sm text-destructive">{error}</p> : null}
    {loading && !snapshot ? <div className="flex justify-center py-8"><Spinner /></div> : null}
    {!loading && !conversations.length ? <p className="py-8 text-center text-sm text-muted-foreground">{t("bot.empty")}</p> : null}
    <div className="flex flex-col gap-3">{conversations.map((item) => <ConversationCard key={item.conversation.conversationId} item={item} onOpen={(conversation) => open(conversation.conversationId, titleOf(conversation))} />)}</div>
  </div>;
}

export function SidePaneBotTask({ tab }: { tab: SidePaneTab }): JSX.Element {
  return tab.botConversationId ? <ConversationPane conversationId={tab.botConversationId} tab={tab} /> : <p className="p-4 text-sm text-muted-foreground">—</p>;
}

function ConversationPane({ conversationId, tab }: { conversationId: string; tab: SidePaneTab }): JSX.Element {
  const { t } = useTranslation("sidepane");
  const { data, loading, error } = useConversationData(conversationId);
  const { snapshot: workSnapshot } = useBotSnapshot();
  const conversation = workSnapshot?.conversations.find((item) => item.conversationId === conversationId);
  const models = useSessionStore((state) => state.models);
  const projects = useSessionStore((state) => state.projects);
  const settings = useSettingsStore((state) => state.settings);
  const patchTab = useSidePaneStore((state) => state.patchTab);
  const [draft, setDraft] = useState(tab.draft ?? "");
  const [attachments, setAttachments] = useState<ChatAttachment[]>([]);
  const [sending, setSending] = useState(false);
  const [sendError, setSendError] = useState<string | null>(null);
  const sendLock = useRef(false);
  const working = Boolean(data?.snapshot.running);
  const failure = working ? undefined : workSnapshot?.executionErrors?.find((item) => item.conversationId === conversationId);
  const messages = viviConversationMessages(data?.snapshot.messages ?? [], failure);
  const avatarStatus = workSnapshot ? botConversationCards(workSnapshot).find((item) => item.conversation.conversationId === conversationId)?.status : undefined;
  const projectName = conversation?.project ? projects.find((project) => project.cwd === conversation.project)?.name || folderName(conversation.project) : "";
  const send = async () => {
    const text = draft.trim();
    if ((!text && !attachments.length) || sendLock.current) return;
    sendLock.current = true; setSending(true); setSendError(null);
    const sent = `${text}${attachmentPromptSuffix(attachments)}`;
    setDraft(""); setAttachments([]); patchTab(tab.id, { draft: "" });
    try { await window.fastvibe.bot.submit({ requestId: crypto.randomUUID(), conversationId, text: sent, images: attachmentsToImages(attachments) }); }
    catch (cause) { setDraft(text); patchTab(tab.id, { draft: text }); setAttachments(attachments); setSendError(cause instanceof Error ? cause.message : String(cause)); }
    finally { sendLock.current = false; setSending(false); }
  };
  const stop = () => { void window.fastvibe.bot.stopConversation({ conversationId }).catch((cause) => setSendError(cause instanceof Error ? cause.message : String(cause))); };
  const resume = () => { void window.fastvibe.bot.continueConversation({ conversationId }).catch((cause) => setSendError(cause instanceof Error ? cause.message : String(cause))); };
  if (loading && !data) return <div className="flex flex-1 items-center justify-center"><Spinner /></div>;
  return <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
    <header className="flex h-11 shrink-0 items-center gap-3 border-b border-border/50 px-4">
      <BotConversationAvatar status={avatarStatus ?? (working ? "working" : "idle")} size="size-7" />
      <h2 className="min-w-0 flex-1 truncate text-sm font-medium" title={conversation ? titleOf(conversation) : tab.title}>{conversation ? titleOf(conversation) : tab.title}</h2>
      {conversation?.project ? <Tooltip>
        <TooltipTrigger render={<Badge variant="outline" className="h-6 max-w-1/3 gap-1.5 rounded-md font-normal text-muted-foreground" />}>
          <HugeiconsIcon strokeWidth={2} icon={Folder01Icon} className="shrink-0" />
          <span className="min-w-0 truncate">{projectName}</span>
        </TooltipTrigger>
        <TooltipContent side="bottom" align="end" className="wrap-anywhere">{conversation.project}</TooltipContent>
      </Tooltip> : null}
    </header>
    {error ? <p role="alert" className="wrap-anywhere border-b px-4 py-2 text-sm text-destructive">{error}</p> : null}
    <div className="min-h-0 flex-1"><MessageList messages={messages} conversationId={conversationId} cwd={conversation?.project} streaming={working} loading={loading && !data} emptyState={<p className="p-6 text-center text-sm text-muted-foreground">{t("bot.emptyConversation")}</p>} /></div>
    {conversation?.paused && !working ? <div className="border-t px-4 py-2"><Button size="sm" variant="outline" onClick={resume}>{t("bot.continue")}</Button></div> : null}
    {sending ? <p role="status" className="px-4 py-2 text-sm text-muted-foreground">{t("app:viviBot.sending")}</p> : null}
    {sendError ? <p role="alert" className="px-4 py-2 text-sm text-destructive wrap-anywhere">{sendError}</p> : null}
    <div className="shrink-0 px-3 pb-3"><Composer className="px-0 pb-0" value={draft} disabled={sending} streaming={working} working={working} conversationId={conversationId} placeholder={t("bot.supplement")} models={models} model={data?.state.model} workspaceLabel={projectName} projects={projects} project={conversation?.project} hideModelPicker commands={getCommands(conversationId) as never} queued={data?.snapshot.queue.items ?? []} queuePause={data?.snapshot.queue.pause ?? null} attachments={attachments} history={() => messages.filter((message) => message.role === "user").map((message) => message.text)} contextPercent={data?.state.contextUsage?.percent} contextUsage={data?.state.contextUsage} stats={null} onChange={(value) => { setDraft(value); patchTab(tab.id, { draft: value }); }} onSubmit={() => void send()} onAbort={stop} onPickWorkspace={() => undefined} onSelectProject={() => undefined} onModelChange={(provider, model) => { void engine.setModel(provider, model, conversationId); }} onManageModels={() => undefined} onThinkingChange={(level) => { void engine.setThinking(level, conversationId); }} onAttachmentsChange={setAttachments} onRemoveQueued={() => undefined} onEditQueued={() => undefined} onSendQueuedNow={() => undefined} onRecallQueued={() => undefined} onReorderQueued={() => undefined} onResumeQueue={() => undefined} canResume={Boolean(conversation?.paused)} onResumeRun={resume} sendOnEnter={settings.sendOnEnter} /></div>
  </div>;
}
