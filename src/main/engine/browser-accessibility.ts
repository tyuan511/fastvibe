import type { BrowserRequest } from "../../shared/types.ts";

export type BrowserAccessibilityChannel = {
  send(method: string, params?: Record<string, unknown>): Promise<any>;
  evaluate(body: string): Promise<any>;
  /** Must return the same private main-frame world used by evaluate. Never use main world. */
  contextId(): Promise<number>;
};

type AXNode = {
  nodeId: string; parentId?: string; childIds?: string[]; backendDOMNodeId?: number;
  role?: { value?: unknown }; name?: { value?: unknown };
  properties?: Array<{ name: string; value?: { value?: unknown } }>;
};
const INTERACTIVE = /^(button|link|textbox|searchbox|checkbox|radio|combobox|listbox|option|menuitem|menuitemcheckbox|menuitemradio|tab|slider|spinbutton|switch|treeitem)$/i;

/** Resolve old refs before invalidation; staging is private and never actionable until commit. */
export function browserAccessibilityScopeBody(request: { rootRef?: string; selector?: string }, token = "ax"): string {
  return `
    const request = ${JSON.stringify(request)};
    if (request.rootRef && request.selector) throw new Error('AMBIGUOUS_SCOPE');
    let scope = document.documentElement;
    if (request.rootRef) {
      scope = document.__fvSnapshotRefs?.get(request.rootRef);
      if (!scope || !scope.isConnected || scope.ownerDocument !== document) throw new Error('STALE_REF');
    } else if (request.selector) {
      const matches = document.querySelectorAll(request.selector);
      if (matches.length !== 1) throw new Error(matches.length ? 'AMBIGUOUS_SCOPE' : 'TARGET_NOT_FOUND');
      scope = matches[0];
    }
    document.__fvSnapshotRefs = new Map();
    document.__fvSnapshotContainers = new Set();
    globalThis.__fvAXStage = { token: ${JSON.stringify(token)}, scope, refs: new Map(), containers: new Set(), elements: [] };
    return { ok: true };
  `;
}

/** Function declaration for callFunctionOn(objectId); never add executionContextId to that call. */
export function browserAccessibilityBindBody(): string {
  return `function(token, ref, interactive) {
    const stage = globalThis.__fvAXStage;
    if (!stage || stage.token !== token) throw new Error('AX_CONTEXT_CHANGED');
    const el = this;
    if (!(el instanceof Element) || !el.isConnected || el.ownerDocument !== document) return { supported: false };
    const within = (root, node) => {
      while (node) {
        if (node === root) return true;
        const parent = node.parentNode;
        if (parent instanceof ShadowRoot) {
          if (parent.mode !== 'open' || parent.host.shadowRoot !== parent) return 'closed';
          node = parent.host;
        } else node = parent;
      }
      return false;
    };
    const containment = within(stage.scope, el);
    if (containment === 'closed') return { supported: false, boundary: true };
    if (!containment) return { supported: false, invalidated: true };
    // Also prove every shadow ancestor is open, even when the scope is inside it.
    let root = el.getRootNode();
    while (root instanceof ShadowRoot) {
      if (root.mode !== 'open' || root.host.shadowRoot !== root) return { supported: false, boundary: true };
      root = root.host.getRootNode();
    }
    interactive = interactive || el.isContentEditable;
    const secret = el.tagName === 'INPUT' && /^(password|file)$/i.test(el.type);
    const selector = el.id ? '#' + CSS.escape(el.id) : el.tagName.toLowerCase();
    const item = { ref, tag: el.tagName.toLowerCase(), type: el.getAttribute('type') || undefined,
      selector, secret, targetType: interactive ? 'interactive' : 'container', placeholder: secret ? undefined : el.getAttribute('placeholder') || undefined,
      name: secret ? undefined : el.getAttribute('name') || undefined,
      text: '', value: !secret && ('value' in el || el.isContentEditable) ? String(el.isContentEditable ? el.textContent : el.value).slice(0,200) : undefined,
      disabled: el.disabled === true || el.getAttribute('aria-disabled') === 'true' };
    stage.refs.set(ref, el);
    if (!interactive) stage.containers.add(el);
    stage.elements.push(item);
    return { supported: true, ...item };
  }`;
}

