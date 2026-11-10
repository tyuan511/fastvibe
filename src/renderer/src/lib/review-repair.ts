import type { AgentThread } from "@shared/agent-thread";
import { ReviewRepairError, submitReviewRepair } from "@shared/review-repair";
import { engine } from "./engine-client";
import { i18n } from "./i18n";

/** The button sends one ordinary prompt; Review itself remains read-only. */
export async function sendReviewRepair(thread: AgentThread): Promise<void> {
  try {
    await submitReviewRepair(thread, {
      format: (data) => i18n.t("sidepane:review.repair.prompt", data),
      state: (conversationId) => engine.getState(conversationId),
      submit: (request) => engine.submitPrompt(request),
    });
  } catch (error) {
    if (error instanceof ReviewRepairError) throw new Error(i18n.t(`sidepane:review.repair.${error.code}`));
    throw error;
  }
}
