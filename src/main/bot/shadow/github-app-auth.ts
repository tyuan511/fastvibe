// SPDX-License-Identifier: MIT
// GitHub App authentication for the isolated DSH deployment. No production runtime,
// IPC, settings, or credential file references this module.
//
// Verified platform semantics (docs.github.com REST OpenAPI + "Get the authenticated
// app" page, checked 2026-11-09):
//   - Installation access tokens CANNOT call `GET /user` (enabledForGitHubApps: false)
//     nor `GET /app` ("You must use a JWT"). The PAT-style write-time `/user` fence in
//     github-native-operation.ts therefore cannot be reused for App principals.
//   - `GET /users/{login}` works with installation tokens; App writes always appear
//     as the app's bot account `{slug}[bot]` with a stable numeric user id.
//   - `POST /app/installations/{id}/access_tokens` requires an RS256 App JWT, returns
//     a token that expires in one hour, and accepts a `repositories` scope in the body.
//   - `POST /app-manifests/{code}/conversions` is unauthenticated, rate limited, and
//     the code is only valid for one hour; the 201 response carries the App id, slug,
//     PEM private key, webhook secret, client id and client secret.
//
// Identity binding for App credentials therefore happens at mint time (this module
// verifies the key against the App id via `GET /app` and discovers the bot user via
// the public user endpoint), not per write. The structural guarantee — an
// installation token can only ever act as its own app's bot — replaces the PAT
// `/user` reflection; see docs/vivi-dsh-github-app.md.

import { createSign } from "node:crypto";
import type { CredentialResolver } from "./credential-host.ts";

const API_VERSION = "2022-11-28";
const DEFAULT_ORIGIN = "https://api.github.com";
const JWT_LIFETIME_SECONDS = 9 * 60; // GitHub rejects JWTs valid for more than 10 minutes.
const TOKEN_REFRESH_MARGIN_MS = 5 * 60_000; // Re-mint before the 1h installation token expires.

export interface GithubAppHttpOptions {
  /** Defaults to https://api.github.com. An http origin requires loopbackTest. */
  origin?: string;
  /** Explicit opt-in for loopback contract tests, mirroring github-transport.ts. */
  loopbackTest?: boolean;
  timeoutMs?: number;
  signal?: AbortSignal;
}

export interface GithubAppIdentity {
  appId: number;
  slug: string;
  /** The numeric id of the `{slug}[bot]` account; this is what review rows record. */
  botUserId: string;
  botLogin: string;
}

export interface GithubAppManifestConversion {
  appId: number;
  slug: string;
  htmlUrl: string;
  pem: string;
  webhookSecret: string | null;
  clientId: string;
  clientSecret: string;
}

const b64url = (value: string): string => Buffer.from(value, "utf8").toString("base64url");

/** RS256 App JWT. `iss` is the App id; lifetime stays under GitHub's 10-minute cap. */
export function createAppJwt(appId: number | string, privateKeyPem: string, now: number = Date.now()): string {
  const id = Number(appId);
  if (!Number.isSafeInteger(id) || id <= 0) throw new Error("GitHub App ID 忘须是正整数");
  if (typeof privateKeyPem !== "string" || !privateKeyPem.includes("PRIVATE KEY")) throw new Error("GitHub App 私钥无效");
  const issuedAt = Math.floor(now / 1000);
  const expiresAt = issuedAt + JWT_LIFETIME_SECONDS;
  if (expiresAt - issuedAt > 600) throw new Error("GitHub App JWT 有效期不能超过 10 分钟");
  const unsigned = `${b64url(JSON.stringify({ alg: "RS256", typ: "JWT" }))}.${b64url(JSON.stringify({ iat: issuedAt, exp: expiresAt, iss: String(id) }))}`;
  try {
    const signature = createSign("RSA-SHA256").update(unsigned).sign(privateKeyPem);
    return `${unsigned}.${signature.toString("base64url")}`;
  } catch {
    throw new Error("GitHub App 私钥签名失败");
  }
}

