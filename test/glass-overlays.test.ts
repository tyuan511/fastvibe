import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * Every floating layer takes its glass fill from one token (`--glass-overlay`, through the
 * `.overlay-surface` class in index.css), which is how a popover, a menu, a select and a dialog
 * stay equally legible over whatever is behind them. A primitive that forgot the class would sit
 * at its own, more see-through, alpha — which is exactly the inconsistency this pins.
 */
const UI = join(import.meta.dirname, "..", "src", "renderer", "src", "components", "ui");

for (const file of ["popover", "dropdown-menu", "context-menu", "select", "tooltip", "dialog", "alert-dialog", "sonner"]) {
  test(`${file} is drawn as an overlay surface`, () => {
    assert.match(readFileSync(join(UI, `${file}.tsx`), "utf8"), /overlay-surface/);
  });
}

test("the glass fill of a floating layer is one token, and it is dense enough to read text over", () => {
  const themes = readFileSync(join(import.meta.dirname, "..", "src", "renderer", "src", "lib", "themes.ts"), "utf8");
  const match = themes.match(/"glass-overlay": fill\(seed\.surface, dark \? (\d+) : (\d+)\)/);
  assert.ok(match, "glass-overlay is derived from the theme's surface");
  assert.ok(Number(match[1]) >= 80 && Number(match[2]) >= 85, `glass-overlay is ${match[1]}/${match[2]}`);
  const css = readFileSync(join(import.meta.dirname, "..", "src", "renderer", "src", "index.css"), "utf8");
  assert.match(css, /html\[data-glass="true"\] \.overlay-surface \{[^}]*var\(--glass-overlay\)/);
});
