import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import test from "node:test";
import type { ConversationQueueState, EngineEvent, QueuePauseReason } from "../src/shared/types.ts";
import { shouldQueueSubmission } from "../src/renderer/src/lib/composer-race.ts";
import { applyAroundSentNow, retractOptimisticTurn, type SentNow } from "../src/renderer/src/stores/session-reducer.ts";

const ts = createRequire(import.meta.url)("typescript") as typeof import("typescript");
const source = readFileSync(new URL("../src/renderer/src/stores/session.ts", import.meta.url), "utf8");
const file = ts.createSourceFile("session.ts", source, ts.ScriptTarget.Latest, true);

// Exercise the actual reducer and queue action without loading React/zustand or a DOM.
function extract(name: string): string {
  let text = "";
  function visit(node: import("typescript").Node): void {
    if (ts.isFunctionDeclaration(node) && node.name?.text === name) text = node.getText(file);
    if (ts.isPropertyAssignment(node) && node.name.getText(file) === name) text = `const ${name} = ${node.initializer.getText(file)};`;
    ts.forEachChild(node, visit);
  }
  visit(file);
  assert.ok(text, `missing ${name}`);
  return ts.transpileModule(text, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None },
  }).outputText;
}

function fixture() {
  let state = {
    activeId: "chat",
    messages: [] as Array<{ id: string }>,
    streaming: false,
    queued: [] as ConversationQueueState["items"],
    sentNow: null as SentNow | null,
    queuePause: null as QueuePauseReason | null,
    queuePauseByConversation: {} as Record<string, QueuePauseReason | null>,
    queueRevisionByConversation: {} as Record<string, number>,
    runInterrupted: "error" as "error" | "aborted" | null,
    pendingPermissions: {},
  };
  type State = typeof state;
  const reduce = new Function(
    "applyAroundSentNow", "applyEngineEvent", "parsePermission", "applyExtensionUi", "extensionScope",
    "upsertSubagent", "applySubagentStream", "activeRunning", "activePermission", "waitingFrom",
    `${extract("reduceEvents")} return reduceEvents;`,
  )(
    applyAroundSentNow,
    (messages: unknown, event: EngineEvent, streaming: boolean) => ({
      messages,
      streaming: event.type === "agent_settled" ? false : streaming,
    }),
    () => undefined, () => ({}), () => "chat",
    (value: unknown) => value, (value: unknown) => value,
    () => ({}), () => null, () => ({}),
  ) as (state: State, events: EngineEvent[]) => Partial<State>;
  const setQueue = new Function("set", "retractOptimisticTurn", `${extract("setQueueState")} return setQueueState;`)(
    (update: (state: State) => Partial<State>) => { state = { ...state, ...update(state) }; },
    retractOptimisticTurn,
  ) as (queue: ConversationQueueState) => void;
  const visible = new Function(`const exports = {}; ${extract("visibleQueue")} return visibleQueue;`)() as
    (queued: State["queued"], id: string | null, sentNow: SentNow | null) => State["queued"];
  return {
    get state() { return state; },
    set(patch: Partial<State>) { state = { ...state, ...patch }; },
    tray: () => visible(state.queued, state.activeId, state.sentNow),
    setQueue,
    settle: () => { state = { ...state, ...reduce(state, [{ type: "agent_settled", conversationId: "chat" }]) }; },
  };
}

function queue(revision: number, pause: QueuePauseReason | null, pending = true): ConversationQueueState {
  return {
    conversationId: "chat", revision, pause,
    items: pending ? [{ id: "q1", conversationId: "chat", text: "next", behavior: "followUp", attachments: [] }] : [],
  };
}

test("a late settled event cannot re-pause a queue Main already resumed", () => {
  const f = fixture();
  f.setQueue(queue(1, "error"));
  f.setQueue(queue(2, null));
  f.settle();
  assert.equal(f.state.queuePause, null);
  assert.equal(f.state.queuePauseByConversation.chat, undefined);
  assert.equal(f.state.queueRevisionByConversation.chat, 2);
  assert.equal(f.state.queued.length, 1);
});

test("real durable pauses survive transcript settlement until a newer queue snapshot", () => {
  for (const reason of ["error", "stopped"] as const) {
    const f = fixture();
    f.setQueue(queue(2, reason));
    f.settle();
    assert.equal(f.state.queuePause, reason);
    f.setQueue(queue(1, null));
    assert.equal(f.state.queuePause, reason);
    f.setQueue(queue(3, null));
    assert.equal(f.state.queuePause, null);
  }
});

const drawn = [{ id: "queue:q1" }, { id: "queue-reply:q1", role: "assistant", text: "", tools: [], parts: [] }];
const sentAt = (revision: number): SentNow => ({ conversationId: "chat", id: "q1", over: null, revision });

test("a row drawn as a turn is still queued, and only left out of the tray", () => {
  const f = fixture();
  f.set({ messages: drawn, sentNow: sentAt(0) });
  f.setQueue(queue(1, null));
  assert.equal(f.state.queued.length, 1, "a Send made now has to queue behind it");
  assert.equal(f.tray().length, 0, "the click already showed it; the snapshot must not undo that");
  assert.equal(f.state.messages.length, 2);
});

test("a queue paused after the click puts the turn back in the tray", () => {
  const f = fixture();
  f.set({ messages: drawn, sentNow: sentAt(1) });
  // The pause the click itself released: same revision the click was made against.
  f.setQueue(queue(1, "stopped"));
  assert.equal(f.state.sentNow?.id, "q1");
  f.setQueue(queue(2, null));
  f.setQueue(queue(3, "stopped"));
  assert.equal(f.state.sentNow, null);
  assert.deepEqual(f.state.messages, []);
  assert.equal(f.tray().length, 1);
});

test("a row withdrawn from the queue takes its drawn turn with it", () => {
  const f = fixture();
  f.set({ messages: drawn, sentNow: sentAt(0) });
  f.setQueue(queue(1, null, false));
  assert.equal(f.state.sentNow, null);
  assert.deepEqual(f.state.messages, []);
});

test("delivery followed by late settlement leaves fresh Send usable", () => {
  const f = fixture();
  f.setQueue(queue(1, "error"));
  f.setQueue(queue(2, null, false));
  f.settle();
  assert.equal(f.state.queuePause, null);
  assert.equal(f.state.queued.length, 0);
  assert.equal(shouldQueueSubmission({
    hasConversation: true,
    running: f.state.streaming,
    hasQueuedItems: f.state.queued.length > 0,
  }), false);
});
