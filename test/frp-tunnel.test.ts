import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { frpProblems, frpPublicUrl, readFrpConfig, renderFrpcToml, type FrpConfig } from "../src/shared/frp.ts";
import { readFrpSettings, saveFrpSettings, writeFrpcConfig } from "../src/main/server/frp-store.ts";
import { TunnelRunner, frpFatal } from "../src/main/server/tunnel.ts";

/**
 * The self-hosted frp tunnel.
 *
 * frp is the one provider whose URL is not in its output, so what can go silently wrong
 * is different from cloudflared and ngrok: a URL derived from the wrong field shows a QR
 * code for an address nothing listens on, and a config rendered with the token in the
 * wrong key logs in anonymously and is refused by a server whose error we then have to
 * recognise. Both are pinned here, along with the store keeping the token out of reach.
 */

const silent = { info: () => undefined, warn: () => undefined, error: () => undefined };

const BASE: FrpConfig = {
  serverAddr: "frp.example.com",
  serverPort: 7000,
  token: 'se"cret',
  mode: "http",
  domain: "fv.example.com",
  vhostPort: null,
  remotePort: null,
  publicUrl: "",
  proxyName: "fastvibe-abc123",
};

test("the public URL is derived from the mode, and the override wins", () => {
  assert.equal(frpPublicUrl(BASE), "http://fv.example.com");
  assert.equal(frpPublicUrl({ ...BASE, vhostPort: 8080 }), "http://fv.example.com:8080");
  assert.equal(frpPublicUrl({ ...BASE, vhostPort: 80 }), "http://fv.example.com");
  assert.equal(frpPublicUrl({ ...BASE, mode: "tcp", remotePort: 17777 }), "http://frp.example.com:17777");
  assert.equal(frpPublicUrl({ ...BASE, mode: "tcp", serverAddr: "2001:db8::1", remotePort: 17777 }), "http://[2001:db8::1]:17777");
  // TLS in front of frps is expressed as the override, and that is what the phone opens.
  assert.equal(frpPublicUrl({ ...BASE, publicUrl: "https://fv.example.com/" }), "https://fv.example.com");
});

test("validation names the field, and refuses what would break the TOML", () => {
  assert.deepEqual(frpProblems(BASE), []);
  const fields = (config: Partial<FrpConfig>) => frpProblems({ ...BASE, ...config }).map((p) => p.field);
  assert.deepEqual(fields({ serverAddr: 'evil"\nserverPort = 1' }), ["serverAddr"]);
  assert.deepEqual(fields({ serverPort: 0 }), ["serverPort"]);
  assert.deepEqual(fields({ domain: "" }), ["domain"]);
  assert.deepEqual(fields({ mode: "tcp", remotePort: null }), ["remotePort"]);
  assert.deepEqual(fields({ publicUrl: "ftp://x" }), ["publicUrl"]);
  // tcp needs no domain at all.
  assert.deepEqual(fields({ mode: "tcp", domain: "", remotePort: 17777 }), []);
});

