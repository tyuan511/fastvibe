import assert from "node:assert/strict";
import { test } from "node:test";
import { mapEngineMessages } from "../src/main/engine/map-messages.ts";

const prompt = [
  "子任务已全部结束（4 完成）。",
  "- T-0001 统计 src/main 的 .ts — 完成",
  "",
  "请用 dag_result 读取需要的产出，向用户汇总结果。",
].join("\n");

test("a settled sub-task notice is a system event, not the prompt", () => {
  const [message] = mapEngineMessages([
    {
      role: "custom",
      customType: "dag-settled",
      display: false,
      content: prompt,
      timestamp: 10,
      details: {
        nodes: [
          { id: "T-0001", status: "completed" },
          { id: "T-0002", status: "completed" },
          { id: "T-0003", status: "failed" },
          { id: "T-0004", status: "skipped" },
          { id: "T-0005", status: "cancelled" },
          { id: "T-0006", status: "running" },
        ],
      },
    },
  ]);
  assert.equal(message?.kind, "dag");
  assert.equal(message?.role, "system");
  assert.equal(message?.text, "");
  assert.deepEqual(message?.dag, { completed: 2, failed: 1, skipped: 1, cancelled: 1 });
});

test("an older visible settled notice is the same event", () => {
  const [message] = mapEngineMessages([
    { role: "custom", customType: "dag-settled", display: true, content: prompt, timestamp: 11 },
  ]);
  assert.equal(message?.kind, "dag");
  assert.equal(message?.text, "");
  assert.deepEqual(message?.dag, { completed: 0, failed: 0, skipped: 0, cancelled: 0 });
});

test("a user row is stamped when it was sent, not when it was composed", () => {
  const composed = Date.parse("2026-10-08T00:00:00.000Z");
  const sent = Date.parse("2026-10-08T01:30:00.000Z");
  const [message] = mapEngineMessages([
    { id: "u1", type: "message", timestamp: new Date(sent).toISOString(), message: { role: "user", content: "later", timestamp: composed } },
  ]);
  assert.equal(message?.createdAt, sent);
  // A message that never became an entry (the optimistic row, a stream) keeps its own stamp.
  const [bare] = mapEngineMessages([{ role: "user", content: "now", timestamp: composed }]);
  assert.equal(bare?.createdAt, composed);
});

test("an assistant row keeps its request start, which the entry cannot say", () => {
  const started = Date.parse("2026-10-08T00:00:00.000Z");
  const finished = Date.parse("2026-10-08T00:05:00.000Z");
  const [message] = mapEngineMessages([
    { id: "a1", type: "message", timestamp: new Date(finished).toISOString(), message: { role: "assistant", content: "done", timestamp: started } },
  ]);
  assert.equal(message?.createdAt, started);
});

test("other hidden custom messages stay out of the thread", () => {
  const messages = mapEngineMessages([
    { role: "custom", customType: "fastvibe-goal", display: false, content: "keep going", timestamp: 12 },
    { role: "custom", customType: "audit", display: true, content: "visible", timestamp: 13 },
  ]);
  assert.equal(messages.length, 1);
  assert.equal(messages[0]?.kind, "custom");
  assert.equal(messages[0]?.text, "visible");
});
