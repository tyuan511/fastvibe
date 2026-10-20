import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * A transcript fold caps its body and scrolls it inside.
 *
 * Every one of these bodies used to be as tall as its content: open a 「用时 …」 run fold
 * on a run that thought for a dozen rounds and called forty tools, and the answer the fold
 * exists to leave on screen was pushed below the window — the opposite of what folding is
 * for. The cap is one class string in `lib/process-body.ts`, and the surfaces that can hold
 * a whole run's worth of parts all read it.
 *
 * What typecheck cannot see is the drift: a component that stops importing the constant and
 * writes its own number silently un-caps itself. So this checks the source, the way
 * `scrollbar-styling.test.ts` does for the same kind of CSS cascade.
 */

const SRC = fileURLToPath(new URL("../src/renderer/src/", import.meta.url));
const CHAT = path.join(SRC, "components/chat");
const read = (...parts: string[]): string => readFileSync(path.join(...parts), "utf8");

/** Comments name the rule they follow; they are not an instance of breaking it. */
function code(text: string): string {
  return text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/[^\n]*/g, "$1");
}

const CONSTANT = code(read(SRC, "lib/process-body.ts"));
const capClass = /PROCESS_BODY_CAP = "([^"]+)"/.exec(CONSTANT)?.[1];

/** Surfaces that apply the cap themselves. */
const CAPS = ["run-collapse.tsx", "tool-row.tsx", "message-row.tsx"];

test("the shared cap is a bounded, scrolling box sized in rem and vh", () => {
  assert.ok(capClass, "PROCESS_BODY_CAP must be exported as a single class string");
  // `rem` so 界面字号 scales it; the `vh` share so a short window still shows the answer.
  assert.match(capClass, /max-h-\[min\(\d+rem,\d+vh\)\]/);
  assert.match(capClass, /overflow-y-auto/);
  // Either property makes Chromium repaint the platform scrollbar (AGENTS.md 滚动条).
  assert.doesNotMatch(CONSTANT, /scrollbar-(width|color)\s*:/);
});

test("every fold that can hold a whole run reads the shared cap", () => {
  for (const file of CAPS) {
    const text = read(CHAT, file);
    assert.match(text, /import \{ PROCESS_BODY_CAP \} from "@\/lib\/process-body"/, `${file} imports the cap`);
    assert.match(text, /PROCESS_BODY_CAP/, `${file} applies the cap`);
  }
  // A tool batch asks its row for the capped body…
  assert.match(read(CHAT, "tool-group.tsx"), /\n\s+scrollBody\n/, "a tool batch asks for the capped body");
  // …and only a batch gets it: a single tool card's body is one panel that already caps.
  assert.match(read(CHAT, "tool-row.tsx"), /scrollBody && PROCESS_BODY_CAP/, "ToolRow applies it only when asked");
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
