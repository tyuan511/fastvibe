import type { AdoptionPolicy } from "./dispatch.ts";
import {
  canonicalize,
  DecisionRequestError,
  effectiveConfidence,
  MAX_CHOICE_OPTIONS,
  MAX_SCORE_LEVELS,
  MIN_SCORE_LEVELS,
  type Answer,
  type DecideRequest,
  type DecisionOutcome,
  type JsonValue,
  type Question,
} from "./protocol.ts";
import { uiText } from "../ui-text.ts";

/**
 * `batch_decide` (docs/decision-layer.md §7.10): the main agent's way to put the same
 * closed question to many items — labels, a rating, yes/no — and get one answer per item.
 *
 * The tool is abstract on purpose (any classification the agent can phrase), so the
 * shape is where its scope is enforced: every answer is one of the options the agent
 * listed, there is no free-text field to smuggle an open question through, and a batch
 * too small to be worth a second model is refused so the agent judges it itself. Each
 * item is its own request with the item as `state`: one item's content never colours
 * another's answer, and one oversized or failed item fails alone.
 *
 * An answer below the agent's confidence floor is not dropped — it comes back as
 * `review` with the best guess, which is what lets the agent spend its own reading on
 * the few items that need it and none on the rest.
 */

export const BATCH_BINDING = "agent.batch";

export const BATCH_LIMITS = {
  /** Below this the agent is faster judging the items itself; the tool refuses. */
  minItems: 5,
  maxItems: 500,
  maxQuestions: 8,
  maxItemChars: 16_000,
  maxContextChars: 8_000,
  maxInstructionChars: 4_000,
} as const;

export const DEFAULT_MIN_CONFIDENCE = 0.7;

export type BatchQuestionInput = {
  type: "choice" | "score" | "yes_no";
  instructions?: string;
  /** choice: option id → what it means. */
  options?: Record<string, string>;
  /** score: level descriptions, lowest first; the score is 0-based over them. */
  levels?: string[];
};

export type BatchInput = {
  instructions: string;
  context?: string;
  questions: Record<string, BatchQuestionInput>;
  items: Array<{ id: string; content: unknown }>;
  min_confidence?: number;
};

export type PreparedBatch = {
  questions: Record<string, Question>;
  kinds: Record<string, BatchQuestionInput["type"]>;
  items: Array<{ id: string; state: JsonValue }>;
  minConfidence: number;
};

export type CompactAnswer =
  | { choice: string; confidence: number | null }
  | { score: number; confidence: number | null }
  | { yes: boolean; p: number; confidence: number | null };

export type ItemResult = {
  id: string;
  status: "decided" | "review" | "failed";
  answers?: Record<string, CompactAnswer>;
  reason?: string;
};

const ID = /^[A-Za-z0-9_.:-]{1,64}$/;

