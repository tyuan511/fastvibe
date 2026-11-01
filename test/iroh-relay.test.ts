import { test } from "node:test";
import assert from "node:assert/strict";
import { IrohRelayQuotaExceeded } from "../src/shared/iroh-relay.ts";
import { IrohRelayLease } from "../src/main/rtc/iroh-relay.ts";

const usage = (remainingBytes = 900) => ({
  periodStart: "2026-01-01T00:00:00Z",
  resetsAt: "2026-02-01T00:00:00Z",
  usedBytes: 100,
  quotaBytes: 1000,
  remainingBytes,
});

const config = (expiresAt = "2026-01-01T00:10:00.000Z") => ({
  relayId: "hk1",
  url: "https://relay.example.test/",
  quicPort: 7842,
  token: "fvr1.token",
  expiresAt,
  usage: usage(),
});

test("relay lease obtains a short-lived config and refreshes before expiry", async () => {
  let now = Date.parse("2026-01-01T00:00:00Z");
  const issued: string[] = [];
  const account = {
    async issueIrohRelay(device: string, endpoint: string) {
      issued.push(`${device}/${endpoint}`);
      return config(new Date(now + 10 * 60_000).toISOString());
    },
    async reportIrohUsage() { return usage(); },
  };
  const lease = new IrohRelayLease({ account, deviceId: "device", endpointId: "endpoint", now: () => now, refreshMarginMs: 60_000 });
  assert.equal((await lease.acquire()).relayId, "hk1");
  assert.equal(issued.length, 1);
  now += 9 * 60_000;
  await lease.acquire();
  assert.equal(issued.length, 2);
  lease.close();
});

test("relay lease reports cumulative wire bytes with one stable checkpoint id", async () => {
  const reports: Array<{ reportId: string; bytesIn: number; bytesOut: number }> = [];
  const account = {
    async issueIrohRelay() { return config(); },
    async reportIrohUsage(input: { reportId: string; bytesIn: number; bytesOut: number }) {
      reports.push(input);
      return usage(900 - input.bytesIn - input.bytesOut);
    },
  };
  const lease = new IrohRelayLease({ account, deviceId: "device", endpointId: "endpoint", reportEveryBytes: 1_000_000 });
  await lease.acquire();
  lease.recordTraffic({ bytesIn: 12, bytesOut: 34 });
  await lease.flush();
  lease.recordTraffic({ bytesIn: 5, bytesOut: 6 });
  await lease.flush();
  assert.equal(reports.length, 2);
  assert.equal(reports[0].reportId, reports[1].reportId);
  assert.deepEqual(reports.map(({ bytesIn, bytesOut }) => [bytesIn, bytesOut]), [[12, 34], [17, 40]]);
  assert.deepEqual(lease.state().reported, { bytesIn: 17, bytesOut: 40 });
  lease.close();
});

test("relay lease keeps traffic out of Control until a relay path is recorded", async () => {
  let reports = 0;
  const account = {
    async issueIrohRelay() { return config(); },
    async reportIrohUsage() { reports += 1; return usage(); },
  };
  const lease = new IrohRelayLease({ account, deviceId: "device", endpointId: "endpoint" });
  await lease.acquire();
  assert.equal(reports, 0);
  lease.recordTraffic({ bytesIn: 0, bytesOut: 0 });
  await lease.flush();
  assert.equal(reports, 0);
  lease.close();
});

test("quota failure is returned by acquire and does not create a fake relay config", async () => {
  const quota = new IrohRelayQuotaExceeded();
  const lease = new IrohRelayLease({
    account: {
      async issueIrohRelay() { throw quota; },
      async reportIrohUsage() { return usage(); },
    },
    deviceId: "device",
    endpointId: "endpoint",
  });
  await assert.rejects(lease.acquire(), quota);
  assert.equal(lease.state().config, null);
  lease.close();
});

test("negative traffic cannot reduce a cumulative checkpoint", async () => {
  const lease = new IrohRelayLease({
    account: {
      async issueIrohRelay() { return config(); },
      async reportIrohUsage() { return usage(); },
    },
    deviceId: "device",
    endpointId: "endpoint",
  });
  await lease.acquire();
  assert.throws(() => lease.recordTraffic({ bytesIn: -1, bytesOut: 0 }), /bytesIn/);
  lease.close();
});
