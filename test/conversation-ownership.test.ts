import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { belongsToTranscript, sessionBelongsToConversation } from "../src/renderer/src/lib/conversation-ownership.ts";

const remote = "remote:srv_alpha:chat-1";

test("state from local, another server, or a draft cannot replace the remote composer", () => {
  for (const conversationId of ["chat-1", "remote:srv_beta:chat-1", undefined]) {
    assert.equal(sessionBelongsToConversation({ conversationId, isStreaming: false }, remote), false);
  }
  assert.equal(sessionBelongsToConversation({ conversationId: remote, isStreaming: true }, remote), true);
  assert.equal(sessionBelongsToConversation({ isStreaming: false }, null), true);
  assert.equal(sessionBelongsToConversation({ conversationId: remote, isStreaming: false }, null), false);
});

test("local or unattributed transcript events cannot enter a remote transcript", () => {
  for (const type of ["message_update", "agent_end", "extension_error"]) {
    for (const conversationId of ["chat-1", "remote:srv_beta:chat-1", undefined]) {
      assert.equal(belongsToTranscript({ type, conversationId }, remote), false);
    }
    assert.equal(belongsToTranscript({ type, conversationId: remote }, remote), true);
  }
});

test("background prompts and subagents still update their keyed state, but not the visible editor", () => {
  assert.equal(belongsToTranscript({ type: "subagent_event", conversationId: "local" }, remote), true);
  assert.equal(belongsToTranscript({ type: "extension_ui_request", method: "confirm", conversationId: "local" }, remote), true);
  assert.equal(belongsToTranscript({ type: "extension_ui_dismiss", conversationId: "local" }, remote), true);
  assert.equal(belongsToTranscript({ type: "extension_ui_request", method: "set_editor_text", conversationId: "local" }, remote), false);
  assert.equal(belongsToTranscript({ type: "extension_ui_request", method: "set_editor_text", conversationId: remote }, remote), true);
});

test("App session reads and mutations cannot bypass the conversation-scoped facade", () => {
  const source = readFileSync(new URL("../src/renderer/src/App.tsx", import.meta.url), "utf8");
  assert.doesNotMatch(source, /window\.fastvibe\.engine\s*\.\s*(?:getMessages|getState|getStats|setThinking|setModel)\s*\(/);
  assert.match(source, /createConversationRefresh\(engine, useSessionStore\.getState\)/);
});
