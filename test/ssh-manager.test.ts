import assert from "node:assert/strict";
import test from "node:test";
import { agentPreflightCommand, agentStopCommand, buildAgentBootstrapCommand, openSshAppTransport, parsePreflight, phoneAccessClearCommand, phoneAccessWriteCommand, runningAgentFits, transferProgress } from "../src/main/ssh/ssh-manager.ts";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { hashPassword, verifyPassword } from "../src/main/server/auth.ts";
import { readRemoteAccess } from "../src/main/server/store.ts";
import { normalizePublicUrl, phoneAccessAddress } from "../src/shared/remote-host.ts";
import type { AgentRuntimeSource } from "../src/main/ssh/agent-runtime.ts";

const HASH_X64 = "a".repeat(64);
const HASH_ARM64 = "b".repeat(64);
const runtime: AgentRuntimeSource = {
  release: "agent-runtime-v12",
  targets: {
    "linux-x64": { runtimeHash: HASH_X64 },
    "linux-arm64": { runtimeHash: HASH_ARM64 },
  },
};

test("bootstrap lets the remote OS pick the port and records it in ~/.fastvibe", () => {
  const command = buildAgentBootstrapCommand(undefined, runtime);
  assert.match(command, /REQUESTED_PORT=0/);
  assert.match(command, /--port=\$REQUESTED_PORT --host=\$LISTEN_HOST --state-file="\$STATE"/);
  // Loopback unless phone access asks otherwise.
  assert.match(command, /WANT_PUBLIC=0/);
  assert.match(command, /LISTEN_HOST=127\.0\.0\.1/);
  assert.match(command, /STATE="\$HOME\/.fastvibe\/agent\.json"/);
  assert.match(command, /FASTVIBE_PORT=%s/);
  assert.equal(/--port \d/.test(command), false);
  assert.match(command, /\[ "\$\(state_field pid\)" = "\$1" \]/);
  assert.match(command, /agent-\*\.pid/);
  assert.match(command, /releases\/\$VERSION/);
  assert.match(command, /runtime hash mismatch/);
  assert.match(command, /Restarting FastVibe Agent/);
  assert.match(command, /nodejs|Node\.js/);
  assert.match(command, /nodejs\.org\/dist/);
  assert.doesNotMatch(command, /pkill/);
  assert.doesNotMatch(command, /killall/);
});

test("bootstrap loads the login shell's rc environment before looking for Node", () => {
  const command = buildAgentBootstrapCommand(undefined, runtime);
  assert.match(command, /"\$PROBE_SHELL" -ilc/);
  assert.match(command, /\.bashrc/);
  assert.doesNotMatch(command, /\.zshrc/);
  assert.match(command, /__FV_ENV__/);
  assert.match(command, /-lt 100/);
  assert.match(command, /kill "\$FV_ENV_PID"/);
  assert.equal(command.indexOf("\nload_login_env\n") > 0, true);
  assert.equal(command.indexOf("\nload_login_env\n") < command.indexOf("SYSTEM_NODE=$(command -v node"), true);
  assert.match(command, /\.nvm\/versions\/node\/\*\/bin\/node/);
  assert.match(command, /\.volta\/bin\/node/);
  assert.match(command, /\.local\/share\/mise\/shims\/node/);
});

test("bootstrap passes the config sync token and waits for the Agent to listen", () => {
  const token = "a".repeat(64);
  const command = buildAgentBootstrapCommand(undefined, runtime, "linux-x64", token);
  assert.equal(command.includes(token), true);
  assert.equal(command.includes('FASTVIBE_VERSION="$VERSION" FASTVIBE_AGENT_SYNC_TOKEN="$SYNC_TOKEN" nohup "$NODE" "$MAIN"'), true);
  assert.match(command, /wait_for_agent "\$AGENT_PID"/);
  assert.match(command, /远程 Agent 已就绪/);
  assert.match(command, /tail -n 20 "\$LOG"/);
});

