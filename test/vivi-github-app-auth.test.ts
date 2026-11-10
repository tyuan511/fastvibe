import assert from "node:assert/strict";
import { createVerify, generateKeyPairSync } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import test from "node:test";
import { buildAppManifest, convertManifestCode, createAppJwt, GithubAppInstallationCredentials, listInstallations, resolveAppPrincipal } from "../src/main/bot/shadow/github-app-auth.ts";
import { ShadowCredentialHost } from "../src/main/bot/shadow/credential-host.ts";
import { ShadowSourceRegistry } from "../src/main/bot/shadow/source-registry.ts";
import { openShadowStore } from "../src/main/bot/shadow/store.ts";

const APP_ID = 4242;
const INSTALLATION_ID = 77;
const SLUG = "vivi-test-app";
const BOT_LOGIN = `${SLUG}[bot]`;
const BOT_USER_ID = "9876543";

const { publicKey, privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const pem = privateKey.export({ type: "pkcs8", format: "pem" }).toString();

interface Recorded {
  method: string; path: string; hasAuth: boolean; claims?: { iss?: string; iat?: number; exp?: number };
  signatureVerified: boolean; body?: unknown;
}

async function fixture(t: test.TestContext, mutate: { appId?: number; failMint?: boolean; failManifest?: boolean } = {}) {
  const requests: Recorded[] = [];
  let mints = 0;
  let nowMs = 1_700_000_000_000;
  const verify = (header: string | undefined): Recorded["claims"] & { ok: boolean } => {
    const token = header?.startsWith("Bearer ") ? header.slice(7) : undefined;
    if (!token) return { ok: false };
    const [head, claims, signature] = token.split(".");
    assert.ok(head && claims && signature, "JWT must have three segments");
    const ok = createVerify("RSA-SHA256").update(`${head}.${claims}`).verify(publicKey.export({ type: "spki", format: "pem" }), Buffer.from(signature, "base64url"));
    return { ok, ...JSON.parse(Buffer.from(claims, "base64url").toString("utf8")) as Recorded["claims"] };
  };
  const server: Server = await new Promise(resolve => {
    const s = createServer((req: IncomingMessage, res: ServerResponse) => {
      const chunks: Buffer[] = [];
      req.on("data", chunk => chunks.push(chunk));
      req.on("end", () => {
        const url = new URL(req.url ?? "/", "http://127.0.0.1");
        const auth = verify(req.headers.authorization);
        const record: Recorded = { method: req.method ?? "", path: url.pathname, hasAuth: !!req.headers.authorization, claims: auth.iss === undefined ? undefined : { iss: auth.iss, iat: auth.iat, exp: auth.exp }, signatureVerified: auth.ok, body: chunks.length ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : undefined };
        requests.push(record);
        const json = (status: number, body: unknown): void => { res.writeHead(status, { "Content-Type": "application/json" }); res.end(JSON.stringify(body)); };
        if (req.method === "POST" && /^\/app-manifests\/[^/]+\/conversions$/.test(url.pathname)) {
          if (mutate.failManifest) return json(404, { message: "Not Found" });
          return json(201, { id: APP_ID, slug: SLUG, html_url: `https://github.com/apps/${SLUG}`, pem, webhook_secret: null, client_id: "Iv1.client", client_secret: "client-secret" });
        }
        if (req.method === "GET" && url.pathname === "/app") {
          if (!auth.ok || auth.iss !== String(APP_ID)) return json(401, { message: "Bad credentials" });
          return json(200, { id: mutate.appId ?? APP_ID, slug: SLUG, name: "Vivi Test" });
        }
        if (req.method === "GET" && url.pathname === "/app/installations") {
          if (!auth.ok || auth.iss !== String(APP_ID)) return json(401, { message: "Bad credentials" });
          return json(200, [{ id: INSTALLATION_ID, account: { id: 1, login: "tyuan511" }, repository_selection: "selected", app_slug: SLUG, html_url: "https://github.com/settings/installations/77" }]);
        }
        if (req.method === "GET" && url.pathname === `/users/${encodeURIComponent(BOT_LOGIN)}`) {
          return json(200, { id: Number(BOT_USER_ID), login: BOT_LOGIN, type: "Bot" });
        }
        if (req.method === "POST" && url.pathname === `/app/installations/${INSTALLATION_ID}/access_tokens`) {
          if (!auth.ok || auth.iss !== String(APP_ID)) return json(401, { message: "Bad credentials" });
          if (mutate.failMint) return json(401, { message: "Bad credentials" });
          mints += 1;
          return json(201, { token: `vivi_token_${mints}_${"a".repeat(30)}`, expires_at: new Date(nowMs + 3_600_000).toISOString(), permissions: { pull_requests: "write" } });
        }
        json(404, { message: "Not Found" });
      });
    });
    s.listen(0, "127.0.0.1", () => resolve(s));
  });
  t.after(() => server.close());
  const port = (server.address() as AddressInfo).port;
  const http = { origin: `http://127.0.0.1:${port}`, loopbackTest: true } as const;
  return { requests, http, mints: () => mints, now: () => nowMs, advance: (ms: number) => { nowMs += ms; } };
}

test("createAppJwt 生成可用公钥验证的 RS256 JWT，且有效期不超过 10 分钟", () => {  const now = 1_700_000_000_000;
  const jwt = createAppJwt(APP_ID, pem, now);
  const [head, claims, signature] = jwt.split(".");
  assert.equal(Buffer.from(head, "base64url").toString("utf8"), JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const payload = JSON.parse(Buffer.from(claims, "base64url").toString("utf8")) as { iss: string; iat: number; exp: number };
  assert.equal(payload.iss, String(APP_ID));
  assert.equal(payload.exp - payload.iat, 540);
  assert.ok(createVerify("RSA-SHA256").update(`${head}.${claims}`).verify(publicKey.export({ type: "spki", format: "pem" }), Buffer.from(signature, "base64url")));
  assert.throws(() => createAppJwt(0, pem, now), /App ID/);
  assert.throws(() => createAppJwt(APP_ID, "not a key", now), /私钥/);
});

test("convertManifestCode 无认证换取 App 配置，数值 id 与可空 webhook secret 正确解析", async t => {
  const f = await fixture(t);
  const conversion = await convertManifestCode({ code: "a180b1a3d263c81bc6441d7b990bae27d4c10679", ...f.http });
  assert.equal(conversion.appId, APP_ID);
  assert.equal(conversion.slug, SLUG);
  assert.equal(conversion.pem, pem);
  assert.equal(conversion.webhookSecret, null);
  assert.equal(conversion.clientId, "Iv1.client");
  assert.equal(conversion.clientSecret, "client-secret");
  const request = f.requests[0]!;
  assert.equal(request.method, "POST");
  assert.equal(request.path, "/app-manifests/a180b1a3d263c81bc6441d7b990bae27d4c10679/conversions");
  assert.equal(request.hasAuth, false);
});

test("convertManifestCode 对无效或过期 code 明确拒绝", async t => {
  const f = await fixture(t, { failManifest: true });
  await assert.rejects(() => convertManifestCode({ code: "deadbeef", ...f.http }), /无效或已超过一小时/);
});

test("resolveAppPrincipal 在 mint 时校验私钥归属并发现 bot 账号", async t => {
  const f = await fixture(t);
  const identity = await resolveAppPrincipal({ appId: APP_ID, privateKeyPem: pem, expectedSlug: SLUG, ...f.http });
  assert.equal(identity.appId, APP_ID);
  assert.equal(identity.slug, SLUG);
  assert.equal(identity.botLogin, BOT_LOGIN);
  assert.equal(identity.botUserId, BOT_USER_ID);
  const app = f.requests.find(request => request.path === "/app")!;
  assert.ok(app.signatureVerified);
  assert.equal(app.claims?.iss, String(APP_ID));
  assert.equal(f.requests.find(request => request.path === `/users/${encodeURIComponent(BOT_LOGIN)}`)?.method, "GET");
});

test("resolveAppPrincipal 拒绝不匹配的 App ID 与 slug", async t => {
  const mismatch = await fixture(t, { appId: 9999 });
  await assert.rejects(() => resolveAppPrincipal({ appId: APP_ID, privateKeyPem: pem, ...mismatch.http }), /私钥与 App ID 不匹配/);
  const f = await fixture(t);
  await assert.rejects(() => resolveAppPrincipal({ appId: APP_ID, privateKeyPem: pem, expectedSlug: "other-app", ...f.http }), /slug 不匹配/);
});

test("installation credentials 用验证过的 JWT mint，仓库范围进入请求体，缓存避免重复 mint", async t => {
  const f = await fixture(t);
  const credentials = new GithubAppInstallationCredentials({ appId: APP_ID, privateKeyPem: pem, installationId: INSTALLATION_ID, repositories: ["vivi-test"], expectedSlug: SLUG, now: f.now, ...f.http });
  const first = await Promise.all([credentials.resolve({ id: "ref" }, "purpose"), credentials.resolve({ id: "ref" }, "purpose"), credentials.resolve({ id: "ref" }, "purpose")]);
  assert.equal(new Set(first).size, 1);
  assert.equal(f.mints(), 1);
  const mint = f.requests.find(request => request.path === `/app/installations/${INSTALLATION_ID}/access_tokens`)!;
  assert.ok(mint.signatureVerified);
  assert.equal(mint.claims?.iss, String(APP_ID));
  assert.deepEqual(mint.body, { repositories: ["vivi-test"] });
  const again = await credentials.resolve({ id: "ref" }, "purpose");
  assert.equal(again, first[0]);
  assert.equal(f.mints(), 1);
});

test("installation token 在过期前 5 分钟 margin 重新 mint", async t => {
  const f = await fixture(t);
  const credentials = new GithubAppInstallationCredentials({ appId: APP_ID, privateKeyPem: pem, installationId: INSTALLATION_ID, now: f.now, ...f.http });
  const first = await credentials.resolve({ id: "ref" }, "purpose");
  f.advance(3_600_000 - 5 * 60_000 + 1);
  const second = await credentials.resolve({ id: "ref" }, "purpose");
  assert.equal(f.mints(), 2);
  assert.notEqual(first, second);
});

test("mint 失败时明确拒绝、不缓存，下一次 resolve 重新尝试", async t => {
  const f = await fixture(t, { failMint: true });
  const credentials = new GithubAppInstallationCredentials({ appId: APP_ID, privateKeyPem: pem, installationId: INSTALLATION_ID, now: f.now, ...f.http });
  await assert.rejects(() => credentials.resolve({ id: "ref" }, "purpose"), /401/);
});

test("credentials 可直接作为 ShadowCredentialHost 的 resolver 绑定使用", async t => {
  const f = await fixture(t);
  const store = openShadowStore(":memory:");
  const registry = new ShadowSourceRegistry(store);
  registry.register({ kind: "github-review", validate: value => value as Record<string, unknown> });
  registry.configure("github-review", { enabled: true, config: {} });
  const host = new ShadowCredentialHost(registry);
  const credentials = new GithubAppInstallationCredentials({ appId: APP_ID, privateKeyPem: pem, installationId: INSTALLATION_ID, now: f.now, ...f.http });
  host.register({ id: "github-app.installation", kind: "github-app" }, credentials);
  host.bind("github-review", { id: "github-app.installation", kind: "github-app" });
  const secret = await host.withSourceCredential("github-review", "github-rest:POST", async value => value);
  assert.equal(typeof secret, "string");
  assert.match(String(secret), /^vivi_token_1_/);
});

test("origin 门禁：非显式 loopback 的 http origin 与仿冒域名在发请求前直接拒绝", async () => {
  const loopbackRejected = new GithubAppInstallationCredentials({ appId: APP_ID, privateKeyPem: pem, installationId: INSTALLATION_ID, origin: "http://127.0.0.1:1" });
  await assert.rejects(() => loopbackRejected.resolve({ id: "ref" }, "purpose"), /只允许 api\.github\.com 或显式 loopback/);
  const foreignRejected = new GithubAppInstallationCredentials({ appId: APP_ID, privateKeyPem: pem, installationId: INSTALLATION_ID, origin: "http://github.example.com", loopbackTest: true });
  await assert.rejects(() => foreignRejected.resolve({ id: "ref" }, "purpose"), /只允许 api\.github\.com 或显式 loopback/);
  const lookalikeRejected = new GithubAppInstallationCredentials({ appId: APP_ID, privateKeyPem: pem, installationId: INSTALLATION_ID, origin: "https://api.github.com.evil.com" });
  await assert.rejects(() => lookalikeRejected.resolve({ id: "ref" }, "purpose"), /只允许 api\.github\.com 或显式 loopback/);
});

test("buildAppManifest 生成表单 manifest 并严格校验输入", () => {
  const base = { name: "Vivi Reviewer", homepage: "https://fastvibe.app", redirectUrl: "http://127.0.0.1:1234/callback", permissions: { pull_requests: "write" } } as const;
  assert.deepEqual(buildAppManifest(base), { name: "Vivi Reviewer", url: "https://fastvibe.app", redirect_url: "http://127.0.0.1:1234/callback", default_permissions: { pull_requests: "write" }, public: false });
  assert.deepEqual(buildAppManifest({ ...base, permissions: { issues: "read" }, setupUrl: "https://fastvibe.app/setup", events: ["pull_request_review"], isPublic: true }),
    { name: "Vivi Reviewer", url: "https://fastvibe.app", redirect_url: "http://127.0.0.1:1234/callback", setup_url: "https://fastvibe.app/setup", default_permissions: { issues: "read" }, default_events: ["pull_request_review"], public: true });
  assert.throws(() => buildAppManifest({ ...base, name: " " }), /name/);
  assert.throws(() => buildAppManifest({ ...base, homepage: "ftp://example.com" }), /homepage/);
  assert.throws(() => buildAppManifest({ ...base, redirectUrl: "notaurl" }), /redirectUrl/);
  assert.throws(() => buildAppManifest({ ...base, setupUrl: "file:///tmp" }), /setupUrl/);
  assert.throws(() => buildAppManifest({ ...base, permissions: {} }), /permissions/);
  assert.throws(() => buildAppManifest({ ...base, permissions: { pull_requests: "maybe" as never } }), /permissions/);
  assert.throws(() => buildAppManifest({ ...base, events: [""] }), /events/);
});

test("listInstallations 返回窄视图并验证 JWT", async t => {
  const f = await fixture(t);
  const installations = await listInstallations({ appId: APP_ID, privateKeyPem: pem, ...f.http });
  assert.equal(installations.length, 1);
  assert.equal(installations[0]!.installationId, INSTALLATION_ID);
  assert.equal(installations[0]!.accountLogin, "tyuan511");
  assert.equal(installations[0]!.repositorySelection, "selected");
  assert.equal(installations[0]!.appSlug, SLUG);
  const request = f.requests.find(row => row.path.startsWith("/app/installations"));
  assert.ok(request?.signatureVerified);
  assert.equal(request?.claims?.iss, String(APP_ID));
});
