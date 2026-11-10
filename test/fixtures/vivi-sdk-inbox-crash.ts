import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { createFauxCore, InMemoryModelsStore } from "@earendil-works/pi-ai";
import { ScratchPiSession } from "../../src/main/bot/shadow/pi-session.ts";
import { openShadowStore } from "../../src/main/bot/shadow/store.ts";

// Abrupt process exit deliberately skips adapter.dispose/store.close. No network.
const root = process.argv[2]; assert.ok(root);
const store = openShadowStore(join(root, "shadow.db"));
const faux = createFauxCore({ api: "inbox-faux-api", provider: "inbox-faux", models: [{ id: "offline" }] });
faux.setResponses([]);
const runtime = await ModelRuntime.create({ authPath: join(root, "auth.json"), modelsPath: null, modelsStore: new InMemoryModelsStore(), allowModelNetwork: false, refreshOnCreate: false });
runtime.registerProvider("inbox-faux", { baseUrl: "http://faux.invalid", api: "inbox-faux-api" as never, apiKey: "unused", streamSimple: (() => { throw new Error("Child must never dispatch provider"); }) as never,
  models: [{ id: "offline", name: "offline", reasoning: false, input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 100_000, maxTokens: 4096 }] });
const adapter = await ScratchPiSession.open({ store, root, binding: { ticketId: "inbox-ticket", assignmentId: "inbox-assignment", generation: 1, claimToken: 1 },
  modelRuntime: runtime, model: runtime.getModel("inbox-faux", "offline")!,
  extensions: [pi => { pi.on("input", () => { throw new Error("prepare must not enter SDK input hook"); }); }] });
const receipt = adapter.prepare({ requestId: "prepared", text: "DURABLE_INBOX_INPUT", inputIds: ["input-1"] });
assert.equal(receipt.stage, "accepted"); assert.equal(receipt.entryId, undefined);
assert.deepEqual(store.sessionReceipts.get(adapter.sessionKey, "prepared"), receipt);
assert.equal(faux.state.callCount, 0);
const transcript = readFileSync(adapter.session.sessionFile!, "utf8").trim().split("\n").map(line => JSON.parse(line));
assert.equal(transcript.some(row => row.type === "message" && row.message.role === "user"), false);
process.exit(76);
