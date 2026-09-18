import { toast } from "sonner";
import { remoteDenialReason } from "@shared/remote-policy";
import { IS_REMOTE } from "@/lib/platform";

/**
 * What this client cannot do, asked of the same table the server refuses with.
 *
 * The remote server denies a narrow set of methods — native dialogs that would open on
 * a machine nobody is looking at, actions that would land on the *host's* desktop, an
 * update that would quit the app under whoever is sitting at it
 * (`shared/remote-policy.ts`). Denying them is correct and is not enough: a control that
 * does nothing when pressed and explains nothing is indistinguishable from a bug.
 *
 * So the control stays where it is and says why on the way out. Not hidden: a feature
 * that vanishes on one client and not another is its own confusion — someone following
 * a screenshot, or their own memory of the desktop, finds the button simply gone and has
 * no way to learn that the reason is *where they are*. Not disabled either, because a
 * disabled control cannot tell you anything; this one answers when asked.
 *
 * The reason is the server's own sentence, from one table, so the notice and a refusal
 * that slips past can never disagree — and a method reclassified in the policy changes
 * both at once.
 */

/**
 * Whether this click should stop here, having said why.
 *
 * Called *before* doing the work, so the guarded action never runs:
 *
 *     onClick={() => {
 *       if (blockedRemotely(Ipc.projectsAdd)) return;
 *       onAddProject();
 *     }}
 *
 * Always false on the desktop, where nothing is denied — the call sites read the same in
 * both builds, and there is no second code path to keep in step.
 */
export function blockedRemotely(method: string): boolean {
  if (!IS_REMOTE) return false;
  const reason = remoteDenialReason(method);
  if (reason === null) return false;
  // The method is the toast's id, so pressing a refused control repeatedly refreshes the
  // one notice instead of stacking copies of the same sentence.
  toast.info(reason, { id: `remote-denied:${method}` });
  return true;
}
