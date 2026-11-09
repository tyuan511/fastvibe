// SPDX-License-Identifier: MIT
// Fixed-argv Git host port; this boundary is not an OS sandbox.
import { spawn } from "node:child_process";
import { lstat, mkdtemp, readFile, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";

export interface ManagedGitRepositoryOptions {
  directory: string;
  ref: `refs/heads/dsh/${string}`;
  remote: string;
  localTest?: true;
  credentials?: () => Promise<{ username: string; password: string }>;
}
export interface GitCommitInput {
  parentSha: string;
  changes: Array<{ path: string; content: string | null; mode?: "100644" | "100755" }>;
  message: string;
  author: { name: string; email: string };
  timestamp: string;
}
export interface GitCommitSnapshot {
  sha: string; tree: string; parentSha: string; ref: string;
  message: string; author: { name: string; email: string }; timestamp: string;
}
export interface GitFenceOptions { signal?: AbortSignal; validate?: () => void }
const failure = () => new Error("Managed Git operation rejected or unconfirmed");
const shaPattern = /^[0-9a-f]{40}$/;
const check = (ok: unknown): void => { if (!ok) throw failure(); };
const sha = (value: string): void => check(typeof value === "string" && shaPattern.test(value));
const fence = (options: GitFenceOptions): void => {
  options.signal?.throwIfAborted();
  check(options.validate?.() === undefined);
  options.signal?.throwIfAborted();
};
const exists = async (path: string): Promise<boolean> => {
  try { await lstat(path); return true; } catch (e) { if ((e as NodeJS.ErrnoException).code === "ENOENT") return false; throw e; }
};

export class ManagedGitRepository {
  readonly directory: string;
  readonly ref: string;
  readonly remote: string;
  private readonly local: boolean;
  private readonly credentials?: ManagedGitRepositoryOptions["credentials"];
  constructor(options: ManagedGitRepositoryOptions) {
    this.directory = resolve(options.directory); this.ref = options.ref; this.remote = options.remote;
    this.local = options.localTest === true; this.credentials = options.credentials;
    check(/^refs\/heads\/dsh\/[A-Za-z0-9_/-]+(?:[.][A-Za-z0-9_/-]+)*$/.test(this.ref)
      && !this.ref.endsWith("/") && !this.ref.includes("//") && !this.ref.includes("..")
      && this.ref.split("/").every(part => !part.startsWith(".") && !part.endsWith(".") && !part.endsWith(".lock")));
    check(this.local ? isAbsolute(this.remote) && this.remote === resolve(this.remote) && !/[\x00-\x1f\x7f]/.test(this.remote)
      : /^https:\/\/github\.com\/[A-Za-z0-9_-]+\/[A-Za-z0-9_.-]+\.git$/.test(this.remote)
        && !this.remote.endsWith("/..git") && typeof this.credentials === "function");
    for (const key of ["directory", "ref", "remote"] as const) Object.defineProperty(this, key, { writable: false, configurable: false });
  }
  private async session<T>(options: GitFenceOptions, action: (run: (args: string[], input?: string, extra?: Record<string, string>, accept?: number[]) => Promise<{ text: string; code: number }>, home: string) => Promise<T>): Promise<T> {
    let home: string | undefined;
    try {
      fence(options); home = await mkdtemp(join(tmpdir(), "dsh-managed-git-"));
      const env = { PATH: "/usr/bin:/bin", TMPDIR: home, TMP: home, HOME: home, XDG_CONFIG_HOME: home,
        GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_SYSTEM: "/dev/null", GIT_NO_REPLACE_OBJECTS: "1",
        GIT_TERMINAL_PROMPT: "0", GIT_ASKPASS: "/usr/bin/false", GIT_PROTOCOL_FROM_USER: "0", LC_ALL: "C" };
      const run = async (args: string[], input?: string, extra?: Record<string, string>, accept = [0]): Promise<{ text: string; code: number }> => {
        fence(options);
        return new Promise((resolveResult, reject) => {
          const child = spawn("/usr/bin/git", ["--literal-pathspecs", "-C", this.directory,
            "-c", "core.hooksPath=/dev/null", "-c", "credential.helper=", "-c", "commit.gpgsign=false", "-c", "tag.gpgsign=false",
            "-c", "credential.useHttpPath=true", "-c", "http.followRedirects=false", "-c", "http.sslVerify=true",
            "-c", "protocol.allow=never", "-c", `protocol.${this.local ? "file" : "https"}.allow=always`, ...args],
          { env: { ...env, ...extra }, shell: false, detached: true, stdio: ["pipe", "pipe", "pipe"] });
          let text = "", failed = false;
          const terminate = () => {
            failed = true;
            // Git may have started an HTTPS/file transport child. Stop the process group.
            try { if (child.pid) process.kill(-child.pid, "SIGKILL"); else child.kill("SIGKILL"); }
            catch { child.kill("SIGKILL"); }
          };
          const timer = setTimeout(terminate, 30_000);
          options.signal?.addEventListener("abort", terminate, { once: true });
          if (options.signal?.aborted) terminate();
          child.stdout.setEncoding("utf8");
          child.stdout.on("data", (chunk: string) => {
            if (failed) return;
            text += chunk;
            if (text.length > 16 * 1024 * 1024) terminate();
          });
          child.stderr.resume(); child.stdin.on("error", () => { failed = true; });
          child.on("error", () => { failed = true; });
          // Abort/error waits for close: callers never observe completion before Git exits.
          child.on("close", code => {
            clearTimeout(timer); options.signal?.removeEventListener("abort", terminate);
            !failed && accept.includes(code ?? -1) ? resolveResult({ text, code: code! }) : reject(failure());
          });
          child.stdin.end(input);
        });
      };
      check(await realpath(this.directory) === this.directory);
      const git = join(this.directory, ".git");
      check((await lstat(git)).isDirectory() && await realpath(git) === git);
      for (const relative of ["config", "objects", "refs", "objects/info", "objects/pack"]) check(!(await lstat(join(git, relative))).isSymbolicLink());
      const refParts = this.ref.split("/");
      for (let count = 2; count <= refParts.length; count++) {
        const part = join(git, ...refParts.slice(0, count));
        if (await exists(part)) check(!(await lstat(part)).isSymbolicLink());
      }
      for (const relative of ["commondir", "gitdir", "objects/info/alternates", "objects/info/http-alternates", "refs/replace", "shallow", "info/grafts"]) check(!await exists(join(git, relative)));
      // Inspect keys without expanding includes. Nothing outside this allowlist reaches Git operations.
      const config = (await run(["config", "--local", "--no-includes", "--null", "--list"])).text;
      for (const entry of config.split("\0").filter(Boolean)) {
        const split = entry.indexOf("\n"), key = entry.slice(0, split), value = entry.slice(split + 1);
        check(split > 0 && /^(?:core\.(?:repositoryformatversion|filemode|bare|logallrefupdates|ignorecase|precomposeunicode)|remote\.origin\.(?:url|fetch))$/.test(key));
        if (key === "remote.origin.url") check(value === this.remote);
        if (key === "remote.origin.fetch") check(value === "+refs/heads/*:refs/remotes/origin/*");
        if (key === "core.bare") check(value === "false");
        if (key === "core.repositoryformatversion") check(value === "0");
      }
      check((await run(["rev-parse", "--is-bare-repository"])).text.trim() === "false");
      const symbolic = await run(["symbolic-ref", "--quiet", this.ref], undefined, undefined, [0, 1]);
      check(symbolic.code === 1);
      check(!(await run(["for-each-ref", "--format=%(refname)", "refs/replace/"])).text.trim());
      if (this.local) {
        check(await realpath(this.remote) === this.remote && (await lstat(this.remote)).isDirectory());
        for (const relative of ["HEAD", "config", "objects", "refs"]) check(!(await lstat(join(this.remote, relative))).isSymbolicLink());
        check((await readFile(join(this.remote, "HEAD"), "utf8")).startsWith("ref: "));
        check((await run(["config", "--file", join(this.remote, "config"), "--no-includes", "--get", "core.bare"])).text.trim() === "true");
      }
      const result = await action(run, home);
      await rm(home, { recursive: true, force: true }); home = undefined;
      fence(options);
      return result;
    } catch { throw failure(); }
    finally { if (home) await rm(home, { recursive: true, force: true }).catch(() => { throw failure(); }); }
  }
  private metadata(snapshot: Omit<GitCommitSnapshot, "sha" | "tree" | "ref">): { date: string; identity: string } {
    check(snapshot.author && [snapshot.author.name, snapshot.author.email].every(v => typeof v === "string" && !!v && v === v.trim() && !/[\x00-\x1f\x7f<>]/.test(v)));
    check(typeof snapshot.message === "string" && !!snapshot.message && !snapshot.message.includes("\0"));
    check(/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.000)?Z$/.test(snapshot.timestamp) && Number.isFinite(Date.parse(snapshot.timestamp)));
    const iso = new Date(snapshot.timestamp).toISOString();
    check(snapshot.timestamp === iso || snapshot.timestamp === iso.replace(".000Z", "Z"));
    return { date: `${Math.floor(Date.parse(snapshot.timestamp) / 1000)} +0000`, identity: `${snapshot.author.name} <${snapshot.author.email}>` };
  }
  private commitText(snapshot: GitCommitSnapshot): string {
    sha(snapshot.sha); sha(snapshot.tree); sha(snapshot.parentSha); check(snapshot.ref === this.ref);
    const { date, identity } = this.metadata(snapshot);
    return `tree ${snapshot.tree}\nparent ${snapshot.parentSha}\nauthor ${identity} ${date}\ncommitter ${identity} ${date}\n\n${snapshot.message.endsWith("\n") ? snapshot.message : snapshot.message + "\n"}`;
  }
  async prepareCommit(input: GitCommitInput, options: GitFenceOptions = {}): Promise<GitCommitSnapshot> {
    input = { ...input, author: { ...input.author }, changes: input.changes.map(change => ({ ...change })) };
    return this.session(options, async (run, home) => {
      sha(input.parentSha); const { date } = this.metadata(input);
      const paths = new Set<string>();
      for (const change of input.changes) {
        check(typeof change.path === "string" && !/[\\\x00-\x1f\x7f:]/.test(change.path) && !isAbsolute(change.path)
          && change.path.split("/").every(p => !!p && p !== "." && p !== ".." && ![".git", ".gitmodules", ".gitattributes"].includes(p.toLowerCase())));
        check(!paths.has(change.path) && (change.content === null || typeof change.content === "string") && (change.mode === undefined || ["100644", "100755"].includes(change.mode)));
        paths.add(change.path);
      }
      check((await run(["cat-file", "-t", input.parentSha])).text.trim() === "commit");
      const env = { GIT_INDEX_FILE: join(home, "index") };
      await run(["read-tree", input.parentSha], undefined, env);
      for (const change of input.changes) {
        if (change.content === null) await run(["update-index", "--force-remove", "--", change.path], undefined, env);
        else {
          const blob = (await run(["hash-object", "-w", "--stdin"], change.content, env)).text.trim(); sha(blob);
          await run(["update-index", "--add", "--cacheinfo", change.mode ?? "100644", blob, change.path], undefined, env);
        }
      }
      const tree = (await run(["write-tree"], undefined, env)).text.trim(); sha(tree);
      const commitEnv = { ...env, GIT_AUTHOR_NAME: input.author.name, GIT_AUTHOR_EMAIL: input.author.email, GIT_COMMITTER_NAME: input.author.name,
        GIT_COMMITTER_EMAIL: input.author.email, GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date };
      const message = input.message.endsWith("\n") ? input.message : input.message + "\n";
      const commit = (await run(["commit-tree", tree, "-p", input.parentSha], message, commitEnv)).text.trim(); sha(commit);
      fence(options);
      return { sha: commit, tree, parentSha: input.parentSha, ref: this.ref, message: input.message, author: { ...input.author }, timestamp: input.timestamp };
    });
  }
  async commitExact(snapshot: GitCommitSnapshot, options: GitFenceOptions = {}): Promise<void> {
    snapshot = { ...snapshot, author: { ...snapshot.author } };
    return this.session(options, async run => {
      const expected = this.commitText(snapshot);
      check((await run(["cat-file", "commit", snapshot.sha])).text === expected);
      const current = await run(["show-ref", "--verify", "--hash", this.ref], undefined, undefined, [0, 1, 128]);
      if (current.code === 0 && current.text.trim() === snapshot.sha) return;
      await run(["update-ref", "--no-deref", this.ref, snapshot.sha, snapshot.parentSha], undefined,
        { GIT_COMMITTER_NAME: snapshot.author.name, GIT_COMMITTER_EMAIL: snapshot.author.email, GIT_COMMITTER_DATE: this.metadata(snapshot).date });
    });
  }
  async inspectCommit(snapshot: GitCommitSnapshot, options: GitFenceOptions = {}): Promise<boolean> {
    try {
      snapshot = { ...snapshot, author: { ...snapshot.author } };
      return await this.session(options, async run => {
      const expected = this.commitText(snapshot);
      return (await run(["cat-file", "commit", snapshot.sha])).text === expected
        && (await run(["show-ref", "--verify", "--hash", this.ref])).text.trim() === snapshot.sha;
    }); } catch { return false; }
  }
  private async auth(options: GitFenceOptions): Promise<Record<string, string>> {
    fence(options);
    if (this.local) return {};
    const credential = await this.credentials!();
    fence(options);
    check(credential && typeof credential.username === "string" && typeof credential.password === "string"
      && !!credential.password && !/[\x00-\x1f\x7f:]/.test(credential.username) && !/[\x00-\x1f\x7f]/.test(credential.password));
    return { GIT_CONFIG_COUNT: "1", GIT_CONFIG_KEY_0: "http.https://github.com/.extraHeader",
      GIT_CONFIG_VALUE_0: `Authorization: Basic ${Buffer.from(`${credential.username}:${credential.password}`).toString("base64")}` };
  }
  async remoteRef(options: GitFenceOptions = {}): Promise<string | null> {
    return this.session(options, async run => {
      const env = await this.auth(options);
      const result = await run(["ls-remote", "--symref", "--refs", "--exit-code", this.remote, this.ref], undefined, env, [0, 2]);
      const text = result.text.trim();
      if (result.code === 2) { check(!text); return null; }
      check(!!text);
      const parts = text.split(/\s+/); check(parts.length === 2 && parts[1] === this.ref); sha(parts[0]!); return parts[0]!;
    });
  }
  async pushExact(input: { sha: string; expectedRemoteSha: string | null }, options: GitFenceOptions = {}): Promise<void> {
    input = { ...input };
    sha(input.sha); if (input.expectedRemoteSha !== null) sha(input.expectedRemoteSha);
    check(await this.remoteRef(options) === input.expectedRemoteSha);
    return this.session(options, async run => {
      sha(input.sha); if (input.expectedRemoteSha !== null) sha(input.expectedRemoteSha);
      check((await run(["cat-file", "-t", input.sha])).text.trim() === "commit");
      check((await run(["show-ref", "--verify", "--hash", this.ref])).text.trim() === input.sha);
      if (input.expectedRemoteSha !== null) await run(["merge-base", "--is-ancestor", input.expectedRemoteSha, input.sha]);
      const env = await this.auth(options);
      await run(["push", "--porcelain", `--force-with-lease=${this.ref}:${input.expectedRemoteSha ?? ""}`, this.remote, `${input.sha}:${this.ref}`], undefined, env);
    });
  }
}
