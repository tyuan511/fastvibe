import type { JSX } from "react";
import { useBotSnapshot } from "./use-bot-snapshot";
import { resolvePath } from "@/lib/workspace-path";
import { PathLink } from "@/components/path-menu";
import { MarkdownView } from "@/components/chat/markdown-view";
import type { ChatMessage } from "@shared/types";

/**
 * Non-conversational Router rows (progress notes, status answers, worker results) are drawn as
 * ordinary things Vivi says. No cards, no status chips, no buttons: the worker's own pane has the
 * execution, evidence and controls.
 */
export function ViviChatRow({ message }: { message: ChatMessage }): JSX.Element {
  const { snapshot } = useBotSnapshot();
  const bot = message.bot;
  if (!bot) return <></>;
  if (bot.kind === "progress") return <p data-slot="vivi-milestone" className="w-full max-w-2xl wrap-anywhere text-sm leading-6 text-muted-foreground">{message.text}</p>;
  const result = bot.kind === "result" ? bot.result : undefined;
  const text = result?.summary ?? message.text;
  const cwd = snapshot?.conversations.find((item) => item.conversationId === bot.conversationId)?.project;
  return <div data-slot={result ? "vivi-result" : "vivi-reply"} className="w-full max-w-2xl">
    {text ? <div className="chat-markdown text-sm leading-6"><MarkdownView text={text} /></div> : null}
    {result?.artifacts?.length ? <div className="mt-1 flex flex-wrap gap-x-3 gap-y-1 text-sm">{result.artifacts.map((path) => <PathLink key={path} path={resolvePath(path, cwd)}>{path}</PathLink>)}</div> : null}
  </div>;
}
