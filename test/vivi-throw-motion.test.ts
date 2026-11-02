import assert from "node:assert/strict";
import test from "node:test";
import { ViviFlight, ViviThrowVelocity } from "../src/main/vivi/throw-motion.ts";

const area = { x: 0, y: 24, width: 4000, height: 2000 };
const bounds = { x: 1500, y: 600, width: 140, height: 140 };

function trace(position: (seconds: number) => number, duration = 0.25, fps = 60) {
  const motion = new ViviThrowVelocity();
  motion.begin({ x: position(0), y: 0 }, 0);
  for (let frame = 1; frame <= duration * fps; frame++) {
    motion.sample({ x: position(frame / fps), y: 0 }, frame * 1000 / fps);
  }
  return motion;
}

function land(velocity: { x: number; y: number }, workArea = area, initial = bounds, fps = 60) {
  const flight = new ViviFlight(initial, velocity, workArea);
  let result = flight.step(0);
  const hits = [];
  for (let frame = 0; frame < fps * 5 && result.active; frame++) {
    result = flight.step(1 / fps);
    if (result.impact) hits.push(result.impact);
    assert.ok(result.bounds.x >= workArea.x && result.bounds.y >= workArea.y);
    assert.ok(result.bounds.x + result.bounds.width <= workArea.x + workArea.width);
    assert.ok(result.bounds.y + result.bounds.height <= workArea.y + workArea.height);
  }
  assert.equal(result.active, false);
  return { ...result, hits };
}

test("fast flicks travel farther than gentle drags", () => {
  const slow = trace((t) => t * 180).release(250);
  const fast = trace((t) => t * 1200).release(250);
  assert.ok(fast.x > slow.x * 3);
  assert.ok(land(fast).bounds.x > land(slow).bounds.x + 200);
});

test("recent acceleration adds throw distance at comparable release speed", () => {
  const steady = trace((t) => t * 600, 0.5).release(500);
  const accelerated = trace((t) => t < 0.4 ? 0 : 5000 * (t - 0.4) ** 2, 0.5).release(500);
  assert.ok(accelerated.x > steady.x, `${accelerated.x} should exceed ${steady.x}`);
  assert.ok(land(accelerated).bounds.x > land(steady).bounds.x);
});

test("holding still before release removes old fling energy", () => {
  const motion = trace((t) => t * 1000);
  for (let frame = 16; frame <= 45; frame++) motion.sample({ x: 250, y: 0 }, frame * 1000 / 60);
  assert.deepEqual(motion.release(750), { x: 0, y: 0 });
  assert.deepEqual(trace((t) => t * 1000).release(1000), { x: 0, y: 0 });
});

test("release keeps direction, rejects stale samples, and caps launch speed", () => {
  const motion = trace((t) => -t * 1000);
  const before = motion.release(250);
  motion.sample({ x: 100000, y: 100000 }, 50);
  motion.sample({ x: NaN, y: 0 }, 260);
  assert.deepEqual(motion.release(250), before);
  assert.ok(before.x < 0 && before.y === 0);
  assert.ok(Math.hypot(trace((t) => t * 1e9).release(250).x, 0) <= 3600);
  assert.equal(new ViviFlight(bounds, { x: 20, y: 10 }, area).active, false);
});

test("each edge bounces inward and reports a direction and speed for animation", () => {
  const workArea = { x: -800, y: 24, width: 800, height: 600 };
  for (const [initial, velocity, nx, ny] of [
    [{ x: -795, y: 200, width: 140, height: 140 }, { x: -1500, y: 0 }, 1, 0],
    [{ x: -145, y: 200, width: 140, height: 140 }, { x: 1500, y: 0 }, -1, 0],
    [{ x: -400, y: 30, width: 140, height: 140 }, { x: 0, y: -1500 }, 0, 1],
    [{ x: -400, y: 478, width: 140, height: 140 }, { x: 0, y: 1500 }, 0, -1],
  ] as const) {
    const result = land(velocity, workArea, initial);
    assert.ok(result.hits.length > 0);
    assert.equal(result.hits[0].x, nx);
    assert.equal(result.hits[0].y, ny);
    assert.ok(result.hits[0].speed > 500);
    if (nx) assert.ok((result.bounds.x - initial.x) * nx > 0);
    if (ny) assert.ok((result.bounds.y - initial.y) * ny > 0);
  }
});

test("corner impacts reflect both axes without escaping even in a tiny work area", () => {
  const workArea = { x: 0, y: 0, width: 160, height: 160 };
  const result = land({ x: 3000, y: 3000 }, workArea, { x: 15, y: 15, width: 140, height: 140 });
  assert.ok(result.hits.some((hit) => hit.x < 0 && hit.y < 0));
});

test("flight distance is independent of timer frequency and long pauses remain bounded", () => {
  const a = land({ x: 1200, y: -200 }, area, bounds, 30);
  const b = land({ x: 1200, y: -200 }, area, bounds, 120);
  assert.ok(Math.hypot(a.bounds.x - b.bounds.x, a.bounds.y - b.bounds.y) < 2);
  const flight = new ViviFlight(bounds, { x: 3000, y: 0 }, area);
  const after = flight.step(1000);
  assert.ok(after.bounds.x - bounds.x < 310);
  assert.deepEqual(flight.step(NaN).bounds, after.bounds);
});
