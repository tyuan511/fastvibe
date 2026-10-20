import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * A transcript fold caps its body at half the reading area and scrolls it inside.
 *
 * Every one of these bodies used to be as tall as its content: open a 「用时 …」 run fold
 * on a run that thought for a dozen rounds and called forty tools, and the answer the fold
 * exists to leave on screen was pushed below the window — the opposite of what folding is
 * for. The cap is one class string in `lib/process-body.ts`, and the surfaces that can hold
 * a whole run's worth of parts all read it.
 *
 * The other half of the rule is that this must stay **one** scrollbar. A capped body can sit
 * inside another (a tool batch lives in the 「用时 …」 fold), and both capping is what drew a
 * scrollbar around a scrollbar, so each capped body is marked and `index.css` hands an inner
 * body's bound back to the outer one.
 *
 * What typecheck cannot see is the drift: a component that stops importing the constant, a
 * mark that goes missing, or the CSS rule moving into `@layer base` (where the Tailwind
 * utilities beat it) all silently undo this. So the source is checked here, the way
 * `scrollbar-styling.test.ts` does for the same kind of cascade.
 */

const SRC = fileURLToPath(new URL("../src/renderer/src/", import.meta.url));
const CHAT = path.join(SRC, "components/chat");
const read = (...parts: string[]): string => readFileSync(path.join(...parts), "utf8");

/** Comments name the rule they follow; they are not an instance of breaking it. */
function code(text: string): string {
  return text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/[^\n]*/g, "$1");
}

const CONSTANT = read(SRC, "lib/process-body.ts");
const capClass = /PROCESS_BODY_CAP = "([^"]+)"/.exec(CONSTANT)?.[1];

/** Surfaces that apply the cap themselves. */
const CAPS = ["run-collapse.tsx", "tool-row.tsx", "message-row.tsx"];

test("the cap is half the reading area, in a scrolling box", () => {
  assert.ok(capClass, "PROCESS_BODY_CAP must be exported as a single class string");
  // Half of `--thread-height` — the transcript viewport, not the window: the reading area
  // is that minus the header and the composer, and no CSS unit reaches it from inside.
  assert.match(capClass, /max-h-\[calc\(var\(--thread-height,[^\)]+\)\/2\)\]/);
  assert.match(capClass, /overflow-y-auto/);
  // Either property makes Chromium repaint the platform scrollbar (AGENTS.md 滚动条).
  assert.doesNotMatch(code(CONSTANT), /scrollbar-(width|color)\s*:/);
});

test("the viewport publishes the height the cap is measured against", () => {
  const list = read(SRC, "components/chat/message-list.tsx");
  assert.match(list, /setProperty\("--thread-height"/, "the thread viewport writes --thread-height");
  assert.match(list, /new ResizeObserver\(write\)/, "and keeps it current as the window moves");
});

test("every fold that can hold a whole run reads the shared cap", () => {
  for (const file of CAPS) {
    const text = read(CHAT, file);
    assert.match(text, /from "@\/lib\/process-body"/, `${file} imports the cap`);
    assert.match(text, /PROCESS_BODY_CAP/, `${file} applies the cap`);
  }
  // A tool batch asks its row for the capped body…
  assert.match(read(CHAT, "tool-group.tsx"), /\n\s+scrollBody\n/, "a tool batch asks for the capped body");
  // …and only a batch gets it: a single tool card's body is one panel that already caps.
  assert.match(read(CHAT, "tool-row.tsx"), /scrollBody && PROCESS_BODY_CAP/, "ToolRow applies it only when asked");
});

test("a capped body is marked, so a nested one can hand its bound back", () => {
  assert.match(CONSTANT, /PROCESS_BODY_MARK = "data-process-body"/);
  // run fold, the live run's hidden tail, the expanded prompt, and the batch row's body.
  const marked = [
    [read(CHAT, "run-collapse.tsx"), /<div data-process-body/],
    [read(CHAT, "message-row.tsx"), /<div data-process-body className=\{cn\("flex flex-col gap-2\.5 pt-1"/],
    [read(CHAT, "message-row.tsx"), /<div data-process-body className=\{cn\(PROCESS_BODY_CAP/],
    [read(CHAT, "tool-row.tsx"), /bodyMark/],
  ] as const;
  for (const [text, pattern] of marked) {
    assert.match(text, pattern, "a capped body carries the mark");
  }
});

test("one scroll layer: the inner capped body gives its bound up to the outer", () => {
  const css = read(SRC, "index.css");
  const rule = /\[data-process-body\] \[data-process-body\]\s*\{([^}]*)\}/.exec(css);
  assert.ok(rule, "index.css must carry the nested-body rule");
  assert.match(rule[1], /max-height:\s*none/);
  assert.match(rule[1], /overflow-y:\s*visible/);
  // Tailwind utilities live in a layer that outranks `base`, so an unlayered rule is the
  // only thing that wins — the same reason the ScrollArea thumb rules sit outside.
  const before = css.slice(0, rule.index);
  const opened = (before.match(/@layer\s+\w+\s*\{/g) ?? []).length;
  const closed = (before.match(/^\}/gm) ?? []).length;
  assert.ok(closed >= opened, "the rule must sit outside every @layer block");
});

test("no transcript surface hardcodes its own version of the cap", () => {
  const offenders: string[] = [];
  for (const file of [...CAPS, "tool-group.tsx", "thinking-block.tsx"]) {
    for (const match of code(read(CHAT, file)).matchAll(/max-h-\[[^\]]*\]/g)) {
      if (match[0] !== capClass) offenders.push(`${file}: ${match[0]}`);
    }
  }
  assert.deepEqual(offenders, [], `surfaces must use PROCESS_BODY_CAP, not their own max-h: ${offenders.join(", ")}`);
});
