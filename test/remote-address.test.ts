import assert from "node:assert/strict";
import test from "node:test";
import { formatRemoteAddress } from "../src/shared/remote-address.ts";

test("remote addresses keep IPv4 in host:port form", () => {
  assert.equal(formatRemoteAddress("192.168.1.20", 7777), "192.168.1.20:7777");
  assert.equal(formatRemoteAddress("192.168.1.20", 7777, true), "192.168.1.20:7777");
});

test("remote addresses bracket IPv6 and encode a link-local zone for URLs", () => {
  assert.equal(formatRemoteAddress("fe80::20%en0", 7777), "[fe80::20%en0]:7777");
  assert.equal(formatRemoteAddress("fe80::20%en0", 7777, true), "[fe80::20%25en0]:7777");
});
