import assert from "node:assert/strict";
import test from "node:test";
import { agentPreflightCommand, agentStopCommand, buildAgentBootstrapCommand, openSshAppTransport, parsePreflight, transferProgress } from "../src/main/ssh/ssh-manager.ts";

test("bootstrap lets the remote OS pick the port and records it in ~/.fastvibe", () => {
  const command = buildAgentBootstrapCommand(undefined, "0.7.0");
  assert.match(command, /REQUESTED_PORT=0/);
  assert.match(command, /--port=\$REQUESTED_PORT --state-file="\$STATE"/);
  assert.match(command, /STATE="\$HOME\/\.fastvibe\/agent\.json"/);
  assert.match(command, /FASTVIBE_PORT=%s/);
  assert.equal(/--port \d/.test(command), false);
  // Ready only once the state file names the process just started.
  assert.match(command, /\[ "\$\(state_field pid\)" = "\$1" \]/);
  // Old fixed-port Agents are stopped rather than left resident beside the new one.
  assert.match(command, /agent-\*\.pid/);
  assert.match(command, /releases\/\$VERSION/);
  assert.match(command, /Restarting FastVibe Agent/);
  assert.match(command, /nodejs|Node\.js/);
  assert.match(command, /nodejs\.org\/dist/);
  assert.doesNotMatch(command, /pkill/);
  assert.doesNotMatch(command, /killall/);
});

test("bootstrap loads the login shell's rc environment before looking for Node", () => {
  const command = buildAgentBootstrapCommand(undefined, "0.7.0");
  // A login-but-not-interactive shell misses nvm/fnm/volta twice over: bash skips
  // `~/.bashrc` unless interactive, and the `-l` profile chain only reaches it when
  // `~/.bash_profile` sources it. Without this the host downloads a Node it has.
  assert.match(command, /"\$PROBE_SHELL" -ilc/);
  assert.match(command, /\.bashrc/);
  // Zsh loads its own rc; never force Bash or sh to parse it.
  assert.doesNotMatch(command, /\.zshrc/);
  assert.match(command, /__FV_ENV__/);
  // The probe is bounded, because a startup file that waits for input would otherwise
  // hang the whole connect with no timeout and no output.
  assert.match(command, /-lt 100/);
  assert.match(command, /kill "\$FV_ENV_PID"/);
  // Loaded in this shell (not a subshell) before Node is looked for, so a manager's shims
  // are on PATH by then — and the Agent started later inherits the proxy settings too.
  assert.equal(command.indexOf("\nload_login_env\n") > 0, true);
  assert.equal(command.indexOf("\nload_login_env\n") < command.indexOf("SYSTEM_NODE=$(command -v node"), true);
  // And the probe keeps up with the managers even when PATH cannot be read: the rc file
  // may be zsh-only, or absent.
  assert.match(command, /\.nvm\/versions\/node\/\*\/bin\/node/);
  assert.match(command, /\.volta\/bin\/node/);
  assert.match(command, /\.local\/share\/mise\/shims\/node/);
});

test("bootstrap passes the config sync token and waits for the Agent to listen", () => {
  const token = "a".repeat(64);
  const command = buildAgentBootstrapCommand(undefined, "0.7.0", "linux-x64", token);
  assert.equal(command.includes(token), true);
  assert.equal(command.includes('FASTVIBE_AGENT_SYNC_TOKEN="$SYNC_TOKEN" nohup "$NODE" "$MAIN"'), true);
  assert.match(command, /wait_for_agent "\$AGENT_PID"/);
  assert.match(command, /远程 Agent 已就绪/);
  assert.match(command, /tail -n 20 "\$LOG"/);
});

