import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * The sub-agent task graph the transcript draws for a 「创建子任务」 call used to open at its
 * full height: a three-task batch is half a screen of dots and cards, more room than the reply
 * that asked for it. It is now one line by default — the state, the progress bar and 取消全部 all
 * stay on that line, so a run in flight is still stoppable without opening anything — and the
 * canvas is one click away.
 *
 * Two invariants make that work, and neither one fails loudly:
 *
 * - The fold must *start* closed. `open` is not remembered across mounts, so a graph the reader
 *   opened during one run does not silently re-open itself in the next conversation.
 * - The header's buttons must sit **beside** the trigger, not inside it. Base UI renders its
 *   trigger as a `<button>`, and a `<button>` cannot contain a `<button>`: 取消全部 would be
 *   dropped from the DOM (or cancel the graph on a click that meant to open it). `DagSummary`
 *   therefore takes `hideActions`, and the inline card draws `DagGraphActions` itself — while the
 *   maximised dialog, which passes neither, must keep the actions it has always had.
 */

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const INLINE_FILE = path.join(ROOT, "src/renderer/src/components/dag/dag-inline.tsx");
const CANVAS_FILE = path.join(ROOT, "src/renderer/src/components/dag/dag-canvas.tsx");

/** The body of one exported function, from its `export function` line to the next top-level one. */
function sourceOf(file: string, name: string): string {
  const text = readFileSync(file, "utf8");
  const start = text.indexOf(`export function ${name}(`);
  assert.ok(start >= 0, `${name} is not exported from ${path.basename(file)}`);
  const rest = text.slice(start);
  const next = rest.indexOf("\nexport ", 1);
  return next === -1 ? rest : rest.slice(0, next);
}

const inline = sourceOf(INLINE_FILE, "DagInline");
const summary = sourceOf(CANVAS_FILE, "DagSummary");
const actions = sourceOf(CANVAS_FILE, "DagGraphActions");

test("the inline graph card starts as one collapsed header line", () => {
  assert.match(inline, /const \[open, setOpen\] = useState\(false\)/);
  // Nothing else decides the fold: no persisted state, no auto-open while a run is live.
  assert.equal(inline.match(/useState\(/g)?.length, 1);
  assert.doesNotMatch(inline, /autoOpen|localStorage|EXPANDED/);
});

test("the graph itself is only mounted inside the collapsible panel", () => {
  const panel = inline.slice(inline.indexOf("<CollapsibleContent"), inline.indexOf("</CollapsibleContent>"));
  assert.ok(panel.includes("<DagCanvas"), "the canvas must live in the panel, not beside it");
  assert.ok(panel.includes("<DagTaskList"), "the narrow-screen list is the panel's other half");
  assert.ok(inline.indexOf("<DagCanvas") > inline.indexOf("</CollapsibleTrigger>"));
});

test("the header's buttons are siblings of the fold trigger, never its children", () => {
  const head = inline.slice(inline.indexOf("<div className="), inline.indexOf("<CollapsibleContent"));
  const triggerEnd = head.indexOf("</CollapsibleTrigger>");
  assert.ok(triggerEnd > 0);
  assert.ok(head.indexOf("<DagGraphActions") > triggerEnd, "取消全部 must not be nested in the trigger");
  assert.ok(head.indexOf("openViewer") > triggerEnd, "最大化 must not be nested in the trigger");
  // And the summary inside the trigger is the reading half only.
  assert.match(head.slice(0, triggerEnd), /<DagSummary[\s\S]*?hideActions/);
});

test("the summary keeps its actions for a caller that does not take them over", () => {
  assert.match(actions, /dag\.cancel/);
  assert.match(actions, /dag\.resume/);
  // `hideActions` defaults off, so the maximised dialog (which passes nothing) still gets them.
  assert.match(summary, /hideActions = false/);
  assert.match(summary, /!\s*hideActions \|\| trailing \?[\s\S]*?<DagGraphActions/);
});
