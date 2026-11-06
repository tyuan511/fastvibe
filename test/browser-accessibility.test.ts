import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";
import { pageProgram } from "../src/shared/browser-page.ts";
import { runBrowserInput } from "../src/main/engine/browser-input.ts";
import * as ax from "../src/main/engine/browser-accessibility.ts";

test("all exported AX programs compile", () => {
  for (const body of [ax.browserAccessibilityScopeBody({ selector: "a[title='`']" }), ax.browserAccessibilityFinalizeBody(), ax.browserAccessibilityCleanupBody(), ax.browserAccessibilityScopeObjectBody()]) assert.doesNotThrow(() => new Function(pageProgram(body)));
  assert.doesNotThrow(() => new Function(`return (${ax.browserAccessibilityBindBody()})`));
});

test("cancelled AX request never starts a new lookup", async () => {
  const controller = new AbortController();
  controller.abort();
  const fail = async () => { throw new Error("must not run"); };
  await assert.rejects(ax.runBrowserAccessibilitySnapshot({ action: "snapshot" }, { send: fail, evaluate: fail, contextId: fail }, controller.signal), { name: "AbortError" });
});

function mockChannel(stop = -1, failMapping = false) {
  const controller = new AbortController();
  const calls: string[] = [];
  let steps = 0;
  const boundary = <T>(value: T): Promise<T> => {
    if (++steps === stop) controller.abort();
    return Promise.resolve(value);
  };
  return {
    controller, calls, get steps() { return steps; },
    contextId: async () => boundary(42),
    evaluate: async (_body: string) => { calls.push('evaluate'); return boundary({ ok: true, snapshotId: 'mock', url: 'about:blank', title: '', text: '' }); },
    send: async (method: string, params: any = {}) => {
      if (controller.signal.aborted) assert.ok(['Runtime.evaluate', 'Runtime.releaseObjectGroup'].includes(method), `no new RPC after Stop: ${method}`);
      calls.push(method);
      if (method === 'Runtime.callFunctionOn') {
        assert.equal(params.executionContextId, undefined);
        if (failMapping) throw new Error('mapping failed');
        return boundary({ result: { value: { supported: true, ref: 'mock:e0', targetType: 'interactive', selector: '#same', secret: false, tag: 'button' } } });
      }
      if (method === 'Runtime.evaluate') return boundary({ result: { objectId: 'scope' } });
      if (method === 'DOM.describeNode') return boundary({ node: { backendNodeId: 1 } });
      if (method === 'Page.getFrameTree') return boundary({ frameTree: { frame: { id: 'main' } } });
      if (method === 'Accessibility.getFullAXTree') return boundary({ nodes: [{ nodeId: '1', backendDOMNodeId: 1, role: { value: 'button' }, name: { value: 'Same' } }] });
      if (method === 'DOM.resolveNode') { assert.equal(params.executionContextId, 42); assert.ok(params.objectGroup); return boundary({ object: { objectId: 'button' } }); }
      return boundary({});
    },
  };
}

test('AX protocol uses exact object handles, releases groups, and cleans up mapping failures', async () => {
  const c = mockChannel();
  const result: any = await ax.runBrowserAccessibilitySnapshot({ action: 'snapshot' }, c);
  assert.equal(result.elements[0].ref, 'mock:e0');
  assert.equal(result.complete, true);
  assert.equal(c.calls.at(-1), 'Runtime.releaseObjectGroup');
  const failed = mockChannel(-1, true);
  await assert.rejects(ax.runBrowserAccessibilitySnapshot({ action: 'snapshot' }, failed), /mapping failed/);
  assert.deepEqual(failed.calls.slice(-2), ['Runtime.evaluate', 'Runtime.releaseObjectGroup']);
});

test('Stop at every AX async boundary prevents further work and permits only cleanup', async () => {
  const baseline = mockChannel();
  await ax.runBrowserAccessibilitySnapshot({ action: 'snapshot' }, baseline);
  for (let stop = 1; stop <= baseline.steps; stop++) {
    const c = mockChannel(stop);
    await assert.rejects(ax.runBrowserAccessibilitySnapshot({ action: 'snapshot' }, c, c.controller.signal), { name: 'AbortError' });
  }
});

