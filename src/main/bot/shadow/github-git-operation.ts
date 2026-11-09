// SPDX-License-Identifier: MIT
// Host-only managed Git delivery. Uses the existing source-operation Effect lifecycle.
import { createHash } from "node:crypto";
import type { GithubAuthorization as GitAuthority } from "./github-operation.ts";
import type { ManagedGitRepository, GitCommitInput, GitCommitSnapshot } from "./git-repository.ts";
import type { OperationAdapter, OperationContext } from "./operations.ts";
import type { Operation, ShadowStore } from "./store.ts";

export interface GithubGitRequest {
  kind: "commit" | "push";
  authorization: GitAuthority;
  snapshot: GitCommitSnapshot;
  directoryRevision: number;
  /** null means a new remote branch. Never infer it from a missing/unreadable response. */
  expectedRemoteSha?: string | null;
}
export interface GithubGitPayload extends GithubGitRequest {
  mode: "managed-git";
  schemaVersion: 1;
  targetId: string;
}
export interface GithubGitOptions {
  store: ShadowStore;
  repository: ManagedGitRepository;
  source: string;
  instance: string;
  repositoryId: string;
  /** Current ready execution-directory revision, resolved by the trusted host. */
  directoryRevision: () => number | undefined;
  authorize: (operation: Operation) => void;
  now?: () => number;
}
const stable = (value: unknown): string => JSON.stringify(value, (_key, item) => item && typeof item === "object" && !Array.isArray(item)
  ? Object.fromEntries(Object.entries(item).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)) : item);
const digest = (value: unknown): string => createHash("sha256").update(stable(value)).digest("hex");
const validSha = (value: unknown): value is string => typeof value === "string" && /^[0-9a-f]{40}$/.test(value);
const attemptKey = (op: Operation): string => `github:git:attempt:${JSON.stringify([op.id, op.revision])}`;

export function isGithubGitOperation(operation: Operation): boolean {
  return (operation.payload as { mode?: unknown } | undefined)?.mode === "managed-git";
}

