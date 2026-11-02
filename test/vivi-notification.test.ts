import assert from "node:assert/strict";
import test from "node:test";
import { ViviNotificationLifetime } from "../src/renderer/src/lib/vivi-notification.ts";

function fixture() {
  let now = 0;
  return { notice: new ViviNotificationLifetime(() => now), at: (value: number) => { now = value; } };
}

test("notices expire after five seconds and polling never renews them", () => {
  const { notice, at } = fixture();
  notice.update("chat:a", "reply:1", false);
  at(4999);
  notice.update("chat:a", "reply:1", false);
  assert.equal(notice.visible, true);
  assert.equal(notice.remaining, 1);
  at(5000);
  assert.equal(notice.visible, false);
  notice.update("chat:a", "reply:1", false);
  assert.equal(notice.visible, false);
  notice.update("chat:a", "reply:2", false);
  assert.equal(notice.visible, true);
  assert.equal(notice.remaining, 5000);
});

test("hover retains an expired notice until the pointer leaves", () => {
  const { notice, at } = fixture();
  notice.update("chat:a", "reply", false);
  at(4000);
  notice.hover(true);
  at(9000);
  assert.equal(notice.visible, true);
  notice.hover(false);
  assert.equal(notice.visible, false);
});

test("leaving before the deadline keeps only the remaining display time", () => {
  const { notice, at } = fixture();
  notice.update("chat:a", "reply", false);
  at(1000);
  notice.hover(true);
  at(2000);
  notice.hover(false);
  assert.equal(notice.remaining, 3000);
  assert.equal(notice.visible, true);
  at(5000);
  assert.equal(notice.visible, false);
});

test("foreground messages are consumed and not replayed on blur, even while hovered", () => {
  const { notice } = fixture();
  notice.update("chat:a", "reply:1", true);
  notice.hover(true);
  assert.equal(notice.visible, false);
  notice.update("chat:a", "reply:1", false);
  assert.equal(notice.visible, false);
  notice.update("chat:a", "reply:2", false);
  assert.equal(notice.visible, true);
  notice.update("chat:a", "reply:2", true);
  assert.equal(notice.visible, false);
  notice.update("chat:a", "reply:2", false);
  assert.equal(notice.visible, false);
});

test("temporary pet feedback cannot resurrect an expired reply", () => {
  const { notice, at } = fixture();
  notice.update("chat:a", "reply", false);
  at(6000);
  notice.update("feedback", "click", false);
  notice.hover(true);
  at(12000);
  notice.update("chat:a", "reply", false);
  assert.equal(notice.visible, false);
});

test("manual dismissal persists through refresh and a new message can notify", () => {
  const { notice } = fixture();
  notice.update("request:a", "question:1", false);
  notice.dismiss();
  notice.hover(true);
  notice.update("request:a", "question:1", false);
  assert.equal(notice.visible, false);
  notice.update("request:a", "question:2", false);
  assert.equal(notice.visible, true);
});