test("resident probe reuses a running Agent without deploying or restarting", () => {
  const command = agentPreflightCommand(runtime);
  assert.match(command, /releases\/\$VERSION\/out\/main\/agent\.js/);
  assert.match(command, /INSTALLED_HASH/);
  assert.match(command, /runtimeHash/);
  assert.match(command, /\.fastvibe\/agent\.json/);
  assert.match(command, /agent_token/);
  assert.match(command, /agent_ready "\$pid"/);
  assert.match(command, /FASTVIBE_AGENT_SYNC_TOKEN=%s/);
  assert.doesNotMatch(command, /nodejs\.org/);
  assert.doesNotMatch(command, /tar -x/);
  assert.doesNotMatch(command, /kill/);
});

test("openSshAppTransport refuses to deploy when already cancelled", async () => {
  const signal = AbortSignal.abort();
  await assert.rejects(
    () =>
      openSshAppTransport({
        profile: { id: "h", label: "h", host: "example.test" },
        agentRuntime: runtime,
        log: { info() {}, warn() {} },
        signal,
      }),
    /远程连接已取消/,
  );
});

test("one preflight round trip reports platform, install, home and the resident token", () => {
  const command = agentPreflightCommand(runtime);
  for (const field of ["OS", "ARCH", "HOME", "INSTALLED", "INSTALLED_HASH", "RUNNING", "PORT"]) assert.match(command, new RegExp(`FASTVIBE_${field}=`));
  const token = "e".repeat(64);
  assert.deepEqual(parsePreflight([
    "FASTVIBE_OS=Linux",
    "FASTVIBE_ARCH=x86_64",
    "FASTVIBE_HOME=/home/dev",
    "FASTVIBE_INSTALLED=agent-runtime-v12",
    `FASTVIBE_INSTALLED_HASH=${HASH_X64}`,
    "FASTVIBE_RUNNING=agent-runtime-v12",
    "FASTVIBE_PORT=41234",
    `FASTVIBE_AGENT_SYNC_TOKEN=${token}`,
  ].join("\n")), { os: "Linux", arch: "x86_64", home: "/home/dev", installed: "agent-runtime-v12", installedHash: HASH_X64, running: "agent-runtime-v12", port: 41234, token });
  assert.deepEqual(parsePreflight("Welcome!\nFASTVIBE_OS=Linux\nFASTVIBE_ARCH=aarch64\nFASTVIBE_HOME=/root\nFASTVIBE_INSTALLED=\nFASTVIBE_INSTALLED_HASH=\nFASTVIBE_RUNNING=\n"), { os: "Linux", arch: "aarch64", home: "/root" });
});

test("bootstrap verifies the Node download and prunes releases nothing runs from", () => {
  const command = buildAgentBootstrapCommand(undefined, runtime);
  assert.match(command, /SHASUMS256\.txt/);
  assert.match(command, /Node\.js 下载内容校验失败/);
  assert.match(command, /prune\(\)/);
  assert.match(command, /in_use "\$dir"/);
  assert.match(command, /LOG="\$ROOT\/agent\.log"/);
});

test("stopping the Agent only ever kills a FastVibe process", () => {
  const command = agentStopCommand();
  assert.match(command, /is_agent "\$p"/);
  assert.match(command, /grep -qF "\/\.fastvibe-agent\/"/);
});

test("a pinned servicePort is passed through; anything invalid falls back to a random port", () => {
  assert.match(buildAgentBootstrapCommand(8123, runtime), /REQUESTED_PORT=8123/);
  assert.match(buildAgentBootstrapCommand(70_000, runtime), /REQUESTED_PORT=0/);
});

test("transfer progress reports a speed and at most four events a second", () => {
  let clock = 0;
  const events: unknown[] = [];
  const progress = transferProgress((event) => events.push(event), () => clock);
  progress.report("agent-upload", 262_144, 4_194_304);
  for (let step = 1; step <= 8; step += 1) {
    clock = step * 125;
    progress.report("agent-upload", 262_144 * (step + 1), 4_194_304);
  }
  assert.equal(events.length, 5);
  assert.deepEqual(events.at(-1), { phase: "agent-upload", done: 2_359_296, total: 4_194_304, rate: 2_359_296 });
  clock += 10;
  progress.report("agent-upload", 4_194_304, 4_194_304);
  assert.equal((events.at(-1) as { done: number }).done, 4_194_304);
  progress.clear();
  assert.equal(events.at(-1), null);
});

