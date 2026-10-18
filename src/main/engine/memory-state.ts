import { importLegacyJson, RowWriter, type Db } from "./db.ts";
import { emptyState, type MemoryStateFile } from "./memory-plan.ts";

/**
 * The memory pipeline's bookkeeping, in the shared database.
 *
 * `MemoryStateFile` stays exactly the object the pipeline reads and writes — three maps
 * keyed by conversation id plus two loose fields — because what lives there is business
 * rules (which conversations have been read at which mtime, how recently one failed, what
 * the last consolidation picked), not storage. Only its persistence changes: it used to be
 * a 295 KB JSON file rewritten whole on a 500 ms debounce, and every one of those writes
 * carried every conversation the machine has ever read.
 *
 * §5.4: one table per map, so a conversation that was just read is one row, and a
 * conversation that fell out of `#prune` is one `DELETE`. `lastRunAt` and `error` are
 * single values and sit in `memory_meta`.
 */

const MAPS = ["outputs", "empty", "failures"] as const;
type MapName = (typeof MAPS)[number];

const TABLE: Record<MapName, string> = {
  outputs: "memory_outputs",
  empty: "memory_empty",
  failures: "memory_failures",
};

type EntryRow = { id: string; value: unknown };

export class MemoryStateStore {
  #db: Db;
  #writers: Record<MapName, RowWriter<EntryRow>>;
  /** What `memory_meta` holds, keyed by meta name; `undefined` means the row is absent. */
  #meta = new Map<string, string>();

  constructor(db: Db, options: { legacyFile?: string } = {}) {
    this.#db = db;
    this.#writers = {
      outputs: writer(db, "outputs"),
      empty: writer(db, "empty"),
      failures: writer(db, "failures"),
    };
    if (options.legacyFile) {
      importLegacyJson(db, {
        name: "memory-state",
        file: options.legacyFile,
        load: (value) => normalizeState(value),
        save: (state) => {
          let rows = 0;
          for (const name of MAPS) {
            for (const [id, value] of Object.entries(state[name] as Record<string, unknown>)) {
              this.#writers[name].writeOne({ id, value });
              rows += 1;
            }
          }
          if (state.lastRunAt !== undefined) rows += this.#writeMeta("lastRunAt", String(state.lastRunAt));
          if (state.error !== undefined) rows += this.#writeMeta("error", state.error);
          return rows;
        },
        count: () => MAPS.reduce((total, name) => total + db.countRows(TABLE[name]), 0) + db.countRows("memory_meta"),
      });
    }
  }

  /** The whole bookkeeping, in the shape the pipeline expects. */
  load(): MemoryStateFile {
    const state = emptyState();
    for (const name of MAPS) {
      const target = state[name] as Record<string, unknown>;
      for (const row of this.#db.all<{ conversation_id: string; data: string }>(
        `SELECT conversation_id, data FROM ${TABLE[name]}`,
      )) {
        try {
          target[row.conversation_id] = JSON.parse(row.data);
        } catch {
          // A row that is not the JSON we wrote is not worth failing the pipeline over.
          continue;
        }
        this.#writers[name].prime({ id: row.conversation_id, value: target[row.conversation_id] }, row.data);
      }
    }
    for (const row of this.#db.all<{ key: string; value: string }>("SELECT key, value FROM memory_meta")) {
      this.#meta.set(row.key, row.value);
    }
    const lastRunAt = this.#meta.get("lastRunAt");
    if (lastRunAt !== undefined && Number.isFinite(Number(lastRunAt))) state.lastRunAt = Number(lastRunAt);
    const error = this.#meta.get("error");
    if (error !== undefined) state.error = error;
    return state;
  }

  /** Upsert what changed since the table was last read, delete what has left the maps. */
  save(state: MemoryStateFile): void {
    this.#db.transaction(() => {
      for (const name of MAPS) {
        this.#writers[name].write(
          Object.entries(state[name] as Record<string, unknown>).map(([id, value]) => ({ id, value })),
        );
      }
      if (state.lastRunAt !== undefined) this.#writeMeta("lastRunAt", String(state.lastRunAt));
      else this.#dropMeta("lastRunAt");
      if (state.error !== undefined) this.#writeMeta("error", state.error);
      else this.#dropMeta("error");
    });
  }

  /** The user cleared memory: the bookkeeping goes with it, row by row. */
  clear(): void {
    this.#db.transaction(() => {
      for (const name of MAPS) {
        this.#db.run(`DELETE FROM ${TABLE[name]}`);
        this.#writers[name].reset();
      }
      this.#db.run("DELETE FROM memory_meta");
      this.#meta.clear();
    });
  }

  #writeMeta(key: string, value: string): number {
    if (this.#meta.get(key) === value) return 0;
    this.#db.run(
      "INSERT INTO memory_meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
      key,
      value,
    );
    this.#meta.set(key, value);
    return 1;
  }

  #dropMeta(key: string): void {
    if (!this.#meta.has(key)) return;
    this.#db.run("DELETE FROM memory_meta WHERE key = ?", key);
    this.#meta.delete(key);
  }
}

function writer(db: Db, name: MapName): RowWriter<EntryRow> {
  return new RowWriter<EntryRow>(db, {
    table: TABLE[name],
    identity: (row) => ({ conversation_id: row.id }),
    data: (row) => JSON.stringify(row.value),
  });
}

/**
 * The legacy `memory-state.json`, read by the rules the file has always had (§4.4 step 2):
 * a wrong version or a missing `outputs` is not a state, and the store starts empty.
 */
function normalizeState(value: unknown): MemoryStateFile {
  const parsed = value as Partial<MemoryStateFile> | null;
  if (!parsed || parsed.version !== 1 || typeof parsed.outputs !== "object" || parsed.outputs === null) {
    return emptyState();
  }
  return {
    ...emptyState(),
    ...parsed,
    outputs: parsed.outputs,
    empty: parsed.empty ?? {},
    failures: parsed.failures ?? {},
  } as MemoryStateFile;
}
