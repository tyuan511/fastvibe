import { createHash, randomBytes } from "node:crypto";
import { chmodSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server, type ServerResponse } from "node:http";
import { dirname } from "node:path";
import type { AddressInfo } from "node:net";
import type { AccountState, AccountUser } from "@shared/account";
import { uiText } from "./ui-text.ts";

/**
 * Sign-in to the FastVibe account: the browser authorization-code flow for native apps
 * (RFC 8252) with PKCE (RFC 7636), against `app.fastvibe.dev`.
 *
 *   1. A listener opens on `127.0.0.1:<free port>/callback` and the system browser is
 *      sent to the site's `/authorize` page with a PKCE challenge and a random `state`.
 *   2. The person signs in with GitHub there (or already is) and confirms.
 *   3. The site redirects the browser to the listener with a one-time `code`.
 *   4. This module checks `state`, trades `code` + the PKCE verifier for a device token,
 *      and stores it. The verifier never leaves this process, so another program that
 *      saw the redirect holds a code it cannot use.
 *
 * No Electron in here, so it runs under `node --test`: opening the browser, telling the
 * UI and lifting the window are all handed in.
 */

const CLIENT_ID = "fastvibe-desktop";
const CALLBACK_PATH = "/callback";
const FILE_VERSION = 1;
/** How long the browser has to come back. The site's own code is good for five minutes. */
const LOGIN_TIMEOUT_MS = 5 * 60 * 1000;
const REQUEST_TIMEOUT_MS = 15_000;

export type AccountDeps = {
  /** Where the token and the signed-in user are kept (0600). */
  file: string;
  /** The site, e.g. `https://app.fastvibe.dev`, no trailing slash. */
  origin: string;
  /** Open `url` in the system browser. */
  openUrl: (url: string) => Promise<void> | void;
  /** The state changed; push it to the windows. */
  onChange: (state: AccountState) => void;
  /** A sign-in just completed: the person is in a browser, bring the app back to them. */
  onSignedIn?: () => void;
  /** What the sign-in list on the site will call this device. */
  deviceName: () => string;
  platform: string;
  fetch?: typeof fetch;
  loginTimeoutMs?: number;
  log?: (message: string) => void;
};

type StoredAccount = {
  version: number;
  /** The site the token was issued by; it is never sent anywhere else. */
  origin: string;
  token: string;
  user: AccountUser;
};

type Attempt = {
  cancel: () => void;
};

/** Raised for failures a person should be told about, in words they can read. */
class LoginError extends Error {}

export function createPkce(): { verifier: string; challenge: string } {
  const verifier = randomBytes(32).toString("base64url");
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  return { verifier, challenge };
}

export function authorizeUrl(
  origin: string,
  request: { redirectUri: string; state: string; challenge: string; deviceName: string; platform: string },
): string {
  const url = new URL("/authorize", origin);
  url.searchParams.set("client_id", CLIENT_ID);
  url.searchParams.set("redirect_uri", request.redirectUri);
  url.searchParams.set("state", request.state);
  url.searchParams.set("code_challenge", request.challenge);
  url.searchParams.set("code_challenge_method", "S256");
  url.searchParams.set("device_name", request.deviceName.slice(0, 80));
  url.searchParams.set("platform", request.platform);
  return url.toString();
}

export class AccountService {
  #deps: AccountDeps;
  #fetch: typeof fetch;
  #stored: StoredAccount | null;
  #attempt: Attempt | null = null;
  #error: string | undefined;
  #listeners = new Set<() => void>();

  constructor(deps: AccountDeps) {
    this.#deps = deps;
    this.#fetch = deps.fetch ?? fetch;
    this.#stored = this.#read();
  }

  /**
   * The token that proves who is signed in, for Main's own requests to the site. It is
   * never part of `state()`: the renderer is told who, not the credential.
   */
  token(): string | null {
    return this.#stored?.token ?? null;
  }

  /** The site the token belongs to. */
  origin(): string {
    return this.#deps.origin;
  }

