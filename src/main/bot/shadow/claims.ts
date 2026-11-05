// SPDX-License-Identifier: MIT
// FastVibe execution fencing; see ../core/NOTICE.md.
import type { EffectRecord, ShadowStore } from "./store.ts";

/** The database row, never a caller's payload, owns an in-flight execution. */
export function ownedEffect(store: ShadowStore, claim: EffectRecord, now: number): EffectRecord | undefined {
  const row = store.effects.get(claim.kind, claim.key);
  return row?.status === "running" && row.seq === claim.seq && row.generation === claim.generation
    && row.claimedGeneration === claim.generation && row.claimToken === claim.claimToken
    && row.leaseOwner === claim.leaseOwner && !!row.leaseOwner && row.leaseUntil! > now ? row : undefined;
}