/** Commit verifies all exact objects again. Abort/error leaves public maps empty. */
export function browserAccessibilityFinalizeBody(token = "ax", commit = true): string {
  return `
    const stage = globalThis.__fvAXStage;
    if (!stage || stage.token !== ${JSON.stringify(token)}) throw new Error('AX_CONTEXT_CHANGED');
    if (!stage.scope?.isConnected || stage.scope.ownerDocument !== document) throw new Error('AX_SCOPE_CHANGED');
    for (const el of stage.refs.values()) {
      if (!el.isConnected || el.ownerDocument !== document) throw new Error('AX_NODE_REPLACED');
      let current = el;
      while (current && current !== stage.scope) {
        const parent = current.parentNode;
        if (parent instanceof ShadowRoot) {
          if (parent.mode !== 'open' || parent.host.shadowRoot !== parent) throw new Error('AX_SHADOW_CHANGED');
          current = parent.host;
        } else current = parent;
      }
      if (current !== stage.scope) throw new Error('AX_SCOPE_CHANGED');
    }
    ${commit ? "document.__fvSnapshotRefs = stage.refs; document.__fvSnapshotContainers = stage.containers;" : ""}
    const fragments = [];
    let textLength = 0, visits = 0, textTruncated = false;
    const collect = (node) => {
      if (++visits > 10000 || textLength >= 8000) { textTruncated = true; return; }
      if (node.nodeType === 3) {
        const parent = node.parentElement || (node.parentNode instanceof ShadowRoot ? node.parentNode.host : null);
        if (parent) {
          const style = getComputedStyle(parent);
          if (style.visibility === 'hidden' || style.visibility === 'collapse' || style.display === 'none') return;
        }
        // Layout ranges exclude unassigned light DOM and inactive slot fallback text.
        const range = document.createRange(); range.selectNode(node);
        if (!range.getClientRects().length) return;
        const text = (node.textContent || '').replace(/\\s+/g, ' ').trim();
        if (text) { fragments.push(text); textLength += text.length + 1; }
        return;
      }
      if (node.nodeType === 1 && (/^(HEAD|INPUT|TEXTAREA|SCRIPT|STYLE|NOSCRIPT|TEMPLATE|IFRAME)$/.test(node.tagName) || node.hidden || node.getAttribute('aria-hidden') === 'true' || getComputedStyle(node).display === 'none')) return;
      if (node.shadowRoot?.mode === 'open') collect(node.shadowRoot);
      for (const child of node.childNodes || []) { collect(child); if (textTruncated) break; }
    };
    collect(stage.scope);
    return { snapshotId: stage.token, url: location.href, title: document.title, text: fragments.join('\\n').slice(0,8000), textTruncated };
  `;
}

/** Access the already pinned object in a fixed execution context, never re-run a selector. */
export function browserAccessibilityScopeObjectBody(token = "ax"): string {
  return `(() => {
    const stage = globalThis.__fvAXStage;
    if (!stage || stage.token !== ${JSON.stringify(token)} || !stage.scope?.isConnected) throw new Error('AX_SCOPE_CHANGED');
    return stage.scope;
  })()`;
}

function scalar(value: unknown): string {
  return typeof value === "string" || typeof value === "number" || typeof value === "boolean" ? String(value).slice(0, 200) : "";
}

