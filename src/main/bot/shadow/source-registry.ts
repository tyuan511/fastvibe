// SPDX-License-Identifier: MIT
// M7 isolated Source registry; Source kinds are explicit adapters, never production registrations.
import type { ScopeResult, SourceScope } from "../core/ports.ts";
import type { ShadowStore, Lease } from "./store.ts";

export type SourceHealthState = "starting" | "healthy" | "degraded" | "error" | "disabled" | "unknown";
export interface ShadowSourceKind {
  kind: string;
  validate(config: unknown): Record<string, unknown>;
  scope?(input: { meta: Record<string, unknown> }, config: Record<string, unknown>): ScopeResult;
}
export type SourceStatus = "enabled" | "disabled" | "revoked" | "unavailable";
export interface ShadowSourceInstance {
  id: string; kind: string; enabled: boolean; status: SourceStatus; config: Record<string, unknown>; revision: number;
}
export interface ShadowSourceHealth {
  source: string; state: SourceHealthState; detail: string; at: number; revision: number;
}
export interface ShadowCursor { source: string; instance: string; cursor?: string; revision: number; at: number }
export interface CredentialReference { id: string; kind: string; label?: string }

const instanceKey = (id: string) => `shadow:m7:source:instance:${id}`;
const healthKey = (id: string) => `shadow:m7:source:health:${id}`;
const credentialKey = (source: string) => `shadow:m7:source:credential:${source}`;
const pollLeaseKey = (source: string, instance: string) => `shadow:m7:source:poll:${encodeURIComponent(source)}:${encodeURIComponent(instance)}`;
const sourceId = /^[a-z][a-z0-9-]{0,63}$/;
const forbidden = /token|secret|password|privatekey|authorization|accesskey|credential|apikey/i;
const copy = <T>(value: T): T => structuredClone(value);

function assertSourceId(id: string): void { if (!sourceId.test(id)) throw new Error(`非法 Source ID: ${id}`); }
function assertSafeValue(value: unknown, path = "config"): void {
  if (Array.isArray(value)) { value.forEach((item, index) => assertSafeValue(item, `${path}[${index}]`)); return; }
  if (!value || typeof value !== "object") return;
  for (const [name, item] of Object.entries(value as Record<string, unknown>)) {
    if (forbidden.test(name) && name !== "credentialRef") throw new Error(`Source 配置不能持久化凭据字段: ${path}.${name}`);
    if (name === "credentialRef") {
      if (item === undefined) continue;
      if (typeof item !== "string" || !item.trim() || item.length > 200) throw new Error("credentialRef 必须是非空引用 ID");
      continue;
    }
    assertSafeValue(item, `${path}.${name}`);
  }
}
function validateRef(ref: CredentialReference): CredentialReference {
  if (!/^[a-z][a-z0-9._-]{0,127}$/.test(ref.id) || !/^[a-z][a-z0-9._-]{0,63}$/.test(ref.kind)) throw new Error("非法凭据引用");
  if (ref.label !== undefined && (ref.label.trim().length === 0 || ref.label.length > 160)) throw new Error("非法凭据标签");
  return { id: ref.id, kind: ref.kind, ...(ref.label ? { label: ref.label } : {}) };
}

/**
 * Persistent registry for the M7 shadow world. Registration is process-local;
 * instances, health, cursors and credential references survive reopening the store.
 */
export class ShadowSourceRegistry implements SourceScope {
  private readonly kinds = new Map<string, ShadowSourceKind>();
  private readonly store: ShadowStore;
  private readonly now: () => number;
  constructor(store: ShadowStore, now: () => number = Date.now) { this.store = store; this.now = now; }
  register(kind: ShadowSourceKind): () => void {
    assertSourceId(kind.kind);
    if (this.kinds.has(kind.kind)) throw new Error(`Source kind already registered: ${kind.kind}`);
    this.kinds.set(kind.kind, kind);
    return () => { if (this.kinds.get(kind.kind) === kind) this.kinds.delete(kind.kind); };
  }
  kind(id: string): ShadowSourceKind | undefined { return this.kinds.get(id); }
  instances(): ShadowSourceInstance[] {
    const stored = this.store.db.all<{ data: string }>("SELECT data FROM dsh_kv WHERE key LIKE 'shadow:m7:source:instance:%' ORDER BY key").map(row => JSON.parse(row.data) as ShadowSourceInstance);
    const byId = new Map(stored.map(value => [value.id, value]));
    for (const [id, kind] of this.kinds) if (!byId.has(id)) byId.set(id, { id, kind: kind.kind, enabled: false, status: "disabled", config: kind.validate({}), revision: 0 });
    return [...byId.values()].sort((a, b) => a.id.localeCompare(b.id)).map(copy);
  }
  instance(id: string): ShadowSourceInstance | undefined {
    const value = this.store.get<ShadowSourceInstance>(instanceKey(id));
    if (value) return copy(value);
    const kind = this.kinds.get(id);
    return kind ? { id, kind: kind.kind, enabled: false, status: "disabled", config: kind.validate({}), revision: 0 } : undefined;
  }
  configure(id: string, input: { enabled: boolean; config: unknown; status?: SourceStatus }, expectedRevision?: number): ShadowSourceInstance {
    assertSourceId(id);
    const kind = this.kinds.get(id);
    if (!kind) throw new Error(`Source kind not installed: ${id}`);
    if (typeof input.enabled !== "boolean") throw new Error("Source enabled 必须是 boolean");
    const config = kind.validate(input.config); assertSafeValue(config);
    return this.store.atomic(() => {
      const current = this.instance(id); const revision = current?.revision ?? 0;
      if (expectedRevision !== undefined && expectedRevision !== revision) throw new Error("Source 配置 revision 冲突");
      const status = input.status ?? (input.enabled ? (current?.status === "revoked" || current?.status === "unavailable" ? current.status : "enabled") : "disabled");
      if (!input.enabled && status === "enabled") throw new Error("disabled Source 不能使用 enabled 状态");
      const next: ShadowSourceInstance = { id, kind: kind.kind, enabled: input.enabled, status, config: copy(config), revision: revision + 1 };
      this.store.set(instanceKey(id), next);
      if (!this.store.get<ShadowSourceHealth>(healthKey(id))) this.store.set(healthKey(id), { source: id, state: input.enabled ? "unknown" : "disabled", detail: "", at: this.now(), revision: 0 });
      return copy(next);
    });
  }
  /** Unknown or disabled kinds never listen, so they cannot start intake. */
  scope(input: { source: string; meta: Record<string, unknown> }): ScopeResult {
    const instance = this.instance(input.source); const kind = this.kinds.get(input.source);
    if (!instance || !kind) return { listened: false, reason: "source_not_installed" };
    if (!instance.enabled || instance.status !== "enabled") return { listened: false, reason: `source_${instance.status}` };
    return kind.scope ? kind.scope({ meta: input.meta }, copy(instance.config)) : { listened: true, observed: false };
  }
  setStatus(id: string, status: SourceStatus, expectedRevision?: number): ShadowSourceInstance {
    const current = this.instance(id); if (!current || !this.kinds.has(id)) throw new Error(`Source kind not installed: ${id}`);
    return this.store.atomic(() => {
      const latest = this.instance(id)!;
      if (expectedRevision !== undefined && latest.revision !== expectedRevision) throw new Error("Source 状态 revision 冲突");
      const next = { ...latest, enabled: status === "enabled", status, revision: latest.revision + 1 };
      this.store.set(instanceKey(id), next); return copy(next);
    });
  }

