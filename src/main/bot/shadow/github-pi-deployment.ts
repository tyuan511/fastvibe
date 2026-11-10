// SPDX-License-Identifier: MIT
// Isolated M11 composition; never constructed by the production BotRuntime or IPC.
import { createHash } from "node:crypto";
import { GithubNativeDeployment, type GithubNativeDeploymentOptions } from "./github-native-deployment.ts";
import { PiExecutor, type PiExecutorOptions } from "./pi-executor.ts";
import { PiLedger } from "./pi-ledger.ts";
import { renderReviewBody } from "./github-presentation.ts";
import type { GithubOperationKind } from "./github-operation.ts";
import type { PiReviewRecord } from "./pi-reviewer.ts";
import type { WorkerToken } from "./engine.ts";
import type { ShadowStore } from "./store.ts";
import type { ShadowSourceRegistry } from "./source-registry.ts";

export interface GithubPiDeploymentOptions {
  native: GithubNativeDeploymentOptions;
  worker: Omit<PiExecutorOptions, "store" | "engine" | "enabled">;
  /** false disables automatic reads; explicit options preserve the M9 baseline rules. */
  poll: false | Parameters<GithubNativeDeployment["poll"]>[0];
  reviewDelivery?: {
    /** Trusted host PR observation; model arguments cannot select another repository or PR. */
    target: (binding: WorkerToken) => { pullNumber: number; headSha: string; baseSha: string };
    source: string; instance: string; repositoryId: string | number;
    /** Match the immutable workflow profile if it grants other delivery operations. */
    allowed?: readonly GithubOperationKind[]; settleIssue?: boolean;
  };
}
const same = (a: WorkerToken, b: WorkerToken): boolean => a.ticketId === b.ticketId && a.assignmentId === b.assignmentId && a.generation === b.generation && a.claimToken === b.claimToken;

