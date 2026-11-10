// SPDX-License-Identifier: MIT
// Pi receipt ledger boundaries are specific to FastVibe's isolated Vivi adapter; see ../core/NOTICE.md.
import { createHash } from "node:crypto";
import type { WorkerReport } from "../core/engine.ts";
import type { WorkerToken } from "./engine.ts";
import type { SessionReceipt, ShadowStore } from "./store.ts";

export interface PiRead {
  entryId: string;
  turnId: string;
  binding: WorkerToken;
  epoch: number;
  at: number;
}

export interface PiTurn {
  turnId: string;
  binding: WorkerToken;
  epoch: number;
  at: number;
}

export interface PiReport {
  turnId: string;
  /** The actual input-read opportunity; it can precede a summary-only reporting turn. */
  readTurnId?: string;
  binding: WorkerToken;
  epoch: number;
  at: number;
  report: WorkerReport;
}

export interface PiReceipt extends SessionReceipt {
  sessionKey: string;
  requestId: string;
  stage: "accepted" | "persisted" | "read" | "reported";
  text: string;
  inputIds: string[];
  mode: "steer" | "followUp";
  binding: WorkerToken;
  epoch: number;
  fingerprint: string;
  status: "accepted" | "queued" | "handled" | "rejected" | "stopped" | "missing" | "uncertain" | "settled";
  entryId?: string;
  /** Captured dispatch identity of the exact JSONL user entry, independent of later bindings. */
  entryEpoch?: number;
  entryBinding?: WorkerToken;
  reads: PiRead[];
  turns: PiTurn[];
  reports: PiReport[];
}

export interface PiSessionState {
  sessionKey: string;
  ticketId: string;
  root: string;
  cwd: string;
  sessionFile: string;
  epoch: number;
  binding: WorkerToken;
  paused: boolean;
}

type PiIdentity = Pick<PiReceipt, "sessionKey" | "requestId" | "text" | "inputIds" | "mode" | "binding" | "epoch">;
type PiPatch = Partial<Omit<PiReceipt, "sessionKey" | "requestId" | "fingerprint" | "text" | "inputIds" | "mode" | "binding" | "epoch">>;
const STAGES: PiReceipt["stage"][] = ["accepted", "persisted", "read", "reported"];
const STATUSES: PiReceipt["status"][] = ["accepted", "queued", "handled", "rejected", "stopped", "missing", "uncertain", "settled"];
const nonEmptyString = (value: unknown): value is string => typeof value === "string" && value.trim().length > 0;
const SESSION_PREFIX = "pi:session:";
const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;
const fingerprintOf = (input: Pick<PiReceipt, "text" | "inputIds" | "mode">): string =>
  createHash("sha256").update(JSON.stringify([input.text, input.inputIds, input.mode])).digest("hex");
const sessionKeyFor = (key: string): string => `${SESSION_PREFIX}${key}`;

function validEpoch(epoch: number): void {
  if (!Number.isSafeInteger(epoch) || epoch < 0) throw new Error("Pi epoch 必须是非负安全整数");
}
function immutableSessionFieldsEqual(a: PiSessionState, b: PiSessionState): boolean {
  return a.sessionKey === b.sessionKey && a.ticketId === b.ticketId && a.root === b.root
    && a.cwd === b.cwd && a.sessionFile === b.sessionFile;
}

/** Durable, SDK-free facts for the Pi adapter. Every operation is serialized by ShadowStore.atomic. */
export class PiLedger {
  private readonly store: ShadowStore;
  constructor(store: ShadowStore) { this.store = store; }

  session(sessionKey: string): PiSessionState | undefined {
    return this.store.atomic(() => {
      const value = this.store.get<PiSessionState>(sessionKeyFor(sessionKey));
      return value ? clone(value) : undefined;
    });
  }

