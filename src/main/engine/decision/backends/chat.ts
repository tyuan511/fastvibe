import type { DecideRequest, DecideResponse, JsonValue, Question } from "../protocol.ts";
import { DecisionBackendError, type DecisionBackend } from "../runtime.ts";

/**
 * A large model as a decision backend: it answers the same typed questions Jev and Laya
 * answer, through the same protocol, so a consumer such as the browser loop can swap
 * backends without changing (docs/decision-layer.md §3, §4 `backends/chat.ts`).
 *
 * The model call is injected — this file knows nothing about providers, keys or APIs —
 * and must return the model's text. The model is asked for a JSON object of chosen option
 * keys only: a chat model's self-reported probabilities are not calibrated, so none are
 * requested and the answers carry no confidence. Validation stays in the protocol layer;
 * an invented option or a missing required head is `invalid_response` there, not here.
 */

export type ChatCompletion = { text: string; model?: string; usage?: { inputTokens?: number; outputTokens?: number } };

export type ChatComplete = (input: { system: string; user: string; signal: AbortSignal }) => Promise<ChatCompletion>;

export type ChatBackendOptions = {
  /** Trace id, e.g. `llm:packy/deepseek-flash`. */
  id?: string;
  complete: ChatComplete;
};

export const CHAT_DECISION_SYSTEM = `You answer typed decision questions about a state.
For each question you must answer, reply with one of its option keys, exactly as written.
Always answer every question that has no "onlyIf". Answer a question with "onlyIf" only when that condition holds for your own answers.
A score question takes a number within its range; a noul question takes a probability between 0 and 1 that its statement is true.
Reply with a single JSON object mapping question id to your answer. No commentary.`;

/** The prompt body: the state, and each question with its options and condition. */
export function buildChatPrompt(request: DecideRequest): string {
  const questions: Record<string, JsonValue> = {};
  for (const [id, question] of Object.entries(request.questions)) {
    questions[id] = describe(question);
  }
  return JSON.stringify({ state: request.state, questions });
}

function describe(question: Question): JsonValue {
  const base: Record<string, JsonValue> = { type: question.type };
  if (question.instructions !== undefined) base.instructions = question.instructions;
  if (question.requiredWhen) base.onlyIf = `${question.requiredWhen.question} == ${question.requiredWhen.equals}`;
  if (question.type === "choice") base.options = question.criteria;
  if (question.type === "score") {
    base.levels = question.criteria;
    base.range = [question.min ?? 0, question.max ?? question.criteria.length - 1];
  }
  return base;
}

/**
 * Turn the model's reply into protocol answers, typed by each question. Anything that is
 * not a JSON object is malformed; values are passed through for the protocol to judge.
 */
export function parseChatAnswers(text: string, questions: Record<string, Question>): Record<string, unknown> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text.trim().replace(/^```(?:json)?\s*|\s*```$/g, ""));
  } catch {
    throw new DecisionBackendError("malformed", "model reply is not JSON", { retryable: false });
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new DecisionBackendError("malformed", "model reply is not a JSON object", { retryable: false });
  }
  const answers: Record<string, unknown> = {};
  for (const [id, value] of Object.entries(parsed as Record<string, unknown>)) {
    const question = questions[id];
    if (!question) {
      answers[id] = value;
      continue;
    }
    if (question.type === "choice") answers[id] = { type: "choice", choice: value };
    else if (question.type === "score") answers[id] = { type: "score", score: value };
    else answers[id] = { type: "noul", noul: value };
  }
  return answers;
}

export function createChatBackend(options: ChatBackendOptions): DecisionBackend {
  return {
    id: options.id ?? "llm",
    async decide(request, { signal }): Promise<DecideResponse> {
      const completion = await options.complete({ system: CHAT_DECISION_SYSTEM, user: buildChatPrompt(request), signal });
      return {
        version: 1,
        backend: options.id ?? "llm",
        ...(completion.model ? { model: completion.model } : {}),
        answers: parseChatAnswers(completion.text, request.questions),
        ...(completion.usage ? { usage: completion.usage } : {}),
      };
    },
  };
}
