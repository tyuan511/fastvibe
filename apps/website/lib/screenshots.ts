import type { Locale } from "next-intl";

export const screenshotScenes = ["workspace", "review", "models"] as const;
export type ScreenshotScene = (typeof screenshotScenes)[number];

/** Each locale has its own capture of the real renderer, including macOS chrome. */
export function screenshotUrl(locale: Locale, scene: ScreenshotScene) {
  return `/screenshots/${locale}/${scene}.webp`;
}
