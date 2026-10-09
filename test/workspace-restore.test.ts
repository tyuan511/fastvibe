import assert from "node:assert/strict";
import test from "node:test";
import { createWorkspaceRestore } from "../src/renderer/src/lib/workspace-restore.ts";

function fixture() {
  let resolve!: () => void;
  let reject!: (error: Error) => void;
  const pending = new Promise<void>((yes, no) => { resolve = yes; reject = no; });
  const calls: string[] = [];
  const errors: unknown[] = [];
  let settled = 0;
  let selected = false;
  const restore = createWorkspaceRestore({
    hasSelection: () => selected,
    restore: (id) => { calls.push(id); return pending; },
    onSettled: () => { settled += 1; },
    onError: (error) => { errors.push(error); },
  });
  return {
    restore, calls, errors, resolve, reject,
    select: () => { selected = true; },
    get settled() { return settled; },
  };
}

for (const first of ["status", "catalog"] as const) {
  test(`${first} arriving first cannot reveal the workspace before its transcript`, async () => {
    const f = fixture();
    if (first === "status") f.restore.setStatus("ready");
    else f.restore.setConversation("last-chat");
    assert.equal(f.settled, 0);
    assert.deepEqual(f.calls, []);
    if (first === "status") f.restore.setConversation("last-chat");
    else f.restore.setStatus("ready");
    assert.deepEqual(f.calls, ["last-chat"]);
    assert.equal(f.settled, 0);
    f.resolve();
    await Promise.resolve();
    assert.equal(f.settled, 1);
  });
}

test("starting waits for readiness and repeated status/catalog replies open only once", async () => {
  const f = fixture();
  f.restore.setStatus("starting");
  f.restore.setConversation("last-chat");
  assert.deepEqual(f.calls, []);
  assert.equal(f.settled, 0);
  f.restore.setStatus("ready");
  f.restore.setStatus("ready");
  f.restore.setConversation("last-chat");
  assert.deepEqual(f.calls, ["last-chat"]);
  assert.equal(f.settled, 0);
  f.resolve();
  await Promise.resolve();
  assert.equal(f.settled, 1);
});

test("a genuine first run reveals the empty workspace only after both replies", () => {
  const f = fixture();
  f.restore.setConversation(null);
  f.restore.setStatus("starting");
  assert.equal(f.settled, 0);
  f.restore.setStatus("ready");
  assert.equal(f.settled, 1);
  assert.deepEqual(f.calls, []);
});

test("idle with a saved conversation restores through the engine's lazy start", async () => {
  const f = fixture();
  f.restore.setStatus("idle");
  f.restore.setConversation("last-chat");
  assert.deepEqual(f.calls, ["last-chat"]);
  assert.equal(f.settled, 0);
  f.resolve();
  await Promise.resolve();
  assert.equal(f.settled, 1);
});

test("a newer selection is not overwritten by startup restoration", () => {
  const f = fixture();
  f.restore.setStatus("ready");
  f.select();
  f.restore.setConversation("old-chat");
  assert.deepEqual(f.calls, []);
  assert.equal(f.settled, 1);
});

for (const status of ["error", "missing"] as const) {
  test(`${status} releases recovery controls and a successful retry can still restore`, () => {
    const f = fixture();
    f.restore.setStatus(status);
    assert.equal(f.settled, 1);
    f.restore.setConversation("last-chat");
    f.restore.setStatus("ready");
    assert.deepEqual(f.calls, ["last-chat"]);
  });
}

test("a failed transcript read surfaces the failure and releases startup", async () => {
  const f = fixture();
  f.restore.setConversation("deleted-chat");
  f.restore.setStatus("ready");
  const error = new Error("conversation not found");
  f.reject(error);
  await Promise.resolve();
  assert.deepEqual(f.errors, [error]);
  assert.equal(f.settled, 1);
});

test("a failed catalog read cannot leave the splash captive", () => {
  const f = fixture();
  const error = new Error("catalog unavailable");
  f.restore.fail(error);
  f.restore.setStatus("ready");
  assert.deepEqual(f.errors, [error]);
  assert.equal(f.settled, 1);
});

test("disposing a StrictMode mount ignores late initial replies", () => {
  const f = fixture();
  f.restore.dispose();
  f.restore.setStatus("ready");
  f.restore.setConversation("last-chat");
  f.restore.fail(new Error("late failure"));
  assert.deepEqual(f.calls, []);
  assert.deepEqual(f.errors, []);
  assert.equal(f.settled, 0);
});

test("disposing during restoration ignores its completion", async () => {
  const f = fixture();
  f.restore.setStatus("ready");
  f.restore.setConversation("last-chat");
  f.restore.dispose();
  f.resolve();
  await Promise.resolve();
  assert.equal(f.settled, 0);
});
