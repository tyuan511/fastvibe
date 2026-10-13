import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { MessageQueueStore } from "../src/main/engine/message-queue.ts";
import { verdictAfterEnd, verdictAfterStart, verdictContinuesQueue } from "../src/main/pi/run-verdict.ts";
import { SendNowSpans } from "../src/main/pi/send-now.ts";

/**
 * 立即 stops the run in flight and then sends the queued row as the next turn.
 *
 * The manager's own queue methods run here against a real durable queue; only the
 * SDK is played by the harness (`interruptForNextPrompt` settles the run the way the
 * session's `agent_settled` handler does, `promptWhenIdle` claims the row and starts
 * the next one).
 */
const ts = createRequire(import.meta.url)("typescript") as typeof import("typescript");
const source = readFileSync(new URL("../src/main/pi/process-manager.ts", import.meta.url), "utf8");
const file = ts.createSourceFile("process-manager.ts", source, ts.ScriptTarget.Latest, true);

function method(name: string): string {
  let text = "";
  function visit(node: import("typescript").Node): void {
    if (
      (ts.isMethodDeclaration(node) || ts.isFunctionDeclaration(node)) &&
      node.name?.getText(file).replace(/^#/, "") === name
    ) {
      text = node.getText(file);
    }
    ts.forEachChild(node, visit);
  }
  visit(file);
  assert.ok(text, `missing ${name}`);
  return text.replaceAll("#", "");
}

const REAL = [
  "withQueue", "sendQueuedNow", "settleQueue", "scheduleQueueDrain", "drainQueue", "queueCanSubmit",
  "reviewSendNow", "endSendNow", "announceWorking", "working", "busy", "isLive", "emitQueue",
  "bumpQueueEpoch", "dropConsumedPrompt",
];
const compiled = ts.transpileModule(
  `class Harness { ${REAL.map(method).join("\n")} }`,
  { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None } },
).outputText;

type Event = { type: string; running?: boolean; conversationId?: string };

function harness(options: { stopFails?: boolean } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "queue-now-"));
  const Harness = new Function(
    "uiText", "parseCompactCommand", "parseHandoffCommand", "isAbortOutcome", "verdictContinuesQueue",
    `${compiled}; return Harness;`,
  )(
    (zh: string) => zh,
    (text: string) => (text.startsWith("/compact") ? {} : null),
    () => null,
    () => false,
    verdictContinuesQueue,
  );
  const host = new Harness();
  const store = new MessageQueueStore(join(dir, "queue.json"));
  const events: Event[] = [];
  const sent: string[] = [];
  const stopped: string[] = [];
  Object.assign(host, {
    messageQueue: store,
    sendNow: new SendNowSpans(),
    queueDrainFaults: new Set<string>(),
    queueRebuilds: new Set<string>(),
    drainingQueues: new Set<string>(),
    drainPromises: new Map<string, Promise<void>>(),
    preferredQueueIds: new Map<string, string>(),
    queueEpochs: new Map<string, number>(),
    queueOperations: new Map<string, Promise<unknown>>(),
    sdkQueueAdapters: new Map<string, unknown>(),
    running: new Map<string, boolean>(),
    compacting: new Map<string, unknown>(),
    busyBroadcast: new Map<string, boolean>(),
    turnEvents: new Map<string, unknown>(),
    queueShutdown: false,
    queueSubmission: { run: (_token: unknown, work: () => Promise<void>) => work() },
    reconcileClaims() { return false; },
    emit(event: Event) { events.push(event); },
    sessionFor: async () => ({ session: {} }),
    flushModelRebind: async () => undefined,
    beginTurn() {},
    /** The run starts: its `agent.prompt` claims the row, then `agent_start` fires. */
    async promptWhenIdle(_session: unknown, _text: string, _images: unknown, id: string) {
      const row = store.all(id).find((item) => !item.claimed && !item.sending)!;
      const picked = (this as { picking?: string }).picking ?? row.id;
      store.update(picked, { claimed: true, sending: true });
      this.emitQueue(id);
      sent.push(picked);
      this.sendNow.runStarted(id);
      this.running.set(id, true);
      this.announceWorking(id);
    },
    /** `session.abort()`: the run settles, exactly as the `agent_settled` handler files it. */
    async interruptForNextPrompt(id: string) {
      stopped.push(id);
      if (options.stopFails) throw new Error("停止当前响应超时");
      this.settle(id, "handoff");
    },
    settle(id: string, verdict: "stopped" | "error" | "handoff" | undefined) {
      this.sendNow.runSettled(id);
      this.running.set(id, false);
      this.announceWorking(id);
      this.settleQueue(id, verdict);
    },
  });
  // The drain names its candidate before it submits; the harness sends that one.
  const drain = host.queueCanSubmit.bind(host);
  host.queueCanSubmit = (conversationId: string, id: string, epoch?: number) => {
    host.picking = id;
    return drain(conversationId, id, epoch);
  };
  return {
    host, store, events, sent, stopped,
    idle: () => new Promise((resolve) => setTimeout(resolve, 10)),
    wentIdle: () => events.some((event) => event.type === "conversation_running" && event.running === false),
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  };
}

