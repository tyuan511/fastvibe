import type { BrowserRequest } from "../../shared/types.ts";
import { PAGE_HELPERS, typeBody } from "../../shared/browser-page.ts";

export type BrowserInputChannel = {
  evaluate(body: string): Promise<unknown>;
  send(method: string, params: Record<string, unknown>): Promise<unknown>;
};

export const INPUT_TREE_HELPERS = `
  const inputActiveElement = () => {
    let current = document.activeElement;
    while (current?.shadowRoot?.activeElement) current = current.shadowRoot.activeElement;
    return current;
  };
  const inputHit = (x, y) => {
    let current = document.elementFromPoint(x, y);
    for (let depth = 0; depth < 50 && current?.shadowRoot; depth++) {
      const inner = current.shadowRoot.elementFromPoint(x, y);
      if (!inner || inner === current) break;
      current = inner;
    }
    return current;
  };
  const inputContains = (target, hit) => {
    for (let current = hit; current; current = current.parentElement || current.getRootNode()?.host) {
      if (current === target) return true;
    }
    return false;
  };
`;

export function browserInputTargetBody(request: BrowserRequest, token = "") : string {
  return `
    const ref = ${JSON.stringify(request.ref ?? "")};
    const selector = ${JSON.stringify(request.selector ?? "")};
    const text = ${JSON.stringify(request.action === "click" ? request.text ?? "" : "")};
    ${PAGE_HELPERS}
    ${INPUT_TREE_HELPERS}
    const el = resolve();
    if (!el) return { ok: false, code: ref ? 'STALE_REF' : 'TARGET_NOT_FOUND', error: 'Target unavailable; take a new browser_snapshot' };
    if (ref && document.__fvSnapshotContainers?.has(el)) return { ok: false, code: 'INVALID_TARGET', error: 'Container refs are for snapshot scope; choose an interactive ref' };
    const bindings = window.__fvInputTargets || (window.__fvInputTargets = new Map());
    if (bindings.size >= 128) bindings.delete(bindings.keys().next().value);
    bindings.set(${JSON.stringify(token)}, { el, expires: Date.now() + 60000 });
    if (!visible(el) || el.disabled || el.getAttribute('aria-disabled') === 'true') return { ok: false, code: 'NOT_ACTIONABLE' };
    if (${JSON.stringify(request.action)} === 'type') {
      if (el.tagName === 'SELECT' || (el.tagName === 'INPUT' && /^(checkbox|radio)$/.test(el.type))) return { ok: true, fallback: true };
      if (!(el.isContentEditable || el.tagName === 'TEXTAREA' || el.tagName === 'INPUT' && /^(text|search|email|url|tel|password|number)$/.test(el.type))) return { ok: false, code: 'UNSUPPORTED_INPUT' };
      if (el.readOnly || el.getAttribute('aria-readonly') === 'true') return { ok: false, code: 'NOT_ACTIONABLE' };
    }
    el.scrollIntoView({ block: 'center', inline: 'center' });
    const rect = el.getBoundingClientRect();
    const left = Math.max(0, rect.left), top = Math.max(0, rect.top);
    const right = Math.min(innerWidth, rect.right), bottom = Math.min(innerHeight, rect.bottom);
    if (right <= left || bottom <= top) return { ok: false, code: 'NOT_ACTIONABLE' };
    const x = (left + right) / 2, y = (top + bottom) / 2;
    const hit = inputHit(x, y);
    if (!hit || !inputContains(el, hit)) return { ok: false, code: 'TARGET_OBSCURED' };
    return { ok: true, x, y };
  `;
}

export function browserInputPrepareBody(request: BrowserRequest, token: string): string {
  return `
    const ref = ${JSON.stringify(request.ref ?? "")};
    const selector = ${JSON.stringify(request.selector ?? "")};
    const text = "";
    ${PAGE_HELPERS}
    ${INPUT_TREE_HELPERS}
    const el = resolve();
    const saved = window.__fvInputTargets?.get(${JSON.stringify(token)});
    if (!el || !saved || saved.expires < Date.now() || saved.el !== el) return { ok: false, code: ref ? 'STALE_REF' : 'TARGET_REPLACED' };
    el.focus();
    if (inputActiveElement() !== el) return { ok: false, code: 'FOCUS_FAILED' };
    if (el.isContentEditable) {
      const range = document.createRange(); range.selectNodeContents(el);
      const selection = getSelection(); selection.removeAllRanges(); selection.addRange(range);
    } else if (typeof el.select === 'function' && el.type !== 'number') el.select();
    else return { ok: true, selectAll: true };
    return { ok: true };
  `;
}

