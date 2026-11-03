export type MemoryRetention = {
  generatedAt: number;
  lastUsage?: number;
  reinforcementCount?: number;
  lastReinforcedAt?: number;
};

const DAY = 24 * 60 * 60_000;
export const MEMORY_MAX_SOURCES = 256;
/** Appended to both consolidation prompts; provenance removal has identical semantics. */
export const MEMORY_RETENTION_POLICY = `

## Shared memory retention policy
All sources, including explicitly saved user instructions and preferences, follow the same forgetting curve and capacity limit. No source has a permanent exemption.
Treat the current source notes and raw collection as authoritative, host-owned inputs. Never recreate a removed source from old context, the workspace diff, or the previous handbook.
When a source is removed by expiration or capacity selection, remove only handbook claims, procedures, and routing/index entries supported exclusively by that source. Preserve content that still has support from surviving sources, and update its citations to those surviving sources. Delete dangling references to removed sources throughout memory documents and skills. Do not retain an unsupported claim merely because it describes a preference or an explicit request to remember.
`;
export const MEMORY_BASE_UNUSED_MS = 30 * DAY;
export const MEMORY_REINFORCEMENT_INTERVAL_MS = DAY;
export const MEMORY_MAX_HALF_LIFE_MS = 90 * DAY;
const INITIAL_HALF_LIFE_MS = MEMORY_BASE_UNUSED_MS / 4;
const MAX_REINFORCEMENTS = 31;

function finite(value: number | undefined, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function reinforcementCount(record: MemoryRetention): number {
  return Math.min(MAX_REINFORCEMENTS, Math.max(0, Math.floor(finite(record.reinforcementCount, 0))));
}

function halfLife(record: MemoryRetention): number {
  return Math.min(MEMORY_MAX_HALF_LIFE_MS, INITIAL_HALF_LIFE_MS * 2 ** reinforcementCount(record));
}

function decay(record: MemoryRetention, now: number): number {
  const clock = memoryRetentionClock(record);
  const age = Math.max(0, finite(now, clock) - clock);
  return 2 ** (-age / halfLife(record));
}

/** Ranking alone includes a bounded reinforcement weight; lifetime usage counts do not. */
export function memoryRetentionScore(record: MemoryRetention, now: number): number {
  return decay(record, now) * (1 + Math.log2(1 + reinforcementCount(record)));
}

/** Expiry uses unweighted R, so even maximally reinforced notes expire after 360 unused days. */
export function memoryExpired(record: MemoryRetention, now: number): boolean {
  return decay(record, now) < 1 / 16;
}

/** Reinforce at most once per day, and never revive an expired note. */
export function reinforceMemory(record: MemoryRetention, now: number): MemoryRetention {
  if (memoryExpired(record, now)) return record;
  const generatedAt = finite(record.generatedAt, 0);
  const lastReinforced = Math.max(generatedAt, finite(record.lastReinforcedAt, memoryRetentionClock(record)));
  if (!Number.isFinite(now) || now - lastReinforced < MEMORY_REINFORCEMENT_INTERVAL_MS) return record;
  return {
    generatedAt,
    lastUsage: Math.max(memoryRetentionClock(record), now),
    lastReinforcedAt: now,
    reinforcementCount: Math.min(MAX_REINFORCEMENTS, reinforcementCount(record) + 1),
  };
}

export function memoryRetentionClock(record: MemoryRetention): number {
  return Math.max(finite(record.generatedAt, 0), finite(record.lastUsage, finite(record.generatedAt, 0)));
}
