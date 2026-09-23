import { createHash } from "node:crypto";
import type { DecisionObservation, ObservedAction } from "./browser-snapshot.ts";

/**
 * A desktop window as the decision loop's observation (docs/decision-layer.md §7.9).
 *
 * `computer_task` runs the same jev-ultrafast loop as `browser_task`; only the control
 * layer differs. This maps what Cua Driver reports for a window — its accessibility
 * elements, each with a token, role, name, value and the actions it supports — onto the
 * observation the loop already understands: controls become click / fill actions with
 * their current value and state, static text becomes the "visible text", and scrolling
 * and waiting are controls. Pure, so the mapping is testable without a desktop.
 */

export type WindowElementInfo = {
  token?: string;
  role: string;
  label?: string;
  value?: string;
  enabled?: boolean;
  selected?: boolean;
  actions?: string[];
  frame?: { x: number; y: number; w: number; h: number };
};

export type WindowStateInfo = {
  appName?: string;
  windowTitle?: string;
  elements: WindowElementInfo[];
  texts?: string[];
  truncated?: boolean;
};

export type WindowObservation = {
  observation: DecisionObservation & { fingerprint: string };
  /** Per observed node, the driver token that addresses it in *this* snapshot. */
  tokens: Map<number, string>;
  /** Where to aim a scroll: the first scroll area's centre, when there is one. */
  scrollPoint?: { x: number; y: number };
};

const TEXT_LIMIT = 6_000;
const ELEMENT_LIMIT = 250;

const FILL_ROLES = new Set(["textfield", "textarea", "searchfield", "combobox"]);
const CLICK_ROLES = new Set([
  "button",
  "link",
  "checkbox",
  "radiobutton",
  "popupbutton",
  "menubutton",
  "menuitem",
  "menubaritem",
  "tab",
  "disclosuretriangle",
  "switch",
  "segmentedcontrol",
  "cell",
  "row",
]);

/** `AXButton`, `button`, `AXTextField` → `button`, `button`, `textfield`. */
export function normalRole(role: string): string {
  return role.replace(/^AX/, "").replace(/[^a-z]/gi, "").toLowerCase();
}

function secret(role: string): boolean {
  return /secure|password/.test(role);
}

export function windowObservation(state: WindowStateInfo): WindowObservation {
  const actions: ObservedAction[] = [];
  const tokens = new Map<number, string>();
  let scrollPoint: WindowObservation["scrollPoint"];
  let node = 0;
  for (const element of state.elements) {
    const role = normalRole(element.role);
    if (role === "scrollarea" && !scrollPoint && element.frame) {
      scrollPoint = { x: Math.round(element.frame.x + element.frame.w / 2), y: Math.round(element.frame.y + element.frame.h / 2) };
    }
    if (!element.token || element.enabled === false || secret(role)) continue;
    const pressable = element.actions?.some((action) => /press|pick|confirm/i.test(action)) ?? false;
    const fillable = FILL_ROLES.has(role);
    if (!fillable && !CLICK_ROLES.has(role) && !pressable) continue;
    if (actions.length >= ELEMENT_LIMIT) break;
    node++;
    tokens.set(node, element.token);
    const label = (element.label || (fillable ? "" : element.value) || role).trim().slice(0, 200) || role;
    const base: ObservedAction = { id: "", kind: fillable ? "fill" : "click", node, role, label };
    if (element.value !== undefined && element.value !== "") base.value = element.value.slice(0, 500);
    if (role === "checkbox" || role === "radiobutton" || role === "switch") base.checked = String(element.value === "1" || element.selected === true);
    else if (element.selected !== undefined) base.selected = String(element.selected);
    actions.push(base);
    if (fillable) actions.push({ ...base, kind: "click", label: `Open ${label}` });
  }
  actions.forEach((action, index) => (action.id = `e${index + 1}`));
  if (scrollPoint) {
    actions.push({ id: "scroll_down", kind: "scroll", label: "Scroll down", delta: 5 });
    actions.push({ id: "scroll_up", kind: "scroll", label: "Scroll up", delta: -5 });
  }
  actions.push({ id: "wait", kind: "wait", label: "Wait for the window to update" });

  const text = (state.texts ?? []).join("\n").slice(0, TEXT_LIMIT);
  const semantics = actions.map(({ id: _id, ...rest }) => rest);
  const guards: Record<string, unknown> = {};
  for (const action of actions) if (action.node !== undefined) guards[action.node] = [action.role, action.label, action.value ?? null, action.checked ?? null, action.selected ?? null];
  const base: DecisionObservation = {
    // Not a URL: the task is bound to one window, so "origin" is the app itself.
    url: `app://${encodeURIComponent(state.appName ?? "app")}/${encodeURIComponent(state.windowTitle ?? "")}`,
    title: state.windowTitle ?? state.appName ?? "",
    w: 0,
    h: 0,
    text,
    scroll: { y: 0, height: 0 },
    actions,
    marker: [state.windowTitle ?? "", text, semantics],
    page_key: [state.windowTitle ?? "", semantics],
    guards,
    omitted_actions: state.truncated ? 1 : 0,
  };
  const fingerprint = createHash("sha256").update(JSON.stringify(base.marker)).digest("hex");
  return { observation: { ...base, fingerprint }, tokens, ...(scrollPoint ? { scrollPoint } : {}) };
}
