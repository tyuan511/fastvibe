import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { spawnSync } from "node:child_process";

import { startHarness } from "../scripts/test-mobile-protocol.mjs";

const root = new URL("..", import.meta.url).pathname;
const defaultLibrary = join(root, "apps/mobile/core/target/debug", process.platform === "darwin" ? "libfastvibe_mobile_core.dylib" : "libfastvibe_mobile_core.so");
const libraryOverride = process.env.FASTVIBE_MOBILE_CORE_LIBRARY?.trim();

function buildLibraryIfNeeded() {
  if (libraryOverride) {
    assert.ok(existsSync(libraryOverride), `FASTVIBE_MOBILE_CORE_LIBRARY does not exist: ${libraryOverride}`);
    return libraryOverride;
  }
  const result = spawnSync("cargo", ["build", "--manifest-path", join(root, "apps/mobile/core/Cargo.toml")], { cwd: root, encoding: "utf8", stdio: "inherit" });
  assert.equal(result.status, 0, "mobile core cdylib build failed");
  assert.ok(existsSync(defaultLibrary), `mobile core library was not built at ${defaultLibrary}`);
  return defaultLibrary;
}

const DRIVER_SCRIPT = String.raw`import ctypes, json, os, sys, time
lib = ctypes.CDLL(sys.argv[1])
lib.fv_mobile_core_create.restype = ctypes.c_void_p
lib.fv_mobile_core_destroy.argtypes = [ctypes.c_void_p]
lib.fv_mobile_core_command_json.argtypes = [ctypes.c_void_p, ctypes.c_char_p]
lib.fv_mobile_core_command_json.restype = ctypes.c_void_p
lib.fv_mobile_core_poll_json.argtypes = [ctypes.c_void_p]
lib.fv_mobile_core_poll_json.restype = ctypes.c_void_p
lib.fv_mobile_core_free_string.argtypes = [ctypes.c_void_p]
handle = lib.fv_mobile_core_create()
def command(value):
    ptr = lib.fv_mobile_core_command_json(handle, json.dumps(value, separators=(',', ':')).encode())
    if not ptr: raise RuntimeError('mobile core returned null')
    try: return json.loads(ctypes.string_at(ptr).decode())
    finally: lib.fv_mobile_core_free_string(ptr)
def poll():
    ptr = lib.fv_mobile_core_poll_json(handle)
    if not ptr: raise RuntimeError('mobile core poll returned null')
    try: return json.loads(ctypes.string_at(ptr).decode())
    finally: lib.fv_mobile_core_free_string(ptr)
def emit(value):
    sys.stdout.write(json.dumps(value, separators=(',', ':')) + '\n'); sys.stdout.flush()
def wait_rpc(action, timeout=30):
    deadline = time.time() + timeout
    while time.time() < deadline:
        for event in poll().get('events', []):
            if event.get('kind') == 'rpcResult' and event.get('action') == action: return event
        time.sleep(0.02)
    raise TimeoutError('timed out waiting for rpcResult ' + action)
try:
    for line in sys.stdin:
        command_value = json.loads(line)
        op = command_value.get('op')
        if op == 'call': emit(command(command_value['value']))
        elif op == 'poll': emit(poll())
        elif op == 'waitRpc': emit(wait_rpc(command_value['action'], command_value.get('timeout', 30)))
        elif op == 'sleep': time.sleep(command_value.get('ms', 50) / 1000); emit({'ok': True})
        elif op == 'quit': break
        else: raise ValueError(command_value)
finally:
    lib.fv_mobile_core_destroy(handle)
`;

