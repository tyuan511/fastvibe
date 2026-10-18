import type { ThinkingTiming } from "@shared/types";
import { importLegacyJson, RowWriter, type Db } from "./db.ts";

/**
 * Thinking-block bounds, keyed by session entry id.
 *
 * The engine's transcript records one timestamp per assistant message — the moment the
 * request started — so a block's thinking time cannot be recovered from it. Main therefore
 * times the live blocks and keeps their `[startedAt, endedAt]` here, which is what lets a
 * reloaded (or re-opened) transcript still read 「N 秒」 instead of falling back to a bare
 * 「思考」.
 *
 * Bounds rather than a duration: the elapsed value is derived at render time, so the stored
 * record stays meaningful whatever the clock or the display does with it.
 *
 * Entries are keyed by the session entry id, so nothing has to be invalidated when a
 * conversation is edited, branched or deleted; only orphans linger, and the cap below
 * bounds them.
 *
 * It used to be one 268 KB JSON file rewritten whole every 500 ms. It is now rows, so a
 * flush writes the handful of entries the last reply actually touched.
 */
type Bounds = [number, number];

type ReasoningFile = {
  version: 1;
  /** Entry id → each thinking block's [startedAt, endedAt], in content order. */
  blocks: Record<string, Bounds[]>;
};

const VERSION = 1;
/** Roughly 200 KB of history — far more than any transcript on screen. */
const MAX_ENTRIES = 5000;
const DEBOUNCE_MS = 500;

/** One row per session entry id: the bounds as JSON, and the order they were written in. */
type ReasoningRow = { entryId: string; seq: number; bounds: Bounds[] };
type Entry = { seq: number; bounds: Bounds[] };

export class ReasoningStore {
  #db: Db;
  #blocks = new Map<string, Entry>();
  #writer: RowWriter<ReasoningRow>;
  /** Continues past whatever the table already holds, so two processes do not collide. */
  #seq = 0;
  #writeTimer: NodeJS.Timeout | null = null;

  constructor(db: Db, options: { legacyFile?: string } = {}) {
    this.#db = db;
    this.#writer = new RowWriter<ReasoningRow>(db, {
      table: "reasoning_blocks",
      identity: (row) => ({ entry_id: row.entryId }),
      columns: (row) => ({ seq: row.seq }),
      dataColumn: "bounds",
      data: (row) => JSON.stringify(row.bounds),
    });

    if (options.legacyFile) {
      importLegacyJson(db, {
        name: "reasoning",
        file: options.legacyFile,
        load: (value) => entriesFromLegacy(value),
        save: (entries) => {
          for (const [entryId, entry] of entries) {
            this.#writer.writeOne({ entryId, seq: entry.seq, bounds: entry.bounds });
          }
          return entries.size;
        },
        count: () => db.countRows("reasoning_blocks"),
      });
    }

    for (const row of db.all<{ entry_id: string; seq: number | null; bounds: string }>(
      "SELECT entry_id, seq, bounds FROM reasoning_blocks ORDER BY seq",
    )) {
      const bounds = parseBounds(row.bounds);
      const seq = Number(row.seq ?? 0);
      this.#seq = Math.max(this.#seq, seq);
      // Insertion order is the load order, which is the seq order: that is what keeps
      // eviction oldest-first across a restart rather than resetting every time.
      this.#blocks.set(row.entry_id, { seq, bounds });
      // Prime with the table's own bytes, so the next flush writes only what has really
      // changed since. `bounds` may be text this store would not have written itself.
      this.#writer.prime({ entryId: row.entry_id, seq, bounds }, row.bounds);
    }
  }

  get(id: string): ThinkingTiming[] | undefined {
    const entry = this.#blocks.get(id);
    return entry?.bounds.map(([startedAt, endedAt]) => ({ startedAt, endedAt }));
  }

  set(id: string, blocks: ThinkingTiming[]): void {
    const bounds = blocks
      .filter((block): block is ThinkingTiming & { endedAt: number } => typeof block.endedAt === "number")
      .map((block): Bounds => [block.startedAt, block.endedAt]);
    if (bounds.length === 0 || !id) return;
    // Re-inserting an existing key moves it to the end of the map, so eviction stays
    // oldest-first — and it takes a new `seq`, which is the same rule in the table.
    this.#blocks.delete(id);
    this.#seq += 1;
    this.#blocks.set(id, { seq: this.#seq, bounds });
    while (this.#blocks.size > MAX_ENTRIES) {
      const oldest = this.#blocks.keys().next();
      if (oldest.done) break;
      this.#blocks.delete(oldest.value);
    }
    this.#write();
  }

  /** Persist immediately (used on shutdown so a pending debounce is not lost). */
  flush(): void {
    if (this.#writeTimer) {
      clearTimeout(this.#writeTimer);
      this.#writeTimer = null;
    }
    try {
      this.#db.transaction(() => {
        this.#writer.write(this.#rows());
        // A second process writing here pushes the shared table past the cap, and each
        // process only ever evicts its own rows — so the bound is enforced on the table.
        this.#db.run(
          "DELETE FROM reasoning_blocks WHERE seq <= (SELECT MAX(seq) FROM reasoning_blocks) - ?",
          MAX_ENTRIES,
        );
      });
    } catch {
      // A timing detail is never worth failing a quit or a run over.
    }
  }

  #rows(): ReasoningRow[] {
    const rows: ReasoningRow[] = [];
    for (const [entryId, entry] of this.#blocks) {
      rows.push({ entryId, seq: entry.seq, bounds: entry.bounds });
    }
    return rows;
  }

  #write(): void {
    if (this.#writeTimer) return;
    this.#writeTimer = setTimeout(() => {
      this.#writeTimer = null;
      this.flush();
    }, DEBOUNCE_MS);
    this.#writeTimer.unref?.();
  }
}

function parseBounds(text: string): Bounds[] {
  try {
    const parsed = JSON.parse(text) as unknown;
    return Array.isArray(parsed) ? clean(parsed) : [];
  } catch {
    return [];
  }
}

/**
 * The legacy file, read by the same normalisation the store has always used (§4.4 step 2:
 * reuse the store's own reading code rather than write a second one that can drift).
 *
 * The file's object order is the order the entries were written, so it becomes `seq`.
 */
function entriesFromLegacy(value: unknown): Map<string, Entry> {
  const parsed = value as ReasoningFile;
  const entries = new Map<string, Entry>();
  if (!parsed || parsed.version !== VERSION || !parsed.blocks) return entries;
  let seq = 0;
  for (const [id, bounds] of Object.entries(parsed.blocks)) {
    if (typeof id !== "string") continue;
    const kept = Array.isArray(bounds) ? clean(bounds) : [];
    if (kept.length === 0) continue;
    seq += 1;
    entries.set(id, { seq, bounds: kept });
  }
  return entries;
}

function clean(bounds: unknown[]): Bounds[] {
  return bounds.filter(
    (block): block is Bounds =>
      Array.isArray(block) &&
      block.length === 2 &&
      Number.isFinite(block[0]) &&
      Number.isFinite(block[1]) &&
      block[1] >= block[0],
  );
}