  /** Run `listener` whenever the signed-in account changes. Returns the unsubscribe. */
  subscribe(listener: () => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  state(): AccountState {
    const base = { origin: this.#deps.origin };
    if (this.#attempt) return { ...base, status: "signing-in" };
    if (this.#stored) return { ...base, status: "signed-in", user: this.#stored.user };
    return { ...base, status: "signed-out", ...(this.#error ? { error: this.#error } : {}) };
  }

  /**
   * Start a sign-in. Returns once the browser has been asked to open — the person
   * finishes elsewhere, and the outcome arrives through `onChange`.
   */
  async login(): Promise<AccountState> {
    if (this.#attempt) return this.state();
    this.#error = undefined;
    const pkce = createPkce();
    const state = randomBytes(24).toString("base64url");

    let listener: Listener;
    try {
      listener = await listen(state, this.#deps.loginTimeoutMs ?? LOGIN_TIMEOUT_MS);
    } catch (error) {
      this.#error = describe(error);
      this.#emit();
      return this.state();
    }
    const attempt: Attempt = { cancel: listener.cancel };
    this.#attempt = attempt;
    this.#emit();

    void this.#complete(attempt, listener, pkce.verifier);

    try {
      await this.#deps.openUrl(
        authorizeUrl(this.#deps.origin, {
          redirectUri: listener.redirectUri,
          state,
          challenge: pkce.challenge,
          deviceName: this.#deps.deviceName(),
          platform: this.#deps.platform,
        }),
      );
    } catch (error) {
      this.#deps.log?.(`account: could not open the browser: ${String(error)}`);
      listener.fail(new LoginError(uiText("无法打开浏览器，请重试", "Couldn't open the browser. Try again.")));
    }
    return this.state();
  }

  /** Stop waiting for the browser. Not an error: the person changed their mind. */
  cancelLogin(): AccountState {
    const attempt = this.#attempt;
    if (!attempt) return this.state();
    // Settle the state now rather than when the listener notices: the caller reads it next.
    this.#attempt = null;
    this.#error = undefined;
    attempt.cancel();
    this.#emit();
    return this.state();
  }

  async logout(): Promise<AccountState> {
    this.cancelLogin();
    const stored = this.#stored;
    this.#stored = null;
    this.#error = undefined;
    // Only a sign-in this app owns is this call's to delete: a file written for another
    // site (see `#read`) is somebody else's credential.
    if (stored) rmSync(this.#deps.file, { force: true });
    this.#emit();
    // The device is signed out here whatever happens next; telling the server is what makes
    // the token stop working elsewhere, so a failure only leaves it to expire on its own.
    if (stored) {
      await this.#call("/api/auth/logout", { method: "POST", token: stored.token }).catch((error: unknown) => {
        this.#deps.log?.(`account: could not revoke the device token: ${String(error)}`);
      });
    }
    return this.state();
  }

  /**
   * Check the stored token and refresh who it belongs to. A token the server rejects is
   * dropped; one it could not be asked about (offline) is kept, because being signed in
   * should not depend on being online.
   */
  async refresh(): Promise<AccountState> {
    const stored = this.#stored;
    if (!stored) return this.state();
    try {
      const response = await this.#call("/api/me", { token: stored.token });
      if (response.status === 401) {
        if (this.#stored === stored) {
          this.#stored = null;
          rmSync(this.#deps.file, { force: true });
          this.#emit();
        }
        return this.state();
      }
      if (!response.ok) return this.state();
      const user = toUser(await response.json());
      if (user && this.#stored === stored) {
        this.#stored = { ...stored, user };
        this.#write(this.#stored);
        this.#emit();
      }
    } catch (error) {
      this.#deps.log?.(`account: refresh failed: ${String(error)}`);
    }
    return this.state();
  }

  async #complete(attempt: Attempt, listener: Listener, verifier: string): Promise<void> {
    try {
      const { code, redirectUri } = await listener.code;
      const stored = await this.#exchange(code, redirectUri, verifier);
      if (this.#attempt !== attempt) {
        // Cancelled while the code was being traded: the device session the site just
        // opened would sit unused in the person's device list, so close it again.
        listener.respond(false);
        await this.#call("/api/auth/logout", { method: "POST", token: stored.token }).catch(() => undefined);
        return;
      }
      this.#stored = stored;
      this.#write(stored);
      this.#attempt = null;
      this.#emit();
      listener.respond(true);
      this.#deps.onSignedIn?.();
    } catch (error) {
      const cancelled = error instanceof CancelledLogin;
      if (!cancelled) this.#deps.log?.(`account: sign-in failed: ${String(error)}`);
      // Backing out is not a failure worth a red line. A newer attempt owns the state now.
      if (this.#attempt === attempt) {
        this.#attempt = null;
        this.#error = cancelled ? undefined : describe(error);
        this.#emit();
      }
      listener.respond(false, cancelled ? undefined : describe(error));
    } finally {
      listener.close();
    }
  }

  async #exchange(code: string, redirectUri: string, verifier: string): Promise<StoredAccount> {
    const response = await this.#call("/api/oauth/token", {
      method: "POST",
      body: {
        grant_type: "authorization_code",
        code,
        code_verifier: verifier,
        client_id: CLIENT_ID,
        redirect_uri: redirectUri,
      },
    }).catch(() => {
      throw new LoginError(uiText("无法连接 FastVibe 服务，请检查网络", "Couldn't reach FastVibe. Check your connection."));
    });
    const body: unknown = await response.json().catch(() => undefined);
    if (!response.ok) {
      const errorCode = (body as { error?: { code?: unknown } } | undefined)?.error?.code;
      if (errorCode === "account_disabled") {
        throw new LoginError(uiText("该账号已被停用", "This account has been disabled."));
      }
      if (errorCode === "invalid_grant") {
        throw new LoginError(uiText("登录已过期，请重新登录", "The sign-in expired. Try again."));
      }
      throw new LoginError(uiText("登录没有成功，请重试", "Sign-in didn't go through. Try again."));
    }
    const token = (body as { access_token?: unknown } | undefined)?.access_token;
    const user = toUser((body as { user?: unknown } | undefined)?.user);
    if (typeof token !== "string" || !token || !user) {
      throw new LoginError(uiText("服务返回了无法识别的内容", "The server sent an unexpected reply."));
    }
    return { version: FILE_VERSION, origin: this.#deps.origin, token, user };
  }

  async #call(
    path: string,
    options: { method?: string; token?: string; body?: unknown },
  ): Promise<Response> {
    const headers: Record<string, string> = { Accept: "application/json" };
    if (options.token) headers.Authorization = `Bearer ${options.token}`;
    if (options.body !== undefined) headers["Content-Type"] = "application/json";
    return this.#fetch(new URL(path, this.#deps.origin), {
      method: options.method ?? "GET",
      headers,
      body: options.body === undefined ? undefined : JSON.stringify(options.body),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      redirect: "error",
    });
  }

