import assert from "node:assert/strict";
import test from "node:test";
import { clampViviBounds, viviBoundsFor, type ViviBounds } from "../src/main/vivi/bounds.ts";
import { DEFAULT_VIVI_SETTINGS } from "../src/shared/vivi.ts";

const workArea = { x: 0, y: 24, width: 1440, height: 816 };

function assertInside(bounds: ViviBounds, area: ViviBounds): void {
  assert.ok(bounds.x >= area.x);
  assert.ok(bounds.y >= area.y);
  assert.ok(bounds.x + bounds.width <= area.x + area.width);
  assert.ok(bounds.y + bounds.height <= area.y + area.height);
  assert.equal(bounds.width, bounds.height);
}

test("dragging against any edge keeps the entire pet inside the usable desktop", () => {
  for (const [x, y, expectedX, expectedY] of [
    [-80, 200, 0, 200],
    [1400, 200, 1300, 200],
    [400, -80, 400, 24],
    [400, 800, 400, 700],
    [-500, -500, 0, 24],
    [2000, 1200, 1300, 700],
  ]) {
    const bounds = clampViviBounds({ x, y, width: 140, height: 140 }, workArea);
    assert.deepEqual(bounds, { x: expectedX, y: expectedY, width: 140, height: 140 });
    assertInside(bounds, workArea);
  }
});

test("a pet already inside the work area keeps its position and size", () => {
  const bounds = { x: 200, y: 250, width: 140, height: 140 };
  assert.deepEqual(clampViviBounds(bounds, workArea), bounds);
});

test("secondary displays can have negative coordinates and different work-area offsets", () => {
  const areas = [
    { x: -1920, y: 120, width: 1920, height: 1040 },
    { x: 240, y: -1200, width: 1600, height: 1160 },
    { x: 1440, y: 24, width: 1280, height: 696 },
  ];
  for (const area of areas) {
    for (const x of [area.x - 500, area.x + 200, area.x + area.width + 500]) {
      for (const y of [area.y - 500, area.y + 200, area.y + area.height + 500]) {
        const bounds = clampViviBounds({ x, y, width: 280, height: 280 }, area);
        assertInside(bounds, area);
        assert.deepEqual(clampViviBounds(bounds, area), bounds);
      }
    }
  }
});

test("saved positions on disconnected displays return to the remaining display", () => {
  for (const [x, y] of [[3000, 1400], [-1920, -1200]]) {
    const bounds = viviBoundsFor({ ...DEFAULT_VIVI_SETTINGS, position: "custom", x, y }, workArea);
    assertInside(bounds, workArea);
  }
});

test("enlarging a pet at the bottom-right edge moves it inward", () => {
  const bounds = viviBoundsFor({ ...DEFAULT_VIVI_SETTINGS, position: "custom", x: 1300, y: 700, scale: 1.5 }, workArea);
  assert.deepEqual(bounds, { x: 1020, y: 420, width: 420, height: 420 });
  assertInside(bounds, workArea);
});

test("corner placement respects work-area offsets and the initial edge gap", () => {
  const area = { x: -1920, y: 24, width: 1920, height: 1016 };
  for (const [position, x, y] of [
    ["top-left", -1896, 48],
    ["top-right", -164, 48],
    ["bottom-left", -1896, 876],
    ["bottom-right", -164, 876],
  ] as const) {
    assert.deepEqual(viviBoundsFor({ ...DEFAULT_VIVI_SETTINGS, position }, area), { x, y, width: 140, height: 140 });
  }
});

test("a work area smaller than the requested pet keeps it square and fully visible", () => {
  const area = { x: -100, y: 30, width: 180, height: 120 };
  const settings = { ...DEFAULT_VIVI_SETTINGS, scale: 1.5 };
  assert.deepEqual(viviBoundsFor(settings, area), { x: -100, y: 30, width: 120, height: 120 });
  assert.equal(viviBoundsFor(settings, workArea).width, 420);
});
