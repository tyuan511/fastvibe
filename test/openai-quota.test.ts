import { test } from "node:test";
import assert from "node:assert/strict";
import {
  fetchOpenAIAccountQuota,
  openAICodexAccountId,
  parseCodexQuota,
  parseOpenAICreditQuota,
} from "../src/main/engine/openai-quota.ts";

test("quota requests use fixed OpenAI endpoints and never expose credentials in the result", async () => {
  const requests: Array<{ url: string; init?: RequestInit }> = [];
  const codex = await fetchOpenAIAccountQuota("openai-codex", { apiKey: "secret-token", accountId: "account-123" }, async (url, init) => {
    requests.push({ url: String(url), init });
    return new Response(JSON.stringify({ rate_limit: { primary_window: { used_percent: 4 } } }), { status: 200 });
  });
  const api = await fetchOpenAIAccountQuota("openai", { apiKey: "secret-key" }, async (url, init) => {
    requests.push({ url: String(url), init });
    return new Response(JSON.stringify({ total_granted: 10, total_used: 2, total_available: 8 }), { status: 200 });
  });

  assert.equal(requests[0]?.url, "https://chatgpt.com/backend-api/wham/usage");
  const codexHeaders = new Headers(requests[0]?.init?.headers);
  assert.equal(codexHeaders.get("authorization"), "Bearer secret-token");
  assert.equal(codexHeaders.get("chatgpt-account-id"), "account-123");
  assert.equal(codexHeaders.get("originator"), "pi");
  assert.equal(requests[1]?.url, "https://api.openai.com/v1/dashboard/billing/credit_grants");
  assert.equal(api.kind, "api-credits");
  assert.equal(JSON.stringify(codex).includes("secret-token"), false);
});

test("quota request errors do not include the response body", async () => {
  await assert.rejects(
    () => fetchOpenAIAccountQuota("openai", { apiKey: "secret-key" }, async () =>
      new Response("secret-key should never be shown", { status: 403 })),
    (error: unknown) => error instanceof Error && !error.message.includes("secret-key"),
  );
});

test("Codex quota maps rolling windows, plan and credits", () => {
  const quota = parseCodexQuota({
    plan_type: "plus",
    rate_limit: {
      primary_window: {
        used_percent: 22,
        reset_at: 1_766_948_068,
        limit_window_seconds: 18_000,
      },
      secondary_window: {
        used_percent: 43,
        reset_at: 1_767_407_914,
        limit_window_seconds: 604_800,
      },
    },
    credits: { balance: "12.5", has_credits: true, unlimited: false },
  }, 1_700_000_000_000);

  assert.equal(quota.kind, "codex");
  assert.equal(quota.plan, "plus");
  assert.deepEqual(quota.windows.map((window) => ({
    kind: window.kind,
    used: window.usedPercent,
    seconds: window.windowSeconds,
  })), [
    { kind: "primary", used: 22, seconds: 18_000 },
    { kind: "secondary", used: 43, seconds: 604_800 },
  ]);
  assert.equal(quota.windows[0]?.resetAt, 1_766_948_068_000);
  assert.deepEqual(quota.credits, { balance: 12.5, hasCredits: true, unlimited: false });
});

test("Codex quota keeps valid model-specific windows and clamps percentages", () => {
  const quota = parseCodexQuota({
    rate_limit: { primary_window: { used_percent: -4 } },
    additional_rate_limits: [
      {
        limit_name: "Codex Spark",
        rate_limit: {
          primary_window: { used_percent: 130, limit_window_seconds: 18_000 },
          secondary_window: { used_percent: "bad" },
        },
      },
    ],
  });

  assert.equal(quota.kind, "codex");
  assert.equal(quota.windows[0]?.usedPercent, 0);
  assert.deepEqual(quota.windows[1], {
    id: "additional:0:primary",
    kind: "additional",
    name: "Codex Spark",
    usedPercent: 100,
    windowSeconds: 18_000,
  });
});

test("OpenAI API credit quota maps balance and the next future expiry", () => {
  const now = 1_700_000_000_000;
  const quota = parseOpenAICreditQuota({
    total_granted: 100,
    total_used: "37.25",
    total_available: 62.75,
    grants: {
      data: [
        { expires_at: 1_600_000_000 },
        { expires_at: 1_800_000_000 },
        { expires_at: 1_750_000_000 },
      ],
    },
  }, now);

  assert.deepEqual(quota, {
    providerId: "openai",
    kind: "api-credits",
    fetchedAt: now,
    totalGranted: 100,
    totalUsed: 37.25,
    totalAvailable: 62.75,
    nextExpiry: 1_750_000_000_000,
  });
});

test("quota parsing rejects payloads without usable allowance data", () => {
  assert.throws(() => parseCodexQuota({ rate_limit: {} }), /额度数据无效/);
  assert.throws(() => parseOpenAICreditQuota({ total_granted: 1 }), /额度数据无效/);
});

test("Codex account id is read from the access token claim", () => {
  const header = Buffer.from(JSON.stringify({ alg: "none" })).toString("base64url");
  const payload = Buffer.from(JSON.stringify({
    "https://api.openai.com/auth": { chatgpt_account_id: "account-123" },
  })).toString("base64url");
  assert.equal(openAICodexAccountId(`${header}.${payload}.signature`), "account-123");
  assert.equal(openAICodexAccountId("not-a-jwt"), undefined);
});
