import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { runInNewContext } from "node:vm";

const require = createRequire(import.meta.url);
const ts = require("typescript") as typeof import("typescript");
const source = readFileSync(new URL("../apps/mobile/src/session/connection.ts", import.meta.url), "utf8");
const compiled = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true } }).outputText;
const settle = async () => { for (let i = 0; i < 15; i++) await Promise.resolve(); };
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}
const server = (id: string) => ({ id, origin: `https://${id}.test`, alias: id });

/** Run the actual connection module with deterministic OS/storage/socket boundaries. */
function harness(t: TestContext, options: {
  token?: (id: string) => Promise<string | null>;
  login?: () => Promise<string>;
  call?: (method: string) => Promise<unknown>;
} = {}) {
  const clients: FakeClient[] = [];
  const writes: unknown[] = [];
  let notifications = 0;
  class FakeClient {
    address?: { origin: string };
    calls: string[] = [];
    listener: ((channel: string, payload: unknown, meta?: { epoch: string; seq: number; scope: string }) => void) | null = null;
    constructor() { clients.push(this); }
    onPush(listener: typeof this.listener) { this.listener = listener; }
    onDisconnect() {}
    setActive() {}
    checkHealth() {}
    subscribe() {}
    unsubscribe() {}
    close() {}
    async connect(address: { origin: string }) { this.address = address; }
    async login() { return options.login ? options.login() : "test-token"; }
    async call(method: string) {
      this.calls.push(method);
      if (options.call) return options.call(method);
      return method === "conversations:list" ? { projects: [], conversations: [] } : method === "settings:get" ? {} : [];
    }
    push(channel: string, payload: unknown, meta?: { epoch: string; seq: number; scope: string }) { this.listener?.(channel, payload, meta); }
  }
  const dependencies: Record<string, unknown> = {
    react: { useSyncExternalStore: (subscribe: (listener: () => void) => void, read: () => unknown) => { subscribe(() => { notifications++; }); return read(); } },
    "react-native": { AppState: { currentState: "active", addEventListener: () => {} } },
    "expo-constants": { expoConfig: { version: "test" } },
    "expo-network": { NetworkStateType: { NONE: "none" }, addNetworkStateListener: () => {}, getNetworkStateAsync: async () => ({ type: "wifi", isConnected: true }) },
    "../protocol/client": { RemoteClient: FakeClient, ConnectionError: class extends Error {} },
    "../protocol/diagnostics": { recordConnectionDiagnostic: () => {} },
    "../protocol/model-cache": { invalidateModelCatalog: () => {} },
    "../i18n": { t: (key: string) => key },
    "../protocol/address": { parseServerAddress: (origin: string) => ({ origin }) },
    "../storage/servers": {
      readToken: options.token ?? (async () => "test-token"),
      writeToken: async (...args: unknown[]) => { writes.push(args); },
      patchServer: async () => [],
    },
    "./catalog-filter": { isMobileConversation: () => true, isMobileProject: () => true },
  };
  const module = { exports: {} };
  runInNewContext(compiled, { module, exports: module.exports, require: (name: string) => {
    assert.ok(name in dependencies, `unexpected dependency ${name}`); return dependencies[name];
  }, Date, Error, setTimeout, clearTimeout }, { filename: "mobile-connection.js" });
  const api = module.exports as typeof import("../apps/mobile/src/session/connection.ts");
  api.useConnection();
  t.after(() => api.disconnect());
  return { api, clients, writes, notifications: () => notifications };
}

test("a late credential read cannot reconnect the device the user already left", async (t) => {
  const first = deferred<string>();
  const { api, clients } = harness(t, { token: (id) => id === "a" ? first.promise : Promise.resolve("b-token") });
  const old = api.connectSaved(server("a"));
  assert.equal(api.currentConnection().status, "connecting");
  await api.connectSaved(server("b"));
  first.resolve("a-token"); await old;
  assert.equal(api.currentConnection().server?.id, "b");
  assert.equal(clients.filter((client) => client.address).length, 1);
});

test("disconnect cancels an outstanding credential selection", async (t) => {
  const token = deferred<string>();
  const { api, clients } = harness(t, { token: () => token.promise });
  const pending = api.connectSaved(server("a")); api.disconnect();
  token.resolve("late-token"); await pending;
  assert.equal(api.currentConnection().status, "idle");
  assert.equal(clients.length, 0);
});

test("a late login cannot save a token or replace a newer connection", async (t) => {
  const login = deferred<string>();
  const { api, writes } = harness(t, { login: () => login.promise });
  const pending = api.loginSaved(server("a"), "test-password");
  await api.connectSaved(server("b"));
  login.resolve("late-token"); await pending;
  assert.equal(api.currentConnection().server?.id, "b");
  assert.equal(writes.length, 0);
});

