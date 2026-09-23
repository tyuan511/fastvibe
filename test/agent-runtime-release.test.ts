import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

const script = join(process.cwd(), "scripts", "resolve-agent-runtime-release.mjs");
const x64 = "a".repeat(64);
const arm64 = "b".repeat(64);

function candidate(x = x64) {
  return JSON.stringify({ schema: 1, targets: {
    "linux-x64": { runtimeHash: x, archive: "fastvibe-agent-linux-x64.tar.gz", archiveSha256: x },
    "linux-arm64": { runtimeHash: arm64, archive: "fastvibe-agent-linux-arm64.tar.gz", archiveSha256: arm64 },
  } });
}

function resolveRelease(dir: string, candidatePath: string, latestPath?: string): { release: string; path: string } {
  const path = join(dir, `out-${Math.random()}.json`);
  const args = [script, `--candidates=${candidatePath}`, `--output=${path}`];
  if (latestPath) args.push(`--latest=${latestPath}`);
  execFileSync(process.execPath, args, { stdio: "pipe" });
  return { ...JSON.parse(readFileSync(path, "utf8")), path };
}

test("runtime release resolver keeps a readable id when hashes are unchanged", () => {
  const dir = mkdtempSync(join(tmpdir(), "fastvibe-runtime-release-"));
  try {
    const candidates = join(dir, "candidates.json");
    writeFileSync(candidates, candidate());
    const first = resolveRelease(dir, candidates);
    assert.equal(first.release, "agent-runtime-v1");
    const reused = resolveRelease(dir, candidates, first.path);
    assert.equal(reused.release, "agent-runtime-v1");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("runtime release resolver increments only after a content hash changes", () => {
  const dir = mkdtempSync(join(tmpdir(), "fastvibe-runtime-release-"));
  try {
    const firstCandidates = join(dir, "first.json");
    writeFileSync(firstCandidates, candidate());
    const first = resolveRelease(dir, firstCandidates);
    const changedCandidates = join(dir, "changed.json");
    writeFileSync(changedCandidates, candidate("c".repeat(64)));
    const changed = resolveRelease(dir, changedCandidates, first.path);
    assert.equal(changed.release, "agent-runtime-v2");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
