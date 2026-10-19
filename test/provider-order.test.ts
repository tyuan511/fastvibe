import assert from "node:assert/strict";
import test from "node:test";
import { orderProviders } from "../src/shared/model-order.ts";

const providers = [
  { id: "a", models: ["a-model"] },
  { id: "b", models: ["b-model"] },
  { id: "c", models: ["c-model"] },
  { id: "new", models: ["new-model"] },
];

test("a stale or filtered provider order retains every current provider exactly once", () => {
  const ordered = orderProviders(providers, ["c", "deleted", "a", "c"]);
  assert.deepEqual(ordered.map((provider) => provider.id), ["c", "a", "b", "new"]);
  assert.equal(ordered[0], providers[2], "reordering preserves the provider's configuration");
  assert.deepEqual(providers.map((provider) => provider.id), ["a", "b", "c", "new"], "the input is unchanged");
});

test("an empty order keeps the current catalog order", () => {
  assert.deepEqual(orderProviders(providers, []), providers);
});
