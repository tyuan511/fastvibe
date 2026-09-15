import type { JSX } from "react";
import { cn } from "@/lib/utils";
import { fileIconUrl, resolveFileIcon, useFileIcons } from "@/lib/file-icons";

/**
 * A Material Icon Theme glyph for a file or folder name. The mapping loads once
 * for the whole renderer, so this is cheap to render per row (file tree, chips).
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
  const icon = !mapping
    ? "file"
    : kind === "folder"
      ? expanded
        ? mapping.folderExpanded
        : mapping.folder
      : resolveFileIcon(mapping, name);
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
