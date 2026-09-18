import { useEffect, useState, type JSX } from "react";
import { useTranslation } from "react-i18next";
import { HugeiconsIcon } from "@hugeicons/react";
import {
  ArrowLeft01Icon,
  ArrowRight01Icon,
  PanelLeftCloseIcon,
  PanelLeftOpenIcon,
  Search01Icon,
} from "@hugeicons/core-free-icons";
import { AppLogo } from "@/components/app-logo";
import { IconButton } from "@/components/icon-button";
import { useHistoryNav } from "@/lib/use-history-nav";
import { useShortcutLabel } from "@/lib/use-shortcuts";
import { cn } from "@/lib/utils";
import { setSidebarCollapsed, useSidebarCollapsed } from "@/lib/sidebar-visibility";

/**
 * The window's title bar on Windows and Linux.
 *
 * macOS hands its traffic lights to the app as an overlay (`hiddenInset`) and the
 * sidebar's first row is built around them; there is no such thing to inset on the
 * other two, where a native title bar above the app's own top row is two bars with
 * one of them empty. So the window there is frameless and this is the whole bar:
 * the brand that the sidebar's logo row used to carry, the sidebar's controls, and
 * the window controls the OS no longer draws — the same row, on all three.
 *
 * Everything is one drag region except the controls themselves, so the bar can be
 * moved from anywhere between them.
 */
export function TitleBar({ onSearch }: { onSearch: () => void }): JSX.Element {
  const { t } = useTranslation("app");
  const sidebarCollapsed = useSidebarCollapsed();
  const toggleSidebarShortcut = useShortcutLabel("toggleSidebar");
  const searchShortcut = useShortcutLabel("commandPalette");
  const { canBack, canForward, back, forward } = useHistoryNav();

  return (
    <div className="drag-region flex h-11 shrink-0 items-center justify-between border-b border-sidebar-border bg-sidebar pr-1 pl-4">
      <div className="no-drag flex min-w-0 items-center gap-3">
        <div className="flex shrink-0 items-center gap-2">
          <AppLogo className="size-5 shrink-0 rounded-md" />
          <span className="text-sm font-semibold tracking-tight">FastVibe</span>
        </div>
        <span className="h-4 w-px shrink-0 bg-sidebar-border" aria-hidden />
        <div className="flex shrink-0 items-center gap-0.5">
          <IconButton
            size="icon-sm"
            variant="ghost"
            className="text-muted-foreground"
            label={sidebarCollapsed ? t("workspace.expandSidebar") : t("sidebar.collapseSidebar")}
            shortcut={toggleSidebarShortcut}
            onClick={() => setSidebarCollapsed(!sidebarCollapsed)}
          >
            <HugeiconsIcon strokeWidth={2} icon={sidebarCollapsed ? PanelLeftOpenIcon : PanelLeftCloseIcon} />
          </IconButton>
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

      <div className="no-drag flex h-full shrink-0 items-center">
        <IconButton
          size="icon-sm"
          variant="ghost"
          className="mr-2 text-muted-foreground"
          label={t("sidebar.search")}
          shortcut={searchShortcut}
          onClick={onSearch}
        >
          <HugeiconsIcon strokeWidth={2} icon={Search01Icon} />
        </IconButton>
        <WindowControls />
      </div>
    </div>
  );
}

/** Windows' own button metrics: 46px of hit area, squared off, flush to the corner. */
const CONTROL_CLASS = "no-drag flex h-full w-11 items-center justify-center text-muted-foreground transition-colors";

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
