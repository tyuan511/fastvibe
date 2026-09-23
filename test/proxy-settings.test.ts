import { test } from "node:test";
import assert from "node:assert/strict";
import {
  DEFAULT_PROXY_SETTINGS, proxySettingsOf, assertProxySettings, chromiumProxyConfig,
  validProxyHost, validProxyPort, proxyUrlFromResolution, isProxyLoopback, mergeSettingsPreservingProxy,
} from "../src/shared/proxy.ts";

test("proxy defaults are disabled, and malformed preferences cannot enable them", () => {
  assert.deepEqual(proxySettingsOf({}), DEFAULT_PROXY_SETTINGS);
  assert.equal(DEFAULT_PROXY_SETTINGS.proxyEnabled, false);
  assert.deepEqual(chromiumProxyConfig(DEFAULT_PROXY_SETTINGS), { mode: "direct" });
  assert.deepEqual(proxySettingsOf({ proxyEnabled: "true", proxyMode: "bad", proxyProtocol: "bad", proxyHost: "http://evil", proxyPort: "8080" }), DEFAULT_PROXY_SETTINGS);
});

test("an unrelated save from a stale client cannot disable or restore another client's proxy", () => {
  const enabled = { ...DEFAULT_PROXY_SETTINGS, proxyEnabled: true, proxyMode: "custom" as const, proxyPort: 1080 };
  const stale = { ...DEFAULT_PROXY_SETTINGS, themeMode: "dark" };
  assert.deepEqual(mergeSettingsPreservingProxy(enabled, stale), { ...enabled, themeMode: "dark" });
  // An old enabled snapshot cannot undo an explicit reset either.
  assert.deepEqual(proxySettingsOf(mergeSettingsPreservingProxy({}, enabled)), DEFAULT_PROXY_SETTINGS);
});

test("system and custom modes produce explicit Chromium rules, including IPv6", () => {
  assert.deepEqual(chromiumProxyConfig(proxySettingsOf({ proxyEnabled: true })), { mode: "system" });
  for (const proxyProtocol of ["http", "socks5"] as const) {
    const settings = { proxyEnabled: true, proxyMode: "custom", proxyProtocol, proxyHost: "[::1]", proxyPort: 1080 };
    assert.doesNotThrow(() => assertProxySettings(settings));
    assert.deepEqual(chromiumProxyConfig(proxySettingsOf(settings)), {
      mode: "fixed_servers", proxyRules: `${proxyProtocol}://[::1]:1080`, proxyBypassRules: "localhost;127.0.0.1;[::1]",
    });
    assert.deepEqual(chromiumProxyConfig(proxySettingsOf({ ...settings, proxyEnabled: false })), { mode: "direct" });
  }
});

test("hosts and ports reject URLs, credentials, rule injection and malformed IPv6", () => {
  for (const host of ["localhost", "proxy.example.invalid", "PROXY.example.invalid", "127.0.0.1", "[::1]", "[2001:db8::1]"]) assert.equal(validProxyHost(host), true, host);
  for (const host of [undefined, null, 123, "", " proxy.invalid", "proxy.invalid ", "proxy.invalid\n", "http://proxy.invalid", "user:pass@proxy.invalid", "proxy.invalid:80", "proxy.invalid/path", "proxy.invalid?x", "proxy.invalid#x", "proxy.invalid;DIRECT", "proxy.invalid,other", "http=proxy.invalid", "proxy\\evil", "::1", "[::gg]", "[::1]:80"]) {
    assert.equal(validProxyHost(host), false, String(host));
    assert.throws(() => assertProxySettings({ ...DEFAULT_PROXY_SETTINGS, proxyEnabled: true, proxyMode: "custom", proxyHost: host }), /Invalid proxy/);
  }
  for (const port of [1, 80, 65535]) assert.equal(validProxyPort(port), true);
  for (const port of [undefined, null, "80", "80;DIRECT", 0, -1, 65536, 1.5, NaN, Infinity]) {
    assert.equal(validProxyPort(port), false, String(port));
    assert.throws(() => assertProxySettings({ ...DEFAULT_PROXY_SETTINGS, proxyEnabled: true, proxyMode: "custom", proxyPort: port }), /Invalid proxy/);
  }
  assert.throws(() => assertProxySettings({ ...DEFAULT_PROXY_SETTINGS, proxyEnabled: true, proxyMode: "custom", proxyProtocol: "https" }), /Invalid proxy/);
  assert.doesNotThrow(() => assertProxySettings({ proxyEnabled: false, proxyMode: "custom" }));
  assert.doesNotThrow(() => assertProxySettings({ proxyEnabled: true, proxyMode: "system" }));
});

test("only loopback literals and localhost bypass the proxy, never 127-prefixed domains", () => {
  for (const host of ["127.0.0.1", "127.1", "[::1]", "localhost"]) {
    assert.equal(isProxyLoopback(`http://${host}/path`), true, host);
  }
  for (const host of ["127.example.com", "127.0.0.1.example.com", "localhost.example.com", "128.0.0.1", "[::2]"]) {
    assert.equal(isProxyLoopback(`http://${host}/path`), false, host);
  }
});

test("PAC respects the first decision, never replacing a failed/unsupported proxy with DIRECT", () => {
  for (const [resolution, expected] of [
    ["DIRECT", ""], [" DIRECT ; PROXY ignored.invalid:80", ""],
    ["PROXY proxy.invalid:8080; DIRECT", "http://proxy.invalid:8080"],
    ["HTTPS proxy.invalid:443; DIRECT", "https://proxy.invalid:443"],
    ["SOCKS5 [2001:db8::1]:1080; DIRECT", "socks5h://[2001:db8::1]:1080"],
    ["PROXY first.invalid:80; PROXY second.invalid:80", "http://first.invalid:80"],
  ]) assert.equal(proxyUrlFromResolution(resolution), expected);
  assert.throws(() => proxyUrlFromResolution("SOCKS proxy.invalid:1080; DIRECT"), /SOCKS4 proxy is unsupported/);
  for (const resolution of ["", "garbage; DIRECT", "SOCKS4 proxy.invalid:80; DIRECT", "PROXY; DIRECT", "; DIRECT"]) {
    assert.throws(() => proxyUrlFromResolution(resolution), /Unsupported system proxy/);
  }
});