function live(f: ReturnType<typeof harness>): void {
  f.host.running.set("chat", true);
  f.host.announceWorking("chat");
}

test("立即 stops the live run, sends the row, and never reports the chat idle in between", async () => {
  const f = harness();
  try {
    live(f);
    const item = f.store.add({ conversationId: "chat", text: "do the next thing", behavior: "followUp" });
    await f.host.sendQueuedNow(item.id);
    await f.idle();
    assert.deepEqual(f.stopped, ["chat"]);
    assert.deepEqual(f.sent, [item.id]);
    assert.equal(f.store.state("chat").pause, null);
    assert.equal(f.wentIdle(), false, "the gap between the two runs is still this chat working");
    assert.equal(f.host.sendNow.has("chat"), false, "the run that was waited for has started");
  } finally {
    f.cleanup();
  }
});

test("立即 on a row that is not the head sends that row, not the head", async () => {
  const f = harness();
  try {
    live(f);
    f.store.add({ conversationId: "chat", text: "first", behavior: "followUp" });
    const clicked = f.store.add({ conversationId: "chat", text: "second", behavior: "followUp" });
    await f.host.sendQueuedNow(clicked.id);
    await f.idle();
    // The stopped run's own settle drains first, and it has no preference of its own.
    assert.equal(f.sent[0], clicked.id);
  } finally {
    f.cleanup();
  }
});

test("立即 on an idle chat just drains, and holds the chat working until the run starts", async () => {
  const f = harness();
  try {
    const item = f.store.add({ conversationId: "chat", text: "whenever", behavior: "followUp" });
    const done = f.host.sendQueuedNow(item.id);
    assert.equal(f.host.working("chat"), true, "working from the click, before any await");
    await done;
    await f.idle();
    assert.deepEqual(f.stopped, []);
    assert.deepEqual(f.sent, [item.id]);
    assert.equal(f.wentIdle(), false);
  } finally {
    f.cleanup();
  }
});

test("立即 on a paused queue releases the pause instead of being closed by it", async () => {
  const f = harness();
  try {
    const item = f.store.add({ conversationId: "chat", text: "held", behavior: "followUp" });
    f.store.pause("chat", "stopped");
    await f.host.sendQueuedNow(item.id);
    await f.idle();
    assert.deepEqual(f.sent, [item.id]);
    assert.equal(f.wentIdle(), false);
  } finally {
    f.cleanup();
  }
});

test("a stop that does not land takes the chat's working mark back to what the run says", async () => {
  const f = harness({ stopFails: true });
  try {
    live(f);
    const item = f.store.add({ conversationId: "chat", text: "next", behavior: "followUp" });
    await assert.rejects(f.host.sendQueuedNow(item.id), /超时/);
    assert.equal(f.host.sendNow.has("chat"), false);
    assert.equal(f.host.working("chat"), true, "the run is still live");
    assert.deepEqual(f.sent, []);
  } finally {
    f.cleanup();
  }
});

