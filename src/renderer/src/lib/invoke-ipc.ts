/**
 * Call the preload bridge in a way that **cannot throw synchronously**.
 *
 * `window.fastvibe.<group>.<method>()` is a property access on an object the preload
 * built. When the preload is older than the renderer — a dev process that was not
 * restarted after a channel was added, or an update whose renderer reloaded while the old
 * preload stayed — the method is simply *absent*. Calling it throws before there is a
 * promise to catch, so the obvious spelling
 *
 * ```ts
 * void window.fastvibe.providers.identifyGateway(id).then(...).finally(() => setBusy(false));
 * ```
 *
 * never reaches its `catch` or its `finally`: the loading state set one line earlier is
 * never cleared and the control spins forever with nothing on screen to explain it. That
 * is a class of bug rather than one call site — every `void …then().finally()` in the app
 * has it — so the throw is turned into a rejection here.
 *
 * This module deliberately imports nothing, so the tests can load it straight from source.
 */
export async function invokeIpc<T>(call: () => Promise<T>): Promise<T> {
  return await call();
}
