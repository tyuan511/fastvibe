const BOOT_LOADER_ID = "fastvibe-boot";

/**
 * Remove the static splash after the initial workspace has committed (see App).
 * Keep it opaque until that handoff: fading a loading surface mixes two startup
 * states and exposes placeholders behind the brand mark. BootRecovery offers a
 * reload on slow starts; it never uncovers a transcript that is still loading.
 */
export function dismissBootLoader(): void {
  document.getElementById(BOOT_LOADER_ID)?.remove();
}
