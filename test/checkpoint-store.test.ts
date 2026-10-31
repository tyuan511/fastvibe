import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { CheckpointStore, checkpointFile, trimCheckpointFiles, type CheckpointFile } from "../src/main/engine/checkpoint.ts";
import { openSecondTestDb, openTestDb, testDir } from "./test-db.ts";
import { closeDatabases } from "../src/main/engine/db.ts";

/**
 * The checkpoint store: what a turn's workspace looked like before the turn ran.
 *
 * It used to be a 784 KB `checkpoints.json` written **only** in `stop()`. So the store that
 * exists to make 重试 honest was the one thing a crash definitely took away — the case it is
 * for. These cases pin the change (§5.2, decision 3): a capture is durable without any quit
 * path running, a replacement leaves no orphan file rows, and 「清除」 of a conversation
 * removes the source code it was holding.
 *
 * The bounds are tested here too (`trimCheckpointFiles`), because past them a file is
 * recorded as opaque and the rewind silently stops covering it.
 */

const files = (dir: string, names: string[]): CheckpointFile[] =>
  names.map((name) => ({ path: join(dir, name), content: `before ${name}\n` }));

test("a capture is readable from a new connection without any flush", async () => {
  const dir = testDir("fastvibe-checkpoint-store-");
  const store = new CheckpointStore(openTestDb(dir));
  const checkpoint = await store.capture("c1", dir, files(dir, ["a.ts", "b.ts"]));
  assert.equal(checkpoint.files.length, 2);

  // Stands in for the process that starts after a crash: no `stop()`, no `flush()` ran.
  const after = new CheckpointStore(openSecondTestDb(dir));
  const restored = after.get("c1");
  assert.equal(restored?.cwd, dir);
  assert.deepEqual(
    restored?.files.map((file) => file.content),
    ["before a.ts\n", "before b.ts\n"],
  );
  assert.equal(after.get("nope"), undefined);
  after.clear("c1");
  assert.equal(openTestDb(dir).countRows("checkpoints"), 0);
});

test("a turn appends newly seen files without replacing earlier rows", async () => {
  const dir = testDir("fastvibe-checkpoint-store-");
  const store = new CheckpointStore(openTestDb(dir));
  const turnFiles = files(dir, ["a.ts"]);
  await store.capture("c1", dir, turnFiles);
  turnFiles.push(...files(dir, ["b.ts"]));
  await store.capture("c1", dir, turnFiles);
  const db = openTestDb(dir);
  assert.equal(db.countRows("checkpoint_files"), 2);
  assert.deepEqual(
    new CheckpointStore(db).get("c1")?.files.map((file) => file.path.split("/").pop()),
    ["a.ts", "b.ts"],
  );
});

test("a conversation keeps one checkpoint, and replacing it leaves no file rows behind", async () => {
  const dir = testDir("fastvibe-checkpoint-store-");
  const store = new CheckpointStore(openTestDb(dir));
  await store.capture("c1", dir, files(dir, ["a.ts", "b.ts", "c.ts"]));
  await store.capture("c1", dir, files(dir, ["d.ts"]));
  const db = openTestDb(dir);
  assert.equal(db.countRows("checkpoints"), 1);
  assert.equal(db.countRows("checkpoint_files"), 1, "the cascade took the old three with it");
  assert.deepEqual(
    db.all<{ path: string }>("SELECT path FROM checkpoint_files ORDER BY seq").map((row) => row.path.split("/").pop()),
    ["d.ts"],
  );
  assert.deepEqual(new CheckpointStore(db).get("c1")?.files.map((file) => file.path.split("/").pop()), ["d.ts"]);
});

test("clearing a conversation drops its rows for every connection", async () => {
  const dir = testDir("fastvibe-checkpoint-store-");
  const store = new CheckpointStore(openTestDb(dir));
  await store.capture("c1", dir, files(dir, ["secret.ts"]));
  const other = openSecondTestDb(dir);
  assert.equal(new CheckpointStore(other).get("c1")?.files.length, 1);
  store.clear("c1");
  assert.equal(new CheckpointStore(other).get("c1"), undefined);
  assert.equal(other.countRows("checkpoint_files"), 0);
  other.close();
});

