import assert from "node:assert/strict";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { mkdtempSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import test from "node:test";
import type { GithubAppManifestConversion } from "../src/main/bot/shadow/github-app-auth.ts";
import { beginGithubAppSetup, loadGithubAppCredential, organizationRegistrationAction, saveGithubAppCredential } from "../src/main/bot/shadow/github-app-setup.ts";

const CONVERSION: GithubAppManifestConversion = {
  appId: 4242,
  slug: "vivi-test-app",
  htmlUrl: "https://github.com/apps/vivi-test-app",
  pem: "-----BEGIN RSA PRIVATE KEY-----\nfixture\n-----END RSA PRIVATE KEY-----",
  webhookSecret: null,
  clientId: "Iv1.client",
  clientSecret: "client-secret",
};

async function conversions(t: test.TestContext, options: { fail?: boolean } = {}) {
  const codes: string[] = [];
  const server: Server = await new Promise(resolve => {
    const s = createServer((req: IncomingMessage, res: ServerResponse) => {
      const url = new URL(req.url ?? "/", "http://127.0.0.1");
      if (req.method === "POST" && /^\/app-manifests\/[^/]+\/conversions$/.test(url.pathname)) {
        const code = url.pathname.split("/")[2]!;
        codes.push(code);
        if (options.fail) { res.writeHead(404, { "Content-Type": "application/json" }); return void res.end(JSON.stringify({ message: "Not Found" })); }
        res.writeHead(201, { "Content-Type": "application/json" });
        return void res.end(JSON.stringify({ id: CONVERSION.appId, slug: CONVERSION.slug, html_url: CONVERSION.htmlUrl, pem: CONVERSION.pem, webhook_secret: null, client_id: CONVERSION.clientId, client_secret: CONVERSION.clientSecret }));
      }
      res.writeHead(404); res.end();
    });
    s.listen(0, "127.0.0.1", () => resolve(s));
  });
  t.after(() => server.close());
  return { origin: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, codes };
}

const manifest = { name: "Vivi Reviewer", homepage: "https://fastvibe.app", permissions: { pull_requests: "write", checks: "read", contents: "read" } };
const pending = (promise: Promise<unknown>, ms = 40): Promise<string> => Promise.race([Promise.resolve(promise).then(() => "settled", () => "settled"), new Promise(resolve => setTimeout(() => resolve("pending"), ms))]);

test("manifest 安装流：redirect_url 由回调端口生成，错误 state 与缺失 code 不触发交换", async t => {
  const f = await conversions(t);
  const handle = await beginGithubAppSetup({ manifest, expectedState: "state-1", origin: f.origin, loopbackTest: true });
  assert.match(handle.callbackUrl, /^http:\/\/127\.0\.0\.1:\d+\/callback$/);
  const form = JSON.parse(handle.registration.manifest) as Record<string, unknown>;
  assert.equal(form.redirect_url, handle.callbackUrl);
  assert.deepEqual(form.default_permissions, manifest.permissions);
  assert.equal(form.public, false);
  assert.equal(form.setup_url, undefined);
  assert.equal(handle.registration.action, "https://github.com/settings/apps/new");
  assert.equal(handle.registration.state, "state-1");

  const wrong = await fetch(`${handle.callbackUrl}?code=code-ok&state=wrong`);
  assert.equal(wrong.status, 403);
  assert.equal(await pending(handle.completed), "pending");
  const missing = await fetch(`${handle.callbackUrl}?state=state-1`);
  assert.equal(missing.status, 400);
  assert.equal(await pending(handle.completed), "pending");
  assert.deepEqual(f.codes, []);

  const right = await fetch(`${handle.callbackUrl}?code=code-ok&state=state-1`);
  assert.equal(right.status, 200);
  assert.match(await right.text(), /已收到/);
  const conversion = await handle.completed;
  assert.equal(conversion.appId, CONVERSION.appId);
  assert.equal(conversion.pem, CONVERSION.pem);
  assert.deepEqual(f.codes, ["code-ok"]);
});

test("manifest 安装流：超时与取消都以明确错误结束", async t => {
  const f = await conversions(t);
  const timeout = await beginGithubAppSetup({ manifest, origin: f.origin, loopbackTest: true, timeoutMs: 40 });
  await assert.rejects(() => timeout.completed, /超时/);
  const cancelled = await beginGithubAppSetup({ manifest, origin: f.origin, loopbackTest: true });
  cancelled.cancel();
  await assert.rejects(() => cancelled.completed, /取消/);
  cancelled.cancel();
  assert.equal(await pending(cancelled.completed), "settled");
});

test("manifest 安装流：转换失败在 completed 上拒绝且错误明确", async t => {
  const f = await conversions(t, { fail: true });
  const handle = await beginGithubAppSetup({ manifest, expectedState: "s", origin: f.origin, loopbackTest: true });
  const response = await fetch(`${handle.callbackUrl}?code=deadbeef&state=s`);
  assert.equal(response.status, 200);
  await assert.rejects(() => handle.completed, /无效或已超过一小时/);
});

test("回调路径与组织注册入口校验", async t => {
  const f = await conversions(t);
  await assert.rejects(() => beginGithubAppSetup({ manifest, origin: f.origin, loopbackTest: true, callbackPath: "callback" }), /回调路径无效/);
  assert.equal(organizationRegistrationAction("acme"), "https://github.com/organizations/acme/settings/apps/new");
  assert.throws(() => organizationRegistrationAction("ac me!"), /组织名/);
});

test("GitHub App 凭据文件：0600 原子写入、往返读取、损坏拒绝", async t => {
  const f = await conversions(t);
  const handle = await beginGithubAppSetup({ manifest, expectedState: "s", origin: f.origin, loopbackTest: true });
  const conversion = await (async () => { const response = await fetch(`${handle.callbackUrl}?code=code-ok&state=s`); assert.equal(response.status, 200); return handle.completed; })();
  const dir = mkdtempSync(join(tmpdir(), "vivi-github-app-"));
  const file = join(dir, "github-app.json");
  saveGithubAppCredential(file, { ...conversion, createdAt: new Date().toISOString() });
  assert.equal(statSync(file).mode & 0o777, 0o600);
  const loaded = loadGithubAppCredential(file)!;
  assert.equal(loaded.appId, conversion.appId);
  assert.equal(loaded.slug, conversion.slug);
  assert.equal(loaded.pem, conversion.pem);
  assert.equal(loaded.installationId, undefined);

  saveGithubAppCredential(file, { ...loaded, installationId: 77 });
  assert.equal(loadGithubAppCredential(file)!.installationId, 77);

  assert.equal(loadGithubAppCredential(join(dir, "missing.json")), undefined);
  writeFileSync(file, "not json");
  assert.throws(() => loadGithubAppCredential(file), /凭据文件无效/);
  assert.throws(() => saveGithubAppCredential(file, { ...conversion, appId: 0, createdAt: new Date().toISOString() }), /凭据记录无效/);
});
