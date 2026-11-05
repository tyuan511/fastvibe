// SPDX-License-Identifier: MIT
// M6 WorkerSlots resource fencing; no scheduler or production executor registration.
import { randomUUID } from "node:crypto";
import type { WorkerToken } from "./engine.ts";
import type { Lease, ShadowStore } from "./store.ts";

export type SlotPhase = "starting" | "running" | "settling" | "stopping" | "uncertain";
export type SlotBy = "launch" | "wake" | "person";
export interface SlotReservation {
  ticketId: string; binding: WorkerToken; by: SlotBy; phase: SlotPhase; revision: number;
  lease: Lease; createdAt: number;
}
const key = (ticketId: string): string => `shadow:slot:${ticketId}`;
const resource = (ticketId: string): string => `shadow:slot:${ticketId}`;
const sameBinding = (a: WorkerToken, b: WorkerToken): boolean => a.ticketId === b.ticketId && a.assignmentId === b.assignmentId && a.generation === b.generation && a.claimToken === b.claimToken;
const active = (_phase: SlotPhase): boolean => true;

export class WorkerSlots {
  private readonly store: ShadowStore; private readonly max: () => number; private readonly now: () => number;
  private readonly owner: string; private readonly leaseMs: number;
  constructor(store: ShadowStore, options: { max: () => number; now?: () => number; owner?: string; leaseMs?: number }) {
    this.store = store; this.max = options.max; this.now = options.now ?? Date.now; this.owner = options.owner ?? randomUUID(); this.leaseMs = options.leaseMs ?? 60_000;
    if (!Number.isSafeInteger(this.leaseMs) || this.leaseMs <= 0) throw new Error("Invalid slot lease");
  }
  get(ticketId: string): SlotReservation | undefined { return this.store.get<SlotReservation>(key(ticketId)); }
  records(): SlotReservation[] { return this.store.db.all<{ data: string }>("SELECT data FROM dsh_kv WHERE key LIKE 'shadow:slot:%' ORDER BY key").map(row => JSON.parse(row.data) as SlotReservation); }
  private normalize(): void {
    const now = this.now();
    for (const slot of this.records()) {
      if (slot.phase !== "uncertain" && slot.lease.expiresAt <= now) this.store.set(key(slot.ticketId), { ...slot, phase: "uncertain" as const, revision: slot.revision + 1 });
    }
  }
  used(): number { return this.store.atomic(() => { this.normalize(); return new Set(this.records().filter(slot => active(slot.phase)).map(slot => slot.ticketId)).size; }); }
  launches(): number {
    return this.store.atomic(() => { this.normalize(); const slots = this.records(); const held = new Set(slots.filter(slot => slot.phase !== "uncertain" && slot.by !== "launch").map(slot => slot.ticketId)); const uncertain = new Set(slots.filter(slot => slot.phase === "uncertain").map(slot => slot.ticketId)); return Math.max(0, this.max() - new Set([...held, ...uncertain]).size); });
  }
  reserve(ticketId: string, by: SlotBy, binding: WorkerToken): SlotReservation {
    return this.store.atomic(() => {
      this.normalize(); const existing = this.get(ticketId);
      if (existing && sameBinding(existing.binding, binding) && existing.phase !== "uncertain") {
        if (existing.lease.owner !== this.owner) throw new Error("Ticket already owns an active worker slot");
        return existing;
      }
      if (existing && existing.phase !== "uncertain" && !sameBinding(existing.binding, binding)) throw new Error("Ticket already owns a different active worker slot");
      const current = this.records().filter(slot => active(slot.phase)); const used = new Set(current.map(slot => slot.ticketId));
      const capacity = this.max() + (by === "person" ? 1 : 0);
      if (used.size >= capacity) throw new Error("No worker slot is free");
      const lease = this.store.leases.acquire(resource(ticketId), this.owner, this.now(), this.leaseMs);
      if (!lease) throw new Error("Worker slot is owned by another executor");
      const record: SlotReservation = { ticketId, binding: structuredClone(binding), by, phase: "starting", revision: (existing?.revision ?? 0) + 1, lease, createdAt: this.now() };
      this.store.set(key(ticketId), record); return structuredClone(record);
    });
  }
  phase(slot: SlotReservation, next: Exclude<SlotPhase, "uncertain">): SlotReservation {
    return this.store.atomic(() => { const current = this.get(slot.ticketId); if (!current || current.revision !== slot.revision || !sameBinding(current.binding, slot.binding) || !this.valid(slot)) throw new Error("Worker slot ownership changed"); const nextRecord = { ...current, phase: next, revision: current.revision + 1 }; this.store.set(key(slot.ticketId), nextRecord); return structuredClone(nextRecord); });
  }
  renew(slot: SlotReservation): SlotReservation {
    return this.store.atomic(() => { const current = this.get(slot.ticketId); if (!current || current.revision !== slot.revision || !this.valid(slot)) throw new Error("Worker slot cannot be renewed"); const ok = this.store.leases.renew(current.lease, this.now(), this.leaseMs); if (!ok) throw new Error("Worker slot lease expired"); const lease: Lease = { ...current.lease, expiresAt: this.now() + this.leaseMs }; const next = { ...current, lease, revision: current.revision + 1 }; this.store.set(key(slot.ticketId), next); return structuredClone(next); });
  }
  valid(slot: SlotReservation): boolean {
    const current = this.get(slot.ticketId); return !!current && current.phase !== "uncertain" && current.revision === slot.revision && sameBinding(current.binding, slot.binding) && current.lease.owner === this.owner && current.lease.generation === slot.lease.generation && current.lease.expiresAt > this.now();
  }
  release(slot: SlotReservation): boolean {
    return this.store.atomic(() => { const current = this.get(slot.ticketId); if (!current || current.revision !== slot.revision || !this.valid(slot)) return false; this.store.db.run("DELETE FROM dsh_kv WHERE key=?", key(slot.ticketId)); this.store.db.run("DELETE FROM dsh_leases WHERE resource=? AND owner=? AND generation=?", resource(slot.ticketId), this.owner, slot.lease.generation); return true; });
  }
  reconcile(expected: SlotReservation, result: { quiet: boolean }): boolean {
    return this.store.atomic(() => { const current = this.get(expected.ticketId); if (!result.quiet || !current || current.phase !== "uncertain" || current.revision !== expected.revision || !sameBinding(current.binding, expected.binding)) return false; this.store.db.run("DELETE FROM dsh_kv WHERE key=?", key(expected.ticketId)); this.store.db.run("DELETE FROM dsh_leases WHERE resource=?", resource(expected.ticketId)); return true; });
  }
}
