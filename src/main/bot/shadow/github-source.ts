// SPDX-License-Identifier: MIT
// GitHub semantics adapted from the pinned DSH prototype; see ../core/NOTICE.md.
// M9 is an explicit, disposable Shadow reader. No network, credentials, timers or production registration.
import { createHash, randomUUID } from "node:crypto";
import type { EngineForSources } from "../core/engine.ts";
import type { Trigger, ThreadRef } from "../core/model.ts";
import { ShadowSourceRegistry, type ShadowSourceInstance, type SourceHealthState } from "./source-registry.ts";
import type { Lease, ShadowStore } from "./store.ts";

export type GithubHeaders = Readonly<Record<string, string | undefined>>;
export interface GithubResponse<T = unknown> { status: number; headers?: GithubHeaders; body?: T }
export interface GithubRequest { path: string; headers: Record<string, string>; cursor?: string; target?: GithubPollTarget }
export interface GithubReader { read(request: GithubRequest): GithubResponse | Promise<GithubResponse> }
export interface GithubRepository { id: string | number; owner: string; name: string; fullName?: string }
export interface GithubActor { login?: string; id?: string | number; type?: string }
export interface GithubSourceConfig { repository: GithubRepository; selfLogins?: readonly string[]; botLogins?: readonly string[]; credentialRef?: string }
export type GithubRawEvent = Record<string, unknown>;
export type GithubStreamKind = "notifications" | "issue" | "issue-comment" | "inline" | "review" | "check-run" | "status";
export interface GithubPollTarget { id: string; path: string; kind: GithubStreamKind; since?: boolean }
export interface GithubShadowSourceOptions {
  store: ShadowStore; registry: ShadowSourceRegistry; engine: { sources: EngineForSources }; reader: GithubReader;
  source?: string; sourceId?: string; instance: string; config?: GithubSourceConfig; now?: () => number; leaseMs?: number;
  /** M11 opt-in: enqueue launch/delivery for existing Tickets, never run SDK in intake. */
  intake?: "shadow" | "durable";
  /** Explicit historical replay boundary. Default is the first poll time, not all repository history. */
  since?: string;
  /** Omit for notifications + repository streams + subscriptions. Explicit targets are fixture/replay scopes. */
  targets?: readonly GithubPollTarget[];
  threads?: readonly number[]; branches?: readonly string[]; horizonMs?: number;
  /** Trusted executor metadata, never derived from issue text. */
  bindings?: readonly { ticketId: string; branch: string; repositoryId: string | number }[];
}
export interface GithubPollResult { status: "completed" | "transient-failure" | "rejected"; pages: number; events: number; failedTargets: string[]; error?: string }
export interface GithubResponsePage { status: "page" | "not-modified"; body: readonly GithubRawEvent[]; etag?: string; next?: string }

