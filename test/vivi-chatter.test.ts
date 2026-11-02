import assert from "node:assert/strict";
import test from "node:test";
import { ViviChatter } from "../src/renderer/src/lib/vivi-chatter.ts";
import type { ViviDragMotion } from "../src/shared/vivi.ts";

function fixture() {
  let now = 0;
  const chatter = new ViviChatter(() => now);
  return {
    chatter,
    advance: (ms: number) => { now += ms; },
    motion: (patch: Partial<ViviDragMotion>) => chatter.motion({ dragging: false, x: 0, y: 0, size: 140, at: now, ...patch }),
    next: (blocked = false, lang: "zh" | "en" = "zh") => chatter.next(lang, blocked),
  };
}

test("drag and throw reactions wait until the pet stops moving", () => {
  const f = fixture();
  f.motion({ dragging: true });
  assert.equal(f.next(), undefined);
  f.advance(400);
  f.motion({ dragging: false, flying: true });
  assert.equal(f.next(), undefined);
  f.motion({});
  f.advance(250);
  assert.match(f.next()!, /起飞/);
});

test("a collision wins over drag, flight and landing feedback", () => {
  const f = fixture();
  f.motion({ dragging: true });
  f.motion({ flying: true, impact: { x: -1, y: 0, speed: 1800 } });
  f.advance(50);
  f.motion({});
  f.advance(250);
  assert.match(f.next()!, /撞扁/);
  assert.equal(f.next(), undefined);
});

test("catching a flying pet tolerates the native stopped-frame before the new grab", () => {
  const f = fixture();
  f.motion({ flying: true });
  f.advance(100);
  f.motion({});
  assert.equal(f.next(), undefined);
  f.advance(20);
  f.motion({ dragging: true });
  f.advance(400);
  f.motion({});
  f.advance(250);
  assert.match(f.next()!, /接住/);
});

test("repeated collisions are throttled and later replies rotate", () => {
  const f = fixture();
  const bump = () => {
    f.motion({ dragging: true, impact: { x: 1, y: 0, speed: 300 } });
    f.motion({});
    f.advance(250);
  };
  bump();
  const first = f.next();
  assert.ok(first);
  f.advance(100);
  bump();
  assert.equal(f.next(), undefined);
  f.advance(5000);
  bump();
  assert.notEqual(f.next(), first);
});

test("pending approvals, typing, active tasks or existing feedback suppress chatter", () => {
  const f = fixture();
  f.motion({ dragging: true, impact: { x: -1, y: 0, speed: 1800 } });
  f.motion({});
  f.advance(250);
  assert.equal(f.next(true), undefined);
  assert.equal(f.next(), undefined);
  f.advance(59000);
  assert.equal(f.next(), undefined);
  f.advance(1500);
  assert.ok(f.next());
});

test("hovering and quiet idle time provide occasional localized greetings", () => {
  const f = fixture();
  f.advance(10000);
  f.chatter.hover(true);
  f.advance(1500);
  assert.match(f.next(false, "en")!, /Looking at me/);
  f.chatter.hover(false);
  f.chatter.interacted();
  f.advance(59000);
  assert.equal(f.next(), undefined);
  f.advance(2000);
  assert.match(f.next()!, /休息/);
  f.advance(1000);
  assert.equal(f.next(), undefined);
});
