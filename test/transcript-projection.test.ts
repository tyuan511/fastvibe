import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import test from "node:test";
import type { ChatMessage } from "../src/shared/types.ts";

const ts = createRequire(import.meta.url)("typescript") as typeof import("typescript");
const compiled = ts.transpileModule(
  readFileSync(new URL("../src/renderer/src/lib/group-parts.tsx", import.meta.url), "utf8"),
  { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX } },
).outputText;
const exports_: {
  groupMessageRowsIncremental?: (messages: ChatMessage[], previous?: unknown) => unknown;
  groupMessageRows?: (messages: ChatMessage[]) => unknown;
} = {};
new Function("require", "exports", compiled)((name: string) => {
  if (name === "@/lib/i18n") return { i18n: { language: "en", t: (key: string) => key } };
  if (name === "./tool-run") {
    return {
      collapseToolRuns: () => [],
      runSummary: () => ({ line: "", pieces: [] }),
    };
  }
  throw new Error(`Unexpected dependency: ${name}`);
}, exports_);

const project = exports_.groupMessageRowsIncremental! as (messages: ChatMessage[], previous?: any) => any;
const full = exports_.groupMessageRows!;

function message(id: string, role: "user" | "assistant", text: string): ChatMessage {
  return { id, role, text, tools: [], parts: text ? [{ kind: "text", text }] : [], createdAt: 1 };
}

function rowShape(rows: Array<{ id: string; messages: ChatMessage[] }>): string[][] {
  return rows.map((row) => row.messages.map((item) => `${item.id}:${item.role}:${item.text}`));
}

test("streaming tail reuses settled rows, turns, and indexes", () => {
  const messages: ChatMessage[] = [];
  for (let index = 0; index < 300; index += 1) {
    messages.push(message(`u-${index}`, "user", `prompt ${index}`));
    messages.push(message(`a-${index}`, "assistant", `answer ${index}`));
  }
  const before = project(messages);
  const changedTail = { ...messages.at(-1)!, text: "answer 299 extended", parts: [{ kind: "text", text: "answer 299 extended" }] };
  const nextMessages = [...messages.slice(0, -1), changedTail];
  const after = project(nextMessages, before);

  assert.deepEqual(rowShape(after.rows), rowShape(full!(nextMessages) as any));
  assert.equal(after.rows.length, before.rows.length);
  for (let index = 0; index < before.rows.length - 1; index += 1) assert.equal(after.rows[index], before.rows[index]);
  for (let index = 0; index < before.turns.length - 1; index += 1) assert.equal(after.turns[index], before.turns[index]);
  assert.notEqual(after.rows.at(-1), before.rows.at(-1));
  assert.notEqual(after.turns.at(-1), before.turns.at(-1));
  // Content changed, but all navigation keys and values are unchanged, so their maps stay shared.
  assert.equal(after.rowIndex, before.rowIndex);
  assert.equal(after.rowIndexByMessage, before.rowIndexByMessage);
});

test("appending a new turn preserves the complete previous prefix", () => {
  const initial = [message("u-1", "user", "one"), message("a-1", "assistant", "reply")];
  const before = project(initial);
  const next = [...initial, message("u-2", "user", "two"), message("a-2", "assistant", "reply two")];
  const after = project(next, before);

  assert.deepEqual(rowShape(after.rows), rowShape(full!(next) as any));
  assert.equal(after.rows[0], before.rows[0]);
  assert.equal(after.rows[1], before.rows[1]);
  assert.equal(after.turns[0], before.turns[0]);
  assert.equal(after.rows.length, 4);
  assert.equal(after.turns.length, 2);
  assert.equal(after.rowIndex.get("a-2"), 3);
  assert.equal(after.rowIndexByMessage.get("a-2"), 1);
});

test("mid-transcript replacement keeps assistant-run grouping and removes stale index keys", () => {
  const initial = [
    message("u-1", "user", "one"),
    message("a-1", "assistant", "first"),
    message("a-2", "assistant", "tool follow-up"),
    message("u-2", "user", "two"),
    message("a-3", "assistant", "second reply"),
  ];
  const before = project(initial);
  assert.deepEqual(before.rows.map((row: any) => row.messages.map((item: any) => item.id)), [["u-1"], ["a-1", "a-2"], ["u-2"], ["a-3"]]);
  const replacement = message("a-2-new", "assistant", "replacement");
  const next = [...initial.slice(0, 2), replacement, ...initial.slice(3)];
  const after = project(next, before);

  assert.deepEqual(rowShape(after.rows), rowShape(full!(next) as any));
  assert.equal(after.rows[0], before.rows[0], "the prompt before the edit remains settled");
  assert.equal(after.rowIndex.get("a-1"), 1);
  assert.equal(after.rowIndex.get("a-2"), undefined);
  assert.equal(after.rowIndexByMessage.get("a-2-new"), 0);
  assert.equal(after.rowIndexByMessage.get("a-2"), undefined);
  assert.equal(after.rowIndexByMessage.get("a-3"), 1);
});

test("compact splitting remains stable while the body streams", () => {
  const compact = { kind: "compact", text: "summary", compact: { status: "done" as const } };
  const first: ChatMessage = {
    id: "a-1",
    role: "assistant",
    text: "body",
    tools: [],
    parts: [{ kind: "text", text: "body" }, compact],
    createdAt: 1,
  };
  const before = project([first]);
  assert.deepEqual(before.rows.map((row: any) => row.messages[0].role), ["assistant", "system"]);
  assert.equal(before.rows[1].id, "a-1:compact");
  const updated = { ...first, text: "body +", parts: [{ kind: "text", text: "body +" }, compact] };
  const after = project([updated], before);
  assert.deepEqual(rowShape(after.rows), rowShape(full!([updated]) as any));
  assert.equal(after.rows.length, 2);
  assert.equal(after.rows[1], before.rows[1], "the settled compact divider is reused");
  assert.notEqual(after.rows[0], before.rows[0], "only the streaming body row changes");
});
