import { useEffect, useState } from "react";
import type { FileIconMapping } from "@shared/types";

/**
 * Loading the file-icon association table. Main reads the vendored vscode-icons manifest once
 * (`resources/file-icons/manifest.json`) and hands it to every client; the SVGs themselves are
 * served under the `fastvibe-icon` scheme, so a chip or a file-tree row only needs the name.
 *
 * The lookup rules live in `@shared/file-icons` (`resolveFileIcon`, `fileIconUrl`) so they stay
 * free of React and testable.
 */
let cache: FileIconMapping | null = null;
let pending: Promise<FileIconMapping> | null = null;

export function loadFileIcons(): Promise<FileIconMapping> {
  if (!pending) {
    pending = window.fastvibe.workspace.fileIcons().then((mapping) => {
      cache = mapping;
      return mapping;
    });
  }
  return pending;
}

export function useFileIcons(): FileIconMapping | null {
  const [mapping, setMapping] = useState<FileIconMapping | null>(cache);
  useEffect(() => {
    if (cache) return;
    let active = true;
    void loadFileIcons()
      .then((value) => {
        if (active) setMapping(value);
      })
      .catch(() => undefined);
    return () => {
      active = false;
    };
  }, []);
  return mapping;
}

export { fileIconUrl, resolveFileIcon } from "@shared/file-icons";
