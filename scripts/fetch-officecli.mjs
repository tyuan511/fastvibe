#!/usr/bin/env node
/**
 * Fetch the OfficeCLI binaries this repository pins in `scripts/officecli.json`.
 *
 * Office is a built-in feature, so the tool that renders and edits Office documents ships in
 * the installer rather than being downloaded by a user who happens to open a `.docx`. That
 * makes an upstream release asset part of *our* build input, so it is verified against the
 * SHA256 committed in the manifest — never against the `SHA256SUMS` that arrives beside the
 * download, which a compromised or stale mirror controls.
 *
 *   node scripts/fetch-officecli.mjs                       # this machine's OS and CPU
 *   node scripts/fetch-officecli.mjs --arch=all            # every CPU electron-builder packages for this OS
 *   node scripts/fetch-officecli.mjs --platforms=mac-arm64,mac-x64
 *   node scripts/fetch-officecli.mjs --check               # verify what is on disk, download nothing
 *   node scripts/fetch-officecli.mjs --force               # refetch even when the hash already matches
 *
 * Files land in `resources/officecli/<os>-<arch>/officecli[.exe]`, beside the
 * `manifest.json` copy the running app reads for its version and cache key. Existing files
 * whose hash already matches are left alone, so a build does not re-download 32 MB per
 * architecture every time.
 *
 * Mirrors are tried in order and the checksum decides: GitHub first (the canonical source),
 * then OfficeCLI's own CDN, then the GitHub proxy this app already uses for the Agent runtime
 * and the cua driver. A mirror cannot substitute a different binary.
 */
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { chmodSync, copyFileSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  OFFICECLI_PLATFORMS,
  officeCliPlatform,
  officeCliPlatformKey,
  parseOfficeCliManifest,
} from "../src/shared/office.ts";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "..");
const MANIFEST_FILE = join(repoRoot, "scripts", "officecli.json");
const OUT_DIR = join(repoRoot, "resources", "officecli");
/** Committed beside the manifest; carried into the package so the license survives distribution. */
const LICENSE_FILES = ["LICENSE", "NOTICE"];
const CONNECT_TIMEOUT_SECONDS = 10;
const MAX_TIME_SECONDS = 600;

function fail(message) {
  console.error(`fetch-officecli: ${message}`);
  process.exit(1);
}

function parseArgs(argv) {
  const out = { os: null, arch: null, platforms: null, check: false, force: false };
  for (const arg of argv) {
    const [name, value] = arg.includes("=") ? [arg.slice(0, arg.indexOf("=")), arg.slice(arg.indexOf("=") + 1)] : [arg, ""];
    switch (name) {
      case "--os":
        if (!["mac", "win", "linux", "all"].includes(value)) fail(`--os 只接受 mac | win | linux | all，收到 "${value}"`);
        out.os = value;
        break;
      case "--arch":
        if (!["x64", "arm64", "all"].includes(value)) fail(`--arch 只接受 x64 | arm64 | all，收到 "${value}"`);
        out.arch = value;
        break;
      case "--platforms":
        out.platforms = value.split(",").map((item) => item.trim()).filter(Boolean);
        break;
      case "--check":
        out.check = true;
        break;
      case "--force":
        out.force = true;
        break;
      case "--help":
      case "-h":
        console.log("用法: node scripts/fetch-officecli.mjs [--os=mac|win|linux|all] [--arch=x64|arm64|all] [--platforms=k1,k2] [--check] [--force]");
        process.exit(0);
        break;
      default:
        fail(`未知参数 ${arg}`);
    }
  }
  if (out.platforms && out.platforms.length === 0) fail("--platforms 需要一个或多个平台键");
  return out;
}

/** `process.arch` in the spelling the platform keys use. */
function hostArch() {
  const key = officeCliPlatformKey(process.platform, process.arch);
  return key ? key.slice(key.lastIndexOf("-") + 1) : null;
}

function selectedKeys(options) {
  if (options.platforms) {
    const unknown = options.platforms.filter((key) => !officeCliPlatform(key));
    if (unknown.length > 0) fail(`清单里没有这些平台：${unknown.join(", ")}`);
    return options.platforms;
  }
  // `--os` is a filter, not a guess: without it this is the machine building right now.
  const os = options.os ?? officeCliPlatformKey(process.platform, process.arch)?.split("-")[0] ?? null;
  if (!os) fail(`这一台机器（${process.platform}）没有对应的 OfficeCLI 资产，请显式给出 --platforms`);
  const arch = options.arch ?? "current";
  if (arch === "current" && !hostArch()) fail(`无法识别这台机器的架构（${process.arch}），请显式给出 --arch`);
  const wanted = arch === "all" ? null : arch === "current" ? hostArch() : arch;
  // Auto-selection only ever picks what an installer carries; the musl builds the headless
  // Agent uses are named explicitly with --platforms, because a desktop build must not pull
  // two extra 32 MB binaries it will never package.
  const keys = OFFICECLI_PLATFORMS
    .filter((item) => item.usedBy.includes("desktop"))
    .filter((item) => os === "all" || item.key.startsWith(`${os}-`))
    .filter((item) => !wanted || item.key.endsWith(`-${wanted}`))
    .map((item) => item.key);
  if (keys.length === 0) fail(`没有平台同时匹配 --os=${os} --arch=${arch}`);
  return keys;
}

