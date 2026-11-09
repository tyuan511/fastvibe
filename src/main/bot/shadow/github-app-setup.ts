// SPDX-License-Identifier: MIT
// GitHub App manifest one-click install flow for the isolated DSH deployment. No
// production runtime, IPC, settings, or credential path references this module.
//
// Flow (docs.github.com "Registering a GitHub App from a manifest", checked
// 2026-11-09): the settings surface renders `registration` as an auto-submitting
// form POST to GitHub; GitHub redirects back to this flow's loopback callback URL
// with a one-hour `code`; `completed` exchanges it via `convertManifestCode` and
// resolves with the App configuration (id, slug, PEM, secrets). The caller then
// persists it with `saveGithubAppCredential` and picks an installation with
// `listInstallations`. Whether GitHub accepts a loopback `redirect_url` is still
// to be confirmed by a real registration; see docs/vivi-dsh-github-app.md.

import { randomUUID } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { buildAppManifest, convertManifestCode, type GithubAppHttpOptions, type GithubAppManifestConversion, type GithubAppManifestInput } from "./github-app-auth.ts";

export interface GithubAppCredentialRecord extends GithubAppManifestConversion {
  /** Chosen later via listInstallations; required before minting tokens. */
  installationId?: number;
  createdAt: string;
}

function validatedRecord(value: unknown): GithubAppCredentialRecord {
  const record = value as GithubAppCredentialRecord;
  if (!record || typeof record !== "object"
    || !Number.isSafeInteger(Number(record.appId)) || Number(record.appId) <= 0
    || typeof record.slug !== "string" || !record.slug.trim()
    || typeof record.pem !== "string" || !record.pem.includes("PRIVATE KEY")
    || typeof record.clientId !== "string" || !record.clientId.trim()
    || typeof record.clientSecret !== "string" || !record.clientSecret.trim()
    || !(record.webhookSecret === null || typeof record.webhookSecret === "string")
    || !(record.installationId === undefined || (Number.isSafeInteger(Number(record.installationId)) && Number(record.installationId) > 0))
    || typeof record.createdAt !== "string" || Number.isNaN(Date.parse(record.createdAt))) throw new Error("GitHub App 凭据记录无效");
  return { ...record, appId: Number(record.appId), installationId: record.installationId === undefined ? undefined : Number(record.installationId) };
}

