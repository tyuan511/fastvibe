import type { JSX } from "react";
import fMark from "@/assets/f-mark.png";
import { i18n } from "@/lib/i18n";
import { cn } from "@/lib/utils";

/**
 * The FastVibe mark breathing under a soft halo — the app's global loading mark.
 *
 * The mark is the shipped app icon with its background stripped, so the brand
 * gradient survives; the halo is a blurred radial disc behind it, which keeps the
 * loader legible on both the light and the dark background. `index.html` paints
 * the same mark in its boot splash, so `dismissBootLoader()` hands the screen off
 * with a fade instead of restarting the animation.
 */
export function FLoader({
  className,
  label,
}: {
  className?: string;
  /** Accessible name; the mark is decorative chrome when a label is already shown. */
  label?: string;
}): JSX.Element {
  return (
    <span role="status" aria-label={label ?? (i18n.t("app:loading") as string)} className={cn("fv-loader size-11", className)}>
      <span className="fv-loader-glow" aria-hidden="true" />
      <img className="fv-loader-mark" src={fMark} alt="" aria-hidden="true" draggable={false} />
    </span>
  );
}
