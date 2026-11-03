import { createHash, randomUUID } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync, openSync, fsyncSync, closeSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import type { NoteRetentions } from "./retention.ts";
import { redactSecrets } from "../../engine/memory-transcript.ts";

export type MemoryTree = Map<string, string>;
export type MemoryState = {
  version: 1; initialized: boolean; generation: number; cutoff: number;
  seen: Record<string, string>; failures: Record<string, { hash: string; attempts: number; retryAt: number }>;
  /** Optional for old installations; source-note strength, never a second copy of memory. */
  retention?: NoteRetentions;
  maintenanceFailure?: { revision: string; attempts: number; retryAt: number };
};
export const emptyState = (): MemoryState => ({ version: 1, initialized: false, generation: 0, cutoff: 0, seen: {}, failures: {} });
export const digest = (value: string): string => createHash("sha256").update(value).digest("hex");
export const revisionOf = (tree: MemoryTree): string => digest(JSON.stringify([...tree].sort(([a], [b]) => a.localeCompare(b))));
export const initialTree = (): MemoryTree => new Map([["MEMORY.md", "# Vivi memory\n"], ["memory_summary.md", "v1\n\n## Memory index\n"], ["raw_memories.md", "# Raw memories\n"]]);
export function memoryPath(path: string): string {
  if (!path || isAbsolute(path) || path.includes("\\") || path.includes("\0") || path.split("/").some(p => !p || p === "." || p === ".." || p.startsWith(".")) || !path.endsWith(".md")) throw new Error("Invalid memory path");
  return path;
}
function regular(path: string, directory = false): void {
  const stat = lstatSync(path);
  if (stat.isSymbolicLink() || (directory ? !stat.isDirectory() : !stat.isFile())) throw new Error("Unsafe memory file");
}
export function readMemoryTree(root: string): MemoryTree {
  const tree: MemoryTree = new Map();
  let bytes = 0;
  if (!existsSync(root)) return tree;
  regular(root, true);
  const walk = (dir: string, prefix: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true }).sort((a,b) => a.name.localeCompare(b.name))) {
      const name = prefix + entry.name;
      const full = join(dir, entry.name);
      if (entry.isSymbolicLink()) throw new Error("Symbolic links are not allowed in memory");
      // A killed atomic writer can leave an unpublished sibling; it is never readable memory.
      if (/\.md\.tmp-[0-9a-f-]{36}$/.test(entry.name)) continue;
      if (entry.isDirectory()) { if (prefix || entry.name !== "rollout_summaries") throw new Error("Invalid memory directory"); walk(full, name + "/"); }
      else {
        memoryPath(name); regular(full);
        const size = lstatSync(full).size;
        bytes += size;
        if (size > 512_000 || bytes > 8_000_000 || tree.size >= 512) throw new Error("Memory files exceed budget");
        tree.set(name, readFileSync(full, "utf8"));
      }
    }
  };
  walk(root, "");
  return tree;
}
export function validateTree(tree: MemoryTree): void {
  if (!tree.has("MEMORY.md")) throw new Error("MEMORY.md is missing");
  const summary = tree.get("memory_summary.md");
  if (summary === undefined || summary.split("\n")[0].replace(/\r$/, "") !== "v1" || summary.length > 20_000) throw new Error("Invalid memory summary (v1, maximum 20000 characters)");
  let bytes = 0;
  for (const [path, content] of tree) {
    memoryPath(path);
    if (path.includes("/") && !/^rollout_summaries\/[^/]+\.md$/.test(path)) throw new Error("Invalid memory directory");
    bytes += Buffer.byteLength(content);
    if (Buffer.byteLength(content) > 512_000 || bytes > 8_000_000 || tree.size > 512) throw new Error("Memory files exceed budget");
  }
}
function atomic(path: string, text: string): void {
  if (existsSync(path)) regular(path);
  const temp = path + ".tmp-" + randomUUID();
  const fd = openSync(temp, "wx", 0o600);
  try { writeFileSync(fd, text); fsyncSync(fd); } finally { closeSync(fd); }
  try {
    renameSync(temp, path);
    if (process.platform !== "win32") {
      const directory = openSync(dirname(path), "r");
      try { fsyncSync(directory); } finally { closeSync(directory); }
    }
  } finally { rmSync(temp, { force: true }); }
}
export function writeMemoryTree(root: string, tree: MemoryTree, durable = true): void {
  if (existsSync(root)) regular(root, true); else mkdirSync(root, { recursive: true, mode: 0o700 });
  const previous = readMemoryTree(root);
  for (const dir of [root, join(root, "rollout_summaries")]) if (existsSync(dir)) {
    regular(dir, true);
    for (const name of readdirSync(dir)) if (/\.md\.tmp-[0-9a-f-]{36}$/.test(name)) rmSync(join(dir, name));
  }
  for (const [path, content] of tree) {
    memoryPath(path);
    if (previous.get(path) === content) continue;
    const full = join(root, path);
    if (dirname(full) !== root) {
      if (existsSync(dirname(full))) regular(dirname(full), true);
      else mkdirSync(dirname(full), { mode: 0o700 });
    }
    if (durable) atomic(full, content);
    else writeFileSync(full, content, { mode: 0o600 });
  }
  for (const path of previous.keys()) if (!tree.has(path)) rmSync(join(root, path));
}

