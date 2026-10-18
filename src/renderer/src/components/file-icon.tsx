import type { JSX } from "react";
import { cn } from "@/lib/utils";
import { useIsDarkTheme } from "@/lib/use-theme";
import { fileIconUrl, resolveFileIcon, useFileIcons } from "@/lib/file-icons";

/**
 * A file-icon glyph for a file or folder name (vscode-icons, vendored into
 * `resources/file-icons`). The mapping loads once for the whole renderer, so this is
 * cheap to render per row (file tree, chips), and the light-theme artwork follows the
 * active theme because the pack draws some marks differently on a white row.
 */
export function FileIcon({
  name,
  kind = "file",
  expanded = false,
  className,
}: {
  name: string;
  kind?: "file" | "folder";
  /** Folders only: use the open-folder glyph. */
  expanded?: boolean;
  className?: string;
}): JSX.Element {
  const mapping = useFileIcons();
  const dark = useIsDarkTheme();
  const icon = !mapping ? "default_file" : resolveFileIcon(mapping, name, { kind, expanded, light: !dark });
  return (
    <img
      src={fileIconUrl(icon)}
      alt=""
      aria-hidden="true"
      draggable={false}
      className={cn("size-4 shrink-0", className)}
    />
  );
}
