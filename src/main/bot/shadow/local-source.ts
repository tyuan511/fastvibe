// SPDX-License-Identifier: MIT
// M8 Local Source replay: explicit, isolated intake for the Shadow world.
import type { Trigger } from "../core/model.ts";
import type { EngineForSources } from "../core/engine.ts";
import { ShadowSourceRegistry, type ShadowSourceInstance, type ShadowSourceHealth } from "./source-registry.ts";
import type { ShadowStore, Lease } from "./store.ts";
import type { ShadowEngine } from "./engine.ts";

export interface LocalReplayBatch {
  source: string;
  instance?: string;
  /** Cursor read before this page. Omit only for the initial page. */
  cursor?: string;
  events: readonly Trigger[];
  /** Cursor to persist after every event in this page has been accepted. */
  nextCursor?: string;
  hasMore?: boolean;
}

export interface LocalReplayResult {
  status: "stored" | "rejected";
  source: string;
  instance: string;
  results: string[];
  cursor: string | undefined;
  cursorRevision: number;
}

export interface LocalPollResult {
  status: "completed" | "transient-failure" | "rejected";
  pages: number;
  events: number;
  cursor?: string;
  error?: string;
}

export interface LocalSourceReplayOptions {
  registry: ShadowSourceRegistry;
  engine: Pick<ShadowEngine, "sources"> | { sources: EngineForSources };
  store?: ShadowStore;
  now?: () => number;
  leaseMs?: number;
  owner?: string;
}

export interface LocalPageReader {
  (cursor: string | undefined): Promise<LocalReplayBatch> | LocalReplayBatch;
}

export class LocalSourceUnavailableError extends Error {}
export class LocalSourceCursorConflictError extends Error {}
export class LocalSourceLeaseLostError extends Error {}
export class LocalSourceTransientError extends Error {}

const clone = <T>(value: T): T => structuredClone(value);
const sourceInstance = (registry: ShadowSourceRegistry, source: string, instance: string): ShadowSourceInstance => {
  const value = registry.instance(source);
  if (!value || !value.enabled || value.status !== "enabled"
    || !registry.scope({ source, meta: {} }).listened) {
    throw new LocalSourceUnavailableError(`Local Source 不可接收: ${source}/${instance}`);
  }
  return value;
};
function validateTrigger(trigger: Trigger, source: string): void {
  if (!trigger || typeof trigger !== "object" || trigger.source !== source || typeof trigger.id !== "string" || !trigger.id
    || !Array.isArray(trigger.threads) || trigger.threads.length === 0 || typeof trigger.text !== "string"
    || typeof trigger.at !== "string" || !trigger.actor || typeof trigger.actor.id !== "string"
    || !trigger.meta || typeof trigger.meta !== "object") throw new Error("Local replay 需要标准化 Trigger");
}
function errorText(error: unknown): string { return error instanceof Error ? error.message : String(error); }

/**
 * Explicit-only Local Source intake. Constructing this class has no timers, registration,
 * polling, model call, session access, or production side effect.
 */
export class LocalSourceReplay {
  private readonly registry: ShadowSourceRegistry;
  private readonly sources: EngineForSources;
  private readonly clock: () => number;
  private readonly leaseMs: number;
  private readonly owner: string;

  constructor(options: LocalSourceReplayOptions) {
    this.registry = options.registry;
    this.sources = options.engine.sources;
    this.clock = options.now ?? Date.now;
    this.leaseMs = options.leaseMs ?? 30_000;
    this.owner = options.owner ?? "local-replay";
    if (!Number.isSafeInteger(this.leaseMs) || this.leaseMs <= 0) throw new Error("Local replay lease 必须是正整数");
  }

  /** Receive one normalized Trigger only when the caller explicitly invokes this method. */
  receive(trigger: Trigger, source = trigger.source, instance = source): string {
    sourceInstance(this.registry, source, instance);
    validateTrigger(trigger, source);
    return this.sources.receive(clone(trigger));
  }

  /** Receive a controlled page and advance its cursor with the registry's CAS. */
  replay(batch: LocalReplayBatch): LocalReplayResult {
    return this.commitPage(batch);
  }

