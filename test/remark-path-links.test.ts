import { test } from "node:test";
import assert from "node:assert/strict";
import { collectPathCandidates, isPathLike } from "../src/renderer/src/lib/remark-path-links.ts";

test("path candidates include prose and inline-code paths", () => {
  assert.deepEqual(
    collectPathCandidates("改动 src/main/index.ts，并检查 `src/renderer/src/App.tsx` 和 /tmp/notes.md。"),
    ["src/main/index.ts", "src/renderer/src/App.tsx", "/tmp/notes.md"],
  );
});

test("path candidates skip fenced and indented code", () => {
  assert.deepEqual(
    collectPathCandidates("src/real.ts\n\n```ts\nsrc/example.ts\n```\n\n    src/indented.ts\n\n`src/inline.ts`"),
    ["src/real.ts", "src/inline.ts"],
  );
});

test("path-like syntax remains only a candidate until filesystem validation", () => {
  assert.equal(isPathLike("feature/login"), true);
  assert.equal(isPathLike("/v1/chat/completions"), true);
});
