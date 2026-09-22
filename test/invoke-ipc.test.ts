import assert from "node:assert/strict";
import test from "node:test";
import { invokeIpc } from "../src/renderer/src/lib/invoke-ipc.ts";

/**
 * The failure this exists for is a *stale preload*: `window.fastvibe.<group>.<method>` is
 * built by the preload, so a renderer that knows a channel the running preload does not
 * finds the method missing. That is a property access that throws *before* there is a
 * promise, and a call site written as `void bridge.thing().catch(...).finally(clearBusy)`
 * then never reaches either — the control spins forever, which is exactly what happened.
 */
test("a bridge method that does not exist rejects rather than throwing out of the chain", async () => {
  const bridge: { identifyGateway?: (id: string) => Promise<string> } = {};

  let caught: unknown;
  let cleared = false;
  await invokeIpc(() => (bridge.identifyGateway as (id: string) => Promise<string>)("id"))
    .catch((error: unknown) => {
      caught = error;
    })
    .finally(() => {
      cleared = true;
    });

  assert.ok(caught instanceof TypeError, "a missing method is reported, not swallowed");
  assert.equal(cleared, true, "the cleanup has to run, or the loading state is never cleared");
});

test("a working call is passed through untouched, rejection and value alike", async () => {
  assert.equal(await invokeIpc(async () => "ok"), "ok");

  const failure = new Error("面板拒绝了该访问令牌");
  await assert.rejects(
    invokeIpc(async () => {
      throw failure;
    }),
    (error: Error) => error === failure,
  );
});
