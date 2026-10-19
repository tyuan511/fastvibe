import { test } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { Ipc } from "../src/shared/ipc.ts";
import type { Conversation, WorkspaceSnapshot } from "../src/shared/types.ts";
import { watchUnreadBadge } from "../src/main/dock-badge.ts";
import { broadcast } from "../src/main/ipc/broadcast.ts";
import { ConversationCatalog } from "../src/main/engine/conversation-catalog.ts";
import { openTestDb, testDir } from "./test-db.ts";

test("Dock badge restores persisted unread chats and clears them as they are opened", (t) => {
  const dir = testDir("fastvibe-dock-");
  const options = { scratchRoot: join(dir, "scratch") };
  const stored = new ConversationCatalog(openTestDb(dir), options);
  const first = stored.create(undefined);
  const second = stored.create(undefined);
  stored.markUnread(first.id);
  stored.markUnread(second.id);
  stored.flush();

  const restored = new ConversationCatalog(openTestDb(dir), options);
  restored.onChange = (snapshot) => broadcast(Ipc.workspaceChanged, snapshot);
  const badges: string[] = [];
  t.after(watchUnreadBadge(restored.snapshot(), (text) => badges.push(text)));
  assert.deepEqual(badges, ["2"], "no renderer or new completion event is needed at startup");

  restored.setActive(first.id);
  restored.flush();
  assert.deepEqual(badges, ["2", "1"]);
  restored.setActive(second.id);
  restored.flush();
  assert.deepEqual(badges, ["2", "1", ""], "an empty string removes the native badge");
});

test("Dock badge follows catalog mutations without accumulating completion events", (t) => {
  const dir = testDir("fastvibe-dock-");
  const catalog = new ConversationCatalog(openTestDb(dir), { scratchRoot: join(dir, "scratch") });
  catalog.onChange = (snapshot) => broadcast(Ipc.workspaceChanged, snapshot);
  const badges: string[] = [];
  t.after(watchUnreadBadge(catalog.snapshot(), (text) => badges.push(text)));
  const chat = catalog.create(undefined);
  catalog.markUnread(chat.id);
  catalog.flush();
  assert.deepEqual(badges, ["", "1"]);

  catalog.markUnread(chat.id);
  catalog.update(chat.id, { title: "renamed" });
  catalog.flush();
  assert.deepEqual(badges, ["", "1"], "repeat completions and renames do not increase the badge");
  catalog.remove(chat.id);
  catalog.flush();
  assert.deepEqual(badges, ["", "1", ""]);
});

test("merged broadcasts count local and remote chats once, exclude side chats, and can unsubscribe", () => {
  const chat = (id: string, extra: Partial<Conversation> = {}): Conversation => ({
    id, title: id, cwd: "/tmp", createdAt: 1, updatedAt: 1, unread: true, ...extra,
  });
  const snapshot = (conversations: Conversation[]): WorkspaceSnapshot => ({ projects: [], conversations });
  const local = chat("local");
  const remote = chat("remote:host:chat");
  const badges: string[] = [];
  const stop = watchUnreadBadge(snapshot([]), (text) => badges.push(text));
  try {
    broadcast(Ipc.workspaceChanged, snapshot([local, remote, remote, chat("side", { kind: "side-chat" })]), { except: "window:1" });
    assert.deepEqual(badges, ["", "2"], "origin exclusions must not suppress the native update");
    broadcast(Ipc.event, { type: "conversation_activity", status: "completed" });
    assert.deepEqual(badges, ["", "2"], "notifications and stream events are not the unread source");
    broadcast(Ipc.workspaceChanged, snapshot([local, { ...remote, unread: false }]));
    assert.deepEqual(badges, ["", "2", "1"], "a read on the remote host is reflected too");
    broadcast(Ipc.workspaceChanged, snapshot([]));
    assert.deepEqual(badges, ["", "2", "1", ""], "removing the last visible project clears the badge");
    stop();
    broadcast(Ipc.workspaceChanged, snapshot([local]));
    assert.deepEqual(badges, ["", "2", "1", ""], "shutdown detaches the native observer");
  } finally {
    stop();
  }
});
