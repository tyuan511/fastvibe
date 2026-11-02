import assert from "node:assert/strict";
import test from "node:test";
import { viviLatestReply } from "../src/renderer/src/lib/vivi-chat.ts";
import type { ChatMessage } from "../src/shared/types.ts";

test("reply preview shows the latest assistant text and never an answer before the current user turn", () => {
  const message = (role: "user" | "assistant", text: string) => ({ role, text }) as ChatMessage;
  assert.equal(viviLatestReply([message("user", "Hi"), message("assistant", "Hello")]), "Hello");
  assert.equal(viviLatestReply([message("assistant", "Old answer"), message("user", "New question"), message("assistant", "")]), "");
  assert.equal(viviLatestReply([message("assistant", "First paragraph"), message("assistant", ""), message("assistant", "Last paragraph")]), "Last paragraph");
});
