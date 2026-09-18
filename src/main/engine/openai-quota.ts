import type { OpenAIAccountQuota, OpenAIQuotaWindow } from "@shared/types";
import { uiText } from "./ui-text.ts";

const OPENAI_CREDITS_URL = "https://api.openai.com/v1/dashboard/billing/credit_grants";
const CODEX_USAGE_URL = "https://chatgpt.com/backend-api/wham/usage";
const REQUEST_TIMEOUT_MS = 20_000;

type FetchLike = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

type OpenAIQuotaCredential = {
  apiKey: string;
  /** ChatGPT workspace/account id carried by the Codex OAuth token. */
  accountId?: string;
};

/**
 * Fetch account allowance data for OpenAI's two native providers.
 *
 * URLs are fixed here rather than supplied by the renderer. The call is safe to expose
 * to a remote client: it can only read the allowance attached to a credential already
 * stored on this FastVibe host, and never returns that credential.
 */
export async function fetchOpenAIAccountQuota(
  providerId: "openai" | "openai-codex",
  credential: OpenAIQuotaCredential,
  fetchImpl: FetchLike = fetch,
): Promise<OpenAIAccountQuota> {
  const url = providerId === "openai-codex" ? CODEX_USAGE_URL : OPENAI_CREDITS_URL;
  const headers: Record<string, string> = {
    Accept: "application/json",
    Authorization: `Bearer ${credential.apiKey}`,
  };
  if (providerId === "openai-codex") {
    // The endpoint is ChatGPT-internal and currently expects the same identifying
    // headers as the Codex Responses transport.
    headers.originator = "pi";
    headers["User-Agent"] = "FastVibe";
  }
  if (providerId === "openai-codex" && credential.accountId) {
    headers["ChatGPT-Account-Id"] = credential.accountId;
  }

  let response: Response;
  try {
    response = await fetchImpl(url, {
      method: "GET",
      headers,
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch {
    throw new Error(uiText("无法连接 OpenAI，请稍后重试", "Could not reach OpenAI. Try again later."));
  }

  if (response.status === 401 || response.status === 403) {
    throw new Error(
      providerId === "openai-codex"
        ? uiText("当前登录无权读取账号额度，请重新登录", "This login cannot read account limits. Sign in again.")
        : uiText(
            "当前 API 密钥无权读取账户余额；项目密钥通常不支持此接口",
            "This API key cannot read the account balance. Project keys usually do not support this endpoint.",
          ),
    );
  }
  if (!response.ok) {
    throw new Error(uiText(`获取账号额度失败（${response.status}）`, `Could not load account limits (${response.status}).`));
  }

  let payload: unknown;
  try {
    payload = await response.json();
  } catch {
    throw new Error(uiText("OpenAI 返回的额度数据无效", "OpenAI returned invalid limit data."));
  }

  return providerId === "openai-codex"
    ? parseCodexQuota(payload)
    : parseOpenAICreditQuota(payload);
}

/** Decode the workspace id from an OpenAI Codex access-token JWT without exposing it. */
export function openAICodexAccountId(accessToken: string): string | undefined {
  const encoded = accessToken.split(".")[1];
  if (!encoded) return undefined;
  try {
    const payload = JSON.parse(Buffer.from(encoded, "base64url").toString("utf8")) as unknown;
    if (!isRecord(payload)) return undefined;
    const auth = payload["https://api.openai.com/auth"];
    if (!isRecord(auth)) return undefined;
    const id = auth.chatgpt_account_id;
    return typeof id === "string" && id.length > 0 ? id : undefined;
  } catch {
    return undefined;
  }
}

export function parseCodexQuota(payload: unknown, fetchedAt = Date.now()): OpenAIAccountQuota {
  if (!isRecord(payload)) throw invalidData();
  const rateLimit = isRecord(payload.rate_limit) ? payload.rate_limit : undefined;
  const windows: OpenAIQuotaWindow[] = [];

  const primary = parseWindow(rateLimit?.primary_window, "primary", "primary");
  if (primary) windows.push(primary);
  const secondary = parseWindow(rateLimit?.secondary_window, "secondary", "secondary");
  if (secondary) windows.push(secondary);

  if (Array.isArray(payload.additional_rate_limits)) {
    payload.additional_rate_limits.forEach((raw, index) => {
      if (!isRecord(raw) || !isRecord(raw.rate_limit)) return;
      const name = stringValue(raw.limit_name) ?? stringValue(raw.metered_feature);
      const extraPrimary = parseWindow(raw.rate_limit.primary_window, `additional:${index}:primary`, "additional", name);
      if (extraPrimary) windows.push(extraPrimary);
      const extraSecondary = parseWindow(raw.rate_limit.secondary_window, `additional:${index}:secondary`, "additional", name);
      if (extraSecondary) windows.push(extraSecondary);
    });
  }

  const credits = parseCodexCredits(payload.credits);
  if (windows.length === 0 && !credits) throw invalidData();

  return {
    providerId: "openai-codex",
    kind: "codex",
    fetchedAt,
    ...(stringValue(payload.plan_type) ? { plan: stringValue(payload.plan_type) } : {}),
    windows,
    ...(credits ? { credits } : {}),
  };
}

export function parseOpenAICreditQuota(payload: unknown, fetchedAt = Date.now()): OpenAIAccountQuota {
  if (!isRecord(payload)) throw invalidData();
  const totalGranted = finiteNumber(payload.total_granted);
  const totalUsed = finiteNumber(payload.total_used);
  const totalAvailable = finiteNumber(payload.total_available);
  if (totalGranted === undefined || totalUsed === undefined || totalAvailable === undefined) throw invalidData();

  const expiries = isRecord(payload.grants) && Array.isArray(payload.grants.data)
    ? payload.grants.data
        .map((grant) => isRecord(grant) ? epochMilliseconds(grant.expires_at) : undefined)
        .filter((value): value is number => value !== undefined && value > fetchedAt)
    : [];

  return {
    providerId: "openai",
    kind: "api-credits",
    fetchedAt,
    totalGranted: Math.max(0, totalGranted),
    totalUsed: Math.max(0, totalUsed),
    totalAvailable: Math.max(0, totalAvailable),
    ...(expiries.length > 0 ? { nextExpiry: Math.min(...expiries) } : {}),
  };
}

function parseWindow(
  raw: unknown,
  id: string,
  kind: OpenAIQuotaWindow["kind"],
  name?: string,
): OpenAIQuotaWindow | undefined {
  if (!isRecord(raw)) return undefined;
  const usedPercent = finiteNumber(raw.used_percent);
  if (usedPercent === undefined) return undefined;
  const resetAt = epochMilliseconds(raw.reset_at);
  const windowSeconds = finiteNumber(raw.limit_window_seconds);
  return {
    id,
    kind,
    ...(name ? { name } : {}),
    usedPercent: Math.min(100, Math.max(0, usedPercent)),
    ...(resetAt !== undefined ? { resetAt } : {}),
    ...(windowSeconds !== undefined && windowSeconds > 0 ? { windowSeconds } : {}),
  };
}

function parseCodexCredits(raw: unknown): { balance?: number; hasCredits?: boolean; unlimited?: boolean } | undefined {
  if (!isRecord(raw)) return undefined;
  const balance = finiteNumber(raw.balance);
  const hasCredits = typeof raw.has_credits === "boolean" ? raw.has_credits : undefined;
  const unlimited = typeof raw.unlimited === "boolean" ? raw.unlimited : undefined;
  if (balance === undefined && hasCredits === undefined && unlimited === undefined) return undefined;
  return {
    ...(balance !== undefined ? { balance: Math.max(0, balance) } : {}),
    ...(hasCredits !== undefined ? { hasCredits } : {}),
    ...(unlimited !== undefined ? { unlimited } : {}),
  };
}

function epochMilliseconds(value: unknown): number | undefined {
  const seconds = finiteNumber(value);
  if (seconds === undefined || seconds <= 0) return undefined;
  // OpenAI currently returns epoch seconds; tolerate milliseconds if that changes.
  return seconds < 10_000_000_000 ? seconds * 1_000 : seconds;
}

function finiteNumber(value: unknown): number | undefined {
  const parsed = typeof value === "number" ? value : typeof value === "string" && value.trim() ? Number(value) : NaN;
  return Number.isFinite(parsed) ? parsed : undefined;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function invalidData(): Error {
  return new Error(uiText("OpenAI 返回的额度数据无效", "OpenAI returned invalid limit data."));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