  #emit(): void {
    this.#deps.onChange(this.state());
    for (const listener of [...this.#listeners]) listener();
  }

  #read(): StoredAccount | null {
    try {
      const parsed = JSON.parse(readFileSync(this.#deps.file, "utf8")) as Partial<StoredAccount>;
      const user = toUser(parsed.user);
      // A token goes only to the site that issued it. Pointing the app at another
      // server (a local one while developing) must not carry the real credential there.
      if (parsed.version !== FILE_VERSION || typeof parsed.token !== "string" || !parsed.token || !user) return null;
      if (parsed.origin !== this.#deps.origin) return null;
      return { version: FILE_VERSION, origin: parsed.origin, token: parsed.token, user };
    } catch {
      return null;
    }
  }

  #write(stored: StoredAccount): void {
    mkdirSync(dirname(this.#deps.file), { recursive: true });
    const temp = `${this.#deps.file}.${process.pid}.tmp`;
    writeFileSync(temp, `${JSON.stringify(stored, null, 2)}\n`, { mode: 0o600 });
    chmodSync(temp, 0o600);
    renameSync(temp, this.#deps.file);
  }
}

class CancelledLogin extends Error {}

function toUser(value: unknown): AccountUser | null {
  if (!value || typeof value !== "object") return null;
  const raw = value as Record<string, unknown>;
  if (typeof raw.id !== "string" || typeof raw.login !== "string" || !raw.login) return null;
  return {
    id: raw.id,
    login: raw.login,
    avatarUrl: typeof raw.avatar_url === "string" && /^https:\/\//.test(raw.avatar_url) ? raw.avatar_url : null,
    email: typeof raw.email === "string" ? raw.email : null,
    role: raw.role === "admin" ? "admin" : "user",
  };
}

function describe(error: unknown): string {
  if (error instanceof LoginError) return error.message;
  return uiText("登录没有成功，请重试", "Sign-in didn't go through. Try again.");
}

/* ---------------- the loopback listener ---------------- */

type Listener = {
  redirectUri: string;
  /**
   * Resolves with the authorization code the browser delivered, and the address it
   * delivered it to. The site ties a code to the redirect it was issued for and wants
   * that same string back at the token endpoint — and that is whatever the browser was
   * sent to, which is `localhost` whenever something on the way rewrote our `127.0.0.1`.
   * Trading the code under the address we handed out was refused as `invalid_grant`.
   */
  code: Promise<{ code: string; redirectUri: string }>;
  /** End the wait with this failure. */
  fail: (error: Error) => void;
  cancel: () => void;
  /** Answer the browser's pending request with the outcome page (once). */
  respond: (ok: boolean, message?: string) => void;
  close: () => void;
};

/**
 * Listen for the one redirect this sign-in expects.
 *
 * Bound to the loopback interface only, so nothing off this machine can reach it; a
 * request must carry our `state` to count, so a stray one — another tab, a port
 * scanner — is answered and ignored without ending the wait; and the `Host` header must
 * be a loopback name with our port, which is what a DNS-rebinding page cannot fake. We
 * hand out `127.0.0.1`, but `localhost` is accepted too: it can only resolve to this
 * machine (the listener is bound to 127.0.0.1), and something between the site and the
 * browser may well spell the redirect that way.
 */
async function listen(state: string, timeoutMs: number): Promise<Listener> {
  let settle!: { resolve: (arrived: { code: string; redirectUri: string }) => void; reject: (error: Error) => void };
  const code = new Promise<{ code: string; redirectUri: string }>((resolve, reject) => {
    settle = { resolve, reject };
  });
  // Rejected before anyone awaits it when the browser fails to open; that is handled by
  // the awaiting side, so keep Node from calling it unhandled in between.
  code.catch(() => undefined);

  let pending: ServerResponse | undefined;
  let done = false;
  let port = 0;

  const server: Server = createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    const hostOk = req.headers.host === `127.0.0.1:${port}` || req.headers.host === `localhost:${port}`;
    if (req.method !== "GET" || url.pathname !== CALLBACK_PATH || !hostOk) {
      res.writeHead(404, { "Content-Type": "text/plain" }).end("Not found");
      return;
    }
    const given = url.searchParams.get("state") ?? "";
    if (!safeEqual(given, state)) {
      res.writeHead(400, pageHeaders()).end(page(false, uiText("这个登录请求不是从 FastVibe 发起的。", "This sign-in didn't start from FastVibe.")));
      return;
    }
    if (done) {
      res.writeHead(400, pageHeaders()).end(page(false, uiText("这次登录已经结束。", "This sign-in has already finished.")));
      return;
    }
    done = true;
    pending = res;
    const denied = url.searchParams.get("error");
    const authorization = url.searchParams.get("code");
    if (denied) settle.reject(new CancelledLogin("denied"));
    // `hostOk` left only our two loopback spellings, so this is one of two known strings.
    else if (authorization) settle.resolve({ code: authorization, redirectUri: `http://${req.headers.host}${CALLBACK_PATH}` });
    else settle.reject(new LoginError(uiText("登录没有成功，请重试", "Sign-in didn't go through. Try again.")));
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  }).catch(() => {
    throw new LoginError(uiText("无法在本机开启登录回调", "Couldn't open the local sign-in callback."));
  });
  port = (server.address() as AddressInfo).port;
  // A loopback listener is never the reason the process stays up.
  server.unref();

  const timer = setTimeout(() => {
    done = true;
    settle.reject(new LoginError(uiText("等待浏览器登录超时，请重试", "Timed out waiting for the browser. Try again.")));
  }, timeoutMs);
  timer.unref();

  return {
    redirectUri: `http://127.0.0.1:${port}${CALLBACK_PATH}`,
    code,
    fail: (error) => {
      done = true;
      settle.reject(error);
    },
    cancel: () => {
      done = true;
      settle.reject(new CancelledLogin("cancelled"));
    },
    respond: (ok, message) => {
      const res = pending;
      pending = undefined;
      if (!res || res.writableEnded) return;
      res.writeHead(ok ? 200 : 400, pageHeaders()).end(page(ok, message));
    },
    close: () => {
      clearTimeout(timer);
      // Let an answer already written reach the browser before the socket goes.
      setTimeout(() => {
        server.close();
        server.closeAllConnections();
      }, 1500).unref();
    },
  };
}

function safeEqual(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && createHash("sha256").update(left).digest().equals(createHash("sha256").update(right).digest());
}

function pageHeaders(): Record<string, string> {
  return {
    "Content-Type": "text/html; charset=utf-8",
    "Cache-Control": "no-store",
    "Referrer-Policy": "no-referrer",
    "Content-Security-Policy": "default-src 'none'; style-src 'unsafe-inline'",
    Connection: "close",
  };
}

function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[ch] as string);
}

/** What the browser tab shows once the app has the answer. */
function page(ok: boolean, message?: string): string {
  const title = ok ? uiText("登录成功", "Signed in") : uiText("没有登录成功", "Sign-in didn't complete");
  const body = ok
    ? uiText("已经回到 FastVibe，这个标签页可以关闭了。", "You're back in FastVibe. You can close this tab.")
    : (message ?? uiText("请回到 FastVibe 重试。", "Return to FastVibe and try again."));
  return `<!doctype html><html lang="${uiText("zh", "en")}"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escapeHtml(title)} · FastVibe</title>
<style>:root{color-scheme:light dark}body{margin:0;min-height:100vh;display:grid;place-items:center;font:16px/1.5 system-ui,-apple-system,"Segoe UI",sans-serif;background:Canvas;color:CanvasText}
main{max-width:24rem;padding:2rem;text-align:center}h1{font-size:1.375rem;margin:0 0 .5rem}p{margin:0;opacity:.7}</style>
<main><h1>${escapeHtml(title)}</h1><p>${escapeHtml(body)}</p></main></html>`;
}
