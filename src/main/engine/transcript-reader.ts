import { createReadStream } from "node:fs";
import { readFile, stat } from "node:fs/promises";
import { createInterface } from "node:readline";
import { migrateSessionEntries, parseSessionEntries, SessionManager, type SessionEntry } from "@earendil-works/pi-coding-agent";
import { relinkDanglingEntries } from "./transcript-file.ts";

type Transcript = { branch: SessionEntry[]; entries: SessionEntry[] };
type CachedBranch = Transcript & { rawEntries: SessionEntry[]; signature: string; identity: string; bytes: number };

const STREAMING_THRESHOLD_BYTES = 4 * 1024 * 1024;

/** Parse one JSONL transcript without materialising the whole file as a string first. */
export type TranscriptEntriesReader = (file: string, bytes: number, start?: number) => Promise<SessionEntry[]>;

export async function readTranscriptEntries(file: string, bytes: number, start = 0): Promise<SessionEntry[]> {
  if (start === 0 && bytes <= STREAMING_THRESHOLD_BYTES) {
    const raw = await readFile(file, "utf8");
    return parseSessionEntries(raw) as unknown as SessionEntry[];
  }
  const stream = createReadStream(file, { encoding: "utf8", ...(start > 0 ? { start } : {}) });
  const lines = createInterface({ input: stream, crlfDelay: Infinity });
  const entries: SessionEntry[] = [];
  try {
    for await (const line of lines) {
      if (!line.trim()) continue;
      try {
        const value = JSON.parse(line) as unknown;
        if (value && typeof value === "object" && !Array.isArray(value)) entries.push(value as SessionEntry);
      } catch {
        // Keep the SDK's historical behaviour: malformed JSONL rows are ignored.
      }
    }
  } finally {
    lines.close();
    stream.destroy();
  }
  return entries;
}

/** Read-only history cache. File identity/mtime/size invalidate edits, appends and forks. */
export class TranscriptReader {
  #cache = new Map<string, CachedBranch>();
  #flights = new Map<string, Promise<Transcript>>();
  #readEntries: TranscriptEntriesReader;
  readonly maxBytes: number;
  constructor(maxBytes = 32 * 1024 * 1024, options?: { readEntries?: TranscriptEntriesReader }) {
    this.maxBytes = maxBytes;
    this.#readEntries = options?.readEntries ?? readTranscriptEntries;
  }

  async read(file: string, cwd: string): Promise<SessionEntry[]> {
    return (await this.#load(file, cwd)).branch;
  }

  /** All persisted entries, including compacted history and abandoned retry branches. */
  async readEntries(file: string, cwd: string): Promise<SessionEntry[]> {
    return (await this.#load(file, cwd)).entries;
  }

  async #load(file: string, cwd: string): Promise<Transcript> {
    const key = JSON.stringify([file, cwd]);
    const pending = this.#flights.get(key);
    if (pending) return pending;
    const flight = this.#read(key, file, cwd).finally(() => this.#flights.delete(key));
    this.#flights.set(key, flight);
    return flight;
  }

  async #read(key: string, file: string, cwd: string): Promise<Transcript> {
    for (let attempt = 0; attempt < 3; attempt++) {
      const before = await stat(file, { bigint: true });
      const identity = `${before.dev}:${before.ino}`;
      const signature = `${identity}:${before.size}:${before.mtimeNs}:${before.ctimeNs}`;
      const cached = this.#cache.get(key);
      if (cached?.signature === signature) {
        this.#cache.delete(key);
        this.#cache.set(key, cached);
        return cached;
      }
      const canAppend = cached?.identity === identity && Number(before.size) > cached.bytes;
      const entries = canAppend
        ? [...cached.rawEntries, ...(await this.#readEntries(file, Number(before.size), cached.bytes))]
        : await this.#readEntries(file, Number(before.size));
      const after = await stat(file, { bigint: true });
      if (`${after.dev}:${after.ino}:${after.size}:${after.mtimeNs}:${after.ctimeNs}` !== signature) continue;
      if ((entries[0] as unknown as { type?: unknown } | undefined)?.type !== "session") throw new Error("Invalid session transcript");
      migrateSessionEntries(entries);
      relinkDanglingEntries(entries);
      // Guard the SDK's parent walk against corrupt cycles before selecting a branch.
      const byId = new Map(entries.filter((entry) => (entry as unknown as { type?: unknown }).type !== "session").map((entry) => [entry.id, entry]));
      const seen = new Set<string>();
      let leaf = entries.at(-1);
      while (leaf && (leaf as unknown as { type?: unknown }).type !== "session") {
        if (seen.has(leaf.id)) throw new Error("Invalid session transcript cycle");
        seen.add(leaf.id);
        leaf = leaf.parentId ? byId.get(leaf.parentId) : undefined;
      }
      const manager = SessionManager.inMemory(cwd, undefined, entries);
      const transcript = { branch: manager.getBranch(), entries: manager.getEntries() };
      const bytes = Number(before.size);
      this.#cache.delete(key);
      if (bytes <= this.maxBytes) this.#cache.set(key, { rawEntries: entries, signature, identity, ...transcript, bytes });
      let retained = [...this.#cache.values()].reduce((sum, value) => sum + value.bytes, 0);
      while (retained > this.maxBytes || this.#cache.size > 8) {
        const oldest = this.#cache.keys().next().value!;
        retained -= this.#cache.get(oldest)!.bytes;
        this.#cache.delete(oldest);
      }
      return transcript;
    }
    throw new Error("Transcript changed while reading; retry");
  }
}
