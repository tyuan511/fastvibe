import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { setTimeout as delay } from "node:timers/promises";
import { runInNewContext } from "node:vm";
import * as page from "../src/shared/browser-page.ts";

import { runBrowserInput as runInput, browserInputTargetBody, browserInputPrepareBody, browserInputVerifyBody, browserInputCheckBody, browserInputFallbackBody } from "../src/main/engine/browser-input.ts";

function channel(observations: unknown[] = [{ ok: true, x: 12, y: 24 }], failure?: string) {
  const calls: Array<{ method: string; params: any }> = [];
  const scripts: string[] = [];
  return {
    calls, scripts,
    evaluate: async (body: string) => { scripts.push(body); return observations.shift() ?? { ok: true }; },
    send: async (method: string, params: any) => {
      calls.push({ method, params });
      if (failure && (params.type === failure || method === failure)) throw new Error("connection lost");
      return {};
    },
  };
}

test("click sends CSS viewport coordinates through CDP and never calls a script click", async () => {
  const c = channel();
  const result = await runInput({ action: "click", ref: "s1:e2" }, c);
  assert.equal(result.clicked, true);
  assert.equal(result.route, "cdp-input");
  assert.deepEqual(c.calls.map(c => c.params.type), ["mouseMoved", "mousePressed", "mouseReleased"]);
  assert.ok(c.calls.every(c => c.params.x === 12 && c.params.y === 24));
  assert.doesNotMatch(c.scripts.join("\n"), /el\.click\(/);
});

test("stale or covered targets send no input and never fall back", async () => {
  for (const code of ["STALE_REF", "TARGET_OBSCURED"]) {
    const c = channel([{ ok: false, code }]);
    const result = await runInput({ action: "click", ref: "old", selector: "#other", text: "Save" }, c);
    assert.equal(result.clicked, false);
    assert.equal(result.code, code);
    assert.equal(result.delivery, "not_delivered");
    assert.equal(c.calls.length, 0);
    assert.equal(c.scripts.length, 1);
  }
});

test("scope container refs cannot dispatch native clicks or text input", async () => {
  const document: any = { __fvSnapshotRefs: new Map(), __fvSnapshotContainers: new Set() };
  const container = { isConnected: true, ownerDocument: document };
  document.__fvSnapshotRefs.set('scope:region', container);
  document.__fvSnapshotContainers.add(container);
  for (const action of ['click', 'type']) {
    let inputs = 0;
    const result = await runInput({ action, ref: 'scope:region', text: 'wrong' }, {
      evaluate: async body => {
        const reply = runInNewContext(page.pageProgram(body), { document });
        assert.equal(reply.ok, true, reply.error);
        return reply.value;
      },
      send: async () => { inputs++; return {}; },
    }) as any;
    assert.equal(result.code, 'INVALID_TARGET');
    assert.equal(result.delivery, 'not_delivered');
    assert.equal(inputs, 0);
  }
});

test("failed mouse dispatch releases the button but never retries or calls DOM fallback", async () => {
  const c = channel(undefined, "mousePressed");
  await assert.rejects(runInput({ action: "click", selector: "#save" }, c), /"delivery":"unknown"/);
  assert.deepEqual(c.calls.map(c => c.params.type), ["mouseMoved", "mousePressed", "mouseReleased"]);
  assert.equal(c.scripts.length, 2);
});

test("press uses native key mapping and modifiers, rejecting unknown keys before delivery", async () => {
  for (const [key, code, modifiers, text] of [
    ["Enter", "Enter", 0, "\r"], ["Tab", "Tab", 0, undefined],
    ["Backspace", "Backspace", 0, undefined], ["Ctrl+a", "KeyA", 2, undefined],
    ["Space", "Space", 0, " "],
  ] as const) {
    const c = channel();
    await runInput({ action: "press", key }, c);
    assert.equal(c.calls[0].params.code, code);
    assert.equal(c.calls[0].params.modifiers, modifiers);
    assert.equal(c.calls[0].params.text, text);
    assert.equal(c.calls[1].params.type, "keyUp");
    assert.equal(c.scripts.length, 0);
  }
  const c = channel();
  await assert.rejects(runInput({ action: "press", key: "NotAKey" }, c), /not_delivered/);
  assert.equal(c.calls.length, 0);
});

test("text replacement verifies the value; empty input deletes the selection", async () => {
  for (const text of ["hello", ""]) {
    const c = channel([{ ok: true }, { ok: true }, { ok: true }, { ok: true, matched: true }]);
    const result = await runInput({ action: "type", ref: "s:e1", text }, c);
    assert.equal(result.filled, true);
    assert.equal(result.verification, "value-observed");
    assert.match(c.scripts[1], /el\.select\(/);
    if (text) assert.equal(c.calls[0].method, "Input.insertText");
    else assert.deepEqual(c.calls.map(c => c.params.type), ["rawKeyDown", "keyUp"]);
  }
  const c = channel([{ ok: true }, { ok: true }], "Input.insertText");
  await assert.rejects(runInput({ action: "type", selector: "#email", text: "hello" }, c), /unsafe/);
  assert.equal(c.calls.length, 1);
  assert.equal(c.scripts.length, 3);
});

test("semantic controls use explicit pre-dispatch fallback; focus failure does not type", async () => {
  const c = channel([{ ok: true, fallback: true }, { filled: true, checked: true }]);
  const result = await runInput({ action: "type", selector: "#check", text: "true" }, c);
  assert.equal(result.route, "page-script-fallback");
  assert.equal(result.checked, true);
  assert.equal(c.calls.length, 0);
  const focus = channel([{ ok: true }, { ok: false, code: "FOCUS_FAILED" }]);
  assert.equal((await runInput({ action: "type", ref: "s:e1", text: "hello" }, focus)).code, "FOCUS_FAILED");
  assert.equal(focus.calls.length, 0);
});

test("all exported input scripts compile through pageProgram", () => {
  const request = { action: "type" as const, ref: "s:e1", selector: "#field", text: "中文 `${hello}" };
  for (const body of [browserInputTargetBody(request, "token"), browserInputPrepareBody(request, "token"), browserInputVerifyBody(request, "token"), browserInputCheckBody("token", true), browserInputCheckBody("token", false, { x: 1, y: 2 }), browserInputFallbackBody(request, "token")]) {
    assert.doesNotThrow(() => new Function(page.pageProgram(body)));
  }
});

test("abort at every input boundary stops new actions and preserves required releases", async () => {
  for (const action of ["click", "type", "press"] as const) {
    const steps = action === "click" ? 5 : action === "type" ? 5 : 2;
    for (let stop = 0; stop <= steps; stop++) {
      const controller = new AbortController();
      const events: string[] = [];
      let index = 0;
      let wasAborted = false;
      const c = {
        evaluate: async (_body: string) => {
          assert.equal(wasAborted, false, "no script after abort");
          events.push("evaluate");
          if (++index === stop) { wasAborted = true; controller.abort(); }
          return { ok: true, x: 12, y: 24, matched: true };
        },
        send: async (method: string, params: Record<string, unknown>) => {
          const name = String(params.type ?? method);
          if (wasAborted) assert.ok(["keyUp", "mouseReleased"].includes(name), name);
          events.push(name);
          if (++index === stop) { wasAborted = true; controller.abort(); }
          return {};
        },
      };
      if (stop === 0) { controller.abort(); wasAborted = true; }
      const promise = runInput({ action, selector: "#field", text: "hello", key: "Enter" }, c, controller.signal);
      await assert.rejects(promise, error => {
        const metadata = JSON.parse((error as Error).message);
        assert.equal(metadata.code, "BROWSER_INPUT_ABORTED");
        const delivered = events.some(event => event !== "evaluate");
        assert.equal(metadata.delivery, delivered ? "unknown" : "not_delivered");
        assert.equal(metadata.retry, delivered ? "unsafe" : "safe");
        return true;
      });
      if (events.includes("mousePressed")) assert.equal(events.at(-1), "mouseReleased");
      if (events.includes("keyDown")) assert.equal(events.at(-1), "keyUp");
    }
  }
});

test("abort after selectAll releases key and never inserts text or starts another script", async () => {
  const controller = new AbortController();
  const c = channel([{ ok: true }, { ok: true, selectAll: true }]);
  const send = c.send;
  c.send = async (method, params) => { const result = await send(method, params); controller.abort(); return result; };
  await assert.rejects(runInput({ action: "type", selector: "#number", text: "42" }, c, controller.signal), /"retry":"unsafe"/);
  assert.deepEqual(c.calls.map(call => call.params.type), ["rawKeyDown", "keyUp"]);
  assert.equal(c.scripts.length, 2);
});

test("lost focus or replaced bound object never inserts or falls back", async () => {
  for (const code of ["FOCUS_LOST", "TARGET_REPLACED"]) {
    const c = channel([{ ok: true }, { ok: true }, { ok: false, code }]);
    const result = await runInput({ action: "type", selector: "#field", text: "hello" }, c);
    assert.equal(result.code, code);
    assert.equal(result.filled, false);
    assert.equal(c.calls.length, 0);
    assert.equal(c.scripts.length, 3);
  }
  const click = channel([{ ok: true, x: 1, y: 2 }, { ok: false, code: "TARGET_REPLACED" }]);
  const result = await runInput({ action: "click", selector: "#save" }, click);
  assert.equal(result.retry, "unsafe");
  assert.deepEqual(click.calls.map(call => call.params.type), ["mouseMoved", "mouseReleased"]);
});

const chromePath = process.env.FASTVIBE_TEST_CHROME;
test("real Chromium native input preserves fill semantics and refuses stale refs", { skip: !chromePath || !existsSync(chromePath) }, async () => {
  const dir = await mkdtemp(join(tmpdir(), "fastvibe-cdp-input-"));
  const child = spawn(chromePath!, ["--headless=new", "--remote-debugging-port=0", `--user-data-dir=${dir}`, "--no-first-run", "--no-default-browser-check", "about:blank"], { stdio: "ignore" });
  const server = createServer((_req, response) => { response.setHeader("Content-Type", "text/html; charset=utf-8"); response.end('<input id="field" value="old"><button id="save" onclick="this.textContent=\'Saved\'">Save</button><input id="secret" type="password"><select id="choice"><option>A</option><option>B</option></select><input id="check" type="checkbox"><div id="edit" contenteditable="true">old</div>'); });
  let socket: WebSocket | undefined;
  try {
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
    let port: string | undefined;
    for (let i = 0; i < 100; i++) {
      try { port = readFileSync(join(dir, "DevToolsActivePort"), "utf8").split("\n")[0]; break; } catch { await delay(100); }
    }
    assert.ok(port, "Chrome must expose a debugging port");
    const targets = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json() as any[];
    socket = new WebSocket(targets.find(t => t.type === "page").webSocketDebuggerUrl);
    await new Promise<void>((resolve, reject) => { socket!.addEventListener("open", () => resolve(), { once: true }); socket!.addEventListener("error", reject, { once: true }); });
    let seq = 0;
    const pending = new Map<number, { resolve: (value: any) => void; reject: (error: Error) => void }>();
    socket.addEventListener("message", event => {
      const reply = JSON.parse(String(event.data));
      const waiter = pending.get(reply.id);
      if (!waiter) return;
      pending.delete(reply.id);
      if (reply.error) waiter.reject(new Error(reply.error.message)); else waiter.resolve(reply.result);
    });
    const send = (method: string, params: any = {}): Promise<any> => new Promise((resolve, reject) => {
      const id = ++seq;
      const timer = setTimeout(() => { pending.delete(id); reject(new Error(`Timeout: ${method}`)); }, 5000);
      pending.set(id, { resolve: value => { clearTimeout(timer); resolve(value); }, reject: error => { clearTimeout(timer); reject(error); } });
      socket!.send(JSON.stringify({ id, method, params }));
    });
    const evaluate = async (body: string) => {
      const tree = await send("Page.getFrameTree");
      const world = await send("Page.createIsolatedWorld", { frameId: tree.frameTree.frame.id, worldName: "fastvibe-browser-automation", grantUniveralAccess: false });
      assert.equal(typeof world.executionContextId, "number");
      const reply = await send("Runtime.evaluate", { expression: page.pageProgram(body), contextId: world.executionContextId, returnByValue: true });
      assert.equal(reply.result.value.ok, true, reply.result.value.error);
      return reply.result.value.value;
    };
    const c = { send, evaluate };
    await send("Page.enable");
    const address = server.address() as { port: number };
    await send("Page.navigate", { url: `http://127.0.0.1:${address.port}/` });
    for (let i = 0; i < 50; i++) {
      if (await evaluate('return !!document.querySelector("#field")')) break;
      await delay(20);
    }
    const snapshot = await evaluate(page.SNAPSHOT_BODY);
    const field = snapshot.elements.find((e: any) => e.selector === "#field");
    await send("Runtime.evaluate", { expression: `
      document.__fvSnapshotRefs = new Map([[${JSON.stringify(field.ref)}, document.querySelector('#secret')]]);
      window.__fvInputTargets = { get() { return { el: document.querySelector('#secret'), expires: Infinity }; }, set() { throw new Error('page map was used'); } };
      true;
    `, returnByValue: true });
    assert.equal(await evaluate('return document.__fvSnapshotRefs.get(' + JSON.stringify(field.ref) + ').id'), "field");
    assert.equal((await runInput({ action: "type", ref: field.ref, text: "中文 hello" }, c)).filled, true);
    assert.equal(await evaluate('return document.querySelector("#secret").value'), "");
    assert.equal(await evaluate('return document.querySelector("#field").value'), "中文 hello");
    assert.equal((await runInput({ action: "type", selector: "#field", text: "" }, c)).filled, true);
    assert.equal((await runInput({ action: "type", selector: "#edit", text: "replacement" }, c)).filled, true);
    assert.equal((await runInput({ action: "type", selector: "#secret", text: "private" }, c)).filled, true);
    assert.equal((await runInput({ action: "type", selector: "#choice", text: "B" }, c)).route, "page-script-fallback");
    assert.equal((await runInput({ action: "type", selector: "#check", text: "true" }, c)).checked, true);
    await evaluate(`
      const host = document.createElement('div'); host.id = 'shadow-host'; document.body.append(host);
      const outer = host.attachShadow({ mode: 'open' });
      const nested = document.createElement('section'); outer.append(nested);
      const root = nested.attachShadow({ mode: 'open' });
      root.innerHTML = '<input id="shadow-field" value="old"><button id="shadow-save">Save in shadow</button>';
      const field = root.querySelector('input'); const button = root.querySelector('button');
      button.addEventListener('click', () => { button.textContent = 'Shadow saved'; });
      document.__fvSnapshotRefs.set('shadow:field', field);
      document.__fvSnapshotRefs.set('shadow:save', button);
      return true;
    `);
    assert.equal((await runInput({ action: 'type', ref: 'shadow:field', text: 'nested 中文' }, c)).filled, true);
    assert.equal((await runInput({ action: 'click', ref: 'shadow:save' }, c)).clicked, true);
    assert.equal(await evaluate(`return document.querySelector('#shadow-host').shadowRoot.querySelector('section').shadowRoot.querySelector('button').textContent`), 'Shadow saved');
    await evaluate(`const field = document.querySelector('#shadow-host').shadowRoot.querySelector('section').shadowRoot.querySelector('input'); field.setAttribute('aria-readonly', 'true'); return true`);
    assert.equal((await runInput({ action: 'type', ref: 'shadow:field', text: 'blocked' }, c)).code, 'NOT_ACTIONABLE');
    assert.equal((await runInput({ action: 'click', ref: 'shadow:field' }, c)).clicked, true, 'readonly controls may still be clicked');
    await runInput({ action: "click", selector: "#save" }, c);
    assert.equal(await evaluate('return document.querySelector("#save").textContent'), "Saved");
    await evaluate('document.querySelector("#field").focus(); return true');
    await runInput({ action: "press", key: "Tab" }, c);
    assert.equal(await evaluate('return document.activeElement.id'), "save");
    await evaluate(page.SNAPSHOT_BODY);
    assert.equal((await runInput({ action: "click", ref: field.ref, selector: "#save" }, c)).code, "STALE_REF");
    await evaluate('const x=document.createElement("input"); x.id="race"; x.value="untouched"; document.body.append(x); return true');
    for (const useRef of [false, true]) {
      const raceSnapshot = await evaluate(page.SNAPSHOT_BODY);
      const raceRef = raceSnapshot.elements.find((element: any) => element.selector === "#race").ref;
      let observations = 0;
      let inserts = 0;
      const result = await runInput({ action: "type", ...(useRef ? { ref: raceRef } : { selector: "#race" }), text: "must not arrive" }, {
        evaluate: async body => {
          const result = await evaluate(body);
          if (++observations === 1) await evaluate('const old=document.querySelector("#race"); old.replaceWith(old.cloneNode(true)); return true');
          return result;
        },
        send: async (method, params) => { inserts++; return send(method, params); },
      });
      assert.equal(result.code, useRef ? "STALE_REF" : "TARGET_REPLACED");
      assert.equal(inserts, 0);
      assert.equal(await evaluate('return document.querySelector("#race").value'), "untouched");
    }
    let preparedCount = 0;
    const lostFocus = await runInput({ action: "type", selector: "#race", text: "must not arrive" }, {
      evaluate: async body => {
        const result = await evaluate(body);
        if (++preparedCount === 2) await evaluate('document.querySelector("#field").focus(); return true');
        return result;
      }, send,
    });
    assert.equal(lostFocus.code, "FOCUS_LOST");
    assert.equal(await evaluate('return document.querySelector("#race").value'), "untouched");
    const mouseEvents: string[] = [];
    const replacedClick = await runInput({ action: "click", selector: "#save" }, {
      evaluate,
      send: async (method, params) => {
        mouseEvents.push(String(params.type));
        const result = await send(method, params);
        if (params.type === "mouseMoved") await evaluate('const old=document.querySelector("#save"); old.replaceWith(old.cloneNode(true)); return true');
        return result;
      },
    });
    assert.equal(replacedClick.code, "TARGET_REPLACED");
    assert.deepEqual(mouseEvents, ["mouseMoved", "mouseReleased"]);
    const controller = new AbortController();
    const cancelledKeys: string[] = [];
    await assert.rejects(runInput({ action: "press", key: "Shift+ArrowRight" }, {
      evaluate,
      send: async (method, params) => {
        cancelledKeys.push(String(params.type));
        const result = await send(method, params);
        if (params.type === "rawKeyDown") controller.abort();
        return result;
      },
    }, controller.signal), /BROWSER_INPUT_ABORTED/);
    assert.deepEqual(cancelledKeys, ["rawKeyDown", "keyUp"]);
    await evaluate('const cover=document.createElement("div"); cover.style="position:fixed;inset:0;z-index:999"; document.body.append(cover); return true');
    assert.equal((await runInput({ action: "click", selector: "#save" }, c)).code, "TARGET_OBSCURED");
  } finally {
    socket?.close();
    server.closeAllConnections();
    server.close();
    const exited = new Promise(resolve => child.once("exit", resolve));
    child.kill();
    await Promise.race([exited, delay(3000)]);
    await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});
