import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { setTimeout as delay } from "node:timers/promises";
import { pageProgram } from "../src/shared/browser-page.ts";
import { runBrowserAccessibilitySnapshot } from "../src/main/engine/browser-accessibility.ts";
import { runBrowserInput } from "../src/main/engine/browser-input.ts";

const chromePath = process.env.FASTVIBE_TEST_CHROME;

test("cancelled accessibility snapshot performs no CDP or page input", async () => {
  const controller = new AbortController();
  controller.abort();
  const methods: string[] = [];
  const fail = async (method?: string) => { if (method) methods.push(method); throw new Error("must not run"); };
  await assert.rejects(
    runBrowserAccessibilitySnapshot({ action: "snapshot", snapshotMode: "accessibility" }, {
      send: fail,
      evaluate: fail,
      contextId: fail,
    }, controller.signal),
    { name: "AbortError" },
  );
  assert.deepEqual(methods, []);
});

test("real Chrome accessibility snapshot keeps exact refs, scope, boundaries and input routing", {
  skip: !chromePath || !existsSync(chromePath),
  timeout: 90000,
}, async () => {
  const profile = await mkdtemp(join(tmpdir(), "fastvibe-accessibility-"));
  const server = createServer((request, response) => {
    response.setHeader("Content-Type", "text/html; charset=utf-8");
    if (request.url === "/frame.html") {
      response.end("<main><button id='inside-frame'>Inside frame</button></main>");
      return;
    }
    response.end(`<!doctype html>
      <title>Accessibility fixture</title>
      <style>
        body { font: 16px sans-serif; } button, input { display: block; width: 180px; height: 32px; margin: 8px; }
        #deep-scope { margin-top: 20px; padding: 8px; } #deep-scope section { padding: 8px; }
      </style>
      <main id="page-main">
        <h1 id="heading">Automation fixture</h1>
        <span style="display:none">Hidden display marker</span>
        <span style="visibility:hidden">Hidden visibility marker</span>
        <div style="display:contents">Visible display contents marker</div>
        <span id="full-name">Name from labelledby</span>
        <button id="same-one" onclick="this.dataset.clicked='one'">Same button</button>
        <button id="same-two" onclick="this.dataset.clicked='two'">Same button</button>
        <input id="labelled" aria-labelledby="full-name" value="visible-value" placeholder="Name placeholder">
        <input id="secret" type="password" value="/file">
        <input id="upload" type="file" value="C:\\fakepath\\secret.txt">
        <div id="deep-scope"><section><div><p id="deep-text">Deep scope text</p><button id="deep-button">Deep button</button></div></section></div>
        <div id="shadow-host"></div>
        <iframe id="frame" src="/frame.html"></iframe>
      </main>`);
  });
  let socket: WebSocket | undefined;
  let child: ReturnType<typeof spawn> | undefined;
  try {
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", resolve);
    });
    const address = server.address();
    assert.ok(address && typeof address === "object");
    const port = address.port;
    child = spawn(chromePath!, [
      "--headless=new", "--remote-debugging-port=0", `--user-data-dir=${profile}`,
      "--no-first-run", "--no-default-browser-check", "about:blank",
    ], { stdio: "ignore" });
    let debugPort: string | undefined;
    for (let attempt = 0; attempt < 120; attempt++) {
      try {
        debugPort = readFileSync(join(profile, "DevToolsActivePort"), "utf8").split("\n")[0];
        break;
      } catch { await delay(50); }
    }
    assert.ok(debugPort, "Chrome must expose a debugging port");
    const targets = await (await fetch(`http://127.0.0.1:${debugPort}/json/list`)).json() as Array<{ type: string; webSocketDebuggerUrl: string }>;
    const page = targets.find(target => target.type === "page");
    assert.ok(page?.webSocketDebuggerUrl);
    socket = new WebSocket(page.webSocketDebuggerUrl);
    await new Promise<void>((resolve, reject) => {
      socket!.addEventListener("open", () => resolve(), { once: true });
      socket!.addEventListener("error", reject, { once: true });
    });
    let id = 0;
    const pending = new Map<number, { resolve: (value: any) => void; reject: (error: Error) => void }>();
    socket.addEventListener("message", event => {
      const reply = JSON.parse(String(event.data));
      const waiter = pending.get(reply.id);
      if (!waiter) return;
      pending.delete(reply.id);
      if (reply.error) waiter.reject(new Error(reply.error.message));
      else waiter.resolve(reply.result);
    });
    const send = (method: string, params: Record<string, unknown> = {}): Promise<any> => new Promise((resolve, reject) => {
      const requestId = ++id;
      const timer = setTimeout(() => { pending.delete(requestId); reject(new Error(`CDP timeout: ${method}`)); }, 10000);
      pending.set(requestId, {
        resolve: value => { clearTimeout(timer); resolve(value); },
        reject: error => { clearTimeout(timer); reject(error); },
      });
      socket!.send(JSON.stringify({ id: requestId, method, params }));
    });
    await send("Page.enable");
    await send("Page.navigate", { url: `http://127.0.0.1:${port}/` });
    await delay(150);
    const frameTree = await send("Page.getFrameTree");
    const context = await send("Page.createIsolatedWorld", {
      frameId: frameTree.frameTree.frame.id,
      worldName: "fastvibe-browser-automation",
      grantUniveralAccess: false,
    });
    const contextId = context.executionContextId as number;
    const evaluate = async (body: string): Promise<any> => {
      const result = await send("Runtime.evaluate", {
        expression: pageProgram(body), contextId, returnByValue: true,
      });
      assert.equal(result.result?.value?.ok, true, result.result?.value?.error);
      return result.result.value.value;
    };
    const channel = { send, evaluate, contextId: async () => contextId };
    await evaluate(`
      const host = document.querySelector('#shadow-host');
      host.attachShadow({ mode: 'open' }).innerHTML = '<label for="shadow-input">Shadow name</label><input id="shadow-input">';
      void host;
    `);
    const snapshot = (extra: Record<string, unknown> = {}) => runBrowserAccessibilitySnapshot({
      action: "snapshot", snapshotMode: "accessibility", ...extra,
    }, channel);
    const first = await snapshot() as any;
    const serialized = JSON.stringify(first);
    assert.equal(first.source, "cdp-accessibility");
    assert.equal(first.capabilities.crossFrame, false);
    assert.match(serialized, /Name from labelledby/);
    assert.doesNotMatch(first.text, /Hidden display marker|Hidden visibility marker/);
    assert.match(first.text, /Visible display contents marker/);
    assert.doesNotMatch(serialized, /\/file\/|fakepath|secret\.txt/);
    const labelled = first.elements.find((element: any) => element.accessibleName === "Name from labelledby");
    assert.ok(labelled, "labelled input should have a DOM-backed element record");
    assert.equal(labelled.accessibleName, "Name from labelledby");
    assert.equal(labelled.value, "visible-value");
    assert.equal(labelled.placeholder, "Name placeholder");
    const same = first.elements.filter((element: any) => element.accessibleName === "Same button");
    assert.equal(same.length, 2);
    assert.notEqual(same[0].ref, same[1].ref);
    assert.equal((await runBrowserInput({ action: "click", ref: same[1].ref }, channel) as any).clicked, true);
    assert.equal(await evaluate("return document.querySelector('#same-one').dataset.clicked || ''"), "");
    assert.equal(await evaluate("return document.querySelector('#same-two').dataset.clicked || ''"), "two");
    const shadow = first.elements.find((element: any) => element.accessibleName === "Shadow name");
    assert.ok(shadow?.ref, "open shadow input should receive an exact ref");
    assert.equal((await runBrowserInput({ action: "type", ref: shadow.ref, text: "shadow value" }, channel) as any).filled, true);
    assert.equal(await evaluate("return document.querySelector('#shadow-host').shadowRoot.querySelector('#shadow-input').value"), "shadow value");
    const findNode = (nodes: any[], predicate: (node: any) => boolean): any => {
      for (const node of nodes) {
        if (predicate(node)) return node;
        const nested = findNode(node.children ?? [], predicate);
        if (nested) return nested;
      }
      return undefined;
    };
    const frameNode = findNode(first.nodes, (node: any) => node.role === "iframe");
    assert.ok(frameNode, "iframe boundary should be represented");
    assert.equal(frameNode.boundary, "iframe");
    assert.equal(frameNode.ref, undefined, "iframe boundary must not expose an internal actionable ref");
    assert.doesNotMatch(serialized, /Inside frame/);

    const scoped = await snapshot({ selector: "#deep-scope", maxDepth: 1 }) as any;
    assert.equal(scoped.text.includes("Name from labelledby"), false);
    assert.match(scoped.text, /Deep scope text/);
    assert.ok(scoped.nodes.some((node: any) => node.subtreeTruncated || node.children.some((child: any) => child.subtreeTruncated)));
    const drillSource = findNode(scoped.nodes, (node: any) => node.ref && node.childrenCount > 0);
    assert.ok(drillSource?.ref, "depth-limited container should be drillable");
    const drilled = await snapshot({ rootRef: drillSource.ref }) as any;
    assert.match(drilled.text, /Deep scope text/);
    assert.match(JSON.stringify(drilled), /Deep button/);
    await assert.rejects(snapshot({ selector: "#deep-scope, #page-main" }), /AMBIGUOUS_SCOPE|AX_MAPPING_FAILED/);

    const oldRef = same[0].ref;
    await snapshot();
    const stale = await runBrowserInput({ action: "click", ref: oldRef }, channel) as any;
    assert.equal(stale.code, "STALE_REF");
    assert.equal(stale.delivery, "not_delivered");
    await evaluate("document.querySelector('#same-two').replaceWith(Object.assign(document.createElement('button'), { id: 'same-two', textContent: 'Same button' }))");
    const replacedSnapshot = await snapshot() as any;
    assert.ok(replacedSnapshot.elements.some((element: any) => element.accessibleName === "Same button"));
    const replacedStale = await runBrowserInput({ action: "click", ref: oldRef }, channel) as any;
    assert.equal(replacedStale.code, "STALE_REF");
    assert.equal((await runBrowserInput({ action: "click", selector: "#same-two" }, channel) as any).clicked, true);

    const controller = new AbortController();
    let axStarted = false;
    const cancellable = {
      ...channel,
      send: async (method: string, params: Record<string, unknown> = {}) => {
        const result = await send(method, params);
        if (method === "Accessibility.getFullAXTree") {
          axStarted = true;
          controller.abort();
        }
        if (controller.signal.aborted) assert.ok(["Runtime.evaluate"].includes(method), `unexpected post-cancel CDP method ${method}`);
        return result;
      },
    };
    await assert.rejects(snapshotWithSignal(cancellable, controller.signal), { name: "AbortError" });
    assert.equal(axStarted, true);
    assert.equal(await evaluate("return document.__fvSnapshotRefs.size"), 0);
  } finally {
    socket?.close();
    child?.kill();
    if (child) await new Promise<void>(resolve => child!.exitCode !== null ? resolve() : child!.once("exit", () => resolve()));
    server.close();
    await rm(profile, { recursive: true, force: true });
  }
});

function snapshotWithSignal(channel: any, signal: AbortSignal) {
  return runBrowserAccessibilitySnapshot({ action: "snapshot", snapshotMode: "accessibility" }, channel, signal);
}
