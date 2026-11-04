import { spawn, spawnSync } from "node:child_process";
import { createServer } from "node:http";
import { mkdtemp, rm, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import { configureFastVibeUserData } from "../src/main/engine/paths.ts";
import { IrohRemoteConnection } from "../src/main/rtc/iroh-remote.ts";
import { IrohSidecar, irohSidecarBinary } from "../src/main/rtc/iroh-sidecar.ts";
import { RemoteServer } from "../src/main/server/server.ts";
import { AppServer } from "../src/main/app-server/app-server.ts";
import { DESKTOP_CAPABILITIES } from "../src/main/app-server/capabilities.ts";
import { Ipc } from "../src/shared/ipc.ts";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const TEST_TOKEN = ["harness", "local", "token"].join("-");
const TEST_RELAY_ID = "mobile-harness-local";
const TEST_EXPIRES_AT = new Date(Date.now() + 60 * 60 * 1000).toISOString();
const TEST_DEVICE_ID = "desktop-test-device";
const TEST_USER = { id: "harness-user", login: "mobile-harness@example.invalid", avatar_url: null, email: "mobile-harness@example.invalid" };
const TEST_RELAY_USAGE = {
  periodStart: "2026-01-01T00:00:00Z",
  resetsAt: "2099-01-01T00:00:00Z",
  usedBytes: 0,
  quotaBytes: 1024 * 1024 * 1024,
  remainingBytes: 1024 * 1024 * 1024,
};

const json = (response, status, value) => {
  response.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
  response.end(JSON.stringify(value));
};

function snapshot(conversationId, state) {
  const current = state.snapshots.get(conversationId);
  if (!current) throw new Error(`unknown conversation: ${conversationId}`);
  return structuredClone(current);
}

function message(id, role, text, createdAt = Date.now()) {
  return {
    id,
    role,
    text,
    thinking: null,
    tools: [],
    parts: [{ kind: "text", text }],
    createdAt,
    completedAt: createdAt,
    runStartedAt: null,
    kind: "message",
    customType: null,
    error: null,
    stop: null,
    retry: null,
    deferredContent: null,
    stopCause: null,
    compact: null,
  };
}

function createDesktopState() {
  const conversations = [
    { id: "conversation-1", title: "Harness conversation", cwd: root, project: null, archived: false, updatedAt: Date.now() },
    { id: "conversation-2", title: "Second conversation", cwd: root, project: null, archived: false, updatedAt: Date.now() - 1 },
  ];
  const snapshots = new Map();
  for (const conversation of conversations) {
    snapshots.set(conversation.id, {
      conversationId: conversation.id,
      messages: [message(`${conversation.id}-user`, "user", "Seed prompt")],
      messageMode: "window",
      historyBeforeEntryId: "history-0",
      history: { beforeEntryId: "history-0" },
      running: false,
      queue: { conversationId: conversation.id, revision: 0, items: [], pause: null },
      pendingUi: [],
      turnEvents: [],
      overflowed: false,
      seq: 1,
    });
  }
  return {
    projects: [],
    conversations,
    activeId: "conversation-1",
    snapshots,
    history: new Map([
      ["conversation-1", [message("history-older-1", "assistant", "Older page 1", 1), message("history-older-2", "assistant", "Older page 2", 2)]],
      ["conversation-2", [message("history-older-3", "assistant", "Older page 3", 3)]],
    ]),
    pending: new Map(),
    nextConversation: 3,
    nextQueue: 1,
    nextSeq: 10,
    promptCalls: [],
    permissionResponses: [],
    aborted: [],
  };
}

function makeDispatch(getAppServer, state) {
  const publish = (method, payload, options) => getAppServer().publish(method, payload, options);
  const currentSnapshot = (conversationId) => snapshot(conversationId, state);
  return async (method, payload) => {
    const body = payload && typeof payload === "object" ? payload : {};
    const conversationId = typeof body.conversationId === "string" ? body.conversationId : state.activeId;
    switch (method) {
      case Ipc.conversationsList:
        return { projects: structuredClone(state.projects), conversations: structuredClone(state.conversations), activeId: state.activeId };
      case Ipc.conversationsOpen: {
        const id = typeof body.id === "string" ? body.id : conversationId;
        if (body.activate !== false) {
          state.activeId = id;
          publish(Ipc.workspaceChanged, { projects: structuredClone(state.projects), conversations: structuredClone(state.conversations), activeId: state.activeId });
        }
        return { activeId: state.activeId, conversation: { id } };
      }
      case Ipc.conversationsCreate: {
        const id = `conversation-${state.nextConversation++}`;
        const item = { id, title: typeof body.title === "string" ? body.title : "New conversation", cwd: root, project: null, archived: false, updatedAt: Date.now() };
        state.conversations.unshift(item);
        state.snapshots.set(id, { conversationId: id, messages: [], messageMode: "window", historyBeforeEntryId: null, history: { beforeEntryId: null }, running: false, queue: { conversationId: id, revision: 0, items: [], pause: null }, pendingUi: [], turnEvents: [], overflowed: false, seq: 0 });
        publish(Ipc.workspaceChanged, { projects: structuredClone(state.projects), conversations: structuredClone(state.conversations), activeId: state.activeId });
        return { projects: structuredClone(state.projects), conversations: structuredClone(state.conversations), activeId: state.activeId, conversation: item, messages: [] };
      }
      case Ipc.engineGetSnapshot:
        return currentSnapshot(conversationId);
      case Ipc.engineGetPendingUi:
        return [...state.pending.values()].flatMap((items) => structuredClone(items));
      case Ipc.engineGetMessagesPage: {
        const items = state.history.get(conversationId) ?? [];
        const limit = Math.max(1, Math.min(Number(body.turnLimit) || 2, 50));
        return { conversationId, messages: structuredClone(items.slice(0, limit)), beforeEntryId: String(body.beforeEntryId ?? "history-0"), nextBeforeEntryId: null, reset: false };
      }
      case Ipc.engineSubmitPrompt: {
        const text = typeof body.text === "string" ? body.text : "";
        state.promptCalls.push({ conversationId, text, enqueue: body.enqueue === true });
        if (text === "error") throw new Error("harness prompt error");
        if (text === "permission") {
          const pending = { type: "extension_ui_request", method: "confirm", id: "permission-1", title: "Harness permission", message: "Allow the harness action?", conversationId };
          state.pending.set(conversationId, [pending]);
          publish(Ipc.event, pending);
          return { accepted: true, pending: true };
        }
        const before = currentSnapshot(conversationId);
        const seq = ++state.nextSeq;
        publish(Ipc.event, { type: "agent_start", conversationId, seq });
        publish(Ipc.event, { type: "conversation_running", conversationId, running: true, seq: seq + 1 });
        publish(Ipc.event, { type: "message", conversationId, seq: seq + 2, message: message(`assistant-${seq}`, "assistant", `Echo: ${text}`) });
        publish(Ipc.event, { type: "conversation_running", conversationId, running: false, seq: seq + 3 });
        const next = structuredClone(before);
        next.messages.push(message(`assistant-${seq}`, "assistant", `Echo: ${text}`));
        next.seq = seq + 3;
        state.snapshots.set(conversationId, next);
        return { accepted: true, conversationId };
      }
      case Ipc.enginePermissionRespond: {
        const id = typeof body.id === "string" ? body.id : "";
        state.permissionResponses.push({ conversationId, id, value: body.value ?? body.answer ?? body.result });
        const pending = state.pending.get(conversationId) ?? [];
        state.pending.set(conversationId, pending.filter((item) => item.id !== id));
        publish(Ipc.event, { type: "extension_ui_dismiss", conversationId, id, seq: ++state.nextSeq });
        return { ok: true };
      }
      case Ipc.engineAbort:
        state.aborted.push(conversationId);
        publish(Ipc.event, { type: "agent_settled", conversationId, seq: ++state.nextSeq });
        return { aborted: true, conversationId };
      case Ipc.engineQueueAdd: {
        const item = { id: `queue-${state.nextQueue++}`, conversationId, text: String(body.text ?? body.message ?? ""), behavior: body.behavior === "steer" ? "steer" : "followUp", sending: false, claimed: false };
        const current = currentSnapshot(conversationId);
        current.queue = { ...current.queue, conversationId, revision: current.queue.revision + 1, items: [...current.queue.items, item], pause: current.queue.pause };
        state.snapshots.set(conversationId, current);
        publish(Ipc.event, { type: "queue_changed", conversationId, queue: structuredClone(current.queue), seq: current.seq });
        return structuredClone(current.queue);
      }
      case Ipc.engineQueueCancel: {
        const id = String(body.id ?? "");
        const current = currentSnapshot(conversationId);
        current.queue = { ...current.queue, revision: current.queue.revision + 1, items: current.queue.items.filter((item) => item.id !== id) };
        current.seq = ++state.nextSeq;
        state.snapshots.set(conversationId, current);
        publish(Ipc.event, { type: "queue_changed", conversationId, queue: structuredClone(current.queue), seq: current.seq });
        return structuredClone(current.queue);
      }
      case Ipc.engineClearQueue: {
        const current = currentSnapshot(conversationId);
        current.queue = { ...current.queue, revision: current.queue.revision + 1, items: [] };
        current.seq = ++state.nextSeq;
        state.snapshots.set(conversationId, current);
        publish(Ipc.event, { type: "queue_changed", conversationId, queue: structuredClone(current.queue), seq: current.seq });
        return structuredClone(current.queue);
      }
      case Ipc.engineGetState:
      case Ipc.engineGetStatus:
        return { conversationId, running: currentSnapshot(conversationId).running, status: "ready" };
      default:
        throw new Error(`harness dispatch does not implement ${method}`);
    }
  };
}

function makeAccountApi({ relayUrl }) {
  const devices = new Map([[TEST_DEVICE_ID, { id: TEST_DEVICE_ID, name: "FastVibe test desktop", platform: "darwin", online: true, iroh_endpoint_id: null }]]);
  const calls = [];
  const server = createServer(async (request, response) => {
    try {
      const url = new URL(request.url ?? "/", "http://127.0.0.1");
      calls.push(`${request.method} ${url.pathname}`);
      const auth = request.headers.authorization;
      if (auth !== `Bearer ${TEST_TOKEN}`) return json(response, 401, { error: "unauthorized" });
      if (url.pathname === "/api/devices" && request.method === "GET") return json(response, 200, { devices: [...devices.values()] });
      if (url.pathname === "/api/devices/me" && request.method === "PUT") {
        const body = await readJson(request);
        const existing = devices.get("mobile-test-device") ?? { id: "mobile-test-device" };
        devices.set(existing.id, { ...existing, name: body.name ?? "FastVibe Mobile", platform: body.platform ?? "android" });
        return json(response, 200, { device: devices.get(existing.id) });
      }
      const endpoint = /^\/api\/devices\/([^/]+)\/iroh$/.exec(url.pathname);
      if (endpoint && request.method === "PUT") {
        const body = await readJson(request);
        const id = decodeURIComponent(endpoint[1]);
        const device = devices.get(id) ?? { id, name: id, platform: "mobile" };
        devices.set(id, { ...device, iroh_endpoint_id: body.endpoint_id ?? body.endpointId });
        return json(response, 200, { ok: true });
      }
      if (url.pathname === "/api/relay/iroh/token" && request.method === "POST") {
        const body = await readJson(request);
        return json(response, 200, { relay_id: TEST_RELAY_ID, url: relayUrl, quic_port: 7842, token: TEST_TOKEN, expires_at: TEST_EXPIRES_AT, usage: TEST_RELAY_USAGE, device_id: body.device_id, endpoint_id: body.endpoint_id });
      }
      if (url.pathname === "/api/relay/iroh/usage" && request.method === "POST") return json(response, 200, TEST_RELAY_USAGE);
      if (url.pathname === "/api/oauth/token" && request.method === "POST") return json(response, 200, { access_token: TEST_TOKEN, user: TEST_USER });
      return json(response, 404, { error: "not found" });
    } catch (error) {
      json(response, 500, { error: error instanceof Error ? error.message : String(error) });
    }
  });
  return { server, devices, calls };
}

async function readJson(request) {
  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);
  return JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
}


