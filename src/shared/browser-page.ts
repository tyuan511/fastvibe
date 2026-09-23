/**
 * The page scripts browser-use runs inside a document.
 *
 * Both backends speak them: the side-pane webview through `executeJavaScript`,
 * and a system browser through CDP `Runtime.evaluate`. They are plain JS on
 * purpose — a script that only compiles inside one of the two hosts is a script
 * that fails in the other with nothing to point at.
 */

export const SNAPSHOT_ELEMENT_LIMIT = 150;
export const SNAPSHOT_TEXT_LIMIT = 8_000;

/**
 * In-page helpers shared by the click and type scripts. An element is addressed
 * by `ref` (stamped by the last snapshot), then by `selector`, then by visible
 * text. A miss lists the labels that were on offer, so the model can retry
 * without another round trip. `ref`, `selector` and `text` are in scope.
 */
export const PAGE_HELPERS = `
  const visible = (el) => { const r = el.getBoundingClientRect(); const s = getComputedStyle(el); return r.width > 1 && r.height > 1 && s.visibility !== 'hidden' && s.display !== 'none' && Number(s.opacity) > 0.05; };
  const clean = (value) => String(value == null ? '' : value).replace(/\\s+/g, ' ').trim();
  const label = (el) => clean(el.innerText || el.value || el.getAttribute('aria-label') || el.getAttribute('title') || el.getAttribute('placeholder') || el.getAttribute('name') || '');
  const TARGETS = 'a,button,summary,label,[role="button"],[role="link"],[role="tab"],[role="menuitem"],[role="option"],[role="checkbox"],[role="switch"],[contenteditable="true"],input:not([type="hidden"]),textarea,select';
  const resolve = () => {
    if (ref) { const hit = document.querySelector('[data-fv-ref="' + ref + '"]'); if (hit) return hit; }
    if (selector) { try { const hit = document.querySelector(selector); if (hit) return hit; } catch (error) { throw new Error('invalid selector: ' + selector); } }
    const needle = clean(text).toLowerCase();
    if (!needle) return null;
    const pool = [...document.querySelectorAll(TARGETS)].filter(visible);
    return pool.find((el) => label(el).toLowerCase() === needle)
      || pool.find((el) => label(el).toLowerCase().startsWith(needle))
      || pool.find((el) => label(el).toLowerCase().includes(needle))
      || null;
  };
  const nearby = () => [...document.querySelectorAll(TARGETS)].filter(visible).map(label).filter(Boolean).slice(0, 12);
`;

/**
 * The snapshot. Elements carry a `ref` (stamped as `data-fv-ref`, so a click can
 * address the exact element even after the page mutates) and a `selector`, and a
 * miss is data, never a throw.
 */
export const SNAPSHOT_BODY = `
  const visible = (el) => { const r = el.getBoundingClientRect(); const s = getComputedStyle(el); return r.width > 1 && r.height > 1 && s.visibility !== 'hidden' && s.display !== 'none' && Number(s.opacity) > 0.05; };
  const clean = (value) => String(value == null ? '' : value).replace(/\\s+/g, ' ').trim();
  const path = (el) => {
    const parts = [];
    let node = el;
    while (node && node.nodeType === 1 && node !== document.body && parts.length < 6) {
      let part = node.tagName.toLowerCase();
      const parent = node.parentElement;
      if (parent) {
        const same = [...parent.children].filter((child) => child.tagName === node.tagName);
        if (same.length > 1) part += ':nth-of-type(' + (same.indexOf(node) + 1) + ')';
      }
      parts.unshift(part);
      node = parent;
    }
    return parts.length ? 'body > ' + parts.join(' > ') : 'body';
  };
  const TARGETS = 'a,button,summary,label,[role="button"],[role="link"],[role="tab"],[role="menuitem"],[role="option"],[role="checkbox"],[role="switch"],[contenteditable="true"],input:not([type="hidden"]),textarea,select';
  const all = [...document.querySelectorAll(TARGETS)].filter(visible);
  const elements = all.slice(0, ${SNAPSHOT_ELEMENT_LIMIT}).map((el, index) => {
    const ref = 'e' + index;
    try { el.setAttribute('data-fv-ref', ref); } catch (error) { void error; }
    const tag = el.tagName.toLowerCase();
    return {
      ref,
      tag,
      type: el.getAttribute('type') || undefined,
      role: el.getAttribute('role') || undefined,
      text: clean(el.innerText || el.value || el.getAttribute('aria-label') || el.getAttribute('title') || el.getAttribute('placeholder') || el.getAttribute('name') || '').slice(0, 200),
      name: el.getAttribute('name') || undefined,
      href: tag === 'a' ? el.href : undefined,
      disabled: el.disabled === true ? true : undefined,
      selector: el.id ? '#' + CSS.escape(el.id) : path(el),
    };
  });
  return {
    url: location.href,
    title: document.title,
    elementCount: all.length,
    truncated: all.length > elements.length,
    elements,
    text: (document.body ? document.body.innerText : '').replace(/\\n{3,}/g, '\\n\\n').slice(0, ${SNAPSHOT_TEXT_LIMIT}),
  };
`;

