#!/usr/bin/env node
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

const args = new Map(process.argv.slice(2).map((arg) => {
  const [key, ...rest] = arg.replace(/^--/, "").split("=");
  return [key, rest.join("=") || true];
}));
const candidatesPath = args.get("candidates");
const latestPath = args.get("latest");
const outputPath = args.get("output");
if (typeof candidatesPath !== "string" || typeof outputPath !== "string") {
  throw new Error("用法：node scripts/resolve-agent-runtime-release.mjs --candidates=FILE --output=FILE [--latest=FILE]");
}

const candidates = JSON.parse(readFileSync(resolve(candidatesPath), "utf8"));
validate(candidates, false);
const latest = typeof latestPath === "string" && existsSync(resolve(latestPath))
  ? JSON.parse(readFileSync(resolve(latestPath), "utf8"))
  : undefined;
if (latest) validate(latest, true);

const same = Boolean(latest) && ["linux-x64", "linux-arm64"].every((target) =>
  latest.targets[target].runtimeHash === candidates.targets[target].runtimeHash,
);
const release = same ? latest.release : `agent-runtime-v${nextNumber(latest?.release)}`;
const targets = same ? latest.targets : candidates.targets;
writeFileSync(resolve(outputPath), `${JSON.stringify({ schema: 1, release, targets }, null, 2)}\n`);
console.log(`${same ? "reusing" : "creating"} ${release}`);

function nextNumber(value) {
  const match = /^agent-runtime-v(\d+)$/.exec(value || "");
  return match ? Number(match[1]) + 1 : 1;
}

function validate(value, requireRelease) {
  if (value?.schema !== 1 || (requireRelease && !/^agent-runtime-v\d+$/.test(value.release))) {
    throw new Error("Agent runtime release metadata 无效");
  }
  for (const target of ["linux-x64", "linux-arm64"]) {
    const item = value.targets?.[target];
    if (!item || !/^[a-f0-9]{64}$/.test(item.runtimeHash)) {
      throw new Error(`Agent runtime release 缺少有效 hash：${target}`);
    }
  }
}