const chromePath = process.env.FASTVIBE_TEST_CHROME ?? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
test("real Chrome AX names, exact refs, scope drill, secret, shadow, iframe and cancellation", { skip: !existsSync(chromePath), timeout: 60000 }, async () => {
  const dir = await mkdtemp(join(tmpdir(), "fv-ax-"));
  const child = spawn(chromePath, ["--headless=new", "--remote-debugging-port=0", `--user-data-dir=${dir}`, "--no-first-run", "about:blank"], { stdio: "ignore" });
  let socket: WebSocket | undefined;
  try {
    let port: string | undefined;
    for (let i = 0; i < 100; i++) { try { port = readFileSync(join(dir, "DevToolsActivePort"), "utf8").split("\n")[0]; break; } catch { await delay(50); } }
    assert.ok(port);
    const targets: any = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
    socket = new WebSocket(targets.find((t: any) => t.type === "page").webSocketDebuggerUrl);
    await new Promise<void>((resolve, reject) => { socket!.addEventListener("open", () => resolve(), { once: true }); socket!.addEventListener("error", reject, { once: true }); });
    let seq = 0;
    const pending = new Map<number, any>();
    socket.addEventListener("message", (event) => { const result = JSON.parse(String(event.data)); const waiter = pending.get(result.id); if (waiter) { pending.delete(result.id); result.error ? waiter.reject(new Error(result.error.message)) : waiter.resolve(result.result); } });
    const send = (method: string, params: any = {}): Promise<any> => new Promise((resolve, reject) => {
      const id = ++seq;
      const timer = setTimeout(() => { pending.delete(id); reject(new Error(`timeout ${method} ${JSON.stringify(params).slice(0, 160)}`)); }, 5000);
      pending.set(id, { resolve: (value: any) => { clearTimeout(timer); resolve(value); }, reject: (error: Error) => { clearTimeout(timer); reject(error); } });
      socket!.send(JSON.stringify({ id, method, params }));
    });
    const contextId = async () => {
      const tree = await send("Page.getFrameTree");
      const world = await send("Page.createIsolatedWorld", { frameId: tree.frameTree.frame.id, worldName: "fastvibe-browser-automation", grantUniveralAccess: false });
      return world.executionContextId;
    };
    const evaluate = async (body: string) => {
      const result = await send("Runtime.evaluate", { contextId: await contextId(), expression: pageProgram(body), returnByValue: true });
      assert.equal(result.result.value?.ok, true, result.result.value?.error);
      return result.result.value.value;
    };
    const c = { send, evaluate, contextId };
    await send("Page.enable");
    await send("Runtime.enable");
    await send("Runtime.evaluate", { expression: `document.body.innerHTML = '<label for="field">Visible Label</label><input id="field"><span id="title">Computed Name</span><input aria-labelledby="title"><button id="one" onclick="this.dataset.clicked=1">Same</button><button id="two" onclick="this.dataset.clicked=1">Same</button><input id="secret" type="password" value="uniqueSECRET_172"><input type="file"><main id="scope"><section><button id="deep">Deep</button></section></main><div id="host"></div><iframe src="data:text/html,frame"></iframe>'; const host=document.querySelector('#host'); host.attachShadow({mode:'open'}).innerHTML='<input id="shadow" aria-label="Shadow Field"><button id="shadowbutton">Shadow Button</button>';` });
    const snapshot = (request: any = {}) => ax.runBrowserAccessibilitySnapshot({ action: "snapshot", snapshotMode: "accessibility", ...request }, c);
    const first: any = await snapshot();
    assert.equal(first.source, "cdp-accessibility");
    assert.match(JSON.stringify(first), /Visible Label/);
    assert.match(JSON.stringify(first), /Computed Name/);
    assert.doesNotMatch(JSON.stringify(first), /uniqueSECRET_172/);
    const same = first.elements.filter((e: any) => e.accessibleName === "Same");
    assert.equal(same.length, 2);
    await runBrowserInput({ action: "click", ref: same[1].ref }, c);
    assert.equal(await evaluate("return document.querySelector('#one').dataset.clicked || ''"), "");
    assert.equal(await evaluate("return document.querySelector('#two').dataset.clicked"), "1");
    const shadow = first.elements.find((e: any) => e.accessibleName === "Shadow Field");
    assert.ok(shadow?.ref);
    await runBrowserInput({ action: "type", ref: shadow.ref, text: "shadow works" }, c);
    assert.equal(await evaluate("return document.querySelector('#host').shadowRoot.querySelector('input').value"), "shadow works");
    assert.ok(first.limitations.some((s: string) => s.includes("iframe")));
    const scoped: any = await snapshot({ selector: "#scope", maxDepth: 1 });
    assert.ok(scoped.nodes[0].children.some((n: any) => n.subtreeTruncated));
    const section = scoped.nodes[0].children.find((n: any) => n.ref);
    const drilled: any = await snapshot({ rootRef: section.ref });
    assert.match(JSON.stringify(drilled), /Deep/);
    assert.doesNotMatch(drilled.text, /Visible Label/);
    assert.equal((await runBrowserInput({ action: "click", ref: same[0].ref }, c)).code, "STALE_REF");
    const hostScope: any = await snapshot({ selector: "#host" });
    assert.ok(hostScope.elements.find((e: any) => e.accessibleName === "Shadow Field"));
    const hostRef = hostScope.nodes[0].ref;
    const shadowDrill: any = await snapshot({ rootRef: hostRef });
    assert.ok(shadowDrill.elements.find((e: any) => e.accessibleName === "Shadow Field"));
    await send("Runtime.evaluate", { expression: "document.__fvSnapshotRefs=new Map();globalThis.__fvAXStage={scope:document.body}" });
    assert.ok((await snapshot()).elements.length);
    const controller = new AbortController();
    let stopped = false;
    const cancelled = { ...c, send: async (method: string, params?: any) => { if (stopped) assert.ok(['Runtime.evaluate', 'Runtime.releaseObjectGroup'].includes(method)); const result = await send(method, params); if (method === "Accessibility.getFullAXTree") { stopped = true; controller.abort(); } return result; } };
    await assert.rejects(ax.runBrowserAccessibilitySnapshot({ action: "snapshot" }, cancelled, controller.signal), { name: "AbortError" });
    assert.equal(await evaluate("return document.__fvSnapshotRefs.size"), 0);
  } finally {
    socket?.close(); child.kill();
    await new Promise<void>(resolve => { if (child.exitCode !== null) resolve(); else child.once("exit", () => resolve()); });
    await rm(dir, { force: true, recursive: true });
  }
});
