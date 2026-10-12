import { useEffect, useState, type JSX } from "react";
import { useTranslation } from "react-i18next";
import { HugeiconsIcon } from "@hugeicons/react";
import {
  ArrowLeft01Icon,
  ArrowRight01Icon,
} from "@hugeicons/core-free-icons";import { AppLogo } from "@/components/app-logo";
import { IconButton } from "@/components/icon-button";
import { useHistoryNav } from "@/lib/use-history-nav";
import { cn } from "@/lib/utils";
import { TITLE_BAR_HEIGHT } from "@/lib/window-chrome";

/**
 * The window's title bar on Windows and Linux.
 *
 * macOS hands its traffic lights to the app as an overlay (`hiddenInset`) and the
 * sidebar's first row is built around them; there is no such thing to inset on the
 * other two, where a native title bar above the app's own top row is two bars with
 * one of them empty. So the window there is frameless and this is the whole bar.
 *
 * It carries what the OS's own bar would have carried — the brand, and history — plus the
 * window controls the OS no longer draws. The *panel* controls are not here: 收起侧边栏 and
 * 搜索 live in the sidebar's top row, next to the panel they act on, and macOS' equivalent
 * row (its traffic-light row) holds the same three the same way. A brand that moved between
 * the two bars per platform is the one thing that would make the layouts read as different
 * apps, and 搜索 staying out of the top-right corner keeps it off the path a pointer takes to
 * 最小化.
 *
 * Everything is one drag region except the controls themselves, so the bar can be
 * moved from anywhere between them.
 */
export function TitleBar(): JSX.Element {
  const { t } = useTranslation("app");
  const { canBack, canForward, back, forward } = useHistoryNav();

  return (
    <div
      className={cn(
        "drag-region flex shrink-0 items-center justify-between border-b border-sidebar-border bg-sidebar pl-3",
        TITLE_BAR_HEIGHT,
      )}
    >
      <div className="no-drag flex min-w-0 items-center gap-3">
        <div className="flex shrink-0 items-center gap-2">
          <AppLogo className="size-5 shrink-0 rounded-md" />
          <span className="truncate text-sm font-semibold tracking-tight">FastVibe</span>
        </div>
        <div className="flex shrink-0 items-center gap-0.5">
          <IconButton
            size="icon-sm"
            variant="ghost"
            className="text-muted-foreground"
            label={t("sidebar.back")}
            disabled={!canBack}
            onClick={back}
          >
            <HugeiconsIcon strokeWidth={2} icon={ArrowLeft01Icon} />
          </IconButton>
          <IconButton
            size="icon-sm"
            variant="ghost"
            className="text-muted-foreground"
            label={t("sidebar.forward")}
            disabled={!canForward}
            onClick={forward}
          >
            <HugeiconsIcon strokeWidth={2} icon={ArrowRight01Icon} />
          </IconButton>
        </div>
      </div>

      <WindowControls />
    </div>
  );
}

/**
 * Windows' own caption-button metrics: 46px of hit area, squared off, flush to the
 * corner. The width is a fixed px value on purpose — this row stands in for chrome the
 * OS draws, and Windows does not scale its caption buttons with a font preference.
 * Close is the only one with a colour of its own, exactly as the platform has it.
 */
const CONTROL_CLASS = "no-drag flex h-full w-[46px] items-center justify-center text-muted-foreground transition-colors";

/**
 * Minimise / maximise / close, drawn by us because the window has no frame left to
 * draw them (see `lib/platform.ts`). The glyphs are the platform's own geometry —
 * hairlines and right angles — rather than the app's rounded icon set, which reads
 * as interface inside a bar that is not.
 */
function WindowControls(): JSX.Element {
  const { t } = useTranslation("app");
  const [maximized, setMaximized] = useState(false);

  useEffect(() => {
    let alive = true;
    void window.fastvibe.window
      .isMaximized()
      .then((value) => {
        if (alive) setMaximized(value);
      })
      .catch(() => undefined);
    // Main owns this because the OS can maximise the window too.
    const off = window.fastvibe.window.onState((state) => setMaximized(state.maximized));
    return () => {
      alive = false;
      off();
    };
  }, []);

  const label = maximized ? t("titleBar.restore") : t("titleBar.maximize");

  return (
    <div className="flex h-full shrink-0 items-stretch">
      <button
        type="button"
        className={cn(CONTROL_CLASS, "hover:bg-sidebar-accent hover:text-foreground")}
        aria-label={t("titleBar.minimize")}
        title={t("titleBar.minimize")}
        onClick={() => void window.fastvibe.window.minimize()}
      >
        <svg viewBox="0 0 10 10" className="size-2.5" aria-hidden="true">
          <path d="M0 5h10v1H0z" fill="currentColor" shapeRendering="crispEdges" />
        </svg>
      </button>
      <button
        type="button"
        className={cn(CONTROL_CLASS, "hover:bg-sidebar-accent hover:text-foreground")}
        aria-label={label}
        title={label}
        onClick={() => void window.fastvibe.window.toggleMaximize()}
      >
        {maximized ? (
          <svg viewBox="0 0 10 10" className="size-2.5" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="1" shapeRendering="crispEdges">
            <path d="M2.5.5h7v7h-2" />
            <path d="M.5 2.5h7v7h-7z" />
          </svg>
        ) : (
          <svg viewBox="0 0 10 10" className="size-2.5" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="1" shapeRendering="crispEdges">
            <path d="M.5.5h9v9h-9z" />
          </svg>
        )}
      </button>
      <button
        type="button"
        className={cn(CONTROL_CLASS, "hover:bg-destructive hover:text-destructive-foreground")}
        aria-label={t("titleBar.close")}
        title={t("titleBar.close")}
        onClick={() => void window.fastvibe.window.close()}
      >
        <svg viewBox="0 0 10 10" className="size-2.5" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="1" shapeRendering="crispEdges">
          <path d="M.5.5l9 9M9.5.5l-9 9" />
        </svg>
      </button>
    </div>
  );
}
