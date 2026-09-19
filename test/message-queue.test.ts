import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { Agent, type AgentMessage } from "@earendil-works/pi-agent-core";
import { MessageQueueStore, SdkQueueClaims, normalizeQueueFile, reorderConversationItems } from "../src/main/engine/message-queue.ts";
import { installSdkQueueAdapter, SUPPORTED_PI_AGENT_CORE_VERSION } from "../src/main/pi/sdk-queue-adapter.ts";

const item = (id: string, conversationId = "a", claimed = false) => ({
  id,
  conversationId,
  text: id,
  sentText: `payload:${id}`,
  behavior: "followUp" as const,
  claimed,
  sending: claimed,
});

test("only the exact SDK message object acknowledges a claimed row", () => {
  const claims = new SdkQueueClaims();
  const queued = { role: "user", content: [{ type: "text", text: "same" }] };
  const ordinary = { role: "user", content: [{ type: "text", text: "same" }] };
  claims.claim(queued, "queue-id");
  assert.equal(claims.take(ordinary), undefined);
  assert.equal(claims.take(queued), "queue-id");
  assert.equal(claims.take(queued), undefined);
});

test("recovery preserves uncertain rows, pauses them, and does not auto-replay", () => {
  const state = normalizeQueueFile({
    version: 2,
    items: [item("claimed", "a", true), item("pending")],
    pauses: { a: "stopped", bad: "unknown" },
  });
  assert.deepEqual(state.items.map(({ id, sentText, claimed, sending }) => ({ id, sentText, claimed, sending })), [
    { id: "claimed", sentText: "payload:claimed", claimed: undefined, sending: undefined },
    { id: "pending", sentText: "payload:pending", claimed: undefined, sending: undefined },
  ]);
  assert.deepEqual(state.pauses, { a: "error" });
});

test("legacy sending state is preserved but paused for an explicit decision", () => {
  const state = normalizeQueueFile({
    version: 1,
    items: [{ ...item("legacy"), claimed: undefined, sending: true }],
  });
  assert.equal(state.items[0]?.id, "legacy");
  assert.equal(state.items[0]?.sending, undefined);
  assert.deepEqual(state.pauses, { a: "error" });
});

test("id reorder is conversation-scoped, keeps claimed positions, and cannot drop additions", () => {
  const items = [item("a1"), item("owned", "a", true), item("b1", "b"), item("a2"), item("a3")];
  const reordered = reorderConversationItems(items, "a", ["a3", "owned", "missing", "a1"]);
  assert.deepEqual(reordered.map((entry) => entry.id), ["a3", "owned", "b1", "a1", "a2"]);
});

test("a failed durable write does not mutate the in-memory queue", () => {
  let fail = true;
  const store = new MessageQueueStore("unused", () => {
    if (fail) throw new Error("disk full");
  });
  assert.throws(() => store.add({
    conversationId: "a",
    text: "hello",
    sentText: "hello",
    behavior: "followUp",
  }), /disk full/);
  assert.deepEqual(store.state("a").items, []);
  assert.equal(store.state("a").revision, 0);

  fail = false;
  const added = store.add({ conversationId: "a", text: "ok", behavior: "followUp" });
  assert.deepEqual(store.state("a").items.map((entry) => entry.id), [added.id]);
});

test("failed updates retain the last committed claimed state", () => {
  let writes = 0;
  const store = new MessageQueueStore("unused", () => {
    writes += 1;
    if (writes === 2) throw new Error("rename failed");
  });
  const added = store.add({ conversationId: "a", text: "one", behavior: "steer" });
  assert.throws(() => store.update(added.id, { claimed: true, sending: true }), /rename failed/);
  assert.equal(store.get(added.id)?.claimed, undefined);
  assert.equal(store.get(added.id)?.sending, undefined);
});