  /**
   * Explicitly poll pages. The reader is supplied by the caller; this module never creates
   * a network client or starts a timer. A failed read leaves the cursor untouched.
   */
  async poll(source: string, reader: LocalPageReader, instance = source): Promise<LocalPollResult> {
    let lease: Lease | undefined;
    let pages = 0;
    let events = 0;
    try {
      sourceInstance(this.registry, source, instance);
      lease = this.registry.acquirePoll(source, instance, this.owner, this.leaseMs, this.clock());
      if (!lease) throw new LocalSourceLeaseLostError(`Local Source poll lease 已被占用: ${source}/${instance}`);
      let cursor = this.registry.cursor(source, instance).cursor;
      for (;;) {
        this.assertLease(lease);
        const page = await reader(cursor);
        if (page.source !== source || (page.instance ?? instance) !== instance) throw new Error("分页批次 Source 身份不匹配");
        if (page.cursor !== cursor) throw new LocalSourceCursorConflictError("分页批次 cursor 与持久游标不一致");
        const result = this.commitPage(page, lease);
        pages++;
        events += result.results.length;
        cursor = result.cursor;
        if (!page.hasMore) return { status: "completed", pages, events, ...(cursor === undefined ? {} : { cursor }) };
      }
    } catch (error) {
      if (error instanceof LocalSourceUnavailableError || error instanceof LocalSourceLeaseLostError) {
        return { status: "rejected", pages, events, error: errorText(error) };
      }
      this.registry.setHealth(source, "degraded", errorText(error));
      return { status: "transient-failure", pages, events, error: errorText(error) };
    } finally {
      if (lease) this.registry.releasePoll(lease, this.clock());
    }
  }

  health(source: string): ShadowSourceHealth | undefined { return this.registry.health(source); }

  private assertLease(lease: Lease): void {
    if (!this.registry.renewPoll(lease, this.leaseMs, this.clock())) throw new LocalSourceLeaseLostError("Local Source poll lease 已失效");
  }

  private commitPage(batch: LocalReplayBatch, lease?: Lease): LocalReplayResult {
    const instance = batch.instance ?? batch.source;
    sourceInstance(this.registry, batch.source, instance);
    if (lease) this.assertLease(lease);
    const current = this.registry.cursor(batch.source, instance);
    if (current.cursor !== batch.cursor) throw new LocalSourceCursorConflictError("Source cursor 值冲突");
    for (const trigger of batch.events) validateTrigger(trigger, batch.source);
    const results = batch.events.map(trigger => this.sources.receive(clone(trigger)));
    let saved = current;
    if (batch.nextCursor !== undefined || batch.cursor !== undefined || batch.hasMore === false) {
      saved = this.registry.advanceCursor(batch.source, instance, batch.nextCursor, current.revision);
    }
    if (lease) this.assertLease(lease);
    this.registry.setHealth(batch.source, "healthy", "replay ok");
    return { status: "stored", source: batch.source, instance, results, cursor: saved.cursor, cursorRevision: saved.revision };
  }
}

/** Pure compatibility projection; it does not call the old Bot API or any runtime. */
export interface LegacyBotInputLike { id?: string; inputId?: string; requestId?: string; text?: string; createdAt?: string; at?: string; conversationId?: string; }
export function legacyBotInputToTrigger(input: LegacyBotInputLike, source = "local-legacy"): Trigger {
  const id = input.requestId ?? input.inputId ?? input.id;
  if (!id || typeof input.text !== "string") throw new Error("旧 Bot 输入缺少稳定 id 或 text");
  const conversation = input.conversationId ?? "default";
  const at = input.at ?? input.createdAt;
  if (!at) throw new Error("旧 Bot 输入缺少时间");
  return { id: `legacy:${id}`, source, threads: [{ source, id: conversation }], actor: { source: "local", id: "user" }, human: true,
    addressed: "direct", at, text: input.text, meta: { legacyInputId: id, legacy: true } };
}
export const mapLegacyBotInput = legacyBotInputToTrigger;
