import type { JSX } from "react";
import appIconLight from "@/assets/app-icon-light.png";
import appIconDark from "@/assets/app-icon-dark.png";
import { cn } from "@/lib/utils";

/**
 * The FastVibe mark on its rounded tile. Light and dark themes each get a baked
 * asset (white tile / black tile) so the gradient mark keeps its contrast
 * whichever way the app is themed. The swap rides the `dark` class `applyTheme`
 * toggles, so "follow system" is covered too.
 */
export function AppLogo({ className }: { className?: string }): JSX.Element {
  return (
    <>
      <img
        src={appIconLight}
        alt=""
        aria-hidden="true"
        draggable={false}
        className={cn("dark:hidden", className)}
      />
      <img
        src={appIconDark}
        alt=""
        aria-hidden="true"
        draggable={false}
        className={cn("hidden dark:block", className)}
      />
    </>
  );
}
