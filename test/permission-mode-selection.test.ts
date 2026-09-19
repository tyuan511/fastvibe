import { test } from "node:test";
import assert from "node:assert/strict";
import {
  needsFullAccessConfirmation,
  permissionModePatch,
} from "../src/renderer/src/lib/permission-mode-selection.ts";

const smart = {
  permissionMode: "smart" as const,
  defaultPermissionMode: "smart" as const,
  fullAccessConfirmed: false,
};

test("full access requires confirmation only before its first acknowledgement", () => {
  assert.equal(needsFullAccessConfirmation(smart, "full"), true);
  assert.equal(
    needsFullAccessConfirmation({ ...smart, fullAccessConfirmed: true }, "full"),
    false,
  );
  assert.equal(needsFullAccessConfirmation(smart, "ask"), false);
});

test("a permission choice is persisted as both the live and startup mode", () => {
  assert.deepEqual(permissionModePatch("full", true), {
    permissionMode: "full",
    defaultPermissionMode: "full",
    fullAccessConfirmed: true,
  });
  assert.deepEqual(permissionModePatch("smart"), {
    permissionMode: "smart",
    defaultPermissionMode: "smart",
  });
});