test("the bootstrap downloads Node from nodejs.org first and npmmirror only as a fallback", () => {
  const command = buildAgentBootstrapCommand(undefined, runtime);
  assert.match(command, /fv_download node-download "\$TMP\/node\.tar\.gz" "\$NODE_OFFICIAL\/\$NODE_FILE" "\$NODE_MIRROR\/\$NODE_FILE"/);
  assert.match(command, /https:\/\/nodejs\.org\/dist/);
  assert.match(command, /https:\/\/cdn\.npmmirror\.com\/binaries\/node/);
});

test("phone access starts the Agent beyond loopback, and says so in the bootstrap", () => {
  const command = buildAgentBootstrapCommand(7777, runtime, "linux-x64", "", { exposed: true });
  assert.match(command, /WANT_PUBLIC=1/);
  assert.match(command, /LISTEN_HOST=0\.0\.0\.0/);
  assert.match(command, /--host=\$LISTEN_HOST/);
  // Reusing the running Agent has to compare how it listens, or turning phone access on
  // would find a perfectly good loopback Agent on the right port and leave it alone.
  assert.match(command, /RUNNING_PUBLIC=\$\(state_field public\)/);
  assert.match(command, /\[ "\$RUNNING_PUBLIC" = "\$WANT_PUBLIC" \]/);
});

test("an Agent too old to listen beyond loopback is reported, not restarted on every connect", () => {
  const command = buildAgentBootstrapCommand(7777, runtime, "linux-x64", "", { exposed: true });
  assert.match(command, /\[ "\$WANT_PUBLIC" = 1 \] && \[ "\$\(state_field public\)" != 1 \]/);
  assert.match(command, /版本过旧，不支持对外监听/);
});

test("the preflight reports whether the running Agent listens beyond loopback", () => {
  const preflight = agentPreflightCommand(runtime);
  assert.match(preflight, /FASTVIBE_PUBLIC=%s/);
  assert.match(preflight, /PUBLIC=\$\(state_field public\)/);
  assert.equal(parsePreflight("FASTVIBE_OS=Linux\nFASTVIBE_ARCH=x86_64\nFASTVIBE_PORT=7777\nFASTVIBE_PUBLIC=1\n").public, true);
  assert.equal(parsePreflight("FASTVIBE_OS=Linux\nFASTVIBE_ARCH=x86_64\nFASTVIBE_PORT=7777\nFASTVIBE_PUBLIC=0\n").public, false);
  // No Agent running, or one from before the field existed: nothing is claimed.
  assert.equal("public" in parsePreflight("FASTVIBE_OS=Linux\nFASTVIBE_ARCH=x86_64\nFASTVIBE_PUBLIC=\n"), false);
});

test("a running Agent is reused only if it listens the way the profile asks", () => {
  // Phone access off: any loopback Agent will do, on the pinned port when there is one.
  assert.equal(runningAgentFits({ port: 41234, public: false }, {}), true);
  assert.equal(runningAgentFits({ port: 41234 }, {}), true, "an Agent from before the field reads as loopback");
  assert.equal(runningAgentFits({ port: 41234, public: false }, { servicePort: 8123 }), false);
  assert.equal(runningAgentFits({ port: 8123, public: false }, { servicePort: 8123 }), true);
  // Turning phone access on moves a loopback Agent, even on the right port.
  assert.equal(runningAgentFits({ port: 7777, public: false }, { phoneAccess: { port: 7777 } }), false);
  assert.equal(runningAgentFits({ port: 7777 }, { phoneAccess: { port: 7777 } }), false);
  assert.equal(runningAgentFits({ port: 7777, public: true }, { phoneAccess: { port: 7777 } }), true);
  assert.equal(runningAgentFits({ port: 7778, public: true }, { phoneAccess: { port: 7777 } }), false);
  // Turning it off moves an exposed Agent back to loopback.
  assert.equal(runningAgentFits({ port: 7777, public: true }, {}), false);
  // The phone port wins over servicePort, which cannot spell 7777 at all.
  assert.equal(runningAgentFits({ port: 7777, public: true }, { servicePort: 9000, phoneAccess: { port: 7777 } }), true);
});

