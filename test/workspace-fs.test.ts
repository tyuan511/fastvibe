import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, existsSync, lstatSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, basename } from "node:path";
import {
  createWorkspaceEntry,
  deleteWorkspaceEntry,
  renameWorkspaceEntry,
  workspaceEntryName,
} from "../src/main/engine/workspace-fs.ts";

/**
 * The file tree's create / rename / delete.
 *
 * These operations remove a directory tree, so the interesting cases are the ones where
 * they must not: outside the project the call names, on the project itself, on the
 * repository, onto a name that is taken, and where a Trash is available but fails.
 */

function workspace(): { cwd: string; file: string; dir: string; nested: string; inside: string } {
  const cwd = mkdtempSync(join(tmpdir(), "fastvibe-ws-"));
  const dir = join(cwd, "src");
  const nested = join(dir, "deep");
  mkdirSync(nested, { recursive: true });
  const file = join(cwd, "README.md");
  writeFileSync(file, "# hi\n");
  const inside = join(nested, "a.ts");
  writeFileSync(inside, "export const a = 1;\n");
  return { cwd, file, dir, nested, inside };
}

test("workspaceEntryName trims and refuses anything that is not one segment", () => {
  assert.equal(workspaceEntryName("  notes.md  "), "notes.md");
  for (const bad of ["", "   ", ".", "..", "a/b", "a\\b", "line\nbreak", "\u0001x"]) {
    assert.throws(() => workspaceEntryName(bad), undefined, `refuses ${JSON.stringify(bad)}`);
  }
  // 255 bytes is what APFS and ext4 agree on; a CJK name counts in bytes, not characters.
  assert.equal(workspaceEntryName("x".repeat(255)), "x".repeat(255));
  assert.throws(() => workspaceEntryName("字".repeat(100)));
  assert.throws(() => workspaceEntryName(undefined));
});

test("createWorkspaceEntry makes an empty file or folder in the directory named", () => {
  const ws = workspace();
  const file = createWorkspaceEntry({ cwd: ws.cwd, path: ws.dir, name: "new.ts", kind: "file" });
  assert.deepEqual(file, { name: "new.ts", path: join(ws.dir, "new.ts"), kind: "file" });
  assert.equal(readFileSync(file.path, "utf8"), "");
  const folder = createWorkspaceEntry({ cwd: ws.cwd, path: ws.dir, name: "assets", kind: "directory" });
  assert.equal(folder.kind, "directory");
  assert.ok(lstatSync(folder.path).isDirectory());
});

test("createWorkspaceEntry writes into the project root, which has a row of its own", () => {
  const ws = workspace();
  const entry = createWorkspaceEntry({ cwd: ws.cwd, path: ws.cwd, name: "CHANGELOG.md", kind: "file" });
  assert.equal(entry.path, join(ws.cwd, "CHANGELOG.md"));
  assert.ok(existsSync(entry.path));
});

test("createWorkspaceEntry refuses a name that is taken, a file as parent, and anything outside", () => {
  const ws = workspace();
  createWorkspaceEntry({ cwd: ws.cwd, path: ws.dir, name: "existing", kind: "file" });
  assert.throws(() => createWorkspaceEntry({ cwd: ws.cwd, path: ws.dir, name: "existing", kind: "file" }));
  // A row that is a file cannot hold anything.
  assert.throws(() => createWorkspaceEntry({ cwd: ws.cwd, path: ws.file, name: "x", kind: "file" }));
  // The project root bounds the call: a sibling checkout is not this tree's business.
  const outside = mkdtempSync(join(tmpdir(), "fastvibe-other-"));
  assert.throws(() => createWorkspaceEntry({ cwd: ws.cwd, path: outside, name: "x", kind: "file" }));
  assert.throws(() => createWorkspaceEntry({ cwd: "", path: ws.dir, name: "x", kind: "file" }));
  assert.equal(existsSync(join(outside, "x")), false);
});

test("renameWorkspaceEntry changes one segment and leaves the content alone", () => {
  const ws = workspace();
  const renamed = renameWorkspaceEntry({ cwd: ws.cwd, path: ws.file, name: "NOTES.md" });
  assert.equal(renamed.path, join(ws.cwd, "NOTES.md"));
  assert.equal(renamed.kind, "file");
  assert.equal(readFileSync(renamed.path, "utf8"), "# hi\n");
  assert.equal(existsSync(ws.file), false);
  // A directory keeps its children, which is why the tree must re-read it.
  const dir = renameWorkspaceEntry({ cwd: ws.cwd, path: ws.dir, name: "lib" });
  assert.equal(dir.kind, "directory");
  assert.ok(existsSync(join(ws.cwd, "lib", "deep", "a.ts")));
  // The same name is not an error: nothing moves and the row stays where it is.
  assert.deepEqual(renameWorkspaceEntry({ cwd: ws.cwd, path: dir.path, name: "lib" }), dir);
});

