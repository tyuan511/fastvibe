import { test } from "node:test";
import assert from "node:assert/strict";
import { actionSpace, buildBrowserStep, resolveDecision } from "../src/main/engine/decision/browser-questions.ts";
import type { DecisionObservation, ObservedAction } from "../src/main/engine/decision/browser-snapshot.ts";
import { adoptAnswers, acceptValid } from "../src/main/engine/decision/dispatch.ts";
import { assertValidQuestions } from "../src/main/engine/decision/protocol.ts";

/**
 * The browser.step builder (ported from jev-ultrafast) decides what the fast model may
 * choose from. Invariants: one index per DOM node even when it can be both clicked and
 * typed into, dropdown options as their own targets, controls as operations, and only the
 * chosen operation's head resolving to an action.
 */

const actions: ObservedAction[] = [
  { id: "e1", kind: "fill", node: 7, role: "combobox", label: "Where from?", value: "" },
  { id: "e2", kind: "click", node: 7, role: "combobox", label: "Open Where from?", value: "" },
  { id: "e3", kind: "click", node: 9, role: "checkbox", label: "Bacon", checked: "false" },
  { id: "e4", kind: "select", node: 11, role: "combobox", label: "Size → Medium", value: "medium", current_value: "Small" },
  { id: "e5", kind: "select", node: 11, role: "combobox", label: "Size → Large", value: "large", current_value: "Small" },
  { id: "e6", kind: "click", node: 12, role: "button", label: "Submit order" },
  { id: "scroll_down", kind: "scroll", label: "Scroll down", delta: 560 },
  { id: "wait", kind: "wait", label: "Wait for the page to update" },
];

const observation: DecisionObservation = {
  url: "https://example.test/order",
  title: "Order",
  w: 1120,
  h: 780,
  text: "Pizza order",
  scroll: { y: 0, height: 2000 },
  actions,
  marker: null,
  page_key: null,
  guards: {},
  omitted_actions: 0,
};

test("one index per node, dropdown options as index:n, controls kept apart", () => {
  const space = actionSpace(actions);
  assert.deepEqual(space.elements.map((e) => [e.index, e.label, e.operations]), [
    ["1", "Where from?", ["TYPE_TEXT", "CLICK"]],
    ["2", "Bacon", ["CLICK"]],
    ["3", "Size", ["SELECT"]],
    ["4", "Submit order", ["CLICK"]],
  ]);
  assert.equal(space.elements[1].checked, "false");
  assert.equal(space.elements[2].value, "Small");
  assert.deepEqual(Object.keys(space.targets.SELECT ?? {}), ["3:1", "3:2"]);
  assert.deepEqual(Object.keys(space.controls), ["SCROLL_DOWN", "WAIT"]);
});

test("the request carries the element table, rules on every question, and valid questions", () => {
  const step = buildBrowserStep({ goal: "Order a medium pizza with bacon", observation, history: [{ action: "Where from?", kind: "fill", text: "Zurich", page_changed: true }] });
  assert.doesNotThrow(() => assertValidQuestions(step.request.questions));
  const op = step.request.questions.operation;
  assert.ok(op.type === "choice");
  if (op.type !== "choice") return;
  assert.deepEqual(Object.keys(op.criteria), ["TYPE_TEXT", "CLICK", "SELECT", "SCROLL_DOWN", "WAIT", "DONE", "BLOCKED"]);
  const target = step.request.questions.click_target;
  assert.ok(target.type === "choice" && target.requiredWhen?.equals === "CLICK");
  assert.deepEqual((target.instructions as { operation: string }).operation, "CLICK");
  const state = step.request.state as { elements: unknown[]; recent_actions: Array<{ text: string }> };
  assert.equal(state.elements.length, 4);
  assert.equal(state.recent_actions[0].text, "Zurich");
});

test("only the chosen operation's head resolves to an action", () => {
  const step = buildBrowserStep({ goal: "g", observation });
  const raw = {
    operation: { type: "choice", choice: "SELECT", probabilities: { TYPE_TEXT: 0, CLICK: 0.1, SELECT: 0.9, SCROLL_DOWN: 0, WAIT: 0, DONE: 0, BLOCKED: 0 }, confidence: { value: 0.9, source: "reported" } },
    select_target: { type: "choice", choice: "3:1", probabilities: { "3:1": 0.8, "3:2": 0.2 }, confidence: { value: 0.7, source: "reported" } },
    click_target: { type: "choice", choice: "not-a-target" },
  };
  const { outcome } = adoptAnswers(step.request.questions, raw, acceptValid("t"));
  assert.equal(outcome.status, "decided");
  if (outcome.status !== "decided") return;
  const decision = resolveDecision(step, outcome.answers as never);
  assert.equal(decision.action?.id, "e4");
  assert.equal(decision.action?.value, "medium");
  const scroll = resolveDecision(step, { operation: { type: "choice", choice: "SCROLL_DOWN" } });
  assert.equal(scroll.action?.kind, "scroll");
  assert.deepEqual(resolveDecision(step, { operation: { type: "choice", choice: "DONE" } }), { operation: "DONE" });
});

test("off-screen elements are marked in the table and the target options, and the rule says they are actionable", () => {
  const withOffscreen: DecisionObservation = {
    ...observation,
    actions: [...actions.slice(0, -2), { id: "e7", kind: "click", node: 20, role: "link", label: "Next chapter", offscreen: true }, ...actions.slice(-2)],
  };
  const step = buildBrowserStep({ goal: "go to the next chapter", observation: withOffscreen });
  const next = step.space.elements.find((e) => e.label === "Next chapter");
  assert.equal(next?.offscreen, true);
  const target = step.request.questions.click_target;
  assert.ok(target.type === "choice");
  if (target.type !== "choice") return;
  assert.deepEqual((target.criteria[next!.index] as { offscreen?: boolean }).offscreen, true);
  assert.match(JSON.stringify(step.request.questions.operation.instructions), /offscreen/);
});
