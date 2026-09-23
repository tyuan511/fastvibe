import { test } from "node:test";
import assert from "node:assert/strict";
import { buildBrowserStep } from "../src/main/engine/decision/browser-questions.ts";
import { normalRole, windowObservation } from "../src/main/engine/decision/computer-observation.ts";
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
