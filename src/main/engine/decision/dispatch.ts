import {
  activeQuestionIds,
  canonicalize,
  checkAnswer,
  effectiveConfidence,
  unconditionalQuestionIds,
  type Answer,
  type DecideRequest,
  type DecisionConfidence,
  type DecisionOutcome,
  type Question,
} from "./protocol.ts";

/**
 * Screening before a request and adoption after it (docs/decision-layer.md §3.5–3.6).
 *
 * Neither step does business: screening only says "this is not worth a request", and
 * adoption only says whether the answers the outcome needs are valid and trustworthy
 * enough. Who takes over after a handoff is the consumer's call.
 */

// ---------------------------------------------------------------------------
// Screening

export type SizeLimits = {
  /** Whole request: state + every question. */
  maxRequestTokens: number;
  /** State plus the single longest question. */
  maxStateTokens: number;
};

/** Jev's documented ceilings (64k per request, 32k for state + longest question). */
export const JEV_SIZE_LIMITS: SizeLimits = { maxRequestTokens: 64_000, maxStateTokens: 32_000 };

/**
 * How tokens are estimated, recorded next to the estimate.
 *
 * Deliberately an over-estimate: English runs about four UTF-8 bytes per token and CJK
 * three bytes per character at roughly one token each, so half the byte count bounds
 * both from above. Refusing a request that would have fit costs one handoff; sending
 * one that does not fit costs a failed request and the same handoff later.
 */
export const TOKEN_ESTIMATE_METHOD = "utf8-bytes/2";

export function estimateTokens(text: string): number {
  return Math.ceil(Buffer.byteLength(text, "utf8") / 2);
}

export type RequestSize = {
  stateTokens: number;
  longestQuestionTokens: number;
  requestTokens: number;
  method: typeof TOKEN_ESTIMATE_METHOD;
};

export function measureRequest(request: DecideRequest): RequestSize {
  const stateTokens = estimateTokens(canonicalize(request.state));
  const questionTokens = Object.entries(request.questions).map(([id, question]) =>
    estimateTokens(id + canonicalize(question as unknown)),
  );
  return {
    stateTokens,
    longestQuestionTokens: Math.max(0, ...questionTokens),
    requestTokens: stateTokens + questionTokens.reduce((sum, tokens) => sum + tokens, 0),
    method: TOKEN_ESTIMATE_METHOD,
  };
}

/**
 * `null` when the request is worth sending; otherwise the handoff to return without one.
 *
 * Only the generic checks live here. Whether a step is `writing` or `open_ended` depends
 * on the consumer's own candidates, so it screens those before building a request.
 */
export function screenRequest(request: DecideRequest, limits: SizeLimits): Extract<DecisionOutcome, { status: "handoff" }> | null {
  const size = measureRequest(request);
  if (size.requestTokens > limits.maxRequestTokens) {
    return { status: "handoff", reason: "oversized", detail: `request ~${size.requestTokens} tokens > ${limits.maxRequestTokens}` };
  }
  if (size.stateTokens + size.longestQuestionTokens > limits.maxStateTokens) {
    return {
      status: "handoff",
      reason: "oversized",
      detail: `state + longest question ~${size.stateTokens + size.longestQuestionTokens} tokens > ${limits.maxStateTokens}`,
    };
  }
  return null;
}

// ---------------------------------------------------------------------------
// Adoption

/**
 * Whether a valid answer is trustworthy enough to act on.
 *
 * Versioned because the threshold is an evaluation result, not a constant of nature:
 * the trace records which policy adopted an answer so a later change can be compared.
 */
export type AdoptionPolicy = {
  version: string;
  accept(input: { questionId: string; question: Question; answer: Answer; confidence: DecisionConfidence | undefined }): boolean;
};

/**
 * The simplest policy: act when confidence is present and at least `min`.
 *
 * An answer with no confidence at all is not adopted — "the model did not say how sure
 * it was" is not "the model was sure".
 */
