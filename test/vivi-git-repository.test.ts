// SPDX-License-Identifier: MIT
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { test } from "node:test";
import { ManagedGitRepository, type GitCommitInput, type GitCommitSnapshot } from "../src/main/bot/shadow/git-repository.ts";

const exec = promisify(execFile);
const ref = "refs/heads/vivi/test" as const;
const author = { name: "Vivi Test", email: "vivi@example.invalid" };
const timestamp = "2026-01-02T03:04:05Z";
const message = "Apply immutable snapshot";
const failure = { message: "Managed Git operation rejected or unconfirmed" };
async function git(directory: string, ...args: string[]): Promise<string> {
  return (await exec("/usr/bin/git", ["-C", directory, ...args], { env: {
    PATH: "/usr/bin:/bin", HOME: directory, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_AUTHOR_NAME: author.name, GIT_AUTHOR_EMAIL: author.email, GIT_COMMITTER_NAME: author.name,
    GIT_COMMITTER_EMAIL: author.email, GIT_AUTHOR_DATE: timestamp, GIT_COMMITTER_DATE: timestamp,
  } })).stdout.trim();
}
async function fixture(t: { after: (fn: () => Promise<void>) => void }) {
  // macOS tmpdir can itself be a symlink; the port deliberately requires canonical paths.
  const { realpath } = await import("node:fs/promises");
  const root = await realpath(await mkdtemp(join(tmpdir(), "vivi-git-test-")));
  t.after(() => rm(root, { recursive: true, force: true }));
  const directory = join(root, "work"), remote = join(root, "remote.git");
  await mkdir(directory); await mkdir(remote);
  await git(directory, "init", "-b", "main"); await git(remote, "init", "--bare");
  await writeFile(join(directory, "original.txt"), "parent contents\n");
  await git(directory, "add", "original.txt"); await git(directory, "commit", "-m", "Initial");
  const parentSha = await git(directory, "rev-parse", "HEAD");
  await git(directory, "update-ref", ref, parentSha);
  const repository = new ManagedGitRepository({ directory, ref, remote, localTest: true });
  const input: GitCommitInput = { parentSha, changes: [{ path: "new.txt", content: "snapshot\n" }], message, author, timestamp };
  return { root, directory, remote, parentSha, repository, input };
}

test("deterministic private index creates objects without changing HEAD, workspace, index or ref", async t => {
  const f = await fixture(t);
  const index = await readFile(join(f.directory, ".git/index"));
  const first = await f.repository.prepareCommit(f.input), second = await f.repository.prepareCommit(f.input);
  assert.deepEqual(first, second);
  assert.equal(await git(f.directory, "rev-parse", "HEAD"), f.parentSha);
  assert.equal(await git(f.directory, "rev-parse", ref), f.parentSha);
  assert.deepEqual(await readFile(join(f.directory, ".git/index")), index);
  await assert.rejects(readFile(join(f.directory, "new.txt")));
  assert.equal(await f.repository.inspectCommit(first), false);
  await f.repository.commitExact(first);
  assert.equal(await f.repository.inspectCommit(first), true);
  await f.repository.commitExact(first);
  assert.equal(await git(f.directory, "show", `${first.sha}:new.txt`), "snapshot");
});

test("delete uses private index even when workspace file exists; executable mode is exact", async t => {
  const f = await fixture(t);
  const snapshot = await f.repository.prepareCommit({ ...f.input, changes: [
    { path: "original.txt", content: null }, { path: "run.sh", content: "echo test\n", mode: "100755" },
  ] });
  assert.equal(await readFile(join(f.directory, "original.txt"), "utf8"), "parent contents\n");
  assert.equal(await git(f.directory, "ls-tree", snapshot.tree, "original.txt"), "");
  assert.match(await git(f.directory, "ls-tree", snapshot.tree, "run.sh"), /^100755 blob /);
});

test("commit compares all metadata and rejects ref drift via CAS", async t => {
  const f = await fixture(t), snapshot = await f.repository.prepareCommit(f.input);
  const variants: GitCommitSnapshot[] = [
    { ...snapshot, tree: f.parentSha }, { ...snapshot, parentSha: snapshot.sha },
    { ...snapshot, timestamp: "2026-01-02T03:04:06Z" }, { ...snapshot, message: "other" },
    { ...snapshot, author: { ...author, name: "other" } }, { ...snapshot, ref: "refs/heads/vivi/other" },
  ];
  for (const variant of variants) {
    await assert.rejects(f.repository.commitExact(variant), failure);
    assert.equal(await f.repository.inspectCommit(variant), false);
  }
  const sibling = await f.repository.prepareCommit({ ...f.input, message: "Sibling" });
  await f.repository.commitExact(sibling);
  await assert.rejects(f.repository.commitExact(snapshot), failure);
  assert.equal(await f.repository.inspectCommit(snapshot), false);
  await f.repository.commitExact(sibling);
});

