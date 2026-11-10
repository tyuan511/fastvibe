import type { AgentThread } from "./agent-thread.ts";
import type { SubmitPromptRequest } from "./prompt-submission.ts";
import type { EngineSessionState } from "./types.ts";
import { decodeScopedId } from "./server-scope.ts";

export class ReviewRepairError extends Error {
  readonly code: "repairUnavailable" | "stateMismatch";
  constructor(code: "repairUnavailable" | "stateMismatch") { super(code); this.code = code; this.name = "ReviewRepairError"; }
}

export type ReviewRepairData = {
  reviewId: string;
  repository: string;
  base: string;
  target: string;
  digest: string;
  issues: string;
  coverage: string;
};

/** Full structured findings, not the shortened titles/descriptions shown in chat. */
export function reviewRepairData(thread: AgentThread): ReviewRepairData {
  const context = thread.review;
  const report = thread.reviewReport;
  if (!thread.conversationId || thread.status !== "completed" || !context || !report?.findings.length) {
    throw new ReviewRepairError("repairUnavailable");
  }
  return {
    reviewId: context.id,
    // The receiving model runs on the report's host; routing prefixes are UI ids.
    repository: decodeScopedId(context.root)?.localId ?? context.root,
    base: context.base,
    target: context.target,
    digest: context.digest,
    issues: JSON.stringify(report.findings, null, 2),
    coverage: JSON.stringify(report.coverage, null, 2),
  };
}

type RepairHost = {
  format: (data: ReviewRepairData) => string;
  state: (conversationId: string) => Promise<EngineSessionState>;
  submit: (request: SubmitPromptRequest) => Promise<unknown>;
};

/** Reuse normal prompt admission/queue handling and keep the original chat draft. */
export async function submitReviewRepair(thread: AgentThread, host: RepairHost): Promise<void> {
  const conversationId = thread.conversationId;
  const text = host.format(reviewRepairData(thread));
  const state = await host.state(conversationId);
  if (state.conversationId !== conversationId) throw new ReviewRepairError("stateMismatch");
  await host.submit({ conversationId, text, enqueue: state.running === true || state.isStreaming || state.isCompacting === true });
}
