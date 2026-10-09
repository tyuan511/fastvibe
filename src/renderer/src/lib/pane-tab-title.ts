/**
 * Which right-pane tab labels are **data**, and which are the pane's own chrome.
 *
 * The distinction is what makes 切换界面语言 work without closing anything: a chrome
 * label (文件 / 终端 / 浏览器 / 审查) is looked up from the type every render, so it
 * follows the language the moment it changes. A stored `title` is only shown where it
 * really is data — a role name, a DAG node's title, a side conversation's title, the
 * name of the file being previewed — because data does not get re-translated: the
 * chat it names was created under whichever language was active then, exactly like a
 * conversation title in the sidebar.
 *
 * Reading this off the tab rather than comparing `title` against a translated string
 * is the whole point. A comparison like `tab.title !== t("tabs.files")` is true for a
 * tab that was opened in the *previous* language, so the old-language chrome won the
 * check and the tab stayed stale until it was reopened.
 *
 * Pure, and free of the store and of i18n, so the rule is testable (see
 * `test/pane-tab-title.test.ts`).
 */

/** The part of a pane tab the rule reads. Structural, so this module imports nothing. */
export type PaneTabTitleInput = {
  type: string;
  /**
   * The tab's stored label. Not read here — this answers whether the caller may show
   * it — but part of the input so a tab object satisfies it as it is.
   */
  title: string;
  /** Set on a `files` tab that is previewing a specific file. */
  path?: string;
};

/** Tabs whose `title` is always data: a run's role, a DAG node, a side conversation. */
const DATA_TITLE_TYPES = new Set(["subagent", "dag-node", "selection-side-chat"]);

/**
 * Whether a tab's stored `title` is what it should display.
 *
 * `false` means the tab is named by its type at render time and its stored `title` is
 * chrome text that must not be trusted — the only thing that makes a language switch
 * reach the tab bar.
 */
export function tabTitleIsData(tab: PaneTabTitleInput): boolean {
  // Nothing stored is not data — the caller reads its own label instead, now.
  if (!tab.title.trim()) return false;
  // A 文件 tab is named by its type until it is showing a file; then its title is that
  // file's name, which the user reads as data even though it looks like a label.
  if (tab.type === "files") return Boolean(tab.path);
  return DATA_TITLE_TYPES.has(tab.type);
}
