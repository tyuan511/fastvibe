import assert from "node:assert/strict";
import { test } from "node:test";
import {
  completedTurnFooters,
  formatTurnMeta,
  type TimedMessage,
} from "../apps/mobile/src/chat/turn-meta.ts";

const NOW = new Date(2026, 8, 4, 14, 32, 0).getTime();

function message(partial: Partial<TimedMessage> & Pick<TimedMessage, "id" | "role">): TimedMessage {
  return partial;
}

test("a finished turn reports its completion time and the whole run", () => {
  const ended = NOW - 60_000;
  const started = ended - 3 * 60_000 - 41_000;
  const footers = completedTurnFooters([
    message({ id: "u1", role: "user", createdAt: started - 1_000 }),
    message({ id: "a1", role: "assistant", createdAt: started, completedAt: started + 20_000 }),
    message({ id: "a2", role: "assistant", createdAt: started + 20_000, completedAt: ended }),
  ], false);
  assert.equal(footers.size, 1);
  const meta = footers.get("a2");
  assert.ok(meta);
  assert.equal(meta.endedAt, ended);
  assert.equal(meta.elapsedMs, ended - started);
  assert.equal(formatTurnMeta(meta, NOW), "14:31 · 用时 3分钟 41秒");
});

test("a turn still in flight has no finish line, earlier turns keep theirs", () => {
  const footers = completedTurnFooters([
    message({ id: "u1", role: "user", createdAt: NOW - 120_000 }),
    message({ id: "a1", role: "assistant", createdAt: NOW - 119_000, completedAt: NOW - 60_000 }),
    message({ id: "u2", role: "user", createdAt: NOW - 10_000 }),
    message({ id: "a2", role: "assistant", createdAt: NOW - 9_000 }),
  ], true);
  assert.equal(footers.has("a2"), false);
  assert.equal(footers.get("a1")?.endedAt, NOW - 60_000);
});

test("an untimed reply still shows when it started, without inventing a duration", () => {
  const footers = completedTurnFooters([
    message({ id: "u1", role: "user" }),
    message({ id: "a1", role: "assistant", createdAt: NOW - 5_000 }),
  ], false);
  const meta = footers.get("a1");
  assert.ok(meta);
  assert.equal(meta.elapsedMs, undefined);
  assert.equal(formatTurnMeta(meta, NOW), "14:31");
});

test("a compaction notice after the reply anchors the line at the end of the turn", () => {
  const footers = completedTurnFooters([
    message({ id: "u1", role: "user", createdAt: NOW - 10_000 }),
    message({ id: "a1", role: "assistant", createdAt: NOW - 9_000, completedAt: NOW - 1_000 }),
    message({ id: "c1", role: "system", kind: "compact", createdAt: NOW - 500 }),
  ], false);
  assert.equal(footers.has("a1"), false);
  assert.equal(footers.get("c1")?.elapsedMs, 8_000);
});
