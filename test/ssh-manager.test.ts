import assert from "node:assert/strict";
import test from "node:test";
import { buildAgentBootstrapCommand, openSshAppTransport, residentAgentProbeCommand } from "../src/main/ssh/ssh-manager.ts";

test("bootstrap uses --port= and only restarts a FastVibe Agent of another version", () => {
  const command = buildAgentBootstrapCommand(7777, "0.7.0");
  assert.match(command, /PORT=7777/);
  assert.match(command, /--port=\$PORT/);
  assert.equal(/--port \d/.test(command), false);
  assert.match(command, /releases\/\$VERSION/);
  assert.match(command, /already in use by another process/);
  assert.match(command, /Restarting FastVibe Agent/);
  assert.match(command, /nodejs|Node\.js/);
  assert.match(command, /nodejs\.org\/dist/);
  assert.doesNotMatch(command, /pkill/);
  assert.doesNotMatch(command, /killall/);
});

test("bootstrap passes the config sync token into the Agent process", () => {
  const token = "a".repeat(64);
  const command = buildAgentBootstrapCommand(7777, "0.7.0", "linux-x64", token);
  assert.equal(command.includes(token), true);
  assert.equal(command.includes('FASTVIBE_AGENT_SYNC_TOKEN="$SYNC_TOKEN" nohup "$NODE" "$MAIN"'), true);
});

test("resident probe reuses a running Agent without deploying or restarting", () => {
  const command = residentAgentProbeCommand(7777, "0.7.0");
  // It must name the same release the bootstrap deploys, and read the token from the
  // running process rather than from disk: a disk token an old process never loaded is
  // exactly the mismatch that made every config sync fail.
  assert.match(command, /releases\/\$VERSION\/out\/main\/agent\.js/);
  assert.match(command, /agent-\$PORT\.pid/);
  assert.match(command, /agent_token/);
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
