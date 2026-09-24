/**
 * Resolve when a prompt is *sent*, not when its run is over.
 *
 * `start` is handed the SDK's `preflightResult` callback and returns the promise of the
 * whole run. The result settles on acceptance (`preflightResult(true)`), rejects when the
 * prompt was refused before that point, and treats a Stop (`isAbort`) as sent. A run
 * that fails after acceptance is not the caller's failure — its outcome reaches every
 * client as events — so it goes to `onLateFailure` instead of rejecting a call that
 * already answered "sent".
 */
export function promptAccepted(
  start: (preflightResult: (success: boolean) => void) => Promise<void>,
  options: { isAbort: (error: unknown) => boolean; onLateFailure: (error: unknown) => void },
): Promise<void> {
  let accepted = false;
  return new Promise<void>((resolve, reject) => {
    let run: Promise<void>;
    try {
      run = start((success) => {
        if (!success || accepted) return;
        accepted = true;
        resolve();
      });
    } catch (error) {
      reject(error);
      return;
    }
    run.then(
      // Paths that never call back (a prompt deferred while the SDK emits
      // `agent_settled`, an extension command) still end the call.
      () => resolve(),
      (error: unknown) => {
        if (options.isAbort(error)) return resolve();
        if (!accepted) return reject(error);
        options.onLateFailure(error);
      },
    );
  });
}
