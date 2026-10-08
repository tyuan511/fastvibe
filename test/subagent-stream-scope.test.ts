import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import test from "node:test";
import * as state from "../src/shared/subagent-state.ts";
import type { ChatMessage, EngineEvent, SubagentInfo } from "../src/shared/types.ts";

// Real stream cache and pruning, with a small reducer and pane stub; no React, DOM or SDK.
const ts = createRequire(import.meta.url)("typescript") as typeof import("typescript");
const source = readFileSync(new URL("../src/renderer/src/stores/session-subagents.ts", import.meta.url), "utf8");
const compiled = ts.transpileModule(source, {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
}).outputText;
const exported: { applySubagentStream?: (streams: Record<string, ChatMessage[]>, event: EngineEvent, subagents: SubagentInfo[]) => Record<string, ChatMessage[]> } = {};
new Function("require", "exports", compiled)((name: string) => {
  if (name === "@shared/subagent-state") return state;
  if (name === "@/stores/side-pane") return { useSidePaneStore: { getState: () => ({ tabs: [], scopes: {} }) } };
  if (name === "@/lib/apply-engine-event") return { applyEngineEvent: (messages: ChatMessage[], event: EngineEvent) => ({ messages: [...messages, { text: event.text }] }) };
  throw new Error(`Unexpected import: ${name}`);
}, exported);
const apply = exported.applySubagentStream!;

test("subagent streams never mix identical run ids from separate hosts", () => {
  let streams: Record<string, ChatMessage[]> = {};
  const owners = ["c1", "remote:a:c1", "remote:b:c1"];
  for (const conversationId of owners) {
    streams = apply(streams, { type: "subagent_event", subagentId: "T-0001", conversationId, event: { type: "message_update", text: conversationId } }, []);
  }
  assert.equal(Object.keys(streams).length, 3);
  for (const owner of owners) assert.deepEqual(streams[state.subagentKey("T-0001", owner)].map((message) => message.text), [owner]);
});

test("stream pruning protects only the running owner's entry when another host reuses its run id", () => {
  const localKey = state.subagentKey("T-0001", "local");
  const remoteKey = state.subagentKey("T-0001", "remote:a:c1");
  let streams: Record<string, ChatMessage[]> = { [localKey]: [], [remoteKey]: [] };
  const subagents: SubagentInfo[] = [{ id: "T-0001", conversationId: "remote:a:c1", status: "running" }];
  for (let i = 0; i < 12; i++) {
    streams = apply(streams, { type: "subagent_event", subagentId: `other-${i}`, conversationId: "local", event: { type: "message_update", text: "x" } }, subagents);
  }
  assert.equal(Object.keys(streams).length, 12);
  assert.equal(streams[localKey], undefined);
  assert.ok(streams[remoteKey]);
});