/** The host alone supplies the repository, credentials, directory revision and authorization. */
export class GithubGitOperations implements OperationAdapter {
  private readonly options: GithubGitOptions;
  private readonly now: () => number;
  constructor(options: GithubGitOptions) {
    this.options = { ...options };
    this.now = options.now ?? Date.now;
  }
  prepareCommit(input: GitCommitInput, authorization: GitAuthority, directoryRevision: number, signal?: AbortSignal): Promise<GitCommitSnapshot> {
    // Preparation writes unreachable Git objects only; branch/ref writes still require an Effect.
    const operation: Operation = { id: "git:prepare", key: "git:prepare", source: this.options.source, instance: this.options.instance,
      status: "planned", revision: 1, payload: { kind: "commit", authorization } };
    const validate = () => {
      if (!Number.isSafeInteger(directoryRevision) || directoryRevision <= 0 || this.options.directoryRevision() !== directoryRevision
        || authorization.source !== operation.source || authorization.instance !== operation.instance || authorization.repositoryId !== this.options.repositoryId) throw new Error("受管 Git 准备目录或来源已失效");
      this.options.authorize(operation);
    };
    validate();
    return this.options.repository.prepareCommit(input, { signal, validate });
  }
  private check(request: GithubGitRequest): void {
    const auth = request.authorization, snapshot = request.snapshot;
    if (!auth || auth.source !== this.options.source || auth.instance !== this.options.instance || auth.repositoryId !== this.options.repositoryId
      || !auth.allowed.includes(request.kind) || !["commit", "push"].includes(request.kind)) throw new Error("受管 Git 授权或仓库不匹配");
    if (!Number.isSafeInteger(request.directoryRevision) || request.directoryRevision <= 0
      || !snapshot || !validSha(snapshot.sha) || !validSha(snapshot.tree) || !validSha(snapshot.parentSha)
      || snapshot.ref !== this.options.repository.ref || !snapshot.ref.startsWith("refs/heads/")) throw new Error("受管 Git 快照无效");
    if (request.kind === "push" && request.expectedRemoteSha !== null && !validSha(request.expectedRemoteSha)) throw new Error("push 必须固定远端旧 SHA 或显式新分支");
    if (request.kind === "commit" && request.expectedRemoteSha !== undefined) throw new Error("commit 不能携带远端参数");
    // Only the fixed snapshot schema is stored: never persist arbitrary request fields/credentials.
    if (Object.keys(request).some(key => !["kind", "authorization", "snapshot", "directoryRevision"].includes(key) && !(request.kind === "push" && key === "expectedRemoteSha"))) throw new Error("受管 Git 请求包含未知字段");
    if (Object.keys(snapshot).sort().join() !== ["sha", "tree", "parentSha", "ref", "message", "author", "timestamp"].sort().join()
      || !snapshot.author || Object.keys(snapshot.author).sort().join() !== "email,name"
      || typeof snapshot.author.name !== "string" || typeof snapshot.author.email !== "string" || typeof snapshot.message !== "string" || typeof snapshot.timestamp !== "string") throw new Error("受管 Git 快照 schema 不匹配");
  }
  buildIntent(request: GithubGitRequest): Omit<Operation, "status" | "revision"> {
    this.check(request);
    const targetId = digest([this.options.repository.directory, this.options.repository.ref, this.options.repository.remote]);
    const payload: GithubGitPayload = { ...structuredClone(request), mode: "managed-git", schemaVersion: 1, targetId };
    // Different immutable snapshots and assignments must never share an operation identity.
    const key = `github-git:${request.kind}:${digest(payload)}`;
    return { id: key, key, source: this.options.source, instance: this.options.instance, payload };
  }
  private payload(operation: Operation): GithubGitPayload {
    const payload = operation.payload as GithubGitPayload;
    if (!payload || payload.mode !== "managed-git" || payload.schemaVersion !== 1) throw new Error("受管 Git 协议不匹配");
    const { mode: _mode, schemaVersion: _version, targetId: _target, ...request } = payload;
    const intent = this.buildIntent(request);
    if (operation.id !== intent.id || operation.key !== intent.key || operation.source !== intent.source || operation.instance !== intent.instance
      || stable(payload) !== stable(intent.payload)) throw new Error("受管 Git 持久意图漂移");
    return payload;
  }
  private currentDirectory(payload: GithubGitPayload): void {
    if (this.options.directoryRevision() !== payload.directoryRevision) throw new Error("受管 Git 执行目录版本已失效");
  }
  private local(operation: Operation, context: OperationContext): void {
    const { store } = this.options;
    const payload = this.payload(operation), current = store.operations.get(operation.source, operation.instance, operation.key);
    const effect = store.effects.get(context.claim.kind, context.claim.key);
    if (context.signal.aborted || !current || current.id !== operation.id || current.status !== "uncertain" || current.revision !== operation.revision
      || stable(current.payload) !== stable(operation.payload) || (current as Operation & { cancelRequested?: boolean }).cancelRequested
      || context.claim.key !== JSON.stringify([operation.source, operation.instance, operation.key])
      || !effect || effect.status !== "running" || effect.seq !== context.claim.seq || effect.generation !== context.claim.generation
      || effect.claimedGeneration !== context.claim.generation || effect.claimToken !== context.claim.claimToken
      || effect.leaseOwner !== context.claim.leaseOwner || (effect.leaseUntil ?? 0) <= this.now()) throw new Error("受管 Git owner 已失效");
    this.currentDirectory(payload);
    this.options.authorize(operation);
  }
  private committed(payload: GithubGitPayload): void {
    const { mode: _mode, schemaVersion: _version, targetId: _target, expectedRemoteSha: _remote, ...request } = payload;
    const intent = this.buildIntent({ ...request, kind: "commit" });
    const commit = this.options.store.operations.get(intent.source, intent.instance, intent.key);
    if (!commit || commit.status !== "confirmed" || stable(commit.payload) !== stable(intent.payload)) throw new Error("push 需要同 binding 下已确认的 commit");
  }
  private receipt(payload: GithubGitPayload): unknown {
    return { provider: "managed-git", repositoryId: this.options.repositoryId, kind: payload.kind, ref: payload.snapshot.ref,
      sha: payload.snapshot.sha, tree: payload.snapshot.tree, parentSha: payload.snapshot.parentSha,
      directoryRevision: payload.directoryRevision, ...(payload.kind === "push" ? { expectedRemoteSha: payload.expectedRemoteSha } : {}) };
  }
  async execute(operation: Operation, context: OperationContext): Promise<{ status: "confirmed" | "failed"; receipt?: unknown }> {
    let issued = false;
    try {
      const payload = this.payload(operation);
      this.local(operation, context);
      if (payload.kind === "push") this.committed(payload);
      // Durable checkpoint precedes the subprocess/credential await. It does not claim a write happened.
      this.options.store.atomic(() => {
        this.local(operation, context);
        if (this.options.store.get(attemptKey(operation))) throw new Error("受管 Git attempt 已存在");
        this.options.store.set(attemptKey(operation), { id: operation.id, revision: operation.revision, digest: digest(payload), at: this.now() });
      });
      issued = true;
      const options = { signal: context.signal, validate: () => this.local(operation, context) };
      if (payload.kind === "commit") await this.options.repository.commitExact(payload.snapshot, options);
      else {
        if (!await this.options.repository.inspectCommit(payload.snapshot, options)) throw new Error("本地提交与快照不一致");
        await this.options.repository.pushExact({ sha: payload.snapshot.sha, expectedRemoteSha: payload.expectedRemoteSha! }, options);
        if (await this.options.repository.remoteRef({ signal: context.signal }) !== payload.snapshot.sha) throw new Error("push 后远端 ref 未确认");
      }
      return { status: "confirmed", receipt: this.receipt(payload) };
    } catch {
      if (!issued) return { status: "failed", receipt: { provider: "managed-git", reason: "host-preflight-refused", writeIssued: false } };
      // No raw subprocess output, URL, credential or host path enters Effects/transcripts.
      throw new Error("受管 Git 操作结果未确认，必须只读对账");
    }
  }
  async inspect(operation: Operation, context: OperationContext): Promise<{ status: "confirmed" | "unknown"; receipt?: unknown }> {
    try {
      const payload = this.payload(operation);
      const attempt = this.options.store.get<{ id: string; revision: number; digest: string }>(attemptKey(operation));
      if (!attempt || attempt.id !== operation.id || attempt.revision !== operation.revision || attempt.digest !== digest(payload)) return { status: "unknown" };
      // Reads remain available after Stop; directory replacement must not confirm a different repository.
      this.currentDirectory(payload);
      const options = { signal: context.signal, validate: () => this.currentDirectory(payload) };
      const matched = payload.kind === "commit" ? await this.options.repository.inspectCommit(payload.snapshot, options)
        : await this.options.repository.remoteRef({ signal: context.signal }) === payload.snapshot.sha;
      return matched ? { status: "confirmed", receipt: this.receipt(payload) } : { status: "unknown" };
    } catch { return { status: "unknown" }; }
  }
}
