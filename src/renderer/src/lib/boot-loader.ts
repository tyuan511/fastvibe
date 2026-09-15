const BOOT_LOADER_ID = "fastvibe-boot";

let dismissed = false;

/**
 * Fade out the static boot splash that `index.html` paints before the module
 * bundle runs.
 *
 * The splash is a plain DOM node React never owns, so it is never unmounted and
 * re-created: its stroke animation runs continuously from the first paint, and
 * the hand-off to the app is a single opacity transition instead of a restart.
 *
 * Called once the engine has settled (see `App`), so the splash never reveals a
 * second loader or a still-empty shell mid-transition. `main.tsx` also arms a
 * watchdog so a stuck engine cannot keep the splash — and the window — captive.
 */
export function dismissBootLoader(): void {
  if (dismissed) return;
  dismissed = true;
  const node = document.getElementById(BOOT_LOADER_ID);
  if (!node) return;
  node.dataset.dismissed = "";
  node.addEventListener("transitionend", () => node.remove(), { once: true });
  // `transitionend` never fires if the element is already hidden or the
  // transition is skipped, so remove it regardless once the fade would be done.
  window.setTimeout(() => node.remove(), 600);
}