  saveSession(state: PiSessionState): void {
    validEpoch(state.epoch);
    if (!state.sessionKey) throw new Error("Pi sessionKey 不能为空");
    this.store.atomic(() => {
      const current = this.store.get<PiSessionState>(sessionKeyFor(state.sessionKey));
      if (current) {
        if (!immutableSessionFieldsEqual(current, state)) throw new Error("Pi 会话身份不可改变");
        if (state.epoch < current.epoch) throw new Error("Pi 会话 epoch 不可倒退");
      }
      this.store.set(sessionKeyFor(state.sessionKey), clone(state));
    });
  }

  get(sessionKey: string, requestId: string): PiReceipt | undefined {
    return this.store.atomic(() => {
      const value = this.store.sessionReceipts.get(sessionKey, requestId) as PiReceipt | undefined;
      return value ? clone(value) : undefined;
    });
  }

  list(sessionKey: string): PiReceipt[] {
    return this.store.atomic(() => this.store.db
      .all<{ data: string }>("SELECT data FROM vivi_session_receipts WHERE session_key=? ORDER BY rowid", sessionKey)
      .map(row => clone(JSON.parse(row.data) as PiReceipt)));
  }

  accept(input: PiIdentity): { receipt: PiReceipt; reused: boolean } {
    validEpoch(input.epoch);
    if (!nonEmptyString(input.sessionKey)) throw new Error("Pi sessionKey 不能为空");
    if (!nonEmptyString(input.requestId)) throw new Error("Pi requestId 不能为空");
    if (typeof input.text !== "string") throw new Error("Pi text 必须是 string");
    if (!Array.isArray(input.inputIds) || !Array.from(input.inputIds).every(nonEmptyString)) {
      throw new Error("Pi inputIds 必须是非空 string 元素的数组");
    }
    if (input.mode !== "steer" && input.mode !== "followUp") throw new Error("Pi mode 无效");
    const fingerprint = fingerprintOf(input);
    return this.store.atomic(() => {
      const current = this.store.sessionReceipts.get(input.sessionKey, input.requestId) as PiReceipt | undefined;
      if (current) {
        if (current.fingerprint !== fingerprint) throw new Error("同一 Pi requestId 的内容不可改变");
        return { receipt: clone(current), reused: true };
      }
      const receipt: PiReceipt = {
        ...clone(input),
        stage: "accepted",
        fingerprint,
        status: "accepted",
        reads: [],
        turns: [],
        reports: [],
      };
      this.store.sessionReceipts.save(receipt);
      return { receipt: clone(receipt), reused: false };
    });
  }

  patch(sessionKey: string, requestId: string, patch: PiPatch): PiReceipt {
    return this.store.atomic(() => {
      const current = this.store.sessionReceipts.get(sessionKey, requestId) as PiReceipt | undefined;
      if (!current) throw new Error("Pi request 回执不存在");
      const next = { ...clone(current), ...clone(patch), sessionKey: current.sessionKey, requestId: current.requestId,
        fingerprint: current.fingerprint, text: current.text, inputIds: current.inputIds, mode: current.mode,
        binding: current.binding, epoch: current.epoch } as PiReceipt;
      if (!STAGES.includes(next.stage)) throw new Error("Pi 回执 stage 无效");
      if (!STATUSES.includes(next.status)) throw new Error("Pi 回执 status 无效");
      if (STAGES.indexOf(next.stage) < STAGES.indexOf(current.stage)) throw new Error("Pi 回执 stage 不可倒退");
      if (current.entryId !== undefined && next.entryId !== current.entryId) throw new Error("Pi 回执 entryId 不可改变");
      if (STAGES.indexOf(next.stage) >= STAGES.indexOf("persisted") && !nonEmptyString(next.entryId)) {
        throw new Error("Pi persisted/read/reported 回执必须已有非空 entryId");
      }
      if (STAGES.indexOf(next.stage) >= STAGES.indexOf("read")
        && (!Array.isArray(next.reads) || next.reads.length === 0 || !Array.from(next.reads).every(read => read != null && typeof read === "object"))) {
        throw new Error("Pi read/reported 回执必须已有 read");
      }
      this.store.sessionReceipts.save(next);
      return clone(next);
    });
  }
}

export { fingerprintOf as piReceiptFingerprint };
