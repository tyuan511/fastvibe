import type { JSX } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import { ContextMenuItem } from "@/components/ui/context-menu";
import { useSessionStore } from "@/stores/session";

/**
 * The actions every path in the app offers: preview it, show it in the file manager,
 * copy it.
 *
 * A path appears in several places — a reply's inline code, a file chip, the viewer's
 * breadcrumb — and the one thing that must not drift is what right-clicking it does.
 * Claude's own file pane offers the same set on a breadcrumb segment as on a path in
 * the transcript, so this is one component those callers compose rather than three
 * menus that look alike.
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

export async function copyPath(path: string, copied: string): Promise<void> {
  try {
    await navigator.clipboard.writeText(path);
    toast.success(copied);
  } catch {
    // The clipboard can refuse outside a user gesture; the path is on screen either way.
  }
}
