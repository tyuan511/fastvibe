import assert from "node:assert/strict";
import test from "node:test";
import { ViviDragPhysics } from "../src/renderer/src/lib/vivi-drag-physics.ts";
import type { ViviDragMotion } from "../src/shared/vivi.ts";

function drive(physics: ViviDragPhysics, vx: number, vy = 0, frames = 60, size = 140, startAt = 0, startX = 0, startY = 0) {
  physics.sample({ dragging: true, x: startX, y: startY, size, at: startAt });
  let pose = physics.step(0);
  for (let frame = 1; frame <= frames; frame++) {
    physics.sample({ dragging: true, x: startX + vx * frame / 60, y: startY + vy * frame / 60, size, at: startAt + frame * 1000 / 60 });
    pose = physics.step(1 / 60);
  }
  return pose;
}

function values(value: unknown): number[] {
  if (typeof value === "number") return [value];
  if (!value || typeof value !== "object") return [];
  return Object.values(value).flatMap(values);
}

test("the pet turns toward horizontal motion and its body trails behind", () => {
  const right = drive(new ViviDragPhysics(), 420);
  const left = drive(new ViviDragPhysics(), -420);
  assert.ok(right.yaw > 0.5 && right.roll < -0.2 && right.offsetX < 0);
  assert.ok(left.yaw < -0.5 && left.roll > 0.2 && left.offsetX > 0);
  assert.ok(Math.abs(right.yaw + left.yaw) < 0.00001);
  assert.ok(Math.abs(right.roll + left.roll) < 0.00001);
});

test("upward and downward dragging produce opposite pitch", () => {
  const up = drive(new ViviDragPhysics(), 0, -420);
  const down = drive(new ViviDragPhysics(), 0, 420);
  assert.ok(up.pitch < -0.1);
  assert.ok(down.pitch > 0.1);
});

test("a sharp direction change produces a stronger lean than steady slow motion", () => {
  const physics = new ViviDragPhysics();
  const steady = drive(physics, 100);
  const reversed = drive(physics, -840, 0, 8, 140, 1001, 100, 0);
  assert.ok(reversed.roll > 0);
  assert.ok(Math.abs(reversed.roll) > Math.abs(steady.roll) * 1.5);
});

test("the two feet kick independently while held, even if the cursor stops", () => {
  const physics = new ViviDragPhysics();
  const pose = drive(physics, 0, 0, 90);
  assert.ok(pose.active);
  assert.ok(Math.abs(pose.leftFoot.pitch - pose.rightFoot.pitch) > 0.02);
  assert.ok(pose.leftFoot.lift > 0 && pose.rightFoot.lift > 0);
  const next = physics.step(0.05);
  assert.notEqual(pose.leftFoot.pitch, next.leftFoot.pitch);
  assert.notEqual(pose.rightFoot.pitch, next.rightFoot.pitch);
});

test("release preserves body inertia, then both body and feet settle to rest", () => {
  const physics = new ViviDragPhysics();
  const dragging = drive(physics, 420);
  physics.sample({ dragging: false, x: 420, y: 0, size: 140, at: 1001 });
  const released = physics.step(1 / 60);
  assert.ok(released.active);
  assert.ok(Math.abs(released.roll) > 0.05);
  assert.ok(Math.abs(released.yaw - dragging.yaw) < 0.2);
  let crossedUpright = false;
  let settled = released;
  for (let frame = 0; frame < 600; frame++) {
    settled = physics.step(1 / 60);
    if (settled.roll * dragging.roll < 0) crossedUpright = true;
  }
  assert.ok(crossedUpright, "the spring should swing past upright before settling");
  assert.equal(settled.active, false);
  assert.ok(values({ ...settled, squashX: 0, squashY: 0 }).every((value) => Math.abs(value) < 0.0001));
  assert.equal(settled.squashX, 1);
  assert.equal(settled.squashY, 1);
});

test("hitting an edge decelerates the pet instead of animating impossible cursor travel", () => {
  const physics = new ViviDragPhysics();
  const moving = drive(physics, 420);
  let stopped = moving;
  for (let frame = 1; frame <= 120; frame++) {
    physics.sample({ dragging: true, x: 420, y: 0, size: 140, at: 1000 + frame * 1000 / 60 });
    stopped = physics.step(1 / 60);
  }
  assert.ok(Math.abs(stopped.yaw) < 0.001);
  assert.ok(Math.abs(stopped.roll) < 0.001);
  assert.ok(stopped.active, "the held pet can still kick at the edge");
});

test("motion is normalized by pet size, including negative multi-monitor coordinates", () => {
  const small = drive(new ViviDragPhysics(), 280, 140, 60, 140, 0, -1900, -1200);
  const large = drive(new ViviDragPhysics(), 560, 280, 60, 280, 0, 1500, 200);
  const a = values(small);
  const b = values(large);
  for (let index = 0; index < a.length; index++) assert.ok(Math.abs(a[index] - b[index]) < 0.00001);
});

