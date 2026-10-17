import { useMemo, type JSX } from "react";
import { useTranslation } from "react-i18next";
import { conversationOutputs } from "@shared/conversation-outputs";
import { useSessionStore } from "@/stores/session";
import { useTranscriptNavigation } from "@/stores/transcript-navigation";
import { displayPath, resolvePath } from "@/lib/workspace-path";
import { FileIcon } from "@/components/file-icon";
import { Button } from "@/components/ui/button";

export function ConversationOutputs({ onOpen }: { onOpen: (path: string) => void }): JSX.Element {
  const { t, i18n } = useTranslation("sidepane");
  const messages = useSessionStore((state) => state.messages);
  const activeId = useSessionStore((state) => state.activeId);
  const cwd = useSessionStore((state) => state.conversations.find((item) => item.id === state.activeId)?.cwd);
  const outputs = useMemo(() => conversationOutputs(messages, (path) => resolvePath(path, cwd)), [messages, cwd]);
  return <div className="space-y-1 p-2">
    <p className="px-1 py-2 text-xs text-muted-foreground">{t(outputs.length ? "outputs.description" : "outputs.empty")}</p>
    {outputs.map((file) => <div key={file.path} className="rounded-md border border-border p-2">
      <button type="button" className="flex w-full min-w-0 items-center gap-2 text-left text-sm hover:text-primary" title={file.path} onClick={() => onOpen(file.path)}><FileIcon name={file.path} className="size-4 shrink-0" /><span className="truncate">{file.title || displayPath(file.path, cwd)}</span></button>
      <p className="mt-1 text-xs text-muted-foreground">{t("outputs.modified", { time: new Date(file.touchedAt).toLocaleString(i18n.language) })}</p>
      <Button size="xs" variant="ghost" className="mt-1" disabled={!activeId} onClick={() => { if (activeId) useTranscriptNavigation.getState().jump(activeId, file.entryId); }}>{t("outputs.jump")}</Button>
    </div>)}
  </div>;
}
