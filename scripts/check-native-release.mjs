#!/usr/bin/env node
// The in-app updater needs GitHub's trusted SHA256, not a hash fetched beside a binary.
import { readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { nativeVersion, checkNativeTag } from "./package-native-macos.mjs";

const release = JSON.parse(readFileSync(process.argv[2], "utf8"));
checkNativeTag(release.tag_name);
if (!release.draft || !release.prerelease) throw new Error("native assets must still be in a draft prerelease");
const name = `FastVibe-Native-${nativeVersion()}-mac-arm64.zip`;
const archive = release.assets.find((a) => a.name === name);
const sha256 = readFileSync(join(process.argv[3], `${name}.sha256`), "utf8").trim().split(/\s+/)[0];
if (!/^[0-9a-f]{64}$/.test(sha256) || archive?.digest !== `sha256:${sha256}` || archive?.size !== statSync(join(process.argv[3], name)).size) {
  throw new Error("GitHub archive digest/size does not match the verified native package; keep this release in draft");
}
console.log("GitHub native archive SHA256 and size match; preview can be published");
