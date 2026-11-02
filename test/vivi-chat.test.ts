import assert from "node:assert/strict";
import test from "node:test";
import { sendViviMessage, viviLatestReply, type ViviChatHost } from "../src/renderer/src/lib/vivi-chat.ts";
import type { ChatMessage } from "../src/shared/types.ts";

function fixture(running = false) {
  const events: unknown[] = [];
  const host: ViviChatHost = {
    create: async () => { events.push("create"); return "new-vivi-chat"; },
    created: (id) => { events.push({ created: id }); },
    isRunning: () => running,
    submit: async (request) => { events.push(request); },
  };
  return { host, events };
}

test("follow-ups always name the selected conversation, including remote conversations", async () => {
  const f = fixture();
  const id = "remote:server:conversation";
  assert.equal(await sendViviMessage(f.host, "  Continue with this  ", id), id);
  assert.deepEqual(f.events, [{ conversationId: id, text: "Continue with this", enqueue: false }]);
});

test("new chat is created once and retained before submission can fail", async () => {
  const f = fixture();
  f.host.submit = async () => { throw new Error("provider unavailable"); };
  await assert.rejects(sendViviMessage(f.host, "Hello"), /provider unavailable/);
  assert.deepEqual(f.events, ["create", { created: "new-vivi-chat" }]);
});

test("follow-ups during a running turn use the host queue", async () => {
  const f = fixture(true);
  await sendViviMessage(f.host, "Next step", "chat");
  assert.deepEqual(f.events, [{ conversationId: "chat", text: "Next step", enqueue: true }]);
});

test("empty messages do not create conversations or submit requests", async () => {
  const f = fixture();
  await assert.rejects(sendViviMessage(f.host, "   "), /Empty/);
  assert.deepEqual(f.events, []);
});

test("reply preview shows the latest assistant text and never an answer before the current user turn", () => {
  const message = (role: "user" | "assistant", text: string) => ({ role, text }) as ChatMessage;
  assert.equal(viviLatestReply([message("user", "Hi"), message("assistant", "Hello")]), "Hello");
  assert.equal(viviLatestReply([message("assistant", "Old answer"), message("user", "New question"), message("assistant", "")]), "");
  assert.equal(viviLatestReply([message("assistant", "First paragraph"), message("assistant", ""), message("assistant", "Last paragraph")]), "Last paragraph");
});