export function thresholdPolicy(version: string, min: number): AdoptionPolicy {
  return {
    version,
    accept: ({ confidence }) => confidence !== undefined && confidence.value >= min,
  };
}

/**
 * Act on any answer that passed validation — the model's most probable legal option.
 *
 * jev-ultrafast runs this way: no confidence gate and no second-model review, with
 * execution-time freshness guards and a no-progress stop as the safety net. Confidence is
 * still validated and traced, so a gate can be reintroduced from evaluation data.
 */
export function acceptValid(version: string): AdoptionPolicy {
  return { version, accept: () => true };
}

export type AdoptionResult = {
  outcome: DecisionOutcome;
  /** Every answer that passed validation, active or not — for the trace, never for acting. */
  validAnswers: Record<string, Answer>;
};

/**
 * Turn a backend's answers into an outcome, in the order §3.6 requires:
 *
 * 1. the unconditional answers must be present, valid and accepted — if any is unsure,
 *    no conditional head is even looked at;
 * 2. those answers decide which conditional heads are active;
 * 3. only active heads are validated and judged. An inactive head that came back
 *    malformed or unsure changes nothing.
 */
export function adoptAnswers(
  questions: Record<string, Question>,
  rawAnswers: Record<string, unknown>,
  policy: AdoptionPolicy,
): AdoptionResult {
  const validAnswers: Record<string, Answer> = {};
  const unknown = Object.keys(rawAnswers).filter((id) => !Object.hasOwn(questions, id));
  if (unknown.length > 0) {
    return {
      outcome: { status: "handoff", reason: "invalid_response", detail: `unknown answer ids: ${unknown.join(", ")}`, affectedQuestionIds: unknown },
      validAnswers,
    };
  }

  const judge = (ids: string[]): Extract<DecisionOutcome, { status: "handoff" }> | null => {
    const invalid: string[] = [];
    const details: string[] = [];
    for (const id of ids) {
      if (!Object.hasOwn(rawAnswers, id)) {
        invalid.push(id);
        details.push(`${id}: missing`);
        continue;
      }
      const checked = checkAnswer(questions[id], rawAnswers[id]);
      if (!checked.ok) {
        invalid.push(id);
        details.push(`${id}: ${checked.reason}`);
        continue;
      }
      validAnswers[id] = checked.answer;
    }
    if (invalid.length > 0) {
      return { status: "handoff", reason: "invalid_response", detail: details.join("; "), affectedQuestionIds: invalid, ...partial(validAnswers) };
    }
    const unsure = ids.filter(
      (id) =>
        !policy.accept({
          questionId: id,
          question: questions[id],
          answer: validAnswers[id],
          confidence: effectiveConfidence(validAnswers[id]),
        }),
    );
    if (unsure.length > 0) {
      return { status: "handoff", reason: "unsure", affectedQuestionIds: unsure, ...partial(validAnswers) };
    }
    return null;
  };

  const heads = unconditionalQuestionIds(questions);
  const headProblem = judge(heads);
  if (headProblem) return { outcome: headProblem, validAnswers };

  const active = activeQuestionIds(questions, validAnswers);
  const conditional = active.filter((id) => !heads.includes(id));
  const conditionalProblem = judge(conditional);
  if (conditionalProblem) return { outcome: conditionalProblem, validAnswers };

  // Record inactive heads that happen to be valid, for the trace only.
  for (const id of Object.keys(questions)) {
    if (active.includes(id) || !Object.hasOwn(rawAnswers, id)) continue;
    const checked = checkAnswer(questions[id], rawAnswers[id]);
    if (checked.ok) validAnswers[id] = checked.answer;
  }

  const answers: Record<string, Answer> = {};
  for (const id of active) answers[id] = validAnswers[id];
  return { outcome: { status: "decided", answers, activeQuestionIds: active }, validAnswers };
}

function partial(answers: Record<string, Answer>): { partialAnswers?: Record<string, Answer> } {
  return Object.keys(answers).length > 0 ? { partialAnswers: { ...answers } } : {};
}
