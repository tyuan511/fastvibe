import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import assert from "node:assert/strict";
import { existingFiles } from "../src/main/engine/path-exists.ts";

test("batch file probes return regular files, not directories or missing paths", async () => {
  const root = await mkdtemp(join(tmpdir(), "fastvibe-paths-"));
  await mkdir(join(root, "src"));
  await writeFile(join(root, "src", "main.ts"), "export {};");

  assert.deepEqual(
    new Set(await existingFiles(["src/main.ts", "src", "src/missing.ts", "../outside"], root)),
    new Set(["src/main.ts"]),
  );
});

test("a relative candidate without a workspace is never resolved from Main's cwd", async () => {
  assert.deepEqual(await existingFiles(["package.json", "./package.json"], undefined), []);
});

test("batch probes are bounded", async () => {
  const result = await existingFiles(Array.from({ length: 600 }, (_, index) => `/missing/${index}.ts`), undefined);
  assert.deepEqual(result, []);
});