test("hooks are disabled and inherited Git environment cannot redirect index or repository", async t => {
  const f = await fixture(t), marker = join(f.root, "hook-ran");
  await writeFile(join(f.directory, ".git/hooks/reference-transaction"), `#!/bin/sh\ntouch '${marker}'\n`, { mode: 0o755 });
  const old = process.env.GIT_INDEX_FILE;
  process.env.GIT_INDEX_FILE = join(f.root, "leaked-index");
  try { const snapshot = await f.repository.prepareCommit(f.input); await f.repository.commitExact(snapshot); }
  finally { if (old === undefined) delete process.env.GIT_INDEX_FILE; else process.env.GIT_INDEX_FILE = old; }
  await assert.rejects(readFile(marker)); await assert.rejects(readFile(join(f.root, "leaked-index")));
});

test("local push uses exact lease, refuses moved remote, and refuses non-descendant target", async t => {
  const f = await fixture(t);
  assert.equal(await f.repository.remoteRef(), null);
  const first = await f.repository.prepareCommit(f.input); await f.repository.commitExact(first);
  await f.repository.pushExact({ sha: first.sha, expectedRemoteSha: null });
  assert.equal(await f.repository.remoteRef(), first.sha);
  const second = await f.repository.prepareCommit({ ...f.input, parentSha: first.sha, message: "Second" });
  await f.repository.commitExact(second);
  await assert.rejects(f.repository.pushExact({ sha: second.sha, expectedRemoteSha: f.parentSha }), failure);
  await f.repository.pushExact({ sha: second.sha, expectedRemoteSha: first.sha });
  assert.equal(await f.repository.remoteRef(), second.sha);
  await git(f.directory, "update-ref", ref, f.parentSha);
  await assert.rejects(f.repository.pushExact({ sha: f.parentSha, expectedRemoteSha: second.sha }), failure);
  assert.equal(await f.repository.remoteRef(), second.sha);
  await assert.rejects(f.repository.pushExact({ sha: first.sha, expectedRemoteSha: second.sha }), failure);
});

test("snapshot paths, runtime modes, duplicates and unsafe refs are rejected", async t => {
  const f = await fixture(t);
  for (const path of ["../escape", "/absolute", "a/../b", "a//b", ".git/config", "a/.GiT/config", ".gitmodules", "a/.gitattributes", "a\\b", "x\ny", ":(glob)*"]) {
    await assert.rejects(f.repository.prepareCommit({ ...f.input, changes: [{ path, content: "text" }] }), failure);
  }
  await assert.rejects(f.repository.prepareCommit({ ...f.input, changes: [{ path: "x", content: "a", mode: "120000" as "100644" }] }), failure);
  await assert.rejects(f.repository.prepareCommit({ ...f.input, changes: [{ path: "x", content: "a" }, { path: "x", content: null }] }), failure);
  for (const suffix of ["../a", "a..b", "a@{b", "a.lock", "a.lock/b", "a/.", "a//b", "a."]) {
    assert.throws(() => new ManagedGitRepository({ directory: f.directory, remote: f.remote, ref: `refs/heads/vivi/${suffix}`, localTest: true }), failure);
  }
});

test("only explicit Github HTTPS remote or canonical local-test directory is allowed; identity is immutable", async t => {
  const f = await fixture(t);
  for (const remote of ["git@github.com:acme/repo.git", "file:///tmp/repo", "https://u:p@github.com/acme/repo.git", "https://github.com/acme/repo.git?x=1", "https://other/acme/repo.git", "--upload-pack=evil"]) {
    assert.throws(() => new ManagedGitRepository({ directory: f.directory, ref, remote, credentials: async () => ({ username: "u", password: "p" }) }), failure);
  }
  assert.equal(f.repository.directory, f.directory); assert.equal(f.repository.remote, f.remote); assert.equal(f.repository.ref, ref);
  assert.throws(() => Object.assign(f.repository, { remote: "/other" }), TypeError);
});

test("unsafe local configuration is rejected without leaking raw values", async t => {
  for (const [key, value] of [["http.proxy", "http://private.invalid/token-value"], ["http.extraHeader", "Authorization: sensitive-value"],
    ["url.https://private.invalid/.insteadOf", "https://github.com/"], ["include.path", "/private/not-readable"], ["credential.helper", "!touch should-not-run"]]) {
    const f = await fixture(t); await git(f.directory, "config", "--local", key!, value!);
    await assert.rejects(f.repository.prepareCommit(f.input), failure);
    assert.equal(await f.repository.inspectCommit({ sha: f.parentSha } as GitCommitSnapshot), false);
  }
});

