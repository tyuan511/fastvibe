import assert from "node:assert/strict";
import test from "node:test";
import { formatRemoteAddress, remoteQrValue } from "../src/shared/remote-address.ts";

test("remote addresses keep IPv4 in host:port form", () => {
  assert.equal(formatRemoteAddress("192.168.1.20", 7777), "192.168.1.20:7777");
  assert.equal(formatRemoteAddress("192.168.1.20", 7777, true), "192.168.1.20:7777");
});

test("remote addresses bracket IPv6 and encode a link-local zone for URLs", () => {
  assert.equal(formatRemoteAddress("fe80::20%en0", 7777), "[fe80::20%en0]:7777");
  assert.equal(formatRemoteAddress("fe80::20%en0", 7777, true), "[fe80::20%25en0]:7777");
});

test("QR URLs carry the saved device name without changing the connection address", () => {
  const value = remoteQrValue("http://192.168.22.139:7777", "  tangge mbp  ");
  assert.equal(value, "http://192.168.22.139:7777?name=tangge+mbp");
  assert.equal(new URL(value).origin, "http://192.168.22.139:7777");
  const unicode = new URL(remoteQrValue("https://desk.example.com", "工作电脑 & #1 + 🖥"));
  assert.equal(unicode.searchParams.get("name"), "工作电脑 & #1 + 🖥");
});

test("QR names preserve IPv6 zones, existing query parameters and fragments", () => {
  assert.equal(remoteQrValue("http://[fe80::20%25en0]:7777", "Desk"), "http://[fe80::20%25en0]:7777?name=Desk");
  assert.equal(
    remoteQrValue("https://desk.example.com/remote.html?view=mobile&name=old#/chat", "New"),
    "https://desk.example.com/remote.html?view=mobile&name=New#/chat",
  );
});

test("a QR without a device name remains the original URL", () => {
  assert.equal(remoteQrValue("https://desk.example.com/"), "https://desk.example.com/");
  assert.equal(remoteQrValue("https://desk.example.com/", "  "), "https://desk.example.com/");
});
