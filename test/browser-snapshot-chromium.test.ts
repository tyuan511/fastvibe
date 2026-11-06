import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { setTimeout as delay } from "node:timers/promises";
import { createRequire } from "node:module";
import browserUse, { formatBrowserSnapshot } from "../resources/extensions/browser-use.ts";
import { SNAPSHOT_BODY, snapshotBody, pageProgram, clickBody, typeBody } from "../src/shared/browser-page.ts";

const chromePath = process.env.FASTVIBE_TEST_CHROME || [
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", "/usr/bin/chromium", "/usr/bin/chromium-browser", "/usr/bin/google-chrome",
].find(existsSync);

// The pre-upgrade wire shape, measured on the same DOM and same observation.
function legacyJSON(page: any, attributes: { type?: string; role?: string }[]) {
  return JSON.stringify({ tabId: page.tabId, url: page.url, title: page.title,
    elementCount: page.elementCount, truncated: page.truncated,
    elements: page.elements.map((e: any, i: number) => ({ ref: `e${i}`, tag: e.tag,
      type: attributes[i].type, role: attributes[i].role, text: e.text, name: e.name, href: e.href, disabled: e.disabled, selector: e.selector })),
    text: page.text }, null, 2);
}

test("real Chromium snapshot semantics, secrecy, refs and measured compact output", { skip: !chromePath, timeout: 30_000 }, async t => {
  const dir = await mkdtemp(join(tmpdir(), "fastvibe-snapshot-"));
  const child = spawn(chromePath!, ["--headless=new", "--no-sandbox", "--no-proxy-server", "--host-resolver-rules=MAP snapshot.test 127.0.0.1", "--remote-debugging-port=0", `--user-data-dir=${dir}`, "--no-first-run", "--no-default-browser-check", "about:blank"], { stdio: "ignore" });
  const fixture = readFileSync(new URL("./fixtures/browser-automation.html", import.meta.url));
  const server = createServer((_req, res) => { res.setHeader("Content-Type", "text/html; charset=utf-8"); res.end(fixture); });
  let socket: WebSocket | undefined;
  try {
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
    let port: string | undefined;
    for (let i = 0; i < 100; i++) {
      try { port = readFileSync(join(dir, "DevToolsActivePort"), "utf8").split("\n")[0]; break; } catch { await delay(50); }
    }
    assert.ok(port, "Chromium debugging port available");
    const targets = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json() as any[];
    socket = new WebSocket(targets.find(target => target.type === "page").webSocketDebuggerUrl);
    await new Promise<void>((resolve, reject) => { socket!.addEventListener("open", () => resolve(), { once: true }); socket!.addEventListener("error", reject, { once: true }); });
    let seq = 0;
    const pending = new Map<number, (reply: any) => void>();
    socket.addEventListener("message", event => { const reply = JSON.parse(String(event.data)); pending.get(reply.id)?.(reply); });
    const send = (method: string, params: any = {}): Promise<any> => new Promise((resolve, reject) => {
      const id = ++seq;
      const timer = setTimeout(() => { pending.delete(id); reject(new Error(`Timeout: ${method}`)); }, 5000);
      pending.set(id, reply => { clearTimeout(timer); pending.delete(id); if (reply.error) reject(new Error(reply.error.message)); else resolve(reply.result); });
      socket!.send(JSON.stringify({ id, method, params }));
    });
    const evaluate = async (body: string, mainWorld = false) => {
      const tree = await send('Page.getFrameTree');
      const world = mainWorld ? undefined : await send('Page.createIsolatedWorld', {
        frameId: tree.frameTree.frame.id, worldName: 'fastvibe-browser-automation', grantUniveralAccess: false,
      });
      const reply = await send("Runtime.evaluate", {
        expression: pageProgram(body), returnByValue: true,
        ...(world ? { contextId: world.executionContextId } : {}),
      });
      assert.equal(reply.result.value?.ok, true, JSON.stringify(reply));
      return reply.result.value.value;
    };
    // A non-loopback HTTP origin mapped to loopback is genuinely insecure.
    await send("Network.enable");
    await send("Page.enable");
    const address = server.address() as { port: number };
    const url = `http://snapshot.test:${address.port}/`;
    await send("Page.navigate", { url });
    for (let i = 0; i < 100; i++) {
      if (await evaluate('return !!document.querySelector("#email")')) break;
      await delay(20);
    }
    assert.equal(await evaluate('return window.isSecureContext'), false);
    assert.equal(await evaluate('return typeof crypto.randomUUID'), 'undefined');
    const secret = '{{' + 'PASSWORD_' + String.fromCharCode(54, 106, 114, 97, 119, 111, 108, 120) + '}}';
    await evaluate(`document.querySelector('#password').value = ${JSON.stringify(secret)}; return true`);
    const page = { tabId: "fixture", ...await evaluate(SNAPSHOT_BODY) };
    const attributes = await evaluate(`return ${JSON.stringify(page.elements.map((e: any) => e.selector))}.map(selector => {
      const el = document.querySelector(selector);
      return { type: el.getAttribute('type') || undefined, role: el.getAttribute('role') || undefined };
    })`);
    const find = (id: string) => page.elements.find((e: any) => e.selector === `#${id}`);
    assert.match(page.snapshotId, /^[A-Za-z0-9_-]{12}$/);
    assert.equal(page.budgets.maxDepth, 50);
    const flatten = (nodes: any[]): any[] => nodes.flatMap(node => [node, ...flatten(node.children || [])]);
    for (const node of flatten(page.nodes).filter(node => node.targetType === 'container' && node.childrenCount === 0)) {
      assert.equal(node.ref, undefined, `${node.role} leaf must not have a ref`);
    }
    assert.ok(page.elements.every((element: any) => element.ref), 'all interactive refs remain available');
    assert.equal(find('email').value, 'person@example.com');
    assert.equal(find('email').placeholder, 'you@example.com');
    assert.equal(find('name').states.readonly, true);
    assert.equal(find('age').states.invalid, 'true');
    assert.equal(find('save').accessibleName, 'Save changes');
    assert.equal(find('save').role, 'button');
    assert.equal(find('password').value, undefined);
    assert.equal(find('upload').value, undefined);
    const compact = formatBrowserSnapshot(page);
    assert.match(compact, /type="email" value="person@example.com" placeholder="you@example.com"/);
    assert.match(compact, /level=2/);
    assert.match(compact, /level=3/);
    assert.match(compact, /Age must be at least 18/);
    assert.match(compact, /Unsaved changes will be lost/);
    assert.match(compact, /Support is available/);
    assert.equal(compact.split('Page text:')[1].includes('\nEmail\n'), false);
    assert.equal(compact.split('Page text:')[1].includes('Age must be at least 18.'), false, 'alert remains in tree exactly once');
    const previous = (globalThis as any).__fastvibeBrowserRequest;
    const tools = new Map<string, any>();
    (globalThis as any).__fastvibeBrowserRequest = async () => page;
    try {
      browserUse({ registerTool: (tool: any) => tools.set(tool.name, tool) } as any);
      const output = await tools.get('browser_snapshot').execute('test', {});
      assert.equal(output.details, page);
      assert.equal(output.structuredContent, page);
      assert.equal(output.content[0].text, compact);
      assert.ok(!JSON.stringify(output).includes(secret));
    } finally { (globalThis as any).__fastvibeBrowserRequest = previous; }
    for (const output of [page, compact, await evaluate(typeBody({ ref: find('password').ref, text: secret })),
      await evaluate(clickBody({ ref: find('password').ref })),
      await evaluate(clickBody({ ref: 'stale', text: 'anything' })),
      await evaluate(typeBody({ selector: '#missing', text: 'anything' }))]) {
      assert.ok(!JSON.stringify(output).includes(secret), 'no password in any result path');
    }
    const ref = find('email').ref;
    await evaluate(`document.__fvSnapshotRefs = new Map([[${JSON.stringify(ref)}, document.querySelector('#bio')]]);
      window.__fvInputTargets = new Map(); return true`, true);
    assert.equal((await evaluate(typeBody({ ref, text: 'new@example.com' }))).filled, true);
    assert.equal(await evaluate(`return document.querySelector('#email').value`), 'new@example.com');
    assert.equal(await evaluate(`return document.querySelector('#bio').value`), 'Engineer and writer');
    await evaluate(`const old=document.querySelector('#email'); old.replaceWith(old.cloneNode(true)); return true`);
    assert.equal((await evaluate(typeBody({ ref, selector: '#email', text: 'wrong' }))).code, 'STALE_REF');
    await evaluate(`document.querySelector('#scope-password').value = ${JSON.stringify(secret)}; return true`);
    const scoped = await evaluate(snapshotBody({ selector: '#scope-fixture' }));
    assert.equal(scoped.complete, true);
    assert.match(scoped.text, /scope-only prose/);
    assert.doesNotMatch(scoped.text, /future invoices|Support is available/);
    assert.ok(scoped.elements.every((element: any) => element.selector.startsWith('#scope-') || element.tag === 'button'));
    assert.ok(Buffer.byteLength(JSON.stringify(scoped)) < Buffer.byteLength(JSON.stringify(page)));
    t.diagnostic(`Scope UTF-8 bytes full=${Buffer.byteLength(JSON.stringify(page))}, scoped=${Buffer.byteLength(JSON.stringify(scoped))}; compact full=${Buffer.byteLength(compact)}, scoped=${Buffer.byteLength(formatBrowserSnapshot(scoped))}`);
    assert.ok(Buffer.byteLength(formatBrowserSnapshot(scoped)) < Buffer.byteLength(compact));
    assert.equal((await evaluate(typeBody({ ref: find('email').ref, text: 'must not replay' }))).code, 'STALE_REF');
    const shallow = await evaluate(snapshotBody({ selector: '#scope-fixture', maxDepth: 1 }));
    assert.equal(shallow.complete, false);
    assert.equal(shallow.truncated, true);
    assert.equal(shallow.budgets.depthTruncated, true);
    const branch = shallow.nodes[0].children.find((node: any) => node.name === 'Nested branch');
    assert.ok(branch.ref);
    assert.equal(branch.targetType, 'container');
    assert.ok(branch.childrenCount > 0);
    assert.deepEqual(branch.children, []);
    assert.equal(await evaluate(`return document.__fvSnapshotContainers.has(document.__fvSnapshotRefs.get(${JSON.stringify(branch.ref)}))`), true);
    assert.equal(shallow.elements.some((element: any) => element.selector === '#scope-action'), false);
    assert.equal((await evaluate(clickBody({ ref: branch.ref }))).code, 'INVALID_TARGET');
    const drilled = await evaluate(snapshotBody({ rootRef: branch.ref }));
    assert.equal(drilled.nodes[0].name, 'Nested branch');
    assert.notEqual(drilled.nodes[0].ref, branch.ref);
    assert.equal(drilled.complete, true);
    assert.ok(drilled.elements.some((element: any) => element.selector === '#scope-action'));
    assert.doesNotMatch(drilled.text, /scope-only prose/);
    assert.equal((await evaluate(snapshotBody({ rootRef: branch.ref }))).code, 'STALE_REF');
    assert.equal((await evaluate(clickBody({ ref: shallow.nodes[0].ref, selector: '#scope-action' }))).code, 'STALE_REF');
    const currentRoot = drilled.nodes[0].ref;
    for (const [request, code] of [
      [{ selector: '#missing' }, 'SCOPE_NOT_FOUND'],
      [{ selector: '#hidden-scope' }, 'SCOPE_NOT_VISIBLE'],
      [{ selector: '.scope-duplicate' }, 'SCOPE_AMBIGUOUS'],
      [{ selector: '[' }, 'INVALID_SELECTOR'],
      [{ rootRef: 'stale' }, 'STALE_REF'],
      [{ selector: '#scope-fixture', rootRef: currentRoot }, 'INVALID_ARGUMENT'],
      ...[{ selector: '' }, { rootRef: '' }, { selector: 1 }, { rootRef: 1 },
        { maxElements: 0 }, { maxElements: 501 }, { maxElements: 1.5 }, { maxElements: '5' },
        { maxDepth: -1 }, { maxDepth: 0 }, { maxDepth: 51 }, { maxDepth: 1001 }, { maxDepth: 1.5 }, { maxDepth: null }, null]
        .map(request => [request, 'INVALID_ARGUMENT']),
    ] as any[]) {
      const failure = await evaluate(snapshotBody(request));
      assert.equal(failure.ok, false, JSON.stringify(request));
      assert.equal(failure.code, code, JSON.stringify(request));
      assert.equal(failure.elements, undefined, 'scope errors never return a full-page snapshot');
      assert.equal(failure.text, undefined);
    }
    // Rejected observations leave the previous valid map intact.
    const afterFailures = await evaluate(snapshotBody({ rootRef: currentRoot, maxDepth: 1 }));
    assert.equal(afterFailures.nodes.length, 1);
    assert.equal(afterFailures.budgets.maxDepth, 1);
    assert.equal((await evaluate(snapshotBody({ selector: '#scope-fixture', maxDepth: 50 }))).budgets.maxDepth, 50);
    const limited = await evaluate(snapshotBody({ selector: '#scope-fixture', maxElements: 1 }));
    assert.equal(limited.budgets.returnedNodeCount, 1);
    assert.equal(limited.budgets.nodeTruncated, true);
    assert.equal(limited.truncated, true);
    assert.equal(limited.complete, false);
    const boundary = await evaluate(snapshotBody({ selector: '#boundary-fixture' }));
    assert.equal(boundary.capabilities.iframeCount, 1);
    assert.equal(boundary.capabilities.openShadowRootCount, 1);
    assert.equal(boundary.capabilities.iframeExpansion, false);
    assert.equal(boundary.capabilities.shadowExpansion, false);
    assert.equal(boundary.complete, false);
    assert.equal(boundary.truncated, false, 'unsupported boundaries differ from budget truncation');
    assert.doesNotMatch(JSON.stringify(boundary), /frame-only-secret-marker|shadow-only-secret-marker|closed-shadow-marker/);
    for (const output of [scoped, shallow, drilled, limited, boundary]) {
      assert.doesNotMatch(JSON.stringify(output), /scope-password-secret/);
      assert.doesNotMatch(formatBrowserSnapshot(output), /scope-password-secret/);
      assert.ok(!JSON.stringify(output).includes(secret));
      assert.ok(!formatBrowserSnapshot(output).includes(secret));
    }
    const textBudget = await evaluate(`const el = document.createElement('section'); el.id = 'text-budget';
      el.textContent = 'Long prose '.repeat(1000); document.body.append(el); ${snapshotBody({ selector: '#text-budget' })}`);
    assert.equal(textBudget.budgets.textTruncated, true);
    assert.equal(textBudget.text.length, 8000);
    assert.equal(textBudget.complete, false);
    assert.equal(textBudget.truncated, true);
    const many = await evaluate(`const el = document.createElement('section'); el.id = 'many-nodes';
      el.innerHTML = '<button>Action</button>'.repeat(510); document.body.append(el);
      ${snapshotBody({ selector: '#many-nodes', maxElements: 500 })}`);
    assert.equal(many.budgets.nodeCount, 511);
    assert.equal(many.budgets.returnedNodeCount, 500);
    assert.equal(many.elements.length, 499);
    assert.equal(many.budgets.nodeTruncated, true);
    const roleScope = await evaluate(`const el = document.createElement('section'); el.id = 'role-scope';
      el.innerHTML = '<h2>Leaf heading</h2><div role="status">Leaf status</div><footer>Leaf footer</footer><div role="slider" aria-label="Volume" style="width:100px;height:20px"></div>';
      document.body.append(el); ${snapshotBody({ selector: '#role-scope' })}`);
    for (const node of roleScope.nodes[0].children.filter((node: any) => node.targetType === 'container')) assert.equal(node.ref, undefined);
    const slider = roleScope.elements.find((element: any) => element.role === 'slider');
    assert.ok(slider.ref);
    assert.equal(await evaluate(`return document.__fvSnapshotContainers.has(document.__fvSnapshotRefs.get(${JSON.stringify(slider.ref)}))`), false);
    assert.equal((await evaluate(clickBody({ ref: slider.ref }))).clicked, true);
    await evaluate(`document.querySelector('#role-scope').remove(); return true`);
    const leaf = await evaluate(snapshotBody({ selector: '#text-budget' }));
    assert.equal(leaf.nodes[0].ref, undefined);
    assert.equal(await evaluate('return document.__fvSnapshotContainers.size'), 0, 'new snapshot clears prior containers');
    assert.equal((await evaluate(clickBody({ ref: roleScope.nodes[0].ref }))).code, 'STALE_REF');
    const replacement = await evaluate(snapshotBody({ selector: '#scope-branch' }));
    await evaluate(`const el = document.querySelector('#scope-branch'); el.replaceWith(el.cloneNode(true)); return true`);
    assert.equal((await evaluate(snapshotBody({ rootRef: replacement.nodes[0].ref }))).code, 'STALE_REF');
    const next = await evaluate(SNAPSHOT_BODY);
    assert.notEqual(next.snapshotId, page.snapshotId);
    assert.equal((await evaluate(clickBody({ ref: find('save').ref, selector: '#save' }))).code, 'STALE_REF');
    await send('Page.navigate', { url });
    for (let i = 0; i < 100; i++) {
      if (await evaluate('return !!document.querySelector("#email") && !document.__fvSnapshotRefs')) break;
      await delay(20);
    }
    assert.equal((await evaluate(snapshotBody({ rootRef: next.nodes[0].ref }))).code, 'STALE_REF');
    assert.equal((await evaluate(typeBody({ ref: next.elements[0].ref, selector: '#email', text: 'wrong' }))).code, 'STALE_REF');
    const old = legacyJSON(page, attributes);
    const bytes = { legacyJSON: Buffer.byteLength(old), compact: Buffer.byteLength(compact) };
    assert.ok(bytes.compact < bytes.legacyJSON);
    t.diagnostic(`UTF-8 bytes ${JSON.stringify(bytes)}; reduction ${((1 - bytes.compact / bytes.legacyJSON) * 100).toFixed(2)}%`);
    try {
      const tokenizer = createRequire(import.meta.url)(process.env.FASTVIBE_TEST_TOKENIZER || 'gpt-tokenizer');
      const tokens = { legacyJSON: tokenizer.encode(old).length, compact: tokenizer.encode(compact).length };
      t.diagnostic(`Tokenizer gpt-tokenizer ${JSON.stringify(tokens)}; reduction ${((1 - tokens.compact / tokens.legacyJSON) * 100).toFixed(2)}%`);
      const scopeTokens = { full: tokens.compact, scoped: tokenizer.encode(formatBrowserSnapshot(scoped)).length };
      assert.ok(scopeTokens.scoped < scopeTokens.full);
      t.diagnostic(`Scope compact tokens ${JSON.stringify(scopeTokens)}; reduction ${((1 - scopeTokens.scoped / scopeTokens.full) * 100).toFixed(2)}%`);
    } catch (error: any) {
      if (error.code !== 'MODULE_NOT_FOUND') throw error;
      t.diagnostic('Tokenizer unavailable; token counts are not estimated. Set FASTVIBE_TEST_TOKENIZER to an installed gpt-tokenizer module.');
    }
  } finally {
    socket?.close(); server.closeAllConnections(); server.close();
    const exited = new Promise(resolve => child.once('exit', resolve)); child.kill();
    await Promise.race([exited, delay(2000)]);
    await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});
