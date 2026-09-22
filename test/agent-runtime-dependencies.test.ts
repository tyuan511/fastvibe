import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { spawnSync } from "node:child_process";
import { agentRuntimePackages, checkAgentRuntime } from "../scripts/check-agent-runtime.mjs";

function fixture(files: Record<string, string>, run: (entry: string) => void) {
  const root = mkdtempSync(join(tmpdir(), "agent-dependencies-"));
  try {
    for (const [name, source] of Object.entries(files)) {
      const file = join(root, name);
      mkdirSync(dirname(file), { recursive: true });
      writeFileSync(file, source);
    }
    run(join(root, "agent.js"));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

test("walks reachable chunks, handles cycles, ignores desktop and textual false positives", () => {
  fixture({
    "agent.js": `import './chunks/a.js'; import 'node:fs'; import 'some-external-package';`,
    "chunks/a.js": `export * from '../shared.js'; // import 'electron'\nconst text = "import('electron')";`,
    "shared.js": `import './chunks/a.js'; export const value = /electron/;`,
    "index.js": `import 'electron';`,
    "chunks/desktop.js": `import 'electron';`,
  }, (entry) => assert.equal(checkAgentRuntime(entry).size, 3));
});

for (const source of [
  `import electron from 'electron';`,
  `import 'electron';`,
  `export { app } from 'electron';`,
  `export * from 'electron/main';`,
  `await import('electron');`,
  "await import(`electron`);",
  `const electron = require('electron');`,
]) {
  test(`rejects Electron edge: ${source}`, () => {
    fixture({ "agent.js": source }, (entry) => {
      assert.throws(() => checkAgentRuntime(entry), /agent\.js -> electron/);
    });
  });
}

test("follows re-exports and nested dynamic chunks with diagnostic import chain", () => {
  fixture({
    "agent.js": `export * from './chunks/a.js';`,
    "chunks/a.js": "export const load = () => import(`./b.js`);",
    "chunks/b.js": `await import('../electron%20bridge.js?build=1#module');`,
    "electron bridge.js": `import { app } from 'electron';`,
  }, (entry) => assert.throws(() => checkAgentRuntime(entry), /agent\.js -> .*a\.js -> .*b\.js -> .*electron bridge\.js -> electron/));
});

test("missing entry or reachable chunk fails closed", () => {
  fixture({}, (entry) => assert.throws(() => checkAgentRuntime(entry), /Cannot read Agent artifact/));
  fixture({ "agent.js": `import './missing.js';` }, (entry) => {
    assert.throws(() => checkAgentRuntime(entry), /agent\.js -> .*missing\.js/);
  });
});

test("malformed reachable JavaScript fails closed", () => {
  fixture({ "agent.js": `import {` }, (entry) => {
    assert.throws(() => checkAgentRuntime(entry), /Cannot parse Agent artifact/);
  });
});

test("CLI returns failure for indirect Electron and success for clean graph", () => {
  for (const electron of [false, true]) {
    fixture({
      "agent.js": `import './chunk.js';`,
      "chunk.js": electron ? `import 'electron';` : `export const safe = true;`,
    }, (entry) => {
      const result = spawnSync(process.execPath, ["scripts/check-agent-runtime.mjs", entry], { encoding: "utf8" });
      assert.equal(result.status, electron ? 1 : 0, result.stderr);
      if (electron) assert.match(result.stderr, /chunk\.js -> electron/);
    });
  }
});

test("lists the packages the Agent imports, by package name, without builtins", () => {
  fixture({
    "agent.js": `import './chunks/a.js'; import 'node:fs'; import 'path'; import ws from 'ws'; export { x } from '@scope/pkg/sub/path.js';`,
    "chunks/a.js": `const m = await import('@scope/other'); require('left-pad/index.js');`,
    "index.js": `import 'desktop-only-package';`,
  }, (entry) => assert.deepEqual([...agentRuntimePackages(entry)].sort(), ["@scope/other", "@scope/pkg", "left-pad", "ws"]));
});
