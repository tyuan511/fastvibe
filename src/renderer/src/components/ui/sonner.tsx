import { useEffect, useState, type CSSProperties, type JSX } from "react";
import { Toaster as Sonner, type ToasterProps } from "sonner";
import { HugeiconsIcon } from "@hugeicons/react";
import {
  Alert02Icon,
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

function Toaster({ ...props }: ToasterProps): JSX.Element {
  const kind = useThemeKind();

  return (
    <Sonner
      theme={kind}
      className="toaster group"
      icons={{
        success: <HugeiconsIcon icon={CheckmarkCircle02Icon} strokeWidth={2} className="size-4" />,
        info: <HugeiconsIcon icon={InformationCircleIcon} strokeWidth={2} className="size-4" />,
        warning: <HugeiconsIcon icon={Alert02Icon} strokeWidth={2} className="size-4" />,
        error: <HugeiconsIcon icon={MultiplicationSignCircleIcon} strokeWidth={2} className="size-4" />,
        loading: <HugeiconsIcon icon={Loading03Icon} strokeWidth={2} className="size-4 animate-spin" />,
      }}
      style={
        {
          "--normal-bg": "var(--popover)",
          "--normal-text": "var(--popover-foreground)",
          "--normal-border": "var(--border)",
          "--border-radius": "var(--radius)",
        } as CSSProperties
      }
      toastOptions={{ classNames: { toast: "cn-toast" } }}
      {...props}
    />
  );
}

export { Toaster };
