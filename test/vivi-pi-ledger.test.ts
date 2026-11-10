import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openShadowStore, type ShadowStore } from "../src/main/bot/shadow/store.ts";
import { PiLedger, type PiReceipt, type PiSessionState } from "../src/main/bot/shadow/pi-ledger.ts";
import type { WorkerToken } from "../src/main/bot/shadow/engine.ts";

const binding: WorkerToken = { ticketId: "ticket-1", assignmentId: "assignment-1", generation: 1, claimToken: 2 };
const state: PiSessionState = {
  sessionKey: "worker:one", ticketId: "ticket-1", root: "/root", cwd: "/root/project", sessionFile: "/root/session.jsonl",
  epoch: 3, binding, paused: false,
};
function memory(t: TestContext): { store: ShadowStore; ledger: PiLedger } {
  const store = openShadowStore();
  t.after(() => store.close());
  return { store, ledger: new PiLedger(store) };
}
function input(text = "hello", requestId = "request-1"): Pick<PiReceipt, "sessionKey" | "requestId" | "text" | "inputIds" | "mode" | "binding" | "epoch"> {
  return { sessionKey: state.sessionKey, requestId, text, inputIds: ["input-1"], mode: "followUp", binding, epoch: state.epoch };
}

test("accept is SQL durable, content-idempotent, and content conflicts atomically", t => {
  const { ledger, store } = memory(t);
  const first = ledger.accept(input());
  assert.equal(first.reused, false);
  assert.equal(first.receipt.fingerprint.length, 64);
  const second = ledger.accept({ ...input(), binding: { ...binding, generation: 9 }, epoch: 99 });
  assert.equal(second.reused, true);
  assert.deepEqual(second.receipt.binding, binding);
  assert.equal(second.receipt.epoch, 3);
  assert.throws(() => ledger.accept(input("changed")), /内容不可改变/);
  assert.equal(store.db.countRows("vivi_session_receipts"), 1);
  assert.equal(ledger.get(state.sessionKey, "request-1")?.text, "hello");
});

test("stage is monotonic while status is independent, and read/report facts are guarded", t => {
  const { ledger } = memory(t);
  ledger.accept(input());
  assert.throws(() => ledger.patch(state.sessionKey, "request-1", { stage: "persisted", status: "queued" }), /entryId/);
  const persisted = ledger.patch(state.sessionKey, "request-1", { stage: "persisted", entryId: "entry-1", status: "queued" });
  assert.equal(persisted.status, "queued");
  assert.throws(() => ledger.patch(state.sessionKey, "request-1", { stage: "read" }), /已有 read/);
  const read = ledger.patch(state.sessionKey, "request-1", {
    stage: "read", entryId: "entry-1", status: "handled",
    reads: [{ entryId: "entry-1", turnId: "turn-1", binding, epoch: 3, at: 10 }],
  });
  assert.equal(read.stage, "read");
  assert.throws(() => ledger.patch(state.sessionKey, "request-1", { entryId: "entry-2" }), /entryId/);
  assert.throws(() => ledger.patch(state.sessionKey, "request-1", { stage: "reported", reads: [] }), /已有 read/);
  const reported = ledger.patch(state.sessionKey, "request-1", {
    stage: "reported", status: "settled", reports: [{ turnId: "turn-1", binding, epoch: 3, at: 11, report: { state: "ready", summary: "done" } }],
  });
  assert.equal(reported.stage, "reported");
  assert.equal(reported.status, "settled");
  assert.throws(() => ledger.patch(state.sessionKey, "request-1", { stage: "read" }), /stage 不可倒退/);
  assert.equal(ledger.patch(state.sessionKey, "request-1", { status: "stopped" }).status, "stopped");
});

test("session identity is immutable, epoch only advances, and sessions are isolated", t => {
  const { ledger } = memory(t);
  ledger.saveSession(state);
  ledger.saveSession({ ...state, epoch: 4, paused: true });
  assert.equal(ledger.session(state.sessionKey)?.paused, true);
  assert.equal(ledger.session(state.sessionKey)?.epoch, 4);
  assert.throws(() => ledger.saveSession({ ...state, epoch: 2 }), /epoch 不可倒退/);
  assert.throws(() => ledger.saveSession({ ...state, cwd: "/other" }), /身份不可改变/);
  ledger.accept(input());
  ledger.accept({ ...input("other", "request-2"), sessionKey: "worker:two" });
  assert.equal(ledger.list(state.sessionKey).length, 1);
  assert.equal(ledger.list("worker:two").length, 1);
});

