import type { ChoiceQuestion, DecideRequest, JsonValue, Question } from "./protocol.ts";

/**
 * Build the `browser.step` request from a page snapshot (docs/decision-layer.md §7.1.2).
 *
 * Every candidate is something the host can execute: an operation with no legal target
 * is left out, a target question with exactly one candidate is not asked (the host
 * resolves it and says so in `localTargets`), and each target question carries a
 * `NONE` option so "none of these fits" is an answer rather than a forced guess.
 *
 * Pure: the snapshot comes in as data, so the same builder serves the live consumer and
 * the offline evaluation.
 */

/** One element as `browser_snapshot` reports it today. */
export type SnapshotElement = {
  ref: string;
  tag: string;
  type?: string;
  role?: string;
  text?: string;
  name?: string;
  href?: string;
  disabled?: boolean;
  /** Whether the element intersects the viewport. Absent on snapshots that do not say. */
  inViewport?: boolean;
};

/** Where the viewport is, so scrolling is a choice the host can offer and the model can judge. */
export type SnapshotViewport = {
  canScrollUp: boolean;
  canScrollDown: boolean;
  /** 0–100, how far down the document the viewport's bottom edge is. */
  scrollPercent: number;
  /** Section headings currently on screen, for "scroll to the X section" goals. */
  headings?: string[];
};

export type BrowserSnapshot = {
  url: string;
  title?: string;
  text?: string;
  elements: SnapshotElement[];
  viewport?: SnapshotViewport;
};

export type BrowserStepInput = {
  goal: string;
  snapshot: BrowserSnapshot;
  /** Short, host-written descriptions of what already happened, oldest first. */
  recentActions?: string[];
  /** Ref of the field the previous step typed into, if focus is still there. */
  typedRef?: string;
  canGoBack?: boolean;
  /** Page text sent to the model, in characters. */
  maxTextChars?: number;
};

export type BrowserOperation = "CLICK" | "TYPE_TEXT" | "PRESS_ENTER" | "SCROLL_DOWN" | "SCROLL_UP" | "BACK" | "DONE" | "BLOCKED";

export const NONE = "NONE";

export type BrowserStepRequest = {
  request: DecideRequest;
  /** Target resolved by code because exactly one candidate existed. */
  localTargets: Partial<Record<BrowserOperation, string>>;
  /** Which question holds the target for each operation that needs one. */
  targetQuestion: Partial<Record<BrowserOperation, string>>;
};

const OPERATION_DESCRIPTIONS: Record<BrowserOperation, string> = {
  CLICK: "Click an element on the page (link, button, tab, checkbox, option).",
  TYPE_TEXT: "Type text into an input field or text area.",
  PRESS_ENTER: "Press Enter in the field that was just typed into, to submit it.",
  SCROLL_DOWN: "Scroll down one screen to reveal more of the page.",
  SCROLL_UP: "Scroll up one screen.",
  BACK: "Go back to the previous page.",
  DONE: "The goal is already achieved on the current page; nothing more to do.",
  BLOCKED: "The goal cannot be progressed from this page (login wall, captcha, error, missing information).",
};

const CLICKABLE_TAGS = new Set(["a", "button", "summary", "label", "select"]);
const CLICKABLE_ROLES = new Set(["button", "link", "tab", "menuitem", "option", "checkbox", "switch"]);
const CLICKABLE_INPUT_TYPES = new Set(["submit", "button", "checkbox", "radio", "reset", "image"]);
/** Inputs a model must never write into. */
const SECRET_INPUT_TYPES = new Set(["password", "file", "hidden"]);
const MAX_DESCRIPTION = 120;
/** Jev's 255-option ceiling, less the NONE escape. */
const MAX_TARGET_CANDIDATES = 254;
const DEFAULT_TEXT_CHARS = 3_000;

export function isClickable(element: SnapshotElement): boolean {
  if (element.disabled) return false;
  if (element.tag === "input") return CLICKABLE_INPUT_TYPES.has((element.type ?? "text").toLowerCase());
  return CLICKABLE_TAGS.has(element.tag) || (element.role !== undefined && CLICKABLE_ROLES.has(element.role));
}

export function isEditable(element: SnapshotElement): boolean {
  if (element.disabled) return false;
  if (element.tag === "textarea") return true;
  if (element.tag === "input") {
    const type = (element.type ?? "text").toLowerCase();
    return !SECRET_INPUT_TYPES.has(type) && !CLICKABLE_INPUT_TYPES.has(type);
  }
  // The snapshot only includes other tags via `[contenteditable]` or a role; with no role
  // and not a known control, it is the contenteditable case.
  return !CLICKABLE_TAGS.has(element.tag) && element.role === undefined;
}