test("symlink/shared Git directories, external config, alternates and replacement objects are rejected", async t => {
  for (const kind of ["directory", "config", "alternates", "commondir", "replace", "gitfile", "remote"]) {
    const f = await fixture(t);
    if (kind === "directory") {
      const alias = join(f.root, "alias"); await symlink(f.directory, alias);
      const repo = new ManagedGitRepository({ directory: alias, remote: f.remote, ref, localTest: true });
      await assert.rejects(repo.prepareCommit(f.input), failure); continue;
    }
    if (kind === "config") {
      const config = join(f.directory, ".git/config"), external = join(f.root, "external-config");
      await writeFile(external, await readFile(config)); await rm(config); await symlink(external, config);
    }
    if (kind === "alternates") await writeFile(join(f.directory, ".git/objects/info/alternates"), "/private/objects\n");
    if (kind === "commondir") await writeFile(join(f.directory, ".git/commondir"), "../elsewhere\n");
    if (kind === "replace") await mkdir(join(f.directory, ".git/refs/replace"));
    if (kind === "gitfile") { await rm(join(f.directory, ".git"), { recursive: true }); await writeFile(join(f.directory, ".git"), "gitdir: /private/git\n"); }
    if (kind === "remote") {
      const alias = join(f.root, "remote-alias.git"); await symlink(f.remote, alias);
      const repo = new ManagedGitRepository({ directory: f.directory, remote: alias, ref, localTest: true });
      await assert.rejects(repo.prepareCommit(f.input), failure); continue;
    }
    await assert.rejects(f.repository.prepareCommit(f.input), failure);
  }
});

test("Stop during credentials await fences push before any network process and hides credential exceptions", async t => {
  const f = await fixture(t), snapshot = await f.repository.prepareCommit(f.input); await f.repository.commitExact(snapshot);
  let started!: () => void, release!: (c: { username: string; password: string }) => void;
  const waiting = new Promise<void>(resolve => { started = resolve; });
  const credentials = new Promise<{ username: string; password: string }>(resolve => { release = resolve; });
  const repo = new ManagedGitRepository({ directory: f.directory, ref, remote: "https://github.com/acme/widget.git", credentials: () => { started(); return credentials; } });
  const controller = new AbortController(); let validations = 0;
  const pending = repo.pushExact({ sha: snapshot.sha, expectedRemoteSha: null }, { signal: controller.signal, validate: () => { validations++; } });
  await waiting; const before = validations; controller.abort(); release({ username: "fake-user", password: "fake-private-token" });
  await assert.rejects(pending, failure); assert.ok(before > 0);
  const bad = new ManagedGitRepository({ directory: f.directory, ref, remote: "https://github.com/acme/widget.git", credentials: async () => { throw new Error("fake-private-token"); } });
  await assert.rejects(bad.remoteRef(), failure);
});

test("prepare and each write honor synchronous fencing; cancelled inspection is false", async t => {
  const f = await fixture(t);
  let calls = 0;
  await assert.rejects(f.repository.prepareCommit(f.input, { validate: () => { if (++calls === 1) throw new Error("sensitive fence details"); } }), failure);
  assert.equal(await git(f.directory, "rev-parse", ref), f.parentSha);
  const snapshot = await f.repository.prepareCommit(f.input);
  await assert.rejects(f.repository.commitExact(snapshot, { validate: () => { throw new Error("private fence"); } }), failure);
  assert.equal(await f.repository.inspectCommit(snapshot), false);
  const controller = new AbortController(); controller.abort();
  assert.equal(await f.repository.inspectCommit(snapshot, { signal: controller.signal }), false);
  await assert.rejects(f.repository.prepareCommit(f.input, { validate: (() => Promise.resolve()) as unknown as () => void }), failure);
});

test("symbolic managed refs cannot redirect commit or push to main", async t => {
  const f = await fixture(t), snapshot = await f.repository.prepareCommit(f.input);
  await git(f.directory, "symbolic-ref", ref, "refs/heads/main");
  await assert.rejects(f.repository.commitExact(snapshot), failure);
  assert.equal(await f.repository.inspectCommit(snapshot), false);
  assert.equal(await git(f.directory, "rev-parse", "refs/heads/main"), f.parentSha);
  await git(f.directory, "update-ref", "--no-deref", ref, f.parentSha);
  await f.repository.commitExact(snapshot);
  // The test bare endpoint is trusted, but aliases in its advertised refs are rejected too.
  await git(f.directory, "push", f.remote, `${snapshot.sha}:refs/heads/main`);
  await git(f.remote, "symbolic-ref", ref, "refs/heads/main");
  await assert.rejects(f.repository.remoteRef(), failure);
  await assert.rejects(f.repository.pushExact({ sha: snapshot.sha, expectedRemoteSha: snapshot.sha }), failure);
  assert.equal(await git(f.remote, "rev-parse", "refs/heads/main"), snapshot.sha);
});
