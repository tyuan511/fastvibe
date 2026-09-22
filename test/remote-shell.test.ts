import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { downloadHelpers, loginEnvironment, loginEnvProbe, remoteShellCommand, shellQuote } from "../src/main/ssh/remote-shell.ts";
import { agentRuntimeRemoteDownloadCommand, agentRuntimeUploadCommand } from "../src/main/ssh/agent-runtime.ts";
import { agentPreflightCommand, agentStopCommand, buildAgentBootstrapCommand } from "../src/main/ssh/ssh-manager.ts";

const unix = process.platform !== "win32";

/**
 * PATH contains only our shell shims, so Bash can actually be absent. The shims
 * replace login startup with the fixture's profile: no test reads the developer's
 * dotfiles (and login Bash on some platforms resets HOME). Payloads still execute
 * in real Bash/sh; only startup-file discovery is substituted.
 */
function fixture(t: { after(fn: () => void): void }, bash: boolean) {
  const home = mkdtempSync(join(tmpdir(), "fv-shell-"));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const shim = (name: string, executable: string) => writeFileSync(join(home, name), [
    "#!/bin/sh",
    `printf '%s:%s\\n' ${shellQuote(name)} "$1" >> "$HOME/calls"`,
    'case "$1" in',
    '  -lc|-ilc)',
    '    mode="$1"; shift',
    '    payload=\'. "$HOME/.profile"\'',
    '    payload="$payload',
    '$1"',
    // Make the explicit .bashrc load exercise its interactive guard too.
    '    case "$mode" in -ilc) flag=-ic ;; *) flag=-c ;; esac',
    `    exec ${shellQuote(executable)} ${name === "bash" ? "--noprofile --norc " : ""}"$flag" "$payload" ;;`,
    `  *) exec ${shellQuote(executable)} "$@" ;;`,
    "esac",
  ].join("\n"), { mode: 0o700 });
  shim("sh", "/bin/sh");
  if (bash) shim("bash", "/bin/bash");
  writeFileSync(join(home, ".profile"), "");
  // The loader needs the ordinary tools a host has — but never bash or sh, whose absence
  // is what the `bash: false` fixture is about.
  const tools = join(home, "tools");
  mkdirSync(tools);
  for (const tool of ["awk", "sed", "grep", "mktemp", "sleep", "rm", "cat", "touch"]) {
    const found = spawnSync("/bin/sh", ["-c", `command -v ${tool}`], { encoding: "utf8" }).stdout.trim();
    if (found) symlinkSync(found, join(tools, tool));
  }
  const path = `${home}:${tools}`;
  const env = { ...process.env, HOME: home, PATH: path, SHELL: join(home, "sh"), BASH_ENV: "", ENV: "" };
  return { home, path, env, run: (command: string, input = "", timeout = 5000) => spawnSync("/bin/sh", ["-c", command], { env, input, encoding: "utf8", timeout }) };
}

test("all SSH control/deploy scripts select Bash before loading profiles", () => {
  const commands = [agentPreflightCommand("1.0.0"), agentStopCommand(), buildAgentBootstrapCommand(undefined, "1.0.0"), agentRuntimeRemoteDownloadCommand({ version: "1.0.0" }, "linux-x64"), agentRuntimeUploadCommand({ version: "1.0.0" }, "a".repeat(64))];
  for (const command of commands) {
    assert.ok(command.startsWith("sh -c "));
    assert.match(command, /command -v bash/);
    assert.match(command, /exec bash -lc/);
    assert.match(command, /exec sh -lc/);
    if (unix) execFileSync("/bin/sh", ["-n", "-c", command]);
  }
});

test("Bash profile can use source even when the account SHELL is sh", { skip: !unix }, (t) => {
  const f = fixture(t, true);
  writeFileSync(join(f.home, ".profile"), 'source "$HOME/environment"\n');
  writeFileSync(join(f.home, "environment"), 'export FV_ENV="from profile"\n');
  const result = f.run(remoteShellCommand('printf "%s" "$FV_ENV"'));
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, "from profile");
  assert.doesNotMatch(result.stderr, /source.*not found/);
});

test("without Bash the profile loads using POSIX dot", { skip: !unix }, (t) => {
  const f = fixture(t, false);
  writeFileSync(join(f.home, ".profile"), '. "$HOME/environment"\n');
  writeFileSync(join(f.home, "environment"), 'export FV_ENV="dot fallback"\n');
  const result = f.run(remoteShellCommand('printf "%s" "$FV_ENV"'));
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, "dot fallback");
});

