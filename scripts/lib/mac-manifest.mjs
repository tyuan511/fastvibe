/**
 * Read and write `latest-mac.yml`, electron-updater's macOS update manifest.
 *
 * Deliberately dependency-free. Two scripts need this — one runs on the mac runner
 * where the project's node_modules exist, the other in a tiny merge job that would
 * otherwise have to `pnpm install` just to parse forty lines of YAML, on the critical
 * path, at the end of the release. A parser for one known shape is cheaper than that.
 *
 * "One known shape" is the safety condition, so it is enforced rather than assumed:
 * the reader understands exactly the document electron-builder emits — top-level
 * scalars plus a `files` list of flat maps — and throws on anything else instead of
 * quietly dropping it. A manifest this code cannot round-trip is a manifest it must
 * not rewrite.
 */
import { readFileSync, writeFileSync } from "node:fs";

/** Keys that carry a value electron-updater compares or downloads. */
const FILE_KEYS = new Set(["url", "sha512", "size", "blockMapSize"]);

export function readManifest(path) {
  const text = readFileSync(path, "utf8");
  const manifest = { files: [], extra: [] };
  let current = null;
  let inFiles = false;

  for (const raw of text.split("\n")) {
    if (!raw.trim()) continue;
    const line = raw.replace(/\s+$/, "");

    if (line === "files:") {
      inFiles = true;
      continue;
    }

    // `  - url: …` opens a new entry; `    sha512: …` continues the current one.
    const entry = line.match(/^ {2}- ([A-Za-z]\w*): (.*)$/);
    if (entry) {
      if (!inFiles) throw new Error(`${path}: list item outside "files": ${line}`);
      current = {};
      manifest.files.push(current);
      current[entry[1]] = scalar(entry[2]);
      continue;
    }

    const nested = line.match(/^ {4}([A-Za-z]\w*): (.*)$/);
    if (nested) {
      if (!current) throw new Error(`${path}: indented key with no list item: ${line}`);
      if (!FILE_KEYS.has(nested[1])) throw new Error(`${path}: unexpected key in files: ${nested[1]}`);
      current[nested[1]] = scalar(nested[2]);
      continue;
    }

    const top = line.match(/^([A-Za-z]\w*): (.*)$/);
    if (top) {
      inFiles = false;
      current = null;
      // Top-level order matters only for readability, so it is preserved as written.
      manifest.extra.push([top[1], top[2]]);
      continue;
    }

    throw new Error(`${path}: cannot parse line: ${line}`);
  }

  if (manifest.files.length === 0) throw new Error(`${path}: no files listed`);
  return manifest;
}

/** Numbers stay numbers; everything else is handed back exactly as written. */
function scalar(value) {
  return /^\d+$/.test(value) ? Number(value) : value;
}

export function writeManifest(path, manifest) {
  const lines = [];
  // electron-builder emits `version` first and `files` immediately after it; the rest
  // follow in their original order. Rebuilding it that way keeps a hand-written
  // manifest byte-identical to one the tool produced, which is what makes the
  // round-trip test in this repo meaningful.
  for (const [key, value] of manifest.extra) {
    lines.push(`${key}: ${value}`);
    if (key !== "version") continue;
    lines.push("files:");
    for (const file of manifest.files) {
      const keys = Object.keys(file);
      lines.push(`  - ${keys[0]}: ${file[keys[0]]}`);
      for (const nested of keys.slice(1)) lines.push(`    ${nested}: ${file[nested]}`);
    }
  }
  writeFileSync(path, `${lines.join("\n")}\n`);
}

/** The entry for one artifact, by file name. */
export function fileEntry(manifest, name) {
  return manifest.files.find((file) => file.url === name);
}
