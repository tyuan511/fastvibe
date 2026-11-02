import assert from "node:assert/strict";
import test from "node:test";
import { ViviActivityMotion, VIVI_GESTURES, type ViviActivityPose, type ViviGesture } from "../src/renderer/src/lib/vivi-activity-motion.ts";
import type { ViviMood } from "../src/shared/vivi.ts";

const moods = Object.keys(VIVI_GESTURES) as ViviMood[];
const turnDelta = (a: number, b: number): number => Math.atan2(Math.sin(a - b), Math.cos(a - b));

function random(seed = 17): () => number {
  return () => {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    return seed / 4294967296;
  };
}

function numbers(value: unknown): number[] {
  if (typeof value === "number") return [value];
  if (!value || typeof value !== "object") return [];
  return Object.values(value).flatMap(numbers);
}

function visit(motion: ViviActivityMotion, seconds: number, inspect: (pose: ViviActivityPose) => void): void {
  for (let frame = 0; frame < seconds * 60; frame++) inspect(motion.step(1 / 60));
}

test("clicks cycle idle gestures immediately without switching to completion", () => {
  const motion = new ViviActivityMotion("idle", random());
  const seen = new Set<ViviGesture>();
  let previous: ViviGesture | null = null;
  for (let click = 0; click < 21; click++) {
    motion.triggerNext();
    const pose = motion.step(1 / 60);
    assert.ok(pose.gesture);
    assert.ok(VIVI_GESTURES.idle.includes(pose.gesture));
    assert.notEqual(pose.gesture, previous);
    seen.add(pose.gesture);
    previous = pose.gesture;
    motion.setMood("idle");
    assert.equal(motion.step(0).gesture, pose.gesture);
  }
  assert.deepEqual(seen, new Set(VIVI_GESTURES.idle));
  motion.step(1 / 60, true);
  motion.triggerNext();
  assert.equal(motion.step(1 / 60, true).gesture, null);
});

test("clicks prioritize facial reactions and provide a visible response on the first frame", () => {
  const motion = new ViviActivityMotion("idle", random());
  const expected = ["blink", "double-blink", "wink", "mouth-open", "yawn"];
  for (const gesture of expected) {
    motion.triggerNext();
    const first = motion.step(1 / 60);
    assert.equal(first.gesture, gesture);
    assert.ok(first.reaction > 0.8 && first.offsetY > 0.005);
    let eye = 0;
    let mouth = 0;
    for (let frame = 0; frame < 75; frame++) {
      const pose = motion.step(1 / 60);
      eye = Math.max(eye, pose.leftBlink, pose.rightBlink);
      mouth = Math.max(mouth, pose.mouthOpen);
    }
    if (gesture.includes("blink") || gesture === "wink") assert.ok(eye > 0.8);
    if (gesture === "mouth-open" || gesture === "yawn") assert.ok(mouth > 0.8);
  }
});

test("a clicked spin finishes one brisk revolution within a second", () => {
  const motion = new ViviActivityMotion("idle", random());
  for (let click = 0; click < VIVI_GESTURES.idle.length; click++) motion.triggerNext();
  let previous = motion.step(0).yaw;
  let travel = 0;
  for (let frame = 0; frame < 60; frame++) {
    const pose = motion.step(1 / 60);
    travel += turnDelta(pose.yaw, previous);
    previous = pose.yaw;
  }
  assert.ok(Math.abs(travel) > Math.PI * 1.9);
  assert.ok(Math.abs(previous) < 0.2);
});

test("idle stays alive between gestures and cycles through its repertoire without immediate repeats", () => {
  const motion = new ViviActivityMotion("idle", random());
  const seen = new Set<ViviGesture>();
  let previous: ViviGesture | null = null;
  let lastStarted: ViviGesture | null = null;
  let quietMotion = false;
  visit(motion, 140, (pose) => {
    if (pose.gesture && pose.gesture !== previous) {
      assert.notEqual(pose.gesture, lastStarted);
      lastStarted = pose.gesture;
      seen.add(pose.gesture);
    }
    if (!pose.gesture && Math.abs(pose.yaw) + Math.abs(pose.headRoll) > 0.005) quietMotion = true;
    previous = pose.gesture;
  });
  assert.deepEqual(seen, new Set(VIVI_GESTURES.idle));
  assert.ok(quietMotion);
});

