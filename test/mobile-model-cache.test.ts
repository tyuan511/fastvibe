import assert from "node:assert/strict";
import test from "node:test";
import { readModelCatalog, invalidateModelCatalog } from "../apps/mobile/src/protocol/model-cache.ts";

test("model catalog reads are shared across simultaneous chats and expire", async (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: 1000 });
  let reads = 0;
  const client = { call: async () => { reads++; return [{ id: "model" }]; } };
  const first = readModelCatalog(client);
  assert.equal(first, readModelCatalog(client));
  await first; await readModelCatalog(client);
  assert.equal(reads, 1);
  t.mock.timers.tick(60_000);
  await readModelCatalog(client);
  assert.equal(reads, 2);
});

test("a late invalidated result cannot repopulate the current model catalog", async () => {
  let resolve!: (value: unknown[]) => void;
  let reads = 0;
  const client = { call: () => ++reads === 1 ? new Promise<unknown[]>((done) => { resolve = done; }) : Promise.resolve(["new"]) };
  const old = readModelCatalog(client);
  invalidateModelCatalog(client);
  assert.deepEqual(await readModelCatalog(client), ["new"]);
  resolve(["old"]); await old;
  assert.deepEqual(await readModelCatalog(client), ["new"]);
  assert.equal(reads, 2);
});

test("failed reads can retry and different connections never share model data", async () => {
  let reads = 0;
  const a = { call: async () => { if (++reads === 1) throw new Error("offline"); return ["a"]; } };
  await assert.rejects(readModelCatalog(a), /offline/);
  assert.deepEqual(await readModelCatalog(a), ["a"]);
  assert.deepEqual(await readModelCatalog({ call: async () => ["b"] }), ["b"]);
});