/**
 * The desktop's trusted transport auth marker is consumed by the mobile core before the
 * App Protocol hello. This harness deliberately leaves that production frame path intact.
 */

async function startRelay({ emulatorReachable = false } = {}) {
  const dir = await mkdtemp(join(tmpdir(), "fastvibe-mobile-relay-"));
  await mkdir(join(dir, "src"));
  await writeFile(join(dir, "Cargo.toml"), `[package]\nname = "fastvibe-mobile-relay"\nversion = "0.1.0"\nedition = "2024"\n\n[dependencies]\niroh-relay = { version = "1.4.1", features = ["server"] }\ntokio = { version = "1", features = ["macros", "rt-multi-thread", "signal"] }\n`);
  const relayBind = emulatorReachable ? "([0, 0, 0, 0], 0)" : "([127, 0, 0, 1], 0)";
  await writeFile(join(dir, "src", "main.rs"), `use iroh_relay::server::{RelayConfig, Server, ServerConfig};\nuse std::net::SocketAddr;\n#[tokio::main]\nasync fn main() {\n  let mut config = ServerConfig::default();\n  config.relay = Some(RelayConfig::new(SocketAddr::from(${relayBind})));\n  let mut server = Server::spawn(config).await.expect("relay");\n  println!("READY http://{}", server.http_addr().expect("relay address"));\n  let _ = server.join().await;\n}`);
  const child = spawn("cargo", ["run", "--quiet", "--manifest-path", join(dir, "Cargo.toml")], { cwd: root, stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, CARGO_TARGET_DIR: join(root, "rust", "target") } });
  let output = "";
  child.stderr.on("data", (chunk) => { if (process.env.FASTVIBE_MOBILE_HARNESS_DEBUG) process.stderr.write(chunk); });
  child.stdout.setEncoding("utf8");
  const relayUrl = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("timed out starting local iroh relay")), 120_000);
    child.stdout.on("data", (chunk) => {
      output += chunk;
      const match = output.match(/READY (http:\/\/[^\s]+)/);
      if (!match) return;
      clearTimeout(timer);
      resolve(match[1]);
    });
    child.once("error", reject);
    child.once("exit", (code) => { if (code && !output.includes("READY")) reject(new Error(`local iroh relay exited ${code}`)); });
  });
  return { child, dir, relayUrl };
}

