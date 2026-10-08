/**
 * 玻璃效果 (设置 → 通用 → 外观): the window drawn over the macOS blur, in whichever theme
 * is active.
 *
 * Two halves have to agree on it: Main turns the window's vibrancy on, and the renderer
 * gives the theme translucent surfaces (`glassTokens` in themes.ts). Translucent surfaces
 * over a window with no vibrancy show the page background through, and vibrancy under
 * opaque surfaces shows nothing — so both read `settings.glass` through this one function,
 * and a missing key means the same thing to each: on.
 */
export function isGlassEnabled(settings: { glass?: unknown }): boolean {
  return settings.glass !== false;
}