test("every mood gets its own complete repertoire and visible depth turns", () => {
  for (const mood of moods) {
    const motion = new ViviActivityMotion(mood, random());
    const seen = new Set<ViviGesture>();
    let maxYaw = 0;
    let maxHead = 0;
    let maxFoot = 0;
    visit(motion, 100, (pose) => {
      if (pose.gesture) seen.add(pose.gesture);
      maxYaw = Math.max(maxYaw, Math.abs(pose.yaw));
      maxHead = Math.max(maxHead, Math.abs(pose.headYaw), Math.abs(pose.headRoll), Math.abs(pose.headPitch));
      maxFoot = Math.max(maxFoot, Math.abs(pose.leftFoot.pitch), Math.abs(pose.rightFoot.pitch));
      assert.ok(numbers(pose).every(Number.isFinite));
      assert.ok(Math.abs(pose.roll) < 0.3 && Math.abs(pose.pitch) < 0.25);
      assert.ok(pose.offsetY < 0.13 && pose.stretch > -0.1 && pose.stretch < 0.15);
    });
    assert.deepEqual(seen, new Set(VIVI_GESTURES[mood]), mood);
    assert.ok(maxYaw > 0.5, `${mood} should show its side`);
    assert.ok(maxHead > 0.025 && maxFoot > 0.05, `${mood} should move head and feet`);
  }
});

test("celebration completes a full revolution and returns to the front continuously", () => {
  const motion = new ViviActivityMotion("success", () => 0.9);
  let previous = 0;
  let accumulated = 0;
  let sawBack = false;
  for (let frame = 0; frame < 3.5 * 60; frame++) {
    const pose = motion.step(1 / 60);
    const delta = turnDelta(pose.yaw, previous);
    assert.ok(Math.abs(delta) < 0.12, "no jump when wrapping past 180 degrees");
    accumulated += delta;
    if (Math.abs(pose.yaw) > 2.8) sawBack = true;
    previous = pose.yaw;
  }
  assert.ok(sawBack);
  assert.ok(accumulated > Math.PI * 1.9 && accumulated < Math.PI * 2.1);
  assert.ok(Math.abs(previous) < 0.15);
});

test("changing mood mid-spin smoothly transitions and does not restart on repeated snapshots", () => {
  const motion = new ViviActivityMotion("success", random());
  visit(motion, 1.2, () => undefined);
  let previous = motion.step(0);
  motion.setMood("thinking");
  const gestures = new Set<ViviGesture>();
  visit(motion, 4, (pose) => {
    if (pose.gesture) gestures.add(pose.gesture);
    assert.ok(Math.abs(turnDelta(pose.yaw, previous.yaw)) < 0.5);
    motion.setMood("thinking");
    previous = pose;
  });
  assert.ok(gestures.has("ponder"));
  assert.ok(Math.abs(previous.yaw) < 1);
});

test("dragging cancels the current gesture and smoothly suppresses all autonomous movement", () => {
  const motion = new ViviActivityMotion("success", random());
  visit(motion, 1.4, () => undefined);
  let pose = motion.step(0);
  assert.ok(Math.abs(pose.yaw) > 1);
  for (let frame = 0; frame < 120; frame++) pose = motion.step(1 / 60, true);
  assert.equal(pose.active, false);
  assert.equal(pose.gesture, null);
  assert.ok(numbers(pose).every((value) => Math.abs(value) < 0.0001));
  motion.setMood("working");
  for (let frame = 0; frame < 60; frame++) pose = motion.step(1 / 60, true);
  assert.equal(pose.gesture, null);
  const seen = new Set<ViviGesture>();
  visit(motion, 12, (next) => { if (next.gesture) seen.add(next.gesture); });
  assert.ok(seen.size > 0);
  for (const gesture of seen) assert.ok(VIVI_GESTURES.working.includes(gesture));
});

test("zero time pauses the sequence and long pauses cannot fast-forward a gesture", () => {
  const motion = new ViviActivityMotion("success", random());
  const initial = motion.step(1 / 60);
  for (let frame = 0; frame < 20; frame++) assert.deepEqual(motion.step(0), initial);
  const after = motion.step(1000);
  assert.equal(after.gesture, "victory-spin");
  assert.ok(numbers(after).every(Number.isFinite));
  assert.deepEqual(motion.step(NaN), after);
});

test("turns and gestures remain stable across 30 and 120 frames per second", () => {
  const sample = (fps: number) => {
    const motion = new ViviActivityMotion("success", random());
    for (let frame = 0; frame < fps * 1.3; frame++) motion.step(1 / fps);
    return motion.step(0);
  };
  const slow = sample(30);
  const fast = sample(120);
  assert.ok(Math.abs(turnDelta(slow.yaw, fast.yaw)) < 0.08);
  assert.ok(Math.abs(slow.offsetY - fast.offsetY) < 0.01);
});
