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
 * by `ref` from the last snapshot, or by `selector` / visible text when no ref
 * was supplied. A stale ref must never fall through to another target.
 * `ref`, `selector` and `text` are in scope.
 */
export const PAGE_HELPERS = `
  const visible = (el) => { const r = el.getBoundingClientRect(); const s = getComputedStyle(el); return r.width > 1 && r.height > 1 && s.visibility !== 'hidden' && s.display !== 'none' && Number(s.opacity) > 0.05; };
  const clean = (value) => String(value == null ? '' : value).replace(/\\s+/g, ' ').trim();
  const secret = (el) => el.tagName === 'INPUT' && /^(password|file)$/i.test(el.type || '');
  const label = (el) => clean((secret(el) ? '' : el.innerText || el.value) || el.getAttribute('aria-label') || el.getAttribute('title') || el.getAttribute('placeholder') || el.getAttribute('name') || '');
  const TARGETS = 'a,button,summary,label,[role="button"],[role="link"],[role="tab"],[role="menuitem"],[role="option"],[role="checkbox"],[role="switch"],[contenteditable="true"],input:not([type="hidden"]),textarea,select';
  const resolve = () => {
    if (ref) {
      const hit = document.__fvSnapshotRefs?.get(ref);
      return hit && hit.isConnected && hit.ownerDocument === document ? hit : null;
    }
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
 * The snapshot retains exact DOM nodes behind opaque refs and reports selectors
 * for scripts. Every successful observation invalidates all preceding refs.
 * Depth counts retained semantic nodes (scope root = 0); maxElements bounds the
 * combined semantic tree, including containers, rather than only controls.
 * Text has a separate character budget and is read only from the resolved scope.
 */
export function snapshotBody(request: { selector?: string; rootRef?: string; maxDepth?: number; maxElements?: number } = {}): string {
  return `
  const request = ${JSON.stringify(request)};
  const fail = (code, error) => ({ ok: false, code, error });
  if (!request || typeof request !== 'object' || Array.isArray(request)) return fail('INVALID_ARGUMENT', 'Snapshot request must be an object');
  const { selector, rootRef, maxDepth = 50, maxElements = ${SNAPSHOT_ELEMENT_LIMIT} } = request;
  if ((selector !== undefined && (typeof selector !== 'string' || !selector.trim())) ||
      (rootRef !== undefined && (typeof rootRef !== 'string' || !rootRef.trim())) ||
      (selector !== undefined && rootRef !== undefined) ||
      !Number.isInteger(maxDepth) || maxDepth < 1 || maxDepth > 50 ||
      !Number.isInteger(maxElements) || maxElements < 1 || maxElements > 500)
    return fail('INVALID_ARGUMENT', 'Use selector or rootRef, maxDepth 1..50, maxElements 1..500');
  // Resolve the previous exact DOM object before replacing its map.
  let root = document.body;
  if (rootRef !== undefined) {
    root = document.__fvSnapshotRefs?.get(rootRef);
    if (!root || !root.isConnected || root.ownerDocument !== document)
      return fail('STALE_REF', 'Ref expired or its node was replaced; take a new browser_snapshot');
  } else if (selector !== undefined) {
    let matches;
    try { matches = document.querySelectorAll(selector); }
    catch { return fail('INVALID_SELECTOR', 'Invalid snapshot scope selector'); }
    if (!matches.length) return fail('SCOPE_NOT_FOUND', 'Snapshot scope matched no elements');
    if (matches.length !== 1) return fail('SCOPE_AMBIGUOUS', 'Snapshot scope must match exactly one element');
    root = matches[0];
  }
  if (!root) return fail('SCOPE_NOT_FOUND', 'Document has no body');
  const visible = (el) => { const r = el.getBoundingClientRect(); const s = getComputedStyle(el); return r.width > 1 && r.height > 1 && s.visibility !== 'hidden' && s.display !== 'none' && Number(s.opacity) > 0.05; };
  if ((selector !== undefined || rootRef !== undefined) && !visible(root))
    return fail('SCOPE_NOT_VISIBLE', 'Snapshot scope is not visible');
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
  const secret = (el) => el.tagName === 'INPUT' && /^(password|file)$/i.test(el.type || '');
  // Each observation owns fresh ids and exact DOM objects. Cloned attributes cannot
  // impersonate a ref, and navigation or node replacement invalidates old refs.
  const snapshotId = [...crypto.getRandomValues(new Uint8Array(12))]
    .map((byte) => 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789_-'[byte & 63]).join('');
  const refs = new Map();
  const containers = new Set();
  document.__fvSnapshotRefs = refs;
  document.__fvSnapshotContainers = containers;
  for (const stale of document.querySelectorAll('[data-fv-ref]')) stale.removeAttribute('data-fv-ref');
  const accessibleName = (el) => {
    const labelled = (el.getAttribute('aria-labelledby') || '').split(/\\s+/).filter(Boolean)
      .map((id) => document.getElementById(id)?.textContent || '').join(' ');
    const contentName = /^(BUTTON|A|SUMMARY|H[1-6])$/.test(el.tagName) ||
      /^(button|link|tab|menuitem|option|checkbox|switch|status|alert|heading)$/.test(el.getAttribute('role') || '') ||
      el.isContentEditable ? el.innerText : '';
    return clean(labelled || el.getAttribute('aria-label') ||
      (el.labels ? [...el.labels].map((item) => item.textContent).join(' ') : '') ||
      (secret(el) ? '' : (el.tagName === 'INPUT' && /^(button|submit|reset)$/i.test(el.type) ? el.value : contentName)) || el.getAttribute('alt') ||
      el.getAttribute('title') || el.getAttribute('placeholder') || el.getAttribute('name') || '').slice(0, 200);
  };
  const roleOf = (el) => el.getAttribute('role') || ({
    A: 'link', BUTTON: 'button', TEXTAREA: 'textbox', SELECT: 'combobox',
    MAIN: 'main', NAV: 'navigation', HEADER: 'banner', FOOTER: 'contentinfo',
    SECTION: 'region', FORM: 'form', ASIDE: 'complementary',
    H1: 'heading', H2: 'heading', H3: 'heading', H4: 'heading', H5: 'heading', H6: 'heading',
    SUMMARY: 'button', IFRAME: 'iframe',
  }[el.tagName]) || (el.tagName === 'INPUT' ?
    ({ checkbox: 'checkbox', radio: 'radio', range: 'slider', number: 'spinbutton', search: 'searchbox', button: 'button', submit: 'button', reset: 'button' }[el.type] || 'textbox') :
    el.isContentEditable ? 'textbox' : 'group');
  const interactiveRoles = new Set(['button', 'link', 'tab', 'menuitem', 'menuitemcheckbox', 'menuitemradio', 'option', 'checkbox', 'radio', 'switch', 'combobox', 'listbox', 'slider', 'spinbutton', 'textbox', 'searchbox', 'treeitem', 'gridcell']);
  const interactive = (el) => el.matches(TARGETS) || interactiveRoles.has(el.getAttribute('role') || '');
  const semanticSelector = 'main,nav,header,footer,section,form,aside,h1,h2,h3,h4,h5,h6,[role],iframe';
  const candidates = [root, ...root.querySelectorAll(TARGETS + ',' + semanticSelector)]
    .filter((el) => visible(el) && (el !== document.body || interactive(el) || el.matches(semanticSelector)));
  const candidateSet = new Set(candidates);
  const depths = new Map();
  const parents = new Map();
  for (const el of candidates) {
    let parent = el === root ? null : el.parentElement;
    while (parent && !candidateSet.has(parent) && parent !== root) parent = parent.parentElement;
    if (!candidateSet.has(parent)) parent = null;
    parents.set(el, parent);
    depths.set(el, parent ? depths.get(parent) + 1 : 0);
  }
  const childCounts = new Map();
  for (const el of candidates) {
    const parent = parents.get(el);
    if (parent) childCounts.set(parent, (childCounts.get(parent) || 0) + 1);
  }
  const withinDepth = candidates.filter((el) => depths.get(el) <= maxDepth);
  const ordered = withinDepth.slice(0, maxElements);
  const selected = ordered.filter(interactive);
  const all = candidates.filter(interactive);
  const refFor = new Map();
  for (const [index, el] of ordered.entries()) {
    const isInteractive = interactive(el);
    if (!isInteractive && !childCounts.get(el)) continue;
    const ref = snapshotId + ':e' + index;
    refFor.set(el, ref);
    refs.set(ref, el);
    if (!isInteractive) containers.add(el);
    try { el.setAttribute('data-fv-ref', ref); } catch (error) { void error; }
  }
  const elements = selected.map((el) => {
    const ref = refFor.get(el);
    const tag = el.tagName.toLowerCase();
    return {
      ref,
      targetType: 'interactive',
      tag,
      type: el.getAttribute('type') || (el.tagName === 'INPUT' ? el.type : undefined),
      value: !secret(el) && ('value' in el || el.isContentEditable) ? String(el.isContentEditable ? el.textContent : el.value).slice(0, 200) : undefined,
      placeholder: el.getAttribute('placeholder') || undefined,
      role: roleOf(el),
      accessibleName: accessibleName(el),
      states: {
        disabled: el.disabled === true || el.getAttribute('aria-disabled') === 'true',
        checked: el.getAttribute('aria-checked') || (typeof el.checked === 'boolean' ? el.checked : undefined),
        selected: el.getAttribute('aria-selected') || (typeof el.selected === 'boolean' ? el.selected : undefined),
        expanded: el.getAttribute('aria-expanded') || undefined,
        required: el.required === true || el.getAttribute('aria-required') === 'true',
        readonly: el.readOnly === true || el.getAttribute('aria-readonly') === 'true',
        invalid: el.getAttribute('aria-invalid') || (el.validity?.valid === false ? true : undefined),
        level: el.getAttribute('aria-level') || (/^H[1-6]$/.test(el.tagName) ? Number(el.tagName.slice(1)) : undefined),
      },
      text: clean((secret(el) ? '' : el.innerText || el.value) || el.getAttribute('aria-label') || el.getAttribute('title') || el.getAttribute('placeholder') || el.getAttribute('name') || '').slice(0, 200),
      name: el.getAttribute('name') || undefined,
      href: tag === 'a' ? el.href : undefined,
      disabled: el.disabled === true ? true : undefined,
      selector: el.id ? '#' + CSS.escape(el.id) : path(el),
    };
  });
  const byElement = new Map(selected.map((el, index) => [el, elements[index]]));
  const nodeMap = new Map();
  const nodes = [];
  for (const el of ordered) {
    const item = byElement.get(el);
    const node = { role: roleOf(el), name: accessibleName(el), ref: refFor.get(el), href: item?.href,
      targetType: item ? 'interactive' : 'container', childrenCount: childCounts.get(el) || 0,
      depth: depths.get(el),
      type: item?.type, value: item?.value, placeholder: item?.placeholder,
      states: item?.states || { readonly: el.getAttribute('aria-readonly') || undefined,
        invalid: el.getAttribute('aria-invalid') || undefined,
        level: el.getAttribute('aria-level') || (/^H[1-6]$/.test(el.tagName) ? Number(el.tagName.slice(1)) : undefined) }, children: [] };
    nodeMap.set(el, node);
    const parent = parents.get(el);
    if (parent && nodeMap.has(parent)) nodeMap.get(parent).children.push(node); else nodes.push(node);
  }
  const bodyText = (root.innerText || '').replace(/\\n{3,}/g, '\\n\\n');
  // Light DOM only; closed shadow roots cannot be detected.
  const scopeElements = [root, ...root.querySelectorAll('*')];
  const iframeCount = scopeElements.filter((el) => el.tagName === 'IFRAME').length;
  const openShadowRootCount = scopeElements.filter((el) => !!el.shadowRoot).length;
  const depthTruncated = withinDepth.length < candidates.length;
  const nodeTruncated = ordered.length < withinDepth.length;
  const textTruncated = bodyText.length > ${SNAPSHOT_TEXT_LIMIT};
  const limitations = ['DOM semantics only; closed shadow roots cannot be detected'];
  if (iframeCount) limitations.push('Iframe contents are not expanded');
  if (openShadowRootCount) limitations.push('Open shadow roots are detected but not expanded');
  return {
    snapshotId,
    source: 'dom-semantics',
    nodes,
    complete: !depthTruncated && !nodeTruncated && !textTruncated && !iframeCount && !openShadowRootCount,
    scope: { selector, rootRef: refFor.get(root), kind: selector !== undefined ? 'selector' : rootRef !== undefined ? 'ref' : 'document' },
    capabilities: { domSemantics: true, iframeExpansion: false, shadowExpansion: false, iframeCount, openShadowRootCount },
    limitations,
    budgets: { maxDepth, maxElements, maxTextCharacters: ${SNAPSHOT_TEXT_LIMIT},
      nodeCount: candidates.length, returnedNodeCount: ordered.length, textCharacters: bodyText.length,
      depthTruncated, nodeTruncated, textTruncated },
    url: location.href,
    title: document.title,
    elementCount: all.length,
    truncated: depthTruncated || nodeTruncated || textTruncated,
    elements,
    text: bodyText.slice(0, ${SNAPSHOT_TEXT_LIMIT}),
  };
`;
}

export const SNAPSHOT_BODY = snapshotBody();

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
    if (!el) return { clicked: false, code: ref ? 'STALE_REF' : 'TARGET_NOT_FOUND', error: ref ? 'Ref expired or its node was replaced; take a new browser_snapshot' : 'No clickable element found', candidates: nearby() };
    if (ref && document.__fvSnapshotContainers?.has(el)) return { clicked: false, code: 'INVALID_TARGET', error: 'Container refs are for snapshot scope; choose an interactive ref' };
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
    if (!el) return { filled: false, code: ref ? 'STALE_REF' : 'TARGET_NOT_FOUND', error: ref ? 'Ref expired or its node was replaced; take a new browser_snapshot' : 'No input element found', candidates: nearby() };
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
    return { filled: true, tag: el.tagName.toLowerCase(), value: secret(el) ? undefined : el.value };
  `;
}

/** A cheap poll for scripts: no snapshot refs are changed or large text returned. */
export function checkBody(request: { selector?: string; text?: string; url?: string }): string {
  return `
    const selector = ${JSON.stringify(request.selector ?? "")};
    const text = ${JSON.stringify(request.text ?? "")};
    const url = ${JSON.stringify(request.url ?? "")};
    const el = selector ? document.querySelector(selector) : null;
    const rect = el && el.getBoundingClientRect();
    const style = el && getComputedStyle(el);
    const visible = !!(rect && rect.width > 1 && rect.height > 1 && style.visibility !== 'hidden' && style.display !== 'none' && Number(style.opacity) > 0.05);
    return {
      matched: (!selector || visible) && (!text || !!document.body && document.body.innerText.includes(text)) && (!url || location.href.includes(url)),
      url: location.href,
      title: document.title,
    };
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
