import assert from "node:assert/strict";
import test from "node:test";
import { AgentThreadStore } from "../src/main/engine/agent-thread-store.ts";
import { openTestDb, testDir } from "./test-db.ts";

test("agent threads persist parent roots and mailbox messages", () => {
  const db = openTestDb(testDir());
  const store = new AgentThreadStore(db);
  const root = store.create({ id: "agent-root", conversationId: "conversation", task: "inspect", cwd: "/repo", status: "working" });
  const child = store.create({ id: "agent-child", conversationId: "conversation", parentId: root.id, task: "verify", cwd: "/repo", status: "queued" });
  assert.equal(child.rootId, root.id);
  const message = store.send(child.id, root.id, "Please report the result", "message");
  assert.equal(store.messages(child.id)[0]?.id, message.id);
  const updated = store.setStatus(child.id, "completed", { lastMessage: "done", unread: true });
  assert.equal(updated?.revision, 2);
  const reopened = new AgentThreadStore(db);
  const recovered = reopened.recoverAfterRestart();
  assert.equal(recovered.some((item) => item.id === root.id), true);
  assert.equal(reopened.get(root.id)?.status, "interrupted");
  assert.deepEqual(reopened.get(child.id), updated);
  assert.equal(reopened.messages(child.id)[0]?.id, message.id);
  assert.equal(reopened.messages(child.id)[0]?.text, message.text);
  db.close();
});
