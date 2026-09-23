import { randomUUID } from "node:crypto";
import { adoptAnswers, JEV_SIZE_LIMITS, measureRequest, screenRequest, type AdoptionPolicy, type SizeLimits } from "./dispatch.ts";
import { assertValidQuestions, type DecideRequest, type DecideResponse, type DecisionOutcome } from "./protocol.ts";
import { buildTraceRecord, type DecisionTraceSink } from "./trace.ts";

/**
 * Runs decisions against a backend: budget, deadline, per-request timeout, retries,
 * cancellation and trace (docs/decision-layer.md §4).
 *
 * It holds short-lived run metadata only — request counts and a deadline per run — and
 * never conversation history: whatever the model should see is in the request's
 * `state`. It never picks a different backend or model on its own either; a handoff is
 * returned to the consumer, which decides who takes over.
 */

export type BackendErrorKind = "auth" | "bad_request" | "rate_limit" | "overloaded" | "server" | "network" | "timeout" | "malformed";

/** A backend call that failed before producing answers. */
export class DecisionBackendError extends Error {
  readonly kind: BackendErrorKind;
  readonly status: number | undefined;
  readonly retryable: boolean;
  constructor(kind: BackendErrorKind, message: string, options: { status?: number; retryable?: boolean } = {}) {
    super(message);
    this.name = "DecisionBackendError";
    this.kind = kind;
    this.status = options.status;
    this.retryable = options.retryable ?? (kind === "rate_limit" || kind === "overloaded" || kind === "server" || kind === "network");
  }
}

export type DecisionBackend = {
  /** Stable id recorded in the trace, e.g. `jev`. */
  readonly id: string;
  decide(request: DecideRequest, options: { signal: AbortSignal }): Promise<DecideResponse>;
};

export type DecisionPhase = "decide" | "text" | "review";

export type DecisionRuntimeOptions = {
  backend: DecisionBackend;
  trace?: DecisionTraceSink;
  /** Ceiling for one request including its retries. Never reset per attempt. */
  requestTimeoutMs?: number;
  /** Ceiling for a single attempt inside that window; unbounded by default. */
  attemptTimeoutMs?: number;
  /** Retries after the first attempt, for retryable failures only. */
  maxRetries?: number;
  /** Delay before retry n (0-based); the last entry repeats. */
  backoffMs?: readonly number[];
  sizeLimits?: SizeLimits;
  now?: () => number;
};

export type DecisionRunOptions = {
  /** Consumer-generated key, e.g. `browser-run:<id>`. Never part of the model's state. */
  budgetKey: string;
  /** Absolute epoch ms shared by every phase of the run. */
  deadlineAt: number;
  /** Model requests of any phase, retries included. */
  maxRequests?: number;
  /** The consumer's own stop signal (the conversation was stopped, the tab closed). */
  signal?: AbortSignal;
};

type RuntimeConfig = Required<Omit<DecisionRuntimeOptions, "trace">> & { trace?: DecisionTraceSink };

export const DEFAULT_REQUEST_TIMEOUT_MS = 8_000;
export const DEFAULT_MAX_REQUESTS = 200;
const DEFAULT_BACKOFF_MS = [250, 750] as const;

export class DecisionRuntime {
  readonly #options: RuntimeConfig;
  readonly #runs = new Set<DecisionRun>();

