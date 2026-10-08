import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { ExtensionAPI, ExtensionCommandContext, SessionEntry } from "@earendil-works/pi-coding-agent";
import { convertToLlm, serializeConversation } from "@earendil-works/pi-coding-agent";

/**
 * `/handoff <下一步>` — start a new chat from a summary of this one.
 *
 * Compaction rewrites the same transcript and drops detail. A handoff does the
 * opposite: the current model writes a self-contained prompt (decisions, files,
 * the next task). Submitting the review opens a new conversation and sends that
 * prompt. The source chat is left as it was.
 *
 * The pi example this follows draws a terminal loader and refuses every mode
 * but `tui`. FastVibe sessions are `rpc`, so the review step is `ctx.ui.editor`
 * and progress is a status line above the composer.
 */

const T = (zh: string, en: string): string => (process.env.FASTVIBE_UI_LANGUAGE === "en" ? en : zh);

/** Serialized transcript passed to the summarizer. Head plus tail stay when it is longer. */
export const HANDOFF_TRANSCRIPT_CHARS = 80_000;
const HANDOFF_HEAD_CHARS = 16_000;

const SYSTEM_PROMPT = [
  "You write the first prompt of a new chat. You are given a conversation and the user's goal for that new chat.",
  "Output only the prompt itself. No preamble, no commentary, no closing remark.",
  "The prompt must stand alone: the new chat cannot see this conversation.",
  "Include the decisions already made, the files involved, and the next task, which is the user's goal.",
  "Write in the same language as the user's goal.",
  "Use this shape:",
  "## Context",
  "## Files",
  "## Task",
].join("\n");

export interface HandoffSourceEntry {
  type: string;
  id?: string;
  firstKeptEntryId?: string;
}

/**
 * Entries the summary is allowed to see.
 *
 * After a compaction the branch still holds the raw turns the summary replaced.
 * Those are what made `/handoff` replay a conversation the model had already
 * forgotten. Keep the compaction itself, the entries it retained
 * (`firstKeptEntryId` through the entry before it), and everything after it.
 */
export function handoffEntries<T extends HandoffSourceEntry>(branch: readonly T[]): T[] {
  let compactionIndex = -1;
  for (let index = branch.length - 1; index >= 0; index -= 1) {
    if (branch[index]?.type === "compaction") {
      compactionIndex = index;
      break;
    }
  }
  const visible = compactionIndex < 0 ? branch : compactedSlice(branch, compactionIndex);
  return visible.filter((entry) => entry.type === "message" || entry.type === "compaction");
}

function compactedSlice<T extends HandoffSourceEntry>(branch: readonly T[], compactionIndex: number): T[] {
  const compaction = branch[compactionIndex]!;
  const firstKept = compaction.firstKeptEntryId
    ? branch.findIndex((entry) => entry.id === compaction.firstKeptEntryId)
    : -1;
  return [
    compaction,
    ...(firstKept >= 0 ? branch.slice(firstKept, compactionIndex) : []),
    ...branch.slice(compactionIndex + 1),
  ];
}

/**
 * Keep the start (a compaction summary lives there) and the most recent turns.
 * The marker length is fixed so the result stays within `maxChars`.
 */
export function clipHandoffTranscript(text: string, maxChars = HANDOFF_TRANSCRIPT_CHARS): string {
  if (text.length <= maxChars) return text;
  const marker = "\n\n[... 000000000000 characters omitted ...]\n\n";
  const head = Math.min(HANDOFF_HEAD_CHARS, Math.floor(maxChars / 4));
  const tail = Math.max(0, maxChars - head - marker.length);
  const omitted = Math.max(0, text.length - head - tail);
  const note = `\n\n[... ${omitted} characters omitted ...]\n\n`;
  return `${text.slice(0, head)}${note}${tail > 0 ? text.slice(text.length - tail) : ""}`;
}

export function handoffRequest(transcript: string, goal: string): string {
  return `<conversation>\n${transcript}\n</conversation>\n\n<goal>\n${goal}\n</goal>`;
}

function entryToMessage(entry: SessionEntry): AgentMessage | undefined {
  if (entry.type === "message") return entry.message;
  if (entry.type === "compaction") {
    return {
      role: "compactionSummary",
      summary: entry.summary,
      tokensBefore: entry.tokensBefore,
      timestamp: new Date(entry.timestamp).getTime(),
    };
  }
  return undefined;
}

function isCommentary(signature: string | undefined): boolean {
  if (!signature) return false;
  try {
    return (JSON.parse(signature) as { phase?: unknown }).phase === "commentary";
  } catch {
    return false;
  }
}