const checkedSidecars = new Map();

async function checkHarnessSidecar() {
  const binary = irohSidecarBinary();
  if (!checkedSidecars.has(binary)) {
    checkedSidecars.set(binary, (async () => {
      const temp = await mkdtemp(join(tmpdir(), "fastvibe-mobile-sidecar-check-"));
      try {
        // Old staged binaries silently ignore relays and bind only the legacy
        // primary. Probe the command parser before starting any network fixtures.
        const commands = [
          { type: "identity", statePath: join(temp, "identity.key") },
          { type: "start", relayId: TEST_RELAY_ID, relayUrl: "http://127.0.0.1:9", relayToken: TEST_TOKEN, expiresAt: TEST_EXPIRES_AT, relays: [] },
          { type: "stop" },
        ];
        const result = spawnSync(binary, ["--stdio"], {
          input: commands.map((command) => JSON.stringify(command)).join("\n") + "\n",
          encoding: "utf8",
          timeout: 5_000,
        });
        if (result.error) throw new Error(`Cannot check harness iroh sidecar ${binary}: ${result.error.message}`);
        const events = result.stdout.trim().split("\n").filter(Boolean).map((line) => JSON.parse(line));
        if (result.status !== 0 || !events.some((event) => event.type === "error" && event.message === "relays must be a non-empty array")) {
          throw new Error(`Harness iroh sidecar does not support the current multi-relay commands: ${binary}. Build current sources with cargo build --manifest-path rust/Cargo.toml --bin fastvibe-iroh --target-dir /tmp/fastvibe-mobile-protocol-iroh, then set FASTVIBE_IROH_BIN to that target's debug/fastvibe-iroh. Probe events: ${JSON.stringify(events)}`);
        }
      } finally {
        await rm(temp, { recursive: true, force: true });
      }
    })());
  }
  await checkedSidecars.get(binary);
  return binary;
}

