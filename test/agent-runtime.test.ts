import test from "node:test";
import assert from "node:assert/strict";
import { agentRuntimeMirrorUrl, agentRuntimeRemoteDownloadCommand, agentRuntimeTarget, agentRuntimeUploadCommand, agentRuntimeUrl, shellQuote } from "../src/main/ssh/agent-runtime.ts";

/**
 * Undo the shell selector wrapper so a test can read the script the host will run.
 *
 * Every quote inside the script is escaped a second time by that wrapper, so asserting on
 * the command directly would only prove that the escaping layers are the expected number
 * deep — not that an injected quote ends up as data.
 */
function remoteScript(command: string): string {
  const marker = " fastvibe-ssh ";
  assert.ok(command.includes(marker));
  const inner = command.slice(command.indexOf(marker) + marker.length);
  return inner.slice(1, -1).replace(/'\\''/g, "'");
}

test("agent runtime maps Linux architectures to release targets", () => {
  assert.equal(agentRuntimeTarget("Linux", "x86_64"), "linux-x64");
  assert.equal(agentRuntimeTarget("Linux", "aarch64"), "linux-arm64");
  assert.throws(() => agentRuntimeTarget("Darwin", "arm64"), /仅支持 Linux/);
});

test("agent runtime release URL includes the app version and target", () => {
  assert.equal(
    agentRuntimeUrl({ version: "0.7.0", releaseBaseUrl: "https://example.test/releases" }, "linux-x64"),
    "https://example.test/releases/v0.7.0/fastvibe-agent-linux-x64.tar.gz",
  );
});

test("the remote download command fetches the release on the host itself", () => {
  const command = agentRuntimeRemoteDownloadCommand({ version: "0.7.0" }, "linux-arm64");
  assert.match(command, /fastvibe-agent-linux-arm64\.tar\.gz/);
  // `-f` is what makes a 404 fail the shell instead of writing GitHub's error page to
  // disk as the archive; without it the unpack below is the first thing to notice. The
  // quiet flags keep curl's progress meter (one push per chunk, into the GUI log) out.
  assert.match(command, /curl -fsSL/);
  assert.match(command, /wget -q/);
  // The download must not be able to hang forever: a host on a black-holing network has
  // to fail into the upload fallback within the budget its caller set.
  assert.match(command, /--connect-timeout 15/);
  assert.match(command, /--timeout=30/);
  // ...and a stalled transfer, not only a refused connection, has to end too.
  assert.match(command, /--speed-time 30/);
  assert.match(command, /VERSION=/);
  assert.equal(command.includes("0.7.0"), true);
  assert.match(command, /~|\$HOME\/\.fastvibe-agent/);
  assert.match(command, /tar -xzf/);
  assert.match(command, /unpacked\/out\/main\/agent\.js/);
  // A half-written archive that still gunzips must not be linked as `current`.
  assert.match(command, /UNPACKED/);
  assert.match(command, /ln -sfn/);
  // The staging directory goes away on every exit path, including a refused download.
  assert.match(command, /trap cleanup EXIT/);
});

test("the remote download pins one sanitized version, with no way to inject shell", () => {
  const hostilePage = "0.7.0'; rm -rf $HOME; echo '";
  const script = remoteScript(agentRuntimeRemoteDownloadCommand({ version: hostilePage }, "linux-x64"));
  // The version reaches a shell variable, the release URL and the manifest comparison.
  // The first two are sanitized to `[0-9A-Za-z._-]`, and the third — which has to stay
  // exact, because that is the version inside the archive — goes through `shellQuote`,
  // so the injected `rm -rf` can only ever end up inside a single-quoted literal.
  const quoted = shellQuote(hostilePage);
  assert.equal(script.includes(quoted), true);
  assert.equal(script.replaceAll(quoted, "").includes("rm -rf $HOME"), false);
  assert.equal(script.includes("VERSION='0.7.0___rm_-rf__HOME__echo__'"), true);
  // A release preview tag is an ordinary version, not a hostile one.
  assert.equal(remoteScript(agentRuntimeRemoteDownloadCommand({ version: "0.7.0-rc.1" }, "linux-x64")).includes("0.7.0-rc.1"), true);
});

test("an uploaded archive passes the same checks as a downloaded one, plus its checksum", () => {
  const sha = "f".repeat(64);
  const command = agentRuntimeUploadCommand({ version: "0.7.0" }, sha);
  assert.equal(command.includes(sha), true);
  assert.match(command, /cat > "\$TMP\/agent\.tar\.gz"/);
  assert.match(command, /校验和不匹配/);
  assert.match(command, /UNPACKED/);
  assert.match(command, /unpacked\/out\/main\/agent\.js/);
  assert.match(command, /trap cleanup EXIT/);
  // A malformed digest is never interpolated.
  assert.equal(agentRuntimeUploadCommand({ version: "0.7.0" }, "'; rm -rf ~; '").includes("rm -rf ~"), false);
});

test("GitHub releases fall back to gh-proxy; a custom release server is never rewritten", () => {
  assert.equal(
    agentRuntimeMirrorUrl({ version: "0.7.0" }, "linux-x64"),
    "https://gh-proxy.com/https://github.com/tyuan511/fastvibe/releases/download/v0.7.0/fastvibe-agent-linux-x64.tar.gz",
  );
  assert.equal(agentRuntimeMirrorUrl({ version: "0.7.0", releaseBaseUrl: "https://cdn.example.com/releases" }, "linux-x64"), undefined);
  const command = agentRuntimeRemoteDownloadCommand({ version: "0.7.0" }, "linux-x64");
  assert.match(command, /fv_download agent-download "\$TMP\/agent\.tar\.gz" "\$URL" "\$MIRROR_URL"/);
  assert.equal(command.includes("gh-proxy.com"), true);
});
