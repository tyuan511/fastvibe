import { test } from "node:test";
import assert from "node:assert/strict";
import { isReachableFromAnotherDevice } from "../src/renderer/src/lib/address-reachability.ts";

/**
 * This decides whether a settings row draws a QR icon at all, and it has already been
 * wrong once in a way nothing else could catch: the pane offered a code for
 * `127.0.0.1:7777`, which scans perfectly and then fails with 连接被拒绝 on the phone.
 * The rules are asserted here because the alternative check — pointing a camera at the
 * screen — is not a thing a test can do.
 */

test("loopback is not reachable from another device", () => {
  for (const address of ["127.0.0.1:7777", "127.0.0.1", "localhost:7777", "localhost", "127.1.2.3:80"]) {
    assert.equal(isReachableFromAnotherDevice(address), false, `${address} should not be scannable`);
  }
});

test("a LAN address or hostname is reachable", () => {
  for (const address of ["192.168.31.45:7777", "10.0.0.7:7777", "172.16.31.4:7777", "mac-mini.local:7777"]) {
    assert.equal(isReachableFromAnotherDevice(address), true, `${address} should be scannable`);
  }
});

test("a tunnel hostname is reachable, scheme or not", () => {
  for (const address of [
    "fluffy-panda-rides-again.trycloudflare.com",
    "foo.ngrok-free.app",
    "fastvibe.example.com:8080",
  ]) {
    assert.equal(isReachableFromAnotherDevice(address), true, `${address} should be scannable`);
  }
});

test("a 127-looking hostname is not loopback, and must not be hidden", () => {
  // `127.example.com` is a public name; the same distinction `shared/proxy.ts` draws for
  // proxy bypass rules. Matching on the prefix would suppress a code that works.
  assert.equal(isReachableFromAnotherDevice("127.example.com:7777"), true);
});

test("IPv6 loopback is not reachable, other IPv6 is", () => {
  assert.equal(isReachableFromAnotherDevice("[::1]:7777"), false);
  assert.equal(isReachableFromAnotherDevice("::1"), false);
  assert.equal(isReachableFromAnotherDevice("[::ffff:127.0.0.1]:7777"), false);
  assert.equal(isReachableFromAnotherDevice("[2001:db8::7]:7777"), true);
  assert.equal(isReachableFromAnotherDevice("[fe80::1]:7777"), true);
});

test("an address that cannot be parsed is treated as reachable", () => {
  // Refusing a code for something merely unrecognised is worse than showing one that
  // might not work — nothing here is a security boundary, and the address is printed
  // beside the icon either way.
  assert.equal(isReachableFromAnotherDevice(""), true);
  assert.equal(isReachableFromAnotherDevice("not a host!!"), true);
});
