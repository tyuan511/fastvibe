import { existsSync, readFileSync, readdirSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { protocol } from "electron";
import type { FileIconMapping } from "@shared/types";

/**
 * File icons come from the Material Icon Theme VS Code extension
 * (`material-icon-theme`), the most-installed file icon pack. It ships ~1250 SVG
 * icons plus a `material-icons.json` association table; FastVibe serves the SVGs
 * over a private scheme and hands the renderer the lookup table, so the chat's
 * change chips and (later) the project file tree share one icon source.
 */
export const FILE_ICON_SCHEME = "fastvibe-icon";

type ThemeManifest = {
  fileExtensions: Record<string, string>;
  fileNames: Record<string, string>;
  file: string;
  folder: string;
  folderExpanded: string;
};

let packageRoot: string | null = null;
let cachedMapping: FileIconMapping | null = null;
let availableIcons: Set<string> | null = null;

function iconsRoot(): string {
  if (!packageRoot) {
    const require = createRequire(import.meta.url);
    packageRoot = dirname(require.resolve("material-icon-theme/package.json"));
  }
  return packageRoot;
}

function iconsDir(): string {
  return join(iconsRoot(), "icons");
}

/**
 * Where the SVGs are, for a transport that cannot use the private scheme.
 *
 * The browser client has no `protocol.handle`, so the remote server serves the same
 * directory over HTTP (`server/server.ts`). One directory, two transports — the same
 * reason the call table itself is shared.
 */
export function fileIconsDirectory(): string {
  return iconsDir();
}

/** Icon names that actually ship as files (the manifest also names generated clones). */
function available(): Set<string> {
  if (!availableIcons) {
    availableIcons = new Set(
      readdirSync(iconsDir())
        .filter((file) => file.endsWith(".svg"))
        .map((file) => file.slice(0, -4).toLowerCase()),
    );
  }
  return availableIcons;
}

function iconOrFallback(name: string, fallback: string): string {
  return available().has(name.toLowerCase()) && existsSync(join(iconsDir(), `${name}.svg`)) ? name : fallback;
}

/** Must run before `app.whenReady()` so the scheme is usable from the renderer. */
export function registerFileIconScheme(): void {
  protocol.registerSchemesAsPrivileged([
    {
      scheme: FILE_ICON_SCHEME,
      privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true },
    },
  ]);
}

/** Serves `fastvibe-icon://icons/<name>.svg` out of the icon package. */
export function registerFileIconProtocol(): void {
  const directory = iconsDir();
  protocol.handle(FILE_ICON_SCHEME, (request) => {
    const name = new URL(request.url).pathname.replace(/^\/+/, "").replace(/\.svg$/, "");
    if (!/^[a-z0-9._-]+$/i.test(name)) return new Response("Bad icon name", { status: 400 });
    const file = join(directory, `${name}.svg`);
    // Unknown names (the manifest references some generated clones) fall back to
    // the generic file glyph instead of a broken image.
    const target = existsSync(file) ? file : join(directory, "file.svg");
    return new Response(readFileSync(target), {
      headers: { "content-type": "image/svg+xml", "cache-control": "public, max-age=86400" },
    });
  });
}

export function getFileIconMapping(): FileIconMapping {
  if (cachedMapping) return cachedMapping;
  const manifest = JSON.parse(
    readFileSync(join(iconsRoot(), "dist", "material-icons.json"), "utf8"),
  ) as ThemeManifest;
  const pick = (name: string): string => iconOrFallback(name, manifest.file);
  cachedMapping = {
    fileExtensions: Object.fromEntries(
      Object.entries(manifest.fileExtensions).map(([extension, icon]) => [extension, pick(icon)]),
    ),
    fileNames: Object.fromEntries(
      Object.entries(manifest.fileNames).map(([name, icon]) => [name, pick(icon)]),
    ),
    file: manifest.file,
    folder: iconOrFallback(manifest.folder, manifest.file),
    folderExpanded: iconOrFallback(manifest.folderExpanded, manifest.file),
  };
  return cachedMapping;
}