/** Validate what the agent sent. Every refusal says how to fix the call. */
export function prepareBatch(input: BatchInput): { ok: true; batch: PreparedBatch } | { ok: false; error: string } {
  const fail = (zh: string, en: string) => ({ ok: false as const, error: uiText(zh, en) });
  const instructions = typeof input.instructions === "string" ? input.instructions.trim() : "";
  if (!instructions) return fail("instructions 不能为空：写清楚要对每一条判断什么。", "instructions must say what to judge about each item.");
  if (instructions.length > BATCH_LIMITS.maxInstructionChars) {
    return fail(`instructions 超过 ${BATCH_LIMITS.maxInstructionChars} 字符，请精简。`, `instructions exceed ${BATCH_LIMITS.maxInstructionChars} characters.`);
  }
  const context = typeof input.context === "string" ? input.context.trim() : "";
  if (context.length > BATCH_LIMITS.maxContextChars) {
    return fail(`context 超过 ${BATCH_LIMITS.maxContextChars} 字符，请只保留判断需要的背景。`, `context exceeds ${BATCH_LIMITS.maxContextChars} characters.`);
  }

  const items = Array.isArray(input.items) ? input.items : [];
  if (items.length < BATCH_LIMITS.minItems) {
    return fail(
      `只有 ${items.length} 条，不值得交给决策模型：直接自己判断。batch_decide 用于至少 ${BATCH_LIMITS.minItems} 条（通常几十到几百条）同类条目。`,
      `Only ${items.length} items — judge them yourself. batch_decide is for ${BATCH_LIMITS.minItems}+ (usually dozens to hundreds of) similar items.`,
    );
  }
  if (items.length > BATCH_LIMITS.maxItems) {
    return fail(`一次最多 ${BATCH_LIMITS.maxItems} 条，请分批调用。`, `At most ${BATCH_LIMITS.maxItems} items per call; split the batch.`);
  }

  const questionIds = Object.keys(input.questions ?? {});
  if (questionIds.length === 0) return fail("questions 至少要有一个问题。", "questions needs at least one question.");
  if (questionIds.length > BATCH_LIMITS.maxQuestions) {
    return fail(`每条最多 ${BATCH_LIMITS.maxQuestions} 个问题。`, `At most ${BATCH_LIMITS.maxQuestions} questions per item.`);
  }

  const questions: Record<string, Question> = {};
  const kinds: Record<string, BatchQuestionInput["type"]> = {};
  for (const id of questionIds) {
    if (!ID.test(id)) return fail(`问题 id「${id}」只能用字母、数字和 _ . : -。`, `Question id "${id}" may only use letters, digits and _ . : -.`);
    const given = input.questions[id];
    const own = typeof given?.instructions === "string" ? given.instructions.trim() : "";
    const guidance = own ? `${instructions}\n\n${own}` : instructions;
    if (given?.type === "choice") {
      const options = Object.entries(given.options ?? {});
      if (options.length < 2) return fail(`问题「${id}」是 choice，options 至少要两个选项。`, `Question "${id}" is a choice and needs at least two options.`);
      if (options.length > MAX_CHOICE_OPTIONS) return fail(`问题「${id}」的选项超过 ${MAX_CHOICE_OPTIONS} 个。`, `Question "${id}" has more than ${MAX_CHOICE_OPTIONS} options.`);
      for (const [option, meaning] of options) {
        if (!ID.test(option)) return fail(`选项 id「${option}」只能用字母、数字和 _ . : -。`, `Option id "${option}" may only use letters, digits and _ . : -.`);
        if (typeof meaning !== "string" || !meaning.trim()) {
          return fail(`选项「${option}」需要一句说明它是什么意思。`, `Option "${option}" needs a sentence saying what it means.`);
        }
      }
      questions[id] = { type: "choice", instructions: guidance, criteria: Object.fromEntries(options.map(([option, meaning]) => [option, meaning.trim()])) };
    } else if (given?.type === "score") {
      const levels = (given.levels ?? []).filter((level) => typeof level === "string" && level.trim()).map((level) => level.trim());
      if (levels.length < MIN_SCORE_LEVELS || levels.length > MAX_SCORE_LEVELS) {
        return fail(`问题「${id}」是 score，levels 需要 ${MIN_SCORE_LEVELS}–${MAX_SCORE_LEVELS} 级说明（从低到高）。`, `Question "${id}" is a score and needs ${MIN_SCORE_LEVELS}–${MAX_SCORE_LEVELS} level descriptions, lowest first.`);
      }
      questions[id] = { type: "score", instructions: guidance, criteria: levels };
    } else if (given?.type === "yes_no") {
      questions[id] = { type: "noul", instructions: guidance };
    } else {
      return fail(`问题「${id}」的 type 必须是 choice、score 或 yes_no。`, `Question "${id}" must have type choice, score or yes_no.`);
    }
    kinds[id] = given.type;
  }

  const seen = new Set<string>();
  const prepared: PreparedBatch["items"] = [];
  for (const [index, item] of items.entries()) {
    const id = typeof item?.id === "string" ? item.id.trim() : "";
    if (!id) return fail(`第 ${index + 1} 条缺少 id。`, `Item ${index + 1} has no id.`);
    if (seen.has(id)) return fail(`条目 id「${id}」重复。`, `Item id "${id}" is repeated.`);
    seen.add(id);
    let serialised: string;
    try {
      serialised = canonicalize(item.content);
    } catch (error) {
      if (!(error instanceof DecisionRequestError)) throw error;
      return fail(`条目「${id}」的 content 不是 JSON 值：${error.message}`, `Item "${id}" content is not a JSON value: ${error.message}`);
    }
    if (item.content === null || item.content === "" || serialised === "{}" || serialised === "[]") {
      return fail(`条目「${id}」的 content 为空。`, `Item "${id}" has empty content.`);
    }
    const state: { [key: string]: JsonValue } = { item: item.content as JsonValue };
    if (context) state.context = context;
    prepared.push({ id, state: serialised.length > BATCH_LIMITS.maxItemChars ? { oversized: true } : state });
  }

  const floor = input.min_confidence;
  const minConfidence = typeof floor === "number" && Number.isFinite(floor) ? Math.min(1, Math.max(0, floor)) : DEFAULT_MIN_CONFIDENCE;
  return { ok: true, batch: { questions, kinds, items: prepared, minConfidence } };
}

