import type { Locale } from "next-intl";

/**
 * Every scene the capture harness renders (`scripts/capture-website.mjs` holds the
 * matching list — keep the two in step).
 *
 * `files`, `tools` and `market` are captured for the READMEs rather than for this site:
 * both READMEs show the same figures, so serving them from one pipeline is what keeps
 * the two languages from drifting apart into separately taken screenshots.
 */
export const screenshotScenes = ["workspace", "files", "review", "tools", "models", "market"] as const;
export type ScreenshotScene = (typeof screenshotScenes)[number];

/**
 * The scenes this site itself renders — the three feature rows.
 *
 * Narrower than `screenshotScenes` on purpose: each one is looked up in the `features`
 * namespace, which is typed from `messages/*.json`, so a scene with no copy there is a
 * build error rather than a screenshot with a missing caption.
 */
export const featureScenes = ["workspace", "review", "models"] as const;
export type FeatureScene = (typeof featureScenes)[number];

/** Each locale has its own capture of the real renderer, including macOS chrome. */
export function screenshotUrl(locale: Locale, scene: ScreenshotScene) {
  return `/screenshots/${locale}/${scene}.webp`;
}
