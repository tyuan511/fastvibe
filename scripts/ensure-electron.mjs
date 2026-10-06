#!/usr/bin/env node
/**
 * Make sure the Electron binary is actually on disk before `electron-vite dev` asks for it.
 *
 * The `electron` package is only JavaScript; its postinstall (`install.js`) is what
 * unpacks the binary into `dist/` and writes `path.txt`. An install that relinks the
 * package from the pnpm store without running that script — one started by another
 * tool, or with scripts ignored — leaves a package that resolves fine and has no
 * binary, and `electron-vite` reports it only as `Error: Electron uninstall`.
 *
 * Re-running the package's own install script is the whole fix: it reuses the zip in
 * the Electron cache when there is one, so this costs nothing when the binary is there
 * and a second or two when it is not.
 *
 *   node scripts/ensure-electron.mjs
 */
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";

const require = createRequire(import.meta.url);
const dir = dirname(require.resolve("electron/package.json"));

function installed() {
  const pathFile = join(dir, "path.txt");
  if (!existsSync(pathFile)) return false;
  return existsSync(join(dir, "dist", readFileSync(pathFile, "utf8").trim()));
}

if (!installed()) {
  console.log("[ensure-electron] Electron binary missing, running its install script");
  execFileSync(process.execPath, [join(dir, "install.js")], { cwd: dir, stdio: "inherit" });
  if (!installed()) {
    console.error("[ensure-electron] Electron is still missing after install.js");
    process.exit(1);
  }
}
