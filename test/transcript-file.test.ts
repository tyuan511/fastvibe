import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import {
  closeOrphanToolCalls,
  relinkDanglingEntries,
  repairTranscriptFile,
  writeTranscriptEntries,
} from "../src/main/engine/transcript-file.ts";
import { canResumeRun } from "../src/main/engine/resume.ts";
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

function toolTurn(calls: string[], stopReason = "toolUse"): Record<string, unknown> {
  return {
    type: "message",
    id: "a1",
    parentId: "u1",
    timestamp,
    message: {
      role: "assistant",
      content: calls.map((id) => ({ type: "toolCall", id, name: "bash", arguments: {} })),
      stopReason,
      timestamp: Date.parse(timestamp),
    },
  };
}

function toolResult(id: string, parentId: string, callId: string): Record<string, unknown> {
  return {
    type: "message",
    id,
    parentId,
    timestamp,
    message: { role: "toolResult", toolCallId: callId, toolName: "bash", content: [{ type: "text", text: "ok" }], isError: false, timestamp: 1 },
  };
}

const note = (tool: string): string => `interrupted ${tool}`;

test("an unanswered tool call is closed with an error result the session can resume from", async () => {
  await withDir(async (dir) => {
    const file = join(dir, "session.jsonl");
    await writeFile(file, lines([header(dir), message("u1", null, "user", "run it"), toolTurn(["c1"])]));
    assert.equal(SessionManager.open(file, undefined, dir).buildSessionContext().messages.at(-1)?.role, "assistant");

    assert.equal(closeOrphanToolCalls(file, note), 1);
    const messages = SessionManager.open(file, undefined, dir).buildSessionContext().messages;
    const last = messages.at(-1) as unknown as { role: string; toolCallId: string; isError: boolean; content: Array<{ text: string }> };
    assert.equal(last.role, "toolResult");
    assert.equal(last.toolCallId, "c1");
    assert.equal(last.isError, true);
    assert.equal(last.content[0].text, "interrupted bash");
    assert.equal(canResumeRun(messages), true);
    // Nothing left to close the second time round.
    assert.equal(closeOrphanToolCalls(file, note), 0);
  });
});

test("only the calls with no result are closed, chained after the leaf", async () => {
  await withDir(async (dir) => {
    const file = join(dir, "session.jsonl");
    await writeFile(file, lines([header(dir), message("u1", null, "user", "run"), toolTurn(["c1", "c2", "c3"]), toolResult("r1", "a1", "c2")]));
    assert.equal(closeOrphanToolCalls(file, note), 2);
    const branch = SessionManager.open(file, undefined, dir).getBranch();
    assert.deepEqual(branch.slice(0, 4).map((entry) => entry.id), ["u1", "a1", "r1", branch[3].id]);
    const closed = branch.slice(3).map((entry) => (entry as unknown as { message: { toolCallId: string } }).message.toolCallId);
    assert.deepEqual(closed, ["c1", "c3"]);
    assert.equal(new Set(branch.map((entry) => entry.id)).size, branch.length);
  });
});

test("calls that were answered, interrupted by the user, or never ran are left alone", async () => {
  await withDir(async (dir) => {
    const answered = join(dir, "answered.jsonl");
    await writeFile(answered, lines([header(dir), message("u1", null, "user", "run"), toolTurn(["c1"]), toolResult("r1", "a1", "c1")]));
    assert.equal(closeOrphanToolCalls(answered, note), 0);

    // The user spoke after the tool request: the projection already treats that as interrupted.
    const followed = join(dir, "followed.jsonl");
    await writeFile(followed, lines([header(dir), message("u1", null, "user", "run"), toolTurn(["c1"]), message("u2", "a1", "user", "never mind")]));
    assert.equal(closeOrphanToolCalls(followed, note), 0);

    // A reply that stopped on an error never ran its tools; continuing drops it.
    const failed = join(dir, "failed.jsonl");
    await writeFile(failed, lines([header(dir), message("u1", null, "user", "run"), toolTurn(["c1"], "error")]));
    const before = await readFile(failed, "utf8");
    assert.equal(closeOrphanToolCalls(failed, note), 0);
    assert.equal(await readFile(failed, "utf8"), before);
  });
});

test("closing orphans keeps every existing line and tolerates missing or headerless files", async () => {
  await withDir(async (dir) => {
    const file = join(dir, "session.jsonl");
    const raw = [header(dir), message("u1", null, "user", "run"), toolTurn(["c1"])].map((entry) => JSON.stringify(entry));
    raw.splice(1, 0, "{not json");
    await writeFile(file, raw.join("\n"));
    assert.equal(closeOrphanToolCalls(file, note), 1);
    const after = (await readFile(file, "utf8")).split("\n");
    assert.deepEqual(after.slice(0, raw.length), raw);
    assert.equal(after.length, raw.length + 2);
    assert.deepEqual((await readdir(dir)).sort(), ["session.jsonl"]);

    assert.equal(closeOrphanToolCalls(join(dir, "absent.jsonl"), note), 0);
    const foreign = join(dir, "foreign.jsonl");
    await writeFile(foreign, lines([toolTurn(["c1"])]));
    assert.equal(closeOrphanToolCalls(foreign, note), 0);
  });
});
