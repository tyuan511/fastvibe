// SPDX-License-Identifier: MIT
// Local M11 loopback test protocol only. Paths are inherited from M10 plans;
// this is NOT a native GitHub adapter or an exactly-once/idempotency guarantee.
import type { Policy } from "../core/ports.ts";
import type { ShadowCredentialHost } from "./credential-host.ts";
import { ShadowDriver, type ShadowDriverOptions } from "./driver.ts";
import { GithubOperationDryRun, type GithubOperationPayload, type GithubOperationPlan, type GithubOperationRequest } from "./github-operation.ts";
import type { OperationAdapter, OperationContext } from "./operations.ts";
import type { ShadowSourceRegistry } from "./source-registry.ts";
import type { Operation, ShadowStore } from "./store.ts";

type HttpResult = { status: number; body: unknown };
export interface GithubHttpAdapterOptions {
  baseUrl: string;
  credentials: ShadowCredentialHost;
  source?: string;
  timeoutMs?: number;
  authorize?: (operation: Operation) => void;
}
function payloadOf(operation: Operation): GithubOperationPayload {
  const payload = operation.payload as GithubOperationPayload;
  if (payload?.mode !== "dry-run" || !payload.expected || !["branch", "pull", "review", "merge", "issue-close"].includes(payload.kind)) throw new Error("M11 operation payload 无效");
  const path = payload.expected.path;
  if (!/^\/(?:repos|repositories)\/\d+\/(?:git\/refs|pulls(?:\/\d+\/(?:reviews|merge))?|issues\/\d+)$/.test(path)) throw new Error("M11 operation path 无效");
  if (payload.authorization.source !== operation.source || payload.authorization.instance !== operation.instance) throw new Error("M11 operation 身份不匹配");
  return payload;
}
function object(value: unknown): Record<string, unknown> | undefined { return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined; }

function matches(payload: GithubOperationPayload, value: unknown): boolean {
  const row = object(value), expected = payload.expected.body;
  if (!row) return false;
  if (payload.kind === "branch") return row.ref === expected.ref && object(row.object)?.sha === expected.sha;
  if (payload.kind === "pull") return row.head === expected.head && row.base === expected.base && row.title === expected.title && row.body === expected.body;
  if (payload.kind === "review") return row.commit_id === expected.commit_id && row.event === expected.event && row.body === expected.body;
  if (payload.kind === "merge") return row.merged === true && row.mergedHead === expected.sha && row.mergedBase === expected.base
    && /^[0-9a-f]{40,64}$/i.test(String(row.sha ?? row.mergeCommit ?? ""));
  return row.state === "closed" && row.mergeCommit === expected.mergeCommit
    && (expected.version === undefined || row.version === Number(expected.version) + 1);
}
function scrub(value: unknown, secret: string): unknown {
  if (typeof value === "string") return value.replaceAll(secret, "[REDACTED]");
  if (Array.isArray(value)) return value.map(item => scrub(item, secret));
  const row = object(value);
  return row ? Object.fromEntries(Object.entries(row).map(([key, item]) => [key.replaceAll(secret, "[REDACTED]"), scrub(item, secret)])) : value;
}

