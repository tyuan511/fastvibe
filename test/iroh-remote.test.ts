import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { configureFastVibeUserData } from "../src/main/engine/paths.ts";
import { IrohRemoteConnection } from "../src/main/rtc/iroh-remote.ts";

const relayConfig = {
  relayId: "hk1",
  url: "https://relay.example.test/",
  quicPort: 7842,
  token: "fvr1.token",
  expiresAt: "2026-01-01T00:10:00.000Z",
  usage: {
    periodStart: "2026-01-01T00:00:00Z",
    resetsAt: "2026-02-01T00:00:00Z",
    usedBytes: 0,
    quotaBytes: 1000,
    remainingBytes: 1000,
  },
};

test("iroh initialization failures become visible error state", async () => {
  const dir = await mkdtemp(join(tmpdir(), "fastvibe-iroh-remote-"));
  const previous = process.env.FASTVIBE_IROH_BIN;
  process.env.FASTVIBE_IROH_BIN = "/tmp/does-not-exist-fastvibe-iroh";
  configureFastVibeUserData(dir);
  const changes: string[] = [];
  const remote = new IrohRemoteConnection({
    account: {
      async setIrohEndpoint() {},
      async issueIrohRelay() { return relayConfig; },
      async reportIrohUsage() { return relayConfig.usage; },
    },
    deviceId: "device",
    attach() {},
    log: { info() {}, warn() {} },
    onChange: () => changes.push("changed"),
  });
  try {
    await assert.rejects(remote.start(), /找不到 iroh transport/);
    const state = remote.state(true);
    assert.equal(state.status, "error");
    assert.match(state.error ?? "", /找不到 iroh transport/);
    assert.ok(changes.length > 0);
  } finally {
    await remote.dispose();
    if (previous === undefined) delete process.env.FASTVIBE_IROH_BIN;
    else process.env.FASTVIBE_IROH_BIN = previous;
    await rm(dir, { recursive: true, force: true });
  }
});
