// SPDX-License-Identifier: MIT
// Native GitHub REST transport. No credential discovery, retries or production registration.
import type { ShadowCredentialHost } from "./credential-host.ts";
import { githubNextLink, type GithubRequest, type GithubResponse } from "./github-source.ts";

export interface GithubRestTransportOptions {
  repository: { id: string | number; owner: string; name: string };
  credentials: ShadowCredentialHost;
  source: string;
  purpose?: string;
  baseUrl?: string;
  timeoutMs?: number;
  apiVersion?: string;
  fetchImpl?: typeof fetch;
  loopbackTest?: boolean;
  /** How the write-time principal reflection binds. "github-app" skips the /user
   * check: installation tokens cannot read it (verified 2026-11-09); identity is
   * bound at token mint time instead, see docs/vivi-github-app.md. */
  principalMode?: "user" | "github-app";
  beforeRequest?: (request: { method: string; path: string }) => void;
}
export interface GithubRestResponse { status: number; headers: Record<string, string>; body: unknown }
export interface GithubRestRequestOptions { signal?: AbortSignal; beforeSend?: () => void; principal?: { id: string; login: string } }
const failure = () => new Error("GitHub REST 请求未确认（凭据、授权、网络、取消、超时或响应无效）");
const safeHeader = /^(?:etag|link|retry-after|x-ratelimit-(?:limit|remaining|reset|used|resource)|x-poll-interval|x-github-request-id)$/;
function scrub(value: unknown, secret: string): unknown {
  if (typeof value === "string") return value.replaceAll(secret, "[REDACTED]");
  if (Array.isArray(value)) return value.map(item => scrub(item, secret));
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([key, item]) => [key.replaceAll(secret, "[REDACTED]"), scrub(item, secret)]));
  return value;
}

