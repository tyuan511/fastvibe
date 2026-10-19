import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * A toast used to arrive as a column of blank cards instead of a deck.
 *
 * Sonner stacks its toasts by giving every `li` `position: absolute` from *its own*
 * stylesheet and moving the ones behind the front toast up by `--gap`. The glass rim rule
 *
 *     html[data-glass="true"] .overlay-surface:not(.fixed, .absolute) { position: relative }
 *
 * is unlayered CSS with three conditions, so it outranks that single attribute selector,
 * and the toast carries `overlay-surface` for its fill and edge. Result, measured in
 * Chromium with 玻璃效果 on: the three toasts reported `position: relative` and laid out at
 * `top` 644 / 694 / 744 — one card under the other — where the same page with the rule
 * excluded reported `position: absolute` and all three anchored to the same box (648,744),
 * the behind ones 95% and 90% and peeking 14px and 28px above the front one. Because the
 * toasts behind the front one hide their content on purpose, the column read as two empty
 * toasts under a real one.
 *
 * The fix is that the toast carries `absolute` in `classNames.toast`, which is what the
 * rim rule's own exclusion is for. Neither half fails loudly: typecheck cannot see a
 * cascade, dropping `absolute` re-breaks the toast, and dropping the exclusion from the
 * rule would make the marker a mystery to the next reader. So both are pinned here.
 */

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const CSS_FILE = path.join(ROOT, "src/renderer/src/index.css");
const TOASTER_FILE = path.join(ROOT, "src/renderer/src/components/ui/sonner.tsx");

/** Comments carry the reasoning; they are not an instance of the rule. */
function stripComments(text: string): string {
  return text.replace(/\/\*[\s\S]*?\*\//g, "");
}

/** The `toast:` entry of `toastOptions.classNames` — the class list sonner puts on each `li`. */
function toastClassList(source: string): string {
  const match = /classNames:\s*\{[\s\S]*?\btoast:\s*\n?\s*"([^"]+)"/.exec(source);
  assert.ok(match, "the Toaster's toast class list was not found");
  return match[1];
}

function rimPositionRule(css: string): string {
  const match = /html\[data-glass="true"\][^{]*\.overlay-surface[^{]*\{[^}]*position:\s*relative[^}]*\}/.exec(css);
  assert.ok(match, "the glass rim rule that sets position on .overlay-surface was not found");
  return match[0];
}

test("the glass rim rule keeps its escape hatch for surfaces that are already positioned", () => {
  const selector = rimPositionRule(stripComments(readFileSync(CSS_FILE, "utf8"))).split("{")[0];
  const notList = /:not\(([^)]*)\)/.exec(selector)?.[1];
  assert.ok(notList, "the rule must spare surfaces that already carry their own position");
  const spared = notList.split(",").map((part) => part.trim());
  assert.ok(spared.includes(".fixed"), "the rule must spare a `fixed` surface");
  assert.ok(
    spared.includes(".absolute"),
    "the rule must spare an `absolute` surface — it is the only way a surface positioned by a " +
      "library stylesheet (a sonner toast) keeps its position",
  );
});

test("the toast opts out of the glass rim rule instead of losing sonner's positioning", () => {
  const classes = toastClassList(stripComments(readFileSync(TOASTER_FILE, "utf8"))).split(/\s+/);
  assert.ok(classes.includes("overlay-surface"), "the toast is a floating layer and shares its surface");
  assert.ok(
    classes.includes("absolute"),
    "carrying `absolute` is what keeps the rim rule from turning the toast back into a box in " +
      "normal flow, which is what breaks sonner's stack into a column",
  );
  // `relative` and `fixed` would fight sonner's own `absolute` the same way it just lost to.
  for (const forbidden of ["relative", "fixed", "static"]) {
    assert.ok(!classes.includes(forbidden), `\`${forbidden}\` overrides how sonner positions the toast`);
  }
});