function checkedOrigin(options: GithubAppHttpOptions): string {
  const origin = options.origin ?? DEFAULT_ORIGIN;
  let base: URL;
  try { base = new URL(origin); } catch { throw new Error("GitHub App origin 无效"); }
  if (!(base.origin === DEFAULT_ORIGIN || (options.loopbackTest === true && base.protocol === "http:" && base.hostname === "127.0.0.1"))) {
    throw new Error("GitHub App 请求只允许 api.github.com 或显式 loopback 测试地址");
  }
  return base.origin;
}

async function appRequest(method: "GET" | "POST", path: string, options: GithubAppHttpOptions & { jwt?: string; body?: unknown }): Promise<unknown> {
  const origin = checkedOrigin(options);
  if (!path.startsWith("/") || path.includes("..") || /[\x00-\x20\x7f]/.test(path)) throw new Error("GitHub App 请求路径无效");
  const headers: Record<string, string> = { Accept: "application/vnd.github+json", "X-GitHub-Api-Version": API_VERSION };
  if (options.jwt !== undefined) headers.Authorization = `Bearer ${options.jwt}`;
  if (options.body !== undefined) headers["Content-Type"] = "application/json";
  const timeoutMs = options.timeoutMs ?? 15_000;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const abort = (): void => controller.abort();
  options.signal?.addEventListener("abort", abort, { once: true });
  let parsed: unknown;
  try {
    const response = await fetch(`${origin}${path}`, { method, headers, body: options.body === undefined ? undefined : JSON.stringify(options.body), signal: controller.signal, redirect: "error" });
    const text = await response.text();
    parsed = text ? JSON.parse(text) : undefined;
    if (!response.ok) {
      const message = parsed && typeof parsed === "object" && typeof (parsed as { message?: unknown }).message === "string" ? (parsed as { message: string }).message : "";
      throw new Error(`GitHub App 请求失败: ${method} ${path} ${response.status}${message ? ` ${message}` : ""}`);
    }
  } catch (error) {
    if (error instanceof Error && error.name === "AbortError") throw new Error(`GitHub App 请求超时: ${method} ${path}`);
    throw error;
  } finally {
    clearTimeout(timer);
    options.signal?.removeEventListener("abort", abort);
  }
  return parsed;
}

const string = (value: unknown, label: string): string => {
  if (typeof value !== "string" || !value.trim()) throw new Error(`GitHub App 响应缺少 ${label}`);
  return value;
};

/** Step 3 of the manifest flow: exchange the one-hour temporary code for the App configuration. */
export async function convertManifestCode(options: { code: string } & GithubAppHttpOptions): Promise<GithubAppManifestConversion> {
  const code = options.code;
  if (typeof code !== "string" || !code.trim() || /[\x00-\x20\x7f/]/.test(code)) throw new Error("manifest code 无效");
  let row: unknown;
  try {
    row = await appRequest("POST", `/app-manifests/${encodeURIComponent(code)}/conversions`, options);
  } catch (error) {
    if (error instanceof Error && /\b404\b/.test(error.message)) throw new Error("manifest code 无效或已超过一小时有效期");
    throw error;
  }
  const object = row as Record<string, unknown>;
  const webhookSecret = object.webhook_secret;
  const appId = Number(object.id);
  if (!Number.isSafeInteger(appId) || appId <= 0) throw new Error("GitHub App 响应缺少 App ID");
  return {
    appId,
    slug: string(object.slug, "slug"),
    htmlUrl: string(object.html_url, "html_url"),
    pem: string(object.pem, "pem"),
    webhookSecret: webhookSecret === null || webhookSecret === undefined ? null : string(webhookSecret, "webhook_secret"),
    clientId: string(object.client_id, "client_id"),
    clientSecret: string(object.client_secret, "client_secret"),
  };
}