  constructor(options: DecisionRuntimeOptions) {
    this.#options = {
      requestTimeoutMs: DEFAULT_REQUEST_TIMEOUT_MS,
      attemptTimeoutMs: Number.POSITIVE_INFINITY,
      maxRetries: 2,
      backoffMs: DEFAULT_BACKOFF_MS,
      sizeLimits: JEV_SIZE_LIMITS,
      now: Date.now,
      ...options,
    };
  }

  startRun(options: DecisionRunOptions): DecisionRun {
    const run = new DecisionRun(this.#options, options, (self) => this.#runs.delete(self));
    // A run whose signal was already aborted released itself before it was added.
    if (!run.cancelled) this.#runs.add(run);
    return run;
  }

  /**
   * Stop every run from issuing further requests — the scenario was switched off or the
   * key was cleared. In-flight requests are aborted; their callers see `cancelled`.
   */
  revokeAll(): void {
    for (const run of [...this.#runs]) run.cancel();
  }

  get activeRuns(): number {
    return this.#runs.size;
  }
}

export type DecideOptions = {
  policy: AdoptionPolicy;
  signal?: AbortSignal;
};

export class DecisionRun {
  readonly budgetKey: string;
  readonly deadlineAt: number;
  readonly maxRequests: number;
  readonly #config: RuntimeConfig;
  readonly #controller = new AbortController();
  readonly #release: (run: DecisionRun) => void;
  #requests = 0;

  constructor(
    config: RuntimeConfig,
    options: DecisionRunOptions,
    release: (run: DecisionRun) => void,
  ) {
    this.#config = config;
    this.budgetKey = options.budgetKey;
    this.deadlineAt = options.deadlineAt;
    this.maxRequests = options.maxRequests ?? DEFAULT_MAX_REQUESTS;
    this.#release = release;
    if (options.signal) {
      if (options.signal.aborted) this.cancel();
      else options.signal.addEventListener("abort", () => this.cancel(), { once: true });
    }
  }

  get requestsUsed(): number {
    return this.#requests;
  }

  get cancelled(): boolean {
    return this.#controller.signal.aborted;
  }

  remainingMs(): number {
    return Math.max(0, this.deadlineAt - this.#config.now());
  }

  cancel(): void {
    if (!this.#controller.signal.aborted) this.#controller.abort();
    this.#release(this);
  }

  /** The run is over; it no longer counts as active. Further calls are refused. */
  finish(): void {
    this.cancel();
  }

  /**
   * Claim one model request for any phase. Cancellation is checked before the budget,
   * and the budget before the deadline, so the reported reason is the first one that
   * actually stopped the run.
   */
  reserve(): { ok: true } | Exclude<DecisionOutcome, { status: "decided" } | { status: "handoff" }> {
    if (this.cancelled) return { status: "cancelled" };
    if (this.#requests >= this.maxRequests) return { status: "exhausted", reason: "budget" };
    if (this.remainingMs() <= 0) return { status: "exhausted", reason: "deadline" };
    this.#requests++;
    return { ok: true };
  }

  async decide(request: DecideRequest, options: DecideOptions): Promise<DecisionOutcome> {
    const config = this.#config;
    const started = config.now();
    const requestId = randomUUID();
    // A malformed question set is the caller's bug: throw, never spend a request on it.
    assertValidQuestions(request.questions);

    const record = (outcome: DecisionOutcome, extra: Partial<TraceExtra> = {}): DecisionOutcome => {
      config.trace?.append(
        buildTraceRecord({
          requestId,
          request,
          backend: config.backend.id,
          budgetKey: this.budgetKey,
          phase: "decide",
          outcome,
          policyVersion: options.policy.version,
          latencyMs: config.now() - started,
          size: measureRequest(request),
          ...extra,
        }),
      );
      return outcome;
    };

    if (this.cancelled || options.signal?.aborted) return record({ status: "cancelled" });
    const screened = screenRequest(request, config.sizeLimits);
    if (screened) return record(screened, { attempts: 0 });

    const windowEnd = Math.min(started + config.requestTimeoutMs, this.deadlineAt);
    const errors: string[] = [];
    let attempts = 0;
    let response: DecideResponse | undefined;

    for (;;) {
      const reserved = this.reserve();
      if (!("ok" in reserved)) return record(reserved, { attempts, errors });
      attempts++;
      const outcome = await this.#attempt(request, windowEnd, options.signal);
      if (outcome.kind === "ok") {
        response = outcome.response;
        break;
      }
      if (outcome.kind === "cancelled") return record({ status: "cancelled" }, { attempts, errors });
      errors.push(outcome.error.kind + (outcome.error.status ? `:${outcome.error.status}` : ""));
      // An attempt that ran out the window the deadline set (a timer may fire a tick
      // early) or that finished past the deadline is the deadline, not a failure. One
      // cut short by its own attempt cap, with time left, is retried instead.
      const windowWasDeadline = windowEnd >= this.deadlineAt && !outcome.error.retryable;
      if (outcome.error.kind === "timeout" && (windowWasDeadline || config.now() >= this.deadlineAt)) {
        return record({ status: "exhausted", reason: "deadline" }, { attempts, errors });
      }
      const delay = config.backoffMs[Math.min(attempts - 1, config.backoffMs.length - 1)] ?? 0;
      const canRetry = outcome.error.retryable && attempts <= config.maxRetries && config.now() + delay < windowEnd;
      if (!canRetry) {
        return record(
          { status: "handoff", reason: "unreachable", detail: `${outcome.error.kind}: ${outcome.error.message}` },
          { attempts, errors, errorKind: outcome.error.kind },
        );
      }
      if (!(await sleep(delay, this.#controller.signal, options.signal))) {
        return record({ status: "cancelled" }, { attempts, errors });
      }
    }

    const { outcome, validAnswers } = adoptAnswers(request.questions, response.answers, options.policy);
    return record(outcome, { attempts, errors, response, validAnswers });
  }

  async #attempt(
    request: DecideRequest,
    windowEnd: number,
    external: AbortSignal | undefined,
  ): Promise<{ kind: "ok"; response: DecideResponse } | { kind: "cancelled" } | { kind: "error"; error: DecisionBackendError }> {
    const config = this.#config;
    const window = windowEnd - config.now();
    const remaining = Math.min(window, config.attemptTimeoutMs);
    // An attempt cut short by its own cap, with window left over, may be tried again.
    const capped = remaining < window;
    if (remaining <= 0) return { kind: "error", error: new DecisionBackendError("timeout", "request window elapsed") };
    const attempt = new AbortController();
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      attempt.abort();
    }, remaining);
    const onAbort = (): void => attempt.abort();
    this.#controller.signal.addEventListener("abort", onAbort, { once: true });
    external?.addEventListener("abort", onAbort, { once: true });
    try {
      const response = await config.backend.decide(request, { signal: attempt.signal });
      if (this.cancelled || external?.aborted) return { kind: "cancelled" };
      return { kind: "ok", response };
    } catch (error) {
      if (this.cancelled || external?.aborted) return { kind: "cancelled" };
      if (timedOut) return { kind: "error", error: new DecisionBackendError("timeout", `no response within ${remaining}ms`, { retryable: capped }) };
      if (error instanceof DecisionBackendError) return { kind: "error", error };
      return { kind: "error", error: new DecisionBackendError("network", error instanceof Error ? error.message : String(error)) };
    } finally {
      clearTimeout(timer);
      this.#controller.signal.removeEventListener("abort", onAbort);
      external?.removeEventListener("abort", onAbort);
    }
  }
}

type TraceExtra = Omit<Parameters<typeof buildTraceRecord>[0], "requestId" | "request" | "backend" | "budgetKey" | "phase" | "outcome" | "policyVersion" | "latencyMs" | "size">;

/** Resolves `true` after `ms`, or `false` as soon as either signal aborts. */
function sleep(ms: number, ...signals: (AbortSignal | undefined)[]): Promise<boolean> {
  return new Promise((resolve) => {
    if (signals.some((signal) => signal?.aborted)) return resolve(false);
    const cleanup = (): void => {
      clearTimeout(timer);
      for (const signal of signals) signal?.removeEventListener("abort", onAbort);
    };
    const onAbort = (): void => {
      cleanup();
      resolve(false);
    };
    const timer = setTimeout(() => {
      cleanup();
      resolve(true);
    }, ms);
    for (const signal of signals) signal?.addEventListener("abort", onAbort, { once: true });
  });
}