export function browserInputVerifyBody(request: BrowserRequest, token: string): string {
  return `
    ${INPUT_TREE_HELPERS}
    const saved = window.__fvInputTargets?.get(${JSON.stringify(token)});
    const el = saved && saved.expires >= Date.now() ? saved.el : null;
    if (!el || !el.isConnected || inputActiveElement() !== el) return { ok: false, code: 'FOCUS_LOST' };
    return { ok: true, matched: (el.isContentEditable ? el.textContent : el.value) === ${JSON.stringify(request.text ?? "")} };
  `;
}

export function browserInputCheckBody(token: string, focus = false, point?: { x: number; y: number }): string {
  return `
    ${INPUT_TREE_HELPERS}
    const saved = window.__fvInputTargets?.get(${JSON.stringify(token)});
    const el = saved?.el;
    if (!el || saved.expires < Date.now() || !el.isConnected || el.ownerDocument !== document) return { ok: false, code: 'TARGET_REPLACED' };
    if (el.disabled || el.getAttribute('aria-disabled') === 'true' || ${JSON.stringify(focus)} && (el.readOnly || el.getAttribute('aria-readonly') === 'true')) return { ok: false, code: 'NOT_ACTIONABLE' };
    if (${JSON.stringify(focus)} && inputActiveElement() !== el) return { ok: false, code: 'FOCUS_LOST' };
    if (${JSON.stringify(!!point)}) {
      const hit = inputHit(${JSON.stringify(point?.x ?? 0)}, ${JSON.stringify(point?.y ?? 0)});
      if (!hit || !inputContains(el, hit)) return { ok: false, code: 'TARGET_OBSCURED' };
    }
    return { ok: true };
  `;
}

export function browserInputFallbackBody(request: BrowserRequest, token: string): string {
  // Keep the shared semantic-control implementation, but resolve only the bound object.
  return INPUT_TREE_HELPERS + typeBody(request).replace('const el = resolve();', `
    const saved = window.__fvInputTargets?.get(${JSON.stringify(token)});
    const el = saved && saved.expires >= Date.now() && saved.el.isConnected && saved.el.ownerDocument === document ? saved.el : null;
  `).replace('el.focus();', `
    el.focus();
    if (!el.isConnected || el.ownerDocument !== document || inputActiveElement() !== el) return { filled: false, code: 'FOCUS_LOST' };
  `);
}

function aborted(signal?: AbortSignal): never | void {
  if (signal?.aborted) throw signal.reason instanceof Error ? signal.reason : new DOMException("The operation was aborted", "AbortError");
}

