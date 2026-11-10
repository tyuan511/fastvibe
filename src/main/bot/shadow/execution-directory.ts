// SPDX-License-Identifier: MIT
// M6 execution directory boundary; no production host or external source is registered here.
import { createHash, randomUUID } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, readdirSync, realpathSync, rmSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { assertShadowPath } from "./schema.ts";
import type { ShadowStore } from "./store.ts";

export type DirectoryState = "preparing" | "ready" | "failed" | "uncertain";
export interface DirectoryRecord {
  ticketId: string; root: string; base: string; cwd: string; sessionDir: string; agentDir: string; sessionFile: string;
  recipeId?: string; state: DirectoryState; revision: number; attemptId?: string; leaseOwner?: string; leaseUntil?: number; leaseGeneration?: number;
  metadata?: Record<string, unknown>; error?: string;
}
export interface PrepareContext { cwd: string; base: string; ticketId: string; signal: AbortSignal; attemptId: string }
export interface PrepareRecipe { id: string; run(context: PrepareContext): Promise<Record<string, unknown> | void> }
export interface PrepareOptions { recipe?: PrepareRecipe; signal?: AbortSignal }
export interface ExecutionDirectoryOptions { now?: () => number; owner?: string; leaseMs?: number; prepareTimeoutMs?: number; allowedRoot?: string }
export interface ExecutionPaths { root: string; base: string; cwd: string; sessionDir: string; agentDir: string; sessionFile: string }
const key = (ticketId: string): string => `shadow:directory:${ticketId}`;
const leaseKey = (ticketId: string): string => `shadow:directory:${ticketId}`;
const digest = (value: string): string => createHash("sha256").update(value).digest("hex");
const copy = <T>(value: T): T => structuredClone(value);
function noSymlink(path: string): void {
  try { if (lstatSync(path).isSymbolicLink()) throw new Error("Execution directory must not contain symbolic links"); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
}
function paths(root: string, ticketId: string): ExecutionPaths {
  const base = join(root, digest(`worker-${ticketId}`));
  return { root, base, cwd: join(base, "workspace"), sessionDir: join(base, "sessions"), agentDir: join(base, "agent"), sessionFile: join(base, "sessions", `${digest(`worker-${ticketId}`)}.jsonl`) };
}
function empty(path: string): boolean { return existsSync(path) && readdirSync(path).length === 0; }

export function assertExecutionPath(path: string, allowedRoot?: string, store?: ShadowStore): void {
  if (allowedRoot && (!store || store.db.get<{ value: string }>("SELECT value FROM vivi_shadow_meta WHERE key='purpose'")?.value !== "vivi-production")) throw new Error("Explicit execution root requires production store purpose");
  assertShadowPath(path, { allowedRoot });
  const boundary = realpathSync(allowedRoot ?? tmpdir());
  let current = resolve(path);
  for (;;) {
    noSymlink(current);
    if (existsSync(current) && realpathSync(current) === boundary) break;
    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
  }
}
export function executionPaths(rootInput: string, ticketId: string): ExecutionPaths {
  if (!ticketId.trim()) throw new Error("ticketId 不能为空");
  const root = realpathSync(resolve(rootInput));
  assertShadowPath(root); noSymlink(root);
  return paths(root, ticketId);
}

export class ExecutionDirectories {
  private readonly store: ShadowStore; private readonly root: string; private readonly allowedRoot?: string; private readonly now: () => number;
  private readonly owner: string; private readonly leaseMs: number; private readonly timeoutMs: number;
  constructor(store: ShadowStore, rootInput: string, options: ExecutionDirectoryOptions = {}) {
    assertExecutionPath(rootInput, options.allowedRoot, store);
    this.store = store; this.root = realpathSync(resolve(rootInput)); this.allowedRoot = options.allowedRoot; this.now = options.now ?? Date.now;
    this.owner = options.owner ?? randomUUID(); this.leaseMs = options.leaseMs ?? 11 * 60_000; this.timeoutMs = options.prepareTimeoutMs ?? 10 * 60_000;
    assertShadowPath(this.root, { allowedRoot: options.allowedRoot }); noSymlink(this.root); mkdirSync(this.root, { recursive: true, mode: 0o700 });
    if (!Number.isSafeInteger(this.leaseMs) || !Number.isSafeInteger(this.timeoutMs) || this.leaseMs <= 0 || this.timeoutMs <= 0) throw new Error("Invalid directory lease");
  }
  get(ticketId: string): DirectoryRecord | undefined { return this.store.get<DirectoryRecord>(key(ticketId)); }
  private ensurePaths(ticketId: string): ExecutionPaths {
    const value = paths(this.root, ticketId);
    for (const path of Object.values(value)) assertExecutionPath(path, this.allowedRoot, this.store);
    return value;
  }
  private normalize(record: DirectoryRecord | undefined): DirectoryRecord | undefined {
    if (!record) return undefined;
    if (record.state === "preparing" && (record.leaseUntil ?? 0) <= this.now()) {
      const uncertain = { ...record, state: "uncertain" as const, revision: record.revision + 1, error: "prepare lease expired" };
      this.store.atomic(() => this.store.set(key(record.ticketId), uncertain));
      return uncertain;
    }
    return record;
  }
  async prepare(ticketId: string, options: PrepareOptions = {}): Promise<DirectoryRecord> {
    const recipe = options.recipe; const value = this.normalize(this.get(ticketId));
    const expected = this.ensurePaths(ticketId);
    if (value && Object.entries(expected).some(([key, path]) => value[key as keyof ExecutionPaths] !== path)) throw new Error("Execution directory identity changed");
    if (value?.state === "ready") { if (recipe && value.recipeId !== recipe.id) throw new Error("Directory prepare recipe is immutable"); return copy(value); }
    if (value?.state === "uncertain") throw new Error("Directory prepare needs explicit reconciliation");
    if (value?.state === "failed" && !empty(value.cwd)) throw new Error("Failed non-empty directory requires explicit reconciliation");
    const p = value ? { root: value.root, base: value.base, cwd: value.cwd, sessionDir: value.sessionDir, agentDir: value.agentDir, sessionFile: value.sessionFile } : this.ensurePaths(ticketId);
    if (value?.recipeId && value.recipeId !== recipe?.id) throw new Error("Directory prepare recipe is immutable");
    const attemptId = randomUUID(); const lease = this.store.atomic(() => {
      const current = this.get(ticketId);
      if (current?.state === "preparing") throw new Error("Directory prepare already running");
      const acquired = this.store.leases.acquire(leaseKey(ticketId), this.owner, this.now(), this.leaseMs);
      if (!acquired) throw new Error("Directory prepare is owned by another executor");
      const record: DirectoryRecord = { ...p, ticketId, recipeId: recipe?.id, state: "preparing", revision: (current?.revision ?? 0) + 1, attemptId, leaseOwner: this.owner, leaseUntil: acquired.expiresAt, leaseGeneration: acquired.generation, ...(current?.metadata ? { metadata: current.metadata } : {}) };
      this.store.set(key(ticketId), record); return record;
    });
    try {
      for (const path of [p.base, p.cwd, p.sessionDir, p.agentDir]) { mkdirSync(path, { recursive: true, mode: 0o700 }); noSymlink(path); }
      const signal = options.signal ? AbortSignal.any([options.signal, AbortSignal.timeout(this.timeoutMs)]) : AbortSignal.timeout(this.timeoutMs);
      const metadata = recipe ? await recipe.run({ cwd: p.cwd, base: p.base, ticketId, signal, attemptId }) : undefined;
      if (signal.aborted) throw new Error("Directory prepare aborted or timed out");
      const ready = this.store.atomic(() => {
        const current = this.get(ticketId); const live = this.store.leases.get(leaseKey(ticketId));
        if (!current || current.revision !== lease.revision || current.state !== "preparing" || current.attemptId !== attemptId || live?.owner !== this.owner || live.generation !== lease.leaseGeneration || live.expiresAt <= this.now()) throw new Error("Directory prepare ownership changed");
        const result: DirectoryRecord = { ...current, state: "ready", revision: current.revision + 1, leaseOwner: undefined, leaseUntil: undefined, leaseGeneration: undefined, ...(metadata ? { metadata: copy(metadata) } : {}) };
        this.store.set(key(ticketId), result); this.store.db.run("DELETE FROM vivi_leases WHERE resource=? AND owner=? AND generation=?", leaseKey(ticketId), this.owner, lease.leaseGeneration); return result;
      });
      return copy(ready);
    } catch (error) {
      await Promise.resolve();
      this.store.atomic(() => { const current = this.get(ticketId); if (current?.attemptId === attemptId && current.state === "preparing") this.store.set(key(ticketId), { ...current, state: "failed", revision: current.revision + 1, error: String(error), leaseOwner: undefined, leaseUntil: undefined, leaseGeneration: undefined }); this.store.db.run("DELETE FROM vivi_leases WHERE resource=? AND owner=?", leaseKey(ticketId), this.owner); });
      throw error;
    }
  }
  retry(ticketId: string, expectedRevision: number, recipe?: PrepareRecipe): Promise<DirectoryRecord> {
    const current = this.get(ticketId); if (!current || current.revision !== expectedRevision || current.state !== "failed" || !empty(current.cwd)) throw new Error("Directory retry requires the exact failed empty directory");
    return this.prepare(ticketId, { recipe });
  }
  reconcile(ticketId: string, expectedRevision: number, result: { prepared: boolean; metadata?: Record<string, unknown> }): DirectoryRecord {
    return this.store.atomic(() => { const current = this.get(ticketId); if (!current || current.revision !== expectedRevision || !["uncertain", "failed"].includes(current.state)) throw new Error("Directory reconciliation CAS failed"); const next: DirectoryRecord = { ...current, state: result.prepared ? "ready" : "failed", revision: current.revision + 1, ...(result.metadata ? { metadata: copy(result.metadata) } : {}) }; this.store.set(key(ticketId), next); return copy(next); });
  }
}
