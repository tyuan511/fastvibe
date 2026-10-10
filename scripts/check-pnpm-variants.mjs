/**
 * Fails when pnpm resolved an agent package under more than one peer variant.
 *
 * `pi-ai@1.1.0(…)(undici@8.10.2)` and `pi-ai@1.1.0(…)(undici@8.11.2)` are two installs of the
 * same version, which happens when this repo's own pin of a package differs from the one
 * `pi-coding-agent` declares. electron-builder's pnpm collector cannot place such a package and
 * silently drops what is under it: v0.19.0 shipped without `cross-spawn`, `@anthropic-ai/sdk`
 * and seven more, and would not start. It also costs installer size: each copy of a package
 * ends up in the archive.
 *
 * The fix is to line the pin up with what `pi-coding-agent` declares, not to change this check.
 */
import { readFileSync } from "node:fs";

const WATCHED = ["@earendil-works/pi-ai", "@earendil-works/pi-coding-agent", "@earendil-works/pi-mcp", "@earendil-works/pi-tui"];

const lock = readFileSync(new URL("../pnpm-lock.yaml", import.meta.url), "utf8");
const snapshots = lock.split("\nsnapshots:\n")[1] ?? "";
const keys = [...snapshots.matchAll(/^ {2}'?([^\s'][^:]*?)'?:/gm)].map((match) => match[1]);

const problems = [];
for (const name of WATCHED) {
  const variants = keys.filter((key) => key.startsWith(`${name}@`));
  if (variants.length > 1) {
    const peers = variants.map((key) => key.slice(key.indexOf("(")) || "(no peers)");
    problems.push(`${name} is installed ${variants.length} times:\n${peers.map((peer) => `    ${peer}`).join("\n")}`);
  }
}

if (problems.length > 0) {
  console.error(`${problems.join("\n")}\n\nA pin in package.json differs from the one pi-coding-agent declares (undici and typebox are the ones that have to match). Align it, run pnpm install, and check again.`);
  process.exit(1);
}
console.log(`pnpm variants: one install of each of ${WATCHED.length} agent packages`);
