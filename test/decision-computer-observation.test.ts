import { test } from "node:test";
import assert from "node:assert/strict";
import { buildBrowserStep } from "../src/main/engine/decision/browser-questions.ts";
import { normalRole, windowFreshness, windowObservation } from "../src/main/engine/decision/computer-observation.ts";
import { assertValidQuestions } from "../src/main/engine/decision/protocol.ts";

/**
 * computer_task feeds a desktop window into the same loop as browser_task. What must
 * hold: only actionable, enabled, non-secret elements are offered, fields carry their
 * value and toggles their state, static text is the visible text, and the result builds
 * a valid browser.step request.
 */

const state = {
  appName: "Reminders",
  windowTitle: "New Reminder",
  texts: ["Title", "Notes", "Remind me on a day"],
  elements: [
    { token: "t1", role: "AXTextField", label: "Title", value: "" },
    { token: "t2", role: "AXSecureTextField", label: "Password", value: "hunter2" },
    { token: "t3", role: "AXCheckBox", label: "Remind me on a day", value: "0" },
    { token: "t4", role: "AXButton", label: "Save", enabled: true },
    { token: "t5", role: "AXButton", label: "Delete", enabled: false },
    { token: "t6", role: "AXGroup", label: "Container" },
    { token: "t7", role: "AXImage", label: "Flag", actions: ["AXPress"] },
    { role: "AXScrollArea", frame: { x: 0, y: 100, w: 400, h: 300 } },
  ],
};

test("roles are normalised across AX and plain spellings", () => {
  assert.equal(normalRole("AXTextField"), "textfield");
  assert.equal(normalRole("text field"), "textfield");
  assert.equal(normalRole("button"), "button");
});

test("only enabled, actionable, non-secret elements become actions", () => {
  const { observation, tokens, scrollPoint } = windowObservation(state);
  const labels = observation.actions.map((a) => `${a.kind}:${a.label}`);
  assert.deepEqual(labels, [
    "fill:Title",
    "click:Open Title",
    "click:Remind me on a day",
    "click:Save",
    "click:Flag",
    "scroll:Scroll down",
    "scroll:Scroll up",
    "wait:Wait for the window to update",
  ]);
  assert.ok(!JSON.stringify(observation).includes("hunter2"), "a secure field and its value never appear");
  assert.equal(observation.actions[2].checked, "false");
  assert.equal(tokens.get(observation.actions[3].node!), "t4");
  assert.deepEqual(scrollPoint, { x: 200, y: 250 });
  assert.equal(observation.text, "Title\nNotes\nRemind me on a day");
});

test("the observation builds a valid browser.step request, and a changed value changes the fingerprint", () => {
  const { observation } = windowObservation(state);
  const step = buildBrowserStep({ goal: "Add a reminder", observation });
  assert.doesNotThrow(() => assertValidQuestions(step.request.questions));
  const changed = windowObservation({ ...state, elements: state.elements.map((e) => (e.token === "t1" ? { ...e, value: "Buy milk" } : e)) });
  assert.notEqual(changed.observation.fingerprint, observation.fingerprint);
});

test("a window is fresh for what the decision depends on, and says what broke it", () => {
  const { observation } = windowObservation(state);
  const save = observation.actions.find((action) => action.label === "Save")!;
  const node = save.node!;

  // A clock, a progress line, terminal output: the window is alive, the controls are the
  // same ones, and the action would still land where the decision meant it.
  const chatty = windowObservation({ ...state, texts: [...state.texts, "12:01:33"] }).observation;
  assert.equal(windowFreshness(observation, chatty, node), null);
  assert.equal(windowFreshness(observation, chatty, undefined), null);

  // Another field the app wrote into does not move the numbering either.
  const typed = windowObservation({ ...state, elements: state.elements.map((e) => (e.token === "t1" ? { ...e, value: "Buy milk" } : e)) }).observation;
  assert.equal(windowFreshness(observation, typed, node), null);

  // A control inserted ahead of the target: node N addresses a different element that may
  // look exactly alike, so the decision is about a window that is not this one.
  const shifted = windowObservation({
    ...state,
    elements: [...state.elements.slice(0, 3), { token: "t8", role: "AXButton", label: "Add" }, ...state.elements.slice(3)],
  }).observation;
  assert.equal(windowFreshness(observation, shifted, node), "window controls 8→9, target name");
  // A verdict about the window, not a control, does not care how the list is ordered.
  assert.equal(windowFreshness(observation, shifted, undefined), null);

  // The target itself changed, and the window became another window.
  const renamed = windowObservation({ ...state, elements: state.elements.map((e) => (e.token === "t4" ? { ...e, label: "Send" } : e)) }).observation;
  assert.equal(windowFreshness(observation, renamed, node), "window control 4 changed, target name");
  const other = windowObservation({ ...state, windowTitle: "Reminder" }).observation;
  assert.equal(windowFreshness(observation, other, node), "window title New Reminder→Reminder");
  assert.equal(windowFreshness(observation, other, undefined), "window title New Reminder→Reminder");

  // The control the decision chose is gone.
  const removed = windowObservation({ ...state, elements: state.elements.filter((e) => e.token !== "t4") }).observation;
  assert.match(windowFreshness(removed, observation, node) ?? "", /target no longer in the window|window controls/);
});
