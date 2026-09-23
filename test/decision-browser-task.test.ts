import { test } from "node:test";
import assert from "node:assert/strict";
import { noProgress, parseTextValue } from "../src/main/engine/decision/browser-task.ts";
import { guardScript, MARKER_SCRIPT, OBSERVE_SCRIPT, settleScript, targetScript } from "../src/main/engine/decision/browser-snapshot.ts";

test("the text helper must answer exactly {text}", () => {
  assert.equal(parseTextValue('{"text": "Zurich"}'), "Zurich");
  assert.equal(parseTextValue('```json\n{"text":"London"}\n```'), "London");
  assert.equal(parseTextValue('{"text": null}'), null);
  assert.throws(() => parseTextValue('{"text": "a", "note": "b"}'));
  assert.throws(() => parseTextValue("Zurich"));
  assert.throws(() => parseTextValue('{"text": "  "}'));
});

test("three unchanged non-wait actions in a row stop the run; waits do not count", () => {
  const same = { action: "x", kind: "click" as const, page_changed: false };
  assert.equal(noProgress([same, same]), false);
  assert.equal(noProgress([same, same, same]), true);
  assert.equal(noProgress([same, { ...same, kind: "wait" as const }, same]), false);
  assert.equal(noProgress([same, same, { ...same, page_changed: true }]), false);
});

test("injected page scripts compile", () => {
  // A script that does not parse fails only at run time inside the page, so parse them here.
  const action = { id: "e1", kind: "fill" as const, node: 3, label: "q", value: "v" };
  for (const script of [OBSERVE_SCRIPT, MARKER_SCRIPT, guardScript(3), targetScript(action), settleScript(action)]) {
    assert.doesNotThrow(() => new Function(`return ${script};`));
  }
});

test("risk is decided by what the action is: commitments and leaving the start origin ask", async () => {
  const { riskOf } = await import("../src/main/engine/decision/browser-task.ts");
  const page = { url: "https://shop.test/cart", title: "", w: 0, h: 0, text: "", scroll: { y: 0, height: 0 }, actions: [], marker: null, page_key: null, guards: {}, omitted_actions: 0 };
  const click = (label: string) => ({ id: "e1", kind: "click" as const, node: 1, label });
  assert.equal(riskOf(click("Place order"), page, "https://shop.test/", false), "label");
  assert.equal(riskOf(click("提交订单"), page, "https://shop.test/", false), "label");
  assert.equal(riskOf(click("Next page"), page, "https://shop.test/", false), null);
  assert.equal(riskOf({ id: "e2", kind: "fill", node: 2, label: "Submit comment" }, page, "https://shop.test/", false), null, "typing never asks");
  assert.equal(riskOf(click("Next page"), { ...page, url: "https://pay.example/" }, "https://shop.test/", false), "origin");
  assert.equal(riskOf(click("Next page"), { ...page, url: "https://pay.example/" }, "https://shop.test/", true), null, "asked once already");
});

test("a failed freshness check says which part of the page moved", async () => {
  const { describeMarkerChange, describeScopedChange } = await import("../src/main/engine/decision/browser-snapshot.ts");
  const key = [1, "https://a.test/", 0, 0, 1120, 780, []];
  const guard = [7, "button", "Toggle Sidebar", null, null, null, null, false, null, "false", null, null, null, "Toggle Sidebar TYPESAFE AI"];
  assert.equal(describeScopedChange([key, guard], [[1, "https://a.test/", 0, 3, 1120, 780, []], guard]), "page scrollY 0→3");
  assert.equal(describeScopedChange([key, guard], [key, [...guard.slice(0, 13), "Toggle Sidebar TYPESAFE AI 12:01"]]), "target nearby text");
  assert.equal(describeScopedChange([key, guard], [key, null]), "target hidden or detached");
  assert.equal(describeScopedChange([key, guard], null), "target no longer on the page");
  assert.equal(describeScopedChange([key, guard], [key, guard]), null);
  assert.equal(describeMarkerChange([1, "u", 0, 0, 1, 1, "t", "a", [], []], [1, "u", 0, 0, 1, 1, "t", "b", [], []]), "visible text");
});