for (const bash of [true, false]) {
  test(`shell selection preserves stdin, literal quoting and exit status (${bash ? "bash" : "sh"})`, { skip: !unix }, (t) => {
    const f = fixture(t, bash);
    const literal = "quotes ' \" ; $(exit 99)\nsecond line";
    const result = f.run(remoteShellCommand(`IFS= read -r line; printf '%s\\n%s' "$line" ${shellQuote(literal)}; exit 23`), "archive bytes\n");
    assert.equal(result.status, 23, result.stderr);
    assert.equal(result.stdout, `archive bytes\n${literal}`);
  });
}

/** The `export` lines the probe printed between its markers. */
function probedEnv(stdout: string): Map<string, string> {
  const block = stdout.split("\n__FV_ENV__\n")[1]?.split("__FV_ENV_END__")[0] ?? "";
  const env = new Map<string, string>();
  for (const line of block.split("\n")) {
    const match = /^export ([A-Za-z_][A-Za-z0-9_]*)='(.*)'$/.exec(line);
    if (match) env.set(match[1], match[2].replace(/'\\''/g, "'"));
  }
  return env;
}

test("env probe selects Bash for sh accounts and loads interactive bashrc using dot", { skip: !unix }, (t) => {
  const f = fixture(t, true);
  writeFileSync(join(f.home, ".bashrc"), 'case $- in *i*) ;; *) return ;; esac\nsource "$HOME/node-env"\necho "noisy rc output"\n');
  writeFileSync(join(f.home, "node-env"), 'export PATH="/fixture/node/bin:$PATH"\nexport https_proxy="http://127.0.0.1:7890"\n');
  writeFileSync(join(f.home, ".zshrc"), "exit 99\n");
  const result = f.run(loginEnvProbe().join("\n"));
  assert.equal(result.status, 0, result.stderr);
  const env = probedEnv(result.stdout);
  assert.equal(env.get("PATH"), `/fixture/node/bin:${f.path}`);
  assert.equal(env.get("https_proxy"), "http://127.0.0.1:7890");
});

test("env probe without Bash never sources bashrc or zshrc", { skip: !unix }, (t) => {
  const f = fixture(t, false);
  writeFileSync(join(f.home, ".bashrc"), "exit 99\n");
  writeFileSync(join(f.home, ".zshrc"), "exit 99\n");
  const result = f.run(loginEnvProbe().join("\n"));
  assert.equal(result.status, 0, result.stderr);
  assert.equal(probedEnv(result.stdout).get("PATH"), f.path);
});

for (const bash of [true, false]) {
  test(`load_login_env applies rc variables and proxies, never executes values (${bash ? "bash" : "sh"})`, { skip: !unix }, (t) => {
    const f = fixture(t, bash);
    const hostile = "it's $(touch pwned) `touch pwned2` ; done";
    writeFileSync(join(f.home, ".bashrc"), [
      "case $- in *i*) ;; *) return ;; esac",
      'export HTTPS_PROXY="http://user:secret@proxy.example:3128"',
      'export JAVA_HOME="/opt/jdk"',
      `export FV_HOSTILE=${shellQuote(hostile)}`,
      'export HOME="/somewhere/else"',
      'export PATH="/rc/bin:$PATH"',
    ].join("\n") + "\n");
    // Without Bash, the sh fixture's interactive shell reads only .profile.
    if (!bash) writeFileSync(join(f.home, ".profile"), `. "$HOME/.bashrc"\n`);
    const script = [
      ...loginEnvironment(),
      "load_login_env",
      'printf "%s|%s|%s|%s|%s|%s\\n" "$https_proxy" "$HTTPS_PROXY" "$JAVA_HOME" "$FV_HOSTILE" "$HOME" "$PATH"',
    ].join("\n");
    const result = f.run(script);
    assert.equal(result.status, 0, result.stderr);
    const lines = result.stdout.trim().split("\n");
    const summary = lines.slice(0, -1).join("\n");
    const values = lines.at(-1)!.split("|");
    assert.equal(values[0], "http://user:secret@proxy.example:3128", "lower-case mirror for wget");
    assert.equal(values[1], "http://user:secret@proxy.example:3128");
    assert.equal(values[2], "/opt/jdk");
    assert.equal(values[3], hostile);
    assert.equal(values[4], f.home, "session identity is kept");
    assert.equal(values[5].startsWith("/rc/bin:"), true);
    assert.equal(values[5].endsWith(`:${f.path}`), true);
    // Credentials never reach the connect log.
    assert.match(summary, /使用代理：http:\/\/\*\*\*@proxy\.example:3128/);
    assert.doesNotMatch(summary, /secret/);
    assert.equal(existsSync(join(f.home, "pwned")) || existsSync(join(f.home, "pwned2")), false);
  });
}

test("an rc file that never finishes cannot hang the loader", { skip: !unix }, (t) => {
  const f = fixture(t, true);
  writeFileSync(join(f.home, ".bashrc"), "case $- in *i*) ;; *) return ;; esac\nsleep 30\n");
  const started = Date.now();
  const result = f.run([...loginEnvironment(), "load_login_env", "echo done"].join("\n"), "", 20_000);
  assert.equal(result.stdout.trim().split("\n").at(-1), "done", result.stderr);
  // It did wait for the probe (this is not the mktemp-less early return), and gave up.
  assert.ok(Date.now() - started > 9_000);
  assert.ok(Date.now() - started < 13_000);
});

/**
 * A fake curl in front of the real tools: any URL containing "unreachable" fails like a
 * refused connection; anything else sends two 1 MB halves a second apart, announcing
 * the length the way `-D` would record it. Every call is logged.
 */
function fakeCurl(home: string): void {
  writeFileSync(join(home, "curl"), [
    "#!/bin/sh",
    'out=""; headers=""; url=""',
    'while [ $# -gt 0 ]; do case "$1" in -o) out="$2"; shift ;; -D) headers="$2"; shift ;; -*) ;; *) url="$1" ;; esac; shift; done',
    'echo "$url" >> "$HOME/fetched"',
    'case "$url" in *unreachable*) exit 7 ;; esac',
    'printf "HTTP/1.1 200 OK\\r\\nContent-Length: 2097152\\r\\n\\r\\n" > "$headers"',
    'head -c 1048576 /dev/zero > "$out"; sleep 1.2; head -c 1048576 /dev/zero >> "$out"',
  ].join("\n"), { mode: 0o700 });
  for (const tool of ["head", "wc", "tr", "tail"]) {
    const found = spawnSync("/bin/sh", ["-c", `command -v ${tool}`], { encoding: "utf8" }).stdout.trim();
    if (found && !existsSync(join(home, "tools", tool))) symlinkSync(found, join(home, "tools", tool));
  }
}

test("a download that cannot reach the official source falls back to the mirror, with progress", { skip: !unix }, (t) => {
  const f = fixture(t, true);
  fakeCurl(f.home);
  const script = [
    ...downloadHelpers(),
    'fv_download node-download "$HOME/out.tgz" "https://unreachable.example/node.tgz" "https://mirror.example/node.tgz" || exit 9',
    'printf "source=%s size=%s\\n" "$FV_SOURCE" "$(wc -c < "$HOME/out.tgz" | tr -d " ")"',
  ].join("\n");
  const result = f.run(script, "", 15_000);
  assert.equal(result.status, 0, result.stderr + result.stdout);
  assert.match(result.stdout, /unreachable\.example 下载失败，改用镜像源 mirror\.example…/);
  assert.match(result.stdout, /^FASTVIBE_PROGRESS node-download 1048576 2097152$/m);
  assert.match(result.stdout, /^FASTVIBE_PROGRESS node-download 2097152 2097152$/m);
  assert.match(result.stdout, /source=https:\/\/mirror\.example\/node\.tgz size=2097152/);
});

test("a reachable official source is used, and the mirror is never contacted", { skip: !unix }, (t) => {
  const f = fixture(t, true);
  fakeCurl(f.home);
  const script = [
    ...downloadHelpers(),
    'fv_download agent-download "$HOME/out.tgz" "https://github.example/a.tgz" "https://mirror.example/a.tgz" || exit 9',
    'echo "source=$FV_SOURCE"',
  ].join("\n");
  const result = f.run(script, "", 15_000);
  assert.equal(result.status, 0, result.stderr + result.stdout);
  assert.match(result.stdout, /source=https:\/\/github\.example\/a\.tgz/);
  assert.doesNotMatch(result.stdout, /改用镜像源/);
  assert.equal(execFileSync("/bin/cat", [join(f.home, "fetched")], { encoding: "utf8" }), "https://github.example/a.tgz\n");
});
