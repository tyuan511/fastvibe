import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { mkdir, readdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { ExtensionFactory, SessionEntry } from "@earendil-works/pi-coding-agent";
import type { Conversation } from "@shared/types";
import { DEFAULT_MEMORY_CONFIG, MEMORY_CONFIG_VERSION, memoryConfigOf, type MemoryConfig, type MemoryPhase, type MemoryState } from "../../shared/memory.ts";
import { memoryCitationIds } from "../../shared/memory-citation.ts";
import type { MemoryHost, MemoryRuntime } from "./memory-host.ts";
import {
  EXTRACT_CONCURRENCY,
  MAX_PER_PASS,
  emptyState,
  failureAfter,
  parseStage1,
  pickCandidates,
  renderRawMemories,
  renderRolloutSummary,
  rolloutFileName,
  selectForConsolidation,
  staleOutputIds,
  type MemoryStateFile,
  type Stage1Output,
} from "./memory-plan.ts";
import { WORKSPACE_DIFF_FILE, consolidationPrompt, readPathPrompt, stage1Input, stage1System } from "./memory-templates.ts";
import { hasSubstance, renderRollout } from "./memory-transcript.ts";
import { changesBetween, readBaseline, readTree, removeSymlinks, renderWorkspaceDiff, validateArtifacts, writeBaseline } from "./memory-workspace.ts";

/** Where the memory lives; `index.ts` derives it from `FastVibePaths`. */
export type MemoryFiles = { memoryFile: string; memoriesDir: string; memoriesBaselineDir: string; memoryStateFile: string };

const SUMMARY_FILE = "memory_summary.md";
const ROLLOUTS_DIR = "rollout_summaries";
const RAW_FILE = "raw_memories.md";
/** A pass is tried this often while the app runs; only conversations that went quiet are read. */
const PASS_INTERVAL_MS = 15 * 60_000;
const STARTUP_DELAY_MS = 45_000;
const SAVE_DEBOUNCE_MS = 500;

function message(error: unknown): string {
  return error instanceof Error && error.message ? error.message : String(error);
}

function writeFileAtomicSync(file: string, content: string): void {
  mkdirSync(dirname(file), { recursive: true });
  const temp = `${file}.${process.pid}.tmp`;
  writeFileSync(temp, content, { mode: 0o600 });
  renameSync(temp, file);
}

async function writeFileAtomic(file: string, content: string): Promise<void> {
  await mkdir(dirname(file), { recursive: true });
  const temp = `${file}.${process.pid}.tmp`;
  await writeFile(temp, content, "utf8");
  await rename(temp, file);
}

export function readMemoryConfig(file: string): MemoryConfig {
  try {
    return memoryConfigOf(JSON.parse(readFileSync(file, "utf8")));
  } catch {
    return DEFAULT_MEMORY_CONFIG;
  }
}

function readState(file: string): MemoryStateFile {
  try {
    const parsed = JSON.parse(readFileSync(file, "utf8")) as Partial<MemoryStateFile>;
    if (parsed?.version !== 1 || typeof parsed.outputs !== "object" || parsed.outputs === null) return emptyState();
    return { ...emptyState(), ...parsed, outputs: parsed.outputs, empty: parsed.empty ?? {}, failures: parsed.failures ?? {} };
  } catch {
    return emptyState();
  }
}

async function readText(file: string): Promise<string> {
  try { return await readFile(file, "utf8"); } catch { return ""; }
}

/** Whether the folder already holds a summary in the schema the readers expect. */
function hasSummary(folder: string): boolean {
  try { return readFileSync(join(folder, SUMMARY_FILE), "utf8").split("\n", 1)[0].replace(/\r$/, "") === "v1"; } catch { return false; }
}

/**
 * Long-term memory, after Codex's (`codex-rs/memories`).
 *
 * **Stage 1** reads a conversation once it has been quiet for a while and asks the model
 * for the part worth remembering: a detailed note and a recap. **Stage 2** hands the
 * recent notes to an agent that keeps `MEMORY.md`, the handbook, and `memory_summary.md`, a
 * map small enough to sit in every prompt. A live agent is shown the map and reads the rest
 * on demand, so memory costs one section per turn and nothing else. What an agent says it
 * used (the citation block its read prompt asks for) is what keeps a conversation's memory
 * in the next consolidation.
 *
 * Both stages are background work behind one switch. Off means off: nothing is read,
 * written or injected, and what is already on disk stays until the user clears it.
 */
export class MemoryManager implements MemoryHost {
  readonly #files: MemoryFiles;
  #config: MemoryConfig;
  #state: MemoryStateFile;
  #runtime: MemoryRuntime | null = null;
  #phase: MemoryPhase = "idle";
  #listeners = new Set<(state: MemoryState) => void>();
  #running = new Set<string>();
  #pass: Promise<void> | null = null;
  #abort: AbortController | null = null;
  #generation = 0;
  #saveTimer: ReturnType<typeof setTimeout> | null = null;
  #startup: ReturnType<typeof setTimeout> | null = null;
  #interval: ReturnType<typeof setInterval> | null = null;
  #closed = false;
  /** Conversations the last pass found waiting; between passes this is as stale as the pass. */
  #pending = 0;
  #ready: boolean;

  constructor(files: MemoryFiles) {
    this.#files = files;
    this.#config = readMemoryConfig(files.memoryFile);
    this.#state = readState(files.memoryStateFile);
    this.#ready = hasSummary(files.memoriesDir);
    this.#schedule();
  }

  get config(): MemoryConfig { return this.#config; }

  state(): MemoryState {
    return {
      config: this.#config,
      phase: this.#phase,
      conversations: Object.keys(this.#state.outputs).length,
      pending: this.#pending,
      ready: this.#ready,
      ...(this.#state.lastRunAt ? { lastRunAt: this.#state.lastRunAt } : {}),
      ...(this.#state.error ? { error: this.#state.error } : {}),
      folder: this.#files.memoriesDir,
    };
  }

  onChange(listener: (state: MemoryState) => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  /** The engine hands over what the pipeline cannot reach itself; `null` on teardown. */
  attach(runtime: MemoryRuntime | null): void {
    this.#runtime = runtime;
  }

  setConversationRunning(id: string, running: boolean): void {
    if (!id) return;
    if (running) this.#running.add(id);
    else this.#running.delete(id);
  }

  async setConfig(patch: unknown): Promise<MemoryState> {
    const input = (patch ?? {}) as { enabled?: unknown; model?: unknown };
    const enabled = typeof input.enabled === "boolean" ? input.enabled : this.#config.enabled;
    // `null` clears the pin (an undefined key does not survive a remote client's JSON).
    const model = "model" in input ? memoryConfigOf({ version: MEMORY_CONFIG_VERSION, enabled, model: input.model }).model : this.#config.model;
    if (enabled === this.#config.enabled && model?.provider === this.#config.model?.provider && model?.id === this.#config.model?.id) return this.state();
    const switched = enabled !== this.#config.enabled;
    this.#config = { enabled, ...(model ? { model } : {}) };
    writeFileAtomicSync(this.#files.memoryFile, `${JSON.stringify({ version: MEMORY_CONFIG_VERSION, ...this.#config }, null, 2)}\n`);
    if (!switched) {
      // Only the model changed: the next pass uses it, nothing in flight is stopped.
    } else if (enabled) {
      this.#kick(1_000);
    } else {
      // Stop what is in flight; the files stay, since switching memory off is not asking to forget.
      this.#cancel();
    }
    this.#emit();
    return this.state();
  }

  /** 立即整理: one pass now, however long ago the last one ran. */
  async run(): Promise<MemoryState> {
    if (this.#config.enabled) await this.#runPass();
    return this.state();
  }

  /** Forget everything: the distilled notes, the handbook, the baseline and the bookkeeping. */
  async clear(): Promise<MemoryState> {
    this.#cancel();
    await this.#pass?.catch(() => undefined);
    this.#state = emptyState();
    this.#pending = 0;
    this.#ready = false;
    this.#saveNow();
    await rm(this.#files.memoriesDir, { recursive: true, force: true });
    await rm(this.#files.memoriesBaselineDir, { recursive: true, force: true });
    this.#emit();
    return this.state();
  }

  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    this.#cancel();
    if (this.#startup) clearTimeout(this.#startup);
    if (this.#interval) clearInterval(this.#interval);
    this.#saveNow();
  }

  /**
   * Inline extension of every conversation's session: Codex's read-path prompt, with the
   * summary inline, goes into the system prompt of each turn (not into the transcript).
   */
  extension(): ExtensionFactory {
    return (pi) => {
      pi.on("before_agent_start", async (event) => {
        if (!this.#config.enabled) return undefined;
        const summary = (await readText(join(this.#files.memoriesDir, SUMMARY_FILE))).trim();
        if (!summary) return undefined;
        return { systemPrompt: event.systemPrompt + readPathPrompt({ basePath: this.#files.memoriesDir, summary }) };
      });
    };
  }

  /**
   * A finished reply. When it carries a citation block, the conversations it names were
   * used: that is the signal consolidation ranks by, so what the agent reaches for stays.
   */
  noteReply(text: string, now = Date.now()): void {
    if (!this.#config.enabled || !text.includes("<oai-mem-citation>")) return;
    let changed = false;
    for (const id of memoryCitationIds(text)) {
      const output = this.#state.outputs[id];
      if (!output) continue;
      output.usageCount += 1;
      output.lastUsage = now;
      changed = true;
    }
    if (changed) this.#saveSoon();
  }

  // ---------------------------------------------------------------------------------

  #schedule(): void {
    this.#startup = setTimeout(() => { if (this.#config.enabled) void this.#runPass(); }, STARTUP_DELAY_MS);
    this.#interval = setInterval(() => { if (this.#config.enabled) void this.#runPass(); }, PASS_INTERVAL_MS);
    this.#startup.unref?.();
    this.#interval.unref?.();
  }

  #kick(delayMs: number): void {
    const timer = setTimeout(() => { if (this.#config.enabled && !this.#closed) void this.#runPass(); }, delayMs);
    timer.unref?.();
  }

  #cancel(): void {
    this.#generation += 1;
    this.#abort?.abort();
  }

  #emit(): void {
    const state = this.state();
    for (const listener of this.#listeners) {
      try { listener(state); } catch { /* one broken listener must not stop the others */ }
    }
  }

  #saveSoon(): void {
    if (this.#saveTimer) return;
    this.#saveTimer = setTimeout(() => this.#saveNow(), SAVE_DEBOUNCE_MS);
    this.#saveTimer.unref?.();
  }

  #saveNow(): void {
    if (this.#saveTimer) { clearTimeout(this.#saveTimer); this.#saveTimer = null; }
    try { writeFileAtomicSync(this.#files.memoryStateFile, `${JSON.stringify(this.#state)}\n`); } catch (error) {
      console.warn("[memory] could not save state", message(error));
    }
  }

  #runPass(): Promise<void> {
    if (this.#pass) return this.#pass;
    const pass = this.#pipeline().finally(() => {
      if (this.#pass === pass) this.#pass = null;
    });
    this.#pass = pass;
    return pass;
  }

  async #pipeline(): Promise<void> {
    const runtime = this.#runtime;
    if (!runtime || !this.#config.enabled || this.#closed) return;
    const generation = this.#generation;
    const controller = new AbortController();
    this.#abort = controller;
    const live = (): boolean => generation === this.#generation && !controller.signal.aborted && this.#config.enabled;
    try {
      // A new pass starts clean; what fails during it (one conversation, the consolidation) sets it again.
      delete this.#state.error;
      this.#phase = "extracting";
      this.#emit();
      this.#prune();
      await this.#extract(runtime, controller.signal, live);
      if (!live()) return;
      this.#phase = "consolidating";
      this.#emit();
      await this.#consolidate(runtime, controller.signal, live);
      if (!live()) return;
      this.#state.lastRunAt = Date.now();
    } catch (error) {
      if (live()) this.#state.error = message(error);
    } finally {
      this.#phase = "idle";
      if (this.#abort === controller) this.#abort = null;
      this.#saveNow();
      this.#emit();
    }
  }

  /** What nothing has used for the whole window goes; so does the memory of a conversation that was deleted. */
  #prune(): void {
    for (const id of staleOutputIds(Object.values(this.#state.outputs), Date.now())) delete this.#state.outputs[id];
    const known = new Set((this.#runtime?.conversations() ?? []).map((conversation) => conversation.id));
    for (const id of Object.keys(this.#state.outputs)) if (!known.has(id)) delete this.#state.outputs[id];
    for (const id of Object.keys(this.#state.empty)) if (!known.has(id)) delete this.#state.empty[id];
    for (const id of Object.keys(this.#state.failures)) if (!known.has(id)) delete this.#state.failures[id];
  }

  async #extract(runtime: MemoryRuntime, signal: AbortSignal, live: () => boolean): Promise<void> {
    const conversations = runtime.conversations();
    const mtimes = new Map<string, number>();
    await Promise.all(conversations.map(async (conversation) => {
      if (!conversation.sessionFile) return;
      try { mtimes.set(conversation.id, (await stat(conversation.sessionFile)).mtimeMs); } catch { /* no transcript yet */ }
    }));

    const waiting = pickCandidates(conversations, mtimes, this.#state, this.#running, Date.now());
    this.#pending = waiting.length;
    const queue = waiting.slice(0, MAX_PER_PASS);
    let next = 0;
    const worker = async (): Promise<void> => {
      while (live()) {
        const candidate = queue[next++];
        if (!candidate) return;
        await this.#extractOne(runtime, candidate.conversation, candidate.sourceUpdatedAt, signal, live);
        this.#pending = Math.max(0, this.#pending - 1);
        this.#saveNow();
        this.#emit();
      }
    };
    await Promise.all(Array.from({ length: Math.min(EXTRACT_CONCURRENCY, queue.length) }, worker));
  }

  async #extractOne(runtime: MemoryRuntime, conversation: Conversation, sourceUpdatedAt: number, signal: AbortSignal, live: () => boolean): Promise<void> {
    const id = conversation.id;
    try {
      let branch: SessionEntry[];
      try {
        branch = await runtime.loadBranch(conversation.sessionFile!, conversation.cwd);
      } catch {
        // A transcript that cannot be read (too large, half-written) will not get better by retrying.
        this.#state.empty[id] = sourceUpdatedAt;
        return;
      }
      const rendered = renderRollout(branch, runtime.inputBudgetChars(this.#config.model));
      if (!hasSubstance(rendered)) {
        this.#state.empty[id] = sourceUpdatedAt;
        return;
      }
      const answer = await runtime.complete(
        stage1System(),
        stage1Input({ rolloutPath: conversation.sessionFile!, rolloutCwd: conversation.cwd, contents: rendered.text }),
        signal,
        this.#config.model,
      );
      if (!live()) return;
      const result = parseStage1(answer);
      if (!result) throw new Error("unreadable extraction result");
      delete this.#state.failures[id];
      // Codex: no note or no recap is "nothing worth saving", not a half result to keep.
      if (!result.rawMemory || !result.rolloutSummary) {
        this.#state.empty[id] = sourceUpdatedAt;
        delete this.#state.outputs[id];
        return;
      }
      const previous = this.#state.outputs[id];
      this.#state.outputs[id] = {
        conversationId: id,
        cwd: conversation.cwd,
        rolloutPath: conversation.sessionFile!,
        createdAt: conversation.createdAt,
        sourceUpdatedAt,
        generatedAt: Date.now(),
        rawMemory: result.rawMemory,
        rolloutSummary: result.rolloutSummary,
        slug: result.slug,
        usageCount: previous?.usageCount ?? 0,
        ...(previous?.lastUsage ? { lastUsage: previous.lastUsage } : {}),
      };
    } catch (error) {
      if (!live()) return;
      this.#state.failures[id] = failureAfter(this.#state.failures[id], sourceUpdatedAt, Date.now());
      this.#state.error = message(error);
    }
  }

  /**
   * Phase 2. The folder is brought in line with the selection, compared with the baseline of the
   * last successful run, and the agent is run only when that comparison (or a missing artifact)
   * says there is something to do.
   */
  async #consolidate(runtime: MemoryRuntime, signal: AbortSignal, live: () => boolean): Promise<void> {
    const folder = this.#files.memoriesDir;
    const selected = selectForConsolidation(Object.values(this.#state.outputs), Date.now());
    const baseline = await readBaseline(this.#files.memoriesBaselineDir);
    // Never consolidated and nothing to consolidate: there is no folder to keep in line.
    if (selected.length === 0 && baseline.size === 0) return;

    await removeSymlinks(folder);
    await this.#syncArtifacts(selected);
    if (!live()) return;
    const current = await readTree(folder);
    const invalid = await validateArtifacts(folder);
    if (changesBetween(baseline, current).length === 0 && invalid === null) {
      this.#ready = true;
      return;
    }

    const diffFile = join(folder, WORKSPACE_DIFF_FILE);
    await writeFileAtomic(diffFile, renderWorkspaceDiff(baseline, current));
    try {
      await runtime.runAgent({ cwd: folder, task: consolidationPrompt(folder), signal, ...(this.#config.model ? { model: this.#config.model } : {}) });
    } finally {
      await rm(diffFile, { force: true });
    }
    if (!live()) return;
    const problem = await validateArtifacts(folder);
    if (problem) throw new Error(`consolidation failed: ${problem}`);
    await writeBaseline(this.#files.memoriesBaselineDir, await readTree(folder));
    this.#ready = true;
  }

  /** Make the folder's input files match the selection exactly: write what is selected, delete what is not. */
  async #syncArtifacts(selected: Stage1Output[]): Promise<void> {
    const folder = this.#files.memoriesDir;
    const dir = join(folder, ROLLOUTS_DIR);
    await mkdir(dir, { recursive: true });
    const names = new Map(selected.map((output) => [rolloutFileName(output), output] as const));
    for (const [name, output] of names) await writeFileAtomic(join(dir, name), renderRolloutSummary(output));
    for (const name of await readdir(dir).catch(() => [] as string[])) {
      if (!names.has(name) && name.endsWith(".md")) await rm(join(dir, name), { force: true });
    }
    await writeFileAtomic(join(folder, RAW_FILE), renderRawMemories(selected));
  }
}

/** Leftovers of the SQLite / embedding memory this replaced; nothing reads them any more. */
export function removeLegacyMemory(runtimeRoot: string): string[] {
  const removed: string[] = [];
  for (const name of ["memory.sqlite", "memory.sqlite-wal", "memory.sqlite-shm", join("models", "memory")]) {
    const target = join(runtimeRoot, name);
    if (!existsSync(target)) continue;
    try {
      rmSync(target, { recursive: true, force: true });
      removed.push(name);
    } catch { /* in use or read-only: it is only disk space */ }
  }
  return removed;
}
