#!/usr/bin/env node
/**
 * Sign, notarize and staple the packaged .dmg files.
 *
 * electron-builder notarizes the *app* and staples the ticket to it, which is what the
 * zip target — and therefore the updater — carries. The .dmg it then builds around that
 * app is left alone: `dmg.sign` exists but electron-builder's own documentation warns it
 * "will lead to unwanted errors in combination with notarization requirements", and
 * nothing notarizes the image itself.
 *
 * That leaves the artifact users actually double-click failing the assessment Gatekeeper
 * runs on a downloaded disk image:
 *
 *   spctl --assess --type open --context context:primary-signature FastVibe-0.8.2-arm64.dmg
 *   → rejected (source=no usable signature)
 *
 * Signing the image, notarizing it and stapling the ticket turns that into
 * `accepted (source=Notarized Developer ID)`. The app inside is already notarized, so
 * this is a second round trip rather than a first one — a few minutes per architecture,
 * paid once per release.
 *
 * No credentials in the environment means nothing to do: a local `pnpm dist:mac` still
 * produces a signed-but-unnotarized dmg and says so, exactly as it did before.
 *
 *   node scripts/notarize-dmg.mjs
 */
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileEntry, readManifest, writeManifest } from "./lib/mac-manifest.mjs";

const RELEASE_DIR = "release";

/**
 * The signing identity, read from the one place that already names it.
 *
 * Matched with a regex rather than a YAML parser on purpose: js-yaml is only a
 * transitive dependency here, and a build script that breaks when electron-builder
 * changes its own dependency tree is worse than a regex over a line this repo owns.
 */
function identity() {
  if (process.env.APPLE_SIGN_IDENTITY) return process.env.APPLE_SIGN_IDENTITY;
  const config = readFileSync("electron-builder.yml", "utf8");
  const match = config.match(/^\s{2}identity:\s*(.+?)\s*$/m);
  const name = match?.[1];
  if (!name || name === "null") {
    throw new Error("electron-builder.yml has no mac.identity to sign the dmg with");
  }
  // `codesign` wants the full certificate name; the config omits the prefix because
  // app-builder-lib's checkPrefix() rejects it there.
  return name.startsWith("Developer ID Application:") ? name : `Developer ID Application: ${name}`;
}

function run(command, args) {
  const result = spawnSync(command, args, { encoding: "utf8" });
  if (result.error) throw result.error;
  const output = `${result.stdout ?? ""}${result.stderr ?? ""}`.trim();
  if (result.status !== 0) {
    throw new Error(`${command} ${args[0]} failed (${result.status})\n${output}`);
  }
  return output;
}

function main() {
  const key = process.env.APPLE_API_KEY;
  const keyId = process.env.APPLE_API_KEY_ID;
  const issuer = process.env.APPLE_API_ISSUER;
  if (!key || !keyId || !issuer) {
    console.log("skipped dmg notarization — APPLE_API_KEY / APPLE_API_KEY_ID / APPLE_API_ISSUER not set");
    return;
  }

  let images;
  try {
    images = readdirSync(RELEASE_DIR).filter((name) => name.endsWith(".dmg"));
  } catch {
    console.log(`skipped dmg notarization — no ${RELEASE_DIR}/ directory`);
    return;
  }
  if (images.length === 0) {
    console.log("skipped dmg notarization — no .dmg files were built");
    return;
  }

  const signer = identity();
  const credentials = ["--key", key, "--key-id", keyId, "--issuer", issuer];

  for (const name of images) {
    const path = join(RELEASE_DIR, name);
    console.log(`\n=== ${name} ===`);
    // `--timestamp` is not optional: the notary service refuses a signature that carries
    // no trusted timestamp.
    run("codesign", ["--sign", signer, "--timestamp", "--force", path]);
    console.log("signed");
    console.log(run("xcrun", ["notarytool", "submit", path, ...credentials, "--wait"]));
    run("xcrun", ["stapler", "staple", path]);
    console.log("stapled");
    // The assessment is the whole point, so it is asserted rather than assumed: a
    // stapled image that still failed it would ship the same warning the unstapled one
    // did, and nothing downstream would notice. `spctl` writes its verdict across both
    // streams, which is why `run` joins them.
    console.log(run("spctl", ["--assess", "--type", "open", "--context", "context:primary-signature", "-vv", path]));
    refreshManifest(name, path);
  }
}

/**
 * Re-record the image's digest in the update manifest.
 *
 * electron-builder hashes each artifact as it produces it — before this script signs
 * and staples the image, which rewrites its bytes. Left alone, `latest-mac.yml` would
 * carry a digest for a file that no longer matches it. macOS updates download the zip,
 * so nothing breaks today; it is simply wrong, and wrong in the way that surfaces as an
 * unexplainable checksum mismatch to whoever verifies a download by hand.
 *
 * The matching `.dmg.blockmap` goes stale for the same reason and is *not* regenerated.
 * macOS updates very much do use differential downloads — but only over the zip:
 * `MacUpdater.doDownloadUpdate` resolves a `zipFileInfo`, caches the previous one as
 * `update.zip`, and diffs against that. The dmg is the first-install download and
 * never enters the update path, so its blockmap has no consumer. The zip and its
 * blockmap are not touched by this script at all.
 */
function refreshManifest(name, path) {
  const manifestPath = join(RELEASE_DIR, "latest-mac.yml");
  if (!existsSync(manifestPath)) return;
  const manifest = readManifest(manifestPath);
  const entry = fileEntry(manifest, name);
  if (!entry) return;
  entry.sha512 = createHash("sha512").update(readFileSync(path)).digest("base64");
  entry.size = statSync(path).size;
  writeManifest(manifestPath, manifest);
  console.log(`latest-mac.yml: refreshed ${name}`);
}

try {
  main();
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}

export {};
