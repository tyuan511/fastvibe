import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ConversationCatalog } from "../src/main/engine/conversation-catalog.ts";
import type { WorkspaceSnapshot } from "../src/shared/types.ts";

/**
 * The catalog's change notice — what every client's conversation list now rides on.
 *
 * Before this existed the list was read once per client, at connect, and never again: a
 * chat created on the desktop never appeared on the phone, a delete left a row that
 * opened nothing, and two desktop windows drifted apart the same way. Each of those
 * looks like the app working until somebody notices a list that is simply wrong.
 *
 * So the notice hangs off the same funnel as the disk write, and these are the
 * properties that makes true: it fires for every kind of mutation, it coalesces the way
 * the write does, it carries the active conversation, and it never describes a state
 * older than the file.
 */

function catalog(): { catalog: ConversationCatalog; file: string; seen: WorkspaceSnapshot[] } {
  const dir = mkdtempSync(join(tmpdir(), "fastvibe-catalog-"));
  const file = join(dir, "conversations.json");
  const instance = new ConversationCatalog(file, join(dir, "scratch"));
  const seen: WorkspaceSnapshot[] = [];
  instance.onChange = (snapshot) => seen.push(snapshot);
  return { catalog: instance, file, seen };
}

/** Let the 40ms write debounce fire. */
function settle(): Promise<void> {
  return new Promise((done) => setTimeout(done, 80));
}

test("creating a conversation announces a snapshot that holds it", async () => {
  const { catalog: cat, seen } = catalog();
  const created = cat.create(undefined);
  await settle();
  assert.equal(seen.length, 1);
  assert.deepEqual(
    seen[0].conversations.map((item) => item.id),
    [created.id],
  );
  // The active conversation travels with the list. It is the half that lets another
  // client follow along rather than only learning that *something* changed.
  assert.equal(seen[0].activeId, created.id);
});

test("several mutations in one action announce once, not once each", async () => {
  const { catalog: cat, seen } = catalog();
  // What "switch this chat to a project" actually does: a handful of writes in a row.
  const created = cat.create(undefined);
  cat.ensureProject("/tmp/demo");
  cat.setProject(created.id, "/tmp/demo");
  cat.update(created.id, { title: "renamed" });
  await settle();
  assert.equal(seen.length, 1, "the write debounce has to coalesce the notice too");
  assert.equal(seen[0].conversations[0].title, "renamed");
  assert.deepEqual(
    seen[0].projects.map((project) => project.cwd),
    ["/tmp/demo"],
  );
});

test("a delete is announced, so no client keeps a row that opens nothing", async () => {
  const { catalog: cat, seen } = catalog();
  const created = cat.create(undefined);
  await settle();
  cat.remove(created.id);
  await settle();
  assert.equal(seen.length, 2);
  assert.deepEqual(seen[1].conversations, []);
});

test("switching the active conversation alone is announced", async () => {
  const { catalog: cat, seen } = catalog();
  const first = cat.create(undefined);
  const second = cat.create(undefined);
  await settle();
  seen.length = 0;
  cat.setActive(first.id);
  await settle();
  assert.equal(seen.length, 1);
  assert.equal(seen[0].activeId, first.id);
  // Re-setting the id already active writes nothing, which is what keeps a client's
  // own `conversations.open` from bouncing back and forth with the push: it follows by
  // calling open, and open's `setActive` is then a no-op that announces nothing.
  seen.length = 0;
  cat.setActive(first.id);
  await settle();
  assert.equal(seen.length, 0);
  assert.notEqual(first.id, second.id);
});

test("the notice never describes a state older than the file", async () => {
  const { catalog: cat, file, seen } = catalog();
  let onDisk: string | null = null;
  cat.onChange = (snapshot) => {
    seen.push(snapshot);
    onDisk = readFileSync(file, "utf8");
  };
  const created = cat.create(undefined, undefined, { title: "written first" });
  await settle();
  // A client that re-reads anything from disk in response to this push must not be
  // handed the previous state; announcing before the write would do exactly that.
  assert.match(onDisk ?? "", /written first/);
  assert.match(onDisk ?? "", new RegExp(created.id));
});

test("flush announces without waiting for the debounce", () => {
  const { catalog: cat, seen } = catalog();
  cat.create(undefined);
  assert.equal(seen.length, 0, "still inside the debounce window");
  // Shutdown path: the pending write is forced out, and the notice goes with it rather
  // than being dropped along with the timer.
  cat.flush();
  assert.equal(seen.length, 1);
});
