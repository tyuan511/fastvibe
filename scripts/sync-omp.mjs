#!/usr/bin/env node
/**
 * Download official oh-my-pi release binaries into resources/omp/
 * so FastVibe can ship a bundled `omp` instead of using the host install.
 *
 *   npm run sync:omp
 *   npm run sync:omp -- --force
 *   npm run sync:omp -- --tag v18.1.17
 *   npm run sync:omp -- --target darwin-arm64 --target darwin-x64
 */
import { createHash } from "node:crypto";
import { createWriteStream } from "node:fs";
import { access, chmod, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { fileURLToPath } from "node:url";

const REPO = "can1357/oh-my-pi";
const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const OUT_DIR = join(ROOT, "resources", "omp");
const MANIFEST_PATH = join(OUT_DIR, "manifest.json");

const args = parseArgs(process.argv.slice(2));

try {
  await main();
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  const local = await readManifest();
  if (local && !args.force) {
    console.warn(`sync-omp: ${message}`);
    console.warn(`sync-omp: keeping existing ${local.tag}`);
    process.exit(0);
  }
  console.error(`sync-omp: ${message}`);
  process.exit(1);
}

async function main() {
  const headers = githubHeaders();
  const release = await fetchRelease(headers, args.tag);
  const sums = await fetchChecksums(headers, release.tag_name);
  const targets = args.targets.length > 0 ? args.targets : [hostTarget()];

  await mkdir(OUT_DIR, { recursive: true });

  const downloaded = [];
  for (const target of targets) {
    const spec = targetSpec(target);
    const dest = join(OUT_DIR, spec.id, spec.file);
    const expected = sums.get(spec.asset);
    if (!expected) {
      throw new Error(`No SHA256 for ${spec.asset} in ${release.tag_name}`);
    }

    if (!args.force && (await alreadyPresent(dest, expected, release.tag_name))) {
      console.log(`sync-omp: ${spec.id} already at ${release.tag_name}`);
      downloaded.push({ ...spec, sha256: expected, skipped: true });
      continue;
    }

    const url = `https://github.com/${REPO}/releases/download/${release.tag_name}/${spec.asset}`;
    console.log(`sync-omp: downloading ${spec.asset} (${release.tag_name})`);
    const sha256 = await downloadFile(url, dest, headers);
    if (sha256 !== expected) {
      await rm(dest, { force: true });
      throw new Error(`Checksum mismatch for ${spec.asset}: got ${sha256}, expected ${expected}`);
    }
    if (process.platform !== "win32") {
      await chmod(dest, 0o755);
    }
    console.log(`sync-omp: wrote ${dest}`);
    downloaded.push({ ...spec, sha256, skipped: false });
  }

  const manifest = {
    repo: REPO,
    tag: release.tag_name,
    downloadedAt: new Date().toISOString(),
    targets: downloaded.map(({ id, asset, file, sha256 }) => ({ id, asset, file, sha256 })),
  };
  await writeFile(MANIFEST_PATH, `${JSON.stringify(manifest, null, 2)}\n`);
  console.log(`sync-omp: ready ${release.tag_name}`);
}

function parseArgs(argv) {
  const parsed = { force: false, tag: "", targets: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--") continue;
    if (arg === "--force") parsed.force = true;
    else if (arg === "--tag") parsed.tag = argv[++i] ?? "";
    else if (arg.startsWith("--tag=")) parsed.tag = arg.slice("--tag=".length);
    else if (arg === "--target") parsed.targets.push(argv[++i] ?? "");
    else if (arg.startsWith("--target=")) parsed.targets.push(arg.slice("--target=".length));
    else throw new Error(`Unknown argument: ${arg}`);
  }
  parsed.targets = parsed.targets.filter(Boolean);
  return parsed;
}

function hostTarget() {
  const arch = process.arch === "x64" || process.arch === "arm64" ? process.arch : null;
  if (!arch) throw new Error(`Unsupported arch: ${process.arch}`);
  if (process.platform === "darwin") return `darwin-${arch}`;
  if (process.platform === "linux") return `linux-${arch}`;
  if (process.platform === "win32") return `windows-${arch}`;
  throw new Error(`Unsupported platform: ${process.platform}`);
}

function targetSpec(id) {
  const match = /^(darwin|linux|windows)-(x64|arm64)$/.exec(id);
  if (!match) throw new Error(`Unknown target: ${id}`);
  const [, os, arch] = match;
  const windows = os === "windows";
  return {
    id,
    asset: windows ? `omp-${os}-${arch}.exe` : `omp-${os}-${arch}`,
    file: windows ? "omp.exe" : "omp",
  };
}

function githubHeaders() {
  const headers = {
    Accept: "application/vnd.github+json",
    "User-Agent": "fastvibe-sync-omp",
    "X-GitHub-Api-Version": "2022-11-28",
  };
  if (process.env.GITHUB_TOKEN) {
    headers.Authorization = `Bearer ${process.env.GITHUB_TOKEN}`;
  }
  return headers;
}

async function fetchRelease(headers, tag) {
  const url = tag
    ? `https://api.github.com/repos/${REPO}/releases/tags/${tag}`
    : `https://api.github.com/repos/${REPO}/releases/latest`;
  const response = await fetch(url, { headers });
  if (!response.ok) {
    throw new Error(`GitHub release ${response.status} ${response.statusText}`);
  }
  return response.json();
}

async function fetchChecksums(headers, tag) {
  const url = `https://github.com/${REPO}/releases/download/${tag}/SHA256SUMS.txt`;
  const response = await fetch(url, { headers, redirect: "follow" });
  if (!response.ok) {
    throw new Error(`SHA256SUMS.txt ${response.status} ${response.statusText}`);
  }
  const text = await response.text();
  const sums = new Map();
  for (const line of text.split("\n")) {
    const match = /^([a-f0-9]{64})\s+(\S+)$/.exec(line.trim());
    if (match) sums.set(match[2], match[1]);
  }
  return sums;
}

async function alreadyPresent(dest, expected, tag) {
  const manifest = await readManifest();
  if (!manifest || manifest.tag !== tag) return false;
  if (!manifest.targets?.some((target) => target.sha256 === expected)) return false;
  try {
    await access(dest);
    return true;
  } catch {
    return false;
  }
}

async function readManifest() {
  try {
    return JSON.parse(await readFile(MANIFEST_PATH, "utf8"));
  } catch {
    return null;
  }
}

async function downloadFile(url, dest, headers) {
  await mkdir(dirname(dest), { recursive: true });
  const tmp = `${dest}.tmp`;
  const response = await fetch(url, { headers, redirect: "follow" });
  if (!response.ok || !response.body) {
    throw new Error(`Download ${url} failed: ${response.status} ${response.statusText}`);
  }

  const hash = createHash("sha256");
  const total = Number(response.headers.get("content-length") ?? 0);
  let received = 0;
  let lastPct = -1;

  await pipeline(
    Readable.fromWeb(response.body),
    async function* progress(source) {
      for await (const chunk of source) {
        hash.update(chunk);
        received += chunk.length;
        if (total > 0) {
          const pct = Math.floor((received / total) * 100);
          if (pct !== lastPct && pct % 5 === 0) {
            lastPct = pct;
            console.log(`sync-omp: ${pct}% (${formatBytes(received)} / ${formatBytes(total)})`);
          }
        }
        yield chunk;
      }
    },
    createWriteStream(tmp),
  );

  await rename(tmp, dest);
  return hash.digest("hex");
}

function formatBytes(value) {
  return `${(value / 1024 / 1024).toFixed(1)} MB`;
}
