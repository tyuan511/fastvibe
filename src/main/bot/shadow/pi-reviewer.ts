// SPDX-License-Identifier: MIT
import { createHash } from "node:crypto";
import type { AgentSession, ExtensionFactory, ModelRuntime } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import type { WorkerToken } from "./engine.ts";
import { ScratchPiSession } from "./pi-session.ts";
import type { PiRead } from "./pi-ledger.ts";
import type { ShadowStore } from "./store.ts";

export interface ReviewerFile { path: string; version: string }
export interface ReviewerCheck { name: string; status: "passed" | "failed" | "not-run"; evidence: string }
export interface PiReviewInput {
  artifactId: string; headSha: string; baseSha: string; diff: string; requirements: string;
  files: readonly ReviewerFile[];
  /** Only the host can attest execution of checks; the reviewer has no execution tool. */
  verifiedChecks?: readonly ReviewerCheck[];
}
export interface PiReviewArtifact {
  artifactId: string; headSha: string; baseSha: string;
  findings: { severity: "critical" | "high" | "medium" | "low" | "info"; path: string; line?: number; message: string }[];
  checks: ReviewerCheck[]; summary: string; verdict: "approve" | "request-changes" | "comment";
}
export interface PiReviewRecord {
  sessionKey: string; ticketId: string; artifactId: string; headSha: string; baseSha: string; fingerprint: string; binding: WorkerToken;
  status: "queued" | "running" | "uncertain" | "completed" | "cancelled";
  attempt: number; requestId: string; cancelRequested: boolean;
  artifact?: PiReviewArtifact;
  evidence?: { toolCallId: string; read: PiRead };
}
export interface ManagedPiReviewerOptions {
  store: ShadowStore; root: string; modelRuntime: ModelRuntime; model: NonNullable<AgentSession["model"]>;
  binding: WorkerToken; isCurrent: () => boolean;
  snapshot: () => { headSha: string; baseSha: string };
  /** An allowlisted workspace reader. It must not resolve arbitrary filesystem paths or expose credentials. */
  readFile: (file: ReviewerFile, signal?: AbortSignal) => Promise<{ content: string; version: string }>;
}
const hash = (value: unknown): string => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const same = (a: WorkerToken, b: WorkerToken): boolean => a.ticketId === b.ticketId && a.assignmentId === b.assignmentId
  && a.generation === b.generation && a.claimToken === b.claimToken;
const pathOK = (path: string): boolean => !!path && !path.includes("\\") && !path.includes("\0") && !path.startsWith("/")
  && path.split("/").every(part => !!part && part !== "." && part !== "..");
const checkSchema = Type.Object({ name: Type.String({ minLength: 1 }), status: Type.Union([Type.Literal("passed"), Type.Literal("failed"), Type.Literal("not-run")]), evidence: Type.String({ minLength: 1 }) }, { additionalProperties: false });
const artifactSchema = Type.Object({
  artifactId: Type.String({ minLength: 1 }), headSha: Type.String(), baseSha: Type.String(),
  findings: Type.Array(Type.Object({ severity: Type.Union(["critical", "high", "medium", "low", "info"].map(s => Type.Literal(s))),
    path: Type.String({ minLength: 1 }), line: Type.Optional(Type.Integer({ minimum: 1 })), message: Type.String({ minLength: 1 }) }, { additionalProperties: false })),
  checks: Type.Array(checkSchema), summary: Type.String({ minLength: 1 }),
  verdict: Type.Union([Type.Literal("approve"), Type.Literal("request-changes"), Type.Literal("comment")]),
}, { additionalProperties: false });

