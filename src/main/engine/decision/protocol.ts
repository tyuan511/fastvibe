/**
 * The decision protocol: `state + questions → answers`, independent of any backend.
 *
 * Pure on purpose — no network, no clock, no fs — so every rule that would let a
 * consumer silently act on a bad answer is testable on its own (docs/decision-layer.md
 * §3). A backend adapter normalises its wire format into these types; nothing here
 * trusts that it did so correctly, which is why answers are re-validated below rather
 * than taken at their TypeScript type.
 */

export type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };

export type DecisionState = JsonValue;

type QuestionMeta = {
  instructions?: string;
  /** A speculative head: its answer is only required when this condition holds. */
  requiredWhen?: { question: string; equals: string };
};

export type ChoiceQuestion = { type: "choice"; criteria: Record<string, string> } & QuestionMeta;
export type ScoreQuestion = { type: "score"; criteria: string[]; min?: number; max?: number } & QuestionMeta;
export type NoulQuestion = { type: "noul" } & QuestionMeta;
export type Question = ChoiceQuestion | ScoreQuestion | NoulQuestion;

export type DecisionConfidence =
  | { value: number; source: "reported" }
  | { value: number; source: "estimated"; method: "top-two-margin" | "binary-distance" };

export type ChoiceAnswer = {
  type: "choice";
  choice: string;
  probabilities?: Record<string, number>;
  confidence?: DecisionConfidence;
};
export type ScoreAnswer = {
  type: "score";
  score: number;
  probabilities?: Record<string, number>;
  confidence?: DecisionConfidence;
};
export type NoulAnswer = { type: "noul"; noul: number; confidence?: DecisionConfidence };
export type Answer = ChoiceAnswer | ScoreAnswer | NoulAnswer;

export type DecideRequest = {
  version: 1;
  /** Consumer capability name, e.g. `browser.step`. Routing only, never user data. */
  binding?: string;
  state: DecisionState;
  questions: Record<string, Question>;
  model?: string;
};

export type DecideResponse = {
  version: 1;
  backend: string;
  /** The model the backend reports it actually ran, not the alias that was asked for. */
  model?: string;
  answers: Record<string, unknown>;
  usage?: { inputTokens?: number; outputTokens?: number };
};

export type HandoffReason = "writing" | "open_ended" | "oversized" | "unsure" | "unreachable" | "invalid_response";

export type DecisionOutcome =
  | { status: "decided"; answers: Record<string, Answer>; activeQuestionIds: string[] }
  | {
      status: "handoff";
      reason: HandoffReason;
      detail?: string;
      partialAnswers?: Record<string, Answer>;
      affectedQuestionIds?: string[];
    }
  | { status: "cancelled" }
  | { status: "exhausted"; reason: "budget" | "deadline" };

/** Jev's documented ceilings; other backends may allow more, v1 validates to these. */
export const MAX_CHOICE_OPTIONS = 255;
export const MIN_SCORE_LEVELS = 2;
export const MAX_SCORE_LEVELS = 10;
/** Probabilities may drift from 1 by rounding; beyond this the answer is inconsistent. */
const PROBABILITY_SUM_TOLERANCE = 0.02;

/** A request the *caller* built wrongly. An implementation bug, never a model outcome. */
export class DecisionRequestError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DecisionRequestError";
  }
}

// ---------------------------------------------------------------------------
// Canonical JSON

/**
 * Serialise a JSON value with object keys sorted and array order kept.
 *
 * Used for hashing and cache keys, so two states that differ only in key order hash
 * alike. Anything that is not JSON — `undefined`, a function, a non-finite number, a
 * class instance — is rejected rather than silently dropped the way `JSON.stringify`
 * drops it: a state that lost a field on the way out is a state nobody can replay.
 */
export function canonicalize(value: unknown): string {
  return serialise(value, "$", new Set());
}

function serialise(value: unknown, path: string, seen: Set<object>): string {
  if (value === null) return "null";
  switch (typeof value) {
    case "boolean":
      return value ? "true" : "false";
    case "string":
      return JSON.stringify(value);
    case "number":
      if (!Number.isFinite(value)) throw new DecisionRequestError(`${path} is not a finite number`);
      return JSON.stringify(value);
    case "object":
      break;
    default:
      throw new DecisionRequestError(`${path} is not a JSON value (${typeof value})`);
  }
  const object = value as object;
  if (seen.has(object)) throw new DecisionRequestError(`${path} is a circular reference`);
  seen.add(object);
  try {
    if (Array.isArray(object)) {
      return `[${object.map((item, index) => serialise(item, `${path}[${index}]`, seen)).join(",")}]`;
    }
    const proto = Object.getPrototypeOf(object);
    if (proto !== Object.prototype && proto !== null) {
      throw new DecisionRequestError(`${path} is not a plain object`);
    }
    const record = object as Record<string, unknown>;
    const keys = Object.keys(record).sort();
    return `{${keys.map((key) => `${JSON.stringify(key)}:${serialise(record[key], `${path}.${key}`, seen)}`).join(",")}}`;
  } finally {
    seen.delete(object);
  }
}