type Journal = { version: 1; tree: Array<[string,string]>; state: MemoryState };
/** All readers and publishers share this boundary, including across processes. No model call belongs here. */
export class ViviMemoryFiles {
  readonly root: string;
  readonly statePath: string;
  readonly baseline: string;
  readonly journal: string;
  readonly lock: string;
  constructor(root: string) {
    this.root = resolve(root);
    this.statePath = join(dirname(this.root), "memory-state.json");
    this.baseline = this.root + "-baseline";
    this.journal = this.root + "-journal.json";
    this.lock = this.root + "-lock";
  }
  async locked<T>(fn: () => T | Promise<T>): Promise<T> {
    mkdirSync(dirname(this.root), { recursive: true, mode: 0o700 });
    if (existsSync(this.root)) regular(this.root, true);
    const token = randomUUID();
    const deadline = Date.now() + 5_000;
    for (;;) {
      try {
        mkdirSync(this.lock, { mode: 0o700 });
        writeFileSync(join(this.lock, "owner.json"), JSON.stringify({ pid: process.pid, token }), { flag: "wx", mode: 0o600 });
        break;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
        regular(this.lock, true);
        const ownerPath = join(this.lock, "owner.json");
        if (existsSync(ownerPath)) {
          regular(ownerPath);
          const raw = readFileSync(ownerPath, "utf8");
          const owner = JSON.parse(raw) as { pid: number; token: string };
          if (!Number.isSafeInteger(owner.pid) || owner.pid <= 0 || !owner.token) throw new Error("Invalid memory lock owner");
          try { process.kill(owner.pid, 0); } catch (e) {
            if ((e as NodeJS.ErrnoException).code === "ESRCH" && readFileSync(ownerPath, "utf8") === raw) {
              rmSync(this.lock, { recursive: true }); continue;
            }
          }
        } else if (Date.now() - lstatSync(this.lock).mtimeMs > 30_000) {
          // A process can die between mkdir and recording its identity.
          rmSync(this.lock, { recursive: true }); continue;
        }
        if (Date.now() >= deadline) throw new Error("Memory directory is busy");
        await delay(15);
      }
    }
    try {
      this.recover();
      return await fn();
    } finally {
      const owner = JSON.parse(readFileSync(join(this.lock, "owner.json"), "utf8")) as { token: string };
      if (owner.token !== token) throw new Error("Memory lock ownership changed");
      rmSync(this.lock, { recursive: true });
    }
  }
  state(): MemoryState {
    if (!existsSync(this.statePath)) return emptyState();
    regular(this.statePath);
    const state = JSON.parse(readFileSync(this.statePath, "utf8")) as MemoryState;
    if (state.version !== 1 || !Number.isSafeInteger(state.generation) || !state.seen || !state.failures) throw new Error("Invalid memory state");
    return state;
  }
  saveState(state: MemoryState): void { atomic(this.statePath, JSON.stringify(state)); }
  snapshot(): { tree: MemoryTree; state: MemoryState; revision: string } {
    const tree = readMemoryTree(this.root);
    return { tree, state: this.state(), revision: revisionOf(tree) };
  }
  publish(tree: MemoryTree, state: MemoryState): void {
    const clean = new Map([...tree].map(([path, text]) => [path, redactSecrets(text)]));
    validateTree(clean);
    atomic(this.journal, JSON.stringify({ version: 1, tree: [...clean], state } satisfies Journal));
    this.recover();
  }
  recover(): void {
    if (!existsSync(this.journal)) return;
    regular(this.journal);
    const pending = JSON.parse(readFileSync(this.journal, "utf8")) as Journal;
    if (pending.version !== 1 || pending.state.version !== 1) throw new Error("Invalid memory journal");
    const tree = new Map(pending.tree);
    validateTree(tree);
    writeMemoryTree(this.root, tree);
    writeMemoryTree(this.baseline, tree);
    this.saveState(pending.state);
    rmSync(this.journal);
  }
}
