import type { DecideRequest, DecideResponse, Question } from "../protocol.ts";
import { DecisionBackendError, type DecisionBackend } from "../runtime.ts";

/**
 * TypeSafe's System One endpoint, serving Jev (docs/decision-layer.md §3.7).
 *
 * The endpoint is fixed here and never configurable in v1: a key that can be pointed at
 * an arbitrary URL is a key that can be exfiltrated. Requests refuse redirects for the
 * same reason — fetch would otherwise carry the Authorization header wherever it is sent.
 */
export const JEV_ENDPOINT = "https://api.typesafe.ai/v1/systemone";
export const JEV_MODELS_ENDPOINT = "https://api.typesafe.ai/v1/models";
export const JEV_DEFAULT_MODEL = "jev-latest";

/** Jev requires `instructions` on every question; this is used when a binding gave none. */
const DEFAULT_INSTRUCTIONS: Record<Question["type"], string> = {
  choice: "Pick the option that best fits the state.",
  score: "Rate the state on the given levels.",
  noul: "Is this true of the state?",
};

type Fetch = typeof fetch;

export type JevBackendOptions = {
  apiKey: string;
  fetch?: Fetch;
};

/** The body Jev receives. Host-only metadata (`requiredWhen`, `binding`) never leaves. */
export function buildJevBody(request: DecideRequest): Record<string, unknown> {
  const questions: Record<string, unknown> = {};
  for (const [id, question] of Object.entries(request.questions)) {
    const given = question.instructions;
    const instructions = typeof given === "string" ? given.trim() || DEFAULT_INSTRUCTIONS[question.type] : given ?? DEFAULT_INSTRUCTIONS[question.type];
    if (question.type === "choice") questions[id] = { type: "choice", instructions, criteria: question.criteria };
    else if (question.type === "score") questions[id] = { type: "score", instructions, criteria: question.criteria };
    else questions[id] = { type: "noul", instructions, ...(question.criteria ? { criteria: question.criteria } : {}) };
  }
  return { model: request.model ?? JEV_DEFAULT_MODEL, state: request.state, questions };
}

/**
 * Normalise Jev's response into ours without judging it.
 *
 * Field names are mapped (`input_tokens` → `inputTokens`, a bare `confidence` number →
 * `{ value, source: "reported" }`) but values are passed through as-is, so the protocol
 * layer's validation sees exactly what the model said. A score's scale is passed
 * through too: whether Jev's weighted `score` is 0- or 1-based is unverified, and the
 * range check should fail loudly rather than this adapter guessing.
 */
export function normalizeJevResponse(raw: unknown): DecideResponse {
  if (!isRecord(raw) || !isRecord(raw.answers)) {
    throw new DecisionBackendError("malformed", "response has no answers object", { retryable: false });
  }
  const answers: Record<string, unknown> = {};
  for (const [id, value] of Object.entries(raw.answers)) {
    if (!isRecord(value)) {
      answers[id] = value;
      continue;
    }
    const { confidence, legend: _legend, ...rest } = value;
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
    backend: "jev",
    ...(typeof raw.model === "string" ? { model: raw.model } : {}),
    answers,
    ...(usage ? { usage } : {}),
  };
}

/** HTTP status → error kind, per TypeSafe's documented codes. */
export function jevHttpError(status: number, body: string): DecisionBackendError {
  const detail = body.slice(0, 200);
  if (status === 401 || status === 403) return new DecisionBackendError("auth", `Jev rejected the API key (${status})`, { status });
  if (status === 422 || status === 400) return new DecisionBackendError("bad_request", `Jev rejected the request (${status}): ${detail}`, { status });
  if (status === 429) return new DecisionBackendError("rate_limit", "Jev rate limit reached", { status });
  if (status === 529) return new DecisionBackendError("overloaded", "Jev is overloaded", { status });
  if (status >= 500) return new DecisionBackendError("server", `Jev server error (${status})`, { status });
  if (status >= 300 && status < 400) return new DecisionBackendError("bad_request", `Jev answered with a redirect (${status})`, { status, retryable: false });
  return new DecisionBackendError("bad_request", `Unexpected Jev status ${status}`, { status, retryable: false });
}

export function createJevBackend(options: JevBackendOptions): DecisionBackend {
  const doFetch = options.fetch ?? fetch;
  return {
    id: "jev",
    async decide(request, { signal }) {
      const response = await doFetch(JEV_ENDPOINT, {
        method: "POST",
        headers: { Authorization: `Bearer ${options.apiKey}`, "Content-Type": "application/json" },
        body: JSON.stringify(buildJevBody(request)),
        redirect: "error",
        signal,
      });
      const text = await response.text();
      if (!response.ok) throw jevHttpError(response.status, text);
      let parsed: unknown;
      try {
        parsed = JSON.parse(text);
      } catch {
        throw new DecisionBackendError("malformed", "Jev response is not JSON", { retryable: false });
      }
      return normalizeJevResponse(parsed);
    },
  };
}

/**
 * The settings page's "test connection": authentication and reachability only.
 *
 * Sends no state. Success means the key is accepted, not that the account has quota or
 * that a browser run will work.
 */
export async function testJevConnection(
  apiKey: string,
  options: { fetch?: Fetch; signal?: AbortSignal } = {},
): Promise<{ ok: true } | { ok: false; kind: DecisionBackendError["kind"]; message: string }> {
  const doFetch = options.fetch ?? fetch;
  try {
    const response = await doFetch(JEV_MODELS_ENDPOINT, {
      headers: { Authorization: `Bearer ${apiKey}` },
      redirect: "error",
      signal: options.signal,
    });
    if (response.ok) return { ok: true };
    const error = jevHttpError(response.status, await response.text().catch(() => ""));
    return { ok: false, kind: error.kind, message: error.message };
  } catch (error) {
    return { ok: false, kind: "network", message: error instanceof Error ? error.message : String(error) };
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
