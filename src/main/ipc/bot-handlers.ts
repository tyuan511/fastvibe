import { Ipc } from "../../shared/ipc.ts";
import type { BotActivity, BotApi, BotCreateWorkRequest, BotReportRequest, BotSubmitRequest } from "../../shared/bot.ts";
import { handle } from "./registry.ts";

type BotIpcPort = Omit<BotApi, "getActivity" | "onChanged" | "onNavigate"> & { activity(): BotActivity };

/** The same business API on desktop and headless hosts; desktop pet controls remain separate. */
export function registerBotIpc(engine: { bot: BotIpcPort }): void {
  handle(Ipc.botGetActivity, () => engine.bot.activity());
  handle(Ipc.botGetWorkSnapshot, () => engine.bot.getWorkSnapshot());
  handle(Ipc.botSubmit, (input: BotSubmitRequest) => engine.bot.submit(input));
  handle(Ipc.botClearChat, () => engine.bot.clearChat());
  handle(Ipc.botCreateWork, (input: BotCreateWorkRequest) => engine.bot.createWork(input));
  handle(Ipc.botReport, (input: BotReportRequest) => engine.bot.report(input));
  handle(Ipc.botAsk, (input: { conversationId: string; requestId?: string; question: string }) => engine.bot.ask(input));
  handle(Ipc.botAnswer, (input: { attentionId: string; answer: string }) => engine.bot.answer(input));
  handle(Ipc.botStopConversation, (input: { conversationId: string; callerConversationId?: string }) => engine.bot.stopConversation(input));
  handle(Ipc.botContinueConversation, (input: { conversationId: string; inputId?: string }) => engine.bot.continueConversation(input));
  handle(Ipc.botStopAll, () => engine.bot.stopAll());
}
