import { test } from "node:test";
import assert from "node:assert/strict";
import {
  AUTO_ARCHIVE_OFF,
  DEFAULT_AUTO_ARCHIVE_DAYS,
  readAutoArchiveDays,
  staleConversationIds,
} from "../src/shared/auto-archive.ts";
import type { Conversation } from "../src/shared/types.ts";

/**
 * 自动归档 decides which chats leave the sidebar on their own. That decision is a rule,
 * not a screen: a mistake here is a person's work disappearing from a list they were
 * reading, so the eligible set is enumerated rather than discovered in the GUI.
 *
 * The two facts the cases turn on are which conversations are *never* candidates (a
 * side chat, an empty draft, a running one, the one on screen) and what "stale" means
 * (`updatedAt` older than the window — exactly at the boundary is not yet stale).
 */

const NOW = Date.UTC(2026, 0, 31, 12, 0, 0);
const DAY = 24 * 60 * 60 * 1000;

function conversation(id: string, updatedAt: number, patch: Partial<Conversation> = {}): Conversation {
  return {
    id,
    title: id,
    cwd: `/tmp/${id}`,
    createdAt: updatedAt,
    updatedAt,
    preview: `${id} prompt`,
    ...patch,
  };
}

const daysAgo = (days: number) => NOW - days * DAY;

test("a conversation older than the window is archived, one inside it is not", () => {
  const ids = staleConversationIds(
    [conversation("old", daysAgo(31)), conversation("fresh", daysAgo(29))],
    { now: NOW, days: 30 },
  );
  assert.deepEqual(ids, ["old"]);
});

test("the boundary belongs to the window, not to the archive", () => {
  // `updatedAt < cutoff`: exactly 30 days old is still inside the window.
  const ids = staleConversationIds([conversation("edge", daysAgo(30))], { now: NOW, days: 30 });
  assert.deepEqual(ids, []);
});

test("oldest first, so an 撤销 reads in the order the rows disappeared", () => {
  const ids = staleConversationIds(
    [conversation("middle", daysAgo(60)), conversation("oldest", daysAgo(200)), conversation("recent", daysAgo(40))],
    { now: NOW, days: 30 },
  );
  assert.deepEqual(ids, ["oldest", "middle", "recent"]);
});

test("0 days turns the sweep off, and never means \"archive everything\"", () => {
  const ids = staleConversationIds([conversation("ancient", daysAgo(4000))], { now: NOW, days: AUTO_ARCHIVE_OFF });
  assert.deepEqual(ids, []);
});

test("an already archived conversation is left where it is", () => {
  const ids = staleConversationIds([conversation("old", daysAgo(90))], {
    now: NOW,
    days: 30,
    archived: new Set(["old"]),
  });
  assert.deepEqual(ids, []);
});

test("a run in flight is never archived mid-reply", () => {
  const ids = staleConversationIds([conversation("old", daysAgo(90))], {
    now: NOW,
    days: 30,
    running: new Set(["old"]),
  });
  assert.deepEqual(ids, []);
});

test("the chat on screen keeps its sidebar row", () => {
  // Hiding it would leave an open thread nothing points at.
  const ids = staleConversationIds([conversation("old", daysAgo(90))], { now: NOW, days: 30, activeId: "old" });
  assert.deepEqual(ids, []);
});

test("a pinned chat stays in the 已置顶 section it was put in", () => {
  const ids = staleConversationIds([conversation("old", daysAgo(90))], {
    now: NOW,
    days: 30,
    pinned: new Set(["old"]),
  });
  assert.deepEqual(ids, []);
});

test("a side chat and an empty draft are not archive material", () => {
  const ids = staleConversationIds(
    [
      conversation("side", daysAgo(90), { kind: "side-chat" }),
      // No preview is how the catalog spots the project's blank draft, which 新对话 reuses.
      conversation("draft", daysAgo(90), { preview: undefined }),
    ],
    { now: NOW, days: 30 },
  );
  assert.deepEqual(ids, []);
});

test("a stored day value is read back, and anything else falls to the default", () => {
  assert.equal(readAutoArchiveDays(7), 7);
  assert.equal(readAutoArchiveDays(AUTO_ARCHIVE_OFF), AUTO_ARCHIVE_OFF);
  assert.equal(readAutoArchiveDays("30"), DEFAULT_AUTO_ARCHIVE_DAYS);
  assert.equal(readAutoArchiveDays(-1), DEFAULT_AUTO_ARCHIVE_DAYS);
  assert.equal(readAutoArchiveDays(1.5), DEFAULT_AUTO_ARCHIVE_DAYS);
  assert.equal(readAutoArchiveDays(undefined), DEFAULT_AUTO_ARCHIVE_DAYS);
  assert.equal(DEFAULT_AUTO_ARCHIVE_DAYS, 30);
});
