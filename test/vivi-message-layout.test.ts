import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import test from "node:test";
import { formatViviMessageTime, viviMessageLayout } from "../src/renderer/src/lib/vivi-message-layout.ts";

const MINUTE = 60_000;
const NOW = new Date(2026, 8, 4, 14, 32).getTime();
const message = (id: string, role: string, createdAt: number) => ({ id, role, createdAt, text: id });

function flags(messages: Parameters<typeof viviMessageLayout>[0]) {
  return viviMessageLayout(messages).map(({ showTime, groupStart, showDay }) => ({ showTime, groupStart, showDay }));
}

test("empty history has no rows, and its first message starts a dated group", () => {
  assert.deepEqual(viviMessageLayout([]), []);
  assert.deepEqual(flags([message("first", "assistant", NOW)]), [
    { showTime: true, groupStart: true, showDay: true },
  ]);
});

test("five minutes is an inclusive time boundary measured from the preceding message", () => {
  const rows = flags([
    message("first", "user", NOW),
    message("under", "user", NOW + 5 * MINUTE - 1),
    message("exact", "user", NOW + 10 * MINUTE - 1),
    message("later", "user", NOW + 16 * MINUTE),
  ]);
  assert.deepEqual(rows, [
    { showTime: true, groupStart: true, showDay: true },
    { showTime: false, groupStart: false, showDay: false },
    { showTime: true, groupStart: true, showDay: false },
    { showTime: true, groupStart: true, showDay: false },
  ]);
});

test("crossing midnight names the new calendar day even one minute later", () => {
  for (const [before, after] of [
    [new Date(2026, 8, 4, 23, 59), new Date(2026, 8, 5, 0, 0)],
    [new Date(2026, 8, 30, 23, 59), new Date(2026, 9, 1, 0, 0)],
    [new Date(2026, 11, 31, 23, 59), new Date(2027, 0, 1, 0, 0)],
  ]) {
    assert.deepEqual(flags([message("before", "assistant", before.getTime()), message("after", "assistant", after.getTime())])[1], {
      showTime: true, groupStart: true, showDay: true,
    });
  }
});

test("consecutive messages remain separate while sender changes start a new group", () => {
  const source = [
    message("user-a", "user", NOW),
    message("user-b", "user", NOW + MINUTE),
    message("reply-a", "assistant", NOW + 2 * MINUTE),
    message("reply-b", "assistant", NOW + 3 * MINUTE),
    message("user-c", "user", NOW + 4 * MINUTE),
  ];
  const rows = viviMessageLayout(source);
  assert.equal(rows.length, source.length);
  assert.deepEqual(rows.map((row) => row.groupStart), [true, false, true, false, true]);
  assert.deepEqual(rows.map((row) => row.showTime), [true, false, false, false, false]);
  rows.forEach((row, index) => assert.equal(row.message, source[index]));
});

test("system messages break a group on both sides, including adjacent system rows", () => {
  assert.deepEqual(flags([
    message("reply", "assistant", NOW),
    message("status-a", "system", NOW + MINUTE),
    message("status-b", "system", NOW + 2 * MINUTE),
    message("reply-next", "assistant", NOW + 3 * MINUTE),
  ]).map((row) => row.groupStart), [true, true, true, true]);
});

test("layout preserves frozen inputs, caller order and extra message fields", () => {
  const source = Object.freeze([
    Object.freeze(message("later", "user", NOW + MINUTE)),
    Object.freeze(message("earlier", "user", NOW)),
  ]);
  const before = JSON.stringify(source);
  const rows = viviMessageLayout(source);
  assert.deepEqual(rows.map((row) => row.message.id), ["later", "earlier"]);
  assert.equal(rows[0].message, source[0]);
  assert.equal(rows[1].message, source[1]);
  assert.equal(rows[1].message.text, "earlier");
  assert.equal(rows[1].showTime, false, "timestamps do not reorder the message feed");
  assert.equal(JSON.stringify(source), before);
});

