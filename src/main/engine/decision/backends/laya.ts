import { DEFAULT_LAYA_BASE_URL } from "../../../../shared/decision.ts";
import type { DecideRequest, DecideResponse, Question } from "../protocol.ts";
import { DecisionBackendError, type DecisionBackend } from "../runtime.ts";

/**
 * Laya (`aac6fef/laya-mlx`), run locally via MLX on Apple silicon — a second decision
 * backend alongside Jev, not a Jev reimplementation. There is no shared spec between the
 * two vendors, only an independent convergence on the same three question shapes
 * (choice/score/noul, per docs/decision-layer.md §2); this adapter still has to do the
 * same per-backend normalisation `jev.ts` does, for different reasons — Laya's own
 * `confidence` is a bare float rather than `{value,source}`, and it adds an `action`
 * head (an act/don't-act probability) that has no place in our protocol.
 *
 * Laya-mlx is a Python package (MLX has no Node binding), so unlike Jev this never talks
 * to a hosted API: it talks HTTP to a small local wrapper process
 * (`~/code/laya/server.py`, `POST /predict` with `{state, questions}`, loaded once at
 * start). This adapter does not start that process — only `createLayaBackend`'s caller
 * decides that — and reports "unreachable" like any other network failure when it is not
 * running.
 */
export const LAYA_DEFAULT_BASE_URL = DEFAULT_LAYA_BASE_URL;

/** Laya accepts a question with no `instructions`, but every other backend in this file
 * fills one in rather than leaving it to guess — same reasoning as Jev's defaults. */
const DEFAULT_INSTRUCTIONS: Record<Question["type"], string> = {
  choice: "Pick the option that best fits the state.",
  score: "Rate the state on the given levels.",
  noul: "Is this true of the state?",
};

type Fetch = typeof fetch;

export type LayaBackendOptions = {
  /** Where the local laya-mlx HTTP wrapper listens. */
  baseUrl?: string;
  fetch?: Fetch;
};

/**
 * Structured guidance as plain text, for Laya's small window.
 *
 * laya-mlx turns a non-string `instructions` into `json.dumps(...)`, which escapes every
 * non-ASCII character — a Chinese goal reaches the model as `\u586b\u5199…` — and its
 * question head is capped at 192 tokens with the options served first, so instructions
 * are cut from the end, sometimes to a couple of dozen tokens. Rendering here keeps the
 * text readable and in the order it was given, so what survives the cut is the first
 * field (the goal), not the escaped opening of a JSON object. Criteria get the same
 * treatment, compacted to one line each.
 */
export function layaText(value: unknown, separator = "\n"): string {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) return value.map((item) => layaText(item, separator)).join(separator);
  if (value && typeof value === "object") {
    return Object.entries(value as Record<string, unknown>)
      .filter(([, item]) => item !== undefined && item !== null && item !== "")
      .map(([key, item]) => `${key}: ${typeof item === "string" ? item : JSON.stringify(item)}`)
      .join(separator);
  }
  return value === undefined || value === null ? "" : String(value);
}

/** The body Laya's wrapper receives. Host-only metadata (`requiredWhen`, `binding`) never leaves. */
export function buildLayaBody(request: DecideRequest): Record<string, unknown> {
  const questions: Record<string, unknown> = {};
  for (const [id, question] of Object.entries(request.questions)) {
    const given = question.instructions;
    const instructions = (given === undefined ? "" : layaText(given).trim()) || DEFAULT_INSTRUCTIONS[question.type];
    if (question.type === "choice") {
      const criteria: Record<string, string> = {};
      for (const [key, description] of Object.entries(question.criteria)) criteria[key] = layaText(description, "; ");
      questions[id] = { type: "choice", instructions, criteria };
    } else if (question.type === "score") questions[id] = { type: "score", instructions, criteria: question.criteria };
    else questions[id] = { type: "noul", instructions };
  }
  return { state: request.state, questions };
}

/**
 * Normalise Laya's response into ours without judging it — field names are mapped
 * (`input_tokens` → `inputTokens`, a bare `confidence` float → `{value,source:"reported"}`)
 * but values pass through as-is, exactly like `normalizeJevResponse`: the protocol
 * layer's `checkAnswer` is what validates, not this adapter. Laya's own `action` and
 * `legend` fields are dropped — the first has no protocol counterpart, the second is
 * score's own criteria echoed back and adds nothing `Question.criteria` doesn't have.
 */
