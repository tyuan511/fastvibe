import { Ipc } from "../../shared/ipc.ts";
import type { BotCreateWorkRequest, BotReportRequest, BotSubmitRequest } from "../../shared/bot.ts";
import type { PiProcessManager } from "../pi/process-manager";
import { handle } from "./registry";

/** The same business API on desktop and headless hosts; desktop pet controls remain separate. */
export function registerBotIpc(engine: PiProcessManager): void {
  handle(Ipc.botGetActivity, () => engine.bot.activity());
  handle(Ipc.botGetWorkSnapshot, () => engine.bot.getWorkSnapshot());
  handle(Ipc.botSubmit, (input: BotSubmitRequest) => engine.bot.submit(input));
  handle(Ipc.botCreateWork, (input: BotCreateWorkRequest) => engine.bot.createWork(input));
  handle(Ipc.botReport, (input: BotReportRequest) => engine.bot.report(input));
  handle(Ipc.botAsk, (input: { conversationId: string; requestId?: string; question: string }) => engine.bot.ask(input));
  handle(Ipc.botAnswer, (input: { attentionId: string; answer: string }) => engine.bot.answer(input));
  handle(Ipc.botStopConversation, (input: { conversationId: string; callerConversationId?: string }) => engine.bot.stopConversation(input));
  handle(Ipc.botContinueConversation, (input: { conversationId: string }) => engine.bot.continueConversation(input));
  handle(Ipc.botStopAll, () => engine.bot.stopAll());
}
