import type { JSX, ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import { ContextMenu, ContextMenuContent, ContextMenuItem, ContextMenuTrigger } from "@/components/ui/context-menu";
import { cn } from "@/lib/utils";
import { resolvePath } from "@/lib/workspace-path";
import { useSessionStore, useWorkspacePath } from "@/stores/session";

/**
 * The actions every path in the app offers: preview it, show it in the file manager,
 * copy it.
 *
 * A path appears in several places — a reply's inline code, a file chip, the viewer's
 * breadcrumb, a folded tool summary — and the one thing that must not drift is what
 * right-clicking it does. Claude's own file pane offers the same set on a breadcrumb
 * segment as on a path in the transcript, so this is one component those callers compose
 * rather than three menus that look alike.
 */
export function PathMenuItems({ path }: { path: string }): JSX.Element {
  const { t } = useTranslation("chat");
  return (
    <>
      <ContextMenuItem onClick={() => void useSessionStore.getState().openPreview(path)}>
        {t("preview.pathPreview")}
      </ContextMenuItem>
      <ContextMenuItem onClick={() => void revealPath(path, t("preview.pathMissing"))}>
        {t("preview.pathReveal")}
      </ContextMenuItem>
      <ContextMenuItem onClick={() => void copyPath(path, t("preview.pathCopied"))}>
        {t("preview.pathCopy")}
      </ContextMenuItem>
    </>
  );
}

/**
 * Show a path in the OS file manager.
 *
 * The host answers with a reason rather than throwing, because the usual failure is
 * ordinary — the file was moved or deleted since the pane read it — and a toast that
 * says which is more useful than a rejected promise.
 */
export async function revealPath(path: string, missing: string): Promise<void> {
  const result = await window.fastvibe.workspace.reveal(path);
  if (result && result.ok === false) toast.error(missing);
}

/**
 * A path as every other path in a reply is drawn: underlined name, click to preview,
 * right-click for {@link PathMenuItems}.
 *
 * The trigger is a span, not the menu's default div, so it can sit inside a paragraph,
 * inline code, or the fold row's button. The click stops there: that button is the
 * fold, and opening the file must not also expand it.
 */
export function PathLink({
  path,
  children,
  className,
  title,
}: {
  path: string;
  children: ReactNode;
  className?: string;
  /** Shown on hover when the visible text is only the file name. */
  title?: string;
}): JSX.Element {
  const cwd = useWorkspacePath();
  const resolved = resolvePath(path, cwd);
  return (
    <ContextMenu>
      <ContextMenuTrigger
        render={
          <span
            title={title}
            className={cn(
              "cursor-pointer text-primary underline decoration-primary/40 underline-offset-2 hover:decoration-primary",
              className,
            )}
          />
        }
        onClick={(event) => {
          event.preventDefault();
          event.stopPropagation();
          void useSessionStore.getState().openPreview(resolved);
        }}
      >
        {children}
      </ContextMenuTrigger>
      <ContextMenuContent className="w-48">
        <PathMenuItems path={resolved} />
      </ContextMenuContent>
    </ContextMenu>
  );
}

export async function copyPath(path: string, copied: string): Promise<void> {
  try {
    await navigator.clipboard.writeText(path);
    toast.success(copied);
  } catch {
    // The clipboard can refuse outside a user gesture; the path is on screen either way.
  }
}