export async function startHarness({ emulatorReachable = false, deadFirstRelay = false } = {}) {
  const sidecarBinary = await checkHarnessSidecar();
  const temp = await mkdtemp(join(tmpdir(), "fastvibe-mobile-harness-"));
  configureFastVibeUserData(temp);
  const relay = await startRelay({ emulatorReachable });
  const state = createDesktopState();
  const advertisedRelayUrl = emulatorReachable
    ? relay.relayUrl.replace(/127\.0\.0\.1|0\.0\.0\.0/, process.env.FASTVIBE_EMULATOR_HOST ?? "10.0.2.2")
    : relay.relayUrl;

  const accountApi = makeAccountApi({ relayUrl: advertisedRelayUrl });
  await new Promise((resolve, reject) => accountApi.server.listen(0, "127.0.0.1", (error) => error ? reject(error) : resolve()));
  const accountPort = accountApi.server.address().port;
  const accountOrigin = `http://${process.env.FASTVIBE_EMULATOR_HOST ?? "127.0.0.1"}:${accountPort}`;
  const channels = () => [
    Ipc.conversationsList, Ipc.conversationsOpen, Ipc.conversationsCreate,
    Ipc.engineGetSnapshot, Ipc.engineGetPendingUi, Ipc.engineGetMessagesPage,
    Ipc.engineSubmitPrompt, Ipc.enginePermissionRespond, Ipc.engineAbort,
    Ipc.engineQueueAdd, Ipc.engineQueueCancel, Ipc.engineClearQueue,
    Ipc.engineGetState, Ipc.engineGetStatus,
  ];
  let appServer;
  const dispatch = makeDispatch(() => appServer, state);
  appServer = new AppServer({
    identity: { serverInstanceId: "srv_mobile_harness", version: "test", platform: process.platform },
    capabilities: DESKTOP_CAPABILITIES,
    channels,
    dispatch,
    log: { info() {}, warn() {} },
  });
  const boundDispatch = dispatch;
  const serverWithDispatch = appServer;
  const remoteServer = new RemoteServer({
    accessFile: join(temp, "remote-access.json"),
    policyScope: "subset",
    channels,
    dispatch: boundDispatch,
    subscribe: () => () => undefined,
    appServer: serverWithDispatch,
    log: { info(message) { if (process.env.FASTVIBE_MOBILE_HARNESS_DEBUG) process.stderr.write(`[desktop] ${message}\n`); }, warn(message) { if (process.env.FASTVIBE_MOBILE_HARNESS_DEBUG) process.stderr.write(`[desktop warn] ${message}\n`); }, error(message, error) { if (process.env.FASTVIBE_MOBILE_HARNESS_DEBUG) process.stderr.write(`[desktop error] ${message} ${String(error ?? "")}\n`); } },
    heartbeatMs: 500,
  });
  const relayConfig = {
    relayId: deadFirstRelay ? "unreachable-primary" : TEST_RELAY_ID,
    url: deadFirstRelay ? "http://127.0.0.1:9" : advertisedRelayUrl,
    quicPort: 7842,
    token: TEST_TOKEN,
    expiresAt: TEST_EXPIRES_AT,
    usage: TEST_RELAY_USAGE,
    ...(deadFirstRelay ? { relays: [
      { relayId: "unreachable-primary", url: "http://127.0.0.1:9", quicPort: 7842, token: TEST_TOKEN },
      { relayId: TEST_RELAY_ID, url: advertisedRelayUrl, quicPort: 7842, token: TEST_TOKEN },
    ] } : {}),
  };
  const account = {
    async setIrohEndpoint() {},
    async issueIrohRelay() { return relayConfig; },
    async reportIrohUsage() { return TEST_RELAY_USAGE; },
  };
  const sidecar = new IrohSidecar();
  let directAddresses = [];
  sidecar.on("event", (event) => {
    if ((event.type === "started" || event.type === "addresses") && Array.isArray(event.directAddresses)) directAddresses = event.directAddresses;
  });
  const desktop = new IrohRemoteConnection({
    sidecar,
    account,
    deviceId: TEST_DEVICE_ID,
    attach: (socket, peer) => {
      if (process.env.FASTVIBE_MOBILE_HARNESS_DEBUG) socket.on("message", (raw) => process.stderr.write(`[desktop frame in] ${Buffer.from(raw).toString("utf8")}\n`));
      remoteServer.attachTransport(socket, peer);
    },
    authorizePeer: async () => true,
    identityFile: join(temp, "desktop-iroh-identity.key"),
    log: { info() {}, warn() {} },
  });
  await desktop.start();
  const remoteId = desktop.state(true).endpointId;
  if (!remoteId) throw new Error("desktop iroh endpoint did not start");
  accountApi.devices.set(TEST_DEVICE_ID, { ...accountApi.devices.get(TEST_DEVICE_ID), iroh_endpoint_id: remoteId });
  const cleanup = async () => {
    await desktop.dispose().catch(() => undefined);
    await remoteServer.stop().catch(() => undefined);
    serverWithDispatch.closeAll();
    await new Promise((resolve) => accountApi.server.close(() => resolve()));
    relay.child.kill("SIGTERM");
    if (relay.child.exitCode === null) await new Promise((resolve) => relay.child.once("exit", resolve));
    await rm(relay.dir, { recursive: true, force: true });
    await rm(temp, { recursive: true, force: true });
  };
  return { temp, sidecarBinary, relayUrl: advertisedRelayUrl, relayConfig, accountOrigin, remoteId, token: TEST_TOKEN, state, desktop, remoteServer, appServer: serverWithDispatch, cleanup, accountCalls: accountApi.calls, get directAddresses() { return [...directAddresses]; } };
}

