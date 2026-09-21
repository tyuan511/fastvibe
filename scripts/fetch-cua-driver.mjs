#!/usr/bin/env node
/**
 * Fetch the `cua-driver` executable that 电脑操控 runs as its private worker.
 *
 * The npm package ships the SDK bindings and their native library, but not this
 * binary — and the binary is what makes the agent cursor possible. In-process SDK
 * mode refuses every cursor call with `facility_unavailable`, because
 * `DriverHostOptions.cursor` is, in cua's own words, "Rust-only host configuration
 * used by the standalone daemon. Language bindings intentionally receive the smaller
 * DriverOptions record." The private worker uses `CursorConfig::default()`, whose
 * `enabled` is true — so the user can see what the agent is doing only when the
 * driver runs as its own process.
 *
 * Pinned to the release that matches the npm package exactly. cua's own README:
 * "Upgrade the bindings and native library together." Both are 0.28.2 here, and the
 * daemon confirms it at startup (`driverVersion: 0.28.2, contract: 0.8.0`).
 *
 * The universal build is deliberate. A thinned slice is half the size, but a local
 * `pnpm dist:mac` packages both architectures from one invocation and would copy
 * whichever slice happened to be fetched into both. One file that is correct for
 * both is worth the extra megabytes.
 *
 *   node scripts/fetch-cua-driver.mjs
 */
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const VERSION = "0.28.2";
const TAG = `cua-driver-rs-v${VERSION}`;
const ASSET = `cua-driver-rs-${VERSION}-darwin-universal-binary.tar.gz`;
/** From the release's own checksums.txt, verified once and pinned here. */
const SHA256 = "386db225a3080714a0f9f935525e61efaf46709587ef8b94dd2df81aeb2f6daa";
const URL = `https://github.com/trycua/cua/releases/download/${TAG}/${ASSET}`;

const OUT_DIR = "resources/cua-driver";
const OUT = join(OUT_DIR, "cua-driver");
/** Records which release the binary on disk came from, so a version bump refetches. */
const STAMP = join(OUT_DIR, ".version");

function main() {
  if (process.platform !== "darwin") {
    console.log(`skipped cua-driver fetch — only macOS ships the private worker (this is ${process.platform})`);
    return;
  }
  if (existsSync(OUT) && existsSync(STAMP) && readFileSync(STAMP, "utf8").trim() === VERSION) {
    console.log(`cua-driver ${VERSION} already present (${mb(OUT)} MB)`);
    return;
  }

  mkdirSync(OUT_DIR, { recursive: true });
  const archive = join(OUT_DIR, ASSET);
  console.log(`downloading ${ASSET}…`);
  execFileSync("curl", ["-fsSL", "--retry", "3", "--retry-delay", "2", "-o", archive, URL], { stdio: "inherit" });

  // Verified before anything is unpacked, let alone executed: this is a binary that
  // will be signed with our Developer ID and shipped inside the app.
  const actual = createHash("sha256").update(readFileSync(archive)).digest("hex");
  if (actual !== SHA256) {
    rmSync(archive, { force: true });
    throw new Error(`checksum mismatch for ${ASSET}\n  expected ${SHA256}\n  actual   ${actual}`);
  }
  console.log("checksum ok");

  // Only the executable. The archive also carries the theme compiler, a copy of the
  // native library the npm package already provides, and a C header.
  execFileSync("tar", ["xzf", archive, "-C", OUT_DIR, "cua-driver"], { stdio: "inherit" });
  rmSync(archive, { force: true });
  chmodSync(OUT, 0o755);
  writeFileSync(STAMP, `${VERSION}\n`);

  console.log(`cua-driver ${VERSION} ready at ${OUT} (${mb(OUT)} MB)`);
}

function mb(path) {
  return Math.round((statSync(path).size / 1048576) * 10) / 10;
}

try {
  main();
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}