type Obj = Record<string, unknown>;
const object = (v: unknown): Obj => v !== null && typeof v === "object" && !Array.isArray(v) ? v as Obj : {};
const text = (v: unknown): string => typeof v === "string" ? v : "";
const clone = <T>(v: T): T => structuredClone(v);
function canonical(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(canonical).join(",")}]`;
  if (v && typeof v === "object") return `{${Object.keys(v).sort().filter(k => (v as Obj)[k] !== undefined).map(k => `${JSON.stringify(k)}:${canonical((v as Obj)[k])}`).join(",")}}`;
  return JSON.stringify(v) ?? "null";
}
const hash = (v: unknown): string => createHash("sha256").update(canonical(v)).digest("hex");
const header = (h: GithubHeaders | undefined, name: string): string | undefined => h?.[Object.keys(h).find(k => k.toLowerCase() === name.toLowerCase()) ?? ""];
const time = (v: unknown): number | undefined => typeof v === "string" && Number.isFinite(Date.parse(v)) ? Date.parse(v) : undefined;
const stamp = (v: Obj): string => text(v.updated_at) || text(v.submitted_at) || text(v.created_at) || text(v.completed_at) || text(v.started_at);
const positive = (v: unknown): number | undefined => Number.isSafeInteger(v) && Number(v) > 0 ? Number(v) : undefined;
const encode = (v: string | number): string => encodeURIComponent(String(v));
const prefix = (source: string, instance: string, repo: GithubRepository): string => `github:${encode(source)}:${encode(instance)}:${encode(repo.id)}`;
const threadId = (source: string, instance: string, repo: GithubRepository, number: number): string => `${prefix(source, instance, repo)}:thread:${number}`;
const repoName = (r: GithubRepository): string => `${r.owner}/${r.name}`;

export function githubNextLink(value: string | undefined): string | undefined {
  for (const part of (value ?? "").split(/,(?=\s*<)/)) {
    const url = /<([^>]+)>/.exec(part)?.[1]; const rel = /;\s*rel\s*=\s*(?:"([^"]+)"|([^;\s]+))/i.exec(part);
    if (url && (rel?.[1] ?? rel?.[2] ?? "").split(/\s+/).includes("next")) return url;
  }
  return undefined;
}
export class GithubHttpError extends Error {
  readonly status: number; readonly headers: GithubHeaders;
  constructor(status: number, message = "", headers: GithubHeaders = {}) {
    super(`GitHub HTTP ${status}${message ? `: ${message}` : ""}`); this.name = "GithubHttpError"; this.status = status; this.headers = headers;
  }
}
export function adaptGithubResponse(response: GithubResponse, previousEtag?: string): GithubResponsePage {
  const etag = header(response.headers, "etag") ?? (response.status === 304 ? previousEtag : undefined);
  if (response.status === 304) return { status: "not-modified", body: [], etag };
  if (response.status < 200 || response.status >= 300) throw new GithubHttpError(response.status, text(object(response.body).message), response.headers);
  const native = object(response.body);
  const data = Array.isArray(response.body) ? response.body : Array.isArray(native.check_runs) ? native.check_runs
    : Array.isArray(native.statuses) ? native.statuses : Object.keys(native).length ? [native] : undefined;
  if (!data || data.some(item => !Object.keys(object(item)).length)) throw new Error("GitHub response 缺少有效对象或数组");
  return { status: "page", body: data as Obj[], etag, next: githubNextLink(header(response.headers, "link")) };
}
function rateLimited(error: GithubHttpError): boolean {
  return error.status === 429 || (error.status === 403 && (header(error.headers, "retry-after") !== undefined
    || header(error.headers, "x-ratelimit-remaining") === "0" || /(?:rate limit|abuse detection)/i.test(error.message)));
}
export function githubHealthForError(error: unknown): { health: SourceHealthState; status?: "revoked" | "unavailable"; detail: string } {
  const detail = (error instanceof Error ? error.message : String(error)).slice(0, 450);
  if (error instanceof GithubHttpError) {
    if (rateLimited(error)) return { health: "degraded", detail: `rate-limited: ${detail}` };
    if (error.status === 401 || error.status === 403) return { health: "error", status: "revoked", detail };
    if (error.status === 410) return { health: "degraded", status: "unavailable", detail };
  }
  return { health: "degraded", detail };
}
function validateConfig(input: unknown): GithubSourceConfig {
  const v = object(input); const r = object(v.repository);
  if ((typeof r.id !== "string" && typeof r.id !== "number") || !String(r.id).trim() || !/^[A-Za-z0-9_.-]+$/.test(text(r.owner))
    || !/^[A-Za-z0-9_.-]+$/.test(text(r.name)) || [".", ".."].includes(text(r.name))) throw new Error("GitHub repository 配置无效");
  if (Object.keys(v).some(k => !["repository", "selfLogins", "botLogins", "credentialRef"].includes(k))) throw new Error("GitHub 配置含未知字段");
  const names = (x: unknown): string[] => {
    if (x === undefined) return [];
    if (!Array.isArray(x) || x.some(y => typeof y !== "string" || !/^[a-z0-9][a-z0-9_-]*(?:\[bot\])?$/i.test(y))) throw new Error("GitHub login 列表无效");
    return [...new Set(x.map(y => (y as string).toLowerCase()))].sort();
  };
  if (v.credentialRef !== undefined && (typeof v.credentialRef !== "string" || !v.credentialRef.trim())) throw new Error("GitHub credentialRef 必须是引用");
  return { repository: { id: String(r.id), owner: text(r.owner), name: text(r.name), fullName: `${text(r.owner)}/${text(r.name)}` },
    selfLogins: names(v.selfLogins), botLogins: names(v.botLogins), ...(v.credentialRef ? { credentialRef: v.credentialRef as string } : {}) };
}
function assertRepo(event: Obj, config: GithubSourceConfig): void {
  const r = object(event.repository); const expected = config.repository;
  if (r.id !== undefined && String(r.id) !== String(expected.id)) throw new Error("GitHub foreign repository identity");
  // Repository ID survives renames. Without an ID, a supplied name must match the configured repository.
  if (r.id === undefined && r.full_name && text(r.full_name).toLowerCase() !== repoName(expected).toLowerCase()) throw new Error("GitHub foreign repository name");
  const short = object(event.repo); if (short.id !== undefined && String(short.id) !== String(expected.id)) throw new Error("GitHub foreign repository identity");
}
function assertObjectUrls(value: Obj, config: GithubSourceConfig): void {
  for (const field of ["issue_url", "pull_request_url", "html_url"]) {
    if (value[field] === undefined || value[field] === null) continue;
    const url = text(value[field]); const match = /^https:\/\/(?:api\.github\.com\/repos|github\.com)\/([^/]+\/[^/]+)\//i.exec(url);
    if (!match || match[1]!.toLowerCase() !== repoName(config.repository).toLowerCase()) throw new Error("GitHub 对象 URL 不属于配置仓库");
  }
}
function nativeNumber(event: Obj, value: Obj): number | undefined {
  for (const n of [value.number, event.number, object(event.issue).number, object(event.pull_request).number]) { const number = positive(n); if (number) return number; }
  for (const url of [value.issue_url, value.pull_request_url, event.issue_url, event.pull_request_url]) {
    const match = /\/(?:issues|pulls?)\/(\d+)(?:$|[/?#])/.exec(text(url)); if (match) return positive(Number(match[1]));
  }
  const prs = value.pull_requests;
  return Array.isArray(prs) && prs.length === 1 ? positive(object(prs[0]).number) : undefined;
}
function nativeSubject(input: Obj, stream?: GithubStreamKind): { event: Obj; value: Obj; kind: string } {
  const payload = object(input.payload); const event = Object.keys(payload).length ? { ...input, ...payload, user: input.actor } : input;
  if (event.comment) return { event, value: object(event.comment), kind: stream === "inline" || /review_comment/i.test(text(event.type)) || object(event.comment).path ? "inline" : "comment" };
  if (event.review) return { event, value: object(event.review), kind: "review" };
  if (event.check_run) return { event, value: object(event.check_run), kind: "ci" };
  if (event.status && typeof event.status === "object") return { event, value: object(event.status), kind: "ci" };
  if (event.issue) return { event, value: object(event.issue), kind: object(event.issue).pull_request ? "pull" : "issue" };
  if (event.pull_request && (object(event.pull_request).number || !event.number)) return { event, value: object(event.pull_request), kind: "pull" };
  const kind = stream === "issue" ? (event.pull_request ? "pull" : "issue") : stream === "issue-comment" ? "comment"
    : stream === "inline" ? "inline" : stream === "review" ? "review" : stream === "check-run" || stream === "status" ? "ci"
    : event.number && event.title ? (event.head || event.pull_request ? "pull" : "issue") : event.issue_url ? "comment" : event.pull_request_url ? "inline" : "unknown";
  return { event, value: event, kind };
}
function actorFacts(event: Obj, value: Obj, config: GithubSourceConfig, ci: boolean, source: string) {
  const raw = object(value.user ?? value.author ?? value.sender ?? event.sender ?? event.user ?? event.actor);
  const login = text(raw.login); const lowered = login.toLowerCase(); const type = text(raw.type).toLowerCase();
  const self = (config.selfLogins ?? []).some(x => x.toLowerCase() === lowered);
  const bot = /\[bot\]$/i.test(login) || (type !== "" && type !== "user") || (config.botLogins ?? []).some(x => x.toLowerCase() === lowered);
  return { actor: { source, id: ci ? "" : login }, human: !!login && !ci && !bot && !self, self, bot, ci, actorType: ci ? "ci" : type || "unknown" };
}
function addressed(message: string, config: GithubSourceConfig): boolean {
  return (config.selfLogins ?? []).some(login => [login, login.replace(/\[bot\]$/i, "")].some(name =>
    new RegExp(`(?:^|[^a-z0-9_@])@${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?![a-z0-9_-])`, "i").test(message)));
}
/** Pure adapter for native REST objects and GitHub event envelopes. Platform fields stay in this module. */
export function githubEventToTrigger(input: GithubRawEvent, source: string, instance: string, config: GithubSourceConfig, stream?: GithubStreamKind): Trigger {
  assertRepo(input, config); const { event, value, kind } = nativeSubject(input, stream); assertRepo(event, config); assertObjectUrls(value, config);
  const number = nativeNumber(event, value);
  for (const field of ["issue_url", "pull_request_url", "html_url"]) {
    const match = /\/(?:issues|pulls?)\/(\d+)(?:$|[/?#])/.exec(text(value[field]));
    if (number && match && Number(match[1]) !== number) throw new Error("GitHub 对象 URL 与 Thread 编号不匹配");
  }
  if (kind === "unknown" || (kind !== "ci" && !number)) throw new Error("GitHub 对象缺少类型或 Thread 编号");
  const nativeId = value.id ?? number; if (nativeId === undefined) throw new Error("GitHub 对象缺少稳定身份");
  const ci = kind === "ci"; const a = actorFacts(event, value, config, ci, source);
  const branch = text(value.branch || value.ref || object(value.check_suite).head_branch || event.branch || event.ref).replace(/^refs\/heads\//, "") || "default";
  const id = number ? threadId(source, instance, config.repository, number) : `${prefix(source, instance, config.repository)}:ci:${encode(branch)}`;
  const version = kind === "issue" || kind === "pull" ? "opened" : hash({ body: value.body, updated_at: value.updated_at, submitted_at: value.submitted_at,
    state: value.state, commit_id: value.commit_id, path: value.path, line: value.line, original_line: value.original_line, diff_hunk: value.diff_hunk,
    ...(ci ? { snapshot: value } : {}) });
  const decision = kind === "review" && text(value.state).toUpperCase() !== "COMMENTED" ? `${text(value.state)} review of commit ${text(value.commit_id) || "unknown"}` : "";
  const place = kind === "inline" ? [text(value.path) + (value.line ?? value.original_line ? `:${value.line ?? value.original_line}` : ""), text(value.diff_hunk)].filter(Boolean).join("\n") : "";
  const message = kind === "issue" || kind === "pull" ? [text(value.title), text(value.body)].filter(Boolean).join("\n\n")
    : ci ? [text(value.name || value.context), text(value.conclusion || value.state || value.status)].filter(Boolean).join(": ")
    : [decision, place, text(value.body)].filter(Boolean).join("\n\n");
  const url = text(value.html_url) || (number ? `https://github.com/${repoName(config.repository)}/${kind === "pull" || kind === "inline" || kind === "review" ? "pull" : "issues"}/${number}` : undefined);
  const at = kind === "issue" || kind === "pull" ? text(value.created_at) || stamp(value) : stamp(value) || stamp(event);
  if (time(at) === undefined) throw new Error("GitHub 对象缺少有效时间");
  return { id: `${prefix(source, instance, config.repository)}:${kind === "pull" ? "issue" : kind}:${encode(String(nativeId))}:${version}`, source,
    threads: [{ source, id }], actor: a.actor, human: a.human, ...(addressed(message, config) ? { addressed: "mention" as const } : {}),
    at: new Date(Date.parse(at)).toISOString(), text: message, ...(url ? { url } : {}),
    ...(number && url ? { channel: { source, thread: id, address: { number: String(number), url } } } : {}),
    meta: { instance, repositoryId: String(config.repository.id), repository: repoName(config.repository), number, kind, nativeId, version,
      self: a.self, bot: a.bot, ci, actorType: a.actorType, isPr: ["pull", "review", "inline"].includes(kind),
      ...(kind === "inline" || kind === "review" ? { path: value.path, line: value.line ?? value.original_line, diff_hunk: value.diff_hunk,
        commit_id: value.commit_id, in_reply_to_id: value.in_reply_to_id, state: value.state } : {}), ...(ci ? { branch } : {}) } };
}