async function startCore(libraryPath) {
  const { spawn } = await import("node:child_process");
  const child = spawn("python3", ["-u", "-c", DRIVER_SCRIPT, libraryPath], { cwd: root, stdio: ["pipe", "pipe", "pipe"] });
  let buffer = "";
  const pending = [];
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk) => {
    buffer += chunk;
    for (;;) {
      const newline = buffer.indexOf("\n");
      if (newline < 0) break;
      const line = buffer.slice(0, newline);
      buffer = buffer.slice(newline + 1);
      if (!line) continue;
      const waiter = pending.shift();
      if (waiter) waiter.resolve(JSON.parse(line));
    }
  });
  child.stderr.setEncoding("utf8");
  let stderr = "";
  child.stderr.on("data", (chunk) => { stderr += chunk; });
  const request = (value) => new Promise((resolve, reject) => {
    pending.push({ resolve, reject });
    child.stdin.write(`${JSON.stringify(value)}\n`);
  });
  const call = (value) => request({ op: "call", value });
  const waitRpc = (action) => request({ op: "waitRpc", action });
  const poll = () => request({ op: "poll" });
  const stop = async () => {
    if (child.exitCode === null) {
      child.stdin.write('{"op":"quit"}\n');
      child.stdin.end();
      await new Promise((resolve) => child.once("exit", resolve));
    }
    assert.equal(stderr, "", stderr);
  };
  return { child, call, waitRpc, poll, stop };
}

async function waitForConnection(core, timeout = 30_000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const events = (await core.poll()).events ?? [];
    if (process.env.FASTVIBE_MOBILE_HARNESS_DEBUG) process.stderr.write(`[mobile-event] ${JSON.stringify(events)}\n`);
    if (events.some((event) => event.type === "connection_error")) throw new Error(JSON.stringify(events));
    if (events.some((event) => event.type === "welcome")) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error("timed out waiting for mobile AppServer welcome");
}

function assertOk(response, label) {
  assert.equal(response.ok, true, `${label}: ${JSON.stringify(response)}`);
  return response.result;
}

