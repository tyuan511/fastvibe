// SPDX-License-Identifier: MIT
// Explicit isolated native deployment; not registered with production Runtime or IPC.
import type { GithubOperationKind, GithubOperationRequest, GithubOperationPlan } from "./github-operation.ts";
import { GithubNativePlanner } from "./github-native-plan.ts";
import { GithubNativeOperationAdapter, type GithubNativeAdapterOptions } from "./github-native-operation.ts";
import { GithubOperationAuthority } from "./github-authority.ts";
import { GithubIssueSettlement } from "./github-settlement.ts";
import { GithubShadowSource, type GithubShadowSourceOptions } from "./github-source.ts";
import { ShadowDriver, type ShadowDriverOptions, type ShadowAdapters } from "./driver.ts";
import type { WorkerToken } from "./engine.ts";
import type { GithubRestTransport } from "./github-transport.ts";
import type { ShadowStore } from "./store.ts";
import type { ShadowSourceRegistry } from "./source-registry.ts";

export interface GithubNativeDeploymentOptions extends Omit<GithubNativeAdapterOptions, "store" | "authorize" | "now"> {
  reader: GithubRestTransport;
  source?: string;
  instance?: string;
  driver: Omit<ShadowDriverOptions, "scope">;
  adapters?: Omit<ShadowAdapters, "operations">;
}

export class GithubNativeDeployment {
  readonly driver: ShadowDriver;
  readonly planner: GithubNativePlanner;
  readonly authority: GithubOperationAuthority;
  readonly settlement: GithubIssueSettlement;
  private readonly store: ShadowStore;
  private readonly registry: ShadowSourceRegistry;
  private readonly options: GithubNativeDeploymentOptions;
  private readonly sourceId: string;
  private readonly instanceId: string;
  private running = false;
  private closing = false;
  private stopping?: Promise<void>;
  private readonly polls = new Set<{ controller: AbortController; promise: ReturnType<GithubShadowSource["poll"]> }>();
  constructor(store: ShadowStore, registry: ShadowSourceRegistry, options: GithubNativeDeploymentOptions) {
    this.store = store; this.registry = registry; this.options = options;
    this.sourceId = options.source ?? "github"; this.instanceId = options.instance ?? this.sourceId;
    this.planner = new GithubNativePlanner(store, registry, this.sourceId, this.instanceId);
    const adapter = new GithubNativeOperationAdapter({ ...options, store, now: options.driver.now, authorize: operation => {
      if ((operation.payload as { kind: string }).kind === "issue-close") this.settlement.authorize(operation);
      else this.authority.authorize(operation);
    } });
    this.driver = new ShadowDriver(store, { ...options.driver, scope: registry, intervalMs: options.driver.intervalMs ?? false }, { ...options.adapters, operations: adapter });
    this.authority = new GithubOperationAuthority(store, registry, this.driver.engine, options.driver.policy);
    this.settlement = new GithubIssueSettlement(store, this.driver.operations!, { registry, policy: options.driver.policy,
      buildIntent: request => this.planner.buildIntent(request) });
  }
  grant(token: WorkerToken, allowed: readonly GithubOperationKind[], options: { settleIssue?: boolean } = {}) {
    if (this.closing) throw new Error("GitHub 原生部署已停止");
    const repositoryId = String((this.registry.instance(this.sourceId)?.config.repository as { id?: unknown } | undefined)?.id ?? "");
    return this.authority.grant(token, this.sourceId, this.instanceId, repositoryId, allowed, options);
  }
  planAndQueue(request: GithubOperationRequest): GithubOperationPlan {
    if (this.closing) throw new Error("GitHub 原生部署已停止");
    if (request.kind === "issue-close") throw new Error("Issue close 只能由已登记的 merge continuation 入队");
    return this.store.atomic(() => {
      const intent = this.planner.buildIntent(request);
      this.authority.authorize({ ...intent, status: "planned", revision: 1 });
      return this.driver.operations!.plan(intent) as GithubOperationPlan;
    });
  }
  /** Explicit poll only. Production lifecycle and real Worker/reviewer wiring are separate M11 exit items. */
  poll(options: Pick<GithubShadowSourceOptions, "since" | "targets" | "threads" | "branches" | "bindings"> = {}) {
    if (!this.running || this.closing) throw new Error("GitHub 原生部署尚未启动或正在停止");
    const controller = new AbortController();
    const source = new GithubShadowSource({ ...options, store: this.store, registry: this.registry, engine: this.driver.engine,
      reader: { read: async request => {
        const result = await this.options.reader.read(request, { signal: controller.signal });
        if (this.closing || !this.running) throw new Error("GitHub 原生轮询已停止");
        return result;
      } }, source: this.sourceId, instance: this.instanceId, now: this.options.driver.now });
    const poll = { controller, promise: source.poll() }; this.polls.add(poll);
    void poll.promise.then(() => this.polls.delete(poll), () => this.polls.delete(poll));
    return poll.promise;
  }
  start(): void {
    if (this.closing) throw new Error("GitHub 原生部署已停止");
    this.running = true;
    try { this.driver.start(); } catch (error) { this.running = false; throw error; }
  }
  idle(): Promise<void> { return this.driver.idle(); }
  stop(options: { abort?: boolean } = {}): Promise<void> {
    if (this.stopping) return this.stopping;
    this.closing = true; this.running = false;
    for (const poll of this.polls) poll.controller.abort();
    return this.stopping = Promise.all([this.driver.stop(options), ...[...this.polls].map(poll => poll.promise.catch(() => undefined))]).then(() => {});
  }
}