/** Real fetch against an explicitly configured loopback server, with no implicit credentials. */
export class GithubOperationHttpAdapter implements OperationAdapter {
  private readonly baseUrl: string;
  private readonly credentials: ShadowCredentialHost;
  private readonly source: string;
  private readonly timeoutMs: number;
  private readonly authorize?: (operation: Operation) => void;
  constructor(options: GithubHttpAdapterOptions) {
    const url = new URL(options.baseUrl);
    if (url.protocol !== "http:" || url.hostname !== "127.0.0.1" || url.username || url.password || url.search || url.hash || url.pathname !== "/") throw new Error("M11 adapter 只允许 loopback HTTP origin");
    this.baseUrl = url.origin; this.credentials = options.credentials; this.source = options.source ?? "github";
    this.timeoutMs = options.timeoutMs ?? 5000; this.authorize = options.authorize;
    if (!Number.isSafeInteger(this.timeoutMs) || this.timeoutMs <= 0) throw new Error("M11 HTTP timeout 无效");
  }
  async execute(operation: Operation, context: OperationContext): Promise<{ status: "confirmed" | "failed"; receipt?: unknown }> {
    const payload = payloadOf(operation);
    if (operation.source !== this.source) throw new Error("M11 adapter Source 不匹配");
    const result = await this.send(operation, payload.expected.method, payload.expected.path, payload.expected.body, context.signal);
    // Only explicit refusal is a known failure; malformed success, throttling and
    // 5xx remain uncertain because an error can follow a committed write.
    if ([400, 401, 403, 404, 409, 422].includes(result.status) && object(result.body)?.applied === false) return { status: "failed", receipt: result };
    if (result.status < 200 || result.status >= 300 || object(result.body)?.operationId !== operation.id || !matches(payload, result.body)) throw new Error("M11 HTTP 写入结果未知");
    return { status: "confirmed", receipt: result };
  }
  async inspect(operation: Operation, context: OperationContext): Promise<{ status: "confirmed" | "not-applied" | "unknown"; receipt?: unknown }> {
    const payload = payloadOf(operation), expected = payload.expected;
    if (operation.source !== this.source) throw new Error("M11 adapter Source 不匹配");
    let path = expected.path;
    if (payload.kind === "branch") path += `/heads/${encodeURIComponent(String(expected.body.ref).replace(/^refs\/heads\//, ""))}`;
    if (payload.kind === "merge") path = path.replace(/\/merge$/, "");
    const result = await this.send(operation, "GET", path, undefined, context.signal);
    // Absence, errors and different versions cannot prove a write never occurred.
    if (result.status !== 200) return { status: "unknown" };
    const confirmed = Array.isArray(result.body) ? result.body.some(row => matches(payload, row)) : matches(payload, result.body);
    return { status: confirmed ? "confirmed" : "unknown", receipt: result };
  }
  private async send(operation: Operation, method: string, path: string, body: Record<string, unknown> | undefined, signal: AbortSignal): Promise<HttpResult> {
    return this.credentials.withSourceCredential(this.source, `m11:${method === "GET" ? "inspect" : "execute"}`, async secret => {
      if (typeof secret !== "string" || !secret) throw new Error("M11 credential resolver 必须返回字符串");
      // Optional host authority is checked after asynchronous credential resolution,
      // immediately before the write. Without it this is a test-only fake profile.
      if (method !== "GET") this.authorize?.(operation);
      const controller = new AbortController(); const abort = () => controller.abort(); signal.addEventListener("abort", abort, { once: true });
      if (signal.aborted) controller.abort();
      const timer = setTimeout(abort, this.timeoutMs);
      try {
        const response = await fetch(`${this.baseUrl}${path}`, { method, redirect: "error", signal: controller.signal,
          headers: { authorization: `Bearer ${secret}`, "content-type": "application/json", "x-m11-operation": operation.id },
          ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
        // The timeout covers reading the body as well as receiving headers.
        return { status: response.status, body: scrub(await response.json(), secret) };
      } catch { throw new Error("M11 HTTP 请求失败或超时，结果待对账"); }
      finally { clearTimeout(timer); signal.removeEventListener("abort", abort); }
    }).catch(() => { throw new Error("M11 凭据解析、授权或 HTTP 请求未确认，需对账"); });
  }
}

const isolatedPolicy: Policy = { version: "m11-test", paused: false, evalTimeoutMs: 60_000,
  gate: () => ({ admissible: true, strength: "explicit", basis: { via: "listed" } }), revalidate: () => true, admitsInferred: () => true };
export class GithubTestDeployment {
  readonly planner: GithubOperationDryRun;
  readonly driver: ShadowDriver;
  private readonly store: ShadowStore;
  constructor(store: ShadowStore, registry: ShadowSourceRegistry, credentials: ShadowCredentialHost, options: {
    baseUrl: string; source?: string; instance?: string; now?: () => number; timeoutMs?: number; authorize?: (operation: Operation) => void; driverOptions?: Partial<ShadowDriverOptions>;
  }) {
    this.store = store; const source = options.source ?? "github", instance = options.instance ?? source;
    this.planner = new GithubOperationDryRun(store, registry, source, instance);
    const adapter = new GithubOperationHttpAdapter({ baseUrl: options.baseUrl, credentials, source, timeoutMs: options.timeoutMs, authorize: options.authorize });
    this.driver = new ShadowDriver(store, { policy: () => isolatedPolicy, scope: { scope: () => ({ listened: true, observed: false }) },
      intervalMs: false, now: options.now, ...options.driverOptions }, { operations: adapter });
  }
  planAndQueue(request: GithubOperationRequest): GithubOperationPlan {
    return this.store.atomic(() => {
      const plan = this.planner.plan(request);
      const queued = this.driver.operations!.plan({ id: plan.id, source: plan.source, instance: plan.instance, key: plan.key, payload: plan.payload });
      return { ...queued, payload: queued.payload as GithubOperationPayload };
    });
  }
  start(): void { this.driver.start(); }
  idle(): Promise<void> { return this.driver.idle(); }
  recover(): void { this.driver.recover(); }
  stop(options: { abort?: boolean } = {}): Promise<void> { return this.driver.stop(options); }
}
