import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openShadowStore } from "../src/main/bot/shadow/store.ts";

test("production Vivi store requires an explicit authorized root and preserves its purpose", () => {
  const root = mkdtempSync(join(tmpdir(), "vivi-production-"));
  const file = join(root, "shadow.db");
  try {
    const first = openShadowStore(file, undefined, { allowedRoot: root, purpose: "vivi-production" });
    first.set("probe", { ok: true });
    first.close();
    const reopened = openShadowStore(file, undefined, { allowedRoot: root, purpose: "vivi-production" });
    assert.deepEqual(reopened.get("probe"), { ok: true });
    reopened.close();
    assert.throws(() => openShadowStore(file), /isolated-m2/);
    assert.throws(() => openShadowStore(file, undefined, { allowedRoot: root }), /isolated-m2/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