/**
 * What the model reads for one candidate: kind, visible label, and for a link where it
 * goes — origin and path only, since a query string can carry tokens.
 */
export function describeElement(element: SnapshotElement): string {
  const kind = element.role ?? (element.tag === "input" ? `${element.type ?? "text"} input` : element.tag);
  const parts = [`[${kind}]`];
  const label = (element.text ?? "").trim();
  if (label) parts.push(JSON.stringify(label.slice(0, 80)));
  else if (element.name) parts.push(`name=${element.name}`);
  if (element.href) {
    const target = safeHref(element.href);
    if (target) parts.push(`→ ${target}`);
  }
  const description = parts.join(" ").slice(0, MAX_DESCRIPTION);
  return element.inViewport === false ? `${description} (off-screen)` : description;
}

function safeHref(href: string): string | undefined {
  try {
    const url = new URL(href);
    if (url.protocol !== "http:" && url.protocol !== "https:") return undefined;
    return `${url.host}${url.pathname}`;
  } catch {
    return undefined;
  }
}

export function buildBrowserStep(input: BrowserStepInput): BrowserStepRequest {
  const { snapshot } = input;
  // On-screen elements first, so a cap never drops what the user can actually see.
  const onScreenFirst = [...snapshot.elements].sort((a, b) => Number(b.inViewport !== false) - Number(a.inViewport !== false));
  const clickable = onScreenFirst.filter(isClickable).slice(0, MAX_TARGET_CANDIDATES);
  const editable = onScreenFirst.filter(isEditable).slice(0, MAX_TARGET_CANDIDATES);
  const questions: Record<string, Question> = {};
  const operations: Partial<Record<BrowserOperation, string>> = {};
  const localTargets: BrowserStepRequest["localTargets"] = {};
  const targetQuestion: BrowserStepRequest["targetQuestion"] = {};

  const addTarget = (operation: BrowserOperation, questionId: string, candidates: SnapshotElement[], instructions: string): void => {
    if (candidates.length === 0) return;
    operations[operation] = OPERATION_DESCRIPTIONS[operation];
    if (candidates.length === 1) {
      localTargets[operation] = candidates[0].ref;
      return;
    }
    const criteria: Record<string, string> = {};
    for (const element of candidates) criteria[element.ref] = describeElement(element);
    criteria[NONE] = "None of these elements fits the goal.";
    questions[questionId] = { type: "choice", instructions, criteria, requiredWhen: { question: "operation", equals: operation } };
    targetQuestion[operation] = questionId;
  };

  addTarget("CLICK", "click_target", clickable, "Which element should be clicked to make progress toward the goal?");
  addTarget("TYPE_TEXT", "type_text_target", editable, "Which field should be typed into to make progress toward the goal?");
  if (input.typedRef && editable.some((element) => element.ref === input.typedRef)) {
    operations.PRESS_ENTER = OPERATION_DESCRIPTIONS.PRESS_ENTER;
    localTargets.PRESS_ENTER = input.typedRef;
  }
  if (snapshot.viewport?.canScrollDown) operations.SCROLL_DOWN = OPERATION_DESCRIPTIONS.SCROLL_DOWN;
  if (snapshot.viewport?.canScrollUp) operations.SCROLL_UP = OPERATION_DESCRIPTIONS.SCROLL_UP;
  if (input.canGoBack) operations.BACK = OPERATION_DESCRIPTIONS.BACK;
  operations.DONE = OPERATION_DESCRIPTIONS.DONE;
  operations.BLOCKED = OPERATION_DESCRIPTIONS.BLOCKED;

  const operation: ChoiceQuestion = {
    type: "choice",
    instructions: "Given the goal, the current page and what was already done, what is the single next browser action?",
    criteria: operations as Record<string, string>,
  };
  // The operation question first: it is the head every target depends on.
  const ordered: Record<string, Question> = { operation, ...questions };

  const state: JsonValue = {
    goal: input.goal,
    page: {
      url: snapshot.url,
      title: snapshot.title ?? "",
      text: (snapshot.text ?? "").slice(0, input.maxTextChars ?? DEFAULT_TEXT_CHARS),
      ...(snapshot.viewport
        ? { viewport: { scrollPercent: snapshot.viewport.scrollPercent, headingsOnScreen: snapshot.viewport.headings ?? [] } }
        : {}),
    },
    recentActions: input.recentActions ?? [],
  };

  return {
    request: { version: 1, binding: "browser.step", state, questions: ordered },
    localTargets,
    targetQuestion,
  };
}