type Cache = { etag?: string; body: Obj[]; next?: string };
type CiEntry = { name: string; state: string; url: string; id: string };
type Baseline = { fingerprint: string; revision: number; failures: CiEntry[] };
type NativeObject = { number: number; pr: boolean; at: number };
interface PollState {
  startedAt: number; streams: Record<string, number>; cache: Record<string, Cache>; ci: Record<string, Baseline>;
  objects: Record<string, NativeObject>; closed: Record<string, string>; unavailable: Record<string, string>; bodies: Record<string, true>;
  coverageGaps: { stream: string; from: number; to: number }[]; pollIntervalMs?: number; defaultBranch?: string;
}
interface Round {
  state: PollState; lease: Lease; configRevision: number; stateRevision: number; pages: number; target: string;
  triggers: Trigger[]; closures: { thread: ThreadRef; outcome: "closed" | "merged"; at: string }[];
  bindings: { ticketId: string; thread: ThreadRef }[]; seenUrls: Set<string>;
}
class FenceError extends Error {}
const HORIZON = 14 * 24 * 60 * 60_000;
export class GithubShadowSource {
  readonly source: string; readonly instance: string;
  private readonly options: GithubShadowSourceOptions; private readonly config: GithubSourceConfig;
  private readonly now: () => number; private readonly leaseMs: number; private readonly stateKey: string;
  constructor(options: GithubShadowSourceOptions) {
    if (!options.store) throw new Error("M9 GitHub Source 必须使用 ShadowStore");
    this.options = options; this.source = options.sourceId ?? options.source ?? "github"; this.instance = options.instance;
    if (!this.instance || this.instance.length > 128) throw new Error("GitHub instance 身份无效");
    this.config = validateConfig(options.config ?? options.registry.instance(this.source)?.config);
    this.now = options.now ?? Date.now; this.leaseMs = options.leaseMs ?? 30_000;
    if (!Number.isSafeInteger(this.leaseMs) || this.leaseMs <= 0 || (options.since !== undefined && time(options.since) === undefined)) throw new Error("GitHub 读取参数无效");
    this.stateKey = `github:m9:${encode(this.config.repository.id)}`;
  }
  private root(): string { return `/repos/${repoName(this.config.repository)}`; }
  private installed(): ShadowSourceInstance {
    const current = this.options.registry.instance(this.source);
    if (!current?.enabled || current.status !== "enabled" || !this.options.registry.scope({ source: this.source, meta: {} }).listened) throw new FenceError("GitHub Source 已禁用、撤权或未安装");
    if (canonical(validateConfig(current.config)) !== canonical(this.config)) throw new FenceError("GitHub Source 配置与 reader 身份不匹配");
    return current;
  }
  private fence(round: Round): void {
    if (this.installed().revision !== round.configRevision) throw new FenceError("GitHub Source 配置 revision 已变化");
    if (!this.options.registry.renewPoll(round.lease, this.leaseMs, this.now())) throw new FenceError("GitHub poll lease 已失效");
  }
  private safePath(path: string): string {
    const url = new URL(path, "https://api.github.com");
    if (url.origin !== "https://api.github.com" || url.username || url.password || url.hash || !(url.pathname === "/notifications"
      || url.pathname === this.root() || url.pathname.startsWith(`${this.root()}/`))) throw new Error("GitHub reader 路径超出配置仓库");
    return `${url.pathname}${url.search}`;
  }
  private async read(round: Round, path: string): Promise<Cache> {
    this.fence(round); const requestPath = this.safePath(path); round.target = requestPath; round.seenUrls.add(requestPath);
    const cache = round.state.cache[requestPath];
    const request: GithubRequest = { path: requestPath, headers: { accept: "application/vnd.github+json", ...(cache?.etag ? { "if-none-match": cache.etag } : {}) } };
    const response = await this.options.reader.read(request); this.fence(round); round.pages++;
    const result = adaptGithubResponse(response, cache?.etag); delete round.state.unavailable[requestPath];
    const poll = Number(header(response.headers, "x-poll-interval")); if (Number.isFinite(poll) && poll > 0) round.state.pollIntervalMs = Math.max(60_000, poll * 1000);
    if (result.status === "not-modified") {
      if (!cache?.etag || request.headers["if-none-match"] !== cache.etag) throw new Error("GitHub 304 缺少同 URL 的已提交缓存");
      return clone(cache);
    }
    const next = result.next ? this.safePath(result.next) : undefined;
    const nextCache: Cache = { body: clone([...result.body]), ...(result.etag ? { etag: result.etag } : {}), ...(next ? { next } : {}) };
    round.state.cache[requestPath] = nextCache; round.seenUrls.add(requestPath); return nextCache;
  }
  private async pages(round: Round, path: string): Promise<Obj[]> {
    const values: Obj[] = []; const visited = new Set<string>(); let current: string | undefined = path;
    while (current) {
      const normalized = this.safePath(current); if (visited.has(normalized) || visited.size >= 1000) throw new Error("GitHub 分页循环或超出读取上限");
      visited.add(normalized);
      try { const result = await this.read(round, normalized); values.push(...result.body); current = result.next; }
      catch (error) {
        if (!(error instanceof GithubHttpError && error.status === 410)) throw error;
        round.state.unavailable[normalized] = new Date(this.now()).toISOString(); break;
      }
    }
    return values;
  }
  private async one(round: Round, path: string): Promise<Obj | undefined> {
    try { const result = await this.read(round, path); if (result.body.length !== 1 || result.next) throw new Error("GitHub 对象响应形状错误"); return result.body[0]!; }
    catch (error) {
      if (!(error instanceof GithubHttpError && error.status === 410)) throw error;
      round.state.unavailable[this.safePath(path)] = new Date(this.now()).toISOString(); return undefined;
    }
  }
  private since(round: Round, stream: string): number {
    const initial = round.state.streams[stream] ?? round.state.startedAt;
    const floor = this.now() - (this.options.horizonMs ?? HORIZON);
    if (initial < floor && !round.state.coverageGaps.some(g => g.stream === stream && g.to >= floor)) round.state.coverageGaps.push({ stream, from: initial, to: floor });
    return Math.max(initial - 5000, floor);
  }
  private async stream(round: Round, target: GithubPollTarget): Promise<Obj[]> {
    const since = target.since ? this.since(round, target.id) : undefined;
    const path = `${target.path}${target.path.includes("?") ? "&" : "?"}per_page=100${since === undefined ? "" : `&since=${encode(new Date(since).toISOString())}`}`;
    const values = await this.pages(round, path); let latest = round.state.streams[target.id] ?? round.state.startedAt;
    for (const item of values) latest = Math.max(latest, time(stamp(item)) ?? 0);
    if (target.since) round.state.streams[target.id] = latest;
    return values;
  }
  private add(round: Round, native: Obj, stream: GithubStreamKind, number?: number): void {
    const input = number ? { ...native, number } : native;
    const trigger = githubEventToTrigger(input, this.source, this.instance, this.config, stream);
    if (trigger.meta.self || !trigger.text.trim()) return;
    if (Date.parse(trigger.at) < Math.max(round.state.startedAt, this.now() - (this.options.horizonMs ?? HORIZON))) return;
    round.triggers.push(trigger);
  }
  private remember(round: Round, number: number, pr: boolean, at?: string): void {
    const old = round.state.objects[number]; round.state.objects[number] = { number, pr: pr || old?.pr === true, at: Math.max(old?.at ?? 0, time(at) ?? this.now()) };
  }
  private async collect(round: Round): Promise<void> {
    const targets = this.options.targets ?? [
      { id: "notifications", path: "/notifications?all=true", kind: "notifications" as const, since: true },
      { id: "issues", path: `${this.root()}/issues?state=all&sort=updated&direction=asc`, kind: "issue" as const, since: true },
      { id: "comments", path: `${this.root()}/issues/comments?sort=updated&direction=asc`, kind: "issue-comment" as const, since: true },
      { id: "inline", path: `${this.root()}/pulls/comments?sort=updated&direction=asc`, kind: "inline" as const, since: true },
    ];
    for (const target of targets) {
      const values = await this.stream(round, target);
      for (const native of values) {
        if (target.kind === "notifications") {
          const repository = object(native.repository);
          if (String(repository.id) !== String(this.config.repository.id)) continue;
          const subject = object(native.subject); if (!["Issue", "PullRequest"].includes(text(subject.type))) continue;
          const path = this.safePath(text(subject.url)); const match = /\/(issues|pulls)\/(\d+)$/.exec(path);
          if (!match) throw new Error("GitHub notification subject 无效");
          this.remember(round, Number(match[2]), match[1] === "pulls", stamp(native));
        } else if (target.kind === "issue") {
          assertRepo(native, this.config); const number = positive(native.number); if (!number) throw new Error("GitHub Issue 缺少编号");
          const pr = !!native.pull_request || !!native.head; this.remember(round, number, pr, stamp(native));
          if (!pr && !round.state.bodies[number] && text(native.state) !== "closed" && (time(native.created_at) ?? 0) >= round.state.startedAt) this.add(round, native, "issue");
        } else if (target.kind === "issue-comment" || target.kind === "inline") {
          const number = nativeNumber(native, native); if (!number) throw new Error("GitHub comment 缺少 Thread 编号");
          this.remember(round, number, target.kind === "inline", stamp(native)); this.add(round, native, target.kind, number);
        } else this.add(round, native, target.kind);
      }
    }
    const threadPrefix = `${prefix(this.source, this.instance, this.config.repository)}:thread:`;
    for (const thread of this.options.store.threads.list()) {
      if (!thread.ref.id.startsWith(threadPrefix) || thread.ref.source !== this.source || !thread.subscriptions.length) continue;
      const number = positive(Number(thread.ref.id.slice(threadPrefix.length)));
      const tickets = thread.subscriptions.map(id => this.options.store.tickets.get(id)).filter(ticket => ticket !== undefined);
      const active = tickets.some(ticket => !ticket.ended);
      const last = Math.max(time(thread.lastAt) ?? 0, ...tickets.map(ticket => time(ticket.ended?.at) ?? 0));
      if (number) this.remember(round, number, false, new Date(active ? this.now() : last).toISOString());
    }
    for (const number of this.options.threads ?? []) { if (!positive(number)) throw new Error("GitHub 订阅编号无效"); this.remember(round, number, false); }
    for (const item of Object.values(round.state.objects).sort((a, b) => a.number - b.number)) {
      if (item.at < this.now() - (this.options.horizonMs ?? HORIZON)) continue;
      await this.readObject(round, item);
    }
    if (this.options.targets === undefined || this.options.branches?.length) {
      let branches = this.options.branches;
      if (!branches) {
        const repo = await this.one(round, this.root());
        if (repo) {
          assertRepo({ repository: repo }, this.config); const name = text(repo.default_branch);
          if (name !== round.state.defaultBranch) { delete round.state.ci[`branch:${name}`]; round.state.defaultBranch = name; }
          branches = name ? [name] : [];
        }
      }
      for (const name of branches ?? []) {
        const branch = await this.one(round, `${this.root()}/branches/${encode(name)}`); const sha = text(object(branch?.commit).sha);
        if (sha) await this.readCi(round, sha, undefined, name);
      }
    }
  }
  private async readObject(round: Round, item: NativeObject): Promise<void> {
    const path = `${this.root()}/${item.pr ? "pulls" : "issues"}/${item.number}`;
    let value = await this.one(round, path); if (!value) return;
    assertRepo(value, this.config);
    if (!item.pr && value.pull_request) { item.pr = true; value = await this.one(round, `${this.root()}/pulls/${item.number}`); if (!value) return; }
    if (positive(value.number) !== item.number) throw new Error("GitHub 对象编号不匹配");
    const firstBody = !round.state.bodies[item.number]; round.state.bodies[item.number] = true;
    if (item.pr) {
      const merged = value.merged === true || !!value.merged_at; const closed = text(value.state) === "closed" || merged;
      const ref = { source: this.source, id: threadId(this.source, this.instance, this.config.repository, item.number) };
      if (closed) {
        const at = text(value.merged_at || value.closed_at || value.updated_at); if (time(at) === undefined) throw new Error("GitHub PR 关闭时间无效");
        const observation = canonical({ outcome: merged ? "merged" : "closed", at });
        const followedKey = `${this.source}:${ref.id}`;
        const needsClose = this.options.store.tickets.open().some(ticket => ticket.follows?.some(follow => follow.thread === followedKey && !follow.closed));
        if (round.state.closed[item.number] !== observation || needsClose) { round.closures.push({ thread: ref, outcome: merged ? "merged" : "closed", at }); round.state.closed[item.number] = observation; }
      } else {
        delete round.state.closed[item.number];
        if (firstBody && (time(value.created_at) ?? 0) >= round.state.startedAt) this.add(round, value, "issue");
        const bindings = (this.options.bindings ?? []).filter(binding => String(binding.repositoryId) === String(this.config.repository.id)
          && binding.branch === text(object(value.head).ref) && (this.config.selfLogins ?? []).includes(text(object(value.user).login).toLowerCase())
          && this.options.store.tickets.get(binding.ticketId)?.ended === undefined && !!this.options.store.tickets.get(binding.ticketId));
        if (bindings.length > 1) throw new Error("GitHub PR 分支匹配多个开放 Ticket");
        if (bindings[0]) {
          if (this.options.store.tickets.open().some(ticket => ticket.id !== bindings[0]!.ticketId && ticket.follows?.some(follow => follow.thread === `${this.source}:${ref.id}` && follow.own && !follow.closed))) throw new Error("GitHub PR 已属于另一个开放 Ticket");
          round.bindings.push({ ticketId: bindings[0].ticketId, thread: ref });
        }
      }
      for (const review of await this.pages(round, `${this.root()}/pulls/${item.number}/reviews?per_page=100`)) this.add(round, review, "review", item.number);
      for (const comment of await this.pages(round, `${this.root()}/pulls/${item.number}/comments?per_page=100`)) this.add(round, comment, "inline", item.number);
      const sha = text(object(value.head).sha); if (sha) await this.readCi(round, sha, item.number);
    } else if (firstBody && text(value.state) !== "closed" && (time(value.created_at) ?? 0) >= round.state.startedAt) this.add(round, value, "issue");
    for (const comment of await this.pages(round, `${this.root()}/issues/${item.number}/comments?per_page=100`)) this.add(round, comment, "issue-comment", item.number);
  }
  private async readCi(round: Round, sha: string, number?: number, branch?: string): Promise<void> {
    const checks = await this.pages(round, `${this.root()}/commits/${encode(sha)}/check-runs?per_page=100`);
    const statuses = await this.pages(round, `${this.root()}/commits/${encode(sha)}/statuses?per_page=100`);
    const latest = new Map<string, { at: number; entry: CiEntry }>();
    for (const [kind, values] of [["check", checks], ["status", statuses]] as const) for (const value of values) {
      const name = kind === "check" ? `${text(object(value.app).slug)}:${text(value.name)}` : text(value.context);
      const key = `${kind}:${name}`; const at = time(stamp(value)) ?? 0;
      const state = kind === "check" ? text(value.status) === "completed" ? text(value.conclusion) : "pending" : text(value.state);
      const entry = { name: key, state, url: text(value.html_url || value.target_url), id: String(value.id ?? "") };
      const previous = latest.get(key); if (!previous || at > previous.at || (at === previous.at && entry.id.localeCompare(previous.entry.id, undefined, { numeric: true }) > 0)) latest.set(key, { at, entry });
    }
    const entries = [...latest.values()].map(v => v.entry).sort((a, b) => a.name.localeCompare(b.name));
    const key = number ? `pr:${number}` : `branch:${branch}`; const previous = round.state.ci[key];
    let failures = entries.filter(e => ["failure", "error", "timed_out", "cancelled", "action_required", "startup_failure"].includes(e.state));
    const pending = entries.some(e => ["pending", "queued", "in_progress", "waiting", "requested"].includes(e.state));
    if (!number && pending && previous) {
      const names = new Set(failures.map(f => f.name)); failures = [...failures, ...previous.failures.filter(f => !names.has(f.name))].sort((a, b) => a.name.localeCompare(b.name));
    }
    const fingerprint = number ? hash({ sha, entries }) : hash(failures.map(({ name, state }) => ({ name, state })));
    const changed = previous !== undefined && previous.fingerprint !== fingerprint;
    const revision = (previous?.revision ?? 0) + (changed ? 1 : 0);
    round.state.ci[key] = { fingerprint, revision, failures };
    if (!changed) return;
    const id = number ? threadId(this.source, this.instance, this.config.repository, number) : `${prefix(this.source, this.instance, this.config.repository)}:ci:${encode(branch ?? "default")}`;
    const summary = `CI ${number ? `PR #${number}` : `branch ${branch}`} at ${sha}\n${entries.map(e => `${e.name}: ${e.state}`).join("\n")}${!number && pending && failures.length ? "\nPrevious failures retained while checks are pending." : ""}`;
    const url = number ? `https://github.com/${repoName(this.config.repository)}/pull/${number}` : `https://github.com/${repoName(this.config.repository)}/commits/${encode(branch ?? "default")}`;
    round.triggers.push({ id: `${prefix(this.source, this.instance, this.config.repository)}:ci:${encode(key)}:${revision}:${fingerprint}`, source: this.source,
      threads: [{ source: this.source, id }], actor: { source: this.source, id: "" }, human: false, at: new Date(this.now()).toISOString(), text: summary, url,
      ...(number ? { channel: { source: this.source, thread: id, address: { number: String(number), url } } } : {}),
      meta: { ci: true, kind: "ci", instance: this.instance, repositoryId: String(this.config.repository.id), number, branch, sha, revision, fingerprint, checks: entries, failures } });
  }
  private executionSnapshot(): string {
    const store = this.options.store;
    const kinds = this.options.intake === "durable" ? "'reply','assessment'" : "'launch','delivery','reply','assessment'";
    return canonical([store.db.all(`SELECT * FROM dsh_effects WHERE kind IN (${kinds}) ORDER BY seq`),
      store.db.all("SELECT * FROM dsh_session_receipts ORDER BY session_key,request_id")]);
  }
  async poll(): Promise<GithubPollResult> {
    let lease: Lease | undefined; let round: Round | undefined;
    const rejected = (error: unknown): GithubPollResult => ({ status: "rejected", pages: round?.pages ?? 0, events: 0, failedTargets: [], error: error instanceof Error ? error.message : String(error) });
    try {
      const installed = this.installed();
      const retry = this.options.store.get<{ at: number }>(`${this.stateKey}:retry:${this.source}:${this.instance}`);
      if (retry && retry.at > this.now()) return { status: "transient-failure", pages: 0, events: 0, failedTargets: [], error: `GitHub rate limit until ${new Date(retry.at).toISOString()}` };
      lease = this.options.registry.acquirePoll(this.source, this.instance, randomUUID(), this.leaseMs, this.now());
      if (!lease) return rejected(new FenceError("GitHub poll lease 已被占用"));
      const saved = this.options.store.cursors.get<PollState>(this.source, this.instance, this.stateKey);
      const start = this.options.since === undefined ? this.now() : Date.parse(this.options.since);
      const state: PollState = saved ? clone(saved.value) : { startedAt: start, streams: {}, cache: {}, ci: {}, objects: {}, closed: {}, unavailable: {}, bodies: {}, coverageGaps: [] };
      if (saved && this.options.since !== undefined && saved.value.startedAt !== start) throw new FenceError("GitHub replay 起点不能漂移");
      round = { state, lease, configRevision: installed.revision, stateRevision: saved?.revision ?? 0, pages: 0, target: "", triggers: [], closures: [], bindings: [], seenUrls: new Set() };
      await this.collect(round); this.fence(round);
      const currentRound = round;
      const results = this.options.store.atomic(() => {
        this.fence(currentRound); const before = this.executionSnapshot(); const ticketCount = this.options.store.tickets.list().length;
        for (const binding of currentRound.bindings) this.options.engine.sources.bindThread(binding.ticketId, binding.thread, true);
        const result = [...new Map(currentRound.triggers.map(trigger => [trigger.id, trigger])).values()].sort((a, b) => a.at.localeCompare(b.at) || a.id.localeCompare(b.id)).map(trigger => {
          const received = this.options.engine.sources.receive(clone(trigger));
          if (!this.options.store.triggers.get(trigger.id) || !this.options.store.triggers.disposition(trigger.id)) throw new Error("M9 接收端未在同一个 ShadowStore 持久化 Trigger");
          return received;
        });
        for (const close of currentRound.closures) this.options.engine.sources.threadClosed(close.thread, close.outcome, close.at);
        this.fence(currentRound);
        if (before !== this.executionSnapshot() || ticketCount !== this.options.store.tickets.list().length) throw new Error("M9 Shadow 接收不能创建执行、模型或回复意图");
        // Only the current request URLs remain useful; older since-query cache cannot grow forever.
        for (const path of Object.keys(currentRound.state.cache)) if (!currentRound.seenUrls.has(path)) delete currentRound.state.cache[path];
        if (!this.options.store.cursors.save(this.source, this.instance, this.stateKey, currentRound.state, currentRound.stateRevision)) throw new FenceError("GitHub cursor revision CAS 冲突");
        this.fence(currentRound);
        this.options.registry.setHealth(this.source, currentRound.state.coverageGaps.length || Object.keys(currentRound.state.unavailable).length ? "degraded" : "healthy",
          currentRound.state.coverageGaps.length ? "GitHub history coverage gap" : Object.keys(currentRound.state.unavailable).length ? "GitHub object unavailable (410)" : "GitHub shadow replay ok");
        return result;
      });
      return { status: "completed", pages: round.pages, events: results.filter(result => result === "stored").length, failedTargets: [] };
    } catch (error) {
      if (error instanceof FenceError) return rejected(error);
      if (round && lease) {
        try {
          this.fence(round); const mapped = githubHealthForError(error);
          this.options.store.atomic(() => {
            this.fence(round!); this.options.registry.setHealth(this.source, mapped.health, mapped.detail);
            if (error instanceof GithubHttpError && rateLimited(error)) {
              const retryAfter = header(error.headers, "retry-after"); const seconds = Number(retryAfter);
              const reset = Number(header(error.headers, "x-ratelimit-reset"));
              const until = retryAfter ? Number.isFinite(seconds) ? this.now() + Math.max(0, seconds) * 1000 : time(retryAfter)
                : reset > 0 ? reset * 1000 : this.now() + 60_000;
              this.options.store.set(`${this.stateKey}:retry:${this.source}:${this.instance}`, { at: Math.max(this.now(), until ?? this.now() + 60_000) });
            }
            if (mapped.status === "revoked") this.options.registry.setStatus(this.source, "revoked", round!.configRevision);
          });
        } catch { /* A changed configuration/lease owns its health; late readers cannot overwrite it. */ }
      }
      return { status: "transient-failure", pages: round?.pages ?? 0, events: 0, failedTargets: round ? [round.target] : [], error: error instanceof Error ? error.message : String(error) };
    } finally { if (lease) this.options.registry.releasePoll(lease, this.now()); }
  }
}

export function registerGithubShadowSource(registry: ShadowSourceRegistry, sourceId = "github"): () => void {
  return registry.register({ kind: sourceId, validate: input => Object.keys(object(input)).length ? validateConfig(input) as unknown as Obj : {}, scope: () => ({ listened: true, observed: false }) });
}