  health(id: string): ShadowSourceHealth | undefined { return copy(this.store.get<ShadowSourceHealth>(healthKey(id))); }
  setHealth(id: string, state: SourceHealthState, detail = "", expectedRevision?: number): ShadowSourceHealth {
    assertSourceId(id); if (!this.kinds.has(id)) throw new Error(`Source kind not installed: ${id}`);
    if (detail.length > 500) throw new Error("Source health detail 过长");
    return this.store.atomic(() => {
      const current = this.health(id); const revision = current?.revision ?? 0;
      if (expectedRevision !== undefined && expectedRevision !== revision) throw new Error("Source health revision 冲突");
      const next: ShadowSourceHealth = { source: id, state, detail, at: this.now(), revision: revision + 1 };
      this.store.set(healthKey(id), next); return copy(next);
    });
  }
  cursor(source: string, instance = source): ShadowCursor {
    const current = this.store.cursors.get<{ cursor?: string; at: number }>(source, instance, "poll");
    return current ? { source, instance, ...(current.value.cursor === undefined ? {} : { cursor: current.value.cursor }), revision: current.revision, at: current.value.at } : { source, instance, revision: 0, at: this.now() };
  }
  advanceCursor(source: string, instance: string, cursor: string | undefined, expectedRevision: number): ShadowCursor {
    if (source.length === 0 || instance.length === 0) throw new Error("Source cursor 身份不能为空");
    if (cursor !== undefined && cursor.length > 2000) throw new Error("Source cursor 过长");
    const value = { ...(cursor === undefined ? {} : { cursor }), at: this.now() };
    if (!this.store.cursors.save(source, instance, "poll", value, expectedRevision)) throw new Error("Source cursor revision 冲突");
    const saved = this.store.cursors.get<{ cursor?: string; at: number }>(source, instance, "poll")!;
    return { source, instance, ...(saved.value.cursor === undefined ? {} : { cursor: saved.value.cursor }), revision: saved.revision, at: saved.value.at };
  }
  acquirePoll(source: string, instance: string, owner: string, ttl: number, at = this.now()): Lease | undefined {
    return this.store.leases.acquire(pollLeaseKey(source, instance), owner, at, ttl);
  }
  renewPoll(lease: Lease, ttl: number, at = this.now()): boolean { return this.store.leases.renew(lease, at, ttl); }
  releasePoll(lease: Lease, at = this.now()): boolean { return this.store.leases.release(lease, at); }

  bindCredential(source: string, ref: CredentialReference, expectedRevision?: number): { source: string; ref: CredentialReference; revision: number } {
    assertSourceId(source); const checked = validateRef(ref);
    return this.store.atomic(() => {
      const key = credentialKey(source); const current = this.store.get<{ source: string; ref: CredentialReference; revision: number }>(key); const revision = current?.revision ?? 0;
      if (expectedRevision !== undefined && expectedRevision !== revision) throw new Error("凭据引用 revision 冲突");
      const next = { source, ref: checked, revision: revision + 1 }; this.store.set(key, next); return copy(next);
    });
  }
  credentialBinding(source: string): { source: string; ref: CredentialReference; revision: number } | undefined {
    return copy(this.store.get(credentialKey(source)));
  }
  credentialBindings(): { source: string; ref: CredentialReference; revision: number }[] {
    return this.store.db.all<{ data: string }>("SELECT data FROM dsh_kv WHERE key LIKE 'shadow:m7:source:credential:%' ORDER BY key").map(row => copy(JSON.parse(row.data)));
  }
}
