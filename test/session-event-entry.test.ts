import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import test from "node:test";
import { belongsToTranscript } from "../src/renderer/src/lib/conversation-ownership.ts";
import type { EngineEvent } from "../src/shared/types.ts";

const ts = createRequire(import.meta.url)("typescript") as typeof import("typescript");

// Execute the actual store action without importing React/zustand or a DOM.
function eventAction(owner: string) {
  const source = readFileSync(new URL("../src/renderer/src/stores/session.ts", import.meta.url), "utf8");
  const file = ts.createSourceFile("session.ts", source, ts.ScriptTarget.Latest, true);
  let callback = "";
  function visit(node: import("typescript").Node): void {
    if (ts.isPropertyAssignment(node) && node.name.getText(file) === "applyEvent") {
      callback = node.initializer.getText(file);
    }
    ts.forEachChild(node, visit);
  }
  visit(file);
  assert.ok(callback);
  const compiled = ts.transpileModule(`const action = ${callback};`, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None },
  }).outputText;
  const applied: EngineEvent[] = [];
  const state = { activeId: owner, queued: [] };
  const factory = new Function("get", "set", "belongsToTranscript", "userMessageText", "COALESCED_EVENTS", "flushQueued", "reduceEvents", `${compiled}; return action;`);
  const action = factory(
    () => state,
    (update: (state: unknown) => unknown) => update(state),
    belongsToTranscript,
    () => undefined,
    new Set(),
    () => {},
    (_state: unknown, events: EngineEvent[]) => { applied.push(...events); return {}; },
  ) as (event: EngineEvent) => void;
  return { action, applied };
}

test("store immediate event entry rejects unattributed and local events while viewing remote", () => {
  const remote = "remote:srv_alpha:chat-1";
  const { action, applied } = eventAction(remote);
  action({ type: "extension_error", error: "local unscoped error" });
  action({ type: "extension_error", conversationId: "chat-1", error: "local scoped error" });
  action({ type: "agent_end", conversationId: "chat-1" });
  assert.deepEqual(applied, []);
  const own = { type: "extension_error", conversationId: remote, error: "remote error" };
  action(own);
  assert.deepEqual(applied, [own]);
});
