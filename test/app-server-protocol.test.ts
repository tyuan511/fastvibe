import assert from "node:assert/strict";
import test from "node:test";
import {
  ALL_SCOPES,
  APP_PROTOCOL,
  APP_PROTOCOL_VERSION,
  isValidAppScope,
  isValidEventCursor,
  isValidRequestId,
  readClientMessage,
} from "../src/shared/app-protocol.ts";

test("legacy id/method frames are not canonical", () => {
  assert.equal(readClientMessage({ id: 1, method: "engine:prompt" }), null);
  assert.equal(readClientMessage({ type: "auth", token: "x" }), null);
});

test("hello requires protocol, integer version, and a named client", () => {
  const hello = {
    protocol: APP_PROTOCOL,
    protocolVersion: APP_PROTOCOL_VERSION,
    client: { kind: "browser", version: "0.7.0" },
  };
  assert.deepEqual(readClientMessage({ kind: "hello", hello }), { kind: "hello", hello });

  assert.equal(readClientMessage({ kind: "hello", hello: { ...hello, protocolVersion: 1.5 } }), null);
  assert.equal(readClientMessage({ kind: "hello", hello: { ...hello, client: { kind: "", version: "1" } } }), null);
  assert.equal(readClientMessage({ kind: "hello", hello: { ...hello, client: { kind: "browser" } } }), null);
  assert.equal(readClientMessage({ kind: "hello" }), null);
});

test("hello drops unknown capabilities and rejects a non-array list", () => {
  const parsed = readClientMessage({
    kind: "hello",
    hello: {
      protocol: APP_PROTOCOL,
      protocolVersion: 1,
      client: { kind: "cli", version: "1" },
      capabilities: ["engine", "not-real", "native"],
    },
  });
  assert.ok(parsed && parsed.kind === "hello");
  assert.deepEqual(parsed.hello.capabilities, ["engine", "native"]);
  assert.equal(
    readClientMessage({
      kind: "hello",
      hello: {
        protocol: APP_PROTOCOL,
        protocolVersion: 1,
        client: { kind: "cli", version: "1" },
        capabilities: "engine",
      },
    }),
    null,
  );
});

test("call and query require a safe request id and a method", () => {
  assert.deepEqual(readClientMessage({ kind: "query", requestId: 0, method: "engine:get-state" }), {
    kind: "query",
    requestId: 0,
    method: "engine:get-state",
    payload: undefined,
  });
  assert.equal(readClientMessage({ kind: "call", requestId: -1, method: "engine:prompt" }), null);
  assert.equal(readClientMessage({ kind: "call", requestId: 1.2, method: "engine:prompt" }), null);
  assert.equal(readClientMessage({ kind: "call", requestId: 1, method: "" }), null);
  assert.equal(readClientMessage({ kind: "query", requestId: 1, method: "engine:prompt", idempotencyKey: "k" }), null);
  assert.equal(readClientMessage({ kind: "call", requestId: 1, method: "engine:prompt", idempotencyKey: "" }), null);
  const call = readClientMessage({
    kind: "call",
    requestId: 3,
    method: "engine:prompt",
    payload: { x: 1 },
    idempotencyKey: "retry-1",
  });
  assert.deepEqual(call, {
    kind: "call",
    requestId: 3,
    method: "engine:prompt",
    payload: { x: 1 },
    idempotencyKey: "retry-1",
  });
});

test("subscribe since must be epoch+seq cursors on valid scopes", () => {
  assert.equal(readClientMessage({ kind: "subscribe", scopes: ["nope"] }), null);
  assert.equal(readClientMessage({ kind: "subscribe", scopes: [ALL_SCOPES, "installation"] })?.kind, "subscribe");
  assert.equal(
    readClientMessage({
      kind: "subscribe",
      scopes: ["installation"],
      since: { installation: 4 },
    }),
    null,
  );
  const parsed = readClientMessage({
    kind: "subscribe",
    scopes: ["conversation:abc", ALL_SCOPES],
    since: { "conversation:abc": { epoch: "ep", seq: 4 } },
  });
  assert.ok(parsed && parsed.kind === "subscribe");
  assert.deepEqual(parsed.since, { "conversation:abc": { epoch: "ep", seq: 4 } });
});

test("cancel and ping are strict", () => {
  assert.deepEqual(readClientMessage({ kind: "ping" }), { kind: "ping" });
  assert.equal(readClientMessage({ kind: "pong" }), null);
  assert.equal(readClientMessage({ kind: "cancel", targetRequestId: -3 }), null);
  assert.deepEqual(readClientMessage({ kind: "cancel", targetRequestId: 9, reason: "gone" }), {
    kind: "cancel",
    targetRequestId: 9,
    reason: "gone",
  });
});

test("scope and cursor helpers", () => {
  assert.equal(isValidAppScope("*"), true);
  assert.equal(isValidAppScope("installation"), true);
  assert.equal(isValidAppScope("conversation:"), false);
  assert.equal(isValidAppScope("workspace:proj"), true);
  assert.equal(isValidAppScope("resource:r1"), true);
  assert.equal(isValidEventCursor({ epoch: "e", seq: 0 }), true);
  assert.equal(isValidEventCursor({ epoch: "e", seq: -1 }), false);
  assert.equal(isValidRequestId(0), true);
  assert.equal(isValidRequestId(Number.MAX_SAFE_INTEGER + 1), false);
});