/** Native input shared by CDP and the embedded guest. Exported channel boundary has no Electron dependency. */
export async function runBrowserInput(request: BrowserRequest, channel: BrowserInputChannel, signal?: AbortSignal): Promise<unknown> {
  const route = "cdp-input";
  let dispatched = false;
  const token = `fv-input-${Math.random().toString(36).slice(2)}-${Date.now()}`;
  const boundary = () => aborted(signal);
  const observe = async (body: string) => {
    boundary();
    const result = await channel.evaluate(body);
    boundary();
    return result;
  };
  const deliver = async (method: string, params: Record<string, unknown>, cleanup = false) => {
    if (!cleanup) boundary();
    dispatched = true;
    const result = await channel.send(method, params);
    if (!cleanup) boundary();
    return result;
  };
  try {
    boundary();
    if (request.action === "press") {
      const parts = (request.key ?? "Enter").split("+");
      const supplied = parts.pop() || "+";
      let modifiers = 0;
      for (const part of parts) {
        const bit = ({ alt: 1, ctrl: 2, control: 2, meta: 4, cmd: 4, shift: 8 } as Record<string, number>)[part.toLowerCase()];
        if (!bit) throw new Error(`Unsupported key modifier: ${part}`);
        modifiers |= bit;
      }
      const named: Record<string, [string, number, string?]> = {
        Enter: ["Enter", 13, "\r"], Tab: ["Tab", 9], Escape: ["Escape", 27], Backspace: ["Backspace", 8], Delete: ["Delete", 46],
        ArrowLeft: ["ArrowLeft", 37], ArrowUp: ["ArrowUp", 38], ArrowRight: ["ArrowRight", 39], ArrowDown: ["ArrowDown", 40], Home: ["Home", 36], End: ["End", 35], PageUp: ["PageUp", 33], PageDown: ["PageDown", 34], Space: ["Space", 32, " "], " ": ["Space", 32, " "],
      };
      const mapping = named[supplied];
      if (!mapping && supplied.length !== 1) throw new Error(`Unsupported key: ${supplied}`);
      const key = supplied === "Space" ? " " : supplied;
      const code = mapping?.[0] ?? (/^[a-z]$/i.test(key) ? `Key${key.toUpperCase()}` : /^[0-9]$/.test(key) ? `Digit${key}` : "");
      const common = { key, code, windowsVirtualKeyCode: mapping?.[1] ?? key.toUpperCase().charCodeAt(0), modifiers };
      const text = modifiers & 7 ? undefined : mapping ? mapping[2] : key;
      try {
        await deliver("Input.dispatchKeyEvent", { ...common, type: text ? "keyDown" : "rawKeyDown", ...(text ? { text, unmodifiedText: text } : {}) });
      } finally {
        await deliver("Input.dispatchKeyEvent", { ...common, type: "keyUp" }, true);
      }
      boundary();
      return { pressed: request.key ?? "Enter", route, delivery: "delivered", verification: "not-checked" };
    }
    if (request.action !== "click" && request.action !== "type") throw new Error("Unsupported input action");
    if (!request.ref && !request.selector && !(request.action === "click" && request.text)) throw new Error("Input requires ref or selector (click also accepts text)");
    const target = await observe(browserInputTargetBody(request, token)) as { ok: boolean; code?: string; error?: string; fallback?: boolean; x: number; y: number };
    boundary();
    if (!target.ok) return { [request.action === "click" ? "clicked" : "filled"]: false, ...target, route, delivery: "not_delivered" };
    if (target.fallback) {
      boundary();
      dispatched = true;
      const result = await observe(browserInputFallbackBody(request, token)) as Record<string, unknown>;
      boundary();
      return { ...result, route: "page-script-fallback", fallbackReason: "semantic-control", delivery: result.filled === true ? "delivered" : "not_delivered", verification: "not-checked" };
    }
    if (request.action === "click") {
      const point = { x: target.x, y: target.y };
      try {
        await deliver("Input.dispatchMouseEvent", { type: "mouseMoved", ...point });
        const checked = await observe(browserInputCheckBody(token, false, point)) as { ok: boolean; code?: string };
        boundary();
        if (!checked.ok) return { clicked: false, ...checked, route, delivery: "unknown", retry: "unsafe" };
        await deliver("Input.dispatchMouseEvent", { type: "mousePressed", ...point, button: "left", buttons: 1, clickCount: 1 });
      } finally {
        await deliver("Input.dispatchMouseEvent", { type: "mouseReleased", ...point, button: "left", buttons: 0, clickCount: 1 }, true);
      }
      boundary();
      return { clicked: true, route, delivery: "delivered", verification: "not-checked" };
    }
    const prepared = await observe(browserInputPrepareBody(request, token)) as { ok: boolean; code?: string; selectAll?: boolean };
    boundary();
    if (!prepared.ok) return { filled: false, ...prepared, route, delivery: "not_delivered" };
    if (prepared.selectAll) {
      const modifier = typeof process !== "undefined" && process.platform === "darwin" ? 4 : 2;
      try {
        await deliver("Input.dispatchKeyEvent", { type: "rawKeyDown", key: "a", code: "KeyA", windowsVirtualKeyCode: 65, modifiers: modifier, commands: ["selectAll"] });
      } finally {
        await deliver("Input.dispatchKeyEvent", { type: "keyUp", key: "a", code: "KeyA", windowsVirtualKeyCode: 65, modifiers: modifier }, true);
      }
    }
    const checked = await observe(browserInputCheckBody(token, true)) as { ok: boolean; code?: string };
    boundary();
    if (!checked.ok) return { filled: false, ...checked, route, delivery: dispatched ? "unknown" : "not_delivered", retry: dispatched ? "unsafe" : "safe" };
    if (request.text === "" || request.text === undefined) {
      try {
        await deliver("Input.dispatchKeyEvent", { type: "rawKeyDown", key: "Backspace", code: "Backspace", windowsVirtualKeyCode: 8 });
      } finally {
        await deliver("Input.dispatchKeyEvent", { type: "keyUp", key: "Backspace", code: "Backspace", windowsVirtualKeyCode: 8 }, true);
      }
    } else await deliver("Input.insertText", { text: request.text });
    boundary();
    const verified = await observe(browserInputVerifyBody(request, token)) as { ok: boolean; matched?: boolean; code?: string };
    boundary();
    return { filled: verified.ok && verified.matched === true, ...(!verified.ok ? { code: verified.code } : {}), route, delivery: "delivered", ...(!verified.ok || !verified.matched ? { retry: "unsafe" } : {}), verification: verified.matched ? "value-observed" : "value-mismatch" };
  } catch (error) {
    throw new Error(JSON.stringify({ code: signal?.aborted ? "BROWSER_INPUT_ABORTED" : "BROWSER_INPUT_FAILED", route, delivery: dispatched ? "unknown" : "not_delivered", retry: dispatched ? "unsafe" : "safe", error: error instanceof Error ? error.message : String(error) }));
  }
}