test("renameWorkspaceEntry will not move a file, overwrite one, or touch the project itself", () => {
  const ws = workspace();
  const renamed = renameWorkspaceEntry({ cwd: ws.cwd, path: ws.inside, name: "b.ts" });
  assert.equal(renamed.path, join(ws.nested, "b.ts"));
  // The same name in the same directory belongs to something else already.
  writeFileSync(join(ws.nested, "c.ts"), "// c\n");
  assert.throws(() => renameWorkspaceEntry({ cwd: ws.cwd, path: join(ws.nested, "b.ts"), name: "c.ts" }));
  assert.ok(existsSync(join(ws.nested, "b.ts")));
  // Renaming the project directory away would leave the pane showing a tree it no longer has.
  assert.throws(() => renameWorkspaceEntry({ cwd: ws.cwd, path: ws.cwd, name: "other" }));
  assert.ok(existsSync(ws.cwd));
  // `.git` is never a row, so this is the guard against a crafted call.
  mkdirSync(join(ws.cwd, ".git"));
  assert.throws(() => renameWorkspaceEntry({ cwd: ws.cwd, path: join(ws.cwd, ".git"), name: "git-old" }));
  assert.ok(existsSync(join(ws.cwd, ".git")));
});

test("deleteWorkspaceEntry removes a file, a folder tree, or whatever the host's Trash took", async () => {
  const ws = workspace();
  await deleteWorkspaceEntry({ cwd: ws.cwd, path: ws.inside });
  assert.equal(existsSync(ws.inside), false);
  assert.ok(existsSync(ws.nested));

  await deleteWorkspaceEntry({ cwd: ws.cwd, path: ws.dir });
  assert.equal(existsSync(ws.dir), false);
  assert.equal(existsSync(ws.nested), false);

  // With a Trash, that is the whole operation: the engine never also unlinks.
  const trash: string[] = [];
  const kept = join(ws.cwd, "README.md");
  await deleteWorkspaceEntry({ cwd: ws.cwd, path: kept, trash: async (path) => { trash.push(path); } });
  assert.deepEqual(trash, [kept]);
  assert.ok(existsSync(kept));
});

test("deleteWorkspaceEntry reports a failed Trash instead of deleting for good", async () => {
  const ws = workspace();
  await assert.rejects(
    deleteWorkspaceEntry({ cwd: ws.cwd, path: ws.file, trash: async () => { throw new Error("no Trash on this volume"); } }),
    /no Trash/,
  );
  assert.ok(existsSync(ws.file));
});

test("deleteWorkspaceEntry is bounded by the project and never deletes it", async () => {
  const ws = workspace();
  const outside = mkdtempSync(join(tmpdir(), "fastvibe-other-"));
  writeFileSync(join(outside, "precious.txt"), "keep");
  await assert.rejects(deleteWorkspaceEntry({ cwd: ws.cwd, path: join(outside, "precious.txt") }));
  assert.ok(existsSync(join(outside, "precious.txt")));
  await assert.rejects(deleteWorkspaceEntry({ cwd: ws.cwd, path: ws.cwd }));
  assert.ok(existsSync(ws.cwd));
  await assert.rejects(deleteWorkspaceEntry({ cwd: ws.cwd, path: join(ws.cwd, "gone.md") }));
  mkdirSync(join(ws.cwd, ".git"));
  await assert.rejects(deleteWorkspaceEntry({ cwd: ws.cwd, path: join(ws.cwd, ".git") }));
  assert.ok(existsSync(join(ws.cwd, ".git")));
});

