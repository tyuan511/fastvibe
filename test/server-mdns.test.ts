import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import os, { hostname } from "node:os";
import { Service } from "bonjour-service";
import { MdnsAdvertiser, MDNS_SERVICE_TYPE, mdnsInstanceName, type BonjourLike } from "../src/main/server/mdns.ts";

/**
 * The mDNS announcement, against a recording stand-in for `bonjour-service`.
 *
 * What is pinned is what fails silently: a name that still carries `.local` on every row
 * of the phone's list, a republish that leaves two records for one server, a withdrawn
 * announcement that keeps a ghost row alive until its TTL, and a multicast failure that
 * takes remote access down with it.
 */

const silent = { info: () => undefined, warn: () => undefined };

function fake(options: { pending?: boolean; publishError?: boolean } = {}) {
  const calls: string[] = [];
  const published: Parameters<BonjourLike["publish"]>[0][] = [];
  const services: Service[] = [];
  const errors: ((error: unknown) => void)[] = [];
  let instances = 0;
  const create = (onError: (error: unknown) => void): BonjourLike => {
    const id = ++instances;
    errors.push(onError);
    return {
      publish(config) {
        published.push(config);
        calls.push(`publish#${id}:${config.port}`);
        if (options.publishError) throw new Error("publish failed");
        const service = new Service(config, () => undefined, () => undefined);
        service.activated = true;
        service.published = !options.pending;
        services.push(service);
        return service;
      },
      unpublishAll(callback) {
        calls.push(`unpublish#${id}`);
        callback?.();
      },
      destroy() {
        calls.push(`destroy#${id}`);
      },
    };
  };
  return { create, calls, published, services, errors };
}

test("the instance name is the host name without the mDNS suffix", () => {
  assert.equal(mdnsInstanceName("Yuans-MacBook-Pro.local"), "Yuans-MacBook-Pro");
  assert.equal(mdnsInstanceName("build-box.LOCAL."), "build-box");
  assert.equal(mdnsInstanceName("  desk  "), "desk");
  assert.equal(mdnsInstanceName("my.server.example"), "my-server-example");
  assert.equal(mdnsInstanceName(""), "FastVibe");
  assert.equal(mdnsInstanceName(".local"), "FastVibe");
});

test("publishes _fastvibe._tcp under the host name", () => {
  const f = fake();
  const advertiser = new MdnsAdvertiser({ log: silent, create: f.create, hostName: () => "Desk.local" });
  advertiser.publish(7777);
  const host = f.published[0]?.host;
  assert.match(host, /^fastvibe-[a-f0-9-]+\.local$/);
  assert.deepEqual(f.published, [{ name: "Desk", host, type: MDNS_SERVICE_TYPE, port: 7777, txt: { v: "1" }, disableIPv6: true }]);
  assert.equal(advertiser.port, 7777);
  assert.equal(advertiser.name, "Desk");
});

test("the actual DNS records never claim the operating system's hostname", () => {
  const f = fake();
  const advertiser = new MdnsAdvertiser({ log: silent, create: f.create });
  advertiser.publish(7777);
  // Exercise the installed library's record builder, not only the config passed to it.
  const records = new Service(f.published[0], () => undefined, () => undefined).records();
  const target = f.published[0].host;
  assert.notEqual(target, hostname());
  assert.equal(records.find((record) => record.type === "SRV")?.data.target, target);
  for (const record of records.filter((record) => record.type === "A" || record.type === "AAAA")) {
    assert.equal(record.name, target);
    assert.notEqual(record.name, hostname());
  }
  advertiser.publish(8888);
  assert.equal(f.published[1].host, target, "rebinding retains the application's own target");
  const other = new MdnsAdvertiser({ log: silent, create: f.create });
  other.publish(7777);
  assert.notEqual(f.published[2].host, target, "two instances must not claim each other's addresses");
});

