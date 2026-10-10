import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import test from "node:test";
import * as attachmentMetadata from "../src/shared/attachment-metadata.ts";
import * as toolResult from "../src/shared/tool-result.ts";
import type { ChatMessage, EngineEvent } from "../src/shared/types.ts";

const ts = createRequire(import.meta.url)("typescript") as typeof import("typescript");
const compiled = ts.transpileModule(
  readFileSync(new URL("../src/renderer/src/lib/apply-engine-event.ts", import.meta.url), "utf8"),
  { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } },
).outputText;
const exports: { applyEngineEvent?: (messages: ChatMessage[], event: EngineEvent, streaming: boolean) => { messages: ChatMessage[] } } = {};
new Function("require", "exports", compiled)((name: string) => {
  if (name === "@shared/attachment-metadata") return attachmentMetadata;
  if (name === "@shared/tool-result") return toolResult;
  if (name.endsWith("random.ts")) return { randomUUID };
  if (name === "@/lib/i18n") return { i18n: { t: (key: string) => key } };
  throw new Error(`Unexpected dependency: ${name}`);
}, exports);

test("a reply placeholder counts from the prompt, not from the event that rebuilt it", () => {
  const row = (id: string, role: "user" | "assistant", text: string, createdAt: number): ChatMessage =>
    ({ id, role, text, tools: [], parts: text ? [{ kind: "text", text }] : [], createdAt });
  const before = Date.now();
  const next = exports.applyEngineEvent!(
    [row("u1", "user", "do the thing", 1_000)],
    { type: "agent_start" } as EngineEvent,
    false,
  ).messages;
  assert.equal(next.at(-1)?.role, "assistant");
  assert.equal(next.at(-1)?.createdAt, 1_000);
  assert.ok(before <= Date.now());
});

test("the engine's echo of a 立即 turn does not draw a second user row", () => {
  const row = (id: string, role: "user" | "assistant", text: string): ChatMessage =>
    ({ id, role, text, tools: [], parts: text ? [{ kind: "text", text }] : [], createdAt: 1 });
  // showQueuedNow: `queue:` user row plus the placeholder reply.
  const shown = [row("queue:q1", "user", "next"), row("local:q1", "assistant", "")];
  const echoed = exports.applyEngineEvent!(
    shown,
    { type: "message_start", message: { role: "user", content: [{ type: "text", text: "next" }] } } as EngineEvent,
    true,
  ).messages;
  assert.equal(echoed.filter((message) => message.role === "user").length, 1);
});
