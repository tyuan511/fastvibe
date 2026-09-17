import { test } from "node:test";
import assert from "node:assert/strict";
import { readBefore, restoreCheckpoint, type TurnCheckpoint } from "../src/main/engine/checkpoint.ts";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { existsSync } from "node:fs";

/**
 * The checkpoint is what makes 重试 safe to offer: it is the only thing standing between
 * "retry this turn" and "re-run the prompt against code the failed attempt already
 * changed". Its two halves — reading a file's pre-turn state, and putting the workspace
 * back — are pure enough to test directly, and both have a failure mode that is silent
 * (the retry just sees the wrong tree).
 */

async function withTempDir<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), "fastvibe-checkpoint-"));
  try {
    return await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

test("a file that exists is captured with its content", async () => {
  await withTempDir(async (dir) => {
    const path = join(dir, "a.ts");
    await writeFile(path, "const a = 1;\n", "utf8");
    const captured = readBefore(path);
    assert.equal(captured.content, "const a = 1;\n");
    assert.equal(captured.created, undefined);
    assert.equal(captured.opaque, undefined);
  });
});

test("a file that does not exist is marked created, not empty", async () => {
  await withTempDir(async (dir) => {
    // The distinction is load-bearing: reverting a file the turn *created* means
    // deleting it, and an empty `content` would instead write an empty file.
    const captured = readBefore(join(dir, "new.ts"));
    assert.equal(captured.created, true);
    assert.equal(captured.content, undefined);
  });
});

test("a binary file is opaque rather than decoded as text", async () => {
  await withTempDir(async (dir) => {
    const path = join(dir, "logo.png");
    await writeFile(path, Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0x01, 0x02]));
    const captured = readBefore(path);
    assert.equal(captured.opaque, true);
    assert.equal(captured.content, undefined);
  });
});

test("restoring rewrites a captured file", async () => {
  await withTempDir(async (dir) => {
    const path = join(dir, "a.ts");
    const checkpoint: TurnCheckpoint = {
      conversationId: "c1",
      cwd: dir,
      createdAt: 1,
      files: [{ path, content: "before\n" }],
    };
    // The turn has since overwritten it, which is the case being undone.
    await writeFile(path, "after\n", "utf8");
    const result = await restoreCheckpoint(checkpoint);
    assert.deepEqual(result.restored, [path]);
    assert.equal(await readFile(path, "utf8"), "before\n");
  });
});

test("restoring deletes a file the turn created", async () => {
  await withTempDir(async (dir) => {
    const path = join(dir, "created.ts");
    await writeFile(path, "made by the turn\n", "utf8");
    const checkpoint: TurnCheckpoint = {
      conversationId: "c1",
      cwd: dir,
      createdAt: 1,
      files: [{ path, created: true }],
    };
    const result = await restoreCheckpoint(checkpoint);
    assert.deepEqual(result.removed, [path]);
    assert.equal(existsSync(path), false);
  });
});

test("a created file that was already deleted is not an error", async () => {
  await withTempDir(async (dir) => {
    // The model may have created and then removed it, or the user did.
    const checkpoint: TurnCheckpoint = {
      conversationId: "c1",
      cwd: dir,
      createdAt: 1,
      files: [{ path: join(dir, "gone.ts"), created: true }],
    };
    const result = await restoreCheckpoint(checkpoint);
    assert.deepEqual(result.removed, []);
    assert.deepEqual(result.skipped, []);
  });
});

test("an opaque file is reported as skipped rather than silently dropped", async () => {
  await withTempDir(async (dir) => {
    // No content copy and no git: there is nothing to put back, and the caller has to
    // be able to say so instead of claiming a clean restore.
    const checkpoint: TurnCheckpoint = {
      conversationId: "c1",
      cwd: dir,
      createdAt: 1,
      files: [{ path: join(dir, "big.bin"), opaque: true }],
    };
    const result = await restoreCheckpoint(checkpoint);
    assert.deepEqual(result.skipped, [join(dir, "big.bin")]);
  });
});
