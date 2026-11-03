import { useRef, useState, type JSX } from "react";
import { useTranslation } from "react-i18next";
import { useBotSnapshot } from "./use-bot-snapshot";
import { AssistantErrorNotice } from "@/components/chat/error-notice";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";
import { resolvePath } from "@/lib/workspace-path";
import { PathLink } from "@/components/path-menu";
import { MarkdownView } from "@/components/chat/markdown-view";
import type { ChatMessage } from "@shared/types";

/** Continue the addressed failed input, with the durable receipt deciding retry eligibility. */
function ViviExecutionError({ message }: { message: ChatMessage }): JSX.Element {
  const { t } = useTranslation("chat");
  const { snapshot, adopt, refresh } = useBotSnapshot();
  const [pending, setPending] = useState(false);
  const [retryError, setRetryError] = useState<string | null>(null);
  const locked = useRef(false);
  const bot = message.bot;
  const failure = snapshot?.executionErrors?.find((item) => item.conversationId === bot?.conversationId && item.inputId === bot?.inputId);
  const retry = async (): Promise<void> => {
    if (!failure || locked.current) return;
    locked.current = true; setPending(true); setRetryError(null);
    try {
      adopt(await window.fastvibe.bot.continueConversation({ conversationId: failure.conversationId, inputId: failure.inputId }));
      refresh();
    } catch (cause) { setRetryError(cause instanceof Error ? cause.message : String(cause)); }
    finally { locked.current = false; setPending(false); }
  };
  return <AssistantErrorNotice error={message.error!} actions={<>
    {failure || pending ? <Button size="sm" variant="outline" disabled={pending} onClick={() => void retry()}>{pending ? <Spinner /> : null}{t("message.retry")}</Button> : null}
    {retryError ? <span role="alert" className="basis-full wrap-anywhere text-sm text-destructive">{retryError}</span> : null}
  </>} />;
}

/** Progress and status rows stay in the conversation, separate from SDK execution details. */
export function ViviChatRow({ message }: { message: ChatMessage }): JSX.Element {
  const { snapshot } = useBotSnapshot();
  const bot = message.bot;
  if (!bot) return <></>;
  if (message.error) return <ViviExecutionError message={message} />;
  if (bot.kind === "progress") return <p data-slot="vivi-milestone" className="w-full max-w-2xl wrap-anywhere text-sm leading-6 text-foreground">{message.text}</p>;
  const result = bot.kind === "result" ? bot.result : undefined;
  const text = result?.summary ?? message.text;
  const cwd = snapshot?.conversations.find((item) => item.conversationId === bot.conversationId)?.project;
  return <div data-slot={result ? "vivi-result" : "vivi-reply"} className="w-full max-w-2xl">
    {text ? <div className="chat-markdown text-sm leading-6"><MarkdownView text={text} /></div> : null}
    {result?.artifacts?.length ? <div className="mt-1 flex flex-wrap gap-x-3 gap-y-1 text-sm">{result.artifacts.map((path) => <PathLink key={path} path={resolvePath(path, cwd)}>{path}</PathLink>)}</div> : null}
  </div>;
}
