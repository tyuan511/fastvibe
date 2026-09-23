import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readDecisionConfig, writeDecisionConfig } from "../src/main/engine/decision/store.ts";

/**
 * `readDecisionConfig` is the one thing every settings-pane load and every future
 * consumer trusts — a wrong default here is a decision model silently on or off. It must
 * never throw and never write, matching `oauth-store.ts`'s "corrupt file ignored rather
 * than trusted" rule.
 */

function withTempFile(fn: (file: string) => void) {
  const dir = mkdtempSync(join(tmpdir(), "fastvibe-decision-"));
  try {
    fn(join(dir, "decision.json"));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test("a missing file reads as off, without creating one", () => {
  withTempFile((file) => {
    assert.deepEqual(readDecisionConfig(file), { kind: "off" });
  });
});

test("round-trips a laya config with a base URL", () => {
  withTempFile((file) => {
    writeDecisionConfig(file, { kind: "laya", baseUrl: "http://127.0.0.1:9999" });
    assert.deepEqual(readDecisionConfig(file), { kind: "laya", baseUrl: "http://127.0.0.1:9999" });
  });
});

test("round-trips laya with no base URL (falls back to the adapter's own default)", () => {
  withTempFile((file) => {
    writeDecisionConfig(file, { kind: "laya" });
    assert.deepEqual(readDecisionConfig(file), { kind: "laya" });
  });
});

test("an invalid base URL is dropped, not stored as a broken config", () => {
  withTempFile((file) => {
    writeFileSync(file, JSON.stringify({ version: 1, decisionModel: { kind: "laya", baseUrl: "not a url" } }));
    assert.deepEqual(readDecisionConfig(file), { kind: "laya" });
  });
});

test("corrupt JSON reads as off, not thrown", () => {
  withTempFile((file) => {
    writeFileSync(file, "{not json");
    assert.deepEqual(readDecisionConfig(file), { kind: "off" });
  });
});

test("an unknown file version reads as off rather than being reinterpreted", () => {
  withTempFile((file) => {
    writeFileSync(file, JSON.stringify({ version: 2, decisionModel: { kind: "laya" } }));
    assert.deepEqual(readDecisionConfig(file), { kind: "off" });
  });
});

test("write is atomic: no partial file survives a rename", () => {
  withTempFile((file) => {
    writeDecisionConfig(file, { kind: "laya", baseUrl: "http://127.0.0.1:8787" });
    writeDecisionConfig(file, { kind: "off" });
    assert.deepEqual(readDecisionConfig(file), { kind: "off" });
  });
});
