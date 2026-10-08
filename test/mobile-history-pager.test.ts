import assert from "node:assert/strict";
import test from "node:test";
import { HistoryPager, prependHistory, type HistoryPage } from "../apps/mobile/src/chat/history-pager.ts";
type Row = { id: string; text?: string };
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>((done) => { resolve = done; }); return { promise, resolve }; }
const settle = async () => { for (let i = 0; i < 12; i++) await Promise.resolve(); };

test("older pages preserve existing objects, inverted row indices and live text", async () => {
  const pending = deferred<HistoryPage<Row>>();
  let messages = [{ id: "u3" }, { id: "a3", text: "live" }];
  const oldUser = messages[0];
  let reads = 0;
  const pager = new HistoryPager<Row>({ cursor: "u3", load: () => { reads++; return pending.promise; },
    prepend: (older, cursor) => { const next = prependHistory(messages, older, cursor); if (!next) return false; messages = next; return true; }, cursorChanged: () => {}, reset: async () => assert.fail() });
  const a = pager.loadOlder(), b = pager.loadOlder(); assert.equal(a, b);
  messages = [messages[0], { ...messages[1], text: "live and newer" }];
  const live = messages[1];
  pending.resolve({ messages: [{ id: "u2" }, { id: "a2" }], beforeEntryId: "u3", nextBeforeEntryId: "u2", reset: false });
  await a;
  assert.equal(reads, 1);
  assert.equal(messages[2], oldUser); assert.equal(messages[3], live);
  assert.equal([...messages].reverse().findIndex((row) => row.id === "a3"), 0);
  assert.equal(pager.cursor, "u2"); pager.dispose();
});

test("Copy All loads every page and never succeeds with a partial history after an error", async () => {
  const seen: string[] = [];
  const pager = new HistoryPager<Row>({ cursor: "u3", load: async (cursor) => ({ beforeEntryId: cursor, reset: false,
    messages: [{ id: cursor === "u3" ? "u2" : "u1" }], nextBeforeEntryId: cursor === "u3" ? "u2" : null }),
    prepend: (messages) => { seen.push(messages[0].id); return true; }, cursorChanged: () => {}, reset: async () => {} });
  await pager.loadAll(); assert.deepEqual(seen, ["u2", "u1"]); assert.equal(pager.cursor, null); pager.dispose();
  const failed = new HistoryPager<Row>({ cursor: "u3", load: async () => { throw new Error("offline"); }, prepend: () => assert.fail(), cursorChanged: () => {}, reset: async () => {} });
  await assert.rejects(failed.loadAll(), /offline/); assert.equal(failed.cursor, "u3"); failed.dispose();
});

test("replacement snapshots and disconnected views reject old page results", async () => {
  const pending = deferred<HistoryPage<Row>>();
  const pager = new HistoryPager<Row>({ cursor: "old", load: () => pending.promise, prepend: () => assert.fail("stale page"), cursorChanged: () => {}, reset: async () => {} });
  const loading = pager.loadOlder(); pager.replace("new");
  pending.resolve({ beforeEntryId: "old", messages: [{ id: "older" }], nextBeforeEntryId: null, reset: false }); await loading;
  assert.equal(pager.cursor, "new"); pager.dispose();
});

test("removed anchors request a full refresh, without appending old-branch history", async () => {
  let resets = 0;
  const pager = new HistoryPager<Row>({ cursor: "removed", load: async () => ({ beforeEntryId: "removed", messages: [], nextBeforeEntryId: null, reset: true }),
    prepend: () => assert.fail(), cursorChanged: () => {}, reset: async () => { resets++; } });
  await pager.loadAll(); assert.equal(resets, 1); assert.equal(pager.cursor, null); pager.dispose();
});

test("automatic history prefetch retries transient errors without a load-more control", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  let reads = 0;
  const pager = new HistoryPager<Row>({ cursor: "u", load: async () => { if (++reads === 1) throw new Error("temporary");
    return { beforeEntryId: "u", messages: [], nextBeforeEntryId: null, reset: false }; }, prepend: () => true, cursorChanged: () => {}, reset: async () => {} });
  pager.prefetch(); await settle(); assert.equal(reads, 1);
  t.mock.timers.tick(1000); await settle(); assert.equal(reads, 2); assert.equal(pager.cursor, null); pager.dispose();
});

test("Copy All waits for an authoritative branch reset, including a second copy during the reset", async () => {
  const reset = deferred<void>();
  let copies = 0;
  const pager = new HistoryPager<Row>({ cursor: "removed", load: async () => ({ beforeEntryId: "removed", messages: [], nextBeforeEntryId: null, reset: true }),
    prepend: () => assert.fail(), cursorChanged: () => {}, reset: () => reset.promise });
  const first = pager.loadAll().then(() => { copies++; });
  await settle();
  const second = pager.loadAll().then(() => { copies++; });
  await settle();
  assert.equal(copies, 0); assert.equal(pager.cursor, "removed");
  reset.resolve(); await Promise.all([first, second]);
  assert.equal(copies, 2); assert.equal(pager.cursor, null); pager.dispose();
});

test("a failed branch reset cannot mark partial history complete", async () => {
  const pager = new HistoryPager<Row>({ cursor: "removed", load: async () => ({ beforeEntryId: "removed", messages: [], nextBeforeEntryId: null, reset: true }),
    prepend: () => assert.fail(), cursorChanged: () => {}, reset: async () => { throw new Error("offline"); } });
  await assert.rejects(pager.loadAll(), /offline/);
  assert.equal(pager.cursor, "removed"); pager.dispose();
});