test("the TOML carries the token as a quoted string and exits on a refused login", () => {
  const toml = renderFrpcToml(BASE, 7777);
  assert.match(toml, /^serverAddr = "frp\.example\.com"$/m);
  assert.match(toml, /^auth\.token = "se\\"cret"$/m);
  assert.match(toml, /^loginFailExit = true$/m);
  assert.match(toml, /^localIP = "127\.0\.0\.1"$/m);
  assert.match(toml, /^localPort = 7777$/m);
  assert.match(toml, /^customDomains = \["fv\.example\.com"\]$/m);
  assert.doesNotMatch(toml, /remotePort/);

  const tcp = renderFrpcToml({ ...BASE, mode: "tcp", remotePort: 17777, token: "" }, 7777);
  assert.match(tcp, /^remotePort = 17777$/m);
  assert.doesNotMatch(tcp, /auth\./);
  assert.doesNotMatch(tcp, /customDomains/);
});

test("the store keeps the token when the pane sends none, and writes privately", () => {
  const dir = mkdtempSync(join(tmpdir(), "fv-frp-"));
  const file = join(dir, "frp.json");
  const { token: _token, proxyName: _name, ...form } = BASE;

  const first = saveFrpSettings(file, { ...form, token: "t1" });
  assert.match(first.proxyName, /^fastvibe-[0-9a-f]{6}$/);
  // An edit without a token keeps it, and keeps the proxy name frps knows us by.
  const second = saveFrpSettings(file, { ...form, domain: "other.example.com" });
  assert.equal(second.token, "t1");
  assert.equal(second.proxyName, first.proxyName);
  // An empty string is an explicit clear.
  assert.equal(saveFrpSettings(file, { ...form, token: "" }).token, "");
  assert.throws(() => saveFrpSettings(file, { ...form, domain: "" }));
  assert.equal(readFrpSettings(file)?.domain, "fv.example.com");

  if (process.platform !== "win32") {
    assert.equal(statSync(file).mode & 0o777, 0o600);
    const toml = join(dir, "frpc.toml");
    writeFrpcConfig(toml, second, 7777);
    assert.equal(statSync(toml).mode & 0o777, 0o600);
    assert.match(readFileSync(toml, "utf8"), /localPort = 7777/);
  }
});

test("a config on disk with a bad proxy name is ignored rather than rendered", () => {
  assert.equal(readFrpConfig({ ...BASE, proxyName: 'x"]\n[[proxies]]' }), null);
  assert.equal(readFrpConfig({ ...BASE })?.proxyName, "fastvibe-abc123");
});

test("frpc's refusals end the run in its own words; a dropped connection does not", () => {
  assert.match(
    frpFatal("2026-09-23 10:00:00.000 [E] [client/service.go:295] login to the server failed: token in login doesn't match token from configuration")?.message ?? "",
    /token/,
  );
  assert.match(
    frpFatal("2026-09-23 10:00:00.000 [W] [client/control.go:168] [abc] [fastvibe-abc123] start error: port already used")?.message ?? "",
    /port already used$/,
  );
  assert.equal(frpFatal("[W] [client/service.go:1] connect to server error: dial tcp 1.2.3.4:7000: connection refused"), null);
});

test("a first login that cannot reach frps sends the user to the security group, with the port", () => {
  const blocked = frpFatal(
    "2026/09/23 10:00:00 [W] [client/service.go:295] login to the server failed: dial tcp 203.0.113.7:7000: i/o timeout. With loginFailExit enabled, no additional retries will be attempted",
  )?.message ?? "";
  assert.match(blocked, /安全组/);
  assert.match(blocked, /TCP 7000/);
  assert.match(blocked, /203\.0\.113\.7:7000/);
  // A refusal is somebody answering: frps is down or elsewhere, not a security group.
  const refused = frpFatal("[W] login to the server failed: dial tcp 203.0.113.7:7000: connect: connection refused")?.message ?? "";
  assert.match(refused, /没有程序在监听/);
  assert.doesNotMatch(refused, /安全组/);
});

/** A stand-in frpc: a Node script piped exactly as the real spawn pipes one. */
function script(source: string) {
  return () => spawn(process.execPath, ["-e", source], { stdio: ["ignore", "pipe", "pipe"] });
}

test("frp comes online at the derived URL when frpc registers the proxy", async () => {
  const runner = new TunnelRunner({
    log: silent,
    launch: script(`
      console.log("2026-09-23 10:00:00.000 [I] [client/service.go:295] [abc] login to server success, get run id [abc]");
      console.log("2026-09-23 10:00:00.100 [I] [client/control.go:168] [abc] [fastvibe-abc123] start proxy success");
      setInterval(() => {}, 1000);
    `),
  });
  const status = await runner.start("frp", 7777, { configFile: "/tmp/frpc.toml", publicUrl: "https://fv.example.com" });
  assert.equal(status.phase, "online");
  assert.equal(status.url, "https://fv.example.com");
  await runner.stop();
});

test("a proxy frps refuses ends the run instead of waiting out the timeout", async () => {
  const runner = new TunnelRunner({
    log: silent,
    startTimeoutMs: 20_000,
    launch: script(`
      console.log("[I] [client/service.go:295] [abc] login to server success");
      console.log("[W] [client/control.go:168] [abc] [fastvibe-abc123] start error: router config conflict");
      setInterval(() => {}, 1000);
    `),
  });
  const status = await runner.start("frp", 7777, { configFile: "/tmp/frpc.toml", publicUrl: "http://fv.example.com" });
  assert.equal(status.phase, "error");
  assert.match(status.error ?? "", /router config conflict/);
  await runner.stop();
});

test("frp with no saved config says so without spawning anything", async () => {
  let spawned = false;
  const runner = new TunnelRunner({
    log: silent,
    launch: () => {
      spawned = true;
      return script("")();
    },
  });
  const status = await runner.start("frp", 7777);
  assert.equal(status.phase, "error");
  assert.equal(spawned, false);
});