test("the address a phone scans: a public URL when given, else http://host:port", () => {
  assert.equal(phoneAccessAddress({ host: "hk1", phoneAccess: undefined }), null);
  assert.equal(phoneAccessAddress({ host: "hk1", hostName: "45.144.137.241", phoneAccess: { port: 7777 } }), "http://45.144.137.241:7777");
  // An ssh_config alias means nothing to a phone; the resolved name is what to use.
  assert.equal(phoneAccessAddress({ host: "my-alias", hostName: "dev.example.com", phoneAccess: { port: 8123 } }), "http://dev.example.com:8123");
  assert.equal(phoneAccessAddress({ host: "dev.example.com", phoneAccess: { port: 8123 } }), "http://dev.example.com:8123");
  assert.equal(phoneAccessAddress({ host: "2001:db8::1", phoneAccess: { port: 7777 } }), "http://[2001:db8::1]:7777");
  assert.equal(phoneAccessAddress({ host: "h", phoneAccess: { port: 7777, publicUrl: "https://agent.example.com/" } }), "https://agent.example.com");
  // A URL the phone could not use falls back rather than producing a code that opens nothing.
  assert.equal(phoneAccessAddress({ host: "h", hostName: "1.2.3.4", phoneAccess: { port: 7777, publicUrl: "ftp://x" } }), "http://1.2.3.4:7777");
});

test("a public URL is an http(s) origin and nothing the phone would silently drop", () => {
  assert.equal(normalizePublicUrl("https://agent.example.com"), "https://agent.example.com");
  assert.equal(normalizePublicUrl("  https://agent.example.com:8443/  "), "https://agent.example.com:8443");
  assert.equal(normalizePublicUrl("http://203.0.113.5:7777"), "http://203.0.113.5:7777");
  for (const bad of ["agent.example.com", "ftp://agent.example.com", "https://agent.example.com/app", "https://agent.example.com/?x=1", "https://user:pw@agent.example.com", "", undefined, 42]) {
    assert.equal(normalizePublicUrl(bad), null, String(bad));
  }
});

// These two run the real script through `sh -c`, as `ssh host <command>` would, against a
// throwaway HOME. POSIX only: the remote side is always Linux, and Windows has no `sh`.
const posix = process.platform !== "win32";

test("the password file is written whole, 0600, and replaces the old one", { skip: !posix }, () => {
  const home = mkdtempSync(join(tmpdir(), "fastvibe-phone-"));
  try {
    const run = (password: string) => execFileSync("sh", ["-c", phoneAccessWriteCommand()], {
      input: `${JSON.stringify({ version: 1, password: hashPassword(password), devices: [] }, null, 2)}\n`,
      env: { ...process.env, HOME: home },
      encoding: "utf8",
    });
    run("correct horse battery");
    const file = join(home, ".fastvibe", "remote-access.json");
    assert.equal((statSync(file).mode & 0o777).toString(8), "600");
    assert.equal(existsSync(`${file}.tmp`), false, "no temporary file is left beside it");
    // Read back with the server's own reader, so the format cannot drift from what it accepts.
    assert.equal(verifyPassword("correct horse battery", readRemoteAccess(file).password!), true);
    run("another one 12345");
    const replaced = readRemoteAccess(file).password!;
    assert.equal(verifyPassword("correct horse battery", replaced), false, "a changed password signs the old one out");
    assert.equal(verifyPassword("another one 12345", replaced), true);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("turning phone access off deletes the password file and stops only an exposed Agent", { skip: !posix }, () => {
  const command = phoneAccessClearCommand();
  // Only an Agent that listens beyond loopback is stopped; a loopback one is the desktop's.
  assert.match(command, /\[ "\$\(state_field public\)" = 1 \]/);
  assert.match(command, /is_agent "\$p"/, "and only ever a FastVibe process");
  const home = mkdtempSync(join(tmpdir(), "fastvibe-phone-"));
  try {
    mkdirSync(join(home, ".fastvibe"), { recursive: true });
    writeFileSync(join(home, ".fastvibe", "remote-access.json"), "{}");
    execFileSync("sh", ["-c", command], { env: { ...process.env, HOME: home }, encoding: "utf8" });
    assert.equal(existsSync(join(home, ".fastvibe", "remote-access.json")), false);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});
