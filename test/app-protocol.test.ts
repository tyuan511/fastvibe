import assert from "node:assert/strict";
import test from "node:test";
import {
  APP_CAPABILITIES,
  APP_PROTOCOL,
  APP_PROTOCOL_VERSION,
  intersectCapabilities,
  isAppCapability,
  isProtocolCompatible,
  isValidServerInstanceId,
  newServerInstanceId,
  readHandshake,
} from "../src/shared/app-protocol.ts";

test("a minted server id is valid and recognisable", () => {
  const id = newServerInstanceId(() => "abcdef01-2345-6789-abcd-ef0123456789");
  assert.equal(id, "srv_abcdef0123456789abcd");
  assert.equal(isValidServerInstanceId(id), true);
  assert.equal(id.startsWith("srv_"), true);
});

test("a server id never carries the separator the composite keys split on", () => {
  // Every binding and namespaced conversation id is `remote:<server>:<local>`, and the
  // split happens at the server half — so a minted id containing `:` would make those
  // keys ambiguous. The generator strips everything outside its own character set.
  const id = newServerInstanceId(() => "a:b/c d:e");
  assert.equal(isValidServerInstanceId(id), true);
  assert.equal(id.includes(":"), false);
});

test("server ids reject what would break a composite key", () => {
  assert.equal(isValidServerInstanceId(""), false);
  assert.equal(isValidServerInstanceId("srv:one"), false);
  assert.equal(isValidServerInstanceId("-leading"), false);
  assert.equal(isValidServerInstanceId("has space"), false);
  assert.equal(isValidServerInstanceId("x".repeat(65)), false);
  assert.equal(isValidServerInstanceId(42), false);
  assert.equal(isValidServerInstanceId("srv.ok-1_2"), true);
  assert.equal(isValidServerInstanceId("x".repeat(64)), true);
});

test("capabilities are a closed vocabulary", () => {
  assert.equal(isAppCapability("terminal"), true);
  assert.equal(isAppCapability("browser"), true);
  assert.equal(isAppCapability("not_a_capability"), false);
  assert.equal(isAppCapability(7), false);
  // The two that genuinely differ between a desktop and a headless Agent.
  assert.equal(APP_CAPABILITIES.includes("browser"), true);
  assert.equal(APP_CAPABILITIES.includes("native"), true);
});

test("capabilities intersect rather than trust either end", () => {
  const server = ["conversations", "engine", "browser", "native"] as const;
  // A client that declares nothing accepts what the server offers.
  assert.deepEqual(intersectCapabilities(server), [...server]);
  // A client with no <webview> narrows it, which is the whole point of declaring.
  assert.deepEqual(intersectCapabilities(server, ["conversations", "engine", "terminal"]), [
    "conversations",
    "engine",
  ]);
  assert.deepEqual(intersectCapabilities(server, []), [...server]);
});

test("a well-formed handshake is read, and a malformed one is refused", () => {
  const valid = {
    protocol: APP_PROTOCOL,
    protocolVersion: 1,
    server: { serverInstanceId: "srv_remote1", version: "0.8.0", platform: "linux" },
    capabilities: ["engine", "terminal", "not_a_capability"],
  };
  const handshake = readHandshake(valid);
  assert.ok(handshake);
  assert.equal(handshake.server.serverInstanceId, "srv_remote1");
  // Unknown capabilities are dropped, not fatal: a server ahead of this client is the
  // normal case, and refusing the handshake over one would be refusing the peer.
  assert.deepEqual(handshake.capabilities, ["engine", "terminal"]);

  assert.equal(readHandshake(null), null);
  assert.equal(readHandshake({ ...valid, protocol: "someone.else" }), null);
  assert.equal(readHandshake({ ...valid, protocolVersion: "1" }), null);
  // An id that could not be embedded in a composite key makes the server unaddressable.
  assert.equal(readHandshake({ ...valid, server: { serverInstanceId: "srv:bad" } }), null);
  assert.equal(readHandshake({ ...valid, server: undefined }), null);
});

test("only exact protocol version 1 is compatible", () => {
  const base = {
    protocol: APP_PROTOCOL,
    protocolVersion: APP_PROTOCOL_VERSION,
    server: { serverInstanceId: "srv_remote1", version: "1", platform: "linux" },
    capabilities: [],
  };
  assert.equal(isProtocolCompatible(base), true);
  assert.equal(isProtocolCompatible({ ...base, protocolVersion: 0 }), false);
  assert.equal(isProtocolCompatible({ ...base, protocolVersion: APP_PROTOCOL_VERSION + 1 }), false);
  assert.equal(isProtocolCompatible({ ...base, protocol: "other.app" }), false);
});
