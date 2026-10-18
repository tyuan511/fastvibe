import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { protocol } from "electron";
import { MEDIA_SCHEME } from "@shared/media-preview";
import type { FileIconMapping, FileIconVariant } from "@shared/types";

/**
 * File icons come from **vscode-icons** (24.7M installs on the Marketplace, MIT), vendored into
 * `resources/file-icons` by `scripts/vendor-file-icons.mjs`. FastVibe serves the SVGs over a
 * private scheme and hands the renderer the lookup table, so the file tree, the chat's per-turn
 * change chips and the inline previews all read one source.
 *
 * The directory is committed rather than fetched at build time: a build needs no network, and two
 * machines cannot quietly end up drawing different glyphs.
 */
export const FILE_ICON_SCHEME = "fastvibe-icon";

let cachedMapping: FileIconMapping | null = null;
let availableIcons: Set<string> | null = null;

/**
 * Where this install keeps the icons, resolved exactly as the built-in skills, extensions and
 * memory templates are: `FASTVIBE_RESOURCES_PATH` (Main sets it to `process.resourcesPath` when
 * packaged, to `<appPath>/resources` in a dev tree), falling back to `<cwd>/resources`.
 */
export function fileIconsResourceDir(): string {
  return join(process.env.FASTVIBE_RESOURCES_PATH?.trim() || join(process.cwd(), "resources"), "file-icons");
}

function iconsDir(): string {
  return join(fileIconsResourceDir(), "icons");
}

/** Icon names that actually ship as files. A manifest that names a missing one falls back. */
function available(): Set<string> {
  if (!availableIcons) {
    // A missing directory is a packaging mistake, not a crash: everything then resolves to the
    // generic glyph, which is what the fallback below is for.
    let entries: string[] = [];
    try {
      entries = readdirSync(iconsDir());
    } catch {
      entries = [];
    }
    availableIcons = new Set(
      entries.filter((file) => file.endsWith(".svg")).map((file) => file.slice(0, -4).toLowerCase()),
    );
  }
  return availableIcons;
}

function iconOrFallback(name: string, fallback: string): string {
  return available().has(name.toLowerCase()) ? name : fallback;
}

/**
 * Must run before `app.whenReady()` so the schemes are usable from the renderer.
 * Electron accepts this call only once, so the icon scheme and the local video
 * scheme are declared together. `stream` is what lets a `<video>` seek: without it
 * the response is buffered whole and range requests never play.
 */
export function registerFileIconScheme(): void {
  protocol.registerSchemesAsPrivileged([
    {
      scheme: FILE_ICON_SCHEME,
      privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true },
    },
    {
      scheme: MEDIA_SCHEME,
      privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true, stream: true },
    },
  ]);
}

/** Serves `fastvibe-icon://icons/<name>.svg` out of the vendored icon directory. */
export function registerFileIconProtocol(): void {
  const directory = iconsDir();
  protocol.handle(FILE_ICON_SCHEME, (request) => {
    const name = new URL(request.url).pathname.replace(/^\/+/, "").replace(/\.svg$/, "");
    if (!/^[a-z0-9._-]+$/i.test(name)) return new Response("Bad icon name", { status: 400 });
    const file = join(directory, `${name}.svg`);
    // A name with no file behind it (a stale manifest, a made-up path) falls back to the
    // generic document glyph instead of a broken image.
    const target = existsSync(file) ? file : join(directory, "default_file.svg");
    if (!existsSync(target)) return new Response("Icon not found", { status: 404 });
    return new Response(readFileSync(target), {
      headers: { "content-type": "image/svg+xml", "cache-control": "public, max-age=86400" },
    });
  });
}

export function getFileIconMapping(): FileIconMapping {
  if (cachedMapping) return cachedMapping;
  const manifest = JSON.parse(
    readFileSync(join(fileIconsResourceDir(), "manifest.json"), "utf8"),
  ) as FileIconMapping;
  const pick = (name: string): string => iconOrFallback(name, manifest.file);
  const fold = (map: Record<string, string> | undefined) =>
    Object.fromEntries(Object.entries(map ?? {}).map(([key, icon]) => [key, pick(icon)]));
  // A light override whose SVG is not on disk is dropped rather than pointed at the generic
  // glyph: the resolver then falls back to the default artwork, which is the right answer.
  const foldVariant = (variant: FileIconVariant | undefined): FileIconVariant | undefined => {
    if (!variant) return undefined;
    const kept: FileIconVariant = {};
    for (const key of ["fileExtensions", "fileNames", "folderNames", "folderNamesExpanded"] as const) {
      const entries = Object.entries(variant[key] ?? {}).filter(([, icon]) => available().has(icon.toLowerCase()));
      if (entries.length) kept[key] = Object.fromEntries(entries);
    }
    for (const key of ["file", "folder", "folderExpanded"] as const) {
      const icon = variant[key];
      if (icon && available().has(icon.toLowerCase())) kept[key] = icon;
    }
    return Object.keys(kept).length ? kept : undefined;
  };
  cachedMapping = {
    ...manifest,
    fileExtensions: fold(manifest.fileExtensions),
    fileNames: fold(manifest.fileNames),
    folderNames: fold(manifest.folderNames),
    folderNamesExpanded: fold(manifest.folderNamesExpanded),
    file: manifest.file,
    folder: iconOrFallback(manifest.folder, manifest.file),
    folderExpanded: iconOrFallback(manifest.folderExpanded, manifest.folder),
    light: foldVariant(manifest.light),
  };
  return cachedMapping;
}
