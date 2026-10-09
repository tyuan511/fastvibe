import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, statSync, writeFileSync, existsSync } from "node:fs";
import { createServer, request as httpRequest, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AccountState } from "../src/shared/account.ts";
import { AccountService, authorizeUrl, createPkce } from "../src/main/engine/account.ts";

/**
 * The desktop half of the sign-in, against a stand-in for the site. The "browser" is a
 * function that does what the real one does after the person confirms: follow the
 * redirect to the app's loopback listener with a code.
 */

const USER = { id: "u1", login: "octocat", avatar_url: "https://avatars.example/octocat", email: "o@example.com", role: "user" };

type Cloud = {
  origin: string;
  /** Codes the fake issued, to the challenge they were issued against. */
  codes: Map<string, { challenge: string; redirectUri: string }>;
  calls: string[];
  revoked: string[];
  meStatus: number;
  tokenStatus: number;
  server: Server;
};

async function readJson(req: IncomingMessage): Promise<Record<string, string>> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  return chunks.length ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : {};
}

async function cloud(): Promise<Cloud> {
  const state: Cloud = { origin: "", codes: new Map(), calls: [], revoked: [], meStatus: 200, tokenStatus: 200, server: undefined as never };
  state.server = createServer(async (req, res) => {
    state.calls.push(`${req.method} ${req.url}`);
    const send = (status: number, body: unknown) => res.writeHead(status, { "Content-Type": "application/json" }).end(JSON.stringify(body));
    if (req.url === "/api/oauth/token") {
      const body = await readJson(req);
      const issued = state.codes.get(body.code);
      state.codes.delete(body.code);
      const challenge = createHash("sha256").update(body.code_verifier ?? "").digest("base64url");
      if (state.tokenStatus !== 200) return send(state.tokenStatus, { error: { code: state.tokenStatus === 403 ? "account_disabled" : "invalid_grant" } });
      if (!issued || issued.challenge !== challenge || issued.redirectUri !== body.redirect_uri || body.client_id !== "fastvibe-desktop") {
        return send(400, { error: { code: "invalid_grant" } });
      }
      return send(200, { access_token: "fvs_issued", token_type: "Bearer", expires_in: 7_776_000, user: USER });
    }
    if (req.url === "/api/me") {
      if (req.headers.authorization !== "Bearer fvs_issued") return send(401, { error: { code: "unauthorized" } });
      return state.meStatus === 200 ? send(200, { ...USER, login: "octocat-renamed" }) : send(state.meStatus, {});
    }
    if (req.url === "/api/auth/logout") {
      state.revoked.push(String(req.headers.authorization));
      return res.writeHead(204).end();
    }
    return send(404, {});
  });
  await new Promise<void>((resolve) => state.server.listen(0, "127.0.0.1", resolve));
  state.origin = `http://127.0.0.1:${(state.server.address() as AddressInfo).port}`;
  return state;
}

type Rig = {
  cloud: Cloud;
  file: string;
  service: AccountService;
  states: AccountState[];
  opened: string[];
  signedIn: number;
  /** What the browser does when it is sent to `url`; replaced per test. */
  browse: (url: URL) => Promise<unknown>;
};

async function rig(options: { origin?: string; file?: string; loginTimeoutMs?: number } = {}): Promise<Rig> {
  const c = await cloud();
  const file = options.file ?? join(mkdtempSync(join(tmpdir(), "fastvibe-account-")), "account.json");
  const r: Rig = {
    cloud: c,
    file,
    states: [],
    opened: [],
    signedIn: 0,
    service: undefined as never,
    // Confirm: the site would issue a code against the request's challenge and redirect.
    browse: async (url) => {
      const redirect = url.searchParams.get("redirect_uri")!;
      const code = `code-${c.codes.size + 1}`;
      c.codes.set(code, { challenge: url.searchParams.get("code_challenge")!, redirectUri: redirect });
      return fetch(`${redirect}?code=${code}&state=${encodeURIComponent(url.searchParams.get("state")!)}`);
    },
  };
  r.service = new AccountService({
    file,
    origin: options.origin ?? c.origin,
    platform: "darwin",
    deviceName: () => "Ada's MacBook",
    loginTimeoutMs: options.loginTimeoutMs,
    onChange: (state) => r.states.push(state),
    onSignedIn: () => { r.signedIn += 1; },
    openUrl: (url) => {
      r.opened.push(url);
      // The person takes their time; the callback arrives after login() has returned.
      setTimeout(() => void r.browse(new URL(url)).catch(() => undefined), 5);
    },
  });
  return r;
}

