import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { runInNewContext } from "node:vm";
import { sessionEntryToContextMessages } from "@earendil-works/pi-coding-agent";
import { mapEngineMessages } from "../src/main/engine/map-messages.ts";
import { transcriptWindow } from "../src/main/engine/transcript-window.ts";

const require = createRequire(import.meta.url);
const ts = require("typescript") as typeof import("typescript");
// Exercise the real projection and SDK mapping without importing Electron's TUI bridge.
const source = readFileSync(new URL("../src/main/pi/process-manager-transcript.ts", import.meta.url), "utf8");
const compiled = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
const module = { exports: {} };
const dependencies: Record<string, unknown> = {
  "@earendil-works/pi-coding-agent": { sessionEntryToContextMessages },
  "../engine/map-messages": { mapEngineMessages },
  "./tui-bridge": { renderExtensionMessage: () => undefined },
  "./process-manager-events": { isRecord: (value: unknown) => typeof value === "object" && value !== null },
  "../engine/transcript-window": { transcriptWindow },
};
runInNewContext(compiled, { module, exports: module.exports, Date, Map, require: (name: string) => {
  assert.ok(name in dependencies, name); return dependencies[name];
} });
const { projectSessionMessages: project } = module.exports as typeof import("../src/main/pi/process-manager-transcript.ts");
type Entry = { id: string; type: string; timestamp: string; message?: Record<string, unknown>; [key: string]: unknown };
const stamp = "2026-10-08T00:00:00.000Z";
function entry(id: string, role: string, content: unknown, extra: Record<string, unknown> = {}): Entry {
  return { id, type: "message", timestamp: stamp, message: { role, content, timestamp: 1000, ...extra } };
}
function setup(branch: Entry[], running = false, compacting = false) {
  return {
    session: {
      sessionManager: { getBranch: () => branch, getEntries: () => { throw new Error("must not scan unrelated branches for completion timestamps"); } },
      extensionRunner: { getMessageRenderer: () => undefined },
      state: { streamingMessage: { role: "assistant", content: [{ type: "text", text: "stream" }], timestamp: 1234 } },
    },
    conversationId: "chat", reasoning: { get: () => [{ startedAt: 100, endedAt: 200 }] }, widgetWidth: 80,
    running: new Map([["chat", running]]), compacting: new Map(compacting ? [["chat", "manual"]] : []),
  } as unknown as Parameters<typeof project>[0];
}
function allPages(deps: Parameters<typeof project>[0], limit: number) {
  const latest = project({ ...deps, page: { turnLimit: limit } });
  let cursor = latest.history?.beforeEntryId;
  let messages = latest.messages;
  let pages = 1;
  while (cursor) {
    const older = project({ ...deps, page: { turnLimit: limit, beforeEntryId: cursor } });
    assert.equal(older.pageAnchorFound, true);
    assert.notEqual(older.history?.beforeEntryId, cursor);
    messages = [...older.messages, ...messages];
    cursor = older.history?.beforeEntryId;
    assert.ok(++pages < 100);
  }
  return { messages, latest, pages };
}

test("paged projection reconstructs the full transcript including tools, images, model changes and compactions", () => {
  const branch: Entry[] = [{ id: "settings", type: "model_change", timestamp: stamp }];
  for (let index = 0; index < 37; index++) {
    const model = index % 2 ? "a" : "b";
    branch.push(entry(`u${index}`, "user", [{ type: "text", text: `question ${index}` }, { type: "image", data: "YWJj", mimeType: "image/png" }]));
    branch.push(entry(`a${index}`, "assistant", [{ type: "thinking", thinking: "think" }, { type: "text", text: `answer ${index}` },
      { type: "toolCall", id: `tool${index}`, name: "read", arguments: { path: "a" } }], { provider: "p", model }));
    branch.push(entry(`r${index}`, "toolResult", [{ type: "text", text: "tool output" }], { toolCallId: `tool${index}` }));
    branch.push(entry(`b${index}`, "assistant", [{ type: "text", text: "done" }], { provider: "p", model }));
    if (index % 3 === 0) branch.push({ id: `c${index}`, type: "compaction", timestamp: stamp, summary: "summary", tokensBefore: 1000 });
  }
  for (const [running, compacting] of [[false, false], [true, false], [true, true]]) {
    const deps = setup(branch, running, compacting);
    const full = project(deps).messages;
    const paged = allPages(deps, 4);
    assert.deepEqual(paged.messages, full);
    assert.ok(paged.latest.messages.length < full.length / 3);
    assert.ok(paged.pages > 1);
  }
});

test("steering between a tool call and result cannot split that result away from its owner", () => {
  const branch = [entry("u0", "user", "first"), entry("a0", "assistant", [{ type: "toolCall", id: "t", name: "read" }]),
    entry("steer", "user", "while busy"), entry("result", "toolResult", "result text", { toolCallId: "t" }),
    entry("a1", "assistant", "finished"), entry("u2", "user", "next"), entry("a2", "assistant", "last")];
  const deps = setup(branch);
  const pages = allPages(deps, 1);
  assert.deepEqual(pages.messages, project(deps).messages);
  assert.equal(pages.messages.find((message) => message.id === "a0")?.tools[0].result, "result text");
  assert.equal(transcriptWindow(branch, 1, "steer").found, false);
});

test("empty users do not separate a compaction from its preceding visible reply", () => {
  const deps = setup([entry("a0", "assistant", "first"), entry("empty", "user", ""),
    { id: "compact", type: "compaction", timestamp: stamp, summary: "summary" }, entry("u1", "user", "next"), entry("a1", "assistant", "last")]);
  assert.deepEqual(allPages(deps, 1).messages, project(deps).messages);
});

test("a removed or no-longer-safe cursor requests a reset instead of serving a different branch", () => {
  const deps = setup([entry("u", "user", "current"), entry("a", "assistant", "reply")], true);
  const page = project({ ...deps, page: { turnLimit: 5, beforeEntryId: "removed" } });
  assert.equal(page.pageAnchorFound, false);
  assert.deepEqual(page.messages, []);
});

test("small transcripts, legacy full reads and empty transcripts remain complete", () => {
  const deps = setup([entry("u", "user", "current"), entry("a", "assistant", "reply")]);
  assert.deepEqual(project({ ...deps, page: { turnLimit: 12 } }).messages, project(deps).messages);
  assert.equal(project({ ...deps, page: { turnLimit: 12 } }).history?.beforeEntryId, null);
  assert.equal(project(deps).history, undefined);
  assert.equal(transcriptWindow([], 12).beforeEntryId, null);
});
