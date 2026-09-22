import { chmodSync, readFileSync, writeFileSync } from "node:fs";
import type { GatewayBalance, GatewayKind } from "@shared/types";
import { uiText } from "./ui-text.ts";

/**
 * Which gateway software is answering at a Base URL, and how to read its balance.
 *
 * Both families are OpenAI/Anthropic-compatible relays, so nothing about the model
 * list tells them apart — a `claude-` id from either one looks the same. What does is
 * the *panel* they answer on, and that is what this probes. Two reasons it is worth
 * the request at all:
 *
 * - 添加供应商 can say which product it is talking to instead of leaving the user to
 *   infer it from a model list.
 * - A balance endpoint exists only once the product is known (`/api/usage/token` for
 *   new-api, `/v1/sub2api/billing` for sub2api), so 供应商详情 cannot show 余额 without it.
 *
 * The kind is stored on the provider entry, not re-probed on every render: it is a
 * fact about the endpoint, and the balance endpoint that depends on it is cached by
 * the caller anyway.
 */
export type { GatewayKind };

/**
 * The kinds this build can act on, as a runtime list.
 *
 * Held apart from the union in `@shared/types`, which is a type and nothing at runtime:
 * this module is loaded by the tests straight from source, where a value import of a
 * path alias cannot resolve. `isGatewayKind` is what re-validates whatever comes back
 * off disk, so the two spellings have to agree.
 */
export const KNOWN_GATEWAY_KINDS: readonly GatewayKind[] = ["sub2api", "new-api"];

export function isGatewayKind(value: unknown): value is GatewayKind {
  return typeof value === "string" && (KNOWN_GATEWAY_KINDS as readonly string[]).includes(value);
}

/** Where the model list lives under a Base URL, i.e. what the user actually typed. */
export type GatewayTarget = {
  /** Scheme + host + explicit port, e.g. `https://gw.example.com`. */
  origin: string;
  /** Path in front of the version segment, e.g. `/relay` for `https://h/relay/v1`. */
  prefix: string;
};


type FetchLike = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;
/**
 * A balance read takes the `origin`/`prefix` probed when the provider was identified,
 * falling back to the target derived from the stored Base URL.
 */
type CredentialTarget = Partial<GatewayTarget> & { apiKey: string };

/**
 * What a new-api panel needs to answer about an account, beyond the relay key.
 *
 * Its `/api/user/self` — the only route that reports a wallet — authenticates a
 * **dashboard** session, not the `sk-` relay key the provider is configured with: the
 * relay key is scoped to proxying, and against the panel it is answered `401` (verified
 * against a live deployment). So the user's own access token and account id have to be
 * supplied for this one read, and they are optional — a panel that will not give them up
 * costs the balance row and nothing else.
 */
export type GatewayDashboardCredential = {
  /** The panel's own access token (设置 → 个人设置 → 生成系统访问令牌). */
  accessToken: string;
  /** The numeric account id the token belongs to; sent as `New-Api-User`. */
  userId: string;
};

const PROBE_TIMEOUT_MS = 8_000;
const BALANCE_TIMEOUT_MS = 15_000;

/**
 * The sites a Base URL could be talking to, most specific first.
 *
 * The question is where the *panel* routes live, which is not where the model list
 * lives. `/v1` and `/v1beta` are the only version segments the UI ever hands a user,
 * and they are exactly what the panel is not mounted under — so a Base URL ending in
 * one has that segment dropped (the model list is still reached, because the caller
 * keeps the typed URL for that). A relay mounted under a path of its own
 * (`.../coding/paas/v4`) keeps it: that path *is* where the software lives.
 */
