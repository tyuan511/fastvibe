import { test } from "node:test";
import assert from "node:assert/strict";
import { noProgress, parseTextValue } from "../src/main/engine/decision/browser-task.ts";
import {
  describeDocumentChange,
  describeScopedChange,
  DOCUMENT_SCRIPT,
  freshnessScope,
  guardScript,
  OBSERVE_SCRIPT,
  settleScript,
  stablePageKey,
  targetScript,
  type ObservedAction,
} from "../src/main/engine/decision/browser-snapshot.ts";

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
  for (const script of [OBSERVE_SCRIPT, DOCUMENT_SCRIPT, guardScript(3), targetScript(action), settleScript(action)]) {
    assert.doesNotThrow(() => new Function(`return ${script};`));
  }
});

test("what a decision depends on decides how fresh the page must be", () => {
  const node = (kind: ObservedAction["kind"]): ObservedAction => ({ id: "e1", kind, node: 4, label: "x" });
  // A control the action aims at: that control plus the document.
  assert.equal(freshnessScope(node("click")), "target");
  assert.equal(freshnessScope(node("select")), "target");
  assert.equal(freshnessScope(node("fill")), "target", "a fill is typed into one field, not into the whole page");
  // Nothing to aim at: only the document.
  assert.equal(freshnessScope(undefined), "document", "DONE and BLOCKED are about the page, not a control");
  assert.equal(freshnessScope({ id: "scroll_down", kind: "scroll", label: "Scroll down", delta: 560 }), "document");
  assert.equal(freshnessScope({ id: "wait", kind: "wait", label: "Wait" }), "document");
});

test("the compared page key leaves out what an action does not depend on", () => {
  const pageKey = [1_700_000_000_000, "https://a.test/", 0, 320, 900, 700, [[7, "secret", false, -1, false, false]]];
  assert.deepEqual(stablePageKey(pageKey), [1_700_000_000_000, "https://a.test/", 900, 700]);
  // The page scrolled under the target, and another field was autofilled: the control the
  // decision chose is where it was, and the target script scrolls it back into view.
  assert.equal(describeScopedChange([stablePageKey(pageKey), [7, "button", "Submit", null]], [stablePageKey(pageKey), [7, "button", "Submit", null]]), null);
});

test("a difference nothing can name is the same page", async () => {
  const { describeParts } = await import("../src/main/engine/decision/browser-snapshot.ts");
  const guard = [7, "textbox", "Title", "", false, -1, false, false, null, null, null, null, null, "Title (required)"];
  const key = [1_700_000_000_000, "https://a.test/", 900, 700];
  // One side travelled as JavaScript values, the other through JSON: the same page, and a
  // byte-exact comparison would call it stale with nothing to say about it. Eight runs ended
  // 「页面一直在变化」 with zero steps executed on exactly this.
  assert.equal(describeScopedChange([key, guard], [key, [...guard, undefined]]), null);
  assert.equal(describeScopedChange([key, guard], [key, [...guard.slice(0, 12), undefined, guard[13]]]), null);
  assert.deepEqual(describeParts(["a", "b"], [1, undefined], [1, null]), []);
  // What a page really did change is still named.
  assert.equal(describeDocumentChange(key, [1_700_000_000_000, "https://a.test/other", 900, 700]), "url");
  assert.equal(describeDocumentChange(key, [1_600_000_000_000, "https://a.test/", 900, 700]), "document 1700000000000→1600000000000");
  assert.equal(describeScopedChange([key, guard], [[1_700_000_000_000, "https://a.test/", 900, 640], guard]), "page viewport height 700→640");
  assert.equal(describeScopedChange([key, guard], [key, [...guard.slice(0, 13), "Title (required) 3 characters left"]]), "target nearby text");
  assert.equal(describeScopedChange([key, guard], [key, null]), "target hidden or detached");
  assert.equal(describeScopedChange([key, guard], null), "target no longer on the page");
});
