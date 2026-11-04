import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import {
  IrohDiscoveryAdvertiser, irohLanAdvertisement,
  type DiscoveryBonjour, type DiscoveryPublishConfig, type DiscoveryService,
  type IrohDiscoveryEndpoint,
} from "../src/main/rtc/iroh-discovery.ts";

const endpoint: IrohDiscoveryEndpoint = {
  deviceId: "00000000-0000-0000-0000-000000000001", endpointId: "ab".repeat(32),
  name: "Office.Mac", directAddresses: ["[fd12::3]:55555", "192.168.22.139:44444"],
};

class FakeService extends EventEmitter implements DiscoveryService {
  activated = true;
  published = false;
  records() {
    return [
      { type: "A", data: "192.168.22.139" },
      { type: "A", data: "10.0.0.99" },
      { type: "AAAA", data: "fd12::3" },
      { type: "AAAA", data: "fe80::1" },
      { type: "PTR", data: "instance" },
    ];
  }
}
class FakeBonjour implements DiscoveryBonjour {
  service = new FakeService();
  configs: DiscoveryPublishConfig[] = [];
  destroyed = false;
  withdrawn = false;
  readonly error: (error: unknown) => void;
  constructor(error: (error: unknown) => void) { this.error = error; }
  publish(config: DiscoveryPublishConfig) { this.configs.push(config); return this.service; }
  unpublishAll(callback?: () => void) { this.withdrawn = true; callback?.(); }
  destroy() { this.destroyed = true; }
}
function harness() {
  const instances: FakeBonjour[] = [];
  const info: string[] = [];
  const warnings: string[] = [];
  const advertiser = new IrohDiscoveryAdvertiser({
    log: { info: (message) => info.push(message), warn: (message) => warnings.push(message) },
    create(error) { const instance = new FakeBonjour(error); instances.push(instance); return instance; },
  });
  return { advertiser, instances, info, warnings };
}

test("iroh DNS-SD advertises the QUIC UDP port and public account route metadata only", () => {
  const h = harness();
  try {
    h.advertiser.publish({ ...endpoint, token: "DO_NOT_ANNOUNCE" } as IrohDiscoveryEndpoint);
    const config = h.instances[0].configs[0];
    assert.equal(config.type, "fastvibe-iroh");
    assert.equal(config.protocol, "udp");
    assert.equal(config.port, 44444);
    assert.equal(config.name, "Office-Mac");
    assert.match(config.host, /^fastvibe-iroh-[a-f0-9-]+\.local$/);
    assert.deepEqual(config.txt, {
      v: "1", device_id: endpoint.deviceId, endpoint_id: endpoint.endpointId,
      addrs: "192.168.22.139:44444,[fd12::3]:55555",
    });
    assert.equal(JSON.stringify(config).includes("DO_NOT_ANNOUNCE"), false);
    assert.equal(config.disableIPv6, true);
    assert.deepEqual(h.instances[0].service.records(), [
      { type: "A", data: "192.168.22.139" },
      { type: "PTR", data: "instance" },
    ]);
  } finally { h.advertiser.stop(); }
});

test("IPv6-only discovery pairs its AAAA record with the IPv6 UDP socket port", () => {
  const h = harness();
  try {
    h.advertiser.publish({ ...endpoint, directAddresses: ["[fd12::3]:55555"] });
    const config = h.instances[0].configs[0];
    assert.equal(config.port, 55555);
    assert.equal(config.disableIPv6, false);
    assert.equal(config.txt.addrs, "[fd12::3]:55555");
    assert.deepEqual(h.instances[0].service.records(), [
      { type: "AAAA", data: "fd12::3" }, { type: "PTR", data: "instance" },
    ]);
  } finally { h.advertiser.stop(); }
});

