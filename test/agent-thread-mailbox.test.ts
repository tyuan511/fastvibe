import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import { AgentThreadStore } from "../src/main/engine/agent-thread-store.ts";
import { openTestDb, testDir } from "./test-db.ts";

function fixture(t: TestContext) {
  const db = openTestDb(testDir("agent-mailbox-"));
  t.after(() => db.close());
  const store = new AgentThreadStore(db);
  const create = (id: string, conversationId = "a") => store.create({ id, conversationId, task: "inspect", cwd: "/repo", status: "working", currentTurn: 1 });
  return { db, store, create };
}

test("completed and failed turns create durable, attributed parent mail once", (t) => {
  const { db, store, create } = fixture(t);
  create("done"); create("failed"); create("other", "b");
  store.finishTurn("done", 1, "completed", "verified the code");
  store.finishTurn("failed", 1, "failed", "partial evidence", "provider failed");
  store.finishTurn("other", 1, "completed", "another conversation");
  assert.equal(store.finishTurn("done", 1, "completed", "duplicate"), undefined);
  const pending = new AgentThreadStore(db).pendingResults("a");
  assert.equal(pending.length, 2);
  assert.deepEqual(pending.map((message) => [message.threadId, message.senderId, message.recipientId, message.turn, message.status]), [
    ["done", "done", "a", 1, "completed"], ["failed", "failed", "a", 1, "failed"],
  ]);
  assert.equal(pending[0].text, "verified the code");
  assert.match(pending[1].text, /provider failed\n\npartial evidence/);
  assert.equal(store.pendingResults("b").length, 1);
  store.acknowledgeResults("b", pending.map((message) => message.id));
  assert.equal(store.pendingResults("a").length, 2, "another chat cannot acknowledge this mailbox");
  store.acknowledgeResults("a", pending.map((message) => message.id));
  assert.deepEqual(store.pendingResults("a"), []);
  assert.equal(store.get("done")?.unread, true, "model delivery does not clear the UI unread badge");
  assert.equal(store.messages("done")[0].text, "verified the code");
});

test("interruption keeps partial thread history without notifying the parent", (t) => {
  const { store, create } = fixture(t);
  create("stopped");
  store.setStatus("stopped", "interrupted"); // interruptAgent can publish before the runner returns.
  store.finishTurn("stopped", 1, "interrupted", "already changed file A");
  assert.equal(store.get("stopped")?.lastMessage, "already changed file A");
  assert.equal(store.messages("stopped")[0].text, "already changed file A");
  assert.deepEqual(store.pendingResults("a"), []);
  store.patch("stopped", { currentTurn: 2, status: "working" });
  store.finishTurn("stopped", 2, "completed", "continued after checking file A");
  assert.equal(store.pendingResults("a")[0].turn, 2);
});

test("late callbacks cannot revive deleted threads or finish a newer turn", (t) => {
  const { store, create } = fixture(t);
  create("newer");
  store.patch("newer", { currentTurn: 2 });
  assert.equal(store.finishTurn("newer", 1, "completed", "old"), undefined);
  assert.equal(store.get("newer")?.status, "working");
  store.removeConversation("a");
  assert.equal(store.finishTurn("newer", 2, "failed", "deleted"), undefined);
  assert.deepEqual(store.pendingResults("a"), []);
});

test("status and result roll back together when mailbox persistence fails", (t) => {
  const { db, store, create } = fixture(t);
  create("full-disk");
  db.exec("CREATE TRIGGER reject_result BEFORE INSERT ON agent_thread_messages BEGIN SELECT RAISE(ABORT, 'disk full'); END;");
  assert.throws(() => store.finishTurn("full-disk", 1, "completed", "do not lose this"), /disk full/);
  assert.equal(store.get("full-disk")?.status, "working");
  assert.deepEqual(store.pendingResults("a"), []);
});

test("historical unaddressed results are not replayed and new batches are bounded without truncating history", (t) => {
  const { store, create } = fixture(t);
  create("legacy");
  store.send("legacy", "agent", "historical output", "result");
  assert.deepEqual(store.pendingResults("a"), []);
  for (let i = 0; i < 10; i++) {
    create(`worker-${i}`);
    store.finishTurn(`worker-${i}`, 1, "completed", "x".repeat(20_000));
  }
  const first = store.pendingResults("a");
  assert.equal(first.length, 8);
  assert.ok(first.every((message) => message.text.length === 20_000));
  store.acknowledgeResults("a", first.map((message) => message.id));
  assert.equal(store.pendingResults("a").length, 2);
});