async function settled(r: Rig, status: AccountState["status"]): Promise<AccountState> {
  for (let i = 0; i < 400; i++) {
    const state = r.service.state();
    if (state.status === status) return state;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`never became ${status}; stuck at ${r.service.state().status}`);
}

/** `fetch` will not let a caller choose Host, so speak HTTP directly. */
function statusWithHost(target: URL, host: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const request = httpRequest({ host: target.hostname, port: target.port, path: "/callback?code=x&state=y", headers: { Host: host } }, (res) => {
      res.resume();
      resolve(res.statusCode ?? 0);
    });
    request.on("error", reject);
    request.end();
  });
}

const closeAll = (r: Rig) => r.cloud.server.close();

test("PKCE: the challenge is the S256 of the verifier", () => {
  const { verifier, challenge } = createPkce();
  assert.equal(challenge, createHash("sha256").update(verifier).digest("base64url"));
  assert.match(challenge, /^[A-Za-z0-9_-]{43}$/);
  assert.notEqual(createPkce().verifier, verifier);
});

test("the authorize link names the client, the loopback callback and the challenge", () => {
  const url = new URL(authorizeUrl("https://app.fastvibe.dev", {
    redirectUri: "http://127.0.0.1:5000/callback", state: "s", challenge: "c", deviceName: "Mac", platform: "darwin",
  }));
  assert.equal(url.origin + url.pathname, "https://app.fastvibe.dev/authorize");
  assert.equal(url.searchParams.get("client_id"), "fastvibe-desktop");
  assert.equal(url.searchParams.get("redirect_uri"), "http://127.0.0.1:5000/callback");
  assert.equal(url.searchParams.get("code_challenge_method"), "S256");
});

test("a sign-in goes through the browser, stores a private token, and lifts the app", async () => {
  const r = await rig();
  try {
    const started = await r.service.login();
    assert.equal(started.status, "signing-in");
    assert.equal(r.opened.length, 1);
    const url = new URL(r.opened[0]);
    assert.match(url.searchParams.get("redirect_uri")!, /^http:\/\/127\.0\.0\.1:\d+\/callback$/);
    assert.equal(url.searchParams.get("device_name"), "Ada's MacBook");

    const state = await settled(r, "signed-in");
    assert.equal(state.user?.login, "octocat");
    assert.equal(state.user?.avatarUrl, "https://avatars.example/octocat");
    assert.equal(r.signedIn, 1);
    assert.deepEqual(r.states.map((s) => s.status), ["signing-in", "signed-in"]);

    // The renderer is only ever told who, never the token that proves it.
    assert.equal(JSON.stringify(r.states).includes("fvs_issued"), false);
    const stored = JSON.parse(readFileSync(r.file, "utf8"));
    assert.equal(stored.token, "fvs_issued");
    assert.equal(stored.origin, r.cloud.origin);
    if (process.platform !== "win32") assert.equal(statSync(r.file).mode & 0o777, 0o600);
  } finally { closeAll(r); }
});

test("the browser is told the outcome on the page it is left on", async () => {
  const r = await rig();
  try {
    let page = "";
    r.browse = async (url) => {
      const redirect = url.searchParams.get("redirect_uri")!;
      r.cloud.codes.set("c1", { challenge: url.searchParams.get("code_challenge")!, redirectUri: redirect });
      const response = await fetch(`${redirect}?code=c1&state=${encodeURIComponent(url.searchParams.get("state")!)}`);
      page = await response.text();
      assert.equal(response.headers.get("cache-control"), "no-store");
      assert.match(response.headers.get("content-security-policy") ?? "", /default-src 'none'/);
    };
    await r.service.login();
    await settled(r, "signed-in");
    await new Promise((resolve) => setTimeout(resolve, 30));
    assert.match(page, /FastVibe/);
  } finally { closeAll(r); }
});

test("a callback that does not carry our state is ignored, and the wait goes on", async () => {
  const r = await rig();
  try {
    r.browse = async (url) => {
      const redirect = url.searchParams.get("redirect_uri")!;
      const stray = await fetch(`${redirect}?code=attacker&state=guessed`);
      assert.equal(stray.status, 400);
      r.cloud.codes.set("c1", { challenge: url.searchParams.get("code_challenge")!, redirectUri: redirect });
      await fetch(`${redirect}?code=c1&state=${encodeURIComponent(url.searchParams.get("state")!)}`);
    };
    await r.service.login();
    const state = await settled(r, "signed-in");
    assert.equal(state.user?.login, "octocat");
    assert.equal(r.cloud.calls.filter((c) => c.includes("token")).length, 1, "the stray request must not reach the token endpoint");
  } finally { closeAll(r); }
});

