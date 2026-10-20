import { readFile, stat } from "node:fs/promises";
import { migrateSessionEntries, parseSessionEntries, SessionManager, type SessionEntry } from "@earendil-works/pi-coding-agent";
import { relinkDanglingEntries } from "./transcript-file.ts";

type Transcript = { branch: SessionEntry[]; entries: SessionEntry[] };
type CachedBranch = Transcript & { signature: string; bytes: number };

/** Read-only history cache. File identity/mtime/size invalidate edits, appends and forks. */
export class TranscriptReader {
  #cache = new Map<string, CachedBranch>();
  #flights = new Map<string, Promise<Transcript>>();
  readonly maxBytes: number;
  constructor(maxBytes = 32 * 1024 * 1024) { this.maxBytes = maxBytes; }

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
      const signature = `${before.dev}:${before.ino}:${before.size}:${before.mtimeNs}:${before.ctimeNs}`;
      const cached = this.#cache.get(key);
      if (cached?.signature === signature) {
        this.#cache.delete(key);
        this.#cache.set(key, cached);
        return cached;
      }
      const raw = await readFile(file, "utf8");
      const after = await stat(file, { bigint: true });
      if (`${after.dev}:${after.ino}:${after.size}:${after.mtimeNs}:${after.ctimeNs}` !== signature) continue;
      const entries = parseSessionEntries(raw);
      if (entries[0]?.type !== "session") throw new Error("Invalid session transcript");
      migrateSessionEntries(entries);
      relinkDanglingEntries(entries);
      // Guard the SDK's parent walk against corrupt cycles before selecting a branch.
      const byId = new Map(entries.filter((entry) => entry.type !== "session").map((entry) => [entry.id, entry]));
      const seen = new Set<string>();
      let leaf = entries.at(-1);
      while (leaf && leaf.type !== "session") {
        if (seen.has(leaf.id)) throw new Error("Invalid session transcript cycle");
        seen.add(leaf.id);
        leaf = leaf.parentId ? byId.get(leaf.parentId) : undefined;
      }
      const manager = SessionManager.inMemory(cwd, undefined, entries);
      const transcript = { branch: manager.getBranch(), entries: manager.getEntries() };
      const bytes = Buffer.byteLength(raw);
      this.#cache.delete(key);
      if (bytes <= this.maxBytes) this.#cache.set(key, { signature, ...transcript, bytes });
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
