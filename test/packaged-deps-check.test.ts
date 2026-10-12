import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";

const { skippedDeps } = createRequire(import.meta.url)("../scripts/check-packaged-deps.cjs") as { skippedDeps: (name: string, platform?: string) => Set<string> };

test("only the Linux build may lack the computer-use SDK the app declares", () => {
  assert.ok(skippedDeps("fastvibe", "linux").has("@trycua/cua-driver"));
  for (const platform of ["darwin", "win32", undefined]) {
    assert.equal(skippedDeps("fastvibe", platform).has("@trycua/cua-driver"), false, String(platform));
  }
  assert.equal(skippedDeps("some-package", "linux").size, 0, "other packages are still held to their dependencies");
});