test("live catalog, running and prompt updates win over a slow restoration without duplicate events", async (t) => {
  const settings = deferred<unknown>();
  const { api, clients } = harness(t, { call: async (method) => {
    if (method === "settings:get") return settings.promise;
    if (method === "engine:get-running") return ["chat"];
    if (method === "engine:get-pending-ui") return [{ type: "extension_ui_request", id: "question", conversationId: "chat", method: "confirm" }];
    return { projects: [], conversations: [{ id: "old" }] };
  } });
  const events: unknown[] = [];
  api.onEngineEvent((event) => events.push(event));
  const connected = api.connectSaved(server("a")); await settle();
  clients[0].push("workspace:changed", { projects: [], conversations: [{ id: "new" }] });
  clients[0].push("engine:event", { type: "conversation_running", conversationId: "chat", running: false });
  clients[0].push("engine:event", { type: "extension_ui_dismiss", id: "question" });
  settings.resolve({}); await connected;
  assert.equal(api.currentConnection().conversations[0].id, "new");
  assert.equal(api.currentConnection().running.chat, false);
  assert.equal(api.currentConnection().pending.length, 0);
  assert.equal(events.length, 2);
});

test("concurrent refreshes share four reads and preserve local archive writes", async (t) => {
  let slow = false;
  const settings = deferred<unknown>();
  const { api, clients, notifications } = harness(t, { call: async (method) => method === "settings:get"
    ? slow ? settings.promise : {} : method === "conversations:list" ? { projects: [], conversations: [] } : [] });
  await api.connectSaved(server("a"));
  slow = true;
  const before = clients[0].calls.length;
  const a = api.refreshConnection(), b = api.refreshConnection();
  api.setArchivedIds(["archived-now"]);
  const notified = notifications();
  settings.resolve({ archivedConversations: [] }); await Promise.all([a, b]);
  assert.equal(clients[0].calls.length - before, 4);
  assert.equal(api.currentConnection().archivedIds[0], "archived-now");
  assert.equal(notifications() - notified, 1, "restore should paint once, after applying its live overlay");
});

test("a handshaken client can restore its chat before slow catalog reads finish", async (t) => {
  const settings = deferred<unknown>();
  const { api } = harness(t, { call: async (method) => method === "settings:get" ? settings.promise : [] });
  const connected = api.connectSaved(server("a")); await settle();
  assert.ok(api.getClient(), "chat restoration must not wait for the catalog barrier");
  assert.equal(api.currentConnection().status, "connecting", "the first catalog retains its existing loading screen");
  api.applyChatSnapshot(api.getClient()!, "chat", { seq: 10, running: true, pendingUi: [] });
  assert.equal(api.currentConnection().running.chat, true);
  settings.resolve({}); await connected;
  assert.equal(api.currentConnection().running.chat, true, "the late global baseline cannot overwrite the chat snapshot");
  assert.equal(api.currentConnection().status, "ready");
});

test("parallel restoration cannot resurrect a prompt the current chat's snapshot has removed", async (t) => {
  const settings = deferred<unknown>();
  const prompt = { type: "extension_ui_request", id: "q", conversationId: "chat", method: "confirm" };
  const { api, clients } = harness(t, { call: async (method) => method === "settings:get" ? settings.promise : method === "engine:get-pending-ui" ? [prompt] : [] });
  const connected = api.connectSaved(server("a")); await settle();
  api.applyChatSnapshot(api.getClient()!, "chat", { seq: 10, running: false, pendingUi: [] });
  clients[0].push("engine:event", { ...prompt, seq: 9 });
  assert.equal(api.currentConnection().pending.length, 0, "older live status must be ignored");
  settings.resolve({}); await connected;
  assert.equal(api.currentConnection().pending.length, 0);
});

test("manual catalog refresh re-applies already-observed live events after its stale baseline", async (t) => {
  let slow = false;
  const settings = deferred<unknown>();
  const { api, clients } = harness(t, { call: async (method) => method === "settings:get" ? slow ? settings.promise : {} : method === "engine:get-running" ? ["chat"] : [] });
  await api.connectSaved(server("a"));
  api.applyChatSnapshot(api.getClient()!, "chat", { seq: 10, running: true, pendingUi: [] });
  slow = true;
  const refreshed = api.refreshConnection();
  clients[0].push("engine:event", { type: "conversation_running", conversationId: "chat", running: false, seq: 11 });
  settings.resolve({}); await refreshed;
  assert.equal(api.currentConnection().running.chat, false);
});

test("a stale chat snapshot cannot modify the replacement server's state", async (t) => {
  const { api } = harness(t);
  await api.connectSaved(server("a")); const old = api.getClient()!;
  await api.connectSaved(server("b"));
  api.applyChatSnapshot(old, "old-chat", { seq: 100, running: true, pendingUi: [] });
  assert.equal(api.currentConnection().running["old-chat"], undefined);
});

test("a gateway's upstream engine restart does not suppress new status on its still-open socket", async (t) => {
  const { api, clients } = harness(t);
  await api.connectSaved(server("a"));
  api.applyChatSnapshot(api.getClient()!, "chat", { seq: 100, running: false, pendingUi: [] });
  clients[0].push("engine:event", { type: "conversation_running", conversationId: "chat", running: false, seq: 101 }, { scope: "conversation:chat", epoch: "gateway", seq: 20 });
  clients[0].push("engine:event", { type: "conversation_running", conversationId: "chat", running: true, seq: 1 }, { scope: "conversation:chat", epoch: "gateway", seq: 21 });
  assert.equal(api.currentConnection().running.chat, true);
  clients[0].push("engine:event", { type: "conversation_running", conversationId: "chat", running: false, seq: 101 }, { scope: "conversation:chat", epoch: "gateway", seq: 20 });
  assert.equal(api.currentConnection().running.chat, true);
});
