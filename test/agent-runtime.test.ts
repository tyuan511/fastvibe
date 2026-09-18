import test from "node:test";
import assert from "node:assert/strict";
import { agentRuntimeTarget, agentRuntimeUrl } from "../src/main/ssh/agent-runtime.ts";

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
