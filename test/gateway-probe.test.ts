import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  fetchGatewayBalance,
  gatewayTargets,
  probeGateway,
  readGatewayCredentials,
  statusLooksLikeNewApi,
  writeGatewayCredentials,
} from "../src/main/engine/gateway-probe.ts";

/** A `fetch` stand-in that answers from a route table. */
function stub(routes: Record<string, { status?: number; body?: unknown; type?: string }>) {
  const calls: string[] = [];
  const impl = (async (input: string | URL | Request) => {
    const url = String(input);
    calls.push(url);
    const route = routes[url];
    if (!route) return new Response("", { status: 404, headers: { "content-type": "text/html" } });
    return new Response(typeof route.body === "string" ? route.body : JSON.stringify(route.body ?? {}), {
      status: route.status ?? 200,
      headers: { "content-type": route.type ?? "application/json; charset=utf-8" },
    });
  }) as typeof fetch;
  return { impl, calls };
}

test("a base URL is split into the origin to probe and the path in front of the version", () => {
  // A Base URL ending in a known version segment has it dropped: the model list lives
  // under /v1, the panel does not.
  assert.deepEqual(gatewayTargets("https://gw.example.com/v1"), [
    { origin: "https://gw.example.com", prefix: "" },
  ]);
  assert.deepEqual(gatewayTargets("https://gw.example.com/v1beta"), [
    { origin: "https://gw.example.com", prefix: "" },
  ]);
  // A relay mounted under a path of its own keeps it — that path *is* where it lives.
  assert.deepEqual(gatewayTargets("https://host/relay/v1"), [
    { origin: "https://host", prefix: "/relay" },
  ]);
  // A base with no recognisable version segment is tried as typed, then at the origin.
  assert.deepEqual(gatewayTargets("https://host/coding/paas/v4"), [
    { origin: "https://host", prefix: "/coding/paas/v4/v1" },
    { origin: "https://host", prefix: "/coding/paas/v4" },
  ]);
  assert.deepEqual(gatewayTargets("https://host"), [
    { origin: "https://host", prefix: "/v1" },
    { origin: "https://host", prefix: "" },
  ]);
  assert.equal(gatewayTargets("   ").length, 0);
  assert.equal(gatewayTargets("not a url at all").length, 0);
});

test("sub2api is recognised by its own setup route", async () => {
  const { impl, calls } = stub({
    "https://relay.example.com/setup/status": { body: { code: 0, data: { needs_setup: false, step: "completed" } } },
  });
  assert.equal(await probeGateway("https://relay.example.com/v1", impl), "sub2api");
  // The panel route is the only thing asked; nothing here carries a credential.
  assert.deepEqual(calls, ["https://relay.example.com/setup/status"]);
});

test("an SPA catch-all cannot claim to be sub2api", async () => {
  // new-api answers `200 text/html` for every unknown path, /setup/status included.
  const { impl } = stub({
    "https://newapi.example.com/setup/status": { body: "<!doctype html><html></html>", type: "text/html; charset=utf-8" },
    "https://newapi.example.com/api/status": {
      body: { success: true, data: { system_name: "New API", version: "v1.0.0", quota_per_unit: 500_000 } },
    },
  });
  assert.equal(await probeGateway("https://newapi.example.com/v1", impl), "new-api");
});

test("an unrecognisable endpoint is unidentified rather than guessed", async () => {
  const { impl } = stub({});
  assert.equal(await probeGateway("https://plain.example.com/v1", impl), undefined);
});

test("a sub2api mounted under a sub-path is probed under it, not at the origin", async () => {
  const { impl, calls } = stub({
    "https://host/relay/setup/status": { body: { code: 0, data: { needs_setup: false, step: "completed" } } },
  });
  assert.equal(await probeGateway("https://host/relay/v1", impl), "sub2api");
  // The bare origin is never asked: that would probe whatever else lives there.
  assert.deepEqual(calls, ["https://host/relay/setup/status"]);
});

test("the new-api status envelope is accepted on its own evidence", () => {
  assert.equal(statusLooksLikeNewApi({ success: true, data: { version: "v0.6.0" } }), true);
  // A rebranded deployment renames `system_name`; the software still says so another way.
  assert.equal(statusLooksLikeNewApi({ success: true, data: { system_name: "词海" } }), true);
  assert.equal(statusLooksLikeNewApi({ success: true, data: { quota_per_unit: 500_000 } }), true);
  assert.equal(statusLooksLikeNewApi({ success: true, data: {} }), false);
  assert.equal(statusLooksLikeNewApi({ success: false, data: { version: "v1" } }), false);
  assert.equal(statusLooksLikeNewApi({ data: { version: "v1" } }), false);
  assert.equal(statusLooksLikeNewApi({ success: true }), false);
});