test("the old checkpoints.json is imported once and kept under a new name", async () => {
  const dir = testDir("fastvibe-checkpoint-store-");
  const legacy = checkpointFile(dir);
  writeFileSync(
    legacy,
    JSON.stringify([
      { conversationId: "c1", cwd: "/work/app", createdAt: 10, head: "abc", files: [{ path: "/work/app/a.ts", content: "x" }] },
      // Junk the old loader refused or can never read back: no id, and no file list.
      { conversationId: "", cwd: "/work/app", createdAt: 1, files: [] },
      { conversationId: "c2", cwd: "/work/app", createdAt: 2 },
      { conversationId: "c3", cwd: "/work/app", createdAt: 3, files: [] },
    ]),
    "utf8",
  );

  const store = new CheckpointStore(openTestDb(dir), { legacyFile: legacy });
  assert.equal(store.get(""), undefined, "an entry with no id can never be read back");
  assert.equal(store.get("c1")?.head, "abc");
  assert.equal(store.get("c1")?.files.length, 1);
  assert.equal(store.get("c2"), undefined, "an entry without files is not a checkpoint");
  assert.deepEqual(store.get("c3")?.files, [], "a checkpoint with no files survives as itself");

  const db = openTestDb(dir);
  assert.equal(db.countRows("checkpoints"), 2);
  assert.equal(db.countRows("checkpoint_files"), 1);
  assert.ok(!existsSync(legacy));
  assert.equal(readdirSync(dir).filter((name) => name.startsWith("checkpoints.json.migrated-")).length, 1);
  assert.equal(db.get<{ status: string }>("SELECT status FROM legacy_imports WHERE name = 'checkpoints'")?.status, "imported");
});

test("a corrupt checkpoints.json is kept and nothing is imported", () => {
  const dir = testDir("fastvibe-checkpoint-store-");
  const legacy = checkpointFile(dir);
  writeFileSync(legacy, "[ { broken", "utf8");
  const store = new CheckpointStore(openTestDb(dir), { legacyFile: legacy });
  assert.equal(store.get("anything"), undefined);
  assert.ok(readdirSync(dir).some((name) => name.startsWith("checkpoints.json.corrupt-")), readdirSync(dir).join(","));
});

test("repos and head survive the round trip, because the restore branches on them", async () => {
  const dir = testDir("fastvibe-checkpoint-store-");
  const db = openTestDb(dir);
  // Not a git repo, so `capture` resolves no revision: write the row the way a real turn
  // would and read it back, which is what the restore path's branching depends on.
  db.run(
    "INSERT INTO checkpoints (conversation_id, cwd, created_at, head, repos) VALUES (?, ?, ?, ?, ?)",
    "c1",
    dir,
    1,
    "deadbeef",
    JSON.stringify([{ root: dir, head: "deadbeef", paths: [join(dir, "a.ts")] }]),
  );
  db.run("INSERT INTO checkpoint_files (conversation_id, seq, path, data) VALUES (?, ?, ?, ?)", "c1", 0, join(dir, "a.ts"), JSON.stringify({ path: join(dir, "a.ts"), content: "before" }));
  const checkpoint = new CheckpointStore(db).get("c1");
  assert.equal(checkpoint?.head, "deadbeef");
  assert.equal(checkpoint?.repos?.length, 1);
  assert.equal(checkpoint?.repos?.[0].root, dir);
});

test("files past the bounds are recorded without content", () => {
  const dir = "/work";
  const big: CheckpointFile = { path: join(dir, "big.ts"), content: "x".repeat(2 * 1024 * 1024), bytes: 2 * 1024 * 1024 };
  const kept = trimCheckpointFiles([big, { path: join(dir, "small.ts"), content: "short" }]);
  // 32 MB is the whole-checkpoint bound, so one 2 MB file is not it; the count is.
  assert.equal(kept[0].content, big.content);

  const many: CheckpointFile[] = [];
  for (let index = 0; index < 205; index++) many.push({ path: join(dir, `f${index}.ts`), content: "y", bytes: 1 });
  const trimmed = trimCheckpointFiles(many);
  assert.equal(trimmed.filter((file) => file.content !== undefined).length, 200, "MAX_COPIED_FILES");
  assert.deepEqual(trimmed.slice(200), [
    { path: join(dir, "f200.ts"), opaque: true },
    { path: join(dir, "f201.ts"), opaque: true },
    { path: join(dir, "f202.ts"), opaque: true },
    { path: join(dir, "f203.ts"), opaque: true },
    { path: join(dir, "f204.ts"), opaque: true },
  ]);

  const huge: CheckpointFile[] = [
    { path: join(dir, "one.ts"), content: "z".repeat(17 * 1024 * 1024), bytes: 17 * 1024 * 1024 },
    { path: join(dir, "two.ts"), content: "z".repeat(17 * 1024 * 1024), bytes: 17 * 1024 * 1024 },
  ];
  const bounded = trimCheckpointFiles(huge);
  assert.equal(bounded[0].content !== undefined, true);
  assert.equal(bounded[1].opaque, true, "MAX_TOTAL_BYTES");
});

test("closing the process folds the write-ahead log away", async () => {
  const dir = testDir("fastvibe-checkpoint-store-");
  const store = new CheckpointStore(openTestDb(dir));
  await store.capture("c1", dir, files(dir, ["a.ts"]));
  closeDatabases();
  assert.ok(!existsSync(join(dir, "fastvibe.db-wal")));
});
