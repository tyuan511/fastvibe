#!/usr/bin/env node
/**
 * Point `scripts/officecli.json` at another OfficeCLI release.
 *
 *   pnpm sync:officecli -- --version v1.0.158
 *   pnpm sync:officecli -- --latest
 *
 * The only input is that release's own `SHA256SUMS`, read over HTTPS and mapped onto the
 * platform table in `src/shared/office.ts`. What it writes is a diff to review: the hashes in
 * the repository are the ones a build verifies against, so an update here is the moment a human
 * decides this release is trustworthy — not something a build does on its own.
 *
 * Nothing is downloaded into `resources/` by this script. Run `pnpm stage:app` (or
 * `node scripts/fetch-officecli.mjs`) afterwards to pull the new binaries, then re-run the
 * manual checks in `docs/office-officecli.md` §7: rendering fidelity and the text `load_skill`
 * prints both change with the binary, and the skills the agent reads come out of it.
 */
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { assetsFromChecksumSums, parseOfficeCliManifest, serializeOfficeCliManifest } from "../src/shared/office.ts";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "..");
const MANIFEST_FILE = join(repoRoot, "scripts", "officecli.json");
const CONNECT_TIMEOUT_SECONDS = 10;
const MAX_TIME_SECONDS = 60;

function fail(message) {
  console.error(`sync-officecli: ${message}`);
  process.exit(1);
}

function parseArgs(argv) {
  const out = { version: "", latest: false };
  for (const arg of argv) {
    if (arg === "--latest") out.latest = true;
    else if (arg.startsWith("--version=")) out.version = arg.slice("--version=".length).trim();
    else if (arg === "--version") out.version = (argv[argv.indexOf(arg) + 1] ?? "").trim();
    else if (arg === "--help" || arg === "-h") {
      console.log("用法: pnpm sync:officecli -- --version v1.0.158 | --latest");
      process.exit(0);
    } else fail(`未知参数 ${arg}`);
  }
  if (!out.version && !out.latest) fail("需要一个版本：--version vX.Y.Z，或 --latest 取最新发布");
  return out;
}

function curl(url) {
  return execFileSync(
    "curl",
    ["--fail", "--silent", "--show-error", "--location", "--proto", "https", "--connect-timeout", String(CONNECT_TIMEOUT_SECONDS), "--max-time", String(MAX_TIME_SECONDS), url],
    { encoding: "utf8", maxBuffer: 4 * 1024 * 1024 },
  );
}

function releaseSources(repository, mirror) {
  return [
    (version) => ({ url: `https://github.com/${repository}/releases/download/${version}/SHA256SUMS`, label: "GitHub" }),
    (version) => ({ url: `${mirror}/releases/download/${version}/SHA256SUMS`, label: "官方镜像" }),
    (version) => ({ url: `https://gh-proxy.com/https://github.com/${repository}/releases/download/${version}/SHA256SUMS`, label: "GitHub 代理" }),
  ];
}

/** Follow the same mirror fallbacks as the download itself, so one dead host is not fatal. */
function fetchChecksums(repository, mirror, version) {
  const errors = [];
  for (const build of releaseSources(repository, mirror)) {
    const { url, label } = build(version);
    try {
      return { text: curl(url), label };
    } catch (error) {
      const detail = (error?.stderr ?? error?.message ?? "").toString().trim().split(/\r?\n/).pop() ?? "";
      errors.push(`${label}: ${detail}`);
    }
  }
  fail(`取不到 ${version} 的 SHA256SUMS\n  ${errors.join("\n  ")}`);
}

/** The newest release tag, read off the redirect the release page answers with. */
function latestVersion(repository, mirror) {
  for (const url of [`https://github.com/${repository}/releases/latest`, `${mirror}/releases/latest`]) {
    try {
      const final = execFileSync(
        "curl",
        ["--fail", "--silent", "--show-error", "--location", "--proto", "https", "--connect-timeout", String(CONNECT_TIMEOUT_SECONDS), "--max-time", String(MAX_TIME_SECONDS), "--output", "/dev/null", "--write-out", "%{url_effective}", url],
        { encoding: "utf8" },
      ).trim();
      const match = /\/releases\/tag\/(v\d+\.\d+\.\d+)$/.exec(final);
      if (match) return match[1];
    } catch {
      // Try the next source.
    }
  }
  fail("无法确定最新发布版本，请显式给出 --version vX.Y.Z");
}

function main() {
  const options = parseArgs(process.argv.slice(2));
  if (!existsSync(MANIFEST_FILE)) fail("缺少 scripts/officecli.json");
  const current = parseOfficeCliManifest(JSON.parse(readFileSync(MANIFEST_FILE, "utf8")));
  const version = options.version || latestVersion(current.repository, current.mirror);
  if (!/^v\d+\.\d+\.\d+$/.test(version)) fail(`版本号写法不对：${version}`);

  const { text, label } = fetchChecksums(current.repository, current.mirror, version);
  const assets = assetsFromChecksumSums(text);
  const previous = current.version;
  const next = parseOfficeCliManifest({
    ...current,
    version,
    assets,
  });
  writeFileSync(MANIFEST_FILE, serializeOfficeCliManifest(next));
  const changed = Object.entries(next.assets).filter(([key, entry]) => current.assets[key]?.sha256 !== entry.sha256).length;
  console.log(`scripts/officecli.json: ${previous} → ${version}（SHA256SUMS 来自 ${label}，${changed} 个平台的哈希有变化）`);
  console.log("下一步：node scripts/fetch-officecli.mjs --arch=all，看一眼 diff，再跑 docs/office-officecli.md §7 的手工检查。");
}

main();
