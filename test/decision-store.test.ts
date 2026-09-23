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

test("round-trips a jev config", () => {
  withTempFile((file) => {
    writeDecisionConfig(file, { kind: "jev" });
    assert.deepEqual(readDecisionConfig(file), { kind: "jev" });
  });
});

test("a laya config from an earlier build reads as off", () => {
  withTempFile((file) => {
    writeFileSync(file, JSON.stringify({ version: 1, decisionModel: { kind: "laya", baseUrl: "http://127.0.0.1:8787" } }));
    assert.deepEqual(readDecisionConfig(file), { kind: "off" });
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
    writeFileSync(file, JSON.stringify({ version: 2, decisionModel: { kind: "jev" } }));
    assert.deepEqual(readDecisionConfig(file), { kind: "off" });
  });
});

test("write is atomic: no partial file survives a rename", () => {
  withTempFile((file) => {
    writeDecisionConfig(file, { kind: "jev" });
    writeDecisionConfig(file, { kind: "off" });
    assert.deepEqual(readDecisionConfig(file), { kind: "off" });
  });
});