test("an IPv4 listener never offers Android an unreachable IPv6 address", (t) => {
  t.mock.method(os, "networkInterfaces", () => ({
    en0: [
      { address: "fe80::1234", family: "IPv6", internal: false, mac: "00:11:22:33:44:55" },
      { address: "192.168.22.139", family: "IPv4", internal: false, mac: "00:11:22:33:44:55" },
    ],
    bridge100: [
      { address: "fd07:b51a::1", family: "IPv6", internal: false, mac: "00:11:22:33:44:66" },
    ],
  }));
  const f = fake();
  const advertiser = new MdnsAdvertiser({ log: silent, create: f.create });
  advertiser.publish(7777);
  const records = new Service(f.published[0], () => undefined, () => undefined).records();
  assert.deepEqual(records.filter((record) => record.type === "AAAA"), []);
  assert.deepEqual(records.filter((record) => record.type === "A").map((record) => record.data), ["192.168.22.139"]);
});

test("changing address family replaces the record even on the same port", () => {
  const f = fake();
  const advertiser = new MdnsAdvertiser({ log: silent, create: f.create });
  advertiser.publish(7777, "Desk", "ipv4");
  advertiser.publish(7777, "Desk", "ipv6");
  assert.deepEqual(f.calls, ["publish#1:7777", "unpublish#1", "destroy#1", "publish#2:7777"]);
  assert.equal(f.published[0].disableIPv6, true);
  assert.equal(f.published[1].disableIPv6, false);
  advertiser.publish(7777, "Desk", "ipv6");
  assert.equal(f.published.length, 2);
});

test("IPv6 selection advertises only AAAA records, including subsequent record builds", (t) => {
  t.mock.method(os, "networkInterfaces", () => ({
    en0: [
      { address: "192.168.22.139", family: "IPv4", internal: false, mac: "00:11:22:33:44:55" },
      { address: "fd07:b51a::1234", family: "IPv6", internal: false, mac: "00:11:22:33:44:55" },
    ],
  }));
  const f = fake();
  const advertiser = new MdnsAdvertiser({ log: silent, create: f.create });
  advertiser.publish(7777, "Desk", "ipv6");
  for (let i = 0; i < 2; i++) {
    const records = f.services[0].records();
    assert.deepEqual(records.filter((record) => record.type === "A"), []);
    assert.deepEqual(records.filter((record) => record.type === "AAAA").map((record) => record.data), ["fd07:b51a::1234"]);
    assert.deepEqual(records.filter((record) => record.type !== "AAAA").map((record) => record.type), ["PTR", "SRV", "TXT", "PTR"]);
  }
  advertiser.publish(7777, "Desk", "ipv4");
  const records = f.services[1].records();
  assert.deepEqual(records.filter((record) => record.type === "AAAA"), []);
  assert.deepEqual(records.filter((record) => record.type === "A").map((record) => record.data), ["192.168.22.139"]);
});

test("publishing the same port again is a no-op; a new port replaces the record", () => {
  const f = fake();
  const advertiser = new MdnsAdvertiser({ log: silent, create: f.create, hostName: () => "Desk" });
  advertiser.publish(7777);
  advertiser.publish(7777);
  assert.deepEqual(f.calls, ["publish#1:7777"]);
  advertiser.publish(8888);
  assert.deepEqual(f.calls, ["publish#1:7777", "unpublish#1", "destroy#1", "publish#2:8888"]);
  assert.equal(advertiser.port, 8888);
});

test("unpublish says goodbye, closes the socket, and is safe to repeat", () => {
  const f = fake();
  const advertiser = new MdnsAdvertiser({ log: silent, create: f.create, hostName: () => "Desk" });
  advertiser.unpublish();
  assert.deepEqual(f.calls, []);
  advertiser.publish(7777);
  advertiser.unpublish();
  advertiser.unpublish();
  assert.deepEqual(f.calls, ["publish#1:7777", "unpublish#1", "destroy#1"]);
  assert.equal(advertiser.port, null);
  advertiser.publish(7777);
  assert.equal(f.calls.at(-1), "publish#2:7777");
});

