import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import ts from "typescript";
import { botChatMessages } from "../src/renderer/src/lib/vivi-chat.ts";
import type { BotChatMessage } from "../src/shared/bot.ts";

const compiled = ts.transpileModule(readFileSync(new URL("../src/renderer/src/lib/group-parts.tsx", import.meta.url), "utf8"), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
const exports_: Record<string, any> = {};
vm.runInNewContext(compiled, { exports: exports_, require: (name: string) => name.includes("i18n") ? { i18n: { language: "zh" } } : {}, WeakMap, Map, Set });

test("Vivi 连续回复、阶段汇报和结果各自独立，不合并成 SDK 运行", () => {
  const messages: BotChatMessage[] = [
    { id: "u", conversationId: "router", role: "user", text: "写文档", createdAt: 1 },
    { id: "a", conversationId: "router", role: "assistant", text: "开始处理", createdAt: 2 },
    { id: "p", conversationId: "worker", role: "assistant", kind: "progress", text: "草稿完成", createdAt: 3 },
    { id: "r", conversationId: "worker", role: "assistant", kind: "result", text: "检查完成", result: { id: "r1", conversationId: "worker", epoch: 0, status: "ready", artifacts: ["/tmp/doc.md"], evidence: ["链接有效"], createdAt: 4 }, createdAt: 4 },
    { id: "a2", conversationId: "router", role: "assistant", text: "文件在这里", createdAt: 5 },
    { id: "a3", conversationId: "router", role: "assistant", text: "还有补充", createdAt: 6 },
  ];
  const mapped = botChatMessages(messages);
  const rows = exports_.groupMessageRows(mapped);
  assert.equal(rows.length, messages.length);
  assert.deepEqual(mapped[3].bot?.result?.artifacts, ["/tmp/doc.md"]);
  assert.deepEqual(mapped[3].bot?.result?.evidence, ["链接有效"]);
  assert.equal(mapped[2].role, "system");
  assert.equal(mapped[0].role, "user");
  assert.equal(mapped[4].role, "assistant");
});