/** Host-owned credential file, the same boundary as remote-access.json: 0600, atomic, never in settings. */
export function saveGithubAppCredential(file: string, record: GithubAppCredentialRecord): void {
  if (typeof file !== "string" || !file.trim() || !file.endsWith(".json")) throw new Error("GitHub App 凭据文件路径无效");
  const value = validatedRecord(record);
  mkdirSync(dirname(file), { recursive: true });
  const temp = `${file}.tmp-${randomUUID()}`;
  try {
    writeFileSync(temp, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
    chmodSync(temp, 0o600);
    renameSync(temp, file);
  } catch {
    throw new Error("GitHub App 凭据文件写入失败");
  }
}

export function loadGithubAppCredential(file: string): GithubAppCredentialRecord | undefined {
  if (!existsSync(file)) return undefined;
  try {
    return validatedRecord(JSON.parse(readFileSync(file, "utf8")));
  } catch {
    throw new Error("GitHub App 凭据文件无效");
  }
}

export interface GithubAppSetupHandle {
  /** The loopback redirect_url already embedded in `registration.manifest`. */
  readonly callbackUrl: string;
  readonly state: string;
  /** Render as an auto-submitting form: action + hidden `manifest`/`state` fields. */
  readonly registration: { action: string; manifest: string; state: string };
  readonly completed: Promise<GithubAppManifestConversion>;
  cancel(): void;
}

/** Organization accounts register at a different target; personal accounts use the default action. */
export function organizationRegistrationAction(organization: string): string {
  if (!/^[A-Za-z0-9-]+$/.test(organization)) throw new Error("GitHub 组织名无效");
  return `https://github.com/organizations/${organization}/settings/apps/new`;
}

const PERSONAL_REGISTRATION_ACTION = "https://github.com/settings/apps/new";
const CALLBACK_PAGE = "<!doctype html><html><body><p>FastVibe 已收到 GitHub App 注册回调，可以关闭此页面返回应用。</p></body></html>";

/**
 * Starts the loopback callback server and returns how to open GitHub plus the
 * `completed` exchange promise. `manifest.redirectUrl` is derived from the bound
 * port, so callers never have to guess it.
 */
export async function beginGithubAppSetup(options: { manifest: Omit<GithubAppManifestInput, "redirectUrl">; expectedState?: string; callbackPath?: string; timeoutMs?: number } & GithubAppHttpOptions): Promise<GithubAppSetupHandle> {
  const callbackPath = options.callbackPath ?? "/callback";
  if (!callbackPath.startsWith("/") || callbackPath.includes("..") || callbackPath.includes("?") || /[^\w/.-]/.test(callbackPath)) throw new Error("回调路径无效");
  const state = options.expectedState ?? randomUUID();
  const timeoutMs = options.timeoutMs ?? 15 * 60_000;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) throw new Error("回调等待超时配置无效");
  let settle: (conversion: GithubAppManifestConversion) => void;
  let reject: (error: Error) => void;
  let settled = false;
  const completed = new Promise<GithubAppManifestConversion>((resolve, reject_) => { settle = resolve; reject = reject_; });
  const server = createServer((request: IncomingMessage, response: ServerResponse) => {
    const reply = (status: number): void => { response.writeHead(status, { "Content-Type": "text/html; charset=utf-8" }); response.end(status === 200 ? CALLBACK_PAGE : ""); };
    if (request.method !== "GET") return reply(405);
    const url = new URL(request.url ?? "/", "http://127.0.0.1");
    if (url.pathname !== callbackPath) return reply(404);
    if (url.searchParams.get("state") !== state) return reply(403);
    const code = url.searchParams.get("code");
    if (code === null || !code.trim() || /[\x00-\x20\x7f/]/.test(code)) return reply(400);
    reply(200);
    if (settled) return;
    settled = true;
    clearTimeout(timer);
    convertManifestCode({ code, origin: options.origin, loopbackTest: options.loopbackTest, timeoutMs: options.timeoutMs, signal: options.signal })
      .then(conversion => { shutdown(); settle!(conversion); }, error => { shutdown(); reject!(error instanceof Error ? error : new Error(String(error))); });
  });
  const shutdown = (): void => { server.close(); server.closeIdleConnections?.(); };
  const timer = setTimeout(() => { if (!settled) { settled = true; shutdown(); reject!(new Error("等待 GitHub App 注册回调超时")); } }, timeoutMs);
  const close = shutdown;
  server.on("error", error => { if (!settled) { settled = true; clearTimeout(timer); reject!(error instanceof Error ? error : new Error(String(error))); } });
  options.signal?.addEventListener("abort", () => { if (!settled) { settled = true; clearTimeout(timer); close(); reject!(new Error("GitHub App 注册流程已取消")); } }, { once: true });
  const port = await new Promise<number>((resolve, reject_) => { server.once("error", reject_); server.listen(0, "127.0.0.1", () => resolve((server.address() as { port: number }).port)); });
  const callbackUrl = `http://127.0.0.1:${port}${callbackPath}`;
  const manifest = buildAppManifest({ ...options.manifest, redirectUrl: callbackUrl });
  return {
    callbackUrl,
    state,
    registration: { action: PERSONAL_REGISTRATION_ACTION, manifest: JSON.stringify(manifest), state },
    completed,
    cancel: () => { if (!settled) { settled = true; clearTimeout(timer); close(); reject!(new Error("GitHub App 注册流程已取消")); } },
  };
}