test("a failure to announce is logged, not thrown, and leaves nothing published", () => {
  const warnings: string[] = [];
  const advertiser = new MdnsAdvertiser({
    log: { info: () => undefined, warn: (m) => warnings.push(m) },
    create: () => {
      throw new Error("multicast is filtered");
    },
  });
  assert.doesNotThrow(() => advertiser.publish(7777));
  assert.equal(advertiser.port, null);
  assert.match(warnings[0] ?? "", /multicast is filtered/);
});

test("a synchronous publish failure releases the socket and permits retry", () => {
  const options = { publishError: true };
  const f = fake(options);
  const advertiser = new MdnsAdvertiser({ log: silent, create: f.create });
  assert.doesNotThrow(() => advertiser.publish(7777));
  assert.deepEqual(f.calls, ["publish#1:7777", "unpublish#1", "destroy#1"]);
  assert.equal(advertiser.port, null);
  options.publishError = false;
  advertiser.publish(7777);
  assert.equal(advertiser.port, 7777);
});

test("an announcement is only reported after up, and repeated status pushes do not restart probing", (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const f = fake({ pending: true });
  const announced: string[] = [];
  const advertiser = new MdnsAdvertiser({ log: { ...silent, info: (m) => announced.push(m) }, create: f.create });
  advertiser.publish(7777);
  advertiser.publish(7777);
  assert.equal(f.published.length, 1);
  assert.equal(advertiser.port, null);
  assert.equal(advertiser.name, null);
  assert.deepEqual(announced, []);
  f.services[0].published = true;
  f.services[0].emit("up");
  assert.equal(advertiser.port, 7777);
  assert.equal(announced.length, 1);
  t.mock.timers.tick(10_000);
  assert.equal(advertiser.port, 7777);
  advertiser.unpublish();
});

test("a silent name conflict retries with a suffix and eventually announces", (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const f = fake({ pending: true });
  const advertiser = new MdnsAdvertiser({ log: silent, create: f.create, hostName: () => "Desk.local" });
  advertiser.publish(7777);
  // bonjour-service stops on conflict; it emits neither 'error' nor 'down'.
  f.services[0].activated = false;
  t.mock.timers.tick(2_000);
  assert.deepEqual(f.calls, ["publish#1:7777", "unpublish#1", "destroy#1", "publish#2:7777"]);
  assert.equal(f.published[1].name, "Desk (2)");
  assert.equal(advertiser.port, null);
  f.services[1].published = true;
  f.services[1].emit("up");
  assert.equal(advertiser.name, "Desk (2)");
  assert.equal(advertiser.port, 7777);
  advertiser.unpublish();
});

test("name conflicts stop after a bounded number of attempts", (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const f = fake({ pending: true });
  const warnings: string[] = [];
  const advertiser = new MdnsAdvertiser({ log: { ...silent, warn: (m) => warnings.push(m) }, create: f.create });
  advertiser.publish(7777);
  for (let i = 0; i < 5; i++) {
    f.services[i].activated = false;
    t.mock.timers.tick(2_000);
  }
  assert.equal(f.published.length, 5);
  assert.equal(advertiser.port, null);
  assert.equal(f.calls.at(-1), "destroy#5");
  assert.match(warnings.at(-1)!, /service names occupied/);
});

test("late events from a replaced or withdrawn service cannot restore its state", (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const f = fake({ pending: true });
  const advertiser = new MdnsAdvertiser({ log: silent, create: f.create });
  advertiser.publish(7777);
  advertiser.publish(8888);
  f.services[1].published = true;
  f.services[1].emit("up");
  f.services[0].emit("up");
  f.errors[0](new Error("late socket error"));
  assert.equal(advertiser.port, 8888);
  advertiser.unpublish();
  f.services[1].emit("up");
  t.mock.timers.tick(10_000);
  assert.equal(advertiser.port, null);
  assert.equal(advertiser.name, null);
  assert.equal(f.published.length, 2);
});