export function gatewayTargets(baseUrl: string): GatewayTarget[] {
  const trimmed = baseUrl.trim();
  if (!trimmed) return [];
  let url: URL;
  try {
    url = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`);
  } catch {
    return [];
  }

  const path = url.pathname.replace(/\/+$/, "");
  const knownVersion = /\/v1beta$/.test(path) ? "/v1beta" : /\/v1$/.test(path) ? "/v1" : undefined;
  const trimmedPrefix = knownVersion ? path.slice(0, -knownVersion.length) : `${path}/v1`;
  const prefixes = knownVersion ? [trimmedPrefix] : [trimmedPrefix, path];

  const seen = new Set<string>();
  const targets: GatewayTarget[] = [];
  for (const prefix of prefixes) {
    if (seen.has(prefix)) continue;
    seen.add(prefix);
    targets.push({ origin: url.origin, prefix });
  }
  return targets;
}

/**
 * Identify the gateway at a Base URL. Never throws: a relay that answers none of the
 * known panels is `unknown`, which is a perfectly ordinary result and the state every
 * provider starts in.
 *
 * `fetchImpl` is the test seam. It is used for the panel probes only — a balance read
 * carries the user's key and goes through `fetchGatewayBalance`, which takes the kind
 * already stored on the provider.
 */
export async function probeGateway(baseUrl: string, fetchImpl: FetchLike = fetch): Promise<GatewayKind | undefined> {
  const targets = gatewayTargets(baseUrl);
  for (const target of targets) {
    if (await isSub2Api(target, fetchImpl)) return "sub2api";
  }
  // Only after every sub2api candidate: `/setup/status` is the harder fingerprint, and
  // a relay that answers both should be named by the more specific one.
  for (const target of targets) {
    if (await isNewApi(target, fetchImpl)) return "new-api";
  }
  return undefined;
}

/**
 * sub2api's own route table has `GET /setup/status` returning a fixed
 * `{"code":0,"data":{"needs_setup":false,"step":"completed"}}`, and new-api has no
 * such route (its SPA fallback answers `200 text/html`). The shape is checked rather
 * than the status alone, so a site that serves an HTML page for every unknown path
 * cannot claim to be sub2api.
 */
async function isSub2Api(target: GatewayTarget, fetchImpl: FetchLike): Promise<boolean> {
  const payload = await getJson(`${target.origin}${target.prefix}/setup/status`, {}, fetchImpl);
  if (!isRecord(payload)) return false;
  const data = isRecord(payload.data) ? payload.data : undefined;
  if (!data) return false;
  return data.needs_setup === false && data.step === "completed";
}

/**
 * new-api (and the one-api it descends from) is recognised by `/api/status`, whose
 * envelope is `{success, data:{system_name, version, setup, …}}`. Bare one-api answers
 * the same endpoint with the same envelope, so it is reported as this family — the two
 * are the same protocol, and the balance endpoint below is shared.
 */
async function isNewApi(target: GatewayTarget, fetchImpl: FetchLike): Promise<boolean> {
  const payload = await getJson(`${target.origin}${target.prefix}/api/status`, {}, fetchImpl);
  return statusLooksLikeNewApi(payload);
}

/** Exported for the test that pins the acceptance shape. */
export function statusLooksLikeNewApi(payload: unknown): boolean {
  if (!isRecord(payload)) return false;
  if (payload.success !== true) return false;
  const data = isRecord(payload.data) ? payload.data : undefined;
  if (!data) return false;
  // `system_name` is what the panel is branded with and what fixes the family in
  // people's minds, but a rebranded deployment may rename it — the version string and
  // the numeric quota unit are what the software actually emits.
  return typeof data.version === "string" || typeof data.quota_per_unit === "number" || typeof data.system_name === "string";
}

/* ---------------- balance ---------------- */

/**
 * Read the balance attached to the stored key.
 *
 * Only the two families `probeGateway` can name are supported; anything else throws,
 * so the caller can decide between hiding the row and showing the reason. The calls
 * are read-only and carry a credential that already belongs to this install.
 */
export async function fetchGatewayBalance(
  credential: CredentialTarget & {
    kind?: GatewayKind;
    baseUrl?: string;
    /** new-api only: without these the panel will not report a wallet. */
    dashboard?: GatewayDashboardCredential;
  },
  fetchImpl: FetchLike = fetch,
): Promise<GatewayBalance> {
  // An unidentified gateway has no balance endpoint to try — the row that would call
  // this is not drawn at all, and the message is for the one path that bypasses it.
  if (!credential.kind) throw new Error(uiText("未识别该站点的类型，无法读取余额", "This site was not identified, so its balance cannot be read."));
  if (!credential.apiKey.trim()) throw new Error(uiText("请先填写 API Key", "Add an API key first."));
  const root = balanceRoot(credential);
  if (!root) throw new Error(uiText("Base URL 无效", "The base URL is not valid."));

  return credential.kind === "sub2api"
    ? readSub2ApiBalance(root, credential.apiKey, fetchImpl)
    : readNewApiBalance(root, credential, fetchImpl);
}

/**
 * Where the panel routes live. The probe's own answer is used when the provider was
 * identified from a known Base URL; otherwise the outermost target is derived again.
 */
function balanceRoot(credential: CredentialTarget & { baseUrl?: string }): string | undefined {
  if (credential.origin !== undefined) return `${credential.origin}${credential.prefix ?? ""}`;
  if (!credential.baseUrl) return undefined;
  const targets = gatewayTargets(credential.baseUrl);
  const target = targets[targets.length - 1];
  return target ? `${target.origin}${target.prefix}` : undefined;
}

/**
 * new-api reports a wallet on `/api/user/self`, which is a **panel** route: it wants the
 * user's own access token and account id, not the relay key — asked with the relay key it
 * answers `401` (verified against a live deployment). So this read needs the dashboard
 * credential, and says so plainly when it is missing rather than reporting a failure the
 * user cannot act on.
 */
async function readNewApiBalance(
  root: string,
  credential: CredentialTarget & { dashboard?: GatewayDashboardCredential },
  fetchImpl: FetchLike,
): Promise<GatewayBalance> {
  const dashboard = credential.dashboard;
  if (!dashboard?.accessToken.trim()) {
    throw new Error(
      uiText(
        "New API 的余额需要面板访问令牌，请点右侧配置",
        "New API needs a dashboard access token for its balance — configure it here.",
      ),
    );
  }
  const payload = await getJson(
    `${root}/api/user/self`,
    {
      Authorization: `Bearer ${dashboard.accessToken.trim()}`,
      ...(dashboard.userId.trim() ? { "New-Api-User": dashboard.userId.trim() } : {}),
    },
    fetchImpl,
    BALANCE_TIMEOUT_MS,
  );
  const data = isRecord(payload) && isRecord(payload.data) ? payload.data : undefined;
  if (!data) {
    throw new Error(
      uiText(
        "面板拒绝了该访问令牌，请检查令牌与用户 ID",
        "The panel refused this access token — check the token and the user id.",
      ),
    );
  }

  const quota = finite(data.quota);
  if (quota === undefined) throw new Error(uiText("该站点未返回余额数据", "This site did not return balance data."));
  // An unlimited account carries the software's `-1` sentinel rather than a budget.
  if (quota < 0) return { unlimited: true };
  // The panel's quota unit is configurable per deployment; without it a number is not money.
  return { unlimited: false, available: quota / (await readQuotaPerUnit(root, fetchImpl)) };
}

/**
 * `quota_per_unit` is published by `/api/status` and is configurable per deployment.
 * The 500000 below is the software's own default, used only when a panel does not say.
 */
async function readQuotaPerUnit(root: string, fetchImpl: FetchLike): Promise<number> {
  const status = await getJson(`${root}/api/status`, {}, fetchImpl);
  const data = isRecord(status) && isRecord(status.data) ? status.data : undefined;
  const configured = finite(data?.quota_per_unit);
  return configured !== undefined && configured > 0 ? configured : 500_000;
}

/**
 * sub2api's own balance route is `GET /v1/usage`, which answers `quota_limited` (the key
 * carries its own budget) or `unrestricted` (a subscription, or a wallet) — its comment
 * says as much, and it is what its panel reads for 余额. `remaining` is in USD when
 * `unit` says so, and `/v1/sub2api/billing` returns no amount at all, only rates.
 */
async function readSub2ApiBalance(root: string, apiKey: string, fetchImpl: FetchLike): Promise<GatewayBalance> {
  const payload = await getJson(`${root}/v1/usage`, { Authorization: `Bearer ${apiKey}` }, fetchImpl, BALANCE_TIMEOUT_MS);
  if (!isRecord(payload)) throw new Error(uiText("该站点未返回余额数据", "This site did not return balance data."));

  const remaining = finite(payload.remaining) ?? finite(payload.balance);
  if (remaining === undefined) {
    // A key that is neither metered nor given a number has no figure to show; it is not
    // an error, and 不限额度 is what the panel itself would say.
    if (payload.unit !== undefined) return { unlimited: true };
    throw new Error(uiText("该站点未返回余额数据", "This site did not return balance data."));
  }
  return { unlimited: false, available: remaining };
}

/* ---------------- helpers ---------------- */

async function getJson(
  url: string,
  headers: Record<string, string>,
  fetchImpl: FetchLike,
  timeout = PROBE_TIMEOUT_MS,
): Promise<unknown> {
  let response: Response;
  try {
    response = await fetchImpl(url, { headers, redirect: "follow", signal: AbortSignal.timeout(timeout) });
  } catch {
    return undefined;
  }
  if (!response.ok) return undefined;
  // A panel route is JSON. Anything else (an SPA's HTML catch-all) is not an answer,
  // and parsing it would be the only way to be wrong here.
  const type = response.headers.get("content-type") ?? "";
  if (!/json/i.test(type)) return undefined;
  try {
    return await response.json();
  } catch {
    return undefined;
  }
}

function finite(value: unknown): number | undefined {
  const parsed =
    typeof value === "number" ? value : typeof value === "string" && value.trim() ? Number(value) : NaN;
  return Number.isFinite(parsed) ? parsed : undefined;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

/* ---------------- dashboard credentials ---------------- */

/**
 * The panel credentials users supply for their new-api deployments, on disk.
 *
 * They live in their own file rather than in `providers.json` for the reason the remote
 * server's own secrets do: `providers.json` is broadcast to every client as the provider
 * list — `listProviderConfigs` is `providers:list` — so an access token put there would
 * be handed to every connected window and every device on remote access. This file is
 * 0600, is never served, and the only thing that crosses IPC is whether one exists.
 */
type DashboardCredentialFile = Record<string, { accessToken: string; userId: string }>;

export function readGatewayCredentials(path: string): Record<string, GatewayDashboardCredential> {
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as unknown;
    if (!isRecord(parsed)) return {};
    const out: Record<string, GatewayDashboardCredential> = {};
    for (const [id, value] of Object.entries(parsed)) {
      if (!isRecord(value)) continue;
      const accessToken = stringValue(value.accessToken);
      const userId = stringValue(value.userId) ?? "";
      if (accessToken) out[id] = { accessToken, userId };
    }
    return out;
  } catch {
    return {};
  }
}

export function writeGatewayCredentials(path: string, credentials: DashboardCredentialFile): void {
  const kept = Object.fromEntries(
    Object.entries(credentials).filter(([, value]) => value.accessToken.trim()),
  );
  writeFileSync(path, Object.keys(kept).length ? `${JSON.stringify(kept, null, 2)}\n` : "", { mode: 0o600 });
  chmodSync(path, 0o600);
}