function answerText(content: readonly { type: string; text?: string; textSignature?: string }[]): string {
  const text = content.filter(
    (block): block is { type: "text"; text: string; textSignature?: string } =>
      block.type === "text" && typeof block.text === "string",
  );
  const final = text.filter((block) => !isCommentary(block.textSignature));
  return (final.length > 0 ? final : text).map((block) => block.text).join("\n").trim();
}

export default function handoff(pi: ExtensionAPI): void {
  let running = false;

  pi.registerCommand("handoff", {
    description: T(
      "把当前对话整理成新会话的提示（/handoff <下一步>）",
      "Start a new chat from a summary of this one (/handoff <next step>)",
    ),
    handler: async (args, ctx) => {
      if (running) {
        ctx.ui.notify(T("交接还在进行", "A handoff is already in progress"), "info");
        return;
      }
      running = true;
      try {
        await runHandoff(args, ctx);
      } finally {
        running = false;
        ctx.ui.setStatus("handoff", undefined);
      }
    },
  });
}

async function runHandoff(args: string, ctx: ExtensionCommandContext): Promise<void> {
  const model = ctx.model;
  if (!model || !ctx.modelRegistry.hasConfiguredAuth(model)) {
    ctx.ui.notify(T("还没有选择模型", "No model selected"), "error");
    return;
  }

  let goal = args.trim();
  if (!goal) {
    const answered = await ctx.ui.input(
      T("交接给新会话", "Hand off to a new chat"),
      T("新会话要做什么？", "What should the new chat do?"),
    );
    goal = answered?.trim() ?? "";
    if (!goal) {
      ctx.ui.notify(T("已取消", "Cancelled"), "info");
      return;
    }
  }

  const messages = handoffEntries(ctx.sessionManager.getBranch())
    .map((entry) => entryToMessage(entry))
    .filter((message): message is AgentMessage => message !== undefined);
  const transcript = clipHandoffTranscript(serializeConversation(convertToLlm(messages)));
  if (!transcript.trim()) {
    ctx.ui.notify(T("没有可以交接的对话", "No conversation to hand off"), "error");
    return;
  }

  ctx.ui.setStatus("handoff", T("正在生成交接摘要…", "Writing the handoff…"));
  const controller = new AbortController();
  const onAbort = (): void => controller.abort();
  ctx.signal?.addEventListener("abort", onAbort, { once: true });
  let prompt = "";
  try {
    const response = await ctx.modelRegistry.complete(
      model,
      {
        systemPrompt: SYSTEM_PROMPT,
        messages: [{ role: "user", content: handoffRequest(transcript, goal), timestamp: Date.now() }],
      },
      { maxTokens: 8192, cacheRetention: "none", timeoutMs: 120_000, signal: controller.signal, sessionId: crypto.randomUUID() },
    );
    if (response.stopReason === "aborted" || controller.signal.aborted) {
      ctx.ui.notify(T("已取消", "Cancelled"), "info");
      return;
    }
    if (response.stopReason === "error") {
      ctx.ui.notify(response.errorMessage || T("交接摘要没有生成", "Could not write the handoff"), "error");
      return;
    }
    prompt = answerText(response.content);
  } catch (error) {
    if (controller.signal.aborted) {
      ctx.ui.notify(T("已取消", "Cancelled"), "info");
      return;
    }
    const message = error instanceof Error ? error.message : String(error);
    ctx.ui.notify(message || T("交接摘要没有生成", "Could not write the handoff"), "error");
    return;
  } finally {
    ctx.signal?.removeEventListener("abort", onAbort);
    ctx.ui.setStatus("handoff", undefined);
  }
  if (!prompt) {
    ctx.ui.notify(T("交接摘要没有生成", "Could not write the handoff"), "error");
    return;
  }

  const edited = await ctx.ui.editor(
    T("交接提示（提交后在新会话发出）", "Handoff prompt (sent in the new chat when you submit)"),
    prompt,
  );
  const next = edited?.trim();
  if (!next) {
    ctx.ui.notify(T("已取消", "Cancelled"), "info");
    return;
  }

  const parentSession = ctx.sessionManager.getSessionFile() ?? undefined;
  ctx.ui.setStatus("handoff", T("正在创建新会话…", "Creating the new chat…"));
  const created = await ctx.newSession({
    ...(parentSession ? { parentSession } : {}),
    withSession: async (replacement) => {
      // The review is the confirmation: submitting it sends the prompt into the new
      // chat, which is already open by the time this runs. Not awaited —
      // `sendUserMessage` resolves when the run is *over*, and the run reports itself
      // through its own events; holding the command open for it would keep the chat
      // being left busy for as long as the answer takes. The replacement context is
      // the new session; the context this command was called with is stale here.
      void replacement.sendUserMessage(next).catch((error: unknown) => {
        replacement.ui.notify(error instanceof Error ? error.message : String(error), "error");
      });
    },
  });
  if (created.cancelled) ctx.ui.notify(T("已取消", "Cancelled"), "info");
}
