import { createHash } from "node:crypto";
import { appendFileSync, existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import type { RequestSize } from "./dispatch.ts";
import { canonicalize, effectiveConfidence, type Answer, type DecideRequest, type DecideResponse, type DecisionConfidence, type DecisionOutcome } from "./protocol.ts";

/**
 * One line of `decision-trace.jsonl` per decision call (docs/decision-layer.md §4.4).
 *
 * The trace answers "why did it click that / why did it hand off" without storing the
 * page: state, criteria and instructions appear only as a hash and a size, and a choice
 * is recorded by its option id, which the consumer generates and which carries no page
 * text. No price either — raw tokens and the model, priced at read time like the usage
 * ledger.
 */
export type DecisionTraceRecord = {
  ts: string;
  requestId: string;
  binding: string | null;
  phase: "decide" | "text" | "review";
  backend: string;
  /** The model the backend reported, falling back to the one requested. */
  model: string | null;
  budgetKey: string;
  stateHash: string;
  size: RequestSize;
  questions: Record<string, { type: string; options?: number; conditional?: boolean }>;
  answerSummary: Record<string, { choice?: string; score?: number; noul?: number; confidence?: DecisionConfidence }>;
  activeQuestionIds: string[] | null;
  outcome: DecisionOutcome["status"];
  handoffReason: string | null;
  exhaustedReason: string | null;
  affectedQuestionIds: string[] | null;
  errorKind: string | null;
  errors: string[];
  attempts: number;
  policyVersion: string;
  latencyMs: number;
  usage: { inputTokens?: number; outputTokens?: number } | null;
};

export type DecisionTraceSink = { append(record: DecisionTraceRecord): void };

export function hashState(state: unknown): string {
  return `sha256:${createHash("sha256").update(canonicalize(state)).digest("hex")}`;
}

export function buildTraceRecord(input: {
  requestId: string;
  request: DecideRequest;
  backend: string;
  budgetKey: string;
  phase: DecisionTraceRecord["phase"];
  outcome: DecisionOutcome;
  policyVersion: string;
  latencyMs: number;
  size: RequestSize;
  attempts?: number;
  errors?: string[];
  errorKind?: string;
  response?: DecideResponse;
  validAnswers?: Record<string, Answer>;
  now?: Date;
}): DecisionTraceRecord {
  const { request, outcome } = input;
  const questions: DecisionTraceRecord["questions"] = {};
  for (const [id, question] of Object.entries(request.questions)) {
    questions[id] = {
      type: question.type,
      ...(question.type === "choice" ? { options: Object.keys(question.criteria).length } : {}),
      ...(question.type === "score" ? { options: question.criteria.length } : {}),
      ...(question.requiredWhen ? { conditional: true } : {}),
    };
  }
  const answerSummary: DecisionTraceRecord["answerSummary"] = {};
  for (const [id, answer] of Object.entries(input.validAnswers ?? {})) {
    const confidence = effectiveConfidence(answer);
    answerSummary[id] = {
      ...(answer.type === "choice" ? { choice: answer.choice } : {}),
      ...(answer.type === "score" ? { score: answer.score } : {}),
      ...(answer.type === "noul" ? { noul: answer.noul } : {}),
      ...(confidence ? { confidence } : {}),
    };
  }
  return {
    ts: (input.now ?? new Date()).toISOString(),
    requestId: input.requestId,
    binding: request.binding ?? null,
    phase: input.phase,
    backend: input.backend,
    model: input.response?.model ?? request.model ?? null,
    budgetKey: input.budgetKey,
    stateHash: hashState(request.state),
    size: input.size,
    questions,
    answerSummary,
    activeQuestionIds: outcome.status === "decided" ? outcome.activeQuestionIds : null,
    outcome: outcome.status,
    handoffReason: outcome.status === "handoff" ? outcome.reason : null,
    exhaustedReason: outcome.status === "exhausted" ? outcome.reason : null,
    affectedQuestionIds: outcome.status === "handoff" ? outcome.affectedQuestionIds ?? null : null,
    errorKind: input.errorKind ?? null,
    errors: input.errors ?? [],
    attempts: input.attempts ?? 0,
    policyVersion: input.policyVersion,
    latencyMs: input.latencyMs,
    usage: input.response?.usage ?? null,
  };
}

/**
 * Append-only JSONL sink, trimmed to the newest `keep` lines.
 *
 * Appends are synchronous, as the usage ledger's are: one short line per decision, and a
 * crash right after a click should still leave the record of why it clicked. Trimming
 * waits until the file holds half again as many lines, so it is a rare rewrite rather
 * than one per append, and goes through a temp file so a crash mid-trim loses nothing.
 * Written 0600: even hashed, this is a record of what the user browsed.
 */
export class DecisionTraceFile implements DecisionTraceSink {
  readonly #file: string;
  readonly #keep: number;
  #lines: number | undefined;

  constructor(file: string, keep = 2000) {
    this.#file = file;
    this.#keep = Math.max(1, keep);
  }

  append(record: DecisionTraceRecord): void {
    try {
      appendFileSync(this.#file, `${JSON.stringify(record)}\n`, { encoding: "utf8", mode: 0o600 });
      this.#lines = (this.#lines ?? this.#count()) + 1;
      if (this.#lines > Math.ceil(this.#keep * 1.5)) this.#trim();
    } catch {
      // A trace that cannot be written must not fail the decision it describes.
    }
  }

  read(): DecisionTraceRecord[] {
    if (!existsSync(this.#file)) return [];
    const records: DecisionTraceRecord[] = [];
    for (const line of readFileSync(this.#file, "utf8").split("\n")) {
      if (!line.trim()) continue;
      try {
        records.push(JSON.parse(line) as DecisionTraceRecord);
      } catch {
        // A torn last line from a crash is skipped, not fatal.
      }
    }
    return records;
  }

  #count(): number {
    if (!existsSync(this.#file)) return 0;
    return readFileSync(this.#file, "utf8").split("\n").filter((line) => line.trim()).length;
  }

  #trim(): void {
    const lines = readFileSync(this.#file, "utf8").split("\n").filter((line) => line.trim());
    const kept = lines.slice(-this.#keep);
    const temp = `${this.#file}.tmp`;
    writeFileSync(temp, `${kept.join("\n")}\n`, { encoding: "utf8", mode: 0o600 });
    renameSync(temp, this.#file);
    this.#lines = kept.length;
  }
}
