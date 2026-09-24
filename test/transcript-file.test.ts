import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import {
  relinkDanglingEntries,
  repairTranscriptFile,
  writeTranscriptEntries,
} from "../src/main/engine/transcript-file.ts";
import { loadConversationTranscriptBranch } from "../src/main/engine/conversation-transcript-search.ts";

const timestamp = "2026-09-23T00:00:00.000Z";

function message(id: string, parentId: string | null, role: string, text: string): Record<string, unknown> {
  return {
    type: "message",
    id,
    parentId,
    timestamp,
    message: role === "assistant"
      ? { role, content: [{ type: "text", text }], stopReason: "stop", timestamp: Date.parse(timestamp) }
      : { role, content: text, timestamp: Date.parse(timestamp) },
  };
}

function header(cwd: string): Record<string, unknown> {
  return { type: "session", version: 3, id: "session", timestamp, cwd };
}

function lines(entries: unknown[]): string {
  return `${entries.map((entry) => JSON.stringify(entry)).join("\n")}\n`;
}

async function withDir(run: (dir: string) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), "fastvibe-transcript-file-"));
  try {
    await run(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

/** The shape found in the wild: a prompt lost from the file, its reply still pointing at it. */
function gapped(cwd: string): Record<string, unknown>[] {
  return [
    header(cwd),
    message("u1", null, "user", "first prompt"),
    message("a1", "u1", "assistant", "first reply"),
    message("u2", "a1", "user", "second prompt"),
    message("a2", "u2", "assistant", "second reply"),
    // `u3` never reached the file.
    message("a3", "u3", "assistant", "third reply"),
    message("u4", "a3", "user", "fourth prompt"),
  ];
}

test("relinks an entry whose parent is missing to the entry before it", () => {
  const entries = gapped("/tmp");
  assert.equal(relinkDanglingEntries(entries), 1);
  assert.equal(entries[5].parentId, "a2");
  assert.equal(entries[6].parentId, "a3");
});

test("leaves a whole chain and legitimate branches alone", () => {
  const entries = [
    header("/tmp"),
    message("u1", null, "user", "first"),
    message("a1", "u1", "assistant", "reply"),
    // An edit of the first prompt starts a new root; that is a branch, not a gap.
    message("u1b", null, "user", "edited first"),
    message("a1b", "u1b", "assistant", "new reply"),
  ];
  const before = JSON.stringify(entries);
  assert.equal(relinkDanglingEntries(entries), 0);
  assert.equal(JSON.stringify(entries), before);
});

test("does not relink into a loop", () => {
  const entries = [
    header("/tmp"),
    message("b", "a", "assistant", "points forward"),
    message("a", "missing", "user", "dangling"),
  ];
  // Relinking `a` to `b` would close a -> b -> a.
  assert.equal(relinkDanglingEntries(entries), 0);
  assert.equal(entries[2].parentId, "missing");
});

test("a repaired file reopens with its whole branch in the SDK", async () => {
  await withDir(async (dir) => {
    const file = join(dir, "session.jsonl");
    await writeFile(file, lines(gapped(dir)));
    assert.equal(SessionManager.open(file, undefined, dir).getBranch().length, 2);

    assert.equal(repairTranscriptFile(file), 1);
    const ids = SessionManager.open(file, undefined, dir).getBranch().map((entry) => entry.id);
    assert.deepEqual(ids, ["u1", "a1", "u2", "a2", "a3", "u4"]);
    // Nothing left to do the second time round.
    assert.equal(repairTranscriptFile(file), 0);
  });
});

test("repair rewrites only the relinked lines and keeps malformed ones", async () => {
  await withDir(async (dir) => {
    const file = join(dir, "session.jsonl");
    const entries = gapped(dir);
    const raw = entries.map((entry) => JSON.stringify(entry));
    raw.splice(3, 0, "{not json");
    await writeFile(file, `${raw.join("\n")}\n`);

    assert.equal(repairTranscriptFile(file), 1);
    const after = (await readFile(file, "utf8")).split("\n");
    assert.equal(after.length, raw.length + 1);
    raw.forEach((line, index) => {
      if (line.includes('"id":"a3"')) assert.equal(JSON.parse(after[index]).parentId, "a2");
      else assert.equal(after[index], line);
    });
    assert.deepEqual((await readdir(dir)).sort(), ["session.jsonl"]);
  });
});

test("repair leaves missing and headerless files untouched", async () => {
  await withDir(async (dir) => {
    assert.equal(repairTranscriptFile(join(dir, "absent.jsonl")), 0);
    const file = join(dir, "foreign.jsonl");
    const raw = lines([message("a3", "u3", "assistant", "no header")]);
    await writeFile(file, raw);
    assert.equal(repairTranscriptFile(file), 0);
    assert.equal(await readFile(file, "utf8"), raw);
  });
});

test("conversation search reads a gapped transcript's whole branch without writing", async () => {
  await withDir(async (dir) => {
    const file = join(dir, "session.jsonl");
    const raw = lines(gapped(dir));
    await writeFile(file, raw);
    const branch = await loadConversationTranscriptBranch(file, dir);
    assert.equal(branch.length, 6);
    assert.equal(await readFile(file, "utf8"), raw);
  });
});

test("writeTranscriptEntries replaces the file and leaves no temporary behind", async () => {
  await withDir(async (dir) => {
    const file = join(dir, "session.jsonl");
    await writeFile(file, "stale\n");
    const entries = [header(dir), message("u1", null, "user", "hello")];
    writeTranscriptEntries(file, entries);
    assert.equal(await readFile(file, "utf8"), lines(entries));
    assert.deepEqual(await readdir(dir), ["session.jsonl"]);
  });
});

test("writeTranscriptEntries keeps the old file when serialising fails", async () => {
  await withDir(async (dir) => {
    const file = join(dir, "session.jsonl");
    const original = lines([header(dir), message("u1", null, "user", "kept")]);
    await writeFile(file, original);
    const circular: Record<string, unknown> = { type: "custom", id: "c", parentId: "u1" };
    circular.self = circular;
    assert.throws(() => writeTranscriptEntries(file, [header(dir), circular]));
    assert.equal(await readFile(file, "utf8"), original);
    assert.deepEqual(await readdir(dir), ["session.jsonl"]);
  });
});
