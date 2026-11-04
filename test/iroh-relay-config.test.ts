import { test } from "node:test";
import assert from "node:assert/strict";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseIrohRelayConfig, irohRelayNodes } from "../src/shared/iroh-relay.ts";
import { IrohSidecar } from "../src/main/rtc/iroh-sidecar.ts";

const nodes = [
  { relay_id: "a", url: "https://a.invalid:8444", quic_port: 7842, token: "token-a" },
  { relay_id: "b", url: "https://b.invalid:8444", quic_port: 7843, token: "token-b" },
];
const common = {
  expires_at: "2027-01-01T00:00:00Z",
  usage: { period_start: "2026-01-01T00:00:00Z", resets_at: "2027-01-01T00:00:00Z", used_bytes: 0, quota_bytes: 1000, remaining_bytes: 1000 },
};

test("cloud relay roster preserves every address, token and discovery port", () => {
  const parsed = parseIrohRelayConfig({ ...common, ...nodes[0], relays: nodes });
  assert.ok(parsed);
  assert.deepEqual(irohRelayNodes(parsed), nodes.map((n) => ({ relayId: n.relay_id, url: n.url, quicPort: n.quic_port, token: n.token })));
  assert.equal(parsed.token, "token-a");
});

test("new roster is authoritative and works without compatibility fields", () => {
  const parsed = parseIrohRelayConfig({ ...common, relays: nodes });
  assert.ok(parsed);
  assert.equal(parsed.relays?.length, 2);
  const stale = parseIrohRelayConfig({ ...common, ...nodes[1], relays: nodes });
  assert.equal(stale?.url, nodes[0].url);
});

test("older Control single-node responses remain usable", () => {
  const parsed = parseIrohRelayConfig({ ...common, ...nodes[0] });
  assert.ok(parsed);
  assert.equal(irohRelayNodes(parsed).length, 1);
  const { relays: _, ...oldConfig } = parsed;
  assert.deepEqual(irohRelayNodes(oldConfig), parsed.relays);
});

test("bad or empty rosters cannot silently fall back to a legacy primary", () => {
  for (const relays of [[], null, {}, [nodes[0], { ...nodes[1], token: "" }], [nodes[0], { ...nodes[1], quic_port: 65536 }], [nodes[0], nodes[0]], [nodes[0], { ...nodes[1], url: "http://b.invalid" }]]) {
    assert.equal(parseIrohRelayConfig({ ...common, ...nodes[0], relays }), null);
  }
  assert.equal(parseIrohRelayConfig({ ...common, expires_at: "invalid", relays: nodes }), null);
});

test("start, refresh and connect forward the full roster to the actual sidecar pipe", async () => {
  const dir = await mkdtemp(join(tmpdir(), "fv-relay-roster-"));
  const binary = join(dir, "sidecar.mjs");
  const capture = join(dir, "commands.jsonl");
  await writeFile(binary, `#!/usr/bin/env node
import { createInterface } from 'node:readline';
import { appendFileSync } from 'node:fs';
for await (const line of createInterface({ input: process.stdin })) {
  const c = JSON.parse(line);
  appendFileSync(${JSON.stringify(capture)}, JSON.stringify(c)+'\\n');
  let e;
  if(c.type==='identity') e={type:'identity',endpointId:'a'.repeat(64)};
  if(c.type==='start') e={type:'started',endpointId:'a'.repeat(64)};
  if(c.type==='refresh') e={type:'refreshed'};
  if(c.type==='connect') e={type:'connected',connectionId:'test',remoteId:c.remoteId};
  if(c.type==='stop') process.exit(0);
  if(e) console.log(JSON.stringify(e));
}
`);
  await chmod(binary, 0o700);
  const previous = process.env.FASTVIBE_IROH_BIN;
  process.env.FASTVIBE_IROH_BIN = binary;
  const sidecar = new IrohSidecar();
  sidecar.on("error", () => {});
  try {
    const config = parseIrohRelayConfig({ ...common, relays: nodes });
    assert.ok(config);
    await sidecar.identity(join(dir, "identity"));
    await sidecar.startLease(config);
    await sidecar.refresh(config);
    await sidecar.connect("b".repeat(64), config);
    const commands = (await readFile(capture, "utf8")).trim().split("\n").map((l) => JSON.parse(l)).filter((c) => ["start", "refresh", "connect"].includes(c.type));
    assert.equal(commands.length, 3);
    for (const command of commands) {
      assert.deepEqual(command.relays, nodes.map((n) => ({ relayId: n.relay_id, relayUrl: n.url, relayToken: n.token, quicPort: n.quic_port })));
      assert.equal(command.relayUrl, nodes[0].url);
      assert.equal(command.relayToken, nodes[0].token);
    }
  } finally {
    await sidecar.stop();
    if (previous === undefined) delete process.env.FASTVIBE_IROH_BIN;
    else process.env.FASTVIBE_IROH_BIN = previous;
    await rm(dir, { recursive: true, force: true });
  }
});
