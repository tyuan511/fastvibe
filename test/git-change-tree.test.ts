import assert from "node:assert/strict";
import test from "node:test";
import { buildGitChangeTree, flattenGitChangeTree, gitDirectoryPaths } from "../src/renderer/src/lib/git-change-tree.ts";

test("Git tree compacts single-child directory chains but preserves branch points and exact paths", () => {
  const files = ["apps/mobile/lib/chat/message.dart", "apps/mobile/lib/chat/composer.dart", "apps/mobile/lib/screens/chat.dart", "README.md"];
  const tree = buildGitChangeTree(files, (path) => path);
  assert.equal(tree[0].name, "apps/mobile/lib");
  assert.equal(tree[0].kind, "directory");
  if (tree[0].kind !== "directory") return;
  assert.deepEqual(tree[0].children.map((node) => node.name), ["chat", "screens"]);
  assert.equal(tree[0].files.length, 3);
  const chat = tree[0].children[0];
  assert.equal(chat.kind, "directory");
  if (chat.kind !== "directory") return;
  assert.deepEqual(chat.files, ["apps/mobile/lib/chat/composer.dart", "apps/mobile/lib/chat/message.dart"]);
  assert.deepEqual(gitDirectoryPaths(tree), ["apps/mobile/lib", "apps/mobile/lib/chat", "apps/mobile/lib/screens"]);
});

test("visible tree rows retain parent and sibling metadata for keyboard navigation", () => {
  const tree = buildGitChangeTree(["src/a/one.ts", "src/a/two.ts", "src/b/other.ts", "root.ts"], (path) => path);
  const rows = flattenGitChangeTree(tree, new Set(["src/a"]));
  assert.deepEqual(rows.map((row) => [row.node.name, row.depth]), [["src",0], ["a",1], ["b",1], ["other.ts",2], ["root.ts",0]]);
  assert.equal(rows[3].parent, "directory:src/b");
  assert.equal(rows[2].position, 2);
  assert.equal(rows[2].siblings, 2);
  assert.equal(rows[4].position, 2);
  assert.deepEqual(flattenGitChangeTree(tree, new Set(["src"])).map((row) => row.node.name), ["src", "root.ts"]);
});

test("folder operations retain deletion metadata and filenames with spaces instead of rebuilding paths", () => {
  const files = [
    { path: "src/deep/ old.ts ", index: " ", worktree: "D" },
    { path: "src/deep/new.ts", index: "?", worktree: "?" },
  ];
  const root = buildGitChangeTree(files, (file) => file.path)[0];
  assert.equal(root.kind, "directory");
  if (root.kind !== "directory") return;
  assert.deepEqual(root.files, files);
  assert.equal(root.name, "src/deep");
  assert.equal(root.children[0].name, " old.ts ");
});
