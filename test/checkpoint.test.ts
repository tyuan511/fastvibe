import { test } from "node:test";
import assert from "node:assert/strict";
import { CheckpointStore, readBefore, readBeforeBinary, restoreCheckpoint, type TurnCheckpoint } from "../src/main/engine/checkpoint.ts";
import { openTestDb } from "./test-db.ts";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { tmpdir } from "node:os";
import { existsSync, realpathSync } from "node:fs";

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

test("an Office zip is kept as bytes and written back on restore", async () => {
  await withTempDir(async (dir) => {
    const path = join(dir, "deck.pptx");
    const original = Buffer.from([0x50, 0x4b, 0x03, 0x04, 0x00, 0x01]);
    await writeFile(path, original);
    const captured = readBeforeBinary(path);
    assert.equal(captured.opaque, undefined);
    assert.equal(captured.binary, original.toString("base64"));
    await writeFile(path, Buffer.from([0x00, 0xff]));
    const result = await restoreCheckpoint({
      conversationId: "c1",
      cwd: dir,
      createdAt: 1,
      files: [captured],
    });
    assert.deepEqual(result.restored, [path]);
    assert.deepEqual(await readFile(path), original);
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

test("a turn that writes two repositories records a baseline for each", async () => {
  const git = promisify(execFile);
  await withTempDir(async (dir) => {
    const left = join(dir, "left");
    const right = join(dir, "right");
    await Promise.all([git("git", ["init", left]), git("git", ["init", right])]);
    const commit = async (root: string, name: string): Promise<void> => {
      await writeFile(join(root, name), "before\n", "utf8");
      await git("git", ["-C", root, "add", name]);
      await git("git", ["-C", root, "-c", "user.email=t@example.com", "-c", "user.name=t", "commit", "-m", "init"]);
    };
    await commit(left, "a.txt");
    await commit(right, "b.txt");
    const checkpoint = await new CheckpointStore(openTestDb(dir)).capture("c-repos", left, [
      { path: join(left, "a.txt"), content: "before\n" },
      { path: join(right, "b.txt"), content: "before\n" },
    ]);
    assert.equal(checkpoint.repos?.length, 2);
    const roots = new Set(checkpoint.repos?.map((repo) => repo.root));
    assert.equal(roots.has(realpathSync(left)), true);
    assert.equal(roots.has(realpathSync(right)), true);
    assert.ok(checkpoint.repos?.every((repo) => repo.head));
  });
});

test("a rewrite hook runs before each file is touched, and a hook that throws does not stop the rewind", async () => {
  await withTempDir(async (dir) => {
    const deck = join(dir, "deck.pptx");
    const note = join(dir, "note.txt");
    await writeFile(deck, Buffer.from([0x50, 0x4b, 0x00]));
    await writeFile(note, "before", "utf8");
    const files = [readBeforeBinary(deck), { path: note, content: "before" }];
    await writeFile(deck, Buffer.from([0xff]));
    await writeFile(note, "after", "utf8");
    const seen: string[] = [];
    const result = await restoreCheckpoint(
      { conversationId: "c1", cwd: dir, createdAt: 1, files },
      {
        beforeRewrite: async (path) => {
          // At the moment the hook runs, the attempt's bytes must still be on disk.
          seen.push(`${path}:${(await readFile(path)).length}`);
          if (path === deck) throw new Error("resident would not close");
        },
      },
    );
    assert.deepEqual(seen, [`${deck}:1`, `${note}:5`]);
    assert.deepEqual(result.restored, [deck, note]);
    assert.equal(await readFile(note, "utf8"), "before");
  });
});