/** Wrap a page body so a throw comes back as data instead of killing the call. */
export function pageProgram(body: string): string {
  return `(() => { try { const value = (() => { ${body} })(); return { ok: true, value: JSON.parse(JSON.stringify(value === undefined ? null : value)) }; } catch (error) { return { ok: false, error: String((error && error.message) || error) }; } })()`;
}

export function clickBody(request: { selector?: string; ref?: string; text?: string }): string {
  return `
    const selector = ${JSON.stringify(request.selector ?? "")};
    const ref = ${JSON.stringify(request.ref ?? "")};
    const text = ${JSON.stringify(request.text ?? "")};
    ${PAGE_HELPERS}
    const el = resolve();
    if (!el) return { clicked: false, error: 'No clickable element found', candidates: nearby() };
    el.scrollIntoView({ block: 'center', inline: 'center' });
    if (el.focus) el.focus();
    for (const type of ['pointerover', 'mouseover', 'pointerdown', 'mousedown', 'pointerup', 'mouseup']) {
      const ctor = type.indexOf('pointer') === 0 ? window.PointerEvent : MouseEvent;
      el.dispatchEvent(new ctor(type, { bubbles: true, cancelable: true, view: window, detail: 1 }));
    }
    el.click();
    return { clicked: true, tag: el.tagName.toLowerCase(), text: label(el).slice(0, 200), href: el.tagName === 'A' ? el.getAttribute('href') || undefined : undefined };
  `;
}

export function typeBody(request: { selector?: string; ref?: string; text?: string }): string {
  return `
    const selector = ${JSON.stringify(request.selector ?? "")};
    const ref = ${JSON.stringify(request.ref ?? "")};
    const text = ${JSON.stringify(request.text ?? "")};
    ${PAGE_HELPERS}
    const el = resolve();
    if (!el) return { filled: false, error: 'No input element found', candidates: nearby() };
    el.scrollIntoView({ block: 'center' });
    el.focus();
    const value = text;
    if (el.tagName === 'SELECT') {
      const wanted = clean(value).toLowerCase();
      const options = [...el.options];
      const option = options.find((item) => item.value.toLowerCase() === wanted || clean(item.text).toLowerCase() === wanted) || options.find((item) => clean(item.text).toLowerCase().includes(wanted));
      if (!option) return { filled: false, error: 'No matching option in select', options: options.slice(0, 30).map((item) => ({ value: item.value, text: clean(item.text) })) };
      el.value = option.value;
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
      return { filled: true, tag: 'select', value: el.value };
    }
    if (el.type === 'checkbox' || el.type === 'radio') {
      const next = !/^(false|0|no|off)$/i.test(clean(value));
      if (el.checked !== next) {
        el.checked = next;
        el.dispatchEvent(new Event('input', { bubbles: true }));
        el.dispatchEvent(new Event('change', { bubbles: true }));
      }
      return { filled: true, tag: el.tagName.toLowerCase(), checked: el.checked };
    }
    if (el.isContentEditable) {
      el.textContent = value;
      el.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: value }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
      return { filled: true, tag: 'contenteditable', value: el.textContent };
    }
    if (!('value' in el)) return { filled: false, error: 'Element does not accept text (' + el.tagName.toLowerCase() + ')' };
    const proto = el.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
    if (setter) setter.call(el, value); else el.value = value;
    el.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: value }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
    return { filled: true, tag: el.tagName.toLowerCase(), value: el.value };
  `;
}

export function pressBody(key: string): string {
  return `
    const key = ${JSON.stringify(key)};
    const target = document.activeElement || document.body;
    const LEGACY = { Enter: 13, Tab: 9, Escape: 27, Backspace: 8, Delete: 46, ArrowUp: 38, ArrowDown: 40, ArrowLeft: 37, ArrowRight: 39, ' ': 32, PageUp: 33, PageDown: 34, Home: 36, End: 35 };
    const keyCode = LEGACY[key] || (key.length === 1 ? key.toUpperCase().charCodeAt(0) : 0);
    const options = { key, code: key === ' ' ? 'Space' : key, keyCode, which: keyCode, bubbles: true, cancelable: true };
    for (const type of ['keydown', 'keypress', 'keyup']) target.dispatchEvent(new KeyboardEvent(type, options));
    return { pressed: key, target: target.tagName.toLowerCase() };
  `;
}
