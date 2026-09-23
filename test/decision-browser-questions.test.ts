import { test } from "node:test";
import assert from "node:assert/strict";
import { buildBrowserStep, describeElement, NONE } from "../src/main/engine/decision/browser-questions.ts";
import { assertValidQuestions } from "../src/main/engine/decision/protocol.ts";

/**
 * The browser.step builder decides what the fast model may even choose from. Its
 * invariants (docs/decision-layer.md §7.1.2): no operation without a legal target, no
 * question for a single candidate, a NONE escape on every target question, and no
 * secret inputs or query strings reaching the model.
 */

const snapshot = {
  url: "https://example.test/",
  title: "Example",
  text: "x".repeat(10_000),
  elements: [
    { ref: "e0", tag: "a", text: "Docs", href: "https://example.test/docs?token=abc" },
    { ref: "e1", tag: "button", text: "Search" },
    { ref: "e2", tag: "input", type: "search", text: "Search the site" },
    { ref: "e3", tag: "input", type: "password", text: "Password" },
    { ref: "e4", tag: "button", text: "Disabled", disabled: true },
  ],
};

test("targets are split by kind, secrets excluded, and single candidates resolved locally", () => {
  const { request, localTargets, targetQuestion } = buildBrowserStep({ goal: "search", snapshot });
  assert.doesNotThrow(() => assertValidQuestions(request.questions));
  const operation = request.questions.operation;
  assert.equal(operation.type, "choice");
  if (operation.type !== "choice") return;
  assert.deepEqual(Object.keys(operation.criteria), ["CLICK", "TYPE_TEXT", "DONE", "BLOCKED"]);
  const click = request.questions.click_target;
  assert.ok(click.type === "choice" && Object.keys(click.criteria).join() === `e0,e1,${NONE}`);
  // One editable, non-secret field: no question, the host resolves it.
  assert.equal(request.questions.type_text_target, undefined);
  assert.equal(localTargets.TYPE_TEXT, "e2");
  assert.equal(targetQuestion.CLICK, "click_target");
});

test("PRESS_ENTER and BACK only appear when the host can execute them", () => {
  const plain = buildBrowserStep({ goal: "g", snapshot }).request.questions.operation;
  assert.ok(plain.type === "choice" && !("PRESS_ENTER" in plain.criteria) && !("BACK" in plain.criteria));
  const built = buildBrowserStep({ goal: "g", snapshot, typedRef: "e2", canGoBack: true });
  const op = built.request.questions.operation;
  assert.ok(op.type === "choice" && "PRESS_ENTER" in op.criteria && "BACK" in op.criteria);
  assert.equal(built.localTargets.PRESS_ENTER, "e2");
  // A typedRef that is not an editable field (e.g. the password box) is not pressable.
  const secret = buildBrowserStep({ goal: "g", snapshot, typedRef: "e3" }).request.questions.operation;
  assert.ok(secret.type === "choice" && !("PRESS_ENTER" in secret.criteria));
});

test("descriptions drop query strings and page text is bounded", () => {
  assert.equal(describeElement(snapshot.elements[0]), '[a] "Docs" → example.test/docs');
  const { request } = buildBrowserStep({ goal: "g", snapshot, maxTextChars: 100 });
  const state = request.state as { page: { text: string } };
  assert.equal(state.page.text.length, 100);
  assert.ok(!JSON.stringify(request).includes("token=abc"));
});

test("scrolling is offered only in the direction the viewport can move, and off-screen elements are marked", () => {
  const withViewport = {
    ...snapshot,
    elements: [{ ref: "e9", tag: "a", text: "Footer", inViewport: false }, ...snapshot.elements.map((e) => ({ ...e, inViewport: true }))],
    viewport: { canScrollUp: false, canScrollDown: true, scrollPercent: 20, headings: ["Intro"] },
  };
  const { request } = buildBrowserStep({ goal: "g", snapshot: withViewport });
  const op = request.questions.operation;
  assert.ok(op.type === "choice" && "SCROLL_DOWN" in op.criteria && !("SCROLL_UP" in op.criteria));
  const click = request.questions.click_target;
  assert.ok(click.type === "choice");
  if (click.type !== "choice") return;
  // On-screen candidates come first; the off-screen one is still offered, and says so.
  assert.equal(Object.keys(click.criteria)[0], "e0");
  assert.match(click.criteria.e9, /\(off-screen\)$/);
  assert.deepEqual((request.state as { page: { viewport: unknown } }).page.viewport, { scrollPercent: 20, headingsOnScreen: ["Intro"] });
});
