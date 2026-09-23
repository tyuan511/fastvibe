import test from "node:test";
import assert from "node:assert/strict";
import { agentRuntimeMirrorUrl, agentRuntimeRemoteDownloadCommand, agentRuntimeTarget, agentRuntimeUploadCommand, agentRuntimeUrl, shellQuote, type AgentRuntimeSource } from "../src/main/ssh/agent-runtime.ts";

const HASH = "a".repeat(64);
const ARCHIVE_SHA = "c".repeat(64);
function source(release = "agent-runtime-v12", releaseBaseUrl?: string): AgentRuntimeSource {
  return {
    release,
    targets: {
      "linux-x64": { runtimeHash: HASH, archiveSha256: ARCHIVE_SHA },
      "linux-arm64": { runtimeHash: "b".repeat(64), archiveSha256: "d".repeat(64) },
    },
    ...(releaseBaseUrl ? { releaseBaseUrl } : {}),
  };
}

/** Undo the shell selector wrapper so a test can read the script the host will run. */
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

test("agent runtime URL uses an independent readable release and target", () => {
  assert.equal(
    agentRuntimeUrl(source("agent-runtime-v12", "https://example.test/releases"), "linux-x64"),
    "https://example.test/releases/agent-runtime-v12/fastvibe-agent-linux-x64.tar.gz",
  );
});

test("the remote download command fetches the release on the host itself", () => {
  const command = agentRuntimeRemoteDownloadCommand(source(), "linux-arm64");
  assert.match(command, /fastvibe-agent-linux-arm64\.tar\.gz/);
  assert.match(command, /curl -fsSL/);
  assert.match(command, /wget -q/);
  assert.match(command, /--connect-timeout 15/);
  assert.match(command, /--timeout=30/);
  assert.match(command, /--speed-time 30/);
  assert.match(command, /VERSION=/);
  assert.equal(command.includes("agent-runtime-v12"), true);
  assert.match(command, /~|\$HOME\/\.fastvibe-agent/);
  assert.match(command, /tar -xzf/);
  assert.match(command, /unpacked\/out\/main\/agent\.js/);
  assert.match(command, /runtimeHash/);
  assert.match(command, /EXPECTED_ARCHIVE_SHA/);
  assert.match(command, /ln -sfn/);
  assert.match(command, /trap cleanup EXIT/);
});

test("the remote download pins one sanitized release, with no way to inject shell", () => {
  const hostilePage = "agent-runtime-v12'; rm -rf $HOME; echo '";
  const script = remoteScript(agentRuntimeRemoteDownloadCommand(source(hostilePage), "linux-x64"));
  const quoted = shellQuote(HASH);
  assert.equal(script.includes(quoted), true);
  assert.equal(script.replaceAll(quoted, "").includes("rm -rf $HOME"), false);
  assert.equal(script.includes("VERSION='agent-runtime-v12___rm_-rf__HOME__echo__'"), true);
});

test("an uploaded archive passes the same checks as a downloaded one, plus its checksum", () => {
  const sha = "f".repeat(64);
  const command = agentRuntimeUploadCommand(source(), "linux-x64", sha);
  assert.equal(command.includes(sha), true);
  assert.match(command, /cat > "\$TMP\/agent\.tar\.gz"/);
  assert.match(command, /校验和不匹配/);
  assert.match(command, /runtimeHash/);
  assert.match(command, /EXPECTED_ARCHIVE_SHA/);
  assert.match(command, /unpacked\/out\/main\/agent\.js/);
  assert.match(command, /trap cleanup EXIT/);
  assert.equal(agentRuntimeUploadCommand(source(), "linux-x64", "'; rm -rf ~; '").includes("rm -rf ~"), false);
});

test("GitHub releases fall back to gh-proxy; a custom release server is never rewritten", () => {
  assert.equal(
    agentRuntimeMirrorUrl(source(), "linux-x64"),
    "https://gh-proxy.com/https://github.com/tyuan511/fastvibe/releases/download/agent-runtime-v12/fastvibe-agent-linux-x64.tar.gz",
  );
  assert.equal(agentRuntimeMirrorUrl(source("agent-runtime-v12", "https://cdn.example.com/releases"), "linux-x64"), undefined);
  const command = agentRuntimeRemoteDownloadCommand(source(), "linux-x64");
  assert.match(command, /fv_download agent-download "\$TMP\/agent\.tar\.gz" "\$URL" "\$MIRROR_URL"/);
  assert.equal(command.includes("gh-proxy.com"), true);
});