test("duplicate, stale and invalid samples cannot inject velocity or non-finite transforms", () => {
  const physics = new ViviDragPhysics();
  const reference = new ViviDragPhysics();
  drive(physics, 280);
  drive(reference, 280);
  for (const sample of [
    { dragging: true, x: 1e8, y: 0, at: 500, size: 140 },
    { dragging: true, x: 1e8, y: 0, at: 1000, size: 140 },
    { dragging: true, x: NaN, y: 0, at: 2000, size: 140 },
    { dragging: true, x: 0, y: 0, at: 2000, size: 0 },
  ]) physics.sample(sample);
  assert.deepEqual(physics.step(1 / 60), reference.step(1 / 60));
  for (let frame = 1; frame <= 200; frame++) {
    physics.sample({ dragging: true, x: frame % 2 ? 1e8 : -1e8, y: frame * 1e7, size: 84, at: 1000 + frame * 16 });
    const pose = physics.step(frame % 2 ? 0.1 : 1 / 240);
    assert.ok(values(pose).every(Number.isFinite));
    assert.ok(Math.abs(pose.roll) <= 0.76 && Math.abs(pose.yaw) <= 1.22 && Math.abs(pose.pitch) <= 0.4);
  }
});

test("stale input decays and reset restores an untouched pose", () => {
  const physics = new ViviDragPhysics();
  drive(physics, 420);
  let pose = physics.step(0);
  for (let frame = 0; frame < 240; frame++) pose = physics.step(1 / 60);
  assert.ok(Math.abs(pose.yaw) < 0.001 && Math.abs(pose.roll) < 0.001);
  physics.reset();
  assert.deepEqual(physics.step(0), new ViviDragPhysics().step(0));
});

test("spring integration remains stable across different render rates and pauses", () => {
  const simulate = (fps: number) => {
    const physics = new ViviDragPhysics();
    physics.sample({ dragging: true, x: 0, y: 0, size: 140, at: 0 });
    for (let frame = 1; frame <= fps; frame++) {
      const sample: ViviDragMotion = { dragging: true, x: 280 * frame / fps, y: 140 * frame / fps, size: 140, at: frame * 1000 / fps };
      physics.sample(sample);
      physics.step(1 / fps);
    }
    return physics;
  };
  const slow = simulate(30).step(0);
  const fast = simulate(120).step(0);
  for (const key of ["yaw", "roll", "pitch", "offsetX", "offsetY"] as const) assert.ok(Math.abs(slow[key] - fast[key]) < 0.025);
  assert.ok(values(simulate(60).step(60)).every(Number.isFinite));
});

test("flying continues turning and kicking without a held mouse button", () => {
  const physics = new ViviDragPhysics();
  drive(physics, 420);
  let pose = physics.step(0);
  for (let frame = 1; frame <= 30; frame++) {
    physics.sample({ dragging: false, flying: true, x: 420 + frame * 7, y: 0, size: 140, at: 1000 + frame * 1000 / 60 });
    pose = physics.step(1 / 60);
  }
  assert.ok(pose.active && pose.yaw > 0.5 && pose.roll < -0.2);
  assert.ok(Math.abs(pose.leftFoot.pitch) + Math.abs(pose.rightFoot.pitch) > 0.2);
  physics.sample({ dragging: false, flying: false, x: 630, y: 0, size: 140, at: 1501 });
  for (let frame = 0; frame < 600; frame++) pose = physics.step(1 / 60);
  assert.equal(pose.active, false);
});

test("impacts squash along the collision axis, rebound and fully recover", () => {
  for (const [x, y] of [[-1, 0], [1, 0], [0, -1], [0, 1]]) {
    const physics = new ViviDragPhysics();
    physics.sample({ dragging: false, x: 0, y: 0, size: 140, at: 10, impact: { x, y, speed: 1800 } });
    const hit = physics.step(1 / 120);
    assert.ok(hit.active);
    if (x) assert.ok(hit.squashX < 0.85 && hit.squashY > 1 && hit.offsetX * x > 0);
    if (y) assert.ok(hit.squashY < 0.85 && hit.squashX > 1 && hit.offsetY * y < 0);
    let pose = hit;
    for (let frame = 0; frame < 600; frame++) pose = physics.step(1 / 60);
    assert.equal(pose.active, false);
    assert.equal(pose.squashX, 1);
    assert.equal(pose.squashY, 1);
  }
});

test("impact strength scales with incoming speed and never inverts the model", () => {
  const hit = (speed: number) => {
    const physics = new ViviDragPhysics();
    physics.sample({ dragging: false, x: 0, y: 0, size: 140, at: 10, impact: { x: -1, y: 0, speed } });
    return physics.step(1 / 120);
  };
  assert.ok(hit(1800).squashX < hit(180).squashX);
  const extreme = hit(1e9);
  assert.ok(extreme.squashX > 0.7 && extreme.squashY < 1.2);
});
