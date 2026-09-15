import { readFileSync, writeFileSync } from "node:fs";
import type { ThinkingTiming } from "@shared/types";

/**
 * Thinking-block bounds, keyed by session entry id.
 *
 * The engine's transcript records one timestamp per assistant message — the moment
 * the request started — so a block's thinking time cannot be recovered from it.
 * Main therefore times the live blocks and keeps their `[startedAt, endedAt]` here,
 * which is what lets a reloaded (or re-opened) transcript still read 「持续了 N 秒」
 * instead of falling back to a bare 「思考」.
 *
 * Bounds rather than a duration: the elapsed value is derived at render time, so the
 * stored record stays meaningful whatever the clock or the display does with it.
 *
 * Entries are keyed by the session entry id, so nothing has to be invalidated when a
 * conversation is edited, branched or deleted; only orphans linger, and the cap
 * below bounds them.
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

export class ReasoningStore {
  #file: string;
  #blocks = new Map<string, Bounds[]>();
  #writeTimer: NodeJS.Timeout | null = null;

  constructor(file: string) {
    this.#file = file;
    this.#read();
  }

  get(id: string): ThinkingTiming[] | undefined {
    const blocks = this.#blocks.get(id);
    return blocks?.map(([startedAt, endedAt]) => ({ startedAt, endedAt }));
  }

  set(id: string, blocks: ThinkingTiming[]): void {
    const bounds = blocks
      .filter((block): block is ThinkingTiming & { endedAt: number } => typeof block.endedAt === "number")
      .map((block): Bounds => [block.startedAt, block.endedAt]);
    if (bounds.length === 0 || !id) return;
    // Re-inserting an existing key keeps its position, so eviction stays oldest-first.
    this.#blocks.delete(id);
    this.#blocks.set(id, bounds);
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
    const payload: ReasoningFile = { version: VERSION, blocks: Object.fromEntries(this.#blocks) };
    try {
      writeFileSync(this.#file, `${JSON.stringify(payload)}\n`);
    } catch {
      // A timing detail is never worth failing a quit or a run over.
    }
  }

  #read(): void {
    try {
      const parsed = JSON.parse(readFileSync(this.#file, "utf8")) as ReasoningFile;
      if (!parsed || parsed.version !== VERSION || !parsed.blocks) return;
      for (const [id, blocks] of Object.entries(parsed.blocks)) {
        if (typeof id !== "string" || !Array.isArray(blocks)) continue;
        const clean = blocks.filter(
          (block): block is Bounds =>
            Array.isArray(block) &&
            block.length === 2 &&
            Number.isFinite(block[0]) &&
            Number.isFinite(block[1]) &&
            block[1] >= block[0],
        );
        if (clean.length > 0) this.#blocks.set(id, clean);
      }
    } catch {
      // Missing or corrupt: start empty.
    }
  }

  #write(): void {
    if (this.#writeTimer) return;
    this.#writeTimer = setTimeout(() => {
      this.#writeTimer = null;
      this.flush();
    }, 500);
    this.#writeTimer.unref?.();
  }
}
