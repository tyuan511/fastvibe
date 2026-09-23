import { uiText } from "../../ui-text.ts";
import { DEFAULT_LAYA_BASE_URL, type DecisionTestResult } from "../../../../shared/decision.ts";
import { sanitizeQuestions, type DecideRequest, type DecideResponse, type DecisionBackend, type DecisionConfidence, type DecisionRuntimeContext, type Answer, type Question } from "../protocol.ts";

/**
 * Adapter for Laya (`aac6fef/laya-mlx`), run locally via MLX on Apple silicon.
 *
 * Laya is not a Jev/TypeSafe reimplementation with a shared spec — there is no such spec,
 * only two vendors that independently converged on the same three question shapes (choice /
 * score / noul). Its wire format still differs in the details docs/decision-layer.md's own
 * protocol cares about: `confidence` is a bare float instead of a `DecisionConfidence`
 * object, and the response envelope uses `model`/snake_case `usage` instead of
 * `backend`/camelCase — exactly the kind of per-backend drift §3.3's "`usage` 先归一化再计量"
 * rule exists for. Every mismatch is normalized here so `dispatch.ts` (not yet built) can
 * treat Laya like any other `DecisionBackend`.
 *
 * Laya-mlx is a Python package (MLX has no Node binding), so this talks HTTP to a small local
 * wrapper process — not to Laya's Python API directly. `~/code/laya/server.py` is that
 * wrapper: `POST /predict` with `{state, questions}`, loaded once at process start. This
 * adapter does not start that process; it only calls it and reports clearly when it is not
 * reachable.
 */
export const LAYA_BACKEND_ID = "laya";
const DEFAULT_BASE_URL = DEFAULT_LAYA_BASE_URL;
const DEFAULT_TIMEOUT_MS = 10_000;

export class LayaBackendError extends Error {}

type FetchLike = (input: string | URL, init?: RequestInit) => Promise<Response>;

export type LayaAdapterOptions = {
  /** Where the local laya-mlx HTTP wrapper listens. */
  baseUrl?: string;
  timeoutMs?: number;
};

/** `DecisionBackend` factory — what a future `dispatch.ts`/backend registry would hold. */
export function createLayaBackend(options: LayaAdapterOptions = {}, fetchImpl: FetchLike = fetch): DecisionBackend {
  return {
    id: LAYA_BACKEND_ID,
    decide: (request, context) => decideWithLaya(request, options, context, fetchImpl),
  };
}

/**
 * The adapter's core call, exported directly so tests can drive it without a backend
 * registry that does not exist yet.
 */
export async function decideWithLaya(
  request: DecideRequest,
  options: LayaAdapterOptions = {},
  context?: DecisionRuntimeContext,
  fetchImpl: FetchLike = fetch,
): Promise<DecideResponse> {
  if (request.version !== 1) {
    throw new LayaBackendError(
      uiText(`不支持的决策协议版本：${request.version}`, `Unsupported decision protocol version: ${request.version}`),
    );
  }

  const baseUrl = (options.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, "");
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const timeoutSignal = AbortSignal.timeout(timeoutMs);
  const signal = context?.signal ? AbortSignal.any([context.signal, timeoutSignal]) : timeoutSignal;

  let response: Response;
  try {
    response = await fetchImpl(`${baseUrl}/predict`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ state: request.state, questions: sanitizeQuestions(request.questions) }),
      signal,
    });
  } catch (cause) {
    throw new LayaBackendError(
      uiText(
        `无法连接本地 laya 服务（${baseUrl}），请确认它已启动（~/code/laya/start.sh bg）`,
        `Could not reach the local laya service (${baseUrl}) — make sure it is running (~/code/laya/start.sh bg)`,
      ),
      { cause },
    );
  }

  if (!response.ok) {
    const body = await response.text().catch(() => "");
    throw new LayaBackendError(
      uiText(`laya 服务返回 ${response.status}：${body.slice(0, 200)}`, `laya service returned ${response.status}: ${body.slice(0, 200)}`),
    );
  }

  const payload = await response.json().catch(() => undefined);
  return normalizeResponse(payload, request.questions);
}

/**
 * The settings pane's "测试连接" — a plain `GET /health`, never `/predict`, matching the
 * design doc's Jev precedent (§5.3: "不假定有 health 端点，也不发送网页或会话内容"). Laya's
 * wrapper does have one, so unlike Jev this can check liveness without sending any state.
 */