test("only the callback path on the loopback address answers", async () => {
  const r = await rig();
  try {
    let statuses: number[] = [];
    r.browse = async (url) => {
      const redirect = new URL(url.searchParams.get("redirect_uri")!);
      statuses = [
        (await fetch(`${redirect.origin}/`)).status,
        (await fetch(`${redirect.origin}/callback`, { method: "POST" })).status,
        // A page on another name that resolves to us (DNS rebinding) carries its own Host.
        await statusWithHost(redirect, "evil.example"),
      ];
      r.service.cancelLogin();
    };
    await r.service.login();
    await settled(r, "signed-out");
    assert.deepEqual(statuses, [404, 404, 404]);
  } finally { closeAll(r); }
});

test("saying no in the browser ends the wait quietly", async () => {
  const r = await rig();
  try {
    r.browse = async (url) => {
      const redirect = url.searchParams.get("redirect_uri")!;
      await fetch(`${redirect}?error=access_denied&state=${encodeURIComponent(url.searchParams.get("state")!)}`);
    };
    await r.service.login();
    const state = await settled(r, "signed-out");
    assert.equal(state.error, undefined);
    assert.equal(existsSync(r.file), false);
    assert.equal(r.signedIn, 0);
  } finally { closeAll(r); }
});

test("cancelling stops waiting, and a code arriving late is refused", async () => {
  const r = await rig();
  try {
    r.browse = async () => undefined; // the person never comes back
    await r.service.login();
    assert.equal(r.service.cancelLogin().status, "signed-out");
    assert.equal(r.service.state().error, undefined);
    const url = new URL(r.opened[0]);
    const late = await fetch(`${url.searchParams.get("redirect_uri")}?code=late&state=${encodeURIComponent(url.searchParams.get("state")!)}`);
    assert.equal(late.status, 400);
    assert.equal(r.cloud.calls.some((call) => call.includes("/token")), false, "a late code must not be traded");
    assert.equal(r.service.state().status, "signed-out");
  } finally { closeAll(r); }
});

test("a browser that never comes back times out with a reason", async () => {
  const r = await rig({ loginTimeoutMs: 50 });
  try {
    r.browse = async () => undefined;
    await r.service.login();
    const state = await settled(r, "signed-out");
    assert.ok(state.error, "a timeout should say so");
  } finally { closeAll(r); }
});

test("a code the site rejects becomes a message, not a sign-in", async () => {
  const r = await rig();
  try {
    r.cloud.tokenStatus = 400;
    await r.service.login();
    const state = await settled(r, "signed-out");
    assert.ok(state.error);
    assert.equal(existsSync(r.file), false);
    assert.equal(r.signedIn, 0);

    // Trying again clears the old complaint.
    r.cloud.tokenStatus = 200;
    await r.service.login();
    assert.equal(r.service.state().error, undefined);
    await settled(r, "signed-in");
  } finally { closeAll(r); }
});

test("a disabled account is told so", async () => {
  const r = await rig();
  try {
    r.cloud.tokenStatus = 403;
    await r.service.login();
    const state = await settled(r, "signed-out");
    assert.match(state.error ?? "", /停用|disabled/);
  } finally { closeAll(r); }
});

test("a second login while one is waiting does not open a second browser", async () => {
  const r = await rig();
  try {
    r.browse = async () => undefined;
    await r.service.login();
    await r.service.login();
    assert.equal(r.opened.length, 1);
    r.service.cancelLogin();
  } finally { closeAll(r); }
});

test("a browser that cannot be opened ends the attempt with a reason", async () => {
  const r = await rig();
  try {
    const service = new AccountService({
      file: r.file, origin: r.cloud.origin, platform: "darwin", deviceName: () => "x",
      onChange: () => undefined,
      openUrl: () => { throw new Error("no browser"); },
    });
    await service.login();
    for (let i = 0; i < 100 && service.state().status !== "signed-out"; i++) await new Promise((resolve) => setTimeout(resolve, 10));
    assert.equal(service.state().status, "signed-out");
    assert.ok(service.state().error);
  } finally { closeAll(r); }
});

