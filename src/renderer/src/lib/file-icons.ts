import { useEffect, useState } from "react";
import type { FileIconMapping } from "@shared/types";
import { IS_REMOTE } from "@/lib/platform";

/**
 * Material Icon Theme lookups. The association table is fetched once from Main
 * and cached for the whole renderer; the icons themselves are served under the
 * `fastvibe-icon` scheme, so a chip or a file-tree row only needs the icon name.
 */
let cache: FileIconMapping | null = null;
let pending: Promise<FileIconMapping> | null = null;
let resolved: Map<string, string> | null = null;

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

/** Extensions sorted longest-first so `d.ts` wins over `ts`. */
function sortedExtensions(mapping: FileIconMapping): Array<[string, string]> {
  return Object.entries(mapping.fileExtensions).sort((a, b) => b[0].length - a[0].length);
}

/** Resolve a file or folder name to a Material Icon Theme icon name. */
export function resolveFileIcon(mapping: FileIconMapping, name: string, kind: "file" | "folder" = "file"): string {
  const lower = name.toLowerCase();
  if (kind === "folder") return mapping.folder;
  if (!resolved) resolved = new Map();
  const hit = resolved.get(lower);
  if (hit) return hit;
  const named = mapping.fileNames[lower];
  let icon = named;
  if (!icon) {
    for (const [extension, candidate] of sortedExtensions(mapping)) {
      if (lower.endsWith(`.${extension}`)) {
        icon = candidate;
        break;
      }
    }
  }
  const value = icon ?? mapping.file;
  resolved.set(lower, value);
  return value;
}

/**
 * Where to fetch one icon, which depends on what can serve it.
 *
 * `fastvibe-icon://` is a `protocol.handle` registered in Main, so it resolves in a
 * desktop window and nowhere else: in the browser client every chip and file-tree row
 * came out as a broken image. The remote server serves the same directory over HTTP,
 * same-origin, which `remote.html`'s `img-src 'self'` already admits.
 */
export function fileIconUrl(icon: string): string {
  return IS_REMOTE ? `/file-icon/${icon}.svg` : `fastvibe-icon://icons/${icon}.svg`;
}