/** Real SDK tools and native HTTP operations share durable domain callbacks, not model assertions. */
export class GithubPiDeployment {
  readonly native: GithubNativeDeployment;
  readonly executor: PiExecutor;
  private readonly store: ShadowStore;
  private readonly options: GithubPiDeploymentOptions;
  private started = false;
  private closing = false;
  private stopping?: Promise<void>;
  constructor(store: ShadowStore, registry: ShadowSourceRegistry, options: GithubPiDeploymentOptions) {
    this.store = store; this.options = options;
    const reviewer = options.worker.reviewer;
    // reviewDelivery may be driven either by an executor-managed reviewer (onCompleted
    // wrapper below) or by a host-opened ManagedPiReviewer whose durable cursor record
    // planReview() validates; the identity fence below applies to both.
    if (options.reviewDelivery) {
      const delivery = options.reviewDelivery, source = options.native.source ?? "github", instance = options.native.instance ?? source;
      const config = registry.instance(source)?.config as { selfLogins?: string[]; botLogins?: string[]; repository?: { id?: string | number } } | undefined;
      const includes = (names: string[] | undefined, login: string) => names?.some(name => name.toLowerCase() === login.toLowerCase()) === true;
      if (delivery.source !== source || delivery.instance !== instance || String(delivery.repositoryId) !== String(config?.repository?.id)
        || !includes(config?.selfLogins, options.native.writerIdentity.login) || !includes(config?.botLogins, options.native.reviewerIdentity.login)
        || includes(config?.selfLogins, options.native.reviewerIdentity.login)) throw new Error("GitHub SDK deployment requires explicit writer-self and reviewer-bot Source identities");
    }
    this.executor = new PiExecutor({ ...options.worker, store, engine: () => this.native.driver.engine,
      enabled: () => this.started && !this.closing && !this.native.driver.paused() && (options.native.driver.configured?.() ?? true),
      reviewer: reviewer && { ...reviewer, onCompleted: options.reviewDelivery ? (binding, record) => {
        const operation = this.planReview(binding, record.artifactId);
        return { operationId: operation.id, status: operation.status, receipt: "queued; external confirmation is separate" };
      } : reviewer.onCompleted },
    });
    try {
      this.native = new GithubNativeDeployment(store, registry, { ...options.native,
        driver: { ...options.native.driver, beforePass: async () => {
          if (this.started && !this.closing) {
            if (options.poll !== false && !this.native.driver.paused()) {
              // Source records its own degraded/revoked health. A read failure must
              // not starve already committed inbox/control work in other layers.
              try { await this.native.poll(options.poll); } catch { /* inspect registry health */ }
            }
            await this.executor.sweep();
            await options.native.driver.beforePass?.();
          }
        } },
        adapters: { ...options.native.adapters, ...this.executor.adapters },
      });
    } catch (error) { void this.executor.stop(); throw error; }
  }
  /** Only a durable current SDK artifact can become a source-operation intent. */
  planReview(binding: WorkerToken, artifactId: string) {
    const delivery = this.options.reviewDelivery;
    const current = this.native.driver.engine.currentBinding(binding.ticketId);
    if (!this.started || this.closing || this.native.driver.paused() || !delivery || !current || !same(binding, current)) throw new Error("Review delivery is stopped or unauthorized");
    const key = createHash("sha256").update(JSON.stringify([binding.ticketId, artifactId])).digest("hex");
    return this.store.atomic(() => {
      const record = this.store.cursors.get<PiReviewRecord>("pi-reviewer", "sdk", key)?.value;
      const artifact = record?.artifact, target = delivery.target(structuredClone(binding));
      if (!record || record.status !== "completed" || record.cancelRequested || !same(record.binding, binding) || !artifact || !record.evidence || !same(record.evidence.read.binding, binding)
        || artifact.artifactId !== artifactId || artifact.headSha !== target.headSha || artifact.baseSha !== target.baseSha || record.headSha !== target.headSha || record.baseSha !== target.baseSha) throw new Error("Review artifact lacks current host and SDK evidence");
      const receipt = record && new PiLedger(this.store).get(record.sessionKey, record.requestId);
      if (!receipt?.entryId || !record?.evidence || !receipt.reads.some(read => JSON.stringify(read) === JSON.stringify(record.evidence!.read)) || !record.evidence.toolCallId) throw new Error("Review artifact is not backed by its durable SDK input/read receipt");
      const event = artifact.verdict === "request-changes" || artifact.findings.some(finding => ["critical", "high"].includes(finding.severity)) || artifact.checks.some(check => check.status === "failed")
        ? "REQUEST_CHANGES" : artifact.verdict === "approve" ? "APPROVE" : "COMMENT";
      const authorization = this.native.grant(binding, delivery.allowed ?? ["review"], { settleIssue: delivery.settleIssue });
      const operation = this.native.planAndQueue({ kind: "review", source: delivery.source, instance: delivery.instance, repositoryId: delivery.repositoryId,
        object: { pullNumber: target.pullNumber }, params: { commitSha: artifact.headSha, artifactId, event, body: renderReviewBody(artifact) },
        authorization, preconditions: { currentState: "open", headSha: target.headSha, baseSha: target.baseSha } });
      return { id: operation.id, source: operation.source, instance: operation.instance, key: operation.key, status: operation.status };
    });
  }
  start(): void {
    if (this.closing) throw new Error("GitHub SDK deployment is stopped");
    this.started = true;
    try { this.native.start(); } catch (error) { this.started = false; throw error; }
  }
  /** Drain currently accepted work; continuous Source polling can discover later work. */
  async idle(): Promise<void> { await this.native.idle(); await this.executor.sweep(); await this.executor.idle(); await this.native.idle(); }
  stop(options: { abort?: boolean } = { abort: true }): Promise<void> {
    if (this.stopping) return this.stopping;
    this.closing = true; this.started = false;
    return this.stopping = Promise.all([this.native.stop(options), this.executor.stop()]).then(() => {});
  }
}
