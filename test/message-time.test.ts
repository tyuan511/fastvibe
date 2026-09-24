import { test } from "node:test";
import assert from "node:assert/strict";
import { formatMessageTime, isSameDay } from "../src/renderer/src/lib/message-time.ts";

/**
 * A transcript's footer is read on the day it was written *and* weeks later, when an
 * old chat is reopened and every bare `14:32` on screen appears to be from today. The
 * rule is narrow — the date joins the time only when the message is not from today —
 * so it is worth pinning: too eager and every today-message grows a date for nothing,
 * too shy and the ambiguity it exists to remove stays.
 */

// A fixed "now" so the rule is tested rather than the wall clock: 2026-09-04, 14:32 local.
const NOW = new Date(2026, 8, 4, 14, 32, 0).getTime();
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
/** A *calendar* day back, rather than `now - 86400000`: a fixed day is what the rule
 * compares, so the test must not subtract hours across a daylight-saving shift. */
const dayBefore = (date: Date): number => new Date(date.getFullYear(), date.getMonth(), date.getDate() - 1, 14, 32).getTime();

test("a message from today shows the bare clock", () => {
  assert.equal(formatMessageTime(NOW - 2 * HOUR, "zh-CN", NOW), "12:32");
});

test("yesterday brings the date and drops the current year", () => {
  const yesterday = dayBefore(new Date(NOW));
  assert.equal(formatMessageTime(yesterday, "zh-CN", NOW), "9月3日 14:32");
  assert.equal(formatMessageTime(yesterday, "en-US", NOW), "Sep 3 14:32");
});

test("just before midnight yesterday is dated, however recent it is", () => {
  // The boundary a naive `now - timestamp < 24h` gets wrong: the message is minutes old,
  // but it is not the same calendar day, so it must carry its date. Midnight itself is
  // the first instant of *today*, and a stamp on it stays a bare clock.
  const midnight = new Date(2026, 8, 4, 0, 0, 0).getTime();
  assert.equal(formatMessageTime(midnight, "zh-CN", midnight + 5 * MINUTE), "00:00");
  assert.equal(formatMessageTime(midnight - MINUTE, "zh-CN", midnight + 5 * MINUTE), "9月3日 23:59");
});

test("another year names the year, so an old chat can be placed", () => {
  assert.equal(
    formatMessageTime(new Date(2025, 11, 31, 9, 5, 0).getTime(), "zh-CN", NOW),
    "2025年12月31日 09:05",
  );
  assert.equal(
    formatMessageTime(new Date(2025, 11, 31, 9, 5, 0).getTime(), "en-US", NOW),
    "Dec 31, 2025 09:05",
  );
});

test("a clock that disagrees is not today", () => {
  // A future stamp is a machine pointing at the wrong day, never a message from today —
  // including one a few hours ahead, which is still on today's calendar day and would
  // slip through a same-day check that ran first.
  assert.equal(formatMessageTime(NOW + 3 * HOUR, "zh-CN", NOW), "9月4日 17:32");
  assert.equal(formatMessageTime(new Date(2026, 8, 5, 14, 32).getTime(), "zh-CN", NOW), "9月5日 14:32");
});

test("the language decides the date wording, and the time stays 24-hour", () => {
  const evening = new Date(2026, 8, 3, 21, 5, 0).getTime();
  assert.equal(formatMessageTime(evening, "zh-CN", NOW), "9月3日 21:05");
  assert.equal(formatMessageTime(evening, "en-US", NOW), "Sep 3 21:05");
});

test("an unusable timestamp renders nothing rather than `Invalid Date`", () => {
  assert.equal(formatMessageTime(Number.NaN, "zh-CN", NOW), "");
});

test("same-day compares the calendar, not the distance", () => {
  const night = new Date(2026, 8, 4, 23, 59, 0);
  assert.equal(isSameDay(night, new Date(2026, 8, 4, 0, 1, 0)), true);
  assert.equal(isSameDay(night, new Date(2026, 8, 5, 0, 1, 0)), false);
  // A month (and a year) boundary is the same rule.
  assert.equal(isSameDay(new Date(2025, 11, 31, 20, 0), new Date(2026, 0, 1, 1, 0)), false);
});
