import assert from "node:assert/strict";
import test from "node:test";
import { conversationOutputs } from "../src/shared/conversation-outputs.ts";
import type { ChatMessage } from "../src/shared/types.ts";

const reply = (id: string, createdAt: number, tools: unknown[]): ChatMessage => ({ id, role: "assistant", createdAt, tools, text: "", parts: [] }) as ChatMessage;
const resolve = (path: string) => path.startsWith("/") ? path : `/repo/${path.replace(/^\.\//, "")}`;

test("outputs collapse repeated paths and point to the latest successful producing message", () => {
  const outputs = conversationOutputs([
    reply("first", 1, [{ id: "w", name: "write", status: "done", args: { path: "out/report.md" } }]),
    reply("latest", 2, [{ id: "e", name: "edit", status: "done", args: { path: "/repo/out/report.md" } }]),
    reply("failed", 3, [{ id: "f", name: "write", status: "error", args: { path: "/repo/out/report.md" } }]),
  ], resolve);
  assert.deepEqual(outputs, [{ path: "/repo/out/report.md", entryId: "latest", touchedAt: 2, title: undefined }]);
});

test("successful presented media is included while web resources and failed outputs are excluded", () => {
  const outputs = conversationOutputs([reply("a", 1, [{ id: "p", name: "present", status: "done", details: { items: [{ ref: "/repo/a.png", ok: true }, { ref: "/repo/missing.png", ok: false }, { ref: "https://example.com/a.png", ok: true }] } }])], resolve);
  assert.deepEqual(outputs.map((item) => item.path), ["/repo/a.png"]);
});