test("the whole repository is off limits, not just its last segment", async () => {
  const ws = workspace();
  mkdirSync(join(ws.cwd, ".git", "objects"), { recursive: true });
  writeFileSync(join(ws.cwd, ".git", "HEAD"), "ref: refs/heads/main\n");
  for (const target of [join(ws.cwd, ".git", "HEAD"), join(ws.cwd, ".git", "objects")]) {
    assert.throws(() => renameWorkspaceEntry({ cwd: ws.cwd, path: target, name: "kept" }), undefined, target);
    await assert.rejects(deleteWorkspaceEntry({ cwd: ws.cwd, path: target }), undefined, target);
  }
  // `.GIT` is the same directory on the case-insensitive volumes macOS and Windows default to.
  await assert.rejects(deleteWorkspaceEntry({ cwd: ws.cwd, path: join(ws.cwd, ".GIT") }));
  assert.ok(existsSync(join(ws.cwd, ".git", "HEAD")));
});

test("a parent that climbs out of the project is refused", () => {
  const ws = workspace();
  const outside = mkdtempSync(join(tmpdir(), "fastvibe-other-"));
  // `resolve` collapses the `..`, so this is the same refusal by another spelling.
  assert.throws(() => createWorkspaceEntry({ cwd: ws.cwd, path: join(ws.cwd, "..", basename(outside)), name: "x", kind: "file" }));
  assert.throws(() => renameWorkspaceEntry({ cwd: ws.cwd, path: ws.file, name: "../escaped.md" }));
  assert.throws(() => renameWorkspaceEntry({ cwd: ws.cwd, path: join(outside, "anything.ts"), name: "mine" }));
  assert.equal(existsSync(join(ws.cwd, "escaped.md")), false);
});

test("a linked directory inside the project is not a door out of it", () => {
  const ws = workspace();
  const elsewhere = mkdtempSync(join(tmpdir(), "fastvibe-far-"));
  symlinkSync(elsewhere, join(ws.cwd, "link"), "dir");
  // The tree would not list it, so this is the crafted call the resolved check exists for.
  assert.throws(() => createWorkspaceEntry({ cwd: ws.cwd, path: join(ws.cwd, "link"), name: "x.ts", kind: "file" }));
  assert.equal(existsSync(join(elsewhere, "x.ts")), false);
});

test("a rename never replaces what is already at the destination", () => {
  const ws = workspace();
  const full = join(ws.cwd, "full");
  mkdirSync(full);
  writeFileSync(join(full, "keep.ts"), "// keep\n");
  assert.throws(() => renameWorkspaceEntry({ cwd: ws.cwd, path: ws.dir, name: "full" }));
  assert.ok(existsSync(join(full, "keep.ts")));
  assert.ok(existsSync(ws.dir));
  // The case that matters for a file: the agent wrote `NOTES.md` in the meantime.
  writeFileSync(join(ws.cwd, "NOTES.md"), "# written by the agent\n");
  assert.throws(() => renameWorkspaceEntry({ cwd: ws.cwd, path: ws.file, name: "NOTES.md" }));
  assert.equal(readFileSync(join(ws.cwd, "NOTES.md"), "utf8"), "# written by the agent\n");
  assert.ok(existsSync(ws.file));
});

test("a rename that only changes case goes through", () => {
  const ws = workspace();
  // APFS/NTFS are case-insensitive and would read this as a collision with itself; ext4 is
  // case-sensitive and treats it as an ordinary rename. Both must succeed.
  const renamed = renameWorkspaceEntry({ cwd: ws.cwd, path: ws.file, name: "readme.md" });
  assert.equal(readFileSync(renamed.path, "utf8"), "# hi\n");
});

test("a symlink row can be renamed without touching its target", () => {
  const ws = workspace();
  const elsewhere = mkdtempSync(join(tmpdir(), "fastvibe-target-"));
  const target = join(elsewhere, "data.json");
  writeFileSync(target, "{}");
  const link = join(ws.cwd, "data.json");
  symlinkSync(target, link);
  const renamed = renameWorkspaceEntry({ cwd: ws.cwd, path: link, name: "data-copy.json" });
  assert.equal(readFileSync(renamed.path, "utf8"), "{}");
  assert.equal(existsSync(link), false);
  assert.ok(existsSync(target));
});

test("a symlink is deleted as the link, not as what it points at", async () => {
  const ws = workspace();
  const elsewhere = mkdtempSync(join(tmpdir(), "fastvibe-target-"));
  const target = join(elsewhere, "data.json");
  writeFileSync(target, "{}");
  const link = join(ws.cwd, "data.json");
  symlinkSync(target, link);
  await deleteWorkspaceEntry({ cwd: ws.cwd, path: link });
  assert.equal(existsSync(link), false);
  assert.ok(existsSync(target));
});
