// SPDX-License-Identifier: MIT
// FastVibe-specific Pi SDK adapter; source and adaptation boundaries are recorded in ../core/NOTICE.md.
import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID, createHash } from "node:crypto";
import { chmodSync, closeSync, existsSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, realpathSync, writeSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { createAgentSession, DefaultResourceLoader, SessionManager, SettingsManager, type AgentSession, type ExtensionFactory, type ModelRuntime, type SessionEntry } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import type { WorkerReport } from "../core/engine.ts";
import type { WorkerToken } from "./engine.ts";
import { PiLedger, type PiReceipt, type PiSessionState } from "./pi-ledger.ts";
import { assertShadowPath } from "./schema.ts";
import type { ShadowStore } from "./store.ts";

export const SUPPORTED_SCRATCH_PI_VERSION = "1.3.0";
const TAG = "__fastvibeDsh";
const READ = "fastvibe-dsh-read";
const TURN = "fastvibe-dsh-turn";
const REPORT = "fastvibe-dsh-report";
interface InputTag { version: 1; sessionKey: string; requestId: string; epoch: number; binding: WorkerToken }
type Tagged = AgentMessage & { __fastvibeDsh?: InputTag };
interface Dispatch { requestId: string; epoch: number; binding: WorkerToken; tagged?: boolean }
interface Turn extends Dispatch { turnId: string; requestIds: string[]; reportingIds: string[] }
interface Marker { sessionKey: string; epoch: number; binding: WorkerToken; turnId: string; requestIds: string[]; at: number; report?: WorkerReport }
interface Owner { pid: number; nonce: string }
export interface ScratchPiOptions {
  store: ShadowStore; root: string; binding: WorkerToken;
  modelRuntime: ModelRuntime; model: NonNullable<AgentSession["model"]>;
  extensions?: ExtensionFactory[];
  context?: () => Record<string, unknown>;
  /** Explicit isolated role identity; default is the stable Ticket Worker. */
  sessionKey?: string;
  activeTools?: readonly string[];
  validate?: () => void;
  onPersisted?: (token: WorkerToken, inputIds: string[]) => void;
  onRead?: (token: WorkerToken, inputIds: string[]) => boolean | void;
  onReport?: (token: WorkerToken, report: WorkerReport) => boolean | void;
}
export interface PiSubmission { requestId: string; text: string; inputIds?: string[]; mode?: "steer" | "followUp" }
export interface PiSubmissionResult { receipt: PiReceipt; reused: boolean; completion: Promise<void> }
const copy = <T>(value: T): T => structuredClone(value);
const same = (a: WorkerToken, b: WorkerToken): boolean => a.ticketId === b.ticketId && a.assignmentId === b.assignmentId
  && a.generation === b.generation && a.claimToken === b.claimToken;
const digest = (value: string): string => createHash("sha256").update(value).digest("hex");
function noSymlink(path: string): void {
  try { if (lstatSync(path).isSymbolicLink()) throw new Error("Scratch paths must not contain symbolic links"); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
}
const alive = (pid: number): boolean => { try { process.kill(pid, 0); return true; } catch (e) { return (e as NodeJS.ErrnoException).code !== "ESRCH"; } };
function checkVersion(): void {
  for (const name of ["@earendil-works/pi-coding-agent", "@earendil-works/pi-agent-core"]) {
    const version = JSON.parse(readFileSync(join(dirname(fileURLToPath(import.meta.resolve(name))), "../package.json"), "utf8")).version;
    if (version !== SUPPORTED_SCRATCH_PI_VERSION) throw new Error(`Unsupported scratch Pi version: ${name} ${version}`);
  }
}

/** A real SDK laboratory with an explicit ModelRuntime and scratch-only settings, resources and history. */
export class ScratchPiSession {
  readonly sessionKey: string;
  readonly ledger: PiLedger;
  session!: AgentSession;
  private readonly options: Omit<ScratchPiOptions, "modelRuntime" | "model">;
  private state: PiSessionState;
  private readonly nonce: string;
  private readonly scope = new AsyncLocalStorage<Dispatch | undefined>();
  private readonly promptDepth = new AsyncLocalStorage<number>();
  private turn?: Turn;
  private nextReads: string[] = [];
  private readonly pending = new Map<string, Promise<void>>();
  private readonly activating = new Map<string, Promise<PiSubmissionResult>>();
  private disposed = false;
  private fault?: Error;
  private constructor(options: Omit<ScratchPiOptions, "modelRuntime" | "model">, state: PiSessionState, nonce: string) {
    this.options = options; this.state = state; this.nonce = nonce;
    this.sessionKey = state.sessionKey; this.ledger = new PiLedger(options.store);
  }
  /** Reconcile a quiet Worker journal without constructing an SDK or selecting a model. */
  static reconcileSaved(store: ShadowStore, rootInput: string, binding: WorkerToken): void {
    const root = realpathSync(rootInput), sessionKey = `worker-${binding.ticketId}`;
    store.atomic(() => {
      const state = new PiLedger(store).session(sessionKey);
      const owner = store.get<Owner | null>(`pi:owner:${sessionKey}`);
      const base = join(root, digest(sessionKey));
      if (!state || !same(state.binding, binding) || state.root !== root || state.cwd !== join(base, "workspace")
        || state.sessionFile !== join(base, "sessions", `${digest(sessionKey)}.jsonl`) || (owner && alive(owner.pid))) throw new Error("Saved Worker journal is not quiet or belongs to another identity");
      for (const path of [root, base, state.cwd, dirname(state.sessionFile), state.sessionFile]) { assertShadowPath(path); noSymlink(path); }
      const adapter = new ScratchPiSession({ store, root, binding }, state, "quiet-reconcile");
      if (adapter.disk()[0]?.dshStoreId !== store.get("pi:store-id")) throw new Error("Saved Worker journal belongs to another store");
      adapter.reconcile();
    });
  }
  static async open(options: ScratchPiOptions): Promise<ScratchPiSession> {
    checkVersion();
    assertShadowPath(join(resolve(options.root), "scratch.guard"));
    mkdirSync(options.root, { recursive: true, mode: 0o700 });
    const root = realpathSync(options.root);
    const ledger = new PiLedger(options.store);
    const sessionKey = options.sessionKey ?? `worker-${options.binding.ticketId}`;
    if (options.sessionKey && (!/^(reviewer|coordinator)-[A-Za-z0-9_.:-]{1,480}$/.test(sessionKey) && sessionKey !== `worker-${options.binding.ticketId}`)) throw new Error("Invalid isolated Pi role Session key");
    const activeTools = [...(options.activeTools ?? ["dsh_report"])];
    if (activeTools.some(name => !/^[a-z][a-z0-9_]*$/.test(name)) || new Set(activeTools).size !== activeTools.length) throw new Error("Invalid isolated Pi role tools");
    const base = join(root, digest(sessionKey));
    const cwd = join(base, "workspace"), sessionDir = join(base, "sessions"), agentDir = join(base, "agent");
    for (const path of [base, cwd, sessionDir, agentDir]) { assertShadowPath(path); noSymlink(path); mkdirSync(path, { recursive: true, mode: 0o700 }); chmodSync(path, 0o700); }
    const sessionFile = join(sessionDir, `${digest(sessionKey)}.jsonl`);
    assertShadowPath(sessionFile); noSymlink(sessionFile);
    const nonce = randomUUID();
    let state!: PiSessionState;
    const dbId = options.store.atomic(() => {
      const ownerKey = `pi:owner:${sessionKey}`;
      const owner = options.store.get<Owner | null>(ownerKey);
      if (owner && alive(owner.pid)) throw new Error("Scratch Pi Session already has a live owner");
      const previous = ledger.session(sessionKey);
      state = { sessionKey, ticketId: options.binding.ticketId, root, cwd, sessionFile,
        epoch: (previous?.epoch ?? 0) + 1, binding: copy(options.binding), paused: previous?.paused ?? false };
      // saveSession checks immutable identity before we touch any existing transcript.
      ledger.saveSession(state);
      const id = options.store.get<string>("pi:store-id") ?? randomUUID(); options.store.set("pi:store-id", id);
      options.store.set(ownerKey, { pid: process.pid, nonce });
      return id;
    });
    const adapter = new ScratchPiSession({ ...options, root }, state, nonce);
    try {
      if (!existsSync(sessionFile)) {
        if (ledger.list(sessionKey).length) throw new Error("Scratch Session transcript is missing; reconciliation is required");
        // The sole initial write, with an SDK-produced v3 header; all later writes belong to SessionManager.
        const header = SessionManager.inMemory(cwd, { id: digest(sessionKey) }).getHeader();
        const fd = openSync(sessionFile, "wx", 0o600);
        try { writeSync(fd, JSON.stringify({ ...header, dshStoreId: dbId }) + "\n"); fsyncSync(fd); } finally { closeSync(fd); }
      }
      const disk = adapter.disk();
      if (disk[0]?.dshStoreId !== dbId) throw new Error("Scratch transcript belongs to another receipt store");
      const manager = SessionManager.open(sessionFile, sessionDir, cwd);
      const settingsManager = SettingsManager.inMemory({ compaction: { enabled: false }, retry: { enabled: false }, cacheWarming: "off" });
      const reportExtension: ExtensionFactory = pi => {
        if (!activeTools.includes("dsh_report")) return;
        pi.registerTool({ name: "dsh_report", label: "DSH report", description: "Record the current assignment's structured report.",
          parameters: Type.Object({ state: Type.Union(["progress", "waiting", "ready", "blocked", "failed", "dropped"].map(value => Type.Literal(value))),
            summary: Type.String(), question: Type.Optional(Type.Union([Type.String(), Type.Null()])), askedBy: Type.Optional(Type.String()), answers: Type.Optional(Type.String()) }),
          execute: async (_id, input) => {
            const accepted = adapter.report(input as WorkerReport);
            return { content: [{ type: "text", text: accepted ? "Report recorded" : "Stale or unread report refused" }], details: { accepted }, isError: !accepted, terminate: accepted };
          } });
      };
      const resourceLoader = new DefaultResourceLoader({ cwd, agentDir, settingsManager, noSkills: true, noContextFiles: true, noExtensions: true, noPromptTemplates: true,
        extensionFactories: [{ name: "dsh-reports", factory: reportExtension }, ...(options.extensions ?? []).map((factory, i) => ({ name: `scratch-${i}`, factory }))] });
      await resourceLoader.reload();
      const result = await createAgentSession({ cwd, agentDir, modelRuntime: options.modelRuntime, model: options.model, sessionManager: manager,
        settingsManager, resourceLoader, tools: activeTools });
      adapter.session = result.session;
      await adapter.session.bindExtensions({ mode: "rpc" });
      adapter.session.setActiveToolsByName(activeTools);
      adapter.install();
      adapter.reconcile();
      return adapter;
    } catch (error) { adapter.session?.dispose(); adapter.release(); throw error; }
  }
  get(requestId: string): PiReceipt | undefined { return this.ledger.get(this.sessionKey, requestId); }
  private ownerKey(): string { return `pi:owner:${this.sessionKey}`; }
  private valid(epoch: number, binding: WorkerToken, allowPaused = false): boolean {
    const live = this.ledger.session(this.sessionKey);
    const owner = this.options.store.get<Owner | null>(this.ownerKey());
    return !this.disposed && !this.fault && !!live && owner?.nonce === this.nonce && live.epoch === epoch && same(live.binding, binding) && (allowPaused || !live.paused);
  }
  private assertLive(): void {
    if (!this.valid(this.state.epoch, this.state.binding)) throw this.fault ?? new Error("Scratch Pi Session is stopped, disposed or superseded");
    this.options.validate?.();
  }
  private disk(): Record<string, unknown>[] {
    for (const path of [dirname(dirname(this.state.sessionFile)), dirname(this.state.sessionFile), this.state.sessionFile]) noSymlink(path);
    assertShadowPath(this.state.sessionFile);
    const text = readFileSync(this.state.sessionFile, "utf8");
    const rows = text.split("\n").filter(line => line.trim()).map(line => JSON.parse(line) as Record<string, unknown>);
    if (rows[0]?.type !== "session" || rows[0].version !== 3 || rows[0].id !== digest(this.sessionKey) || rows[0].cwd !== this.state.cwd) throw new Error("Invalid scratch Session header");
    const ids = new Set<string>();
    for (const row of rows.slice(1)) {
      if (typeof row.id !== "string" || ids.has(row.id) || (row.parentId !== null && !ids.has(row.parentId as string))) throw new Error("Invalid scratch Session entry chain");
      ids.add(row.id);
    }
    return rows;
  }
  private tag(message: AgentMessage): InputTag | undefined {
    const tag = (message as Tagged)[TAG];
    if (!tag) return undefined;
    if (tag.version !== 1 || tag.sessionKey !== this.sessionKey || typeof tag.requestId !== "string"
      || !Number.isSafeInteger(tag.epoch) || tag.epoch < 0 || !tag.binding
      || tag.binding.ticketId !== this.state.ticketId || typeof tag.binding.assignmentId !== "string"
      || !Number.isSafeInteger(tag.binding.generation) || !Number.isSafeInteger(tag.binding.claimToken)) {
      throw new Error("Invalid scratch input identity");
    }
    return tag;
  }
  private install(): void {
    // Input/before-start hooks may submit their own prompts before the original
    // object exists. Nested SDK submissions must not inherit the adapter's identity.
    const sessionPrompt = this.session.prompt.bind(this.session);
    this.session.prompt = async (text, options) => {
      const depth = this.promptDepth.getStore() ?? 0;
      await this.promptDepth.run(depth + 1, () => depth
        ? this.scope.run(undefined, () => sessionPrompt(text, options))
        : sessionPrompt(text, options));
    };
    const sessionSteer = this.session.steer.bind(this.session), sessionFollowUp = this.session.followUp.bind(this.session);
    this.session.steer = (...args) => this.scope.run(undefined, () => sessionSteer(...args));
    this.session.followUp = (...args) => this.scope.run(undefined, () => sessionFollowUp(...args));
    const agent = this.session.agent;
    const decorate = (message: AgentMessage): void => {
      const dispatch = this.scope.getStore();
      if (!dispatch || message.role !== "user" || dispatch.tagged) return;
      if (!this.valid(dispatch.epoch, dispatch.binding)) throw new Error("Scratch input cancelled during SDK preflight");
      dispatch.tagged = true;
      (message as Tagged)[TAG] = { version: 1, sessionKey: this.sessionKey, requestId: dispatch.requestId, epoch: dispatch.epoch, binding: copy(dispatch.binding) };
    };
    const prompt = agent.prompt.bind(agent), steer = agent.steer.bind(agent), followUp = agent.followUp.bind(agent);
    const boundary = agent as unknown as { prompt: (messages: AgentMessage | AgentMessage[]) => Promise<void> };
    boundary.prompt = async messages => { for (const message of Array.isArray(messages) ? messages : [messages]) decorate(message); await prompt(messages); };
    agent.steer = message => { decorate(message); steer(message); };
    agent.followUp = message => { decorate(message); followUp(message); };
    const convert = agent.convertToLlm.bind(agent);
    agent.convertToLlm = async messages => {
      this.assertLive();
      const result = await convert(messages);
      this.nextReads = [...new Set(messages.flatMap(message => { const tag = this.tag(message); return tag ? [tag.requestId] : []; }))];
      return result.map(message => { const { __fastvibeDsh: _identity, ...plain } = message as typeof message & Tagged; return plain; });
    };
    const stream = agent.streamFunction;
    agent.streamFunction = (model, context, config) => {
      this.assertLive();
      const epoch = this.state.epoch, binding = copy(this.state.binding);
      const sessionRequest = config?.sessionId === this.session.sessionId;
      if (sessionRequest) this.reconcile();
      const live = { role: "system" as const, content: JSON.stringify({ dsh_context: this.options.context?.() ?? {}, binding, sessionKey: this.sessionKey, epoch }), timestamp: Date.now() };
      if (!this.valid(epoch, binding)) throw new Error("Scratch request was superseded before provider dispatch");
      const withContext = { ...context, messages: [live, ...context.messages] };
      if (!sessionRequest) return stream(model, withContext, config);
      const requestIds = this.nextReads.filter(id => { const receipt = this.get(id); return receipt?.entryId && same(receipt.entryBinding ?? receipt.binding, binding) && !["handled", "rejected", "stopped"].includes(receipt.status); });
      // Compaction can replace raw input with a summary. A later report may
      // continue previously read work, without claiming that raw input was read again.
      const reportingIds = [...new Set([...requestIds, ...this.ledger.list(this.sessionKey)
        .filter(receipt => receipt.reads.some(read => same(read.binding, binding))).map(receipt => receipt.requestId)])];
      const turn: Turn = { requestId: requestIds[0] ?? "", epoch, binding, turnId: randomUUID(), requestIds, reportingIds };
      this.turn = undefined;
      const marker: Marker = { sessionKey: this.sessionKey, epoch: turn.epoch, binding: turn.binding, turnId: turn.turnId, requestIds, at: Date.now() };
      // A synchronous provider failure is not evidence that it received input.
      // Record the opportunity only after the provider returned its stream.
      const dispatched = stream(model, withContext, config);
      return Promise.resolve(dispatched).then(response => {
        this.turn = turn;
        this.options.store.atomic(() => {
          this.assertLive();
          this.recordMarker(READ, marker, true);
          // Domain and Pi read commit together; JSONL is their audit mirror.
          this.options.store.afterCommit(() => {
            try { this.session.sessionManager.appendCustomEntry(READ, marker); }
            catch (error) { this.fault = error as Error; }
          });
        });
        return response;
      });
    };
    this.session.subscribe(event => {
      if (event.type === "message_end" && this.tag(event.message)) queueMicrotask(() => { try { this.reconcile(); } catch (error) { this.fault = error as Error; void this.session.abort(); } });
      if (event.type === "turn_end" && this.turn && this.valid(this.turn.epoch, this.turn.binding)) {
        const marker: Marker = { ...this.turn, requestIds: this.turn.reportingIds, sessionKey: this.sessionKey, at: Date.now() };
        this.session.sessionManager.appendCustomEntry(TURN, marker); this.recordMarker(TURN, marker, true);
      }
      if (event.type === "agent_settled") {
        this.reconcile();
        for (const receipt of this.ledger.list(this.sessionKey)) if (receipt.reads.some(read => read.epoch === this.state.epoch) && !["handled", "rejected", "stopped"].includes(receipt.status)) this.ledger.patch(this.sessionKey, receipt.requestId, { status: "settled" });
      }
    });
  }
  private recordMarker(kind: string, marker: Marker, notify: boolean, acceptReport = false): void {
    if (marker.sessionKey !== this.sessionKey) return;
    for (const id of marker.requestIds) {
      const receipt = this.get(id); if (!receipt?.entryId) continue;
      this.options.store.atomic(() => {
        if (kind === READ && notify && !receipt.reads.some(read => read.turnId === marker.turnId)) {
          this.ledger.patch(this.sessionKey, id, { stage: receipt.stage === "reported" ? "reported" : "read", reads: [...receipt.reads, { entryId: receipt.entryId!, turnId: marker.turnId, binding: marker.binding, epoch: marker.epoch, at: marker.at }] });
          if (notify && this.valid(marker.epoch, marker.binding)) {
            this.options.validate?.();
            if (this.options.store.atomic(() => this.options.onRead?.(marker.binding, receipt.inputIds)) === false) throw new Error("Domain refused the SDK input read");
          }
        }
        if (kind === TURN && !receipt.turns.some(turn => turn.turnId === marker.turnId)) this.ledger.patch(this.sessionKey, id, { turns: [...receipt.turns, { turnId: marker.turnId, binding: marker.binding, epoch: marker.epoch, at: marker.at }] });
        if (kind === REPORT && marker.report) {
          const committed = receipt.reports.find(report => report.turnId === marker.turnId);
          const read = receipt.reads.filter(read => same(read.binding, marker.binding)).at(-1);
          if (acceptReport && !committed && read) {
            this.ledger.patch(this.sessionKey, id, { stage: "reported", reports: [...receipt.reports, { turnId: marker.turnId, readTurnId: read.turnId, binding: marker.binding, epoch: marker.epoch, at: marker.at, report: marker.report }] });
          } else if (!committed || committed.epoch !== marker.epoch || !same(committed.binding, marker.binding)
            || JSON.stringify(committed.report) !== JSON.stringify(marker.report)) {
            throw new Error("Report journal has no committed acceptance; reconciliation required");
          }
        }
      });
    }
  }
  private reconcile(): void {
    const rows = this.disk(); chmodSync(this.state.sessionFile, 0o600);
    for (const row of rows) {
      if (row.type !== "message") continue;
      const message = row.message as Tagged; const tag = message && this.tag(message); if (!tag) continue;
      const receipt = this.get(tag.requestId); if (!receipt) throw new Error("Transcript contains an unregistered DSH request");
      if (receipt.entryId && receipt.entryId !== row.id) throw new Error("DSH request has duplicate transcript entries");
      if (!receipt.entryId) this.options.store.atomic(() => {
        this.ledger.patch(this.sessionKey, receipt.requestId, { stage: "persisted", entryId: String(row.id), entryEpoch: tag.epoch, entryBinding: tag.binding });
        if (this.valid(tag.epoch, tag.binding)) this.options.onPersisted?.(tag.binding, receipt.inputIds);
      });
    }
    for (const row of rows) if (row.type === "custom" && [READ, TURN, REPORT].includes(row.customType as string)) this.recordMarker(String(row.customType), row.data as Marker, false);
    for (const receipt of this.ledger.list(this.sessionKey)) {
      if (!receipt.entryId) continue;
      const entry = rows.find(row => row.id === receipt.entryId);
      if (!entry) throw new Error("Persisted request entry is missing from transcript");
      const tag = entry.type === "message" && this.tag(entry.message as Tagged);
      if (!tag || tag.requestId !== receipt.requestId || tag.epoch !== receipt.entryEpoch
        || !receipt.entryBinding || !same(tag.binding, receipt.entryBinding)) throw new Error("Persisted request entry identity is inconsistent");
    }
  }
  /** Durable inbox only: no provider call or JSONL user entry. */
  prepare(input: PiSubmission): PiReceipt {
    this.assertLive();
    const previous = this.get(input.requestId);
    if (previous && !same(previous.binding, this.state.binding)) throw new Error("Prepared Pi input belongs to another binding");
    return this.ledger.accept({ sessionKey: this.sessionKey, requestId: input.requestId, text: input.text, inputIds: input.inputIds ?? [], mode: input.mode ?? "steer", binding: this.state.binding, epoch: this.state.epoch }).receipt;
  }
  async activate(requestId: string): Promise<PiSubmissionResult> {
    this.assertLive(); this.reconcile();
    const receipt = this.get(requestId);
    if (!receipt || !same(receipt.binding, this.state.binding)) throw new Error("Prepared Pi input belongs to another binding");
    const activating = this.activating.get(requestId);
    if (activating) return { ...await activating, reused: true };
    const pending = this.pending.get(requestId);
    if (pending) return { receipt, reused: true, completion: pending };
    if (receipt.entryId || ["handled", "rejected", "stopped"].includes(receipt.status)) return { receipt, reused: true, completion: Promise.resolve() };
    const run = this.dispatch(receipt); this.activating.set(requestId, run);
    try { return await run; } finally { if (this.activating.get(requestId) === run) this.activating.delete(requestId); }
  }
  async submit(input: PiSubmission): Promise<PiSubmissionResult> {
    this.assertLive();
    const accepted = this.ledger.accept({ sessionKey: this.sessionKey, requestId: input.requestId, text: input.text, inputIds: input.inputIds ?? [], mode: input.mode ?? "steer", binding: this.state.binding, epoch: this.state.epoch });
    if (accepted.reused) return { ...accepted, completion: this.pending.get(input.requestId) ?? Promise.resolve() };
    return this.dispatch(accepted.receipt);
  }
  private async dispatch(receipt: PiReceipt): Promise<PiSubmissionResult> {
    this.assertLive();
    const dispatch: Dispatch = { requestId: receipt.requestId, epoch: this.state.epoch, binding: copy(this.state.binding) };
    let resolve!: () => void, reject!: (error: unknown) => void;
    const ready = new Promise<void>((yes, no) => { resolve = yes; reject = no; });
    const run = this.promptDepth.run(0, () => this.scope.run(dispatch, () => this.session.prompt(receipt.text, { expandPromptTemplates: false, streamingBehavior: receipt.mode, source: "extension", preflightResult: disposition => {
      if (!this.valid(dispatch.epoch, dispatch.binding)) { reject(new Error("Scratch preflight was superseded")); return; }
      this.ledger.patch(this.sessionKey, receipt.requestId, { status: disposition === "handled" ? "handled" : "queued" }); resolve();
    } })));
    const completion = run.then(async () => { await this.session.waitForIdle(); this.reconcile(); }).catch(error => {
      const current = this.get(receipt.requestId);
      if (current && !current.entryId) this.ledger.patch(this.sessionKey, receipt.requestId, { status: current.status === "stopped" ? "stopped" : this.valid(dispatch.epoch, dispatch.binding) ? "rejected" : "uncertain" });
      reject(error); throw error;
    });
    this.pending.set(receipt.requestId, completion);
    void completion.finally(() => { if (this.pending.get(receipt.requestId) === completion) this.pending.delete(receipt.requestId); }).catch(() => {});
    await ready;
    return { receipt: this.get(receipt.requestId)!, reused: false, completion };
  }
  async recover(requestId: string): Promise<PiSubmissionResult> {
    this.assertLive(); this.reconcile();
    const receipt = this.get(requestId); if (!receipt) throw new Error("Unknown Pi request");
    if (receipt.entryId || ["handled", "rejected", "stopped"].includes(receipt.status)) return { receipt, reused: true, completion: Promise.resolve() };
    if (this.pending.has(requestId)) throw new Error("Pi request still has a live dispatch");
    return this.dispatch(receipt);
  }
  report(report: WorkerReport, captured = this.turn): boolean {
    if (!captured || !this.turn || captured.turnId !== this.turn.turnId || !this.valid(captured.epoch, captured.binding)) return false;
    const ids = captured.reportingIds ?? captured.requestIds;
    if (!ids.length || ids.some(id => !this.turn!.reportingIds.includes(id))) return false;
    const receipts = ids.map(id => this.get(id));
    if (receipts.some(receipt => !receipt?.reads.some(read => same(read.binding, captured.binding)))) return false;
    const previous = receipts.flatMap(receipt => receipt!.reports.filter(record => record.turnId === captured.turnId));
    if (previous.length) return previous.length === receipts.length && previous.every(record => JSON.stringify(record.report) === JSON.stringify(report));
    const marker: Marker = { ...captured, requestIds: ids, sessionKey: this.sessionKey, at: Date.now(), report };
    const refused = Symbol("report refused");
    try {
      return this.options.store.atomic(() => {
        if (!this.valid(captured.epoch, captured.binding)) return false;
        if (this.options.store.atomic(() => { this.options.validate?.(); return this.options.onReport?.(captured.binding, report); }) === false) throw refused;
        this.recordMarker(REPORT, marker, false, true);
        // Domain callback and receipt commit together. JSONL is an audit mirror;
        // it can never authorize a report after a SQLite rollback.
        this.options.store.afterCommit(() => {
          try { this.session.sessionManager.appendCustomEntry(REPORT, marker); }
          catch (error) { this.fault = error as Error; }
        });
        return true;
      });
    } catch (error) { if (error === refused) return false; throw error; }
  }
  private async quiesce(paused: boolean, status: "stopped" | "uncertain"): Promise<void> {
    this.state = { ...this.state, epoch: this.state.epoch + 1, paused }; this.ledger.saveSession(this.state);
    this.session.clearQueue();
    for (const receipt of this.ledger.list(this.sessionKey)) if (!receipt.entryId && !["handled", "rejected"].includes(receipt.status)
      && !(status === "uncertain" && receipt.status === "stopped")) this.ledger.patch(this.sessionKey, receipt.requestId, { status });
    await this.session.abort();
  }
  async stop(): Promise<void> {
    if (this.disposed) return;
    await this.quiesce(true, "stopped");
  }
  async resume(): Promise<void> { if (this.disposed) throw new Error("Scratch Session disposed"); this.state = { ...this.state, paused: false }; this.ledger.saveSession(this.state); }
  async continue(): Promise<void> {
    this.assertLive(); await this.session.waitForIdle(); this.assertLive();
    const last = this.session.sessionManager.buildSessionProjection().entries.filter(entry => entry.messages.length).at(-1)?.sourceEntry;
    if (last?.type === "message" && last.message.role === "assistant" && ["error", "aborted", "length"].includes(last.message.stopReason)) {
      this.session.sessionManager.appendContextEdit(last.id, null); this.session.refreshContext();
    }
    const raw = this.session as unknown as { _startRun: (trigger: unknown) => Promise<void>; _prepareRun: (trigger: unknown) => Promise<unknown[]> };
    if (typeof raw._startRun !== "function" || typeof raw._prepareRun !== "function") throw new Error("Unsupported Pi continuation internals");
    const prepare = raw._prepareRun;
    raw._prepareRun = async () => [];
    try { await raw._startRun.call(this.session, { messageType: "user", prompt: "" }); } finally { raw._prepareRun = prepare; }
  }
  async reload(): Promise<void> { this.assertLive(); await this.session.waitForIdle(); this.assertLive(); await this.session.reload(); this.session.setActiveToolsByName([...(this.options.activeTools ?? ["dsh_report"])]); this.reconcile(); }
  async compact(instructions?: string): Promise<void> { this.assertLive(); await this.session.compact(instructions); this.reconcile(); }
  async rebind(binding: WorkerToken): Promise<void> {
    if (binding.ticketId !== this.state.ticketId) throw new Error("Cannot move a Session to another Ticket");
    if (same(binding, this.state.binding)) return;
    await this.quiesce(this.state.paused, "uncertain");
    this.state = { ...this.state, binding: copy(binding), epoch: this.state.epoch + 1 }; this.ledger.saveSession(this.state); this.turn = undefined;
  }
  private release(): void {
    this.options.store.atomic(() => { const owner = this.options.store.get<Owner | null>(this.ownerKey()); if (owner?.nonce === this.nonce) this.options.store.set(this.ownerKey(), null); });
  }
  async dispose(): Promise<void> {
    if (this.disposed) return;
    await this.quiesce(this.state.paused, "uncertain"); this.disposed = true; this.session.dispose(); this.release();
  }
}
