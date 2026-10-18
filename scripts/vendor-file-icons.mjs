#!/usr/bin/env node
/**
 * Vendor the vscode-icons file icons into `resources/file-icons/`.
 *
 * **Run by hand, never from a lifecycle hook.** The output is committed, so a build needs no
 * network and no version drift: `pnpm dev` on a plane draws the same glyphs as this machine did.
 * Refresh it deliberately:
 *
 *     node scripts/vendor-file-icons.mjs            # fetch the pinned version from the marketplace
 *     node scripts/vendor-file-icons.mjs --vsix=…   # from a vsix already on disk
 *
 * The marketplace regenerates each vsix per request (three downloads of the same version came
 * back with three different hashes), so there is nothing stable to pin but the *content* — which
 * is why this script prints what it wrote and the repository keeps the result.
 *
 * What lands in `resources/file-icons/`:
 *   manifest.json  the lookup FastVibe's renderer consumes (see scripts/lib/file-icons-normalize.mjs)
 *   icons/*.svg    only the SVGs that manifest references, under their own basenames
 *   LICENSE.txt    vscode-icons' MIT licence, kept beside the files it covers
 */
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { normalizeIconTheme, LANGUAGE_EXTENSIONS } from "./lib/file-icons-normalize.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const OUT = join(ROOT, "resources", "file-icons");
const VERSION = "13.0.0";
const URL = `https://marketplace.visualstudio.com/_apis/public/gallery/publishers/vscode-icons-team/vsextensions/vscode-icons/${VERSION}/vspackage`;
const THEME_JSON = "extension/dist/src/vsicons-icon-theme.json";
const ICONS_DIR = "extension/icons";

const args = new Map(process.argv.slice(2).map((a) => {
  const [key, value] = a.split("=");
  return [key.replace(/^--/, ""), value ?? true];
}));

function unpack(vsix, into) {
  rmSync(into, { recursive: true, force: true });
  mkdirSync(into, { recursive: true });
  try {
    execFileSync("unzip", ["-q", "-o", vsix, "-d", into], { stdio: "inherit" });
  } catch {
    throw new Error(`解压失败（需要 unzip）：${vsix}`);
  }
}

function main() {
  const root = tmpdir();
  let dir;
  let vsix = typeof args.get("vsix") === "string" ? args.get("vsix") : null;
  if (vsix) {
    dir = dirname(vsix);
  } else {
    dir = join(root, `fv-vscode-icons-${process.pid}`);
    mkdirSync(dir, { recursive: true });
    vsix = join(dir, "vscode-icons.vsix");
    console.log(`下载 vscode-icons v${VERSION} …`);
    execFileSync("curl", ["-fsSL", "--retry", "3", "--retry-delay", "2", "-o", vsix, URL], { stdio: "inherit" });
  }
  const unpacked = join(dir, "unpacked");
  unpack(vsix, unpacked);

  const themeFile = join(unpacked, THEME_JSON);
  if (!existsSync(themeFile)) throw new Error(`vsix 里没有 ${THEME_JSON}`);
  const theme = JSON.parse(readFileSync(themeFile, "utf8"));
  const sourceIcons = join(unpacked, ICONS_DIR);
  if (!existsSync(sourceIcons)) throw new Error(`vsix 里没有 ${ICONS_DIR}`);

  const { manifest, icons, skippedLanguages } = normalizeIconTheme(theme);
  // A table key that names no language id in the theme is a typo, and it would otherwise sit
  // here forever doing nothing.
  const unknownKeys = Object.keys(LANGUAGE_EXTENSIONS).filter((key) => !(key in (theme.languageIds ?? {})));
  const missing = [...icons].filter((name) => !existsSync(join(sourceIcons, `${name}.svg`)));
  if (missing.length) throw new Error(`主题引用了不存在的图标：${missing.slice(0, 5).join(", ")}`);

  const iconOut = join(OUT, "icons");
  rmSync(iconOut, { recursive: true, force: true });
  mkdirSync(iconOut, { recursive: true });
  let bytes = 0;
  for (const name of icons) {
    const from = join(sourceIcons, `${name}.svg`);
    copyFileSync(from, join(iconOut, `${name}.svg`));
    bytes += statSync(from).size;
  }
  writeFileSync(join(OUT, "manifest.json"), `${JSON.stringify({ ...manifest, source: `vscode-icons ${VERSION}` }, null, 2)}\n`);
  const license = join(unpacked, "extension", "LICENSE.txt");
  if (existsSync(license)) copyFileSync(license, join(OUT, "LICENSE.txt"));
  else console.warn("警告：vsix 里没有 LICENSE.txt，MIT 授权文件没带上");

  const hash = createHash("sha256").update(
    [...icons].sort().map((name) => `${name}\t${createHash("sha256").update(readFileSync(join(sourceIcons, `${name}.svg`))).digest("hex")}`).join("\n"),
  ).digest("hex");

  console.log(
    [
      `写入 ${OUT.replace(`${ROOT}/`, "")}`,
      `  图标 ${icons.size} 个 SVG（${(bytes / 1048576).toFixed(1)} MB），内容摘要 ${hash.slice(0, 16)}…`,
      `  扩展名 ${Object.keys(manifest.fileExtensions).length}，文件名 ${Object.keys(manifest.fileNames).length}，`,
      `  文件夹名 ${Object.keys(manifest.folderNames).length}；浅色主题覆盖 ${manifest.light ? Object.keys(manifest.light).join("/") : "无"}`,
      `  未能折叠的 language id ${skippedLanguages.length} 个（这些类型退回通用文件图标）`,
      unknownKeys.length ? `  折叠表里对不上主题的键：${unknownKeys.join(" ")}` : "  折叠表的键全部对得上",
    ].join("\n"),
  );
  if (args.get("verbose") && skippedLanguages.length) console.log(`  ${skippedLanguages.join(" ")}`);
}

main();