export interface GithubAppManifestInput {
  name: string;
  homepage: string;
  redirectUrl: string;
  setupUrl?: string;
  /** e.g. `{ contents: "read", pull_requests: "write" }`. */
  permissions: Record<string, "read" | "write" | "admin">;
  events?: readonly string[];
  isPublic?: boolean;
}

/**
 * Step 0 of the manifest flow: the JSON submitted to `github.com/settings/apps/new`.
 * Pure so the settings UI can render it into an auto-submitting form POST. Vivi's
 * reviewer bot needs at minimum `{ pull_requests: "write" }`; the loop reads CI via
 * `checks: "read"` and files via `contents: "read"` during preflight.
 */
export function buildAppManifest(input: GithubAppManifestInput): Record<string, unknown> {
  const url = (value: string, label: string): string => {
    let parsed: URL;
    try { parsed = new URL(value); } catch { throw new Error(`GitHub App manifest ${label} 无效`); }
    if (!/^https?:$/.test(parsed.protocol) || parsed.username || parsed.password) throw new Error(`GitHub App manifest ${label} 无效`);
    return parsed.href;
  };
  if (typeof input.name !== "string" || !input.name.trim() || input.name.length > 100) throw new Error("GitHub App manifest name 无效");
  url(input.homepage, "homepage");
  const redirect = url(input.redirectUrl, "redirectUrl");
  if (input.setupUrl !== undefined) url(input.setupUrl, "setupUrl");
  const permissions = input.permissions;
  if (!permissions || typeof permissions !== "object" || Array.isArray(permissions)
    || Object.keys(permissions).length === 0 || Object.entries(permissions).some(([key, access]) => !/^[a-z_]+$/.test(key) || !["read", "write", "admin"].includes(access))) throw new Error("GitHub App manifest permissions 无效");
  if (input.events !== undefined && (!Array.isArray(input.events) || input.events.some(event => typeof event !== "string" || !event.trim()))) throw new Error("GitHub App manifest events 无效");
  return {
    name: input.name.trim(),
    url: input.homepage,
    redirect_url: redirect,
    ...(input.setupUrl === undefined ? {} : { setup_url: input.setupUrl }),
    default_permissions: { ...permissions },
    ...(input.events === undefined ? {} : { default_events: [...input.events] }),
    public: input.isPublic ?? false,
  };
}

/**
 * Mint-time App identity: verifies the private key really belongs to `appId` (via the
 * JWT-authenticated `GET /app`) and resolves the bot account the App will act as.
 */
export async function resolveAppPrincipal(options: { appId: number | string; privateKeyPem: string; expectedSlug?: string } & GithubAppHttpOptions): Promise<GithubAppIdentity> {
  const appId = Number(options.appId);
  if (!Number.isSafeInteger(appId) || appId <= 0) throw new Error("GitHub App ID 必须是正整数");
  const jwt = createAppJwt(appId, options.privateKeyPem);
  const app = await appRequest("GET", "/app", { ...options, jwt }) as Record<string, unknown>;
  if (Number(app.id) !== appId) throw new Error("GitHub App 私钥与 App ID 不匹配");
  const slug = string(app.slug, "slug").toLowerCase();
  if (options.expectedSlug !== undefined && options.expectedSlug.toLowerCase() !== slug) throw new Error(`GitHub App slug 不匹配: 期望 ${options.expectedSlug} 实际 ${slug}`);
  const botLogin = `${slug}[bot]`;
  const user = await appRequest("GET", `/users/${encodeURIComponent(botLogin)}`, options) as Record<string, unknown>;
  if (string(user.login, "bot login").toLowerCase() !== botLogin.toLowerCase()) throw new Error("GitHub App bot 账号响应不匹配");
  const botUserId = String(user.id);
  if (!/^[1-9]\d*$/.test(botUserId)) throw new Error("GitHub App bot 账号 id 无效");
  return { appId, slug, botUserId, botLogin };
}

export interface GithubInstallationView {
  installationId: number;
  accountLogin: string;
  repositorySelection: string;
  appSlug: string;
  htmlUrl: string;
}