test("file store survives close and reopen with deterministic list", t => {
  const dir = mkdtempSync(join(tmpdir(), "vivi-pi-ledger-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const file = join(dir, "shadow.db");
  const first = openShadowStore(file);
  new PiLedger(first).saveSession(state);
  new PiLedger(first).accept(input("one", "a"));
  new PiLedger(first).patch(state.sessionKey, "a", { stage: "persisted", entryId: "durable-entry", status: "uncertain" });
  new PiLedger(first).accept(input("two", "b"));
  first.close();
  const second = openShadowStore(file);
  try {
    const ledger = new PiLedger(second);
    assert.deepEqual(ledger.list(state.sessionKey).map(receipt => receipt.requestId), ["a", "b"]);
    assert.deepEqual(ledger.session(state.sessionKey), state);
    assert.equal(ledger.get(state.sessionKey, "a")?.entryId, "durable-entry");
    assert.equal(ledger.get(state.sessionKey, "a")?.status, "uncertain");
    assert.equal(ledger.accept(input("one", "a")).reused, true);
    assert.equal(ledger.get(state.sessionKey, "b")?.text, "two");
  } finally { second.close(); }
});


for (const field of ["text", "inputIds", "mode"] as const) {
  test(`request content conflict includes ${field}`, t => {
    const { ledger } = memory(t);
    const original = ledger.accept(input()).receipt;
    const changed = { ...input(), [field]: field === "text" ? "changed" : field === "inputIds" ? ["input-2"] : "steer" };
    assert.throws(() => ledger.accept(changed), /内容不可改变/);
    assert.deepEqual(ledger.get(state.sessionKey, "request-1"), original);
  });
}

for (const field of ["ticketId", "root", "cwd", "sessionFile"] as const) {
  test(`session ${field} cannot be rebound`, t => {
    const { ledger } = memory(t);
    ledger.saveSession(state);
    assert.throws(() => ledger.saveSession({ ...state, [field]: "different" }), /身份不可改变/);
    assert.deepEqual(ledger.session(state.sessionKey), state);
  });
}

for (const epoch of [-1, 0.5, Number.NaN, Number.MAX_SAFE_INTEGER + 1]) {
  test(`invalid epoch ${epoch} cannot create facts`, t => {
    const { ledger } = memory(t);
    assert.throws(() => ledger.saveSession({ ...state, epoch }), /epoch/);
    assert.throws(() => ledger.accept({ ...input(), epoch }), /epoch/);
    assert.equal(ledger.session(state.sessionKey), undefined);
    assert.deepEqual(ledger.list(state.sessionKey), []);
  });
}

test("outer SQL transaction rollback removes session and receipt together", t => {
  const { ledger, store } = memory(t);
  assert.throws(() => store.atomic(() => {
    ledger.saveSession(state);
    ledger.accept(input());
    assert.equal(store.db.countRows("vivi_session_receipts"), 1);
    throw new Error("rollback");
  }), /rollback/);
  assert.equal(ledger.session(state.sessionKey), undefined);
  assert.equal(store.db.countRows("vivi_session_receipts"), 0);
  assert.equal(store.db.countRows("vivi_kv"), 0);
});

test("failed nested update preserves the outer transaction and original receipt", t => {
  const { ledger, store } = memory(t);
  ledger.accept(input());
  store.atomic(() => {
    ledger.saveSession(state);
    assert.throws(() => ledger.patch(state.sessionKey, "request-1", { stage: "read" }), /entryId/);
    ledger.accept(input("another", "request-2"));
  });
  assert.equal(ledger.session(state.sessionKey)?.epoch, 3);
  assert.equal(ledger.get(state.sessionKey, "request-1")?.stage, "accepted");
  assert.equal(ledger.list(state.sessionKey).length, 2);
});

test("same request ID in separate sessions is independent and KV namespace is reserved", t => {
  const { ledger, store } = memory(t);
  store.set(state.sessionKey, { unrelated: true });
  store.set("shadow:worker:ticket-1", binding);
  ledger.saveSession(state);
  const a = ledger.accept(input());
  const b = ledger.accept({ ...input("different"), sessionKey: "worker:two" });
  assert.equal(a.reused, false);
  assert.equal(b.reused, false);
  assert.equal(ledger.get("worker:two", "request-1")?.text, "different");
  assert.deepEqual(store.get(state.sessionKey), { unrelated: true });
  assert.deepEqual(store.get("shadow:worker:ticket-1"), binding);
  assert.equal(ledger.session("worker:two"), undefined);
  assert.deepEqual(ledger.list("missing"), []);
  assert.equal(ledger.get(state.sessionKey, "missing"), undefined);
  assert.throws(() => ledger.patch(state.sessionKey, "missing", { status: "missing" }), /不存在/);
});

test("identity is protected even from a structurally wider runtime patch", t => {
  const { ledger } = memory(t);
  const original = ledger.accept(input()).receipt;
  const forged = { ...original, ...input("forged", "other"), sessionKey: "other-session", fingerprint: "forged", epoch: 9,
    binding: { ...binding, claimToken: 9 }, stage: "persisted" as const, entryId: "entry-1" };
  const updated = ledger.patch(state.sessionKey, "request-1", forged);
  assert.deepEqual(updated, { ...original, stage: "persisted", entryId: "entry-1" });
  assert.equal(ledger.get("other-session", "other"), undefined);
});

test("accepted identity uses structured SHA256 content and detaches input and output arrays", t => {
  const { ledger } = memory(t);
  const request = input();
  const receipt = ledger.accept(request).receipt;
  assert.equal(receipt.fingerprint, createHash("sha256").update(JSON.stringify(["hello", ["input-1"], "followUp"])).digest("hex"));
  request.inputIds.push("caller-change");
  receipt.inputIds.push("result-change");
  receipt.binding.claimToken = 999;
  const current = ledger.get(state.sessionKey, "request-1")!;
  assert.deepEqual(current.inputIds, ["input-1"]);
  assert.equal(current.binding.claimToken, 2);
  ledger.list(state.sessionKey)[0]!.reads.push({ entryId: "fake", turnId: "fake", binding, epoch: 3, at: 1 });
  assert.deepEqual(ledger.get(state.sessionKey, "request-1")?.reads, []);
});

test("status alone grants no read or report stage and replay preserves terminal facts", t => {
  const { ledger } = memory(t);
  ledger.accept(input());
  const terminal = ledger.patch(state.sessionKey, "request-1", { status: "settled" });
  assert.equal(terminal.stage, "accepted");
  assert.throws(() => ledger.patch(state.sessionKey, "request-1", { stage: "reported", entryId: "entry" }), /已有 read/);
  assert.deepEqual(ledger.accept({ ...input(), epoch: 10 }).receipt, terminal);
  assert.throws(() => ledger.patch(state.sessionKey, "request-1", { stage: "unknown" } as unknown as Parameters<PiLedger["patch"]>[2]), /stage 无效/);
});

for (const [field, values] of [
  ["sessionKey", ["", "   ", null, 1]],
  ["requestId", ["", "\t", null, 1]],
  ["text", [null, 1, {}, undefined]],
  ["inputIds", [null, "input-1", {}, [""], ["   "], [1], [null], ["valid", ""], Array(1)]],
  ["mode", ["", "followup", "unknown", null]],
] as const) {
  test(`accept rejects invalid ${field} without creating or reusing facts`, t => {
    const { ledger, store } = memory(t);
    const original = ledger.accept(input()).receipt;
    for (const value of values) {
      const invalid = { ...input(), [field]: value } as unknown as Parameters<PiLedger["accept"]>[0];
      assert.throws(() => ledger.accept(invalid), new RegExp(field));
      assert.throws(() => ledger.accept({ ...invalid, requestId: field === "requestId" ? invalid.requestId : "new" }), new RegExp(field));
      assert.deepEqual(ledger.get(state.sessionKey, "request-1"), original);
      assert.equal(store.db.countRows("vivi_session_receipts"), 1);
    }
  });
}

test("empty text and an empty input snapshot remain valid facts for either mode", t => {
  const { ledger } = memory(t);
  for (const mode of ["steer", "followUp"] as const) {
    const receipt = ledger.accept({ ...input("", mode), inputIds: [], mode }).receipt;
    assert.equal(receipt.text, "");
    assert.deepEqual(receipt.inputIds, []);
    assert.equal(receipt.mode, mode);
  }
});

for (const stage of ["persisted", "read", "reported"] as const) {
  test(`${stage} rejects absent, empty and non-string entry identity`, t => {
    const { ledger } = memory(t);
    const original = ledger.accept(input()).receipt;
    for (const entryId of [undefined, "", "   ", null, 1]) {
      const patch = { stage, entryId, reads: [{ entryId: "entry", turnId: "turn", binding, epoch: 3, at: 1 }] };
      assert.throws(() => ledger.patch(state.sessionKey, "request-1", patch as unknown as Parameters<PiLedger["patch"]>[2]), /entryId/);
      assert.deepEqual(ledger.get(state.sessionKey, "request-1"), original);
    }
  });
}

for (const stage of ["read", "reported"] as const) {
  test(`${stage} requires read records and cannot erase them after advancement`, t => {
    const { ledger } = memory(t);
    const original = ledger.accept(input()).receipt;
    for (const reads of [undefined, [], null, {}, "read", [null], Array(1)]) {
      assert.throws(() => ledger.patch(state.sessionKey, "request-1", { stage, entryId: "entry", reads } as unknown as Parameters<PiLedger["patch"]>[2]), /已有 read/);
      assert.deepEqual(ledger.get(state.sessionKey, "request-1"), original);
    }
    const advanced = ledger.patch(state.sessionKey, "request-1", {
      stage, entryId: "entry", reads: [{ entryId: "entry", turnId: "turn", binding, epoch: 3, at: 1 }],
    });
    assert.throws(() => ledger.patch(state.sessionKey, "request-1", { reads: [] }), /已有 read/);
    assert.deepEqual(ledger.get(state.sessionKey, "request-1"), advanced);
  });
}

for (const field of ["stage", "status"] as const) {
  test(`unknown ${field} is rejected without overwriting the receipt`, t => {
    const { ledger } = memory(t);
    const original = ledger.accept(input()).receipt;
    for (const value of ["unknown", "", null, 1, {}, []]) {
      assert.throws(() => ledger.patch(state.sessionKey, "request-1", { [field]: value } as unknown as Parameters<PiLedger["patch"]>[2]), new RegExp(`${field} 无效`));
      assert.deepEqual(ledger.get(state.sessionKey, "request-1"), original);
    }
  });
}

test("every defined status remains independent of stage", t => {
  const { ledger } = memory(t);
  ledger.accept(input());
  for (const status of ["accepted", "queued", "handled", "rejected", "stopped", "missing", "uncertain", "settled"] as const) {
    const receipt = ledger.patch(state.sessionKey, "request-1", { status });
    assert.equal(receipt.status, status);
    assert.equal(receipt.stage, "accepted");
  }
});

for (const failure of ["accept", "patch"] as const) {
  test(`${failure} contract failure rolls back earlier real SQL writes in the transaction`, t => {
    const { ledger, store } = memory(t);
    const original = ledger.accept(input()).receipt;
    const before = store.db.all<{ data: string }>("SELECT data FROM vivi_session_receipts ORDER BY rowid");
    assert.throws(() => store.atomic(() => {
      ledger.saveSession(state);
      ledger.accept(input("second", "request-2"));
      ledger.patch(state.sessionKey, "request-1", { stage: "persisted", entryId: "entry" });
      assert.equal(store.db.countRows("vivi_session_receipts"), 2);
      assert.equal(store.db.countRows("vivi_kv"), 1);
      if (failure === "accept") ledger.accept({ ...input(), inputIds: [""] });
      else ledger.patch(state.sessionKey, "request-1", { stage: "read" });
    }), failure === "accept" ? /inputIds/ : /已有 read/);
    assert.deepEqual(store.db.all<{ data: string }>("SELECT data FROM vivi_session_receipts ORDER BY rowid"), before);
    assert.deepEqual(ledger.get(state.sessionKey, "request-1"), original);
    assert.equal(ledger.get(state.sessionKey, "request-2"), undefined);
    assert.equal(ledger.session(state.sessionKey), undefined);
    assert.equal(store.db.countRows("vivi_kv"), 0);
  });
}
