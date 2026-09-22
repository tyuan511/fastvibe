#!/usr/bin/env node
/**
 * Merge the per-architecture `latest-mac.yml` files back into the one manifest
 * electron-updater actually asks for.
 *
 * The mac release is built as two independent jobs so they run at the same time, and
 * each one writes a manifest describing only its own architecture. Only one can be
 * published under the name the updater fetches, and shipping either alone is worse than
 * it sounds:
 *
 *   - only x64 survives → an arm64 Mac finds no arm64 entry, and MacUpdater explicitly
 *     "allow[s] arm64 macs to install universal or rosetta2(x64)", so those users are
 *     silently moved onto x64 builds and stay there. No error, ever.
 *   - only arm64 survives → an x64 Mac has every candidate excluded and updates fail.
 *
 * The filename cannot carry the architecture either: `getChannelFilename` is
 * `${channel}.yml` with no arch in it, and MacUpdater picks between entries by testing
 * whether a file's url contains "arm64". One manifest, both architectures listed.
 *
 *   node scripts/merge-mac-manifest.mjs <output.yml> <input.yml> <input.yml> …
 */
import { readManifest, writeManifest } from "./lib/mac-manifest.mjs";

function main(argv) {
  const [output, ...inputs] = argv;
  if (!output || inputs.length === 0) {
    throw new Error("usage: merge-mac-manifest.mjs <output.yml> <input.yml>…");
  }

  const manifests = inputs.map((path) => ({ path, data: readManifest(path) }));

  // A version mismatch means the two jobs packaged different commits. Publishing that
  // would hand half the users a manifest pointing at files the release does not have.
  const versions = new Set(manifests.map(({ data }) => top(data, "version")));
  if (versions.size !== 1) {
    throw new Error(`inputs disagree about version: ${[...versions].join(", ")}`);
  }

  const files = [];
  const seen = new Set();
  for (const { path, data } of manifests) {
    for (const file of data.files) {
      if (seen.has(file.url)) continue;
      seen.add(file.url);
      files.push(file);
    }
    console.log(`${path}: ${data.files.length} files`);
  }

  // electron-builder's own ordering when it builds both architectures at once: the
  // zips first (that is what the updater downloads), x64 before arm64.
  const rank = (file) => (file.url.endsWith(".zip") ? 0 : 2) + (file.url.includes("arm64") ? 1 : 0);
  files.sort((a, b) => rank(a) - rank(b));

  // The top-level `path`/`sha512` is the fallback for a client that matches nothing in
  // `files`. electron-builder points it at the x64 zip, which is the one entry every
  // Mac can run, so the fallback stays the safe one.
  const fallback = files.find((file) => file.url.endsWith(".zip") && !file.url.includes("arm64")) ?? files[0];

  const merged = {
    files,
    extra: manifests[0].data.extra.map(([key, value]) => {
      if (key === "path") return [key, fallback.url];
      if (key === "sha512") return [key, fallback.sha512];
      // Whichever job finished last describes the release's actual age.
      if (key === "releaseDate") return [key, latest(manifests, "releaseDate")];
      return [key, value];
    }),
  };

  writeManifest(output, merged);
  console.log(`\n${output}: ${files.length} files, fallback ${fallback.url}`);
}

function top(manifest, key) {
  return manifest.extra.find(([name]) => name === key)?.[1];
}

function latest(manifests, key) {
  return manifests
    .map(({ data }) => top(data, key))
    .filter(Boolean)
    .sort()
    .at(-1);
}

try {
  main(process.argv.slice(2));
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}