export class GithubRestTransport {
  static readonly MAX_PAGES = 100;
  private readonly origin: string;
  private readonly options: GithubRestTransportOptions;
  private readonly timeoutMs: number;
  private readonly apiVersion: string;
  private readonly send: typeof fetch;
  readonly principalMode: "user" | "github-app";
  private readonly repoPath: string;
  private readonly idPath: string;
  constructor(options: GithubRestTransportOptions) {
    try {
      const base = new URL(options.baseUrl ?? "https://api.github.com");
      if (base.username || base.password || base.search || base.hash || base.pathname !== "/"
        || !(base.origin === "https://api.github.com" || (options.loopbackTest === true && base.protocol === "http:" && base.hostname === "127.0.0.1"))) throw failure();
      const { id, owner, name } = options.repository;
      if (!/^[1-9]\d*$/.test(String(id)) || ![owner, name].every(part => /^[A-Za-z0-9_.-]+$/.test(part) && part !== "." && part !== "..") || !options.source) throw failure();
      this.timeoutMs = options.timeoutMs ?? 10_000;
      this.apiVersion = options.apiVersion ?? "2022-11-28";
      if (!Number.isSafeInteger(this.timeoutMs) || this.timeoutMs <= 0 || !/^\d{4}-\d{2}-\d{2}$/.test(this.apiVersion)) throw failure();
      const principalMode = options.principalMode ?? "user";
      if (principalMode !== "user" && principalMode !== "github-app") throw failure();
      this.origin = base.origin;
      // Snapshot caller-owned configuration so mutation cannot widen repository scope.
      this.options = { ...options, repository: { ...options.repository } };
      this.repoPath = `/repos/${owner}/${name}`;
      this.idPath = `/repositories/${id}`;
      this.send = options.fetchImpl ?? fetch;
      this.principalMode = principalMode;
    } catch { throw failure(); }
  }
  private url(path: string, method: string): URL {
    if (typeof path !== "string" || /[\\\s#]/.test(path) || path.startsWith("//")) throw failure();
    // Validate raw segments before URL normalizes dot segments; also forbid nested encodings.
    const rawPath = path.replace(/^https?:\/\/[^/]+/i, "").split("?")[0]!;
    for (const part of rawPath.split("/")) {
      const decoded = decodeURIComponent(part);
      if (decoded === "." || decoded === ".." || /[/%\\\x00-\x20\x7f]/.test(decoded)) throw failure();
    }
    const url = new URL(path, this.origin);
    if (url.origin !== this.origin || url.username || url.password || url.hash || !path.startsWith("/") && !/^https?:\/\//.test(path)) throw failure();
    const p = url.pathname;
    const inRepo = [this.repoPath, this.idPath].some(prefix => p === prefix || p.startsWith(`${prefix}/`));
    if (!inRepo && !(method === "GET" && (p === "/notifications" || p === "/user"))) throw failure();
    return url;
  }
  async request(method: string, path: string, body?: unknown, options: GithubRestRequestOptions = {}): Promise<GithubRestResponse> {
    return this.perform(method, path, body, options);
  }
  async read(request: GithubRequest, options: GithubRestRequestOptions = {}): Promise<GithubResponse> {
    return this.perform("GET", request.path, undefined, options, request.headers);
  }
  private async perform(method: string, path: string, body: unknown, request: GithubRestRequestOptions, inputHeaders: Record<string, string> = {}): Promise<GithubRestResponse> {
    const controller = new AbortController();
    const abort = () => controller.abort();
    const signal = request.signal;
    signal?.addEventListener("abort", abort, { once: true });
    if (signal?.aborted) abort();
    const timer = setTimeout(abort, this.timeoutMs);
    // Race the entire operation, including credential resolution and body consumption.
    // A resolver/fetch double that ignores abort must not keep this request pending.
    let onAbort: (() => void) | undefined;
    const cancelled = new Promise<never>((_, reject) => {
      onAbort = () => reject(failure());
      controller.signal.addEventListener("abort", onAbort, { once: true });
      if (controller.signal.aborted) onAbort();
    });
    try {
      if (!["GET", "POST", "PATCH", "PUT", "DELETE", "HEAD"].includes(method) || ((method === "GET" || method === "HEAD") && body !== undefined)) throw failure();
      const url = this.url(path, method);
      const encoded = body === undefined ? undefined : JSON.stringify(body);
      const result = this.options.credentials.withSourceCredential(this.options.source, this.options.purpose ?? `github-rest:${method}`, async (secret, validateCredential) => {
        if (typeof secret !== "string" || !secret || /[\x00-\x20\x7f]/.test(secret)) throw failure();
        const headers = new Headers({ Accept: "application/vnd.github+json", "X-GitHub-Api-Version": this.apiVersion, Authorization: `Bearer ${secret}` });
        if (encoded !== undefined) headers.set("Content-Type", "application/json");
        for (const [key, value] of Object.entries(inputHeaders)) {
          if (/^(?:if-none-match|if-modified-since|cache-control)$/i.test(key)) headers.set(key, value);
        }
        const init: RequestInit = { method, headers, redirect: "error", signal: controller.signal, ...(encoded === undefined ? {} : { body: encoded }) };
        if (request.principal && method !== "GET" && method !== "HEAD" && this.principalMode === "user") {
          // Bind /user and the write to the same resolved secret. Resolving again
          // after a separate identity lookup could silently switch accounts.
          // github-app mode skips this reflection: installation tokens cannot read
          // /user; their identity is bound at mint time (docs/vivi-github-app.md).
          controller.signal.throwIfAborted(); validateCredential();
          const identity = await this.send(`${this.origin}/user`, { method: "GET", headers, redirect: "error", signal: controller.signal });
          const user = identity.status === 200 ? await identity.json() as { id?: unknown; login?: unknown } : undefined;
          if (!user || String(user.id) !== request.principal.id || String(user.login).toLowerCase() !== request.principal.login.toLowerCase()) throw failure();
        }
        controller.signal.throwIfAborted(); validateCredential();
        this.options.beforeRequest?.({ method, path: url.pathname + url.search });
        request.beforeSend?.();
        controller.signal.throwIfAborted(); validateCredential();
        const response = await this.send(url.href, init);
        if (response.status >= 300 && response.status < 400 && response.status !== 304) throw failure();
        const text = await response.text();
        controller.signal.throwIfAborted();
        const parsed: unknown = response.status === 204 || response.status === 304 || method === "HEAD" ? null : JSON.parse(text);
        const safe: Record<string, string> = {};
        response.headers.forEach((value, key) => { if (safeHeader.test(key)) safe[key] = value.replaceAll(secret, "[REDACTED]"); });
        return { status: response.status, headers: safe, body: scrub(parsed, secret) };
      });
      return await Promise.race([result, cancelled]);
    } catch { throw failure(); }
    finally {
      clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
      if (onAbort) controller.signal.removeEventListener("abort", onAbort);
    }
  }
  async pages(path: string, options: { signal?: AbortSignal } = {}): Promise<unknown[]> {
    const seen = new Set<string>(), rows: unknown[] = [];
    let next: string | undefined = path;
    for (let count = 0; next !== undefined; count++) {
      if (count >= GithubRestTransport.MAX_PAGES) throw new Error("GitHub REST 分页超过 100 页上限");
      let url: URL;
      try { url = this.url(next, "GET"); } catch { throw failure(); }
      // Sorting query parameters catches equivalent links with reordered parameters.
      const identity = new URL(url); identity.searchParams.sort();
      if (seen.has(identity.href)) throw new Error("GitHub REST 分页循环");
      seen.add(identity.href);
      const response = await this.request("GET", url.href, undefined, options);
      const envelope = response.body && typeof response.body === "object" && !Array.isArray(response.body)
        ? response.body as Record<string, unknown> : undefined;
      const items = Array.isArray(response.body) ? response.body : envelope?.check_runs;
      if (response.status < 200 || response.status >= 300 || !Array.isArray(items)) throw new Error("GitHub REST 分页响应无效");
      rows.push(...items);
      const link = githubNextLink(response.headers.link);
      next = link === undefined ? undefined : link.startsWith("?") ? url.pathname + link
        : link.startsWith("/") || /^https?:\/\//.test(link) ? link : url.pathname.slice(0, url.pathname.lastIndexOf("/") + 1) + link;
    }
    return rows;
  }
}
