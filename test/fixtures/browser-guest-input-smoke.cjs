const { app, BrowserWindow, session } = require("electron");
const { createServer } = require("node:http");
const { join } = require("node:path");
const assert = require("node:assert/strict");
const root = process.env.FASTVIBE_GUEST_SMOKE_ROOT;
const { runBrowserGuestAction, BROWSER_AUTOMATION_WORLD } = require(join(root, "src/main/pi/browser-guest-input.js"));
app.setPath("userData", join(root, "user-data"));
const server = createServer((_req, res) => {
  res.setHeader("Content-Type", "text/html; charset=utf-8");
  res.end(`<!doctype html><main><section id="account" role="region" aria-label="Account settings">
    <label for="field">Email</label><input id="field" value="old"><input id="other" value="untouched">
    <span id="save-name">Save account</span><button id="save" aria-labelledby="save-name" onclick="this.textContent='Saved'">Save</button><div id="edit" contenteditable="true">old</div>
    <label for="password">Password</label><input id="password" type="password">
    <select id="choice"><option>A</option><option>B</option></select><input id="check" type="checkbox"></section>
    <div id="shadow-host"></div><iframe title="Frame boundary" srcdoc="<button id='frame-only'>Frame inner secret</button>"></iframe></main>
    <script>const shadow=document.querySelector('#shadow-host').attachShadow({mode:'open'}); shadow.innerHTML='<label for="shadow-field">Shadow email</label><input id="shadow-field"><button id="shadow-save">Shadow save</button>'; shadow.querySelector('button').onclick=function(){this.textContent='Shadow saved'};</script>`);
});
let host;
let guest;
let otherHost;
(async () => {
  await app.whenReady();
  if (app.dock) app.dock.hide();
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  // No persistent partition and no production profile. The host stays hidden throughout.
  const partition = `guest-input-smoke-${Date.now()}`;
  const isolatedSession = session.fromPartition(partition);
  host = new BrowserWindow({ show: false, webPreferences: { webviewTag: true, backgroundThrottling: false, nodeIntegration: false, contextIsolation: true } });
  host.webContents.on("console-message", (_e, ...args) => console.log("host", ...args));
  const attached = new Promise(resolve => host.webContents.once("did-attach-webview", (_e, contents) => {
    guest = contents;
    contents.once("did-finish-load", resolve);
  }));
  const url = `http://127.0.0.1:${server.address().port}/`;
  await host.loadURL(`data:text/html,${encodeURIComponent(`<webview partition="${partition}" src="${url}" style="position:fixed;left:-10000px;top:0;width:1024px;height:768px"></webview>`)}`);
  await attached;
  assert.equal(host.isVisible(), false);
  assert.equal(guest.session, isolatedSession);
  const run = async request => {
    const focused = BrowserWindow.getFocusedWindow();
    const result = await runBrowserGuestAction(host.webContents, guest, request);
    assert.equal(BrowserWindow.getFocusedWindow(), focused, 'automation must not change the focused window');
    assert.equal(host.isVisible(), false, 'automation must keep the host hidden');
    return result;
  };
  const read = script => run({ action: "evaluate", script });
  const snapshot = await run({ action: "snapshot" });
  assert.equal(snapshot.source, "dom-semantics");
  const field = snapshot.elements.find(e => e.selector === "#field");
  const save = snapshot.elements.find(e => e.selector === "#save");
  assert.ok(field && save);
  // Malicious main-world state cannot replace the isolated ref map or input table.
  await guest.executeJavaScript(`document.__fvSnapshotRefs = new Map([[${JSON.stringify(field.ref)}, document.querySelector('#other')]]); window.__fvInputTargets = new Map();`);
  const filled = await run({ action: "type", ref: field.ref, text: "中文 hello" });
  assert.equal(filled.route, "electron-input");
  assert.equal(filled.filled, true, JSON.stringify(filled));
  assert.equal(await read("return document.querySelector('#field').value"), "中文 hello");
  assert.equal(await read("return document.querySelector('#other').value"), "untouched");
  assert.equal((await run({ action: "type", ref: field.ref, text: "" })).filled, true);
  assert.equal(await read("return document.querySelector('#field').value"), "");
  await read("document.querySelector('#field').readOnly=true; return true");
  const readonly = await run({ action: "type", ref: field.ref, text: "must-not-write" });
  assert.equal(readonly.filled, false);
  assert.equal(readonly.code, "NOT_ACTIONABLE");
  assert.equal(await read("return document.querySelector('#field').value"), "");
  await read("document.querySelector('#field').readOnly=false; return true");
  assert.equal((await run({ action: "type", selector: "#edit", text: "replacement" })).filled, true);
  assert.equal(await read("return document.querySelector('#edit').textContent"), "replacement");
  assert.equal((await run({ action: "type", selector: "#password", text: "private" })).filled, true);
  assert.equal((await run({ action: "type", selector: "#choice", text: "B" })).route, "page-script-fallback");
  assert.equal((await run({ action: "type", selector: "#check", text: "true" })).checked, true);
  assert.equal((await run({ action: "click", ref: save.ref })).route, "cdp-input");
  assert.equal((await run({ action: "check", text: "Saved" })).matched, true);
  await read("document.querySelector('#field').focus(); return true");
  await run({ action: "press", key: "Tab" });
  assert.equal(await read("return document.activeElement.id"), "other");
  const fresh = await run({ action: "snapshot" });
  assert.ok(!JSON.stringify(fresh).includes("private"));
  assert.equal((await run({ action: "click", ref: field.ref, selector: "#save" })).code, "STALE_REF");
  const ax = await run({ action: "snapshot", snapshotMode: "accessibility" });
  assert.equal(ax.source, "cdp-accessibility");
  const axField = ax.elements.find(e => e.selector === "#field");
  const axSave = ax.elements.find(e => e.selector === "#save");
  const findNode = (nodes, predicate) => {
    for (const node of nodes || []) {
      if (predicate(node)) return node;
      const found = findNode(node.children, predicate);
      if (found) return found;
    }
  };
  const axRegion = findNode(ax.nodes, node => node.role === 'region' && node.name === 'Account settings' && node.targetType === 'container');
  const shadowField = ax.elements.find(e => e.selector === "#shadow-field");
  const shadowSave = ax.elements.find(e => e.selector === "#shadow-save");
  assert.ok(axField && axSave && axRegion, JSON.stringify(ax));
  assert.match(JSON.stringify(axSave), /Save account/);
  assert.ok(shadowField && shadowSave, "AX must expose exact refs for open shadow controls");
  assert.ok(!JSON.stringify(ax).includes("private"), "AX must suppress password values");
  assert.ok(!ax.elements.some(e => e.selector === "#frame-only"), "iframe internals must not get unusable refs");
  assert.match(JSON.stringify(ax.limitations ?? ax.warnings ?? []), /iframe/i, "AX must state the iframe boundary");
  await guest.executeJavaScript(`document.__fvSnapshotRefs = new Map([[${JSON.stringify(axField.ref)}, document.querySelector('#other')]]);`);
  assert.equal((await run({ action: "type", ref: axField.ref, text: "AX exact" })).filled, true);
  assert.equal(await read("return document.querySelector('#field').value"), "AX exact");
  assert.equal(await read("return document.querySelector('#other').value"), "untouched");
  assert.equal((await run({ action: "type", ref: shadowField.ref, text: "shadow exact" })).filled, true);
  assert.equal(await read("return document.querySelector('#shadow-host').shadowRoot.querySelector('#shadow-field').value"), "shadow exact");
  assert.equal((await run({ action: "click", ref: shadowSave.ref })).clicked, true);
  assert.equal(await read("return document.querySelector('#shadow-host').shadowRoot.querySelector('#shadow-save').textContent"), "Shadow saved");
  const scoped = await run({ action: "snapshot", snapshotMode: "accessibility", rootRef: axRegion.ref, maxDepth: 4, maxElements: 40 });
  assert.equal(scoped.source, "cdp-accessibility");
  assert.ok(scoped.elements.some(e => e.selector === "#field"));
  assert.ok(!scoped.elements.some(e => e.selector === "#shadow-field"));
  assert.equal((await run({ action: "click", ref: axSave.ref })).code, "STALE_REF");
  const selectorScoped = await run({ action: "snapshot", snapshotMode: "accessibility", selector: "#account", maxDepth: 1, maxElements: 1 });
  assert.equal(selectorScoped.source, "cdp-accessibility");
  assert.equal(selectorScoped.complete, false);
  assert.ok(selectorScoped.elements.length <= 1);
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(runBrowserGuestAction(host.webContents, guest, { action: "click", selector: "#save" }, controller.signal));
  otherHost = new BrowserWindow({ show: false });
  await assert.rejects(runBrowserGuestAction(otherHost.webContents, guest, { action: "snapshot" }), /OWNER_MISMATCH/);
  // Opening DevTools can take the debugger. Ref state stays isolated even on fallback.
  guest.debugger.detach();
  const attach = guest.debugger.attach;
  guest.debugger.attach = () => { throw new Error("smoke: attach unavailable"); };
  const fallback = await run({ action: "type", selector: "#field", text: "fallback" });
  assert.equal(fallback.route, "page-script-fallback");
  assert.equal(await read("return document.querySelector('#field').value"), "fallback");
  const fallbackSnapshot = await run({ action: "snapshot" });
  assert.equal(fallbackSnapshot.source, "dom-semantics");
  const fallbackField = fallbackSnapshot.elements.find(e => e.selector === "#field");
  assert.equal((await run({ action: "type", ref: fallbackField.ref, text: "fallback ref" })).filled, true);
  await assert.rejects(run({ action: "snapshot", snapshotMode: "accessibility" }), /BROWSER_ACCESSIBILITY_UNAVAILABLE/);
  guest.debugger.attach = attach;
  // Both isolated worlds retain their maps; host authority must defeat resurrection in either direction.
  assert.equal((await run({ action: "type", ref: fallbackField.ref, text: "must not revive" })).code, "STALE_REF");
  assert.equal((await run({ action: "type", ref: axField.ref, text: "must not revive" })).code, "STALE_REF");
  assert.equal(host.isVisible(), false);
  assert.equal(BROWSER_AUTOMATION_WORLD, 1001);
  console.log("GUEST_INPUT_SMOKE_OK: hidden parked webview; native fill/click/Tab; isolated refs; stale refs; ownership; semantic and attach fallback");
})().then(() => finish(0), error => { console.error(error); finish(1); });
function finish(code) {
  try { otherHost?.destroy(); host?.destroy(); } catch {}
  server.close();
  app.exit(code);
}
setTimeout(() => { console.error("Guest input smoke timed out"); finish(1); }, 40000).unref();