export async function testLayaConnection(baseUrl: string = DEFAULT_LAYA_BASE_URL, fetchImpl: FetchLike = fetch): Promise<DecisionTestResult> {
  const trimmed = baseUrl.replace(/\/+$/, "");
  let response: Response;
  try {
    response = await fetchImpl(`${trimmed}/health`, { signal: AbortSignal.timeout(5_000) });
  } catch {
    return { ok: false, error: uiText(`无法连接本地 laya 服务（${trimmed}）`, `Could not reach the local laya service (${trimmed})`) };
  }
  if (!response.ok) {
    return { ok: false, error: uiText(`服务返回 ${response.status}`, `service returned ${response.status}`) };
  }
  const body = await response.json().catch(() => undefined);
  const model = isRecord(body) && typeof body.model === "string" ? body.model : undefined;
  return { ok: true, model };
}

/**
 * Laya answers only the questions it was asked, keyed the same way — but nothing about its
 * HTTP contract guarantees that, so each requested id is read defensively rather than
 * spreading `payload.answers` through.
 */
function normalizeResponse(payload: unknown, questions: Record<string, Question>): DecideResponse {
  if (!isRecord(payload) || !isRecord(payload.answers)) {
    throw new LayaBackendError(uiText("laya 服务返回了无法识别的响应", "laya service returned an unrecognized response"));
  }

  const answers: Record<string, Answer> = {};
  for (const [id, question] of Object.entries(questions)) {
    const raw = payload.answers[id];
    if (!isRecord(raw)) {
      throw new LayaBackendError(uiText(`laya 响应缺少问题 "${id}" 的答案`, `laya response is missing the answer for question "${id}"`));
    }
    answers[id] = normalizeAnswer(id, question, raw);
  }

  return { version: 1, backend: LAYA_BACKEND_ID, answers, usage: normalizeUsage(payload.usage) };
}

function normalizeAnswer(id: string, question: Question, raw: Record<string, unknown>): Answer {
  const confidence = normalizeConfidence(raw.confidence);
  switch (question.type) {
    case "choice": {
      const choice = typeof raw.choice === "string" ? raw.choice : undefined;
      // A choice outside its own criteria is not a valid answer under any protocol — see
      // docs/decision-layer.md §3.3 "choice 必须属于 criteria". Laya cannot invent an option,
      // so this only guards against a schema mismatch (e.g. criteria sent as an array upstream).
      if (choice === undefined || !(choice in question.criteria)) {
        throw new LayaBackendError(uiText(`问题 "${id}" 的答案不在候选范围内`, `The answer for question "${id}" is not among its criteria`));
      }
      return { type: "choice", choice, probabilities: normalizeProbabilities(raw.probabilities), confidence };
    }
    case "score": {
      const score = finite(raw.score);
      if (score === undefined) {
        throw new LayaBackendError(uiText(`问题 "${id}" 缺少 score`, `The answer for question "${id}" is missing a score`));
      }
      return { type: "score", score, probabilities: normalizeProbabilities(raw.probabilities), confidence };
    }
    case "noul": {
      const noul = finite(raw.noul);
      if (noul === undefined || noul < 0 || noul > 1) {
        throw new LayaBackendError(uiText(`问题 "${id}" 的 noul 概率非法`, `The answer for question "${id}" has an invalid noul probability`));
      }
      return { type: "noul", noul, confidence };
    }
  }
}

/**
 * Laya reports a genuinely model-calibrated confidence per answer (unlike a plain chat
 * model echoing a self-described number), so it normalizes to `source: "reported"` — never
 * `"estimated"`, which is reserved for confidence this layer derives itself from a
 * distribution (see docs/decision-layer.md §3.2.1). A missing or out-of-range value is
 * dropped rather than defaulted to 0 or 1.
 */
function normalizeConfidence(value: unknown): DecisionConfidence | undefined {
  const num = finite(value);
  if (num === undefined || num < 0 || num > 1) return undefined;
  return { value: num, source: "reported" };
}

function normalizeProbabilities(value: unknown): Record<string, number> | undefined {
  if (!isRecord(value)) return undefined;
  const out: Record<string, number> = {};
  for (const [key, entry] of Object.entries(value)) {
    const num = finite(entry);
    // A distribution that cannot be fully parsed is not a partial one worth keeping — the
    // consumer's self-consistency check (keys sum to ~1, argmax == choice) needs it whole.
    if (num === undefined) return undefined;
    out[key] = num;
  }
  return out;
}

function normalizeUsage(value: unknown): DecideResponse["usage"] {
  if (!isRecord(value)) return undefined;
  const inputTokens = finite(value.input_tokens);
  const outputTokens = finite(value.output_tokens);
  if (inputTokens === undefined && outputTokens === undefined) return undefined;
  return { inputTokens, outputTokens };
}

function finite(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