test("today uses a 24-hour clock and a localized day only when requested", () => {
  const stamp = new Date(2026, 8, 4, 9, 5).getTime();
  assert.equal(formatViviMessageTime(stamp, "zh-CN", NOW), "09:05");
  assert.equal(formatViviMessageTime(stamp, "en-US", NOW), "09:05");
  assert.equal(formatViviMessageTime(stamp, "zh-CN", NOW, true), "今天 09:05");
  assert.equal(formatViviMessageTime(stamp, "en-US", NOW, true), "Today 09:05");
  const midnight = new Date(2026, 8, 4, 0, 0).getTime();
  assert.equal(formatViviMessageTime(midnight, "en-US", NOW), "00:00");
});

test("yesterday remains explicit, including across the year boundary", () => {
  const yesterday = new Date(2026, 8, 3, 21, 5).getTime();
  assert.equal(formatViviMessageTime(yesterday, "zh-CN", NOW), "昨天 21:05");
  assert.equal(formatViviMessageTime(yesterday, "en-US", NOW), "Yesterday 21:05");
  assert.equal(formatViviMessageTime(yesterday, "en-US", NOW, true), "Yesterday 21:05");
  const newYear = new Date(2027, 0, 1, 0, 1).getTime();
  assert.equal(formatViviMessageTime(new Date(2026, 11, 31, 23, 59).getTime(), "zh-CN", newYear), "昨天 23:59");
});

test("older dates show the month and day, adding the year for another year", () => {
  const older = new Date(2026, 8, 1, 14, 32).getTime();
  assert.equal(formatViviMessageTime(older, "zh-CN", NOW), "9月1日 14:32");
  assert.equal(formatViviMessageTime(older, "en-US", NOW), "Sep 1 14:32");
  const previousYear = new Date(2025, 11, 31, 9, 5).getTime();
  assert.equal(formatViviMessageTime(previousYear, "zh-CN", NOW), "2025年12月31日 09:05");
  assert.equal(formatViviMessageTime(previousYear, "en-US", NOW), "Dec 31, 2025 09:05");
});

test("future dates are dated, including a future year", () => {
  assert.equal(formatViviMessageTime(new Date(2026, 8, 5, 9, 5).getTime(), "en-US", NOW), "Sep 5 09:05");
  assert.equal(formatViviMessageTime(new Date(2027, 0, 1, 9, 5).getTime(), "zh-CN", NOW), "2027年1月1日 09:05");
});

test("invalid timestamps render nothing", () => {
  for (const stamp of [Number.NaN, Number.POSITIVE_INFINITY, 9e15]) {
    assert.equal(formatViviMessageTime(stamp, "zh-CN", NOW), "");
  }
  assert.equal(formatViviMessageTime(NOW, "en-US", Number.NaN), "");
});

test("yesterday is a calendar day across both daylight-saving transitions", () => {
  // Isolate TZ in a child so concurrent tests and the host's time zone are untouched.
  const helper = new URL("../src/renderer/src/lib/vivi-message-layout.ts", import.meta.url).href;
  const script = `
    import assert from 'node:assert/strict';
    import { formatViviMessageTime, viviMessageLayout } from ${JSON.stringify(helper)};
    for (const [month, day] of [[2, 9], [10, 2]]) {
      const now = new Date(2026, month, day, 0, 30).getTime();
      const yesterday = new Date(2026, month, day - 1, 0, 15).getTime();
      assert.equal(formatViviMessageTime(yesterday, 'en-US', now), 'Yesterday 00:15');
      assert.equal(formatViviMessageTime(yesterday, 'zh-CN', now), '昨天 00:15');
    }
    const before = new Date(2026, 10, 1, 0, 30).getTime();
    const after = new Date(2026, 10, 1, 23, 30).getTime();
    assert.equal(after - before, 24 * 60 * 60_000);
    assert.equal(formatViviMessageTime(before, 'en-US', after), '00:30');
    assert.equal(viviMessageLayout([
      { id: 'before', role: 'user', createdAt: before },
      { id: 'after', role: 'user', createdAt: after },
    ])[1].showDay, false);
  `;
  execFileSync(process.execPath, ["--input-type=module", "-e", script], {
    env: { ...process.env, TZ: "America/New_York" },
    timeout: 10_000,
  });
});
