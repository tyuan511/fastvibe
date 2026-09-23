import { useEffect, useState, type CSSProperties, type JSX } from "react";
import { Toaster as Sonner, type ToasterProps } from "sonner";
import { HugeiconsIcon } from "@hugeicons/react";
import {
  Alert02Icon,
  Cancel01Icon,
  CheckmarkCircle02Icon,
  InformationCircleIcon,
  Loading03Icon,
  MultiplicationSignCircleIcon,
} from "@hugeicons/core-free-icons";
import { useSettingsStore } from "@/stores/settings";
import { resolveTheme, systemPrefersDark } from "@/lib/themes";

/**
 * shadcn's sonner, with the theme wired to this app's own.
 *
 * The generated component reads `next-themes`, which FastVibe does not use: appearance
 * lives in `lib/themes.ts`, which writes a theme's tokens onto `<html>` and toggles the
 * `dark` class (twenty-odd named themes, not two). Outside a `ThemeProvider`
 * `useTheme()` reports "system", so a window pinned to 亮色 while the OS is dark would
 * have handed sonner the wrong one.
 *
 * The colours come from the CSS variables below, so a toast follows whichever theme is
 * active without naming any of them; `theme` only decides sonner's own light/dark class,
 * and it is resolved through `resolveTheme` — the same function the rest of the shell
 * uses, so there is one answer to "which kind is showing".
 */
function useThemeKind(): "light" | "dark" {
  const themeMode = useSettingsStore((state) => state.settings.themeMode);
  const lightTheme = useSettingsStore((state) => state.settings.lightTheme);
  const darkTheme = useSettingsStore((state) => state.settings.darkTheme);
  const [prefersDark, setPrefersDark] = useState(systemPrefersDark);

  // Only matters while themeMode is "system", but subscribing unconditionally keeps the
  // hook order fixed and costs one listener.
  useEffect(() => {
    const media = window.matchMedia("(prefers-color-scheme: dark)");
    const sync = (): void => setPrefersDark(media.matches);
    sync();
    media.addEventListener("change", sync);
    return () => media.removeEventListener("change", sync);
  }, []);

  return resolveTheme({ themeMode, lightTheme, darkTheme }, prefersDark).kind;
}

/**
 * The toast is drawn by us, not by sonner (`unstyled`). Sonner's own skin brings its own
 * font stack, a fixed 13px size, and description greys (`#3f3f3f` / `#e8e8e8`) that are
 * the same on every theme — so a toast was the one surface that ignored both the theme
 * and 界面字号. It now matches `PopoverContent` through the shared overlay surface:
 * translucent popover colour, a quiet border and desktop-style shadow, `rounded-lg`,
 * `text-sm` title over a muted `text-xs` description, and the type carried by the icon's
 * colour alone rather than a tinted card.
 *
 * `unstyled` drops only sonner's `[data-styled=true]` rules; stacking, swiping and the
 * enter/exit motion stay its own. The one visual rule of that set worth keeping is that a
 * toast stacked behind the front one hides its content — otherwise its text shows through
 * the peeking edge — so it is restated below.
 */
function Toaster({ ...props }: ToasterProps): JSX.Element {
  const kind = useThemeKind();

  return (
    <Sonner
      theme={kind}
      className="toaster group"
      closeButton
      icons={{
        success: <HugeiconsIcon icon={CheckmarkCircle02Icon} strokeWidth={2} className="size-4 text-success" />,
        info: <HugeiconsIcon icon={InformationCircleIcon} strokeWidth={2} className="size-4 text-info" />,
        warning: <HugeiconsIcon icon={Alert02Icon} strokeWidth={2} className="size-4 text-warning" />,
        error: <HugeiconsIcon icon={MultiplicationSignCircleIcon} strokeWidth={2} className="size-4 text-destructive" />,
        loading: (
          <HugeiconsIcon icon={Loading03Icon} strokeWidth={2} className="size-4 animate-spin text-muted-foreground" />
        ),
        close: <HugeiconsIcon icon={Cancel01Icon} strokeWidth={2} className="size-3.5" />,
      }}
      // rem, so the column follows 界面字号 like everything else.
      style={{ "--width": "22rem" } as CSSProperties}
      toastOptions={{
        unstyled: true,
        classNames: {
          toast:
            "overlay-surface group/toast flex w-(--width) items-start gap-2.5 rounded-lg bg-popover/95 p-3 pr-9 font-sans text-sm text-popover-foreground outline-hidden focus-visible:ring-2 focus-visible:ring-ring/50 *:transition-opacity data-[expanded=false]:data-[front=false]:*:opacity-0",
          icon: "relative mt-0.5 flex size-4 shrink-0 items-center justify-center",
          content: "flex min-w-0 flex-1 flex-col gap-0.5",
          title: "leading-5 font-medium",
          description: "text-xs leading-relaxed text-muted-foreground",
          actionButton:
            "h-6 shrink-0 self-center rounded-md bg-primary px-2 text-xs font-medium text-primary-foreground transition-colors hover:bg-primary/85 focus-visible:ring-2 focus-visible:ring-ring/50 focus-visible:outline-hidden",
          cancelButton:
            "h-6 shrink-0 self-center rounded-md bg-muted px-2 text-xs font-medium text-muted-foreground transition-colors hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/50 focus-visible:outline-hidden",
          // Hover-revealed like the transcript's row actions, and always drawn on touch,
          // where there is no hover to reveal it. The colours are `!`: sonner's dark theme
          // paints the close button in one rule `unstyled` does not gate, and at four
          // attribute selectors it outranks any utility.
          closeButton:
            "absolute top-2.5 right-2.5 flex size-5 items-center justify-center rounded-md bg-transparent! text-muted-foreground! opacity-0 transition hover:bg-muted! hover:text-foreground! focus-visible:opacity-100 focus-visible:ring-2 focus-visible:ring-ring/50 focus-visible:outline-hidden group-hover/toast:opacity-100 pointer-coarse:opacity-100",
        },
      }}
      {...props}
    />
  );
}

export { Toaster };