export function normalizeLayaResponse(raw: unknown): DecideResponse {
  if (!isRecord(raw) || !isRecord(raw.answers)) {
    throw new DecisionBackendError("malformed", "response has no answers object", { retryable: false });
  }
  const answers: Record<string, unknown> = {};
  for (const [id, value] of Object.entries(raw.answers)) {
    if (!isRecord(value)) {
      answers[id] = value;
      continue;
    }
    const { confidence, action: _action, legend: _legend, ...rest } = value;
    answers[id] = {
      ...rest,
      ...(typeof confidence === "number" ? { confidence: { value: confidence, source: "reported" } } : {}),
      ...(confidence !== undefined && typeof confidence !== "number" ? { confidence } : {}),
    };
  }
  const usage = isRecord(raw.usage)
    ? {
        ...(typeof raw.usage.input_tokens === "number" ? { inputTokens: raw.usage.input_tokens } : {}),
        ...(typeof raw.usage.output_tokens === "number" ? { outputTokens: raw.usage.output_tokens } : {}),
      }
    : undefined;
  return {
    version: 1,
    backend: "laya",
    ...(typeof raw.model === "string" ? { model: raw.model } : {}),
    answers,
    ...(usage ? { usage } : {}),
  };
}

/** HTTP status → error kind. Laya's wrapper documents no error codes of its own (unlike
 * Jev's API), so this only distinguishes the shapes `runtime.ts`'s retry policy cares about. */
export function layaHttpError(status: number, body: string): DecisionBackendError {
  const detail = body.slice(0, 200);
  if (status === 400 || status === 422) return new DecisionBackendError("bad_request", `laya rejected the request (${status}): ${detail}`, { status, retryable: false });
  if (status === 429) return new DecisionBackendError("rate_limit", "laya is rate limiting requests", { status });
  if (status >= 500) return new DecisionBackendError("server", `laya server error (${status})`, { status });
  return new DecisionBackendError("bad_request", `Unexpected laya status ${status}`, { status, retryable: false });
}

export function createLayaBackend(options: LayaBackendOptions = {}): DecisionBackend {
  const baseUrl = (options.baseUrl ?? LAYA_DEFAULT_BASE_URL).replace(/\/+$/, "");
  const doFetch = options.fetch ?? fetch;
  return {
    id: "laya",
    async decide(request, { signal }) {
      const response = await doFetch(`${baseUrl}/predict`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(buildLayaBody(request)),
        signal,
      });
      const text = await response.text();
      if (!response.ok) throw layaHttpError(response.status, text);
      let parsed: unknown;
      try {
        parsed = JSON.parse(text);
      } catch {
        throw new DecisionBackendError("malformed", "laya response is not JSON", { retryable: false });
      }
      return normalizeLayaResponse(parsed);
    },
  };
}

/**
 * The settings page's "测试连接": a plain `GET /health`, never `/predict` — sends no
 * state, matching `testJevConnection`'s own rule. Laya's wrapper does have a health
 * route, so unlike Jev this can check liveness without spending an inference.
 */
export async function testLayaConnection(
  baseUrl: string = LAYA_DEFAULT_BASE_URL,
  options: { fetch?: Fetch; signal?: AbortSignal } = {},
): Promise<{ ok: true; model?: string } | { ok: false; kind: DecisionBackendError["kind"]; message: string }> {
  const doFetch = options.fetch ?? fetch;
  const trimmed = baseUrl.replace(/\/+$/, "");
  try {
    const response = await doFetch(`${trimmed}/health`, { signal: options.signal });
    if (!response.ok) {
      const error = layaHttpError(response.status, await response.text().catch(() => ""));
      return { ok: false, kind: error.kind, message: error.message };
    }
    const body = await response.json().catch(() => undefined);
    const model = isRecord(body) && typeof body.model === "string" ? body.model : undefined;
    return { ok: true, model };
  } catch (error) {
    return { ok: false, kind: "network", message: error instanceof Error ? error.message : String(error) };
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
