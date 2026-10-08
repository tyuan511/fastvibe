import type { SubmitPromptRequest } from "../../shared/prompt-submission.ts";
import type { ConversationQueueState, QueuedPromptPreview } from "../../shared/types.ts";

type Preview = { title: string; preview?: string };
type Host = {
  preview(id: string): Preview | undefined;
  record(id: string, text: string): void;
  restore(id: string, before: Preview, expected: Preview): void;
  behavior(): unknown;
  prompt(input: SubmitPromptRequest): Promise<void>;
  enqueue(input: SubmitPromptRequest, behavior: "steer" | "followUp", preview: QueuedPromptPreview): Promise<ConversationQueueState>;
};

/** No network waits between preview, current host preference and the actual send. */
export async function submitPrompt(host: Host, input: SubmitPromptRequest): Promise<ConversationQueueState | null> {
  if (!input || typeof input.conversationId !== "string" || !input.conversationId ||
      typeof input.text !== "string" || typeof input.enqueue !== "boolean") throw new Error("Invalid prompt submission");
  const current = host.preview(input.conversationId);
  if (!current) throw new Error("conversation not found");
  const before = { ...current };
  host.record(input.conversationId, input.text);
  const expected = { ...host.preview(input.conversationId)! };
  try {
    if (input.enqueue) {
      const behavior = !/^\/compact(?:\s|$)/.test(input.text) && host.behavior() === "steer" ? "steer" : "followUp";
      return await host.enqueue(input, behavior, {
        previousTitle: before.title, previousPreview: before.preview,
        nextTitle: expected.title, nextPreview: expected.preview,
      });
    }
    await host.prompt(input);
    return null;
  } catch (error) {
    // The host knows whether admission failed; a socket loss never enters this path.
    // The catalog only restores if no newer send has replaced this preview.
    host.restore(input.conversationId, before, expected);
    throw error;
  }
}
