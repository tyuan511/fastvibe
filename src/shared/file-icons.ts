import type { FileIconMapping, FileIconVariant } from "./types";

/**
 * Name → icon-name resolution, shared by every surface that draws a file glyph (the project
 * file tree, the chat's per-turn change chips, the inline preview strip).
 *
 * It lives here rather than in the renderer's `lib/file-icons.ts` because that module loads the
 * mapping through React state; this is the part with rules worth pinning in a test — the
 * longest-extension-first lookup, the extension-less `Dockerfile` case, and the light-theme
 * override below.
 */

/** Which glyph set a name resolves against: the theme's default one, or its light variant. */
export type FileIconOptions = {
  kind?: "file" | "folder";
  /** Folders only: the open-folder glyph. */
  expanded?: boolean;
  /** The interface is on a light theme: prefer the icon pack's light-specific artwork. */
  light?: boolean;
};

type Index = {
  /** Extensions sorted longest-first, so `d.ts` wins over `ts`. */
  extensions: Array<[string, string]>;
  /** The same pairs by exact key, for the extension-less names below. */
  extensionMap: Map<string, string>;
  fileNames: Map<string, string>;
  folderNames: Map<string, string>;
  folderNamesExpanded: Map<string, string>;
  file: string;
  folder: string;
  folderExpanded: string;
};

const indexes = new WeakMap<FileIconMapping, { default: Index; light: Index }>();

function merge(base: Record<string, string> | undefined, over: Record<string, string> | undefined): Map<string, string> {
  return new Map([...Object.entries(base ?? {}), ...Object.entries(over ?? {})]);
}

function buildIndex(mapping: FileIconMapping, variant?: FileIconVariant): Index {
  const extensionMap = merge(mapping.fileExtensions, variant?.fileExtensions);
  return {
    extensions: [...extensionMap].sort((a, b) => b[0].length - a[0].length),
    extensionMap,
    fileNames: merge(mapping.fileNames, variant?.fileNames),
    folderNames: merge(mapping.folderNames, variant?.folderNames),
    folderNamesExpanded: merge(mapping.folderNamesExpanded, variant?.folderNamesExpanded),
    file: variant?.file ?? mapping.file,
    folder: variant?.folder ?? mapping.folder,
    folderExpanded: variant?.folderExpanded ?? mapping.folderExpanded,
  };
}

function indexOf(mapping: FileIconMapping, light: boolean): Index {
  let cached = indexes.get(mapping);
  if (!cached) {
    cached = { default: buildIndex(mapping), light: buildIndex(mapping, mapping.light) };
    indexes.set(mapping, cached);
  }
  return light ? cached.light : cached.default;
}

/** Resolve a file or folder name to an icon name from the vendored manifest. */
export function resolveFileIcon(
  mapping: FileIconMapping,
  name: string,
  options: FileIconOptions = {},
): string {
  const { kind = "file", expanded = false, light = false } = options;
  const index = indexOf(mapping, light);
  const lower = name.toLowerCase();
  if (kind === "folder") {
    const named = (expanded ? index.folderNamesExpanded.get(lower) : undefined) ?? index.folderNames.get(lower);
    return named ?? (expanded ? index.folderExpanded : index.folder);
  }
  let icon = index.fileNames.get(lower);
  if (!icon) {
    for (const [extension, candidate] of index.extensions) {
      if (lower.endsWith(`.${extension}`)) {
        icon = candidate;
        break;
      }
    }
  }
  // `Dockerfile` and `Makefile` have no extension to look up, yet that is exactly how the
  // manifest keys them — the whole name stands in for the extension.
  if (!icon && !lower.includes(".")) icon = index.extensionMap.get(lower);
  return icon ?? index.file;
}

/**
 * Where to fetch one icon: `fastvibe-icon://` is a `protocol.handle` registered in Main, which
 * serves the vendored directory to the window.
 */
export function fileIconUrl(icon: string): string {
  return `fastvibe-icon://icons/${icon}.svg`;
}
