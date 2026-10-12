/**
 * The height of the title bar the app draws for itself on Windows and Linux
 * (`components/layout/title-bar.tsx`).
 *
 * Two places need it and they must not drift apart: the bar itself, and the settings
 * overlay, which starts *below* the bar so the window controls stay reachable while a
 * pane is open (`settings-dialog.tsx`). They are Tailwind class names rather than a
 * number because both uses are classes; a fixed height, not one that follows 界面字号 —
 * this row stands in for the OS's own chrome, and Windows does not scale it either.
 */
export const TITLE_BAR_HEIGHT = "h-10";
export const TITLE_BAR_OFFSET = "top-10";