test("a stored sign-in is there at launch, without asking the network", async () => {
  const r = await rig();
  try {
    await r.service.login();
    await settled(r, "signed-in");
    const again = new AccountService({
      file: r.file, origin: r.cloud.origin, platform: "darwin", deviceName: () => "x",
      onChange: () => undefined, openUrl: () => undefined,
      fetch: () => Promise.reject(new Error("offline")),
    });
    assert.equal(again.state().status, "signed-in");
    assert.equal(again.state().user?.login, "octocat");
    // Offline at launch is not a reason to sign anyone out.
    assert.equal((await again.refresh()).status, "signed-in");
  } finally { closeAll(r); }
});

test("a token is only ever sent to the site that issued it", async () => {
  const r = await rig();
  try {
    await r.service.login();
    await settled(r, "signed-in");
    const sent: string[] = [];
    const elsewhere = new AccountService({
      file: r.file, origin: "https://other.example", platform: "darwin", deviceName: () => "x",
      onChange: () => undefined, openUrl: () => undefined,
      fetch: (input) => { sent.push(String(input)); return Promise.reject(new Error("blocked")); },
    });
    assert.equal(elsewhere.state().status, "signed-out");
    await elsewhere.refresh();
    await elsewhere.logout();
    assert.deepEqual(sent, []);
    // …and signing out of the other site did not throw away this one's sign-in.
    assert.equal(JSON.parse(readFileSync(r.file, "utf8")).token, "fvs_issued");
  } finally { closeAll(r); }
});

test("refresh picks up a renamed account", async () => {
  const r = await rig();
  try {
    await r.service.login();
    await settled(r, "signed-in");
    const state = await r.service.refresh();
    assert.equal(state.user?.login, "octocat-renamed");
    assert.equal(JSON.parse(readFileSync(r.file, "utf8")).user.login, "octocat-renamed");
  } finally { closeAll(r); }
});

test("refresh drops a token the site no longer accepts", async () => {
  const r = await rig();
  try {
    await r.service.login();
    await settled(r, "signed-in");
    writeFileSync(r.file, JSON.stringify({ ...JSON.parse(readFileSync(r.file, "utf8")), token: "fvs_revoked" }));
    const revoked = new AccountService({
      file: r.file, origin: r.cloud.origin, platform: "darwin", deviceName: () => "x",
      onChange: (s) => r.states.push(s), openUrl: () => undefined,
    });
    assert.equal(revoked.state().status, "signed-in");
    assert.equal((await revoked.refresh()).status, "signed-out");
    assert.equal(existsSync(r.file), false);
  } finally { closeAll(r); }
});

test("a server error during refresh leaves the sign-in alone", async () => {
  const r = await rig();
  try {
    await r.service.login();
    await settled(r, "signed-in");
    r.cloud.meStatus = 503;
    assert.equal((await r.service.refresh()).status, "signed-in");
    assert.equal(existsSync(r.file), true);
  } finally { closeAll(r); }
});

test("logout forgets the token here and revokes it on the site", async () => {
  const r = await rig();
  try {
    await r.service.login();
    await settled(r, "signed-in");
    const state = await r.service.logout();
    assert.equal(state.status, "signed-out");
    assert.equal(existsSync(r.file), false);
    assert.deepEqual(r.cloud.revoked, ["Bearer fvs_issued"]);
    assert.equal(r.states.at(-1)?.status, "signed-out");
  } finally { closeAll(r); }
});

test("logout still signs out locally when the site cannot be reached", async () => {
  const r = await rig();
  try {
    await r.service.login();
    await settled(r, "signed-in");
    const offline = new AccountService({
      file: r.file, origin: r.cloud.origin, platform: "darwin", deviceName: () => "x",
      onChange: () => undefined, openUrl: () => undefined,
      fetch: () => Promise.reject(new Error("offline")),
    });
    assert.equal((await offline.logout()).status, "signed-out");
    assert.equal(existsSync(r.file), false);
  } finally { closeAll(r); }
});

test("a damaged account file is a signed-out app, not a crash", async () => {
  const r = await rig({ file: join(mkdtempSync(join(tmpdir(), "fastvibe-account-")), "account.json") });
  try {
    writeFileSync(r.file, "{not json");
    const service = new AccountService({
      file: r.file, origin: r.cloud.origin, platform: "darwin", deviceName: () => "x",
      onChange: () => undefined, openUrl: () => undefined,
    });
    assert.equal(service.state().status, "signed-out");
  } finally { closeAll(r); }
});