/** App-JWT-authenticated installation listing for the settings flow's picker. */
export async function listInstallations(options: { appId: number | string; privateKeyPem: string } & GithubAppHttpOptions): Promise<GithubInstallationView[]> {
  const appId = Number(options.appId);
  if (!Number.isSafeInteger(appId) || appId <= 0) throw new Error("GitHub App ID 必须是正整数");
  const jwt = createAppJwt(appId, options.privateKeyPem);
  const rows = await appRequest("GET", "/app/installations?per_page=100", { ...options, jwt });
  if (!Array.isArray(rows)) throw new Error("GitHub App 安装列表响应无效");
  return rows.map(row => {
    const installation = row as Record<string, unknown>;
    const installationId = Number(installation.id);
    if (!Number.isSafeInteger(installationId) || installationId <= 0) throw new Error("GitHub App 安装列表响应无效");
    return {
      installationId,
      accountLogin: string((installation.account as Record<string, unknown> | undefined)?.login, "account login"),
      repositorySelection: string(installation.repository_selection, "repository_selection"),
      appSlug: string(installation.app_slug, "app_slug"),
      htmlUrl: string(installation.html_url, "html_url"),
    };
  });
}

export interface GithubAppInstallationOptions extends GithubAppHttpOptions {
  appId: number | string;
  privateKeyPem: string;
  installationId: number;
  /** Scope every minted token to these repositories when provided. */
  repositories?: readonly string[];
  /** Fail minting if the key belongs to an App with a different slug. */
  expectedSlug?: string;
  now?: () => number;
}

/**
 * A CredentialResolver that mints one-hour installation access tokens on demand.
 * Tokens are cached until five minutes before expiry; concurrent resolves share a
 * single mint. Nothing but the token string ever leaves this class.
 */
export class GithubAppInstallationCredentials implements CredentialResolver {
  readonly installationId: number;
  private readonly options: GithubAppInstallationOptions;
  private token?: { value: string; expiresAt: number };
  private minting?: Promise<string>;
  private identity?: Promise<GithubAppIdentity>;

  constructor(options: GithubAppInstallationOptions) {
    if (!Number.isSafeInteger(options.installationId) || options.installationId <= 0) throw new Error("GitHub App installation ID 必须是正整数");
    if (options.repositories !== undefined && (!Array.isArray(options.repositories) || options.repositories.some(name => typeof name !== "string" || !name.trim()))) throw new Error("GitHub App token 仓库范围无效");
    this.installationId = options.installationId;
    this.options = options;
  }

  /** Verified at mint time; cached. See the module header for why this is not per-write. */
  principal(): Promise<GithubAppIdentity> {
    this.identity ??= resolveAppPrincipal(this.options).catch(error => { this.identity = undefined; throw error; });
    return this.identity;
  }

  async resolve(_reference: { id: string }, _purpose: string): Promise<string> {
    const now = this.options.now ?? Date.now;
    if (this.token && now() < this.token.expiresAt - TOKEN_REFRESH_MARGIN_MS) return this.token.value;
    this.minting ??= this.mint().finally(() => { this.minting = undefined; });
    return this.minting;
  }

  private async mint(): Promise<string> {
    const jwt = createAppJwt(this.options.appId, this.options.privateKeyPem, (this.options.now ?? Date.now)());
    const body = this.options.repositories?.length ? { repositories: [...this.options.repositories] } : undefined;
    const row = await appRequest("POST", `/app/installations/${this.installationId}/access_tokens`, { ...this.options, jwt, body }) as Record<string, unknown>;
    const value = string(row.token, "installation token");
    if (/[\x00-\x20\x7f]/.test(value)) throw new Error("GitHub App installation token 无效");
    const expiresAt = Date.parse(string(row.expires_at, "expires_at"));
    if (!Number.isFinite(expiresAt) || expiresAt <= (this.options.now ?? Date.now)()) throw new Error("GitHub App installation token 已过期");
    this.token = { value, expiresAt };
    return value;
  }
}
