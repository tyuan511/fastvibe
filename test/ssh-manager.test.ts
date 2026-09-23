import assert from "node:assert/strict";
import test from "node:test";
import { agentPreflightCommand, agentStopCommand, buildAgentBootstrapCommand, openSshAppTransport, parsePreflight, transferProgress } from "../src/main/ssh/ssh-manager.ts";
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
  assert.match(command, /--port=\$REQUESTED_PORT --state-file="\$STATE"/);
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
