#!/usr/bin/env node

import { createHash } from "node:crypto";
import { existsSync, readFileSync, statSync } from "node:fs";
import { join, resolve } from "node:path";

function option(name, fallback = "") {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? process.argv[index + 1] : fallback;
}

if (process.argv.includes("--help")) {
  console.log("Usage: node scripts/check-native-bundle.mjs --bundle DIR [--allow-resigned]");
  process.exit(0);
}

const bundleOption = option("bundle");
if (!bundleOption) throw new Error("--bundle DIR is required");
const bundle = resolve(bundleOption);
const manifestPath = join(bundle, "native-manifest.json");
if (!existsSync(manifestPath)) throw new Error(`native-manifest.json is missing from ${bundle}`);

const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
if (manifest.schema !== 1 || manifest.layout !== "bundle") {
  throw new Error("unsupported native bundle manifest");
}
if (!Array.isArray(manifest.binaries) || manifest.binaries.length !== 2) {
  throw new Error("native bundle must contain fastvibe and fastvibe-server");
}
if (!Array.isArray(manifest.resources)) throw new Error("native bundle resources are missing");

const allowResigned = process.argv.includes("--allow-resigned");
const sha256 = (path) => createHash("sha256").update(readFileSync(path)).digest("hex");
const insideBundle = (relative) => {
  if (!relative || relative.startsWith("/") || relative.includes("\\")) {
    throw new Error(`manifest path is not relative: ${relative}`);
  }
  const path = resolve(bundle, relative);
  const prefix = bundle.endsWith("/") ? bundle : `${bundle}/`;
  if (!path.startsWith(prefix)) throw new Error(`manifest path escapes bundle: ${relative}`);
  return path;
};
const mismatches = [];

for (const entry of manifest.binaries) {
  if (!entry || typeof entry.path !== "string" || typeof entry.name !== "string") {
    throw new Error("invalid binary manifest entry");
  }
  const path = insideBundle(entry.path);
  if (!existsSync(path)) throw new Error(`binary is missing: ${entry.path}`);
  const stat = statSync(path);
  if (!stat.isFile() || stat.size === 0) throw new Error(`binary is empty: ${entry.path}`);
  if (process.platform !== "win32" && (stat.mode & 0o111) === 0) {
    throw new Error(`binary is not executable: ${entry.path}`);
  }
  if (stat.size !== entry.bytes || sha256(path) !== entry.sha256) mismatches.push(entry.path);
}

for (const entry of manifest.resources) {
  if (!entry || typeof entry.path !== "string") throw new Error("invalid resource manifest entry");
  const path = insideBundle(entry.path);
  if (!existsSync(path)) throw new Error(`resource is missing: ${entry.path}`);
  const stat = statSync(path);
  if (!stat.isFile() || stat.size !== entry.bytes || sha256(path) !== entry.sha256) {
    throw new Error(`resource hash mismatch: ${entry.path}`);
  }
}

if (mismatches.length && !allowResigned) {
  throw new Error(`binary hash mismatch (use --allow-resigned after signing): ${mismatches.join(", ")}`);
}
console.log(
  `verified native bundle: ${manifest.platform}-${manifest.arch}; ` +
    `${manifest.resources.length} resources; ` +
    (mismatches.length ? `${mismatches.length} signed binary hashes accepted` : "binary hashes match"),
);
