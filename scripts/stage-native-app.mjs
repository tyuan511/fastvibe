#!/usr/bin/env node

import { createHash } from "node:crypto";
import {
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { basename, join, resolve } from "node:path";
import { spawnSync } from "node:child_process";

const root = resolve(new URL("..", import.meta.url).pathname);
const nativeManifest = join(root, "native", "Cargo.toml");

function option(name, fallback) {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? process.argv[index + 1] : fallback;
}

if (process.argv.includes("--help")) {
  console.log("Usage: node scripts/stage-native-app.mjs [--platform mac|win|linux] [--arch arm64|x64] [--profile debug|release] [--target TARGET] [--output DIR] [--bundle] [--no-build]");
  process.exit(0);
}

const platform = option("platform", process.platform === "darwin" ? "mac" : process.platform === "win32" ? "win" : "linux");
const arch = option("arch", process.arch === "arm64" ? "arm64" : "x64");
const profile = option("profile", "release");
const target = option("target", "");
const output = resolve(option("output", join(root, "release", "native", `${platform}-${arch}`)));
const bundle = process.argv.includes("--bundle");
const binaryDirectory = target
  ? join(root, "native", "target", target, profile)
  : join(root, "native", "target", profile);
const executableSuffix = platform === "win" ? ".exe" : "";
const binaries = ["fastvibe", "fastvibe-server"].map((name) => `${name}${executableSuffix}`);

function copyTree(source, destination) {
  const stat = lstatSync(source);
  if (stat.isSymbolicLink()) {
    throw new Error(`refusing to stage a symlink: ${source}`);
  }
  if (stat.isDirectory()) {
    mkdirSync(destination, { recursive: true });
    for (const entry of readdirSync(source)) {
      copyTree(join(source, entry), join(destination, entry));
    }
    return;
  }
  copyFileSync(source, destination);
}

function fileEntry(path, relative) {
  const bytes = readFileSync(path);
  return {
    path: relative,
    bytes: bytes.length,
    sha256: createHash("sha256").update(bytes).digest("hex"),
  };
}

function collectFiles(source, relativeRoot) {
  const entries = [];
  const stat = lstatSync(source);
  if (stat.isDirectory()) {
    for (const name of readdirSync(source)) {
      entries.push(...collectFiles(join(source, name), join(relativeRoot, name)));
    }
  } else if (stat.isFile()) {
    entries.push(fileEntry(source, relativeRoot));
  }
  return entries;
}

if (!process.argv.includes("--no-build")) {
  const args = ["build", "--manifest-path", nativeManifest, "-p", "fv-server", "-p", "fv-gui"];
  if (profile === "release") args.push("--release");
  if (target) args.push("--target", target);
  const result = spawnSync("cargo", args, { cwd: root, stdio: "inherit" });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
}

mkdirSync(output, { recursive: true });
const binaryOutput = bundle ? join(output, "bin") : output;
const resourceOutput = bundle ? join(output, "Resources") : null;
mkdirSync(binaryOutput, { recursive: true });
const entries = [];
for (const name of binaries) {
  const source = join(binaryDirectory, name);
  const destination = join(binaryOutput, basename(name));
  try {
    copyFileSync(source, destination);
  } catch (error) {
    throw new Error(`native binary is missing: ${source}; build the requested target first (${error.message})`);
  }
  entries.push({ name, ...fileEntry(destination, bundle ? `bin/${name}` : name) });
}

const resources = [];
if (bundle) {
  const skills = join(root, "resources", "skills");
  if (!existsSync(skills)) throw new Error(`bundled skills are missing: ${skills}`);
  copyTree(skills, join(resourceOutput, "skills"));
  resources.push(...collectFiles(skills, "Resources/skills"));

  const officeRoot = join(root, "resources", "officecli");
  const officeKey = `${platform}-${arch}`;
  const officeSource = join(officeRoot, officeKey);
  if (!existsSync(officeSource)) {
    throw new Error(`OfficeCLI resource is missing for ${officeKey}: run node scripts/fetch-officecli.mjs --platforms=${officeKey}`);
  }
  const officeDestination = join(resourceOutput, "officecli");
  mkdirSync(officeDestination, { recursive: true });
  for (const name of ["LICENSE", "NOTICE", "manifest.json"]) {
    const source = join(officeRoot, name);
    if (!existsSync(source)) throw new Error(`OfficeCLI package is missing ${source}`);
    copyFileSync(source, join(officeDestination, name));
    resources.push(fileEntry(source, `Resources/officecli/${name}`));
  }
  copyTree(officeSource, join(officeDestination, officeKey));
  resources.push(...collectFiles(officeSource, `Resources/officecli/${officeKey}`));
}

const manifest = {
  schema: 1,
  layout: bundle ? "bundle" : "flat",
  platform,
  arch,
  profile,
  target: target || null,
  binaries: entries,
  resources,
};
writeFileSync(join(output, "native-manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
console.log(`staged ${entries.length} native binaries in ${output}`);
