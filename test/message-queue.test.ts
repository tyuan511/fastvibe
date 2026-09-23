import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { Agent, type AgentMessage } from "@earendil-works/pi-agent-core";
import { MessageQueueStore, SdkQueueClaims, findDeliveredClaims, normalizeQueueFile, reorderConversationItems } from "../src/main/engine/message-queue.ts";
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

test("recovery keeps claimed rows claimed for reconciliation, pauses them, and does not auto-replay", () => {
  const state = normalizeQueueFile({
    version: 2,
    items: [item("claimed", "a", true), item("pending")],
    pauses: { a: "stopped", bad: "unknown" },
  });
  assert.deepEqual(state.items.map(({ id, sentText, claimed, sending }) => ({ id, sentText, claimed, sending })), [
    { id: "claimed", sentText: "payload:claimed", claimed: true, sending: true },
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

test("transcript reconciliation matches each claimed row to one later user turn", () => {
  const rows = [
    { ...item("old-text", "a", true), queuedAt: 100 },
    { ...item("twin-1", "a", true), sentText: "same", queuedAt: 200 },
    { ...item("twin-2", "a", true), sentText: "same", queuedAt: 200 },
    { ...item("pending"), sentText: "same" },
  ];
  const delivered = findDeliveredClaims(rows, [
    // Equal text sent before the row existed is a different turn.
    { text: "payload:old-text", timestamp: 50 },
    { text: "same", timestamp: 250 },
  ]);
  // One transcript turn acknowledges one row; its twin was never sent.
  assert.deepEqual([...delivered], ["twin-1"]);
});

test("resolving claims removes delivered rows, re-queues the rest, and keeps a held pause", () => {
  const store = new MessageQueueStore("unused", () => undefined);
  const sent = store.add({ conversationId: "a", text: "sent", behavior: "steer", claimed: true, sending: true });
  const lost = store.add({ conversationId: "a", text: "lost", behavior: "steer", claimed: true, sending: true });
  store.pause("a", "error");
  assert.equal(store.resolveClaims("a", new Set([sent.id])), true);
  assert.equal(store.get(sent.id), undefined);
  assert.equal(store.get(lost.id)?.claimed, false);
  assert.equal(store.get(lost.id)?.sending, false);
  assert.equal(store.state("a").pause, "error");
  // Nothing left to hold: the pause goes with the last row.
  store.update(lost.id, { claimed: true });
  store.resolveClaims("a", new Set([lost.id]));
  assert.equal(store.state("a").pause, null);
  assert.equal(store.resolveClaims("a", new Set()), false);
});

test("a pause is released only once it holds nothing", () => {
  const store = new MessageQueueStore("unused", () => undefined);
  // Stop over an empty queue: a leftover latch, released without touching others.
  store.pause("a", "stopped");
  store.pause("b", "stopped");
  const held = store.add({ conversationId: "b", text: "held", behavior: "followUp" });
  const revision = store.state("a").revision;
  assert.equal(store.releaseEmptyPause("a"), true);
  assert.equal(store.state("a").pause, null);
  assert.equal(store.state("a").revision, revision + 1);
  assert.equal(store.releaseEmptyPause("a"), false);
  assert.equal(store.state("a").revision, revision + 1);
  // A pause over a held row is the user's to release.
  assert.equal(store.releaseEmptyPause("b"), false);
  assert.equal(store.state("b").pause, "stopped");
  store.remove(held.id);
  assert.equal(store.releaseEmptyPause("b"), true);
});

test("id reorder is conversation-scoped, keeps claimed positions, and cannot drop additions", () => {
  const items = [item("a1"), item("owned", "a", true), item("b1", "b"), item("a2"), item("a3")];
  const reordered = reorderConversationItems(items, "a", ["a3", "owned", "missing", "a1"]);
  assert.deepEqual(reordered.map((entry) => entry.id), ["a3", "owned", "b1", "a1", "a2"]);
});

test("a corrupt durable queue is not silently treated as empty", () => {
  const directory = mkdtempSync(join(tmpdir(), "fastvibe-queue-"));
  const file = join(directory, "message-queue.json");
  writeFileSync(file, "{not-json", "utf8");
  try {
    assert.throws(() => new MessageQueueStore(file), /Unable to read durable message queue/);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
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

test("actual SDK getSteeringMessages claims the exact object it drains, in any run", async () => {
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
  // A run the user started directly has no queue token in scope. Its read is still
  // a delivery and must claim, or the row stays 发送中 forever.
  const drainedOutside = await config.getSteeringMessages();
  assert.deepEqual(drainedOutside, [message]);
  assert.deepEqual(claimed, ["queued-1"]);
  assert.equal(claims.take(message as object), "queued-1");
  assert.equal(adapter.cancelPending("queued-1"), false);

  const second = sdkUser("two");
  currentId = "queued-2";
  agent.steer(second);
  currentId = "run";
  assert.deepEqual(await config.getSteeringMessages(), [second]);
  currentId = undefined;
  assert.deepEqual(claimed, ["queued-1", "queued-2"]);
  assert.equal(claims.take(second as object), "queued-2");
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

test("a resumed run skips one read of each queue and leaves the steered rows pending", async () => {
  const agent = sdkAgent();
  const claims = new SdkQueueClaims();
  let currentId: string | undefined;
  const claimed: string[] = [];
  const adapter = installSdkQueueAdapter(agent, {
    currentId: () => currentId,
    onClaim: (id) => claimed.push(id),
    claims,
  });
  const steered = sdkUser("queued while the run was live");
  const followUp = sdkUser("queued for after the run");
  currentId = "steer-1";
  agent.steer(steered);
  currentId = "follow-1";
  agent.followUp(followUp);
  currentId = undefined;

  // What continueTurn arms before it re-enters the loop: the resume's own reads
  // come back empty, and the objects stay exactly where the queue left them.
  adapter.suppressNextDrain();
  const config = (agent as unknown as {
    createLoopConfig(): {
      getSteeringMessages(): Promise<AgentMessage[]>;
      getFollowUpMessages(): Promise<AgentMessage[]>;
    };
  }).createLoopConfig();
  const later = sdkUser("steered into the resumed run");
  currentId = "steer-2";
  agent.steer(later);
  currentId = undefined;

  // Steering mode returns one message per read, so a naive "skip, then drain" would
  // hand this later steer back as the read it was supposed to suppress. Both of the
  // resume's own reads come back empty, and every object stays pending.
  assert.deepEqual(await config.getSteeringMessages(), []);
  assert.deepEqual(await config.getFollowUpMessages(), []);
  assert.deepEqual(claimed, []);
  assert.deepEqual(adapter.pendingIds().sort(), ["follow-1", "steer-1", "steer-2"]);

  // The suppression is exactly one read per queue. The resumed run's later polls
  // deliver what it held back, in the order it was queued, and claim it normally.
  assert.deepEqual(await config.getSteeringMessages(), [steered]);
  assert.deepEqual(await config.getSteeringMessages(), [later]);
  assert.deepEqual(claimed, ["steer-1", "steer-2"]);
  assert.equal(claims.take(later as object), "steer-2");
  assert.deepEqual(adapter.pendingIds(), ["follow-1"]);
});

test("a loop read outside a submission withdraws a refused object instead of throwing", async () => {
  const agent = sdkAgent();
  const claims = new SdkQueueClaims();
  let currentId: string | undefined;
  const withdrawn: string[] = [];
  const adapter = installSdkQueueAdapter(agent, {
    currentId: () => currentId,
    onClaim: (id) => {
      if (id === "paused") throw new Error("queue paused");
    },
    onWithdraw: (id) => withdrawn.push(id),
    claims,
  });
  const refused = sdkUser("held by a paused queue");
  const accepted = sdkUser("still deliverable");
  currentId = "paused";
  agent.steer(refused);
  currentId = "ok";
  agent.steer(accepted);
  currentId = undefined;
  const config = (agent as unknown as {
    createLoopConfig(): { getSteeringMessages(): Promise<AgentMessage[]> };
  }).createLoopConfig();

  // One-at-a-time: the refused head is withdrawn and the read moves on to the next.
  assert.deepEqual(await config.getSteeringMessages(), [accepted]);
  assert.deepEqual(withdrawn, ["paused"]);
  assert.deepEqual(adapter.pendingIds(), []);
  assert.equal(claims.take(refused as object), undefined);
  assert.equal(claims.take(accepted as object), "ok");
});

test("a failed durable claim withdraws the object instead of failing the run", async () => {
  const agent = sdkAgent();
  const claims = new SdkQueueClaims();
  const withdrawn: string[] = [];
  const adapter = installSdkQueueAdapter(agent, {
    currentId: () => "queued",
    onClaim: () => {
      throw new Error("disk full");
    },
    onWithdraw: (id) => withdrawn.push(id),
    claims,
  });
  agent.steer(sdkUser("one"));
  const config = (agent as unknown as {
    createLoopConfig(): { getSteeringMessages(): Promise<AgentMessage[]> };
  }).createLoopConfig();

  assert.deepEqual(await config.getSteeringMessages(), []);
  assert.deepEqual(withdrawn, ["queued"]);
  assert.deepEqual(adapter.pendingIds(), []);
});

test("messages enqueued later in a queue-started run are not filed under its spent id", async () => {
  const agent = sdkAgent();
  const claims = new SdkQueueClaims();
  const claimed: string[] = [];
  const adapter = installSdkQueueAdapter(agent, {
    // The drain's token stays in scope for the whole run it started.
    currentId: () => "opening",
    onClaim: (id) => {
      if (claimed.includes(id)) throw new Error("already claimed");
      claimed.push(id);
    },
    claims,
  });
  const opening = sdkUser("queued prompt");
  // The opening prompt's claim; the provider stream is never reached.
  await agent.prompt(opening).catch(() => undefined);
  assert.deepEqual(claimed, ["opening"]);

  // Goal mode continuing from agent_end, still inside the same async scope.
  const continuation = sdkUser("extension follow-up");
  agent.followUp(continuation);
  assert.deepEqual(adapter.pendingIds(), []);
  const config = (agent as unknown as {
    createLoopConfig(): { getFollowUpMessages(): Promise<AgentMessage[]> };
  }).createLoopConfig();
  assert.deepEqual(await config.getFollowUpMessages(), [continuation]);
  assert.deepEqual(claimed, ["opening"]);
});