export function printConnectionInfo(harness) {
  // Deliberately omit the mobile/desktop signing keys. The mobile side generates its own key
  // through the C ABI; the desktop key is only in the temporary identity file.
  const accountPort = new URL(harness.accountOrigin).port;
  const lines = [
    "FASTVIBE_MOBILE_HARNESS=1",
    `FASTVIBE_TEST_ACCOUNT_ORIGIN=${harness.accountOrigin}`,
    `FASTVIBE_TEST_ACCOUNT_PORT=${accountPort}`,
    `FASTVIBE_TEST_RELAY_URL=${harness.relayUrl}`,
    `FASTVIBE_TEST_RELAY_TOKEN=${harness.token}`,
    `FASTVIBE_TEST_REMOTE_ID=${harness.remoteId}`,
    `FASTVIBE_TEST_DEVICE_ID=${TEST_DEVICE_ID}`,
    "# Android emulator: adb reverse tcp:<FASTVIBE_TEST_ACCOUNT_PORT> tcp:<FASTVIBE_TEST_ACCOUNT_PORT>.",
  ];
  process.stdout.write(`${lines.join("\n")}\n`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const args = new Set(process.argv.slice(2));
  if (args.has("--help")) {
    process.stdout.write("Usage: node --experimental-strip-types scripts/test-mobile-protocol.mjs [--persistent]\n\n--persistent keeps a local fake account, iroh relay, and desktop AppServer alive for emulator pairing.\n");
    process.exit(0);
  }
  const harness = await startHarness({ emulatorReachable: args.has("--emulator") });
  printConnectionInfo(harness);
  if (args.has("--persistent")) {
    const stop = async () => { await harness.cleanup(); process.exit(0); };
    process.once("SIGINT", stop);
    process.once("SIGTERM", stop);
    await new Promise(() => {});
  }
  await harness.cleanup();
}
