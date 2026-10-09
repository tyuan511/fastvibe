import { test } from "node:test";
import assert from "node:assert/strict";
import { tabTitleIsData } from "../src/renderer/src/lib/pane-tab-title.ts";

/**
 * The rule behind 切换界面语言 renaming the right pane without closing anything.
 *
 * A tab label is either the pane's own chrome — looked up from the type every render,
 * so it follows the language — or data the user reads as a name (a file, a run's role,
 * a DAG node, a side conversation), which must not be re-translated. Getting this
 * wrong is how the 文件 tab used to stick: the old code asked
 * `tab.title !== t("tabs.files")`, and a tab opened under 中文 failed that check for
 * the *right* reason and the *wrong* conclusion — its stored chrome won, so the tab
 * stayed in the language it was opened in until it was reopened.
 */

test("singleton tabs are named by their type, never by a stored label", () => {
  for (const [type, staleTitle] of [
    ["git", "审查"],
    ["terminal", "终端"],
    ["browser", "浏览器"],
    ["changes", "修改记录"],
  ] as const) {
    assert.equal(tabTitleIsData({ type, title: staleTitle }), false, `${type} must derive its label`);
  }
});

test("a files tab shows its own label until it is previewing a file", () => {
  assert.equal(tabTitleIsData({ type: "files", title: "文件" }), false);
  assert.equal(
    tabTitleIsData({ type: "files", title: "side-pane.ts", path: "/repo/src/side-pane.ts" }),
    true,
    "a previewed file's name is data",
  );
});

test("a chrome label stored under another language is still chrome", () => {
  // The regression itself: the label no longer decides anything, so the language it
  // was written in cannot make a tab look like a file.
  for (const title of ["文件", "Files", " "]) {
    assert.equal(tabTitleIsData({ type: "files", title }), false, title);
  }
});

test("a tab whose title is real data keeps it", () => {
  assert.equal(tabTitleIsData({ type: "subagent", title: "explorer" }), true);
  assert.equal(tabTitleIsData({ type: "dag-node", title: "审计中间件" }), true);
  assert.equal(tabTitleIsData({ type: "selection-side-chat", title: "辅助对话 2" }), true);
});

test("a tab that has stored nothing is not data, so its label is read live", () => {
  // A run registered before its role arrived, a DAG node with a blank title: the tab
  // falls back to the pane's own label at render time rather than freezing whatever
  // language was active when the tab was minted.
  for (const type of ["subagent", "dag-node", "selection-side-chat", "files"]) {
    assert.equal(tabTitleIsData({ type, title: "" }), false, type);
    assert.equal(tabTitleIsData({ type, title: "   " }), false, `${type} (blank)`);
  }
});
