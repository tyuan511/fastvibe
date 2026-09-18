import { test } from "node:test";
import assert from "node:assert/strict";
import QRCode from "qrcode";
import { qrPath } from "../src/renderer/src/lib/qr-path.ts";

/**
 * The matrix-to-path step, which is the part of the QR code that can be wrong silently.
 *
 * Everything else about that component is either the library's job (the encoder) or
 * visible at a glance (the colours, the box). This is the step where a mistake still
 * draws a convincing field of squares: read with the axes swapped, the symbol comes out
 * transposed — three finder patterns still in three corners — and no camera will read
 * it. Nothing on screen says so, and the report arrives as "the QR doesn't scan".
 */

/** The dark cells a path describes, as `"x,y"`. */
function cells(path: string): Set<string> {
  const found = new Set<string>();
  for (const match of path.matchAll(/M(-?\d+) (-?\d+)h1v1h-1z/g)) {
    found.add(`${match[1]},${match[2]}`);
  }
  return found;
}

test("index y*size+x is the module at column x of row y", () => {
  // A hand-built matrix rather than an encoded one: the convention is the whole claim,
  // and a synthetic matrix states it without the encoder in the way. Transposing the
  // read turns this into `M0 2` and fails.
  const path = qrPath({ size: 3, data: [0, 0, 0, 0, 0, 1, 0, 0, 0] });
  assert.equal(path, "M2 1h1v1h-1z");
});

test("the finder pattern lands in the top-left corner, not mirrored into another", () => {
  const { modules } = QRCode.create("https://fluffy-panda.trycloudflare.com", {
    errorCorrectionLevel: "M",
  });
  const dark = cells(qrPath(modules));

  // Every QR symbol opens with a 7×7 finder: a filled 3×3 core, a light ring, a dark
  // ring, and then one light module separating it from the data.
  for (let i = 0; i < 7; i += 1) {
    assert.ok(dark.has(`${i},0`), `top edge of the finder at ${i},0`);
    assert.ok(dark.has(`0,${i}`), `left edge of the finder at 0,${i}`);
  }
  assert.ok(!dark.has("1,1"), "the finder's light ring");
  assert.ok(dark.has("2,2"), "the finder's core");
  assert.ok(!dark.has("7,0"), "the separator after the finder");
});

test("the symbol is not symmetric about its diagonal, so a transpose is a real change", () => {
  // What makes the test above insufficient on its own: finder patterns sit in three
  // corners and survive a transpose. This is the property that does not.
  const { modules } = QRCode.create("https://fluffy-panda.trycloudflare.com", {
    errorCorrectionLevel: "M",
  });
  const dark = cells(qrPath(modules));
  const mirrored = new Set([...dark].map((cell) => cell.split(",").reverse().join(",")));
  assert.notDeepEqual([...dark].sort(), [...mirrored].sort());
});
