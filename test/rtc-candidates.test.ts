import assert from "node:assert/strict";
import { test } from "node:test";
import { usableRemoteCandidate } from "../src/main/rtc/responder.ts";

test("only UDP candidates that another machine can reach are kept", () => {
  assert.equal(usableRemoteCandidate("candidate:1 1 udp 2122260223 192.168.1.5 54321 typ host"), true);
  assert.equal(usableRemoteCandidate("a=candidate:2 1 UDP 1686052607 203.0.113.9 40000 typ srflx raddr 0.0.0.0 rport 0"), true);
  assert.equal(usableRemoteCandidate("candidate:3 1 udp 41885439 198.51.100.2 50000 typ relay raddr 0.0.0.0 rport 0"), true);
  assert.equal(usableRemoteCandidate("candidate:4 1 tcp 1518280447 192.168.1.5 9 typ host tcptype active"), false);
  assert.equal(usableRemoteCandidate("candidate:5 1 udp 2122194687 fe80::1 54322 typ host"), false);
  assert.equal(usableRemoteCandidate("candidate:6 1 udp 2130706431 127.0.0.1 44323 typ host"), false);
  assert.equal(usableRemoteCandidate("candidate:7 1 udp 2130706431 ::1 40791 typ host"), false);
  assert.equal(usableRemoteCandidate("garbage"), false);
});
