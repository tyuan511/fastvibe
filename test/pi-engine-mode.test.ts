import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { assertSeparateAgentDirs, readPiEngineState, writePiEngineMode } from "../src/main/engine/pi-engine-mode.ts";

test("pi engine defaults to the isolated directory and keeps global pi separate", () => {
  const dir = mkdtempSync(join(tmpdir(), "fastvibe-pi-engine-"));
  try {
    const state = readPiEngineState(dir);
    assert.equal(state.mode, "isolated");
    assert.equal(state.agentDir, state.isolatedAgentDir);
    assert.notEqual(state.agentDir, state.globalAgentDir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("pi engine mode is durable and only accepts separate directories", () => {
  const dir = mkdtempSync(join(tmpdir(), "fastvibe-pi-engine-"));
  try {
    const global = join(dir, "global");
    writePiEngineMode(dir, "global", global);
    const state = readPiEngineState(dir);
    assert.equal(state.mode, "global");
    assert.equal(state.agentDir, global);
    assertSeparateAgentDirs(state.isolatedAgentDir, state.globalAgentDir);
    assert.match(readFileSync(join(dir, "engine-mode.json"), "utf8"), /"mode": "global"/);
    assert.throws(() => assertSeparateAgentDirs(global, global));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