export async function runBrowserAccessibilitySnapshot(
  request: BrowserRequest, channel: BrowserAccessibilityChannel, signal?: AbortSignal,
): Promise<Record<string, unknown>> {
  const token = `ax-${crypto.randomUUID()}`;
  const maxDepth = Math.max(1, Math.min(50, Math.floor(request.maxDepth ?? 50)));
  const limit = Math.max(1, Math.min(500, Math.floor(request.maxElements ?? 150)));
  const check = () => signal?.throwIfAborted();
  const send = async (method: string, params: Record<string, unknown> = {}) => {
    check(); const result = await channel.send(method, params); check();
    if (result.exceptionDetails) throw new Error(`AX_MAPPING_FAILED: ${result.exceptionDetails.text ?? method}`);
    return result;
  };
  const evaluate = async (body: string) => { check(); const result = await channel.evaluate(body); check(); return result; };
  check();
  const contextId = await channel.contextId(); check();
  await evaluate(browserAccessibilityScopeBody(request, token));
  try {
  // Pin every RPC to the original world. Navigation destroys object handles; never reacquire/fallback.
  const scope = await send("Runtime.evaluate", { expression: browserAccessibilityScopeObjectBody(token), contextId, objectGroup: token, returnByValue: false });
  if (!scope.result?.objectId) throw new Error("AX_SCOPE_UNAVAILABLE");
  const description = await send("DOM.describeNode", { objectId: scope.result.objectId, depth: 0 });
  const backendNodeId = description.node?.backendNodeId;
  if (typeof backendNodeId !== "number") throw new Error("AX_SCOPE_UNAVAILABLE");
  const frames = await send("Page.getFrameTree");
  const frameId = frames.frameTree.frame.id;
  const full = await send("Accessibility.getFullAXTree", { frameId });
  const all: AXNode[] = full.nodes ?? [];
  const byId = new Map(all.map(node => [node.nodeId, node]));
  let root = all.find(node => node.backendDOMNodeId === backendNodeId);
  if (!root) {
    // Ignored DOM scope nodes may be absent from the full tree. Partial AX provides its exact AX id.
    const partial = await send("Accessibility.getPartialAXTree", { backendNodeId, fetchRelatives: true });
    for (const node of (partial.nodes ?? []) as AXNode[]) if (!byId.has(node.nodeId)) byId.set(node.nodeId, node);
    root = (partial.nodes as AXNode[] | undefined)?.find(node => node.backendDOMNodeId === backendNodeId);
  }
  if (!root) throw new Error("AX_SCOPE_UNAVAILABLE");
  const selected: Array<{ ax: AXNode; depth: number; parent?: string; boundary: boolean }> = [];
  const visited = new Set<string>();
  let truncated = false;
  const limitations = new Set<string>();
  const visit = (ax: AXNode, depth: number, parent?: string) => {
    if (visited.has(ax.nodeId)) throw new Error("AX_TREE_CHANGED");
    visited.add(ax.nodeId);
    if (selected.length >= limit) { truncated = true; return; }
    const boundary = /^iframe(?:presentational)?$/i.test(scalar(ax.role?.value));
    selected.push({ ax, depth, parent, boundary });
    if (boundary) { limitations.add("iframe documents are boundaries; cross-frame observation and input are unsupported"); return; }
    // Chromium exposes user-agent editor internals below text fields. They are not page DOM targets.
    if (/^(textbox|searchbox|spinbutton|combobox)$/i.test(scalar(ax.role?.value))) return;
    if (depth >= maxDepth) { if (ax.childIds?.length) truncated = true; return; }
    for (const id of ax.childIds ?? []) {
      const child = byId.get(id);
      if (!child) throw new Error("AX_TREE_CHANGED");
      visit(child, depth + 1, ax.nodeId);
    }
  };
  visit(root, 0);
  const bindings = new Map<string, any>();
  for (const { ax, boundary } of selected) {
    if (boundary || !ax.backendDOMNodeId) continue; // AX-only nodes can never receive an actionable ref.
    const remote = await send("DOM.resolveNode", { backendNodeId: ax.backendDOMNodeId, executionContextId: contextId, objectGroup: token });
    if (!remote.object?.objectId) throw new Error("AX_NODE_UNAVAILABLE");
    const bound = await send("Runtime.callFunctionOn", {
      objectId: remote.object.objectId, functionDeclaration: browserAccessibilityBindBody(),
      arguments: [{ value: token }, { value: `${token}:e${bindings.size}` }, { value: INTERACTIVE.test(scalar(ax.role?.value)) }], returnByValue: true,
    });
    if (bound.result?.value?.invalidated) throw new Error('AX_SCOPE_CHANGED');
    if (bound.result?.value?.supported) bindings.set(ax.nodeId, bound.result.value);
    else if (bound.result?.value?.boundary) limitations.add("closed shadow nodes have no actionable refs");
  }
  const suppressed = new Set<string>();
  const suppressChildren = (node: AXNode) => {
    for (const id of node.childIds ?? []) {
      if (suppressed.has(id)) continue;
      suppressed.add(id); const child = byId.get(id); if (child) suppressChildren(child);
    }
  };
  for (const { ax } of selected) if (bindings.get(ax.nodeId)?.secret || ax.properties?.some(p => p.name === "protected" && p.value?.value === true)) suppressChildren(ax);
  const nodes: any[] = [];
  const output = new Map<string, any>();
  const elements: any[] = [];
  for (const { ax, parent, boundary } of selected) {
    if (suppressed.has(ax.nodeId)) continue;
    const bound = bindings.get(ax.nodeId);
    // Never copy AX value/description/properties strings. AX can expose password/file values.
    const secret = bound?.secret || ax.properties?.some(p => p.name === "protected" && p.value?.value === true);
    const name = secret ? "" : scalar(ax.name?.value);
    const atomic = /^(textbox|searchbox|spinbutton|combobox)$/i.test(scalar(ax.role?.value)) || secret;
    const node: any = { role: scalar(ax.role?.value).toLowerCase(), name, children: [], childrenCount: atomic ? 0 : ax.childIds?.length ?? 0 };
    if (bound) {
      const { supported: _supported, ...metadata } = bound;
      Object.assign(node, { ref: metadata.ref, type: metadata.type, targetType: metadata.targetType, value: secret ? undefined : metadata.value, placeholder: secret ? undefined : metadata.placeholder });
      if (metadata.targetType === 'interactive') elements.push({ ...metadata, value: secret ? undefined : metadata.value, accessibleName: name, role: node.role, text: secret ? "" : name });
    } else node.virtual = true;
    if (boundary) node.boundary = "iframe";
    const states: Record<string, unknown> = {};
    for (const property of ax.properties ?? []) {
      if (["disabled", "checked", "selected", "expanded", "required", "readonly", "invalid", "level"].includes(property.name) &&
        ["boolean", "number"].includes(typeof property.value?.value)) states[property.name] = property.value?.value;
    }
    node.states = states;
    output.set(ax.nodeId, node);
    if (parent && output.has(parent)) output.get(parent).children.push(node); else nodes.push(node);
  }
  for (const node of output.values()) if (!node.boundary && node.childrenCount > node.children.length) node.subtreeTruncated = true;
  const meta = await evaluate(browserAccessibilityFinalizeBody(token, false));
  // Commit is one fixed-context, synchronous RPC. No new world may publish these refs.
  await send("Runtime.evaluate", { expression: `(() => { ${browserAccessibilityFinalizeBody(token)} })()`, contextId, returnByValue: true });
  if ((await channel.contextId()) !== contextId) throw new Error("AX_CONTEXT_CHANGED");
  check();
  if (meta.textTruncated) truncated = true;
  return { ...meta, source: "cdp-accessibility", nodes, elements,
    elementCount: elements.length, complete: !truncated && limitations.size === 0, truncated,
    limitations: [...limitations], capabilities: { mainFrame: true, openShadow: true, closedShadow: false, crossFrame: false } };
  } catch (error) {
    // Cleanup can run after abort; only invalidate maps in the original context, never reacquire a world.
    await channel.send("Runtime.evaluate", { contextId, expression: browserAccessibilityCleanupBody(token) }).catch(() => undefined);
    throw error;
  } finally {
    await channel.send("Runtime.releaseObjectGroup", { objectGroup: token }).catch(() => undefined);
    if (signal?.aborted) {
      await channel.send("Runtime.evaluate", { contextId, expression: browserAccessibilityCleanupBody(token) }).catch(() => undefined);
      signal.throwIfAborted();
    }
  }
}

export function browserAccessibilityCleanupBody(token = "ax"): string {
  return `if (globalThis.__fvAXStage?.token === ${JSON.stringify(token)}) {
    document.__fvSnapshotRefs = new Map(); document.__fvSnapshotContainers = new Set(); delete globalThis.__fvAXStage;
  }`;
}