function download(urls, target) {
  mkdirSync(dirname(target), { recursive: true });
  for (const url of urls) {
    const temporary = `${target}.${process.pid}.download`;
    try {
      execFileSync(
        "curl",
        ["--fail", "--silent", "--show-error", "--location", "--proto", "https", "--connect-timeout", String(CONNECT_TIMEOUT_SECONDS), "--max-time", String(MAX_TIME_SECONDS), "--output", temporary, url],
        { stdio: ["ignore", "ignore", "pipe"] },
      );
    } catch (error) {
      rmSync(temporary, { force: true });
      const detail = (error?.stderr ?? error?.message ?? "").toString().trim().split(/\r?\n/).pop() ?? "";
      console.error(`  下载失败（${url}）${detail ? `: ${detail}` : ""}`);
      continue;
    }
    return temporary;
  }
  return null;
}

function sha256(path) {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function same(left, right) {
  return left.trim().toLowerCase() === right.trim().toLowerCase();
}

function main() {
  const options = parseArgs(process.argv.slice(2));
  if (!existsSync(MANIFEST_FILE)) fail(`缺少 ${join("scripts", "officecli.json")}`);
  let manifest;
  try {
    manifest = parseOfficeCliManifest(JSON.parse(readFileSync(MANIFEST_FILE, "utf8")));
  } catch (error) {
    fail(`清单无法解析：${error instanceof Error ? error.message : String(error)}`);
  }

  const keys = selectedKeys(options);
  // The app reads its version and its cache key from this copy, so the packaged install and
  // the build input cannot disagree about which release they are holding.
  if (!options.check) {
    mkdirSync(OUT_DIR, { recursive: true });
    writeFileSync(join(OUT_DIR, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
    for (const name of LICENSE_FILES) {
      const source = join(repoRoot, "resources", "officecli", name);
      if (!existsSync(source)) fail(`resources/officecli/${name} 丢了 —— 分发 OfficeCLI 必须附带 Apache-2.0 的许可与 NOTICE`);
    }
  }

  const failures = [];
  for (const key of keys) {
    const platform = officeCliPlatform(key);
    const expected = manifest.assets[key];
    if (!platform || !expected) {
      failures.push(`${key}: 清单里没有这个平台的哈希`);
      continue;
    }
    const target = join(OUT_DIR, platform.key, platform.binary);
    const present = existsSync(target);
    if (present && same(sha256(target), expected.sha256)) {
      if (options.check || !options.force) {
        if (!options.check) shipBeside(platform.key);
        console.log(`${key}: 已就位，哈希一致（${mb(target)}）`);
        continue;
      }
    }
    if (options.check) {
      failures.push(present
        ? `${key}: 磁盘上的文件哈希与清单不一致\n  期望 ${expected.sha256}\n  实际 ${sha256(target)}`
        : `${key}: 缺少 ${join("resources/officecli", platform.key, platform.binary)}`);
      continue;
    }
    const file = `https://github.com/${manifest.repository}/releases/download/${manifest.version}/${expected.asset}`;
    const urls = [
      file,
      `${manifest.mirror}/releases/download/${manifest.version}/${expected.asset}`,
      `https://gh-proxy.com/${file}`,
    ];
    console.log(`${key}: 下载 ${expected.asset}（OfficeCLI ${manifest.version}）…`);
    const temporary = download(urls, join(OUT_DIR, platform.key, `${platform.binary}.tmp`));
    if (!temporary) {
      failures.push(`${key}: 三个下载源都没能取到 ${expected.asset}`);
      continue;
    }
    let actual = "";
    try {
      actual = sha256(temporary);
    } catch (error) {
      failures.push(`${key}: 读不到下载下来的文件：${error instanceof Error ? error.message : String(error)}`);
      rmSync(temporary, { force: true });
      continue;
    }
    if (!same(actual, expected.sha256)) {
      rmSync(temporary, { force: true });
      failures.push(`${key}: 哈希与清单不一致，已删除下载文件\n  期望 ${expected.sha256}\n  实际 ${actual}`);
      continue;
    }
    mkdirSync(dirname(target), { recursive: true });
    chmodSync(temporary, 0o755);
    // Rename, not overwrite: a running watch or resident process would otherwise lose the text
    // segment under it, which on macOS leaves it stuck on the next code page fault.
    renameSync(temporary, target);
    if (process.platform !== "win32") chmodSync(target, 0o755);
    shipBeside(platform.key);
    console.log(`${key}: 完成（${mb(target)}），哈希校验通过`);
  }

  if (failures.length > 0) {
    for (const line of failures) console.error(`fetch-officecli: ${line}`);
    process.exit(1);
  }
}

/**
 * Put the license and the manifest next to the binary.
 *
 * Packaging copies one architecture's directory and nothing else, so the attribution Apache-2.0
 * requires, and the version the app reads, have to travel inside that directory.
 */
function shipBeside(key) {
  const dir = join(OUT_DIR, key);
  mkdirSync(dir, { recursive: true });
  for (const name of [...LICENSE_FILES, "manifest.json"]) {
    const source = join(OUT_DIR, name);
    if (!existsSync(source)) fail(`resources/officecli/${name} 丢了 —— 分发 OfficeCLI 必须附带许可、NOTICE 和版本清单`);
    copyFileSync(source, join(dir, name));
  }
}

function mb(path) {
  return `${(statSync(path).size / 1048576).toFixed(1)} MB`;
}

main();