test("withdrawing during a conflicted probe cancels the retry", (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const f = fake({ pending: true });
  const advertiser = new MdnsAdvertiser({ log: silent, create: f.create });
  advertiser.publish(7777);
  f.services[0].activated = false;
  advertiser.unpublish();
  t.mock.timers.tick(10_000);
  assert.equal(f.published.length, 1);
  assert.equal(advertiser.port, null);
});

test("a stalled probe is cleaned up and can be retried", (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const f = fake({ pending: true });
  const advertiser = new MdnsAdvertiser({ log: silent, create: f.create });
  advertiser.publish(7777);
  t.mock.timers.tick(2_000);
  assert.equal(advertiser.port, null);
  assert.equal(f.calls.at(-1), "destroy#1");
  advertiser.publish(7777);
  assert.equal(f.published.length, 2);
  advertiser.unpublish();
});

test("socket and service errors clear the announcement and allow another publish", () => {
  const f = fake();
  const advertiser = new MdnsAdvertiser({ log: silent, create: f.create });
  advertiser.publish(7777);
  f.errors[0](new Error("EADDRINUSE"));
  assert.equal(advertiser.port, null);
  advertiser.publish(7777);
  f.services[1].emit("error", new Error("network unavailable"));
  assert.equal(advertiser.port, null);
  advertiser.publish(7777);
  assert.equal(advertiser.port, 7777);
  assert.equal(f.published.length, 3);
});

test("destroy failures in an asynchronous goodbye callback cannot escape", () => {
  let goodbye: (() => void) | undefined;
  const advertiser = new MdnsAdvertiser({
    log: silent,
    create: () => ({
      publish: () => Object.assign(new EventEmitter(), { activated: true, published: true, records: () => [] }),
      unpublishAll: (callback) => { goodbye = callback; },
      destroy: () => { throw new Error("socket never bound"); },
    }),
  });
  advertiser.publish(7777);
  advertiser.unpublish();
  assert.ok(goodbye);
  assert.doesNotThrow(goodbye);
  assert.equal(advertiser.port, null);
});

test("renaming on the same port replaces the announcement and resetting restores the default", () => {
  const f = fake();
  const advertiser = new MdnsAdvertiser({ log: silent, create: f.create, hostName: () => "Desk.local" });
  advertiser.publish(7777);
  advertiser.publish(7777, "  工作电脑  ");
  assert.equal(advertiser.name, "工作电脑");
  assert.deepEqual(f.calls, ["publish#1:7777", "unpublish#1", "destroy#1", "publish#2:7777"]);
  assert.equal(f.published[0].host, f.published[1].host);
  advertiser.publish(7777, "工作电脑");
  assert.equal(f.published.length, 2);
  advertiser.publish(7777, "");
  assert.equal(advertiser.name, "Desk");
  assert.equal(f.published.length, 3);
});

test("a long custom name leaves room for the conflict suffix and stays idempotent", (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const f = fake({ pending: true });
  const advertiser = new MdnsAdvertiser({ log: silent, create: f.create });
  const name = "机".repeat(21);
  advertiser.publish(7777, name);
  f.services[0].activated = false;
  t.mock.timers.tick(2_000);
  assert.equal(f.published[1].name, `${"机".repeat(19)} (2)`);
  assert.ok(Buffer.byteLength(f.published[1].name) <= 63);
  advertiser.publish(7777, name);
  assert.equal(f.published.length, 2, "status pushes retain the conflict-adjusted name");
  advertiser.unpublish();
});

test("renaming during a conflicting probe cancels retries for the old name", (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const f = fake({ pending: true });
  const advertiser = new MdnsAdvertiser({ log: silent, create: f.create });
  advertiser.publish(7777, "Old");
  f.services[0].activated = false;
  advertiser.publish(7777, "New");
  f.services[1].published = true;
  f.services[1].emit("up");
  f.services[0].emit("up");
  t.mock.timers.tick(10_000);
  assert.equal(advertiser.name, "New");
  assert.equal(f.published.length, 2);
  advertiser.unpublish();
});