test("stop restores only exact SDK-pending ids and retains claimed rows", () => {
  const store = new MessageQueueStore("unused", () => undefined);
  const pending = store.add({ conversationId: "a", text: "pending", behavior: "steer", sending: true });
  const claimed = store.add({ conversationId: "a", text: "claimed", behavior: "steer", sending: true, claimed: true });
  store.restorePending("a", new Set([pending.id]), "stopped");
  assert.equal(store.get(pending.id)?.sending, false);
  assert.equal(store.get(pending.id)?.claimed, undefined);
  assert.equal(store.get(claimed.id)?.sending, true);
  assert.equal(store.get(claimed.id)?.claimed, true);
  assert.equal(store.state("a").pause, "stopped");
});

function sdkUser(text: string): AgentMessage {
  return { role: "user", content: [{ type: "text", text }], timestamp: Date.now() };
}

function sdkAgent(): Agent {
  return new Agent({
    // The integration exercises the real private PendingMessageQueue and loop config;
    // no provider stream is reached.
    streamFn: (() => { throw new Error("not used"); }) as ConstructorParameters<typeof Agent>[0]["streamFn"],
  });
}

test("adapter version matches the exact pinned SDK dependency", () => {
  const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as {
    dependencies: Record<string, string>;
  };
  assert.equal(pkg.dependencies["@earendil-works/pi-agent-core"], SUPPORTED_PI_AGENT_CORE_VERSION);
});

test("actual SDK getSteeringMessages claims only when it drains the exact object", async () => {
  const agent = sdkAgent();
  const claims = new SdkQueueClaims();
  let currentId: string | undefined = "queued-1";
  const claimed: string[] = [];
  const adapter = installSdkQueueAdapter(agent, {
    currentId: () => currentId,
    onClaim: (id) => claimed.push(id),
    claims,
  });
  const message = sdkUser("one");
  agent.steer(message);
  currentId = undefined;

  assert.deepEqual(claimed, []);
  assert.deepEqual(adapter.pendingIds(), ["queued-1"]);

  const config = (agent as unknown as {
    createLoopConfig(): { getSteeringMessages(): Promise<AgentMessage[]> };
  }).createLoopConfig();
  const drained = await config.getSteeringMessages();
  assert.deepEqual(drained, [message]);
  assert.deepEqual(claimed, ["queued-1"]);
  assert.equal(claims.take(message as object), "queued-1");
  assert.equal(adapter.cancelPending("queued-1"), false);
});

test("identity cancellation filters one SDK object without clearing or replaying survivors", async () => {
  const agent = sdkAgent();
  const claims = new SdkQueueClaims();
  let currentId: string | undefined;
  const adapter = installSdkQueueAdapter(agent, {
    currentId: () => currentId,
    onClaim: () => undefined,
    claims,
  });
  const first = sdkUser("same");
  const second = sdkUser("same");
  currentId = "first";
  agent.steer(first);
  currentId = "second";
  agent.steer(second);
  currentId = undefined;

  assert.equal(adapter.cancelPending("first"), true);
  const config = (agent as unknown as {
    createLoopConfig(): { getSteeringMessages(): Promise<AgentMessage[]> };
  }).createLoopConfig();
  assert.deepEqual(await config.getSteeringMessages(), [second]);
  assert.equal(claims.take(second as object), "second");
});

test("failed durable claim leaves the real SDK queue undrained", async () => {
  const agent = sdkAgent();
  const claims = new SdkQueueClaims();
  let fail = true;
  const adapter = installSdkQueueAdapter(agent, {
    currentId: () => "queued",
    onClaim: () => {
      if (fail) throw new Error("disk full");
    },
    claims,
  });
  const message = sdkUser("one");
  agent.steer(message);
  const config = (agent as unknown as {
    createLoopConfig(): { getSteeringMessages(): Promise<AgentMessage[]> };
  }).createLoopConfig();

  await assert.rejects(config.getSteeringMessages(), /disk full/);
  assert.deepEqual(adapter.pendingIds(), ["queued"]);
  fail = false;
  assert.deepEqual(await config.getSteeringMessages(), [message]);
});
