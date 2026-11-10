import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { chmod, mkdtemp, mkdir, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { promisify } from "node:util";
import { createReviewSnapshot } from "../src/main/engine/review-snapshot.ts";
import type { ReviewScope } from "../src/shared/review.ts";

const exec = promisify(execFile);
async function repository(t: TestContext) {
  const root = await mkdtemp(join(tmpdir(), "fastvibe-review-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const git = (...args: string[]) => exec("git", ["-C", root, ...args]).then((result) => result.stdout.trim());
  await git("init", "-b", "main");
  await mkdir(join(root, "src"));
  await writeFile(join(root, "src/change.ts"), "const value = 1;\nexport { value };\n");
  await writeFile(join(root, "AGENTS.md"), "Read the engineering contracts.\n");
  await writeFile(join(root, "src/dependency.ts"), "export const dependency = 'original';\n");
  await git("add", ".");
  const commit = () => git("-c", "user.name=Review Test", "-c", "user.email=review@example.com", "commit", "-m", "Snapshot fixture");
  await commit();
  const snapshot = (scope: ReviewScope = "worktree", extra = {}) => createReviewSnapshot({ conversationId: "owner", cwd: root, scope, ...extra }, { id: "review-one", model: "provider/reviewer", thinkingLevel: "high" });
  return { root, git, commit, snapshot };
}

test("worktree capture freezes changed contents and pins unchanged context and repository root", async (t) => {
  const f = await repository(t);
  await writeFile(join(f.root, "src/change.ts"), "const value = 2;\nexport { value };\n");
  await writeFile(join(f.root, "src/new file.ts"), "export const created = true;\n");
  const review = await createReviewSnapshot({ conversationId: "owner", cwd: join(f.root, "src"), scope: "worktree" }, { id: "frozen", model: "p/m", thinkingLevel: "high" });
  assert.equal(review.context.root, await realpath(f.root));
  assert.equal(review.context.model, "p/m");
  assert.match(review.context.target, /^[0-9a-f]{40,64}$/);
  assert.equal(review.context.files.length, 2);
  assert.match(review.task, /\+const value = 2;/);
  await writeFile(join(f.root, "src/change.ts"), "const value = 999;\n");
  await writeFile(join(f.root, "src/dependency.ts"), "export const dependency = 'mutated';\n");
  assert.match((await review.readFile("src/change.ts")).text, /value = 2/);
  assert.match((await review.readFile("src/change.ts", "old")).text, /value = 1/);
  assert.match((await review.readFile("src/dependency.ts")).text, /original/);
  assert.match((await review.readFile("AGENTS.md")).text, /engineering contracts/);
  await assert.rejects(review.readFile("../secret.txt"));
  await assert.rejects(review.readFile(join(f.root, "src/change.ts")));
  await assert.rejects(review.readFile(".git/config"));
  await assert.rejects(review.readFile("src\\change.ts"));
  await assert.rejects(review.readFile("missing.ts"));
});

test("staged capture excludes unstaged edits and remains stable after the index changes", async (t) => {
  const f = await repository(t);
  await writeFile(join(f.root, "src/change.ts"), "const value = 2;\nexport { value };\n");
  await f.git("add", "src/change.ts");
  await writeFile(join(f.root, "src/change.ts"), "const value = 3;\nexport { value };\n");
  const review = await f.snapshot("staged");
  await f.git("add", "src/change.ts");
  assert.match((await review.readFile("src/change.ts")).text, /value = 2/);
  assert.doesNotMatch(review.task, /value = 3/);
  const search = await review.search("value =");
  assert.deepEqual(search.matches.map((item) => item.text), ["const value = 2;"]);
});

test("branch and commit scope resolve immutable revisions instead of reading dirty files", async (t) => {
  const f = await repository(t);
  const base = await f.git("rev-parse", "HEAD");
  await f.git("checkout", "-b", "feature");
  await writeFile(join(f.root, "src/change.ts"), "const value = 4;\nexport { value };\n");
  await f.git("add", "."); await f.commit();
  const target = await f.git("rev-parse", "HEAD");
  await writeFile(join(f.root, "src/change.ts"), "dirty\n");
  const branch = await f.snapshot("branch", { base: "main" });
  const commit = await f.snapshot("commit", { revision: target });
  assert.equal(branch.context.base, base);
  assert.equal(branch.context.comparisonBase, "main");
  assert.equal(branch.context.target, target);
  assert.equal(commit.context.base, base);
  assert.equal(commit.context.target, target);
  assert.match((await branch.readFile("src/change.ts")).text, /value = 4/);
  assert.equal((await commit.readFile("src/change.ts")).text, (await branch.readFile("src/change.ts")).text);
});

test("search uses target context, captured replacements, literal queries and explicit pagination", async (t) => {
  const f = await repository(t);
  await writeFile(join(f.root, "src/change.ts"), "value = first\nvalue = second\nvalue = third\n");
  const review = await f.snapshot();
  const first = await review.readFile("src/change.ts", "new", 1, 2);
  assert.equal(first.totalLines, 3); assert.equal(first.truncated, true);
  const last = await review.readFile("src/change.ts", "new", 3, 2);
  assert.equal(last.text, "3: value = third"); assert.equal(last.truncated, false);
  const matches = await review.search("value =", "src");
  assert.equal(matches.matches.length, 3);
  assert.ok(matches.matches.every((item) => item.path === "src/change.ts"));
  assert.match((await review.search("original")).matches[0].text, /dependency/);
  await assert.rejects(review.search("value\nsecond"));
  await assert.rejects(review.search("x", "../outside"));
});

test("binary, large files and symbolic links are explicit unreviewed coverage", async (t) => {
  const f = await repository(t);
  await writeFile(join(f.root, "binary.dat"), Buffer.from([1, 0, 2]));
  await writeFile(join(f.root, "large.txt"), "a".repeat(1024 * 1024 + 1));
  await symlink("src/change.ts", join(f.root, "link.ts"));
  const review = await f.snapshot();
  assert.equal(review.context.files.length, 3);
  assert.ok(review.context.files.every((file) => Boolean(file.skipped)));
  await assert.rejects(review.readFile("link.ts"));
  const report = review.validateReport({ version: 1, summary: "All files require separate review.", findings: [], coverage: { reviewedPaths: [], unreviewedPaths: [] } });
  assert.equal(report.coverage.unreviewedPaths.length, 3);
  assert.throws(() => review.validateReport({ version: 1, summary: "Wrong coverage", findings: [], coverage: { reviewedPaths: ["binary.dat"], unreviewedPaths: [] } }));
});

test("diff limit excludes large patches explicitly instead of silently clipping input", async (t) => {
  const f = await repository(t);
  await writeFile(join(f.root, "src/change.ts"), `${"large\n".repeat(45_000)}`);
  const review = await f.snapshot();
  assert.ok(review.context.files[0].skipped);
  assert.equal(review.context.files[0].newLines, 0);
  assert.doesNotMatch(review.task, /\+large/);
});

test("first commit and unborn repositories are valid review snapshots", async (t) => {
  const f = await repository(t);
  const first = await f.snapshot("commit");
  assert.equal(first.context.base, "");
  assert.equal(first.context.files.length, 3);
  const emptyRoot = await mkdtemp(join(tmpdir(), "fastvibe-review-unborn-"));
  t.after(() => rm(emptyRoot, { recursive: true, force: true }));
  await exec("git", ["-C", emptyRoot, "init", "-b", "main"]);
  await writeFile(join(emptyRoot, "new.ts"), "new file\n");
  const unborn = await createReviewSnapshot({ conversationId: "owner", cwd: emptyRoot, scope: "worktree" }, { id: "unborn", model: "p/m", thinkingLevel: "high" });
  assert.equal(unborn.context.target, "");
  assert.match((await unborn.readFile("new.ts")).text, /new file/);
});

test("chmod-only changes remain visible in worktree, index and commit snapshots", async (t) => {
  const f = await repository(t);
  await f.git("config", "core.filemode", "true");
  await chmod(join(f.root, "src/change.ts"), 0o755);
  const worktree = await f.snapshot("worktree");
  assert.equal(worktree.context.files[0].oldMode, "100644");
  assert.equal(worktree.context.files[0].newMode, "100755");
  assert.match(worktree.task, /old mode 100644\nnew mode 100755/);
  await f.git("add", "src/change.ts");
  const staged = await f.snapshot("staged");
  assert.equal(staged.context.files[0].oldMode, "100644");
  assert.equal(staged.context.files[0].newMode, "100755");
  assert.match(staged.task, /old mode 100644\nnew mode 100755/);
  await f.commit();
  const committed = await f.snapshot("commit", { instructions: "Check executable permissions." });
  assert.equal(committed.context.instructions, "Check executable permissions.");
  assert.equal(committed.context.files[0].oldMode, "100644");
  assert.equal(committed.context.files[0].newMode, "100755");
  assert.match(committed.task, /old mode 100644\nnew mode 100755/);
  assert.equal(committed.context.files[0].oldLines, committed.context.files[0].newLines);
});

test("an oversized base file cannot be silently represented as a complete reviewed diff", async (t) => {
  const f = await repository(t);
  await writeFile(join(f.root, "src/change.ts"), "x".repeat(1024 * 1024 + 1));
  await f.git("add", "."); await f.commit();
  await writeFile(join(f.root, "src/change.ts"), "small replacement\n");
  const review = await f.snapshot();
  assert.ok(review.context.files[0].skipped);
  const report = review.validateReport({ version: 1, summary: "Base file is too large for complete review.", findings: [], coverage: { reviewedPaths: [], unreviewedPaths: [] } });
  assert.equal(report.coverage.unreviewedPaths[0].path, "src/change.ts");
  assert.throws(() => review.validateReport({ version: 1, summary: "Wrong coverage", findings: [], coverage: { reviewedPaths: ["src/change.ts"], unreviewedPaths: [] } }));
});

test("same commit with different worktree contents produces a different snapshot digest", async (t) => {
  const f = await repository(t);
  await writeFile(join(f.root, "src/change.ts"), "one\n");
  const first = await f.snapshot();
  await writeFile(join(f.root, "src/change.ts"), "two\n");
  const second = await f.snapshot();
  assert.equal(first.context.target, second.context.target);
  assert.notEqual(first.context.digest, second.context.digest);
});
