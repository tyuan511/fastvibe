#!/usr/bin/env node
import { createHash } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";

const args = new Map(process.argv.slice(2).map((arg) => {
  const [key, ...rest] = arg.replace(/^--/, "").split("=");
  return [key, rest.join("=") || true];
}));
const output = args.get("output");
const inputs = process.argv.slice(2).filter((arg) => !arg.startsWith("--"));
if (typeof output !== "string" || inputs.length < 2) {
  throw new Error("用法：node scripts/merge-agent-runtime-metadata.mjs --output=FILE METADATA...");
}

const targets = {};
for (const input of inputs) {
  const metadata = JSON.parse(readFileSync(resolve(input), "utf8"));
  if (metadata?.schema !== 1 || typeof metadata.target !== "string" || !/^linux-(x64|arm64)$/.test(metadata.target)) {
    throw new Error(`Agent runtime metadata 无效：${basename(input)}`);
  }
  if (!/^[a-f0-9]{64}$/.test(metadata.runtimeHash)) {
    throw new Error(`Agent runtime hash 无效：${metadata.target}`);
  }
  if (!/^[a-f0-9]{64}$/.test(metadata.archiveSha256)) {
    throw new Error(`Agent runtime archive hash 无效：${metadata.target}`);
  }
  const expectedArchive = `fastvibe-agent-${metadata.target}.tar.gz`;
  if (metadata.archive !== expectedArchive) throw new Error(`Agent runtime archive 名称无效：${metadata.target}`);
  const archivePath = join(dirname(resolve(input)), metadata.archive);
  if (existsSync(archivePath)) {
    const actual = createHash("sha256").update(readFileSync(archivePath)).digest("hex");
    if (actual !== metadata.archiveSha256) throw new Error(`Agent runtime archive 校验失败：${metadata.target}`);
  }
  if (targets[metadata.target]) throw new Error(`Agent runtime metadata 重复：${metadata.target}`);
  targets[metadata.target] = {
    runtimeHash: metadata.runtimeHash,
    archive: metadata.archive,
    archiveSha256: metadata.archiveSha256,
    ...(typeof metadata.node === "string" ? { node: metadata.node } : {}),
  };
}

for (const target of ["linux-x64", "linux-arm64"]) {
  if (!targets[target]) throw new Error(`缺少 Agent runtime metadata：${target}`);
}
writeFileSync(resolve(output), `${JSON.stringify({ schema: 1, targets }, null, 2)}\n`);
