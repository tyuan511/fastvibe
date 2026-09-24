import assert from "node:assert/strict";
import test from "node:test";
import { promptAccepted } from "../src/main/pi/prompt-acceptance.ts";

const abort = (error: unknown): boolean => error instanceof Error && error.name === "AbortError";

function deferred(): { promise: Promise<void>; resolve: () => void; reject: (error: unknown) => void } {
  let resolve!: () => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<void>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

test("resolves on acceptance while the run is still going", async () => {
  const run = deferred();
  let settled = false;
  const call = promptAccepted((preflight) => {
    queueMicrotask(() => preflight(true));
    return run.promise;
  }, { isAbort: abort, onLateFailure: () => assert.fail("no late failure") });
  void call.then(() => { settled = true; });
  await call;
  assert.equal(settled, true);
  run.resolve();
});

test("a run that fails after acceptance does not reject the call", async () => {
  const run = deferred();
  const late: unknown[] = [];
  await promptAccepted((preflight) => {
    preflight(true);
    return run.promise;
  }, { isAbort: abort, onLateFailure: (error) => late.push(error) });
  const failure = new Error("502 mid-run");
  run.reject(failure);
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(late, [failure]);
});

test("a refused prompt rejects with the refusal", async () => {
  const refusal = new Error("No API key found");
  await assert.rejects(
    promptAccepted((preflight) => {
      preflight(false);
      return Promise.reject(refusal);
    }, { isAbort: abort, onLateFailure: () => assert.fail("not accepted") }),
    refusal,
  );
});

test("a throw before the preflight ran is a refusal too", async () => {
  const refusal = new Error("Cannot submit a prompt while compaction is in progress.");
  await assert.rejects(
    promptAccepted(() => Promise.reject(refusal), { isAbort: abort, onLateFailure: () => assert.fail("not accepted") }),
    refusal,
  );
});

test("a path that never calls back still ends when the SDK returns", async () => {
  await promptAccepted(() => Promise.resolve(), { isAbort: abort, onLateFailure: () => assert.fail("no failure") });
});

test("Stop before acceptance counts as sent, not as a failure", async () => {
  const stop = Object.assign(new Error("aborted"), { name: "AbortError" });
  await promptAccepted(() => Promise.reject(stop), { isAbort: abort, onLateFailure: () => assert.fail("abort is not a failure") });
});
