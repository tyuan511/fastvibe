import type { AssistantMessage } from "@earendil-works/pi-ai";
import type { AgentSession } from "@earendil-works/pi-coding-agent";
import type { BotExecutionOutcome } from "../../shared/bot.ts";

/** Await the SDK's whole prompt promise, including preflight, retries and compaction. */
export async function runBotSession(session: AgentSession, text: string, options: {
  signal: AbortSignal;
  timeoutMs: number;
  abort: () => Promise<unknown>;
  prepare?: () => Promise<void>;
}): Promise<BotExecutionOutcome> {
  let timedOut = false;
  let canceled = options.signal.aborted;
  let aborting: Promise<unknown> | undefined;
  const cancel = (): void => {
    canceled = true;
    aborting ??= options.abort().catch((error) => { console.warn("[bot] abort failed", error); });
  };
  if (canceled) return { status: "interrupted", text: "" };
  options.signal.addEventListener("abort", cancel, { once: true });
  const timer = setTimeout(() => { timedOut = true; cancel(); }, options.timeoutMs);
  try {
    await options.prepare?.();
    if (!session.isIdle) await session.waitForIdle();
    if (canceled) return { status: timedOut ? "failed" : "interrupted", text: "", error: timedOut ? "Vivi execution timed out" : undefined };
    // Identity survives projection/compaction where an array index would not.
    const previous = new Set(session.messages.filter((message) => message.role === "assistant"));
    const prompt = session.agent.prompt;
    // SDK abort during async preflight precedes its agent's AbortController. Guard
    // the actual dispatch inside _startRun's try/finally so cancellation still settles.
    session.agent.prompt = async (...args) => {
      if (canceled) throw new Error("Vivi execution canceled before submission");
      return Reflect.apply(prompt, session.agent, args);
    };
    try { await session.prompt(text, { expandPromptTemplates: false }); }
    finally { session.agent.prompt = prompt; }
    await session.waitForIdle();
    const last = [...session.messages].reverse().find((message): message is AssistantMessage => message.role === "assistant" && !previous.has(message));
    const output = last?.content.filter((part) => part.type === "text").map((part) => part.text).join("\n") ?? "";
    if (timedOut) return { status: "failed", text: output, error: "Vivi execution timed out" };
    if (canceled || last?.stopReason === "aborted") return { status: "interrupted", text: output };
    if (!last || last.stopReason === "error" || last.stopReason === "length") return { status: "failed", text: output, error: last?.errorMessage || "Vivi's model did not finish the request" };
    // terminate:true leaves toolUse as the last assistant. Runtime separately requires
    // the structured report; lack of a prose epilogue is not a failure.
    return { status: "completed", text: output };
  } catch (error) {
    if (timedOut) return { status: "failed", text: "", error: "Vivi execution timed out" };
    if (canceled) return { status: "interrupted", text: "" };
    throw error;
  } finally {
    clearTimeout(timer);
    options.signal.removeEventListener("abort", cancel);
    await aborting;
    await session.waitForIdle();
  }
}
