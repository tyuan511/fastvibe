import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { readFileSync, mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { runInNewContext } from "node:vm";
import ts from "typescript";
import type { WebContents } from "electron";
import { Ipc } from "../src/shared/ipc.ts";
import { assertBrowserGuest, BROWSER_AUTOMATION_WORLD, BROWSER_AUTOMATION_WORLD_NAME, runBrowserGuestAction } from "../src/main/pi/browser-guest-input.ts";

const asContents = (value: unknown) => value as WebContents;
let nextGuestId = 10;
function fakeGuest(owner: object, values: unknown[] = []) {
  const guest = Object.assign(new EventEmitter(), {
    id: ++nextGuestId,
    hostWebContents: owner,
    isDestroyed: () => false,
    getType: () => "webview",
    calls: [] as Array<{ world?: number; method?: string; params?: any }>,
    executeJavaScript: async () => { throw new Error("Main world must never run automation"); },
    executeJavaScriptInIsolatedWorld: async (world: number, _scripts: unknown[]) => {
      guest.calls.push({ world });
      return { ok: true, value: values.shift() };
    },
    debugger: Object.assign(new EventEmitter(), {
      isAttached: () => guest.debugger.attached,
      attached: false,
      attach: (_protocol: string) => { guest.debugger.attached = true; },
      sendCommand: async (method: string, params: any) => {
        guest.calls.push({ method, params });
        if (method === "Page.getFrameTree") return { frameTree: { frame: { id: "main-frame" } } };
        if (method === "Page.createIsolatedWorld") return { executionContextId: 42 };
        if (method === "Runtime.evaluate") return { result: { value: { ok: true, value: values.shift() } } };
        return {};
      },
    }),
  });
  return guest;
}
const owner = () => Object.assign(new EventEmitter(), { isDestroyed: () => false });

test("guest ownership rejects other windows, destroyed guests and non-webviews", () => {
  const host = owner();
  const guest = fakeGuest(host);
  assert.doesNotThrow(() => assertBrowserGuest(asContents(host), asContents(guest)));
  assert.throws(() => assertBrowserGuest(asContents(owner()), asContents(guest)), /OWNER_MISMATCH/);
  assert.throws(() => assertBrowserGuest(asContents(host), undefined), /OWNER_MISMATCH/);
  guest.getType = () => "window";
  assert.throws(() => assertBrowserGuest(asContents(host), asContents(guest)), /OWNER_MISMATCH/);
});

test("snapshot, check and authorized evaluate execute only in the shared isolated world", async () => {
  const host = owner();
  for (const action of ["snapshot", "check", "evaluate"]) {
    const expected = { sentinel: action };
    const guest = fakeGuest(host, [expected]);
    const result = await runBrowserGuestAction(asContents(host), asContents(guest), { action, text: "Saved", script: "return 1" });
    assert.equal(result, expected);
    assert.deepEqual(guest.calls.map(c => c.method), ["Page.getFrameTree", "Page.createIsolatedWorld", "Runtime.evaluate"]);
    assert.equal(guest.calls[1].params.worldName, BROWSER_AUTOMATION_WORLD_NAME);
    assert.equal(guest.calls[2].params.contextId, 42);
    assert.equal(guest.calls.filter(c => c.world).length, 0);
  }
  await assert.rejects(runBrowserGuestAction(asContents(host), asContents(fakeGuest(host)), { action: "arbitrary" }), /NOT_ALLOWED/);
});

test("native guest click uses isolated targeting and Input without main-world evaluation", async () => {
  const host = owner();
  const guest = fakeGuest(host, [{ ok: true, x: 15, y: 25 }, { ok: true }]);
  const result = await runBrowserGuestAction(asContents(host), asContents(guest), { action: "click", selector: "#save" }) as any;
  assert.equal(result.route, "cdp-input");
  assert.equal(result.clicked, true);
  assert.deepEqual(guest.calls.filter(c => c.method?.startsWith("Input.")).map(c => c.params.type), ["mouseMoved", "mousePressed", "mouseReleased"]);
  assert.equal(guest.calls.filter(c => c.method === "Runtime.evaluate").length, 2);
  assert.ok(guest.calls.filter(c => c.method === "Runtime.evaluate").every(c => c.params.contextId === 42));
  assert.equal(guest.calls.filter(c => c.world).length, 0);
});

test("attach refusal uses isolated fallback, and input failure never replays through fallback", async () => {
  const host = owner();
  const guest = fakeGuest(host, [{ clicked: true }]);
  guest.debugger.attach = () => { throw new Error("DevTools owns this target"); };
  const result = await runBrowserGuestAction(asContents(host), asContents(guest), { action: "click", selector: "#save" }) as any;
  assert.equal(result.route, "page-script-fallback");
  assert.equal(guest.calls.length, 1);
  assert.equal(guest.calls[0].world, BROWSER_AUTOMATION_WORLD);
  const failing = fakeGuest(host, [{ ok: true, x: 15, y: 25 }, { ok: true }]);
  const failingSend = failing.debugger.sendCommand;
  failing.debugger.sendCommand = async (method, params) => {
    if (params.type === "mousePressed") {
      failing.calls.push({ method, params });
      throw new Error("connection lost");
    }
    return failingSend(method, params);
  };
  await assert.rejects(runBrowserGuestAction(asContents(host), asContents(failing), { action: "click", selector: "#save" }), /"retry":"unsafe"/);
  assert.deepEqual(failing.calls.filter(c => c.method?.startsWith("Input.")).map(c => c.params.type), ["mouseMoved", "mousePressed", "mouseReleased"]);
  assert.equal(failing.calls.filter(c => c.method === "Runtime.evaluate").length, 2);
});

test("Stop and guest destruction stop new input but still release held mouse buttons", async () => {
  const host = owner();
  for (const destroy of [false, true]) {
    const controller = new AbortController();
    const guest = fakeGuest(host, [{ ok: true, x: 15, y: 25 }, { ok: true }]);
    const send = guest.debugger.sendCommand;
    guest.debugger.sendCommand = async (method, params) => {
      const result = await send(method, params);
      if (params.type === "mousePressed") {
        if (destroy) guest.emit("destroyed"); else controller.abort();
      }
      return result;
    };
    await assert.rejects(runBrowserGuestAction(asContents(host), asContents(guest), { action: "click", selector: "#save" }, controller.signal), /BROWSER_INPUT_ABORTED/);
    assert.equal(guest.calls.filter(c => c.method?.startsWith("Input.")).at(-1)?.params.type, "mouseReleased");
    assert.equal(guest.listenerCount("destroyed"), 0);
  }
});

test("abort after focus emulation always disables it without sending input", async () => {
  const host = owner();
  const controller = new AbortController();
  const guest = fakeGuest(host);
  const send = guest.debugger.sendCommand;
  guest.debugger.sendCommand = async (method, params) => {
    const result = await send(method, params);
    if (method === "Emulation.setFocusEmulationEnabled" && params.enabled) controller.abort();
    return result;
  };
  await assert.rejects(runBrowserGuestAction(asContents(host), asContents(guest), { action: "press", key: "Enter" }, controller.signal), /abort/i);
  assert.deepEqual(guest.calls.filter(c => c.method === "Emulation.setFocusEmulationEnabled").map(c => [c.method, c.params?.enabled]), [
    ["Emulation.setFocusEmulationEnabled", true], ["Emulation.setFocusEmulationEnabled", false],
  ]);
});

test("lost emulation response is cleaned up across fallback, while foreign debuggers stay untouched", async () => {
  const host = owner();
  const guest = fakeGuest(host, [{ clicked: true }]);
  const send = guest.debugger.sendCommand;
  guest.debugger.sendCommand = async (method, params) => {
    const result = await send(method, params);
    if (method === "Emulation.setFocusEmulationEnabled" && params.enabled) throw new Error("enable response lost");
    return result;
  };
  const result = await runBrowserGuestAction(asContents(host), asContents(guest), { action: "click", selector: "#save" }) as any;
  assert.equal(result.route, "page-script-fallback");
  assert.equal(guest.calls.at(-1)?.params.enabled, false);
  assert.equal(guest.calls.filter(c => c.method?.startsWith("Input.")).length, 0);
  const foreign = fakeGuest(host, [{ clicked: true }]);
  foreign.debugger.isAttached = () => true;
  await runBrowserGuestAction(asContents(host), asContents(foreign), { action: "click", selector: "#save" });
  assert.equal(foreign.calls.filter(c => c.method).length, 0);
});

test("host ref authority survives neither world transitions nor a newer observation", async () => {
  const host = owner();
  const guest = fakeGuest(host, [
    { snapshotId: "old", elements: [{ ref: "old:e1" }] },
    { snapshotId: "new", elements: [{ ref: "new:e1" }] },
  ]);
  await runBrowserGuestAction(asContents(host), asContents(guest), { action: "snapshot" });
  await runBrowserGuestAction(asContents(host), asContents(guest), { action: "snapshot", rootRef: "old:e1" });
  const stale = await runBrowserGuestAction(asContents(host), asContents(guest), { action: "click", ref: "old:e1", selector: "#save" }) as any;
  assert.equal(stale.code, "STALE_REF");
  assert.equal(guest.calls.filter(c => c.method?.startsWith("Input.")).length, 0);
  // An externally lost debugger must not remain classified as ours after reattachment.
  guest.debugger.emit("detach");
  guest.debugger.attached = false;
  guest.debugger.attach = () => { throw new Error("unavailable"); };
  assert.equal((await runBrowserGuestAction(asContents(host), asContents(guest), { action: "snapshot", rootRef: "new:e1" }) as any).code, "STALE_REF");
  // Retaining the same CDP executionContextId cannot resurrect either old map.
  guest.debugger.attach = () => { guest.debugger.attached = true; };
  assert.equal((await runBrowserGuestAction(asContents(host), asContents(guest), { action: "click", ref: "new:e1" }) as any).code, "STALE_REF");
});

test("attach-unavailable DOM refs work in 1001, while AX explicitly rejects", async () => {
  const host = owner();
  const guest = fakeGuest(host, [{ snapshotId: "fallback", elements: [{ ref: "fallback:e1" }] }, { clicked: true }]);
  guest.debugger.attach = () => { throw new Error("unavailable"); };
  await runBrowserGuestAction(asContents(host), asContents(guest), { action: "snapshot" });
  assert.equal((await runBrowserGuestAction(asContents(host), asContents(guest), { action: "click", ref: "fallback:e1" }) as any).clicked, true);
  await assert.rejects(runBrowserGuestAction(asContents(host), asContents(guest), { action: "snapshot", snapshotMode: "accessibility" }), /BROWSER_ACCESSIBILITY_UNAVAILABLE/);
  assert.ok(guest.calls.every(c => c.world === 1001));
});

test("CDP world failure never falls through to another world", async () => {
  const host = owner();
  const guest = fakeGuest(host);
  const send = guest.debugger.sendCommand;
  guest.debugger.sendCommand = async (method, params) => {
    if (method === "Page.createIsolatedWorld") throw new Error("world unavailable");
    return send(method, params);
  };
  await assert.rejects(runBrowserGuestAction(asContents(host), asContents(guest), { action: "snapshot" }), /world unavailable/);
  assert.equal(guest.calls.filter(c => c.world).length, 0);
});

test("context replacement invalidates refs before targeting or dispatch", async () => {
  const host = owner();
  const guest = fakeGuest(host, [{ snapshotId: "context-a", elements: [{ ref: "context-a:e1" }] }]);
  await runBrowserGuestAction(asContents(host), asContents(guest), { action: "snapshot" });
  const send = guest.debugger.sendCommand;
  guest.debugger.sendCommand = async (method, params) => method === "Page.createIsolatedWorld" ? { executionContextId: 43 } : send(method, params);
  const previousEvaluations = guest.calls.filter(c => c.method === "Runtime.evaluate").length;
  assert.equal((await runBrowserGuestAction(asContents(host), asContents(guest), { action: "type", ref: "context-a:e1", selector: "#other", text: "must not write" }) as any).code, "STALE_REF");
  assert.equal(guest.calls.filter(c => c.method === "Runtime.evaluate").length, previousEvaluations);
  assert.equal(guest.calls.filter(c => c.method?.startsWith("Input.")).length, 0);
});

test("Stop after AX acquisition prevents further AX binding", async () => {
  const host = owner();
  const controller = new AbortController();
  const guest = fakeGuest(host);
  const send = guest.debugger.sendCommand;
  guest.debugger.sendCommand = async (method, params) => {
    if (method === "Runtime.evaluate" && params.returnByValue === false) {
      guest.calls.push({ method, params });
      return { result: { objectId: "scope-object" } };
    }
    if (method === "DOM.describeNode") {
      guest.calls.push({ method, params });
      return { node: { backendNodeId: 7 } };
    }
    if (method === "Accessibility.getFullAXTree") {
      guest.calls.push({ method, params });
      controller.abort();
      return { nodes: [{ nodeId: "1", backendDOMNodeId: 7 }] };
    }
    return send(method, params);
  };
  await assert.rejects(runBrowserGuestAction(asContents(host), asContents(guest), { action: "snapshot", snapshotMode: "accessibility" }, controller.signal), /abort/i);
  assert.equal(guest.calls.filter(c => c.method === "DOM.resolveNode").length, 0);
  assert.equal(guest.calls.filter(c => c.method === "Runtime.evaluate")[0].params.contextId, 42);
});

function bridgeHarness() {
  const source = readFileSync(new URL("../src/main/pi/browser-bridge.ts", import.meta.url), "utf8");
  const compiled = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
  const api: Record<string, any> = {};
  const hosts: any[] = [];
  const claims: any[] = [];
  const require = createRequire(import.meta.url);
  runInNewContext(compiled, {
    exports: api, AbortController, AbortSignal, setTimeout, clearTimeout,
    require: (name: string) => {
      if (name === "electron") return { app: new EventEmitter(), webContents: { fromId: (id: number) => ({ id }) } };
      if (name === "@shared/ipc") return { Ipc };
      if (name.endsWith("ui-text")) return { uiText: (_zh: string, en: string) => en };
      if (name.endsWith("app-settings")) return { readAppSettings: () => ({}) };
      if (name.endsWith("paths")) return { getFastVibePaths: () => ({ runtimeRoot: "/tmp" }) };
      if (name.endsWith("browser-cdp")) return {};
      if (name.endsWith("browser-guest-input")) return { runBrowserGuestAction: async (...args: any[]) => { claims.push(args); return { clicked: true }; } };
      return require(name);
    },
  });
  const makeHost = () => {
    const host = Object.assign(owner(), { send: (_channel: string, envelope: any) => { host.envelope = envelope; }, envelope: undefined as any });
    hosts.push(host);
    return host;
  };
  return { api, claims, makeHost };
}

test("pending claims bind caller and original arguments, execute once, and expire on Stop", async () => {
  const h = bridgeHarness();
  const host = h.makeHost();
  const other = h.makeHost();
  h.api.attachBrowserRenderer(host);
  const controller = new AbortController();
  const original = { action: "click", ref: "s:e1", conversationId: "chat-a" };
  const request = h.api.requestBrowser(original, controller.signal);
  const id = host.envelope.id;
  await assert.rejects(h.api.executeBrowserGuestAction({ id, guestId: 12 }, other), /WRONG_OWNER/);
  await h.api.executeBrowserGuestAction({ id, guestId: 12, script: "evil", request: { action: "press" } }, host);
  assert.equal(h.claims[0][2], original);
  await assert.rejects(h.api.executeBrowserGuestAction({ id, guestId: 12 }, host), /ALREADY_EXECUTED/);
  h.api.respondBrowserRequest({ id, ok: true }, other);
  controller.abort();
  await assert.rejects(request, /Aborted/);
  assert.equal(h.claims[0][3].aborted, true);
  await assert.rejects(h.api.executeBrowserGuestAction({ id, guestId: 12 }, host), /EXPIRED/);
});

test("destroying one renderer cancels its requests without cancelling another window", async () => {
  const h = bridgeHarness();
  const first = h.makeHost();
  const second = h.makeHost();
  h.api.attachBrowserRenderer(first);
  const firstRequest = h.api.requestBrowser({ action: "snapshot" });
  h.api.attachBrowserRenderer(second);
  const secondRequest = h.api.requestBrowser({ action: "snapshot" });
  first.emit("destroyed");
  await assert.rejects(firstRequest, /closed/);
  h.api.respondBrowserRequest({ id: second.envelope.id, ok: true, result: { title: "second" } }, second);
  assert.equal((await secondRequest).title, "second");
});

test("pending timeout aborts the claimant and rejects late execution", async () => {
  const h = bridgeHarness();
  const host = h.makeHost();
  h.api.attachBrowserRenderer(host);
  const request = h.api.requestBrowser({ action: "snapshot", timeoutMs: 1 });
  const id = host.envelope.id;
  await h.api.executeBrowserGuestAction({ id, guestId: 12 }, host);
  await assert.rejects(request, /timed out/);
  assert.equal(h.claims[0][3].aborted, true);
  await assert.rejects(h.api.executeBrowserGuestAction({ id, guestId: 12 }, host), /EXPIRED/);
});

test("real Electron parked webview uses isolated state and native input", { skip: process.env.FASTVIBE_TEST_ELECTRON !== "1", timeout: 60_000 }, async () => {
  const dir = mkdtempSync(join(tmpdir(), "fastvibe-guest-input-"));
  const root = new URL("../", import.meta.url);
  try {
    for (const relative of ["src/main/pi/browser-guest-input.ts", "src/main/engine/browser-input.ts", "src/main/engine/browser-accessibility.ts", "src/shared/browser-page.ts"]) {
      const output = join(dir, relative.replace(/\.ts$/, ".js"));
      mkdirSync(dirname(output), { recursive: true });
      const js = ts.transpileModule(readFileSync(new URL(relative, root), "utf8"), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
      writeFileSync(output, js.replace(/(require\("[^"\n]+)\.ts("\))/g, "$1.js$2"));
    }
    const require = createRequire(import.meta.url);
    const executable = require("electron") as string;
    const env = { ...process.env, FASTVIBE_GUEST_SMOKE_ROOT: dir };
    delete env.ELECTRON_RUN_AS_NODE;
    const child = spawn(executable, [new URL("./fixtures/browser-guest-input-smoke.cjs", import.meta.url).pathname], { env, stdio: ["ignore", "pipe", "pipe"] });
    let output = "";
    child.stdout.on("data", chunk => { output += chunk; });
    child.stderr.on("data", chunk => { output += chunk; });
    const timer = setTimeout(() => child.kill("SIGKILL"), 50_000);
    const code = await new Promise<number | null>((resolve, reject) => { child.on("exit", resolve); child.on("error", reject); });
    clearTimeout(timer);
    assert.equal(code, 0, output);
    assert.match(output, /GUEST_INPUT_SMOKE_OK/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
