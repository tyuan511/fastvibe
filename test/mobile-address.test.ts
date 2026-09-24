import assert from "node:assert/strict";
import { test } from "node:test";
import { parseServerAddress } from "../apps/mobile/src/protocol/address.ts";

test("a tunnel QR is an https origin", () => {
  const parsed = parseServerAddress("https://foo.trycloudflare.com/");
  assert.equal(parsed?.origin, "https://foo.trycloudflare.com");
  assert.equal(parsed?.wsUrl, "wss://foo.trycloudflare.com/ws");
  assert.equal(parsed?.kind, "public");
});

test("the LAN address copied from settings needs no scheme", () => {
  const parsed = parseServerAddress("192.168.31.45:7777");
  assert.equal(parsed?.origin, "http://192.168.31.45:7777");
  assert.equal(parsed?.wsUrl, "ws://192.168.31.45:7777/ws");
  assert.equal(parsed?.kind, "lan");
});

test("a typed LAN host without a port uses FastVibe's default", () => {
  const parsed = parseServerAddress("10.0.0.8");
  assert.equal(parsed?.origin, "http://10.0.0.8:7777");
  assert.equal(parsed?.kind, "lan");
});

test("an explicit http LAN URL is kept", () => {
  const parsed = parseServerAddress("http://172.16.4.2:7777/mobile.html");
  assert.equal(parsed?.origin, "http://172.16.4.2:7777");
  assert.equal(parsed?.kind, "lan");
});

test("a bare public hostname is https", () => {
  const parsed = parseServerAddress("foo.ngrok-free.app");
  assert.equal(parsed?.origin, "https://foo.ngrok-free.app");
  assert.equal(parsed?.kind, "public");
});

test("mDNS names are LAN http", () => {
  const parsed = parseServerAddress("mac-mini.local:7777");
  assert.equal(parsed?.origin, "http://mac-mini.local:7777");
  assert.equal(parsed?.kind, "lan");
});

test("loopback is recognised so a phone is not sent to itself", () => {
  assert.equal(parseServerAddress("127.0.0.1:7777")?.kind, "loopback");
  assert.equal(parseServerAddress("localhost")?.kind, "loopback");
});

test("rejects a non-http scheme and an empty string", () => {
  assert.equal(parseServerAddress(""), null);
  assert.equal(parseServerAddress("ftp://192.168.1.2"), null);
});