/** A managed real SDK session with exactly two tools. Tool selection is not an OS sandbox. */
export class ManagedPiReviewer {
  private readonly options: ManagedPiReviewerOptions;
  private stopped = false;
  private readonly pending = new Map<string, Promise<PiReviewRecord>>();
  private readonly sessions = new Map<string, ScratchPiSession>();
  private constructor(options: ManagedPiReviewerOptions) { this.options = { ...options, binding: structuredClone(options.binding) }; }
  static async open(options: ManagedPiReviewerOptions): Promise<ManagedPiReviewer> { return new ManagedPiReviewer(options); }
  private identity(input: PiReviewInput): string { return hash([this.options.binding.ticketId, input.artifactId]); }
  private normalize(input: PiReviewInput): PiReviewInput {
    if (!input.artifactId?.trim() || !/^[a-f0-9]{40}$/.test(input.headSha) || !/^[a-f0-9]{40}$/.test(input.baseSha)
      || typeof input.diff !== "string" || !input.requirements?.trim() || !Array.isArray(input.files)
      || input.files.some(f => !pathOK(f.path) || !f.version?.trim()) || new Set(input.files.map(f => f.path)).size !== input.files.length) throw new Error("Invalid reviewer versioned input");
    const checks = input.verifiedChecks ?? [];
    if (checks.some(c => !c.name?.trim() || !["passed", "failed", "not-run"].includes(c.status) || !c.evidence?.trim())
      || new Set(checks.map(c => c.name)).size !== checks.length) throw new Error("Invalid host check evidence");
    return structuredClone({ artifactId: input.artifactId, headSha: input.headSha, baseSha: input.baseSha, diff: input.diff,
      requirements: input.requirements, files: input.files.map(file => ({ path: file.path, version: file.version })).sort((a, b) => a.path.localeCompare(b.path)),
      verifiedChecks: checks.map(check => ({ name: check.name, status: check.status, evidence: check.evidence })).sort((a, b) => a.name.localeCompare(b.name)) });
  }
  private load(key: string) { return this.options.store.cursors.get<PiReviewRecord>("pi-reviewer", "sdk", key); }
  private update(key: string, mutate: (value: PiReviewRecord) => PiReviewRecord): PiReviewRecord {
    return this.options.store.atomic(() => {
      const row = this.load(key); if (!row) throw new Error("Missing reviewer record");
      const value = mutate(structuredClone(row.value));
      if (!this.options.store.cursors.save("pi-reviewer", "sdk", key, value, row.revision)) throw new Error("Reviewer record changed");
      return value;
    });
  }
  /** Read-only, including after restart: never opens a session or replays a provider request. */
  inspect(raw: PiReviewInput): PiReviewRecord | undefined {
    const input = this.normalize(raw), value = this.load(this.identity(input))?.value;
    if (value && value.fingerprint !== hash(input)) throw new Error("Reviewer artifact intent drift");
    if (!value) return undefined;
    if (["queued", "running"].includes(value.status) && !this.pending.has(this.identity(input))) return { ...value, status: "uncertain" };
    return value;
  }
  private validate(input: PiReviewInput, key: string, attempt: number): void {
    const current = this.load(key)?.value, snapshot = this.options.snapshot();
    if (this.stopped || !this.options.isCurrent() || snapshot.headSha !== input.headSha || snapshot.baseSha !== input.baseSha
      || !current || current.attempt !== attempt || current.cancelRequested || !same(current.binding, this.options.binding)
      || !["queued", "running", "completed"].includes(current.status)) throw new Error("Reviewer stopped, stale binding or version drift");
  }
  review(input: PiReviewInput): Promise<PiReviewRecord> { return this.start(input, false); }
  retry(input: PiReviewInput): Promise<PiReviewRecord> { return this.start(input, true); }
  private async start(raw: PiReviewInput, retry: boolean): Promise<PiReviewRecord> {
    const input = this.normalize(raw), key = this.identity(input);
    const existing = this.inspect(input);
    if (existing && !same(existing.binding, this.options.binding)) throw new Error("Reviewer parent binding changed");
    if (this.stopped || !this.options.isCurrent()) throw new Error("Reviewer is stopped or stale");
    const snapshot = this.options.snapshot();
    if (snapshot.headSha !== input.headSha || snapshot.baseSha !== input.baseSha) throw new Error("Reviewer version drift");
    if (this.pending.has(key)) return this.pending.get(key)!;
    if (existing && (!retry || existing.status === "completed")) return existing;
    if (existing?.status === "cancelled") throw new Error("Cancelled reviewer requires a new artifact identity");
    const attempt = (existing?.attempt ?? 0) + 1;
    const sessionKey = `reviewer-${hash([this.options.binding.ticketId, input.headSha, input.baseSha, input.artifactId])}`;
    this.options.store.atomic(() => {
      const row = this.load(key);
      const value: PiReviewRecord = { sessionKey, ticketId: this.options.binding.ticketId, artifactId: input.artifactId, headSha: input.headSha, baseSha: input.baseSha, fingerprint: hash(input),
        binding: structuredClone(this.options.binding), status: "queued", attempt, requestId: `review-${attempt}`, cancelRequested: false };
      if (!this.options.store.cursors.save("pi-reviewer", "sdk", key, value, row?.revision ?? 0)) throw new Error("Reviewer enqueue changed");
    });
    const run = this.execute(input, key, attempt);
    this.pending.set(key, run);
    try { return await run; } finally { if (this.pending.get(key) === run) this.pending.delete(key); }
  }
  private async execute(input: PiReviewInput, key: string, attempt: number): Promise<PiReviewRecord> {
    let adapter: ScratchPiSession | undefined;
    const validate = () => this.validate(input, key, attempt);
    const extension: ExtensionFactory = pi => {
      pi.registerTool({ name: "read_file", label: "Read snapshot file", description: "Read only a host-allowlisted workspace file at its fixed version.",
        parameters: Type.Object({ path: Type.String() }, { additionalProperties: false }),
        execute: async (_id, args, signal) => {
          validate(); const file = input.files.find(f => f.path === args.path);
          if (!file) throw new Error("File is outside reviewer snapshot");
          const result = await this.options.readFile(structuredClone(file), signal);
          validate(); if (signal?.aborted || result.version !== file.version) throw new Error("Reviewer file version changed");
          return { content: [{ type: "text", text: result.content }], details: { path: file.path, version: file.version } };
        } });
      pi.registerTool({ name: "dsh_review", label: "Record structured review", description: "Submit findings for the exact head/base. Checks without host execution evidence are stored as not-run.",
        parameters: artifactSchema,
        execute: async (toolCallId, args) => {
          validate();
          const artifact = structuredClone(args) as PiReviewArtifact;
          if (artifact.artifactId !== input.artifactId || artifact.headSha !== input.headSha || artifact.baseSha !== input.baseSha
            || artifact.findings.some(f => !pathOK(f.path) || !input.files.some(file => file.path === f.path))) throw new Error("Review artifact version/path mismatch");
          if (new Set(artifact.checks.map(c => c.name)).size !== artifact.checks.length) throw new Error("Duplicate reviewer check");
          artifact.checks = artifact.checks.map(check => {
            const verified = input.verifiedChecks?.find(c => c.name === check.name);
            return verified ? structuredClone(verified) : { name: check.name, status: "not-run", evidence: "Not executed by this read-only reviewer. " + check.evidence };
          });
          for (const check of input.verifiedChecks ?? []) if (!artifact.checks.some(c => c.name === check.name)) artifact.checks.push(structuredClone(check));
          const receipt = adapter?.get(`review-${attempt}`);
          const read = receipt?.reads.filter(r => same(r.binding, this.options.binding) && r.epoch === receipt.epoch).at(-1);
          if (!read) throw new Error("Review has no current provider-read evidence");
          this.options.store.atomic(() => {
            validate();
            this.update(key, record => {
              if (record.artifact && hash(record.artifact) !== hash(artifact)) throw new Error("Reviewer artifact content drift");
              return { ...record, status: "completed", artifact, evidence: { toolCallId, read } };
            });
          });
          return { content: [{ type: "text", text: "Structured review recorded" }], details: { artifactId: artifact.artifactId }, terminate: true };
        } });
    };
    try {
      validate();
      const record = this.load(key)!.value;
      adapter = await ScratchPiSession.open({ ...this.options, sessionKey: record.sessionKey, activeTools: ["read_file", "dsh_review"], validate,
        extensions: [extension], context: () => ({ reviewer: true, headSha: input.headSha, baseSha: input.baseSha, artifactId: input.artifactId }) });
      this.sessions.set(key, adapter); validate();
      if (adapter.session.getActiveToolNames().slice().sort().join(",") !== "dsh_review,read_file") throw new Error("Reviewer tool set mismatch");
      // Accept before activation, so the durable intent exists even if dispatch fails.
      this.options.store.atomic(() => {
        validate(); adapter!.prepare({ requestId: record.requestId, text: JSON.stringify({ instruction: "Review the full fixed diff and requirements. Use read_file for context and dsh_review for the only accepted result. No test execution is available; never claim unverified checks passed.", ...input }) });
        this.update(key, value => ({ ...value, status: "running" }));
      });
      const submission = await adapter.activate(record.requestId);
      await submission.completion;
    } catch {
      // Provider/SDK exceptions can contain secrets; the durable projection stores no raw exception.
    } finally {
      if (adapter) { await adapter.dispose(); this.sessions.delete(key); }
      this.update(key, value => value.attempt !== attempt || ["completed", "cancelled"].includes(value.status) ? value : { ...value, status: value.cancelRequested ? "cancelled" : "uncertain" });
    }
    return this.load(key)!.value;
  }
  async stop(): Promise<void> { await this.close(true); }
  async dispose(): Promise<void> { await this.close(false); }
  private async close(cancel: boolean): Promise<void> {
    this.stopped = true;
    for (const key of this.pending.keys()) this.update(key, value => ({ ...value, cancelRequested: cancel || value.cancelRequested }));
    await Promise.all([...this.sessions.values()].map(async adapter => { if (cancel) await adapter.stop(); await adapter.dispose(); }));
    await Promise.allSettled([...this.pending.values()]);
  }
}
