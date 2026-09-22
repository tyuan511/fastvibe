import type { JSX } from "react";
import appIconLight from "@/assets/app-icon-light.png";
import appIconDark from "@/assets/app-icon-dark.png";
import { cn } from "@/lib/utils";

/**
 * The FastVibe mark on its rounded blue tile. The asset is self-contained
 * (white F on the brand gradient), so the same file reads on light and dark;
 * the `dark` class swap is kept so a future theme-specific tile can land
 * without touching call sites.
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