test("a Stop after 立即 ends it: the queue is held and the chat goes idle", async () => {
  const f = harness();
  try {
    const item = f.store.add({ conversationId: "chat", text: "next", behavior: "followUp" });
    f.host.sendNow.begin("chat", item.id, false);
    f.host.sendNow.arm("chat", item.id);
    f.host.announceWorking("chat");
    // What `abort()` does to the queue.
    f.store.pause("chat", "stopped");
    f.host.emitQueue("chat");
    assert.equal(f.host.sendNow.has("chat"), false);
    assert.equal(f.wentIdle(), true, "this is the client's cue to put the row back");
  } finally {
    f.cleanup();
  }
});

test("a queued /compact is not a reason to stop the run", async () => {
  const f = harness();
  try {
    live(f);
    const item = f.store.add({ conversationId: "chat", text: "/compact", behavior: "followUp" });
    await f.host.sendQueuedNow(item.id);
    assert.deepEqual(f.stopped, []);
    assert.equal(f.host.preferredQueueIds.get("chat"), item.id, "it is next once the run settles");
  } finally {
    f.cleanup();
  }
});

test("a run the user stopped outright still pauses the queue", async () => {
  const f = harness();
  try {
    live(f);
    f.store.add({ conversationId: "chat", text: "held", behavior: "followUp" });
    f.host.settle("chat", "stopped");
    await f.idle();
    assert.equal(f.store.state("chat").pause, "stopped");
    assert.deepEqual(f.sent, []);
  } finally {
    f.cleanup();
  }
});

test("a run the repetition guard stopped leaves the queue running", async () => {
  const f = harness();
  try {
    live(f);
    const item = f.store.add({ conversationId: "chat", text: "next", behavior: "followUp" });
    f.host.settle("chat", "repetition");
    await f.idle();
    // The guard stopped a reply that was never going to end by itself; the user's next
    // message is not something they should have to release by hand afterwards.
    assert.equal(f.store.state("chat").pause, null);
    assert.deepEqual(f.sent, [item.id]);
  } finally {
    f.cleanup();
  }
});

test("a stop that was asked for survives the turn the agent loop opens after a tool is aborted", () => {
  // Aborting mid-tool: tool results, `turn_end`, `turn_start`, then the aborted reply.
  for (const asked of ["handoff", "stopped", "repetition"] as const) {
    const afterTurnStart = verdictAfterStart(asked);
    assert.equal(afterTurnStart, asked);
    assert.equal(verdictAfterEnd(afterTurnStart, "aborted"), asked, "not a failed run");
  }
  // A verdict read off a failed attempt is the one a retry supersedes.
  assert.equal(verdictAfterStart("error"), undefined);
  assert.equal(verdictAfterEnd(undefined, "aborted"), "error");
  assert.equal(verdictAfterEnd(undefined, "stop"), undefined);
});

test("a span outlives the run it replaces and ends with the run it waits for", () => {
  const spans = new SendNowSpans();
  spans.begin("chat", "q1", true);
  assert.equal(spans.target("chat"), undefined, "not judged against the queue until armed");
  spans.arm("chat", "q1");
  assert.equal(spans.runStarted("chat"), false, "a retry of the run being stopped is not the one");
  assert.equal(spans.runSettled("chat"), "replaced");
  assert.equal(spans.has("chat"), true);
  assert.equal(spans.runStarted("chat"), true);
  assert.equal(spans.has("chat"), false);

  spans.begin("chat", "q2", false);
  assert.equal(spans.end("chat", "q1"), false, "an older request cannot close a newer span");
  assert.equal(spans.runSettled("chat"), "ended", "a prompt the SDK settled without starting");
  assert.equal(spans.has("chat"), false);
});