for (const deadFirstRelay of [false, true]) test(`mobile core C ABI speaks real iroh to desktop AppServer and exercises protocol lifecycle${deadFirstRelay ? " with an unavailable first relay" : " (legacy single relay)"}`, { timeout: 180_000 }, async (t) => {
  const library = buildLibraryIfNeeded();
  const harness = await startHarness({ deadFirstRelay });
  const core = await startCore(library);
  t.after(async () => {
    await core.stop();
    await harness.cleanup();
  });

  const step = (name) => { if (process.env.FASTVIBE_MOBILE_HARNESS_DEBUG) process.stderr.write(`[mobile-harness] ${name}\n`); };
  step("identity");
  const identity = assertOk(await core.call({ action: "identity" }), "identity");
  assert.match(identity.endpointId, /^[a-z0-9]+$/);
  assert.equal(typeof identity.secretKey, "string");
  assert.equal(JSON.stringify(identity).includes(harness.token), false);

  step("connect");
  const connect = assertOk(await core.call({
    action: "connect",
    remoteId: harness.remoteId,
    relay: deadFirstRelay ? harness.relayConfig : { url: harness.relayUrl, token: harness.token },
    conversationId: "conversation-1",
  }), "connect");
  assert.equal(connect.remoteId, harness.remoteId);
  step("welcome");
  await waitForConnection(core);

  step("list");
  assertOk(await core.call({ action: "listConversations" }), "listConversations");
  const listed = assertOk(await core.waitRpc("listConversations"), "listConversations result");
  assert.equal(listed.conversations.length, 2);

  step("open");
  assertOk(await core.call({ action: "openConversation", conversationId: "conversation-2" }), "independent open queued");
  const independent = assertOk(await core.waitRpc("openConversation"), "independent open");
  assert.equal(independent.conversation.id, "conversation-2");
  assert.equal(independent.activeId, "conversation-1", "mobile open must preserve desktop navigation");
  assertOk(await core.call({ action: "openConversation", conversationId: "conversation-1" }), "openConversation queued");
  const opened = assertOk(await core.waitRpc("openConversation"), "openConversation");
  assert.equal(opened.conversation.id, "conversation-1");

  step("snapshot");
  assertOk(await core.call({ action: "snapshot", conversationId: "conversation-1" }), "snapshot queued");
  const snapshotResult = assertOk(await core.waitRpc("snapshot"), "snapshot");
  assert.equal(snapshotResult.conversationId, "conversation-1");
  assert.equal(snapshotResult.messages[0].text, "Seed prompt");
  const hydratedSnapshot = (await core.call({ action: "poll" })).state.snapshot;
  assert.equal(hydratedSnapshot.messages[0].text, "Seed prompt", "snapshot must reach the native core store");
  assert.equal(hydratedSnapshot.historyBeforeEntryId, "history-0");
  assert.equal(hydratedSnapshot.queue.pause, null);

  step("subscribe");
  assertOk(await core.call({ action: "subscribe", scopes: ["conversation:conversation-1"] }), "subscribe queued");
  const subscribed = assertOk(await core.waitRpc("subscribe"), "subscribe");
  assert.ok(subscribed.cursors["conversation:conversation-1"]);

  step("prompt");
  assertOk(await core.call({ action: "prompt", conversationId: "conversation-1", text: "hello from real iroh" }), "prompt queued");
  const prompt = assertOk(await core.waitRpc("submitPrompt"), "prompt");
  assert.equal(prompt.conversationId, "conversation-1");
  const afterPrompt = (await core.call({ action: "snapshot", conversationId: "conversation-1" }));
  assertOk(afterPrompt, "snapshot after prompt queued");
  const afterPromptResult = assertOk(await core.waitRpc("snapshot"), "snapshot after prompt");
  assert.equal(afterPromptResult.messages.at(-1).text, "Echo: hello from real iroh");

  step("error");
  assertOk(await core.call({ action: "prompt", conversationId: "conversation-1", text: "error" }), "error prompt queued");
  const errorPrompt = await core.waitRpc("submitPrompt");
  assert.equal(errorPrompt.ok, false);
  assert.match(errorPrompt.error.message, /harness prompt error/);

  step("permission");
  assertOk(await core.call({ action: "prompt", conversationId: "conversation-1", text: "permission" }), "permission prompt queued");
  const permissionPrompt = assertOk(await core.waitRpc("submitPrompt"), "permission prompt");
  assert.equal(permissionPrompt.pending, true);
  assertOk(await core.call({ action: "pendingUi" }), "pendingUi queued");
  const pending = assertOk(await core.waitRpc("pendingUi"), "pendingUi");
  assert.equal(pending[0].id, "permission-1");
  assertOk(await core.call({ action: "permissionRespond", id: "permission-1", confirmed: true }), "permission response queued");
  assertOk(await core.waitRpc("permissionRespond"), "permission response");

  step("history");
  assertOk(await core.call({ action: "getMessagesPage", conversationId: "conversation-1", beforeEntryId: "history-0", turnLimit: 2 }), "history page queued");
  const page = assertOk(await core.waitRpc("getMessagesPage"), "history page");
  assert.equal(page.messages.length, 2);
  assert.equal(page.messages[0].text, "Older page 1");

  step("queue");
  assertOk(await core.call({ action: "call", method: "engine:queue-add", payload: { conversationId: "conversation-1", text: "queued from mobile", behavior: "followUp" } }), "queue add queued");
  const queueAdded = assertOk(await core.waitRpc("call"), "queue add");
  assert.equal(queueAdded.items.length, 1);
  const queueId = queueAdded.items[0].id;
  assertOk(await core.call({ action: "call", method: "engine:queue-cancel", payload: { conversationId: "conversation-1", id: queueId } }), "queue cancel queued");
  const queueCancelled = assertOk(await core.waitRpc("call"), "queue cancel");
  assert.equal(queueCancelled.items.length, 0);

  step("abort");
  assertOk(await core.call({ action: "abort", conversationId: "conversation-1" }), "abort queued");
  const aborted = assertOk(await core.waitRpc("abort"), "abort");
  assert.equal(aborted.aborted, true);

  assertOk(await core.call({ action: "disconnect" }), "disconnect");
  const disconnected = (await core.call({ action: "poll" })).state;
  assert.equal(disconnected.connection, "disconnected");
});
