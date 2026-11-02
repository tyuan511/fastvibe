import { useCallback, useEffect, useRef, useState, type JSX } from "react";
import { useTranslation } from "react-i18next";
import { HugeiconsIcon } from "@hugeicons/react";
import { BotIcon, Folder01Icon, StopIcon } from "@hugeicons/core-free-icons";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";
import { Composer } from "@/components/chat/composer";
import { MessageList } from "@/components/chat/message-list";
import { useSessionStore } from "@/stores/session";
import { useSettingsStore } from "@/stores/settings";
import { useSidePaneStore, type SidePaneTab } from "@/stores/side-pane";
import { engine, getCommands, onEvent } from "@/lib/engine-client";
import { attachmentPromptSuffix, attachmentsToImages } from "@/lib/attachments";
import { folderName, ConversationRow, ResultStatus } from "./bot-status";
import { useBotSnapshot } from "./use-bot-snapshot";
import type { BotConversationMeta, WorkSnapshot } from "@shared/bot";
import type { ChatAttachment, ChatMessage, ConversationSnapshot, EngineSessionState } from "@shared/types";

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
  const conversations = (snapshot?.conversations ?? []).filter((conversation) => conversation.role === "worker");
  return <div className="min-h-0 flex-1 overflow-y-auto p-3">
    <div className="mb-3 flex items-center gap-2"><HugeiconsIcon strokeWidth={2} icon={BotIcon} className="size-4 text-muted-foreground" /><h2 className="text-sm font-medium">{t("bot.conversations")}</h2></div>
    {error ? <p role="alert" className="wrap-anywhere py-2 text-sm text-destructive">{error}</p> : null}
    {loading && !snapshot ? <div className="flex justify-center py-8"><Spinner /></div> : null}
    {!loading && !conversations.length ? <p className="py-8 text-center text-sm text-muted-foreground">{t("bot.empty")}</p> : null}
    <div className="flex flex-col gap-1">{conversations.map((conversation) => <ConversationRow key={conversation.conversationId} conversation={conversation} onOpen={(item) => open(item.conversationId, titleOf(item))} />)}</div>
  </div>;
}

export function SidePaneBotTask({ tab }: { tab: SidePaneTab }): JSX.Element {
  return tab.botConversationId ? <ConversationPane conversationId={tab.botConversationId} tab={tab} /> : <p className="p-4 text-sm text-muted-foreground">—</p>;
}

function ConversationPane({ conversationId, tab }: { conversationId: string; tab: SidePaneTab }): JSX.Element {
  const { t } = useTranslation("sidepane");
  const { data, loading, error } = useConversationData(conversationId);
  const conversation = useBotSnapshot().snapshot?.conversations.find((item) => item.conversationId === conversationId);
  const models = useSessionStore((state) => state.models);
  const projects = useSessionStore((state) => state.projects);
  const settings = useSettingsStore((state) => state.settings);
  const patchTab = useSidePaneStore((state) => state.patchTab);
  const [draft, setDraft] = useState(tab.draft ?? "");
  const [attachments, setAttachments] = useState<ChatAttachment[]>([]);
  const messages: ChatMessage[] = data?.snapshot.messages ?? [];
  const working = Boolean(data?.snapshot.running);
  const projectName = conversation?.project ? folderName(conversation.project) : "";
  const send = async () => {
    const text = draft.trim();
    if ((!text && !attachments.length) || working) return;
    const sent = `${text}${attachmentPromptSuffix(attachments)}`;
    setDraft(""); setAttachments([]); patchTab(tab.id, { draft: "" });
    try { await window.fastvibe.bot.submit({ requestId: crypto.randomUUID(), conversationId, text: sent, images: attachmentsToImages(attachments) }); }
    catch (cause) { setDraft(text); patchTab(tab.id, { draft: text }); setAttachments(attachments); }
  };
  const stop = () => { void window.fastvibe.bot.stopConversation({ conversationId }); };
  const resume = () => { void window.fastvibe.bot.continueConversation({ conversationId }); };
  if (loading && !data) return <div className="flex flex-1 items-center justify-center"><Spinner /></div>;
  return <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
    <header className="flex shrink-0 items-start gap-2 border-b px-4 py-3"><HugeiconsIcon strokeWidth={2} icon={BotIcon} className="mt-1 size-4 shrink-0 text-muted-foreground" /><div className="min-w-0 flex-1"><h2 className="wrap-anywhere text-sm font-medium">{conversation ? titleOf(conversation) : conversationId}</h2><p className="mt-1 flex items-center gap-1 text-xs text-muted-foreground"><HugeiconsIcon strokeWidth={2} icon={Folder01Icon} className="size-3.5" />{projectName}</p></div>{working ? <Button size="xs" variant="outline" onClick={stop}><HugeiconsIcon strokeWidth={2} icon={StopIcon} />{t("bot.stop")}</Button> : null}</header>
    {error ? <p role="alert" className="wrap-anywhere border-b px-4 py-2 text-sm text-destructive">{error}</p> : null}
    <div className="min-h-0 flex-1"><MessageList messages={messages} conversationId={conversationId} cwd={conversation?.project} streaming={working} loading={loading && !data} emptyState={<p className="p-6 text-center text-sm text-muted-foreground">{t("bot.emptyConversation")}</p>} /></div>
    {conversation?.paused && !working ? <div className="border-t px-4 py-2"><Button size="sm" variant="outline" onClick={resume}>{t("bot.continue")}</Button></div> : null}
    {data?.snapshot && <ResultStatus status={useBotSnapshot().snapshot?.results.find((result) => result.conversationId === conversationId)?.status ?? "idle"} />}
    <div className="shrink-0 px-3 pb-3"><Composer className="px-0 pb-0" value={draft} disabled={false} streaming={working} working={working} conversationId={conversationId} placeholder={t("bot.supplement")} models={models} model={data?.state.model} workspaceLabel={projectName} projects={projects} project={conversation?.project} commands={getCommands(conversationId) as never} queued={data?.snapshot.queue.items ?? []} queuePause={data?.snapshot.queue.pause ?? null} attachments={attachments} history={() => messages.filter((message) => message.role === "user").map((message) => message.text)} contextPercent={data?.state.contextUsage?.percent} contextUsage={data?.state.contextUsage} stats={null} onChange={(value) => { setDraft(value); patchTab(tab.id, { draft: value }); }} onSubmit={() => void send()} onAbort={stop} onPickWorkspace={() => undefined} onSelectProject={() => undefined} onModelChange={(provider, model) => { void engine.setModel(provider, model, conversationId); }} onManageModels={() => undefined} onThinkingChange={(level) => { void engine.setThinking(level, conversationId); }} onAttachmentsChange={setAttachments} onRemoveQueued={() => undefined} onEditQueued={() => undefined} onSendQueuedNow={() => undefined} onRecallQueued={() => undefined} onReorderQueued={() => undefined} onResumeQueue={() => undefined} canResume={Boolean(conversation?.paused)} onResumeRun={resume} sendOnEnter={settings.sendOnEnter} /></div>
  </div>;
}
