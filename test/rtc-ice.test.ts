import { test } from "node:test";
import assert from "node:assert/strict";
import { iceExpiry, stunServers, toIceServers } from "../src/main/rtc/ice.ts";

test("the cloud's answer becomes STUN and TURN entries with the credential kept intact", () => {
  const password = "a+b/c==";
  const servers = toIceServers({
    ice_servers: [
      { urls: ["stun:turn.example.com:3478"] },
      {
        urls: ["turn:turn.example.com:3478?transport=udp", "turn:turn.example.com:3478?transport=tcp"],
        username: "1790000000:user-id",
        credential: password,
      },
    ],
    relay_exhausted: false,
  });
  assert.deepEqual(servers, [
    { hostname: "turn.example.com", port: 3478 },
    // The TCP form is left to the phone: libdatachannel's libjuice has no TURN over TCP.
    { hostname: "turn.example.com", port: 3478, username: "1790000000:user-id", password, relayType: "TurnUdp" },
  ]);
});

test("a TURN entry without credentials is dropped, a STUN one needs none", () => {
  assert.deepEqual(toIceServers({ ice_servers: [{ urls: "turn:t.example.com" }, { urls: "stun:s.example.com" }] }), [
    { hostname: "s.example.com", port: 3478 },
  ]);
});

test("ports default, IPv6 literals unwrap, and junk is skipped", () => {
  assert.deepEqual(toIceServers({ ice_servers: [{ urls: ["stun:[2001:db8::1]:19302", "stun:host", "http://x", "stun:h:99999", 7] }] }), [
    { hostname: "2001:db8::1", port: 19302 },
    { hostname: "host", port: 3478 },
  ]);
  assert.deepEqual(toIceServers(null), []);
  assert.deepEqual(toIceServers({ ice_servers: "nope" }), []);
  assert.deepEqual(toIceServers({ ice_servers: [] }), []);
});

test("the desktop gathers with STUN alone, and a relay's address serves as one", () => {
  const servers = toIceServers({
    ice_servers: [
      { urls: ["stun:turn.example.com:3478"] },
      { urls: ["turn:turn.example.com:3478?transport=udp"], username: "u", credential: "p" },
      { urls: ["turn:other.example.com:3479"], username: "u", credential: "p" },
    ],
  });
  assert.deepEqual(stunServers(servers), [
    { hostname: "turn.example.com", port: 3478 },
    { hostname: "other.example.com", port: 3479 },
  ]);
  assert.deepEqual(stunServers([]), []);
});

test("the expiry is read when the service gives one", () => {
  assert.equal(iceExpiry({ expires_at: "2026-10-10T02:00:00Z" }), Date.parse("2026-10-10T02:00:00Z"));
  assert.equal(iceExpiry({ expires_at: "soon" }), null);
  assert.equal(iceExpiry({}), null);
  assert.equal(iceExpiry(null), null);
});
