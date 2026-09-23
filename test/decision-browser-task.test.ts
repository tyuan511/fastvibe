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
