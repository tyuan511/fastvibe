import test from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * The app paints its own scrollbars, and Chromium lets a surface opt out of that
 * painting with a property nobody would think to grep for.
 *
 * `scrollbar-width` or `scrollbar-color` set to anything but `auto` makes an element
 * ignore every `::-webkit-scrollbar` rule and repaint the platform bar (measured in
 * Chromium: 11px thin, 15px classic, square, and no colour of ours). The trap is that
 * the standard properties arrive through the back door:
 *
 *   * `transcript-gutter` used to carry `scrollbar-width: thin`, which is what made
 *     the chat's own scrollbar look like nothing else in the window;
 *   * Tailwind's `scrollbar-thumb-*` / `scrollbar-track-*` utilities are a
 *     `scrollbar-color` shorthand, so `scrollbar-thumb-scrollbar` on the transcript
 *     viewport was silently un-theming it;
 *   * `scrollbar-color: transparent transparent` on the composer's highlight layer
 *     gave that layer a 15px gutter while the textarea above it reserved 11px, so the
 *     two layers wrapped their lines at different widths.
 *
 * None of those fail loudly — typecheck cannot see a CSS cascade, and the result is a
 * plausible-looking UI with one unstyled surface. So the invariant is checked here.
 */

const SRC = fileURLToPath(new URL("../src/renderer/src/", import.meta.url));
const CSS_FILE = path.join(SRC, "index.css");

function sources(dir: string, found: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) sources(full, found);
    else if (/\.(css|ts|tsx)$/.test(entry)) found.push(full);
  }
  return found;
}

/** Comments explain the rule; they are not an instance of breaking it. */
function stripComments(text: string): string {
  return text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/[^\n]*/g, "$1");
}

const css = stripComments(readFileSync(CSS_FILE, "utf8"));

test("no renderer source opts a surface out of the app's scrollbar styling", () => {
  const offenders: string[] = [];
  for (const file of sources(SRC)) {
    const text = stripComments(readFileSync(file, "utf8"));
    const hits = [
      ...text.matchAll(/scrollbar-width\s*:/g).map((m) => `scrollbar-width at ${m.index}`),
      ...text.matchAll(/scrollbar-color\s*:/g).map((m) => `scrollbar-color at ${m.index}`),
      ...text.matchAll(/scrollbarWidth\s*:/g).map((m) => `style={{ scrollbarWidth }} at ${m.index}`),
      ...text.matchAll(/scrollbarColor\s*:/g).map((m) => `style={{ scrollbarColor }} at ${m.index}`),
      // Tailwind's functional utilities, both of which write `scrollbar-color`.
      // (`(?<![-\w])` keeps `var(--scrollbar-thumb-hover)` out of the net.)
      ...text.matchAll(/(?<![-\w])scrollbar-(thumb|track)-[\w.[\]-]+/g).map((m) => `Tailwind ${m[0]} at ${m.index}`),
    ];
    if (hits.length) offenders.push(`${path.relative(SRC, file)}: ${hits.join(", ")}`);
  }
  assert.deepEqual(
    offenders,
    [],
    "These properties hand the element a platform scrollbar. Theme the bar through " +
      "index.css's `::-webkit-scrollbar` rules instead, and hide one with `no-scrollbar`.",
  );
});

test("the scrollbar rules live in @layer base so a utility can still reach them", () => {
  // Unlayered declarations beat every layered one, so rules that a utility must be
  // able to override (the transparent thumb while `data-autoscrolling`) cannot sit at
  // the top level of the stylesheet.
  const blocks: Array<[number, number]> = [];
  for (const match of css.matchAll(/@layer base\s*\{/g)) {
    let depth = 1;
    let i = (match.index ?? 0) + match[0].length;
    while (i < css.length && depth > 0) {
      if (css[i] === "{") depth++;
      if (css[i] === "}") depth--;
      i++;
    }
    blocks.push([match.index ?? 0, i]);
  }
  const inside = (needle: string) =>
    blocks.some(([start, end]) => {
      const at = css.indexOf(needle, start);
      return at >= 0 && at < end;
    });
  assert.ok(inside("::-webkit-scrollbar {"), "the bar's width must be painted inside @layer base");
  assert.ok(inside("::-webkit-scrollbar-thumb {"), "the thumb must be painted inside @layer base");
  assert.ok(inside("[data-autoscrolling]::-webkit-scrollbar-thumb"));
  // The ScrollArea's own thumb is matched by data-slot and must stay unlayered: that
  // is the only reason it wins over the `bg-border` utility on the same element.
  const slotRule = css.indexOf('[data-slot="scroll-area-thumb"] {');
  assert.ok(slotRule >= 0);
  assert.ok(!blocks.some(([start, end]) => slotRule > start && slotRule < end), "the ScrollArea thumb rule must stay unlayered");
});

test("a native bar is as wide as the ScrollArea's", () => {
  // ScrollArea: `w-2.5` = 0.625rem = 10px, minus `p-px` on both sides, minus the 1px
  // transparent `border-l` → a 7px thumb.
  const scrollArea = stripComments(readFileSync(path.join(SRC, "components/ui/scroll-area.tsx"), "utf8"));
  const units = Number(scrollArea.match(/data-vertical:w-(\d+(?:\.\d+)?)/)?.[1]);
  const padding = scrollArea.includes("p-px") ? 1 : 0;
  const border = /data-vertical:border-l\b/.test(scrollArea) ? 1 : 0;
  assert.ok(Number.isFinite(units), "the ScrollArea's track width is unreadable");
  const areaThumb = units * 4 - padding * 2 - border;

  const track = Number(css.match(/::-webkit-scrollbar\s*\{\s*width:\s*(\d+(?:\.\d+)?)px/)?.[1]);
  const inset = Number(css.match(/::-webkit-scrollbar-thumb\s*\{\s*border:\s*(\d+(?:\.\d+)?)px solid transparent/)?.[1]);
  assert.ok(Number.isFinite(track) && Number.isFinite(inset), "the native bar's geometry is unreadable");
  const nativeThumb = track - inset * 2;

  assert.equal(nativeThumb, areaThumb, "a native scrollbar's thumb must be the ScrollArea's width");
  // One colour for both, or the two look like different controls side by side.
  assert.match(css, /::-webkit-scrollbar-thumb\s*\{[^}]*background-color:\s*var\(--scrollbar-thumb\)/);
  assert.match(css, /\[data-slot="scroll-area-thumb"\]\s*\{\s*background-color:\s*var\(--scrollbar-thumb\)/);
});