test("no LAN claim is made for absent, public-STUN-only, unspecified or link-local addresses", () => {
  const h = harness();
  try {
    for (const directAddresses of [[], ["8.8.8.8:45000"], ["0.0.0.0:45000", "[::]:45000"],
      ["127.0.0.1:45000", "169.254.1.2:45000", "[fe80::1%en0]:45000", "[ff02::1]:45000"],
      ["192.168.1.1:0", "192.168.1.1:65536", "[::1]:45", "[::ffff:192.168.1.2]:45"]]) {
      h.advertiser.publish({ ...endpoint, directAddresses });
    }
    assert.equal(h.instances.length, 0);
    assert.equal(irohLanAdvertisement({ ...endpoint, endpointId: "wrong" }), null);
  } finally { h.advertiser.stop(); }
});

test("IPv4 and IPv6 route hints are bounded by TXT byte limits and address count", () => {
  const advertisement = irohLanAdvertisement({
    ...endpoint,
    directAddresses: Array.from({ length: 20 }, (_, i) => `[fd12:1234:5678:abcd:1234:5678:abcd:${i + 1}]:55555`),
  })!;
  assert.ok(advertisement.addresses.length > 1);
  assert.ok(advertisement.addresses.length <= 8);
  for (const [key, value] of Object.entries(advertisement.txt)) assert.ok(Buffer.byteLength(`${key}=${value}`) <= 255);
  assert.ok(advertisement.txt.addrs.split(",").every((address) => address.endsWith("]:55555")));
});

test("same descriptor is a no-op, while name, endpoint, port and address changes replace the record", () => {
  const h = harness();
  try {
    h.advertiser.publish(endpoint);
    h.advertiser.publish({ ...endpoint, directAddresses: [...endpoint.directAddresses].reverse() });
    assert.equal(h.instances.length, 1);
    h.advertiser.publish({ ...endpoint, name: "Renamed" });
    h.advertiser.publish({ ...endpoint, endpointId: "cd".repeat(32) });
    h.advertiser.publish({ ...endpoint, directAddresses: ["192.168.22.139:44445"] });
    h.advertiser.publish({ ...endpoint, directAddresses: ["192.168.22.140:44445"] });
    assert.equal(h.instances.length, 5);
    assert.ok(h.instances.slice(0, -1).every((instance) => instance.withdrawn && instance.destroyed));
    assert.ok(h.instances.every((instance) => instance.configs[0].host === h.instances[0].configs[0].host));
    h.advertiser.publish({ ...endpoint, directAddresses: [] });
    assert.ok(h.instances.at(-1)!.destroyed);
  } finally { h.advertiser.stop(); }
});

test("bind errors and late service callbacks cannot revive or withdraw a newer advertisement", () => {
  const h = harness();
  h.advertiser.publish(endpoint);
  const first = h.instances[0];
  first.error(new Error("bind denied"));
  assert.ok(first.destroyed);
  h.advertiser.publish(endpoint);
  const next = h.instances[1];
  first.service.emit("up");
  first.error(new Error("late error"));
  assert.equal(next.destroyed, false);
  next.service.emit("up");
  assert.equal(h.info.length, 1);
  h.advertiser.stop();
  next.service.emit("up");
  assert.equal(h.info.length, 1);
  assert.ok(next.withdrawn && next.destroyed);
  assert.equal(h.warnings.length, 1);
});

test("silent service name conflicts retry and stop cancels pending probes", (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const h = harness();
  try {
    h.advertiser.publish(endpoint);
    h.instances[0].service.activated = false;
    t.mock.timers.tick(2_000);
    assert.equal(h.instances.length, 2);
    assert.equal(h.instances[1].configs[0].name, "Office-Mac (2)");
    h.advertiser.stop();
    t.mock.timers.tick(20_000);
    assert.equal(h.instances.length, 2);
    assert.ok(h.instances.every((instance) => instance.destroyed));
  } finally { h.advertiser.stop(); }
});

test("synchronous publisher failures are contained", () => {
  const warnings: string[] = [];
  const advertiser = new IrohDiscoveryAdvertiser({
    log: { info() {}, warn: (message) => warnings.push(message) },
    create() { throw new Error("multicast unavailable"); },
  });
  assert.doesNotThrow(() => advertiser.publish(endpoint));
  assert.equal(warnings.length, 1);
  advertiser.stop();
});
