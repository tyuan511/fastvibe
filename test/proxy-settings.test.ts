import { test } from "node:test";
import assert from "node:assert/strict";
import {
  DEFAULT_PROXY_SETTINGS, LEGACY_PROXY_KEYS, proxySettingsOf, assertProxySettings, chromiumProxyConfig,
  validProxyHost, validProxyPort, normalizeProxyUrl, proxyUrlOf, proxyUrlFromResolution, isProxyLoopback,
  mergeSettingsPreservingProxy,
} from "../src/shared/proxy.ts";

test("proxy defaults are disabled, and malformed preferences cannot enable them", () => {
  assert.deepEqual(proxySettingsOf({}), DEFAULT_PROXY_SETTINGS);
  assert.equal(DEFAULT_PROXY_SETTINGS.proxyEnabled, false);
  assert.deepEqual(chromiumProxyConfig(DEFAULT_PROXY_SETTINGS), { mode: "direct" });
  assert.deepEqual(proxySettingsOf({ proxyEnabled: "true", proxyMode: "bad", proxyUrl: 8080 }), DEFAULT_PROXY_SETTINGS);
});

test("the address an earlier build wrote in three fields still routes", () => {
  const legacy = { proxyEnabled: true, proxyMode: "custom", proxyProtocol: "socks5", proxyHost: "proxy.example.invalid", proxyPort: 1080 };
  assert.equal(proxyUrlOf(legacy), "socks5://proxy.example.invalid:1080");
  assert.deepEqual(chromiumProxyConfig(proxySettingsOf(legacy)).proxyRules, "socks5://proxy.example.invalid:1080");
  assert.equal(proxyUrlOf({ ...legacy, proxyProtocol: "http" }), "http://proxy.example.invalid:1080");
  // Half a legacy config is no config: it must not invent an address out of one part.
  assert.equal(proxyUrlOf({ proxyEnabled: true, proxyMode: "custom", proxyHost: "proxy.example.invalid" }), null);
  assert.throws(() => assertProxySettings({ proxyEnabled: true, proxyMode: "custom", proxyHost: "proxy.example.invalid" }), /Invalid proxy/);
  // Once the new field is there it wins outright, garbage included: a half-typed address
  // must not resurrect the parts an older build left beside it in the same object.
  assert.equal(proxyUrlOf({ ...legacy, proxyUrl: "http://" }), null);
  assert.deepEqual([...LEGACY_PROXY_KEYS], ["proxyProtocol", "proxyHost", "proxyPort"]);
});

test("an unrelated save from a stale client cannot disable or restore another client's proxy", () => {
  const enabled = { ...DEFAULT_PROXY_SETTINGS, proxyEnabled: true, proxyMode: "custom" as const, proxyUrl: "http://127.0.0.1:1080" };
  const stale = { ...DEFAULT_PROXY_SETTINGS, themeMode: "dark" };
  assert.deepEqual(mergeSettingsPreservingProxy(enabled, stale), { ...enabled, themeMode: "dark" });
  // An old enabled snapshot cannot undo an explicit reset either.
  assert.deepEqual(proxySettingsOf(mergeSettingsPreservingProxy({}, enabled)), DEFAULT_PROXY_SETTINGS);
});

test("system and custom modes produce explicit Chromium rules, including IPv6", () => {
  assert.deepEqual(chromiumProxyConfig(proxySettingsOf({ proxyEnabled: true })), { mode: "system" });
  for (const scheme of ["http", "https", "socks5", "socks5h"] as const) {
    const settings = { proxyEnabled: true, proxyMode: "custom", proxyUrl: `${scheme}://[::1]:1080` };
    assert.doesNotThrow(() => assertProxySettings(settings));
    assert.deepEqual(chromiumProxyConfig(proxySettingsOf(settings)), {
      mode: "fixed_servers", proxyRules: `${scheme}://[::1]:1080`, proxyBypassRules: "localhost;127.0.0.1;[::1]",
    });
    assert.deepEqual(chromiumProxyConfig(proxySettingsOf({ ...settings, proxyEnabled: false })), { mode: "direct" });
  }
});

test("an address keeps what a person typed, and drops nothing but the scheme's case", () => {
  // `URL` answers port "" for a port equal to its scheme's default, so parsing by hand is
  // what keeps `:80` in the rule instead of quietly letting Chromium guess.
  assert.equal(normalizeProxyUrl("HTTP://Proxy.Example.INVALID:80"), "http://Proxy.Example.INVALID:80");
  assert.equal(normalizeProxyUrl("http://h:80"), "http://h:80");
  assert.equal(normalizeProxyUrl("socks5://[2001:db8::1]:1080"), "socks5://[2001:db8::1]:1080");
  // The port may be left off; the scheme's own then applies, in Chromium and in Node alike.
  assert.equal(normalizeProxyUrl("http://proxy.corp"), "http://proxy.corp");
});

test("an address rejects credentials, paths, rule injection, other schemes and bad ports", () => {
  for (const url of [
    undefined, null, 8080, "", "   ", "http:// ", " http://h:1", "h:8080", "proxy.example.invalid:8080",
    "http://user:pass@proxy.invalid:8080", "http://proxy.invalid:8080/path", "http://proxy.invalid:8080?x=1",
    "http://proxy.invalid:8080#x", "http://proxy.invalid:8080;DIRECT", "http://a,http://b",
    "http://proxy.invalid:0", "http://proxy.invalid:99999", "http://proxy.invalid:abc", "http://[::gg]:1",
    "ftp://proxy.invalid:21", "socks4://proxy.invalid:1080", "http://:8080",
  ]) {
    assert.equal(normalizeProxyUrl(url), null, String(url));
    assert.throws(() => assertProxySettings({ proxyEnabled: true, proxyMode: "custom", proxyUrl: url }), /Invalid proxy/);
  }
  assert.doesNotThrow(() => assertProxySettings({ proxyEnabled: false, proxyMode: "custom", proxyUrl: "garbage" }));
  assert.doesNotThrow(() => assertProxySettings({ proxyEnabled: true, proxyMode: "system" }));
});

test("hosts and ports reject URLs, credentials, rule injection and malformed IPv6", () => {
  // Still the rules behind an address's host part, and behind reading a legacy settings
  // file — so they stay pinned here even though the pane only asks for one field now.
  for (const host of ["localhost", "proxy.example.invalid", "PROXY.example.invalid", "127.0.0.1", "[::1]", "[2001:db8::1]"]) assert.equal(validProxyHost(host), true, host);
  for (const host of [undefined, null, 123, "", " proxy.invalid", "proxy.invalid ", "proxy.invalid\n", "http://proxy.invalid", "user:pass@proxy.invalid", "proxy.invalid:80", "proxy.invalid/path", "proxy.invalid?x", "proxy.invalid#x", "proxy.invalid;DIRECT", "proxy.invalid,other", "http=proxy.invalid", "proxy\\evil", "::1", "[::gg]", "[::1]:80"]) {
    assert.equal(validProxyHost(host), false, String(host));
    if (typeof host === "string") assert.equal(normalizeProxyUrl(`http://${host}:8080`), null, host);
  }
  for (const port of [1, 80, 65535]) assert.equal(validProxyPort(port), true);
  for (const port of [undefined, null, "80", "80;DIRECT", 0, -1, 65536, 1.5, NaN, Infinity]) {
    assert.equal(validProxyPort(port), false, String(port));
    assert.equal(proxyUrlOf({ proxyHost: "proxy.example.invalid", proxyPort: port }), null, String(port));
  }
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
