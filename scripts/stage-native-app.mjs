#!/usr/bin/env node

import { createHash } from "node:crypto";
import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { spawnSync } from "node:child_process";

const root = resolve(new URL("..", import.meta.url).pathname);
const nativeManifest = join(root, "native", "Cargo.toml");

function option(name, fallback) {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? process.argv[index + 1] : fallback;
}

if (process.argv.includes("--help")) {
  console.log("Usage: node scripts/stage-native-app.mjs [--platform mac|win|linux] [--arch arm64|x64] [--profile debug|release] [--target TARGET] [--no-build]");
  process.exit(0);
}

const platform = option("platform", process.platform === "darwin" ? "mac" : process.platform === "win32" ? "win" : "linux");
const arch = option("arch", process.arch === "arm64" ? "arm64" : "x64");
const profile = option("profile", "release");
const target = option("target", "");
const output = resolve(option("output", join(root, "release", "native", `${platform}-${arch}`)));
const binaryDirectory = target
  ? join(root, "native", "target", target, profile)
  : join(root, "native", "target", profile);
const executableSuffix = platform === "win" ? ".exe" : "";
const binaries = ["fastvibe", "fastvibe-server"].map((name) => `${name}${executableSuffix}`);

if (!process.argv.includes("--no-build")) {
  const args = ["build", "--manifest-path", nativeManifest, "-p", "fv-server", "-p", "fv-gui"];
  if (profile === "release") args.push("--release");
  if (target) args.push("--target", target);
  const result = spawnSync("cargo", args, { cwd: root, stdio: "inherit" });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
}

mkdirSync(output, { recursive: true });
const entries = [];
for (const name of binaries) {
  const source = join(binaryDirectory, name);
  const destination = join(output, basename(name));
  try {
    copyFileSync(source, destination);
  } catch (error) {
    throw new Error(`native binary is missing: ${source}; build the requested target first (${error.message})`);
  }
  const bytes = readFileSync(destination);
  entries.push({ name, bytes: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex") });
}

const manifest = {
  schema: 1,
  platform,
  arch,
  profile,
  target: target || null,
  binaries: entries,
};
writeFileSync(join(output, "native-manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
console.log(`staged ${entries.length} native binaries in ${output}`);
