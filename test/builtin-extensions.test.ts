import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { join } from "node:path";
import {
  BUILTIN_EXTENSIONS,
  builtinExtensionPaths,
} from "../src/main/pi/extension-manager.ts";

test("development resolves every built-in extension from the source resources directory", () => {
  const previous = process.env.FASTVIBE_RESOURCES_PATH;
  delete process.env.FASTVIBE_RESOURCES_PATH;
  try {
    const paths = builtinExtensionPaths();
    assert.equal(paths.length, BUILTIN_EXTENSIONS.length);
    assert.equal(
      paths.find((path) => path.endsWith("conversation-search.ts")),
      join(process.cwd(), "resources/extensions/conversation-search.ts"),
    );
    assert.equal(paths.every((path) => existsSync(path)), true);
  } finally {
    if (previous === undefined) delete process.env.FASTVIBE_RESOURCES_PATH;
    else process.env.FASTVIBE_RESOURCES_PATH = previous;
  }
});
