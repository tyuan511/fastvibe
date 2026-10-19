import { test } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { ConversationCatalog } from "../src/main/engine/conversation-catalog.ts";
import { openTestDb, testDir, type Db } from "./test-db.ts";
import type { WorkspaceSnapshot } from "../src/shared/types.ts";

/**
 * 「已完成但未读」 lives on the catalog row, not in a renderer map.
 *
 * The sidebar marks a chat whose reply landed while the reader was on another one, and the
 * project folder next to it aggregates those marks. Both have to answer the same questions
 * a second later, from a second process, or on a phone: is this still unread after a reload,
 * after a restart, in the window that did not cause it? A per-window map makes those wrong
 * in different directions — and `failedInBackground` (which *is* transient, and only claims
 * 「this run stopped badly in front of a window that has since moved on」) is the proof the
 * two are not the same fact.
 *
 * So the durable half is tested here: the write, the clear on open, and what the write must
 * *not* touch.
 */

function catalog(): { dir: string; db: Db; instance: ConversationCatalog; seen: WorkspaceSnapshot[] } {
  const dir = testDir("fastvibe-unread-");
  const db = openTestDb(dir);
  const instance = new ConversationCatalog(db, { scratchRoot: join(dir, "scratch") });
  const seen: WorkspaceSnapshot[] = [];
  instance.onChange = (snapshot) => seen.push(snapshot);
  return { dir, db, instance, seen };
}

/** Let the 40ms write debounce fire. */
function settle(): Promise<void> {
  return new Promise((done) => setTimeout(done, 80));
}

test("an unread mark is stored, announced, and survives a reopen", async () => {
  const { dir, instance, seen } = catalog();
  const chat = instance.create("/tmp/proj");
  await settle();
  seen.length = 0;

  instance.markUnread(chat.id);
  await settle();
  assert.equal(instance.get(chat.id)?.unread, true);
  // The list is what every client draws, and the notice is how a second window or a phone
  // learns about it — a mark that only Main's memory holds would never reach them.
  assert.equal(seen.at(-1)?.conversations.find((item) => item.id === chat.id)?.unread, true);

  const reopened = new ConversationCatalog(openTestDb(dir), { scratchRoot: join(dir, "scratch") });
  assert.equal(reopened.get(chat.id)?.unread, true, "and it is still unread after a restart");
});

test("opening the chat is reading it: the mark comes off in memory and on disk", async () => {
  const { dir, instance } = catalog();
  const first = instance.create("/tmp/proj");
  const second = instance.create("/tmp/proj");
  instance.markUnread(second.id);
  await settle();

  instance.setActive(second.id);
  assert.equal(instance.get(second.id)?.unread, undefined, "absent, not false");
  await settle();
  const reopened = new ConversationCatalog(openTestDb(dir), { scratchRoot: join(dir, "scratch") });
  assert.equal(reopened.get(second.id)?.unread, undefined);
  // The chat the reader left is untouched.
  assert.equal(reopened.get(first.id)?.unread, undefined);
});

test("an already-active chat that only needs its mark cleared still writes", async () => {
  const { instance } = catalog();
  const chat = instance.create("/tmp/proj");
  instance.setActive(chat.id);
  instance.markUnread(chat.id);
  assert.equal(instance.get(chat.id)?.unread, true);
  // `setActive` returns early for an unchanged id, so the clear must not live behind that
  // guard — a mark that cannot be cleared is a dot that never leaves the row.
  instance.setActive(chat.id);
  assert.equal(instance.get(chat.id)?.unread, undefined);
});

test("marking unread is not a mutation of the chat", async () => {
  const { instance } = catalog();
  const chat = instance.create("/tmp/proj");
  const before = instance.get(chat.id)!.updatedAt;
  await new Promise((done) => setTimeout(done, 5));

  // `updatedAt` is what 设置 → 归档对话 shows as 更新时间 and what the auto-archive sweep
  // waits on. Slowly reading a finished reply must not push a chat out of both.
  instance.markUnread(chat.id);
  assert.equal(instance.get(chat.id)!.updatedAt, before);
});

test("marking twice writes once, and a side chat is never marked", async () => {
  const { instance, seen } = catalog();
  const chat = instance.create("/tmp/proj");
  const side = instance.create("/tmp/proj", { sessionId: "side-1" }, { kind: "side-chat", parentId: chat.id });
  await settle();
  seen.length = 0;

  instance.markUnread(chat.id);
  instance.markUnread(chat.id);
  instance.markUnread(side.id);
  await settle();
  assert.equal(seen.length, 1, "one change notice for the one real change");
  assert.equal(instance.get(chat.id)?.unread, true);
  assert.equal(instance.get(side.id)?.unread, undefined, "an answer nobody sees in the sidebar cannot be unread");
});
