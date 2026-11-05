// SPDX-License-Identifier: MIT
import { appendFileSync } from "node:fs";
import { ShadowEffects } from "../../src/main/bot/shadow/effects.ts";
import { ShadowOperations } from "../../src/main/bot/shadow/operations.ts";
import { openShadowStore } from "../../src/main/bot/shadow/store.ts";

const [file, journal, mode] = process.argv.slice(2);
if (!file || !journal || !["before-handler", "before-execute", "after-execute"].includes(mode!)) throw new Error("Invalid crash fixture arguments");
const store = openShadowStore(file);
const effects = new ShadowEffects(store, { now: () => 1000, owner: "crash-child", leaseMs: 1000 });
const operations = new ShadowOperations(store, effects, {
  execute: async operation => {
    if (store.operations.get(operation.source, operation.instance, operation.key)?.status !== "uncertain") process.exit(90);
    if (mode === "before-execute") process.exit(71);
    appendFileSync(journal, JSON.stringify({ id: operation.id, payload: operation.payload }) + "\n");
    return { status: "confirmed", receipt: { external: operation.id } };
  },
  inspect: async () => { throw new Error("Child must not inspect"); },
}, { now: () => 1000 });
if (mode === "after-execute") {
  const transition = store.operations.transition;
  store.operations.transition = (...args) => {
    // Kill inside the real generic effect commit, after transport success and before SQL facts.
    if (args[1] === "confirmed") process.exit(72);
    return transition(...args);
  };
}
if (mode === "before-handler") {
  const set = store.set.bind(store);
  store.set = (key, value) => {
    set(key, value);
    if (key.startsWith("shadow:effect:attempt:")) {
      // Exit after the real claim + snapshot transaction commits, before handler dispatch.
      store.afterCommit(() => process.exit(73));
    }
  };
}
operations.plan({ id: "crash-op", source: "source", instance: "instance", key: "k", payload: { remote: "value" } });
effects.start();
await effects.idle();
process.exit(91);
