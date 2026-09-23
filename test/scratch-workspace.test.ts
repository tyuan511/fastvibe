import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ConversationCatalog } from "../src/main/engine/conversation-catalog.ts";
import { scratchWorkspace } from "../src/main/engine/paths.ts";
import { writeImportedSession } from "../src/main/engine/import/writer.ts";
import type { ImportedSession } from "../src/main/engine/import/types.ts";

function setup(): { dir: string; scratch: string; file: string } {
  const dir = mkdtempSync(join(tmpdir(), "fastvibe-scratch-"));
  const scratch = join(dir, "scratch");
  mkdirSync(scratch);
  return { dir, scratch, file: join(dir, "conversations.json") };
}

function chat(id: string, cwd: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return { id, title: id, cwd, createdAt: 1, updatedAt: 1, ...extra };
}

test("scratchWorkspace stays inside the scratch root", () => {
  assert.equal(scratchWorkspace("/data/scratch", "abc-123"), join("/data/scratch", "abc-123"));
  assert.equal(scratchWorkspace("/data/scratch", "../etc"), join("/data/scratch", "_etc"));
  assert.equal(scratchWorkspace("/data/scratch", ".."), join("/data/scratch", "chat"));
});

test("two unbound chats do not share a directory", () => {
  const { scratch, file } = setup();
  const cat = new ConversationCatalog(file, scratch);
  const first = cat.create(undefined);
  const second = cat.create(undefined);
  assert.equal(first.cwd, join(scratch, first.id));
  assert.equal(second.cwd, join(scratch, second.id));
  assert.notEqual(first.cwd, second.cwd);
  assert.equal(existsSync(first.cwd), true);
  assert.equal(existsSync(second.cwd), true);
});

test("a side chat keeps its parent's scratch directory", () => {
  const { scratch, file } = setup();
  const cat = new ConversationCatalog(file, scratch);
  const parent = cat.create(undefined);
  const side = cat.create(undefined, { cwd: parent.cwd }, { kind: "side-chat", parentId: parent.id, activate: false });
  assert.equal(side.cwd, parent.cwd);
});

test("unbinding a project restores that chat's own scratch directory", () => {
  const { scratch, file } = setup();
  const cat = new ConversationCatalog(file, scratch);
  const created = cat.create("/tmp/demo");
  assert.equal(created.cwd, "/tmp/demo");
  const unbound = cat.setProject(created.id, undefined);
  assert.equal(unbound?.project, undefined);
  assert.equal(unbound?.cwd, join(scratch, created.id));
  assert.equal(existsSync(unbound?.cwd ?? ""), true);
});

test("passing the shared scratch root is rewritten to the per-chat directory", () => {
  const { scratch, file } = setup();
  const cat = new ConversationCatalog(file, scratch);
  const created = cat.create(undefined, { cwd: scratch });
  assert.equal(created.cwd, join(scratch, created.id));
});

test("a catalog that still points every unbound chat at the scratch root is split on load", () => {
  const { scratch, file } = setup();
  writeFileSync(join(scratch, "shared.txt"), "both");
  writeFileSync(file, `${JSON.stringify({
    version: 2,
    conversations: [chat("a", scratch), chat("b", scratch)],
    projects: [],
  }, null, 2)}\n`);
  const cat = new ConversationCatalog(file, scratch);
  const a = cat.get("a");
  const b = cat.get("b");
  assert.equal(a?.cwd, join(scratch, "a"));
  assert.equal(b?.cwd, join(scratch, "b"));
  // Neither chat can claim a file both of them used to see.
  assert.equal(existsSync(join(scratch, "shared.txt")), true);
  assert.equal(existsSync(join(scratch, "a", "shared.txt")), false);
  assert.equal(existsSync(join(scratch, "b", "shared.txt")), false);
});

test("a single chat that owned the shared scratch keeps the files that were there", () => {
  const { scratch, file } = setup();
  writeFileSync(join(scratch, "notes.txt"), "mine");
  writeFileSync(file, `${JSON.stringify({
    version: 2,
    conversations: [
      chat("owner", scratch),
      chat("side", scratch, { kind: "side-chat", parentId: "owner" }),
    ],
    projects: [],
  }, null, 2)}\n`);
  const cat = new ConversationCatalog(file, scratch);
  const owner = cat.get("owner");
  const side = cat.get("side");
  assert.equal(owner?.cwd, join(scratch, "owner"));
  assert.equal(side?.cwd, owner?.cwd);
  assert.equal(readFileSync(join(scratch, "owner", "notes.txt"), "utf8"), "mine");
  assert.equal(existsSync(join(scratch, "notes.txt")), false);
});

test("an imported session with no project gets its own scratch directory", () => {
  const { dir, scratch } = setup();
  const session: ImportedSession = {
    source: "pi",
    sourceId: "src-1",
    title: "Imported",
    cwd: join(dir, "missing-project"),
    createdAt: 1_700_000_000_000,
    updatedAt: 1_700_000_000_000,
    items: [{ kind: "user", text: "hello", at: 1_700_000_000_000 }],
    skipped: [],
  };
  const written = writeImportedSession(session, { sessionsDir: join(dir, "sessions"), scratchDir: scratch });
  assert.equal(written.project, undefined);
  assert.equal(written.cwd, join(scratch, written.sessionId));
  assert.equal(existsSync(written.cwd), true);
  const header = JSON.parse(readFileSync(written.sessionFile, "utf8").split("\n")[0]) as { cwd?: string };
  assert.equal(header.cwd, written.cwd);
});
