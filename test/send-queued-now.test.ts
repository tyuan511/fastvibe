import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { MessageQueueStore } from "../src/main/engine/message-queue.ts";

/**
 * 立即 stops the run in flight and then sends the queued row as the next turn.
 * These two methods are where that used to go wrong: steering the row into the run
 * it was meant to replace, and pausing the queue because the stop looked like the
 * user's own 停止.
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

const compiled = ts.transpileModule(
  `class Harness { ${method("withQueue")} ${method("sendQueuedNow")} ${method("settleQueue")} }`,
  { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None } },
).outputText;

function harness() {
  const dir = mkdtempSync(join(tmpdir(), "queue-now-"));
  const Harness = new Function("uiText", "parseCompactCommand", "parseHandoffCommand", `${compiled}; return Harness;`)(
    (zh: string) => zh,
    () => null,
    () => null,
  );
  const host = new Harness();
  const store = new MessageQueueStore(join(dir, "queue.json"));
  const drains: Array<string | undefined> = [];
  const interrupted: string[] = [];
  Object.assign(host, {
    messageQueue: store,
    queueDrainFaults: new Set<string>(),
    queueEpochs: new Map<string, number>(),
    queueOperations: new Map<string, Promise<unknown>>(),
    sdkQueueAdapters: new Map<string, unknown>(),
    reconcileClaims() { return false; },
    running: new Map<string, boolean>(),
    sessions: new Map<string, unknown>(),
    bumpQueueEpoch(id: string) { this.queueEpochs.set(id, (this.queueEpochs.get(id) ?? 0) + 1); },
    isLive(id: string) { return this.running.get(id) === true; },
    emitQueue() {},
    scheduleQueueDrain(id: string, preferred?: string) { drains.push(preferred ?? id); },
    interruptForNextPrompt(id: string) { interrupted.push(id); this.running.set(id, false); return Promise.resolve(); },
  });
  return {
    host, store, drains, interrupted, dir,
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  };
}

test("立即 stops the live run and drains the row as the next turn", async () => {
  const f = harness();
  try {
    f.host.running.set("chat", true);
    const item = f.store.add({ conversationId: "chat", text: "do the next thing", behavior: "followUp" });
    await f.host.sendQueuedNow(item.id);
    assert.deepEqual(f.interrupted, ["chat"]);
    assert.equal(f.store.state("chat").pause, null);
    assert.deepEqual(f.drains, [item.id]);
    assert.equal(f.store.get(item.id)?.sending, undefined);
  } finally {
    f.cleanup();
  }
});

test("立即 on an idle chat just drains, without pretending to stop anything", async () => {
  const f = harness();
  try {
    const item = f.store.add({ conversationId: "chat", text: "whenever", behavior: "followUp" });
    await f.host.sendQueuedNow(item.id);
    assert.deepEqual(f.interrupted, []);
    assert.deepEqual(f.drains, [item.id]);
  } finally {
    f.cleanup();
  }
});

test("a run ended by 立即 drains the queue instead of pausing it", async () => {
  const f = harness();
  try {
    const kept = f.store.add({ conversationId: "chat", text: "still queued", behavior: "followUp" });
    await f.host.settleQueue("chat", "handoff");
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(f.store.state("chat").pause, null, "the stop was asked for so the queue could continue");
    assert.equal(f.store.get(kept.id)?.sending, undefined);
    assert.deepEqual(f.drains, ["chat"]);
  } finally {
    f.cleanup();
  }
});

test("a run the user stopped outright still pauses the queue", async () => {
  const f = harness();
  try {
    f.store.add({ conversationId: "chat", text: "held", behavior: "followUp" });
    await f.host.settleQueue("chat", "stopped");
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(f.store.state("chat").pause, "stopped");
    assert.deepEqual(f.drains, []);
  } finally {
    f.cleanup();
  }
});
