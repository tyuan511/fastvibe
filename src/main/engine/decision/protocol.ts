/**
 * The decision layer's own protocol: `state + questions → answers`.
 *
 * Modelled on the shape TypeSafe's Jev (System One) popularised — state is data, not a
 * conversation; questions are enumerated by the caller, never invented by the model; one
 * request can fan out several questions; answers carry probabilities and confidence — but
 * this is FastVibe's own type, not Jev's wire format. See `docs/decision-layer.md` §3 for
 * the full rationale: a backend's raw response is never trusted as-is, and every adapter
 * (`decision/backends/*.ts`) normalizes into these types instead of passing a vendor
 * response through.
 */

export type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };

export type DecisionState = JsonValue;

type QuestionMeta = {
  instructions?: string;
  /** This question is a speculative head; its answer is only required when the condition holds. */
  requiredWhen?: { question: string; equals: string };
};

export type Question =
  | ({ type: "choice"; criteria: Record<string, string> } & QuestionMeta)
  | ({ type: "score"; criteria: string[]; min?: number; max?: number } & QuestionMeta)
  | ({ type: "noul" } & QuestionMeta);

export type DecisionConfidence =
  | { value: number; source: "reported" }
  | { value: number; source: "estimated"; method: "top-two-margin" | "binary-distance" };

export type Answer =
  | { type: "choice"; choice: string; probabilities?: Record<string, number>; confidence?: DecisionConfidence }
  | { type: "score"; score: number; probabilities?: Record<string, number>; confidence?: DecisionConfidence }
  | { type: "noul"; noul: number; confidence?: DecisionConfidence };

export type DecideRequest = {
  version: 1;
  /** Consumer capability name, e.g. `"browser.step"`; a backend may pick its own prompt by it. */
  binding?: string;
  state: DecisionState;
  questions: Record<string, Question>;
  model?: string;
};

export type DecideResponse = {
  version: 1;
  backend: string;
  answers: Record<string, Answer>;
  usage?: { inputTokens?: number; outputTokens?: number };
};

/**
 * Routing/budget metadata for a `decide()` call. Deliberately disjoint from `DecisionState`:
 * `budgetKey` and `route` steer cancellation, cost tracking and trace — they must never leak
 * into the model input, or a decision would silently depend on which conversation asked.
 */
export type DecisionRuntimeContext = {
  budgetKey?: string;
  signal?: AbortSignal;
  route?: { conversationId?: string; runId?: string; tabId?: string; owner?: string };
};

/** The shape every backend adapter implements, so a consumer can swap Jev for Laya for a future one without changing. */
export type DecisionBackend = {
  readonly id: string;
  decide(request: DecideRequest, context?: DecisionRuntimeContext): Promise<DecideResponse>;
};

/**
 * Strips host-only validation metadata before a request crosses to a backend.
 *
 * `requiredWhen` decides whether *this host* treats an answer as required (see
 * docs/decision-layer.md §3.3) — it is not part of any backend's own question schema, and
 * sending it along would leak an internal validation detail into a vendor's request log for
 * no reason. Every adapter must call this rather than forwarding `request.questions` as-is.
 */
export function sanitizeQuestions(questions: Record<string, Question>): Record<string, Question> {
  const out: Record<string, Question> = {};
  for (const [id, question] of Object.entries(questions)) {
    const { requiredWhen: _requiredWhen, ...rest } = question;
    out[id] = rest as Question;
  }
  return out;
}
