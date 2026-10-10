import { test } from "node:test";
import assert from "node:assert/strict";
import { DEFAULT_PROXY_SETTINGS } from "../src/shared/proxy.ts";
import { mergeClientSettings, remoteSettingsOf } from "../src/shared/settings-merge.ts";

test("a save from a window opened before remote access was switched on leaves it on", () => {
  // The file after `remote:start`; the window still holds what it loaded at startup.
  const file = { ...DEFAULT_PROXY_SETTINGS, themeMode: "dark", remoteEnabled: true, remotePort: 7777, remoteDeviceName: "studio" };
  const stale = { ...DEFAULT_PROXY_SETTINGS, themeMode: "dark", sidebarWidth: 300 };
  assert.deepEqual(mergeClientSettings(file, stale), { ...file, sidebarWidth: 300 });
});

test("a save from a window opened while it was on cannot switch it back on, or move the port", () => {
  const file = { ...DEFAULT_PROXY_SETTINGS, remoteEnabled: false, remotePort: 7777 };
  const stale = { ...DEFAULT_PROXY_SETTINGS, remoteEnabled: true, remotePort: 9000, remoteDeviceName: "forged" };
  assert.deepEqual(mergeClientSettings(file, stale), file);
});

test("a client cannot introduce a remote-access key the file does not have", () => {
  const merged = mergeClientSettings({}, { remoteEnabled: true, glass: false });
  assert.deepEqual(remoteSettingsOf(merged), {});
  assert.equal(merged.glass, false);
});

test("the proxy is still the file's, and ordinary preferences are still the client's", () => {
  const file = { ...DEFAULT_PROXY_SETTINGS, proxyEnabled: true, keepAwake: true };
  const merged = mergeClientSettings(file, { ...DEFAULT_PROXY_SETTINGS, keepAwake: false });
  assert.equal(merged.proxyEnabled, true);
  assert.equal(merged.keepAwake, false);
});

test("what 恢复默认 keeps is the remote-access keys and nothing else", () => {
  assert.deepEqual(
    remoteSettingsOf({ themeMode: "dark", remoteEnabled: true, remotePort: 7777, proxyEnabled: true }),
    { remoteEnabled: true, remotePort: 7777 },
  );
});