// ---------------------------------------------------------------------------
// Questions

/**
 * Check a question set before it is sent. Throws `DecisionRequestError`.
 *
 * `requiredWhen` is deliberately narrow in v1: it may only name an *unconditional*
 * choice question and one of that question's options — no chains, no cycles — so the
 * set of answers a response must contain is decidable from one answer.
 */
export function assertValidQuestions(questions: Record<string, Question>): void {
  const ids = Object.keys(questions);
  if (ids.length === 0) throw new DecisionRequestError("a request needs at least one question");
  for (const id of ids) {
    const question = questions[id];
    if (!id) throw new DecisionRequestError("question id must not be empty");
    switch (question.type) {
      case "choice": {
        const options = Object.keys(question.criteria ?? {});
        if (options.length === 0) throw new DecisionRequestError(`${id}: a choice needs at least one option`);
        if (options.length > MAX_CHOICE_OPTIONS) {
          throw new DecisionRequestError(`${id}: ${options.length} options exceeds ${MAX_CHOICE_OPTIONS}`);
        }
        break;
      }
      case "score": {
        const levels = question.criteria?.length ?? 0;
        if (levels < MIN_SCORE_LEVELS || levels > MAX_SCORE_LEVELS) {
          throw new DecisionRequestError(`${id}: a score needs ${MIN_SCORE_LEVELS}–${MAX_SCORE_LEVELS} levels, got ${levels}`);
        }
        const [min, max] = scoreRange(question);
        if (!Number.isFinite(min) || !Number.isFinite(max) || !(min < max)) {
          throw new DecisionRequestError(`${id}: score range must be finite with min < max`);
        }
        break;
      }
      case "noul":
        break;
      default:
        throw new DecisionRequestError(`${id}: unknown question type`);
    }
    const condition = question.requiredWhen;
    if (!condition) continue;
    const head = questions[condition.question];
    if (!head || condition.question === id) {
      throw new DecisionRequestError(`${id}: requiredWhen names unknown question ${condition.question}`);
    }
    if (head.type !== "choice") throw new DecisionRequestError(`${id}: requiredWhen must name a choice question`);
    if (head.requiredWhen) throw new DecisionRequestError(`${id}: requiredWhen must name an unconditional question`);
    if (!Object.hasOwn(head.criteria, condition.equals)) {
      throw new DecisionRequestError(`${id}: requiredWhen names unknown option ${condition.equals}`);
    }
  }
}

export function scoreRange(question: ScoreQuestion): [number, number] {
  return [question.min ?? 0, question.max ?? question.criteria.length - 1];
}

/** Questions with no condition: their answers are always required. */
export function unconditionalQuestionIds(questions: Record<string, Question>): string[] {
  return Object.keys(questions).filter((id) => !questions[id].requiredWhen);
}

/**
 * Which answers this outcome actually needs, given the adopted unconditional answers.
 *
 * A speculative head whose condition did not hold is not active: its answer may be
 * missing, malformed or unsure without affecting anything, and it must never be acted on.
 */
export function activeQuestionIds(questions: Record<string, Question>, adopted: Record<string, Answer>): string[] {
  return Object.keys(questions).filter((id) => {
    const condition = questions[id].requiredWhen;
    if (!condition) return true;
    const head = adopted[condition.question];
    return head?.type === "choice" && head.choice === condition.equals;
  });
}

// ---------------------------------------------------------------------------
// Answers

/**
 * Validate one answer against its question. Returns the typed answer, or a reason.
 *
 * Never clamps or repairs: a choice outside the criteria is not "the nearest option",
 * and a score outside its range is not the range's edge. Either is a response the
 * consumer must not act on.
 */