test("resident probe reuses a running Agent without deploying or restarting", () => {
  const command = agentPreflightCommand("0.7.0");
  // It must name the same release the bootstrap deploys, and read the token from the
  // running process rather than from disk: a disk token an old process never loaded is
  // exactly the mismatch that made every config sync fail.
  assert.match(command, /releases\/\$VERSION\/out\/main\/agent\.js/);
  assert.match(command, /\.fastvibe\/agent\.json/);
  assert.match(command, /agent_token/);
  assert.match(command, /agent_ready "\$pid"/);
  assert.match(command, /FASTVIBE_AGENT_SYNC_TOKEN=%s/);
  // The fast path never installs, downloads or kills anything.
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
        agentRuntime: { version: "0.7.0" },
        log: { info() {}, warn() {} },
        signal,
      }),
    /远程连接已取消/,
  );
});

test("one preflight round trip reports platform, install, home and the resident token", () => {
  const command = agentPreflightCommand("0.7.0");
  for (const field of ["OS", "ARCH", "HOME", "INSTALLED", "RUNNING", "PORT"]) assert.match(command, new RegExp(`FASTVIBE_${field}=`));
  const token = "e".repeat(64);
  assert.deepEqual(parsePreflight([
    "FASTVIBE_OS=Linux",
    "FASTVIBE_ARCH=x86_64",
    "FASTVIBE_HOME=/home/dev",
    "FASTVIBE_INSTALLED=0.7.0",
    "FASTVIBE_RUNNING=0.7.0",
    "FASTVIBE_PORT=41234",
    `FASTVIBE_AGENT_SYNC_TOKEN=${token}`,
  ].join("\n")), { os: "Linux", arch: "x86_64", home: "/home/dev", installed: "0.7.0", running: "0.7.0", port: 41234, token });
  // Nothing installed: no token, no versions, and a login banner is not mistaken for a field.
  assert.deepEqual(parsePreflight("Welcome!\nFASTVIBE_OS=Linux\nFASTVIBE_ARCH=aarch64\nFASTVIBE_HOME=/root\nFASTVIBE_INSTALLED=\nFASTVIBE_RUNNING=\n"), { os: "Linux", arch: "aarch64", home: "/root" });
});

test("bootstrap verifies the Node download and prunes releases nothing runs from", () => {
  const command = buildAgentBootstrapCommand(undefined, "0.7.0");
  assert.match(command, /SHASUMS256\.txt/);
  assert.match(command, /Node\.js 下载内容校验失败/);
  assert.match(command, /prune\(\)/);
  assert.match(command, /in_use "\$dir"/);
  // The log lives with the Agent, not in the shared /tmp another user can squat on.
  assert.match(command, /LOG="\$ROOT\/agent\.log"/);
});

test("stopping the Agent only ever kills a FastVibe process", () => {
  const command = agentStopCommand();
  assert.match(command, /is_agent "\$p"/);
  assert.match(command, /grep -qF "\/\.fastvibe-agent\/"/);
});

test("a pinned servicePort is passed through; anything invalid falls back to a random port", () => {
  assert.match(buildAgentBootstrapCommand(8123, "0.7.0"), /REQUESTED_PORT=8123/);
  assert.match(buildAgentBootstrapCommand(70_000, "0.7.0"), /REQUESTED_PORT=0/);
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
  // Nine reports over one second: throttled to the first and every 250 ms after.
  assert.equal(events.length, 5);
  assert.deepEqual(events.at(-1), { phase: "agent-upload", done: 2_359_296, total: 4_194_304, rate: 2_359_296 });
  // The final chunk always gets through, whatever the throttle says.
  clock += 10;
  progress.report("agent-upload", 4_194_304, 4_194_304);
  assert.equal((events.at(-1) as { done: number }).done, 4_194_304);
  progress.clear();
  assert.equal(events.at(-1), null);
});

test("the bootstrap downloads Node from nodejs.org first and npmmirror only as a fallback", () => {
  const command = buildAgentBootstrapCommand(undefined, "0.7.0");
  assert.match(command, /fv_download node-download "\$TMP\/node\.tar\.gz" "\$NODE_OFFICIAL\/\$NODE_FILE" "\$NODE_MIRROR\/\$NODE_FILE"/);
  assert.match(command, /https:\/\/nodejs\.org\/dist/);
  assert.match(command, /https:\/\/cdn\.npmmirror\.com\/binaries\/node/);
});
