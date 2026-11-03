import { stat } from "node:fs/promises";
import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import type { BotConversationPreview } from "../../shared/bot.ts";
import { stripMemoryCitation } from "../../shared/memory-citation.ts";

const MAX_PREVIEW_CHARS = 400;
const MAX_CACHED_FILES = 128;
const MAX_READS = 4;

export type BotConversationPreviewSource =
  | { branch: readonly SessionEntry[] }
  | { file: string; cwd: string };

/** Only actual assistant prose on the selected branch can become a reply preview. */
export function botConversationPreview(branch: readonly SessionEntry[]): BotConversationPreview | undefined {
  for (let index = branch.length - 1; index >= 0; index--) {
    const entry = branch[index];
    if (entry.type !== "message" || entry.message.role !== "assistant") continue;
    const message = entry.message;
    const prose = message.content.filter((part) => part.type === "text").map((part) => part.text).join("\n");
    const text = stripMemoryCitation(prose).replace(/\s+/gu, " ").trim();
    if (!text) continue;
    // Avoid exposing a dangling UTF-16 surrogate when the limit bisects an emoji.
    const clipped = text.slice(0, MAX_PREVIEW_CHARS).replace(/[\uD800-\uDBFF]$/u, "");
    const timestamp = Date.parse(entry.timestamp);
    return { text: clipped, updatedAt: Number.isFinite(timestamp) ? timestamp : 0 };
  }
  return undefined;
}

type BranchReader = (file: string, cwd: string) => Promise<readonly SessionEntry[]>;
type Cached = { stamp: string; preview: BotConversationPreview | undefined };

/** Keeps only bounded derived text, never a transcript or an AgentSession. */
export class BotConversationPreviewReader {
  #cache = new Map<string, Cached>();
  #pending = new Map<string, Promise<BotConversationPreview | undefined>>();
  #reading = 0;
  #waiting: Array<() => void> = [];
  readonly #source: (id: string) => BotConversationPreviewSource | undefined;
  readonly #load: BranchReader;

  constructor(source: (id: string) => BotConversationPreviewSource | undefined, load: BranchReader) {
    this.#source = source;
    this.#load = load;
  }

  async read(ids: readonly string[]): Promise<Record<string, BotConversationPreview>> {
    const previews: Array<[string, BotConversationPreview]> = [];
    const files: Array<[string, { file: string; cwd: string }]> = [];
    // Capture all live branches synchronously, before any cold disk read yields.
    for (const id of new Set(ids)) {
      try {
        const source = this.#source(id);
        if (!source) continue;
        if ("branch" in source) {
          const preview = botConversationPreview(source.branch);
          if (preview) previews.push([id, preview]);
        } else files.push([id, source]);
      } catch { /* One unavailable conversation cannot hide the rest of the list. */ }
    }
    let next = 0;
    await Promise.all(Array.from({ length: Math.min(MAX_READS, files.length) }, async () => {
      while (next < files.length) {
        const [id, source] = files[next++];
        try {
          const preview = await this.#readFile(source);
          if (preview) previews.push([id, preview]);
        } catch { /* Missing, oversized or damaged transcripts have no preview. */ }
      }
    }));
    return Object.fromEntries(previews);
  }

  async #readFile({ file, cwd }: { file: string; cwd: string }): Promise<BotConversationPreview | undefined> {
    const info = await stat(file, { bigint: true });
    const key = JSON.stringify([file, cwd]);
    const stamp = `${info.dev}:${info.ino}:${info.mtimeNs}:${info.ctimeNs}:${info.size}`;
    const cached = this.#cache.get(key);
    if (cached?.stamp === stamp) {
      this.#cache.delete(key);
      this.#cache.set(key, cached);
      return cached.preview;
    }
    const pendingKey = JSON.stringify([key, stamp]);
    const existing = this.#pending.get(pendingKey);
    if (existing) return existing;
    const pending = this.#loadFile(file, cwd, key, stamp);
    this.#pending.set(pendingKey, pending);
    try { return await pending; }
    finally { this.#pending.delete(pendingKey); }
  }

  async #loadFile(file: string, cwd: string, key: string, stamp: string): Promise<BotConversationPreview | undefined> {
    if (this.#reading >= MAX_READS) await new Promise<void>((resolve) => this.#waiting.push(resolve));
    else this.#reading++;
    try {
      let preview: BotConversationPreview | undefined;
      try { preview = botConversationPreview(await this.#load(file, cwd)); }
      catch { /* Cache a failed parse too, until this file changes. */ }
      const after = await stat(file, { bigint: true });
      // A file changed during the read may contain a different branch now. Retry
      // on the next snapshot instead of retaining a result under the wrong stamp.
      if (`${after.dev}:${after.ino}:${after.mtimeNs}:${after.ctimeNs}:${after.size}` !== stamp) return undefined;
      this.#cache.delete(key);
      this.#cache.set(key, { stamp, preview });
      while (this.#cache.size > MAX_CACHED_FILES) this.#cache.delete(this.#cache.keys().next().value!);
      return preview;
    } finally {
      const resume = this.#waiting.shift();
      if (resume) resume(); else this.#reading--;
    }
  }
}
