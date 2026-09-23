import assert from "node:assert/strict";
import test from "node:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { hashRuntimeDirectory } from "../scripts/agent-runtime-hash.mjs";

function fixture(): string {
  const root = mkdtempSync(join(tmpdir(), "fastvibe-agent-hash-"));
  mkdirSync(join(root, "out", "main"), { recursive: true });
  writeFileSync(join(root, "out", "main", "agent.js"), "console.log('agent');\n");
  writeFileSync(join(root, "package.json"), '{"version":"0.0.0"}\n');
  writeFileSync(join(root, "manifest.json"), '{"runtimeHash":"old"}\n');
  return root;
}

test("runtime hash is independent of manifest content and directory order", () => {
  const root = fixture();
  try {
    const first = hashRuntimeDirectory(root, { target: "linux-x64", node: "v24.0.0" });
    writeFileSync(join(root, "out", "main", "desktop-only.js"), "desktop change\n");
    const ignoredDesktopChange = hashRuntimeDirectory(root, {
      target: "linux-x64",
      node: "v24.0.0",
      ignore: (name) => name === "out/main/desktop-only.js",
    });
    assert.equal(ignoredDesktopChange, first);
    writeFileSync(join(root, "manifest.json"), '{"runtimeHash":"new","version":"desktop-9.9.9"}\n');
    writeFileSync(join(root, "extra.txt"), "added\n");
    const second = hashRuntimeDirectory(root, { target: "linux-x64", node: "v24.0.0" });
    assert.notEqual(first, second);
    rmSync(join(root, "extra.txt"));
    rmSync(join(root, "out", "main", "desktop-only.js"));
    assert.equal(hashRuntimeDirectory(root, { target: "linux-x64", node: "v24.0.0" }), first);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("runtime hash distinguishes target and Node fallback version", () => {
  const root = fixture();
  try {
    const base = hashRuntimeDirectory(root, { target: "linux-x64", node: "v24.0.0" });
    assert.notEqual(base, hashRuntimeDirectory(root, { target: "linux-arm64", node: "v24.0.0" }));
    assert.notEqual(base, hashRuntimeDirectory(root, { target: "linux-x64", node: "v24.0.1" }));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
