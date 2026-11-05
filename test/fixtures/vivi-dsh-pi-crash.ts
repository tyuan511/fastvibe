import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { ModelRuntime, type ExtensionFactory } from "@earendil-works/pi-coding-agent";
import { createFauxCore, fauxAssistantMessage, InMemoryModelsStore } from "@earendil-works/pi-ai";
import { openShadowStore } from "../../src/main/bot/shadow/store.ts";
import { ScratchPiSession } from "../../src/main/bot/shadow/pi-session.ts";

const [root, mode] = process.argv.slice(2);
assert.ok(root && ["accepted", "jsonl-before-receipt", "receipt", "report-committed-before-mirror"].includes(mode!));
const store = openShadowStore(join(root, "shadow.db"));
const faux = createFauxCore({ api: "dsh-crash-faux", provider: "dsh-faux", models: [{ id: "scripted" }] });
faux.setResponses([fauxAssistantMessage("预热持久历史"), fauxAssistantMessage("崩溃前不得完成")]);
const runtime = await ModelRuntime.create({ authPath: join(root, "auth.json"), modelsPath: null, modelsStore: new InMemoryModelsStore(), allowModelNetwork: false, refreshOnCreate: false });
runtime.registerProvider("dsh-faux", { baseUrl: "http://faux.invalid", api: "dsh-crash-faux" as never, apiKey: "unused", streamSimple: faux.streamSimple as never, models: [{ id: "scripted", name: "scripted", reasoning: false, input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 100_000, maxTokens: 4096 }] });
const extension: ExtensionFactory = pi => {
  pi.on("input", event => {
    if (event.text === "CRASH_INPUT" && mode === "accepted") process.exit(71);
  });
};
const adapter = await ScratchPiSession.open({
  store, root, binding: { ticketId: "sdk-ticket", assignmentId: "sdk-assignment", generation: 1, claimToken: 1 },
  modelRuntime: runtime, model: runtime.getModel("dsh-faux", "scripted")!, extensions: [extension],
  onReport: (_token, report) => {
    store.set("crash-report-domain", report);
    store.set("crash-report-calls", (store.get<number>("crash-report-calls") ?? 0) + 1);
    return true;
  },
  onPersisted: (_token, ids) => {
    if (mode === "receipt" && ids.includes("crash-input")) {
      store.afterCommit(() => {
        assert.ok(adapter.get("crash")?.entryId);
        process.exit(73);
      });
    }
  },
});
await adapter.resume();
await (await adapter.submit({ requestId: "warmup", text: "建立真实 SDK 历史" })).completion;
if (mode === "report-committed-before-mirror") {
  // warmup is replayed from the parent's ledger; Continue creates an actual
  // current provider turn without adding another user message.
  await adapter.continue();
  const report = { state: "ready" as const, summary: "SQL 已提交但 mirror 尚未追加" };
  store.atomic(() => {
    // This callback precedes the adapter's REPORT mirror callback in the same
    // outer transaction: process death proves the SQL-only committed window.
    store.afterCommit(() => {
      assert.equal(adapter.get("warmup")!.reports.length, 1);
      assert.deepEqual(store.get("crash-report-domain"), report);
      assert.doesNotMatch(readFileSync(adapter.session.sessionFile!, "utf8"), /fastvibe-dsh-report/);
      process.exit(74);
    });
    assert.equal(adapter.report(report), true);
    assert.equal(adapter.get("warmup")!.stage, "reported");
  });
}
if (mode === "jsonl-before-receipt") {
  // Inject process death after the actual SDK append, before the adapter can
  // acknowledge it. The real SessionManager writes its normal JSONL throughout.
  const manager = adapter.session.sessionManager;
  const append = manager.appendMessage.bind(manager);
  manager.appendMessage = message => {
    const id = append(message);
    if (message.role === "user" && JSON.stringify(message.content).includes("CRASH_INPUT")) {
      assert.match(readFileSync(adapter.session.sessionFile!, "utf8"), /CRASH_INPUT/);
      assert.equal(adapter.get("crash")?.entryId, undefined);
      process.exit(72);
    }
    return id;
  };
}
await (await adapter.submit({ requestId: "crash", text: "CRASH_INPUT", inputIds: ["crash-input"] })).completion;
throw new Error(`未触发预期真实子进程崩溃边界：${mode}`);
