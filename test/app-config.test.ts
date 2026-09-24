import { test } from "node:test";
import assert from "node:assert/strict";
import { handle } from "../src/main/ipc/registry.ts";
import { Ipc } from "../src/shared/ipc.ts";
import { APP_CONFIG_CATALOG } from "../src/shared/app-config.ts";
import { runAppConfig } from "../src/main/app-config.ts";

// Stand-ins for the handlers the settings panes call. The table under test dispatches
// into the real registry, so these are what it reaches.
const writes: Array<{ channel: string; payload: unknown }> = [];
let settings: Record<string, unknown> = { themeMode: "dark", permissionMode: "smart" };
let mcp = [
  { id: "a", name: "A", enabled: true, transport: "stdio", command: "a", connected: true, tools: ["x"] },
  { id: "b", name: "B", enabled: true, transport: "http", url: "https://b", connected: false, tools: [] },
];
const frp = { serverAddr: "1.2.3.4", serverPort: 7000, mode: "http", domain: "fv.example.com", vhostPort: 8080, remotePort: null, publicUrl: "", proxyName: "fastvibe-abc", hasToken: true };

handle(Ipc.settingsGet, () => settings);
handle(Ipc.settingsSet, (payload: Record<string, unknown>) => {
  writes.push({ channel: Ipc.settingsSet, payload });
  settings = payload;
});
handle(Ipc.engineListMcpServers, () => mcp);
handle(Ipc.engineSaveMcpServers, (payload: { configs: typeof mcp }) => {
  writes.push({ channel: Ipc.engineSaveMcpServers, payload });
  mcp = payload.configs.map((item) => ({ ...item, connected: false, tools: [] }));
  return mcp;
});
handle(Ipc.remoteFrpGet, () => frp);
handle(Ipc.remoteFrpSet, (payload: unknown) => {
  writes.push({ channel: Ipc.remoteFrpSet, payload });
  return payload;
});
handle(Ipc.sshHosts, () => ({ saved: [{ id: "h", host: "vps", password: "hunter2", hasPassword: true }], discovered: [] }));

test("an unknown action is answered with the catalog, not a throw", async () => {
  const result = await runAppConfig({ action: "remote.hack" });
  assert.equal(result.ok, false);
  assert.match(!result.ok ? result.error : "", /remote\.frp_set/);
});

test("the read tool cannot reach a write action", async () => {
  const result = await runAppConfig({ action: "settings.set", input: { patch: { themeMode: "light" } } });
  assert.equal(result.ok, false);
  assert.equal(writes.length, 0);
});

test("the agent cannot write its own permission mode", async () => {
  for (const key of ["permissionMode", "defaultPermissionMode", "fullAccessConfirmed", "permissionAlways", "remoteEnabled", "proxyUrl"]) {
    const result = await runAppConfig({ action: "settings.set", input: { patch: { [key]: "full" } }, write: true });
    assert.equal(result.ok, false, key);
  }
  assert.equal(settings.permissionMode, "smart");
});

test("settings.set merges the patch into what is stored", async () => {
  const result = await runAppConfig({ action: "settings.set", input: { patch: { keepAwake: false } }, write: true });
  assert.equal(result.ok, true);
  assert.deepEqual(settings, { themeMode: "dark", permissionMode: "smart", keepAwake: false });
});

test("ssh hosts never carry a password back to the model", async () => {
  const result = await runAppConfig({ action: "ssh.hosts" });
  assert.equal(result.ok, true);
  assert.equal(JSON.stringify(result.ok && result.value).includes("hunter2"), false);
});

test("frp_set changes one field and keeps the rest of the form (and the token)", async () => {
  writes.length = 0;
  await runAppConfig({ action: "remote.frp_set", input: { vhostPort: 80 }, write: true });
  const saved = writes[0]?.payload as Record<string, unknown>;
  assert.equal(saved.vhostPort, 80);
  assert.equal(saved.domain, "fv.example.com");
  assert.equal("token" in saved, false, "an absent token keeps the stored one");
  assert.equal("proxyName" in saved || "hasToken" in saved, false);
});

test("mcp.upsert touches one server and leaves the others alone", async () => {
  await runAppConfig({ action: "mcp.upsert", input: { server: { id: "c", name: "C", transport: "stdio", command: "c" } }, write: true });
  assert.deepEqual(mcp.map((item) => item.id), ["a", "b", "c"]);
  await runAppConfig({ action: "mcp.upsert", input: { server: { id: "a", name: "A2", transport: "stdio", command: "a2" } }, write: true });
  assert.deepEqual(mcp.map((item) => item.name), ["A2", "B", "C"]);
  const removed = await runAppConfig({ action: "mcp.remove", input: { id: "missing" }, write: true });
  assert.equal(removed.ok, false);
});

test("every catalog entry says whether it reads or writes", () => {
  for (const [name, entry] of Object.entries(APP_CONFIG_CATALOG)) {
    assert.ok(entry.kind === "read" || entry.kind === "write", name);
    assert.ok(entry.summary.length > 0, name);
  }
});
