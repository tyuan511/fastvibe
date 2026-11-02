import assert from "node:assert/strict";
import test from "node:test";
import { modelCuaResultText, normalizeCuaMetadata } from "../src/shared/cua-result.ts";

test("model-facing CUA results include structured observations and readable verdicts", () => {
  const text = modelCuaResultText("动作已执行", '{"status":2}', {
    action: {
      effect: 0,
      route: 0,
      delivery: { mode: 1 },
      evidence: [{ kind: 1 }],
    },
    verification: {
      status: 0,
      predicates: [{ index: 0n, status: 0, unknownReason: 4 }],
    },
  });

  assert.match(text, /\[CUA structured result\]/);
  assert.match(text, /"status": "Unknown"/);
  assert.match(text, /"effect": "Confirmed"/);
  assert.match(text, /"route": "Accessibility"/);
  assert.match(text, /"mode": "Foreground"/);
  assert.match(text, /"kind": "WindowChange"/);
  assert.match(text, /"unknownReason": "TargetMissing"/);
  assert.match(text, /"index": "0"/);
});

test("CUA metadata normalization preserves ordinary values", () => {
  assert.deepEqual(normalizeCuaMetadata({ label: "Save", enabled: true }), { label: "Save", enabled: true });
});
