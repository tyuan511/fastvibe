import assert from "node:assert/strict";
import { test } from "node:test";
import { openDatabase } from "../src/main/engine/db.ts";
import { BotStore } from "../src/main/bot/bot-store.ts";
import type { BotConversationMeta, BotDelivery } from "../src/shared/bot.ts";

const meta: BotConversationMeta = { conversationId: "router:1", role: "router", owner: "vivi", creationKey: "router:vivi", epoch: 0, paused: false, createdAt: 1, updatedAt: 1 };
const worker: BotConversationMeta = { ...meta, conversationId: "worker:1", role: "worker", creationKey: "work:r1", title: "工作" };
function input(id: string, status: "queued" | "running" = "queued") { return { id, conversationId: "router:1", epoch: 0, source: "user" as const, text: "做事", status, createdAt: 1 }; }

test("会话、输入和 revision 在事务中原子提交，读取对象相互隔离", () => {
  const db = openDatabase(":memory:");
  try {
    const store = new BotStore(db);
    store.transaction(() => { store.putConversation(meta); store.putInput(input("i")); store.bumpRevision(); });
    assert.equal(store.revision, 1); const copy = store.conversation(meta.conversationId)!; copy.title = "mutated"; assert.equal(store.conversation(meta.conversationId)?.title, undefined);
    assert.throws(() => store.transaction(() => { store.putConversation({ ...meta, paused: true }); store.bumpRevision(); throw new Error("rollback"); }));
    assert.equal(store.conversation(meta.conversationId)?.paused, false); assert.equal(store.revision, 1);
  } finally { db.close(); }
});

test("输入、问题、结果和 outbox 都是可恢复的持久事实", () => {
  const db = openDatabase(":memory:");
  try {
    const store = new BotStore(db); store.putConversation(meta); store.putConversation(worker); store.putInput(input("i", "running"));
    store.putAttention({ id: "q", conversationId: "worker:1", inputId: "w", epoch: 0, question: "哪个文件？", status: "pending", createdAt: 2 });
    store.putResult({ id: "r", conversationId: "worker:1", inputId: "w", epoch: 0, status: "ready", summary: "完成", evidence: ["检查过"], artifacts: ["out.md"], createdAt: 3 });
    const delivery: BotDelivery = { id: "d", conversationId: "worker:1", targetConversationId: "router:1", status: "pending", text: "完成", resultId: "r", createdAt: 4 };
    assert.equal(store.putDelivery(delivery), true); assert.equal(new BotStore(db).putDelivery(delivery), false);
    assert.equal(store.attention("q")?.status, "pending"); assert.equal(store.result("r")?.summary, "完成"); assert.equal(store.deliveries("pending").length, 1);
    store.updateDelivery({ ...delivery, status: "delivered" }); assert.equal(store.deliveries("delivered")[0].id, "d");
  } finally { db.close(); }
});

test("recover 将 running/accepted 输入标记 uncertain 并暂停所属会话，重复恢复幂等", () => {
  const db = openDatabase(":memory:");
  try { const store = new BotStore(db); store.putConversation(meta); store.putInput(input("i", "running")); store.recover(); assert.equal(store.input("i")?.status, "uncertain"); assert.equal(store.conversation(meta.conversationId)?.paused, true); const revision = store.revision; store.recover(); assert.equal(store.revision, revision); }
  finally { db.close(); }
});

test("不同会话与不同来源可以共存，查询顺序稳定且旧表不会进入新 scheduler", () => {
  const db = openDatabase(":memory:");
  try { const store = new BotStore(db); store.putConversation(worker); store.putConversation(meta); store.putInput(input("b")); assert.deepEqual(store.conversations().map((item) => item.conversationId), ["router:1", "worker:1"]); }
  finally { db.close(); }
});