test("a new-api balance is read from the panel, with the credential it needs", async () => {
  const { impl, calls } = stub({
    "https://relay.example.com/api/user/self": {
      body: { success: true, data: { id: 7, username: "cx", quota: 600_000 } },
    },
    "https://relay.example.com/api/status": { body: { success: true, data: { quota_per_unit: 500_000 } } },
  });
  const balance = await fetchGatewayBalance(
    {
      origin: "https://relay.example.com",
      prefix: "",
      apiKey: "sk-relay",
      kind: "new-api",
      dashboard: { accessToken: "panel-token", userId: "7" },
    },
    impl,
  );
  assert.equal(balance.available, 1.2);
  assert.equal(balance.unlimited, false);
  // The relay key is not what the panel authenticates, so it is not what is sent.
  assert.deepEqual(calls, ["https://relay.example.com/api/user/self", "https://relay.example.com/api/status"]);
});

test("the panel credential is a header pair, and only what was given is sent", async () => {
  const seen: Array<Record<string, string>> = [];
  const impl = (async (input: string | URL | Request, init?: RequestInit) => {
    seen.push((init?.headers ?? {}) as Record<string, string>);
    const url = String(input);
    const body = url.includes("/api/user/self")
      ? { success: true, data: { quota: 500_000 } }
      : { success: true, data: { quota_per_unit: 500_000 } };
    return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
  await fetchGatewayBalance(
    { origin: "https://h", prefix: "", apiKey: "sk", kind: "new-api", dashboard: { accessToken: "tok", userId: "" } },
    impl,
  );
  assert.equal(seen[0].Authorization, "Bearer tok");
  // An empty user id is omitted rather than sent blank, which the panel would reject.
  assert.equal(seen[0]["New-Api-User"], undefined);
});

test("without a panel credential the read asks for one instead of reporting a failure", async () => {
  const { impl, calls } = stub({});
  await assert.rejects(
    fetchGatewayBalance({ origin: "https://h", prefix: "", apiKey: "sk-relay", kind: "new-api" }, impl),
    (error: Error) => error.message.includes("面板访问令牌"),
  );
  // Nothing was attempted: the relay key would only ever be refused.
  assert.deepEqual(calls, []);
});

test("an unlimited panel account reads from its sentinel rather than as a negative balance", async () => {
  const { impl } = stub({
    "https://h/api/user/self": { body: { success: true, data: { quota: -1 } } },
  });
  const balance = await fetchGatewayBalance(
    { origin: "https://h", prefix: "", apiKey: "sk", kind: "new-api", dashboard: { accessToken: "t", userId: "1" } },
    impl,
  );
  assert.equal(balance.unlimited, true);
  assert.equal(balance.available, undefined);
});
test("a sub2api balance is the wallet its own 余额 route reports", async () => {
  const { impl, calls } = stub({
    "https://relay.example.com/v1/usage": { body: { mode: "unrestricted", planName: "钱包余额", remaining: 12.3456, unit: "USD" } },
  });
  const balance = await fetchGatewayBalance(
    { origin: "https://relay.example.com", prefix: "", apiKey: "sk-test", kind: "sub2api" },
    impl,
  );
  assert.equal(balance.available, 12.3456);
  assert.equal(balance.unlimited, false);
  assert.deepEqual(calls, ["https://relay.example.com/v1/usage"]);
});

test("a sub2api key the panel gives no figure for reads as unlimited, not as an error", async () => {
  // A subscription group reports `remaining` too, but a key with neither a budget nor a
  // wallet has nothing to report — the panel says so by answering with a unit and no
  // amount rather than by failing.
  const { impl } = stub({
    "https://relay.example.com/v1/usage": { body: { mode: "unrestricted", unit: "USD", isValid: true } },
  });
  const balance = await fetchGatewayBalance(
    { origin: "https://relay.example.com", prefix: "", apiKey: "sk-test", kind: "sub2api" },
    impl,
  );
  assert.equal(balance.unlimited, true);
});

test("a balance read refuses an unidentified gateway and a missing key", async () => {
  const { impl } = stub({});
  await assert.rejects(
    fetchGatewayBalance({ origin: "https://h", prefix: "", apiKey: "sk", kind: "unknown" }, impl),
  );
  await assert.rejects(
    fetchGatewayBalance({ origin: "https://h", prefix: "", apiKey: "  ", kind: "new-api" }, impl),
  );
});

test("the panel credential is stored 0600, survives a re-read, and clears on an empty token", () => {
  const dir = mkdtempSync(join(tmpdir(), "fastvibe-gw-"));
  const file = join(dir, "gateway-credentials.json");
  try {
    assert.deepEqual(readGatewayCredentials(file), {}, "a missing file is not an error");

    writeGatewayCredentials(file, { "custom-relay": { accessToken: "tok", userId: "7" } });
    assert.equal(statSync(file).mode & 0o777, 0o600);
    assert.deepEqual(readGatewayCredentials(file), { "custom-relay": { accessToken: "tok", userId: "7" } });

    // An empty token is how the dialog clears one; the entry goes with it rather than
    // lingering as a row that claims a credential exists.
    writeGatewayCredentials(file, { "custom-relay": { accessToken: "", userId: "" } });
    assert.deepEqual(readGatewayCredentials(file), {});
    assert.equal(readFileSync(file, "utf8"), "");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