export function itemRequest(batch: PreparedBatch, item: PreparedBatch["items"][number]): DecideRequest {
  return { version: 1, binding: BATCH_BINDING, state: item.state, questions: batch.questions };
}

/** Whether an item was cut before it was ever sent (its content would not fit a request). */
export function isOversized(item: PreparedBatch["items"][number]): boolean {
  const state = item.state as { oversized?: unknown };
  return state !== null && typeof state === "object" && state.oversized === true;
}

/**
 * A choice or yes/no needs its confidence to clear the floor. A score is an expected
 * value over its levels, which Jev may not report a confidence for; with none it is
 * taken as given rather than sent to review every time.
 */
export function batchPolicy(minConfidence: number): AdoptionPolicy {
  return {
    version: `${BATCH_BINDING}/min=${minConfidence}`,
    accept: ({ answer, confidence }) => {
      if (answer.type === "score" && confidence === undefined) return true;
      return confidence !== undefined && confidence.value >= minConfidence;
    },
  };
}

function round(value: number): number {
  return Math.round(value * 100) / 100;
}

function compact(answer: Answer): CompactAnswer {
  const confidence = effectiveConfidence(answer);
  const value = confidence ? round(confidence.value) : null;
  if (answer.type === "choice") return { choice: answer.choice, confidence: value };
  if (answer.type === "score") return { score: round(answer.score), confidence: value };
  return { yes: answer.noul >= 0.5, p: round(answer.noul), confidence: value };
}

function compactAll(answers: Record<string, Answer> | undefined): Record<string, CompactAnswer> | undefined {
  if (!answers || Object.keys(answers).length === 0) return undefined;
  return Object.fromEntries(Object.entries(answers).map(([id, answer]) => [id, compact(answer)]));
}

export function itemResult(id: string, outcome: DecisionOutcome): ItemResult {
  switch (outcome.status) {
    case "decided":
      return { id, status: "decided", answers: compactAll(outcome.answers) };
    case "handoff": {
      if (outcome.reason === "unsure") {
        const answers = compactAll(outcome.partialAnswers);
        return { id, status: "review", ...(answers ? { answers } : {}), reason: `low confidence: ${(outcome.affectedQuestionIds ?? []).join(", ")}` };
      }
      return { id, status: "failed", reason: outcome.detail ? `${outcome.reason}: ${outcome.detail}` : outcome.reason };
    }
    case "cancelled":
      return { id, status: "failed", reason: "cancelled" };
    case "exhausted":
      return { id, status: "failed", reason: `exhausted: ${outcome.reason}` };
  }
}

export type RunBatchOptions = {
  concurrency?: number;
  signal?: AbortSignal;
  onProgress?: (done: number, total: number) => void;
};

/** Decide every item, a few at a time, keeping the agent's order in the results. */
export async function runBatch(
  batch: PreparedBatch,
  decide: (request: DecideRequest) => Promise<DecisionOutcome>,
  options: RunBatchOptions = {},
): Promise<ItemResult[]> {
  const results: ItemResult[] = new Array(batch.items.length);
  const concurrency = Math.max(1, options.concurrency ?? 8);
  let next = 0;
  let done = 0;
  const worker = async (): Promise<void> => {
    for (;;) {
      const index = next++;
      if (index >= batch.items.length) return;
      const item = batch.items[index];
      if (options.signal?.aborted) results[index] = { id: item.id, status: "failed", reason: "cancelled" };
      else if (isOversized(item)) results[index] = { id: item.id, status: "failed", reason: `oversized: content > ${BATCH_LIMITS.maxItemChars} chars` };
      else results[index] = itemResult(item.id, await decide(itemRequest(batch, item)));
      options.onProgress?.(++done, batch.items.length);
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, batch.items.length) }, worker));
  return results;
}

export function summarizeBatch(results: ItemResult[]): { total: number; decided: number; review: number; failed: number } {
  const count = (status: ItemResult["status"]) => results.filter((result) => result.status === status).length;
  return { total: results.length, decided: count("decided"), review: count("review"), failed: count("failed") };
}
