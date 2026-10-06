import assert from "node:assert/strict";
import test from "node:test";
import { randomUUID } from "../src/shared/random.ts";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

test("randomUUID uses the native implementation when available", () => {
  assert.equal(randomUUID({ randomUUID: () => "native-id" }), "native-id");
});

test("randomUUID builds a v4 UUID when randomUUID is unavailable", () => {
  const id = randomUUID({
    getRandomValues: (bytes) => {
      bytes.fill(0);
      return bytes;
    },
  });
  assert.match(id, UUID);
  assert.equal(id, "00000000-0000-4000-8000-000000000000");
});

test("randomUUID still returns a UUID-shaped id without Web Crypto", () => {
  assert.match(randomUUID({}), UUID);
});
