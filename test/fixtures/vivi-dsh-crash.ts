import { openShadowStore } from "../../src/main/bot/shadow/store.ts";

// Deliberately exit without close/finally: the parent must recover the actual WAL.
const [file, phase] = process.argv.slice(2);
if (!file || !["before", "after", "running"].includes(phase!)) throw new Error("invalid crash fixture arguments");
const store = openShadowStore(file);
if (phase === "running") {
  store.effects.enqueue("reply", "crash-running", { version: 0 }, 0);
  const claim = store.effects.claim("reply", "crash-running", "crashed-owner", 0, 10)!;
  store.set("crashed-claim", claim);
  const other = openShadowStore(file);
  other.effects.enqueue("reply", "crash-running", { version: 1 }, 1);
  const operation = store.operations.plan({ id: "crash-operation", source: "fixture", instance: "crash", key: "write", payload: { text: "external write" } });
  store.operations.transition(operation, "uncertain", { lookup: "remote-id" });
  process.stdout.write("running-committed\n");
  process.exit(43);
}
store.atomic(() => {
  store.set("crash-intent", { phase });
  store.effects.enqueue("reply", "crash-reply", { text: "durable intent" }, 1);
  store.receipts.add({ id: "crash-message", kind: "reply", channel: { source: "fixture", thread: "t", address: {} }, text: "first message" });
  store.afterCommit(() => {
    process.stdout.write("after-commit\n");
    if (phase === "after") process.exit(42);
  });
  if (phase === "before") {
    process.stdout.write("before-commit\n");
    process.exit(41);
  }
});
throw new Error("fixture failed to exit at crash boundary");