export function checkAnswer(question: Question, raw: unknown): { ok: true; answer: Answer } | { ok: false; reason: string } {
  if (!isRecord(raw)) return fail("answer is not an object");
  if (raw.type !== question.type) return fail(`answer type ${String(raw.type)} does not match question type ${question.type}`);
  const confidence = checkConfidence(raw.confidence);
  if (confidence === false) return fail("confidence is malformed");

  if (question.type === "choice") {
    if (typeof raw.choice !== "string" || !Object.hasOwn(question.criteria, raw.choice)) {
      return fail(`choice ${JSON.stringify(raw.choice)} is not one of the criteria`);
    }
    const probabilities = raw.probabilities;
    if (probabilities !== undefined) {
      const problem = checkDistribution(probabilities, Object.keys(question.criteria));
      if (problem) return fail(problem);
      const record = probabilities as Record<string, number>;
      const top = Math.max(...Object.values(record));
      // Ties are allowed; a choice that is not among the most likely is not.
      if (record[raw.choice] < top) return fail("choice is not the most probable option");
    }
    return ok({
      type: "choice",
      choice: raw.choice,
      ...(probabilities !== undefined ? { probabilities: probabilities as Record<string, number> } : {}),
      ...(confidence ? { confidence } : {}),
    });
  }

  if (question.type === "score") {
    const [min, max] = scoreRange(question);
    if (typeof raw.score !== "number" || !Number.isFinite(raw.score)) return fail("score is not a finite number");
    if (raw.score < min || raw.score > max) return fail(`score ${raw.score} is outside ${min}..${max}`);
    const probabilities = raw.probabilities;
    if (probabilities !== undefined) {
      const problem = checkDistribution(probabilities, Object.keys(probabilities as object));
      if (problem) return fail(problem);
    }
    return ok({
      type: "score",
      score: raw.score,
      ...(probabilities !== undefined ? { probabilities: probabilities as Record<string, number> } : {}),
      ...(confidence ? { confidence } : {}),
    });
  }

  if (typeof raw.noul !== "number" || !Number.isFinite(raw.noul) || raw.noul < 0 || raw.noul > 1) {
    return fail("noul is not a number in 0..1");
  }
  return ok({ type: "noul", noul: raw.noul, ...(confidence ? { confidence } : {}) });
}

function ok(answer: Answer): { ok: true; answer: Answer } {
  return { ok: true, answer };
}

function fail(reason: string): { ok: false; reason: string } {
  return { ok: false, reason };
}

/** `undefined` when absent, `false` when present but malformed. */
function checkConfidence(raw: unknown): DecisionConfidence | undefined | false {
  if (raw === undefined) return undefined;
  if (!isRecord(raw) || !isUnit(raw.value)) return false;
  if (raw.source === "reported") return { value: raw.value, source: "reported" };
  if (raw.source === "estimated" && (raw.method === "top-two-margin" || raw.method === "binary-distance")) {
    return { value: raw.value, source: "estimated", method: raw.method };
  }
  return false;
}

function checkDistribution(raw: unknown, expectedKeys: string[]): string | undefined {
  if (!isRecord(raw)) return "probabilities is not an object";
  const keys = Object.keys(raw);
  if (keys.length !== expectedKeys.length || !expectedKeys.every((key) => Object.hasOwn(raw, key))) {
    return "probabilities keys do not match the criteria";
  }
  let sum = 0;
  for (const key of keys) {
    const value = raw[key];
    if (!isUnit(value)) return `probability for ${key} is not a number in 0..1`;
    sum += value;
  }
  if (Math.abs(sum - 1) > PROBABILITY_SUM_TOLERANCE) return `probabilities sum to ${sum.toFixed(3)}, not 1`;
  return undefined;
}

// ---------------------------------------------------------------------------
// Confidence

/**
 * The confidence a policy should look at: reported if the backend gave one, otherwise
 * estimated from the distribution with the method named, otherwise nothing.
 *
 * Missing stays missing — never 0 or 1 — and a score is not estimated: an ordinal
 * scale's spread does not mean what a choice's does.
 */
export function effectiveConfidence(answer: Answer): DecisionConfidence | undefined {
  if (answer.confidence) return answer.confidence;
  if (answer.type === "choice" && answer.probabilities) {
    const sorted = Object.values(answer.probabilities).sort((a, b) => b - a);
    const margin = sorted.length > 1 ? sorted[0] - sorted[1] : sorted[0] ?? 0;
    return { value: clampUnit(margin), source: "estimated", method: "top-two-margin" };
  }
  if (answer.type === "noul") {
    return { value: clampUnit(2 * Math.abs(answer.noul - 0.5)), source: "estimated", method: "binary-distance" };
  }
  return undefined;
}

function clampUnit(value: number): number {
  return Math.min(1, Math.max(0, value));
}

function isUnit(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 1;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
