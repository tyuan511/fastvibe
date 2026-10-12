import { test } from "node:test";
import assert from "node:assert/strict";
import type { Conversation } from "../src/shared/types.ts";
import {
  MAX_AGE_MS,
  MAX_CONSOLIDATED,
  MAX_PER_PASS,
  MAX_UNUSED_MS,
  MIN_IDLE_MS,
  RETRY_DELAY_MS,
  emptyState,
  failureAfter,
  parseStage1,
  pickCandidates,
  renderRawMemories,
  renderRolloutSummary,
  rolloutFileName,
  rolloutFileStem,
  selectForConsolidation,
  staleOutputIds,
  type Stage1Output,
} from "../src/main/engine/memory-plan.ts";

const NOW = Date.UTC(2026, 5, 15, 12, 0, 0);
const HOUR = 3_600_000;
const chat = (id: string, extra: Partial<Conversation> = {}): Conversation => ({ id, title: id, cwd: "/p", sessionFile: `/s/${id}.jsonl`, createdAt: 0, updatedAt: 0, ...extra });
const output = (id: string, extra: Partial<Stage1Output> = {}): Stage1Output => ({
  conversationId: id, cwd: "/p", rolloutPath: `/s/${id}.jsonl`, createdAt: Date.UTC(2026, 0, 5, 12, 30, 15), sourceUpdatedAt: NOW - 1000, generatedAt: NOW - 1000,
  rawMemory: `raw ${id}`, rolloutSummary: `sum ${id}`, slug: `slug-${id}`, usageCount: 0, ...extra,
});

test("the numbers are Codex's defaults", () => {
  assert.equal(MIN_IDLE_MS, 6 * HOUR);
  assert.equal(MAX_AGE_MS, 10 * 24 * HOUR);
  assert.equal(MAX_PER_PASS, 2);
  assert.equal(MAX_CONSOLIDATED, 256);
  assert.equal(MAX_UNUSED_MS, 30 * 24 * HOUR);
  assert.equal(RETRY_DELAY_MS, HOUR);
});

test("only conversations that went quiet, recently enough, are picked", () => {
  const mtimes = new Map([
    ["fresh", NOW - MIN_IDLE_MS + 1000],
    ["quiet", NOW - MIN_IDLE_MS - 1000],
    ["old", NOW - MAX_AGE_MS - 1000],
    ["running", NOW - MIN_IDLE_MS - 5000],
    ["side", NOW - MIN_IDLE_MS - 2000],
    ["newer", NOW - MIN_IDLE_MS - 500],
  ]);
  const picked = pickCandidates(
    [chat("fresh"), chat("quiet"), chat("old"), chat("running"), chat("side", { kind: "side-chat" }), chat("nofile", { sessionFile: undefined }), chat("newer")],
    mtimes, emptyState(), new Set(["running"]), NOW,
  );
  assert.deepEqual(picked.map((item) => item.conversation.id), ["newer", "quiet"]);
});

test("a conversation already read at its current transcript is left alone until it changes", () => {
  const quiet = NOW - MIN_IDLE_MS - 1000;
  const mtimes = new Map([["a", quiet], ["b", quiet], ["c", quiet]]);
  const state = emptyState();
  state.outputs.a = output("a", { sourceUpdatedAt: quiet });
  state.empty.b = quiet;
  const chats = [chat("a"), chat("b"), chat("c")];
  assert.deepEqual(pickCandidates(chats, mtimes, state, new Set(), NOW).map((item) => item.conversation.id), ["c"]);
  mtimes.set("a", quiet + 500); // the chat continued
  assert.deepEqual(pickCandidates(chats, mtimes, state, new Set(), NOW).map((item) => item.conversation.id).sort(), ["a", "c"]);
});

test("a failing conversation is retried after an hour, a few times, then left until it changes", () => {
  const mtime = NOW - MIN_IDLE_MS - 1000;
  const mtimes = new Map([["a", mtime]]);
  const state = emptyState();
  state.failures.a = failureAfter(undefined, mtime, NOW);
  assert.equal(pickCandidates([chat("a")], mtimes, state, new Set(), NOW).length, 0);
  assert.equal(pickCandidates([chat("a")], mtimes, state, new Set(), NOW + RETRY_DELAY_MS + 1).length, 1);
  state.failures.a = failureAfter(failureAfter(failureAfter(undefined, mtime, NOW), mtime, NOW), mtime, NOW);
  assert.equal(state.failures.a.attempts, 3);
  assert.equal(pickCandidates([chat("a")], mtimes, state, new Set(), NOW + 365 * 24 * HOUR).length, 0);
  mtimes.set("a", mtime + 1);
  assert.equal(pickCandidates([chat("a")], mtimes, state, new Set(), NOW).length, 1);
});

test("consolidation prefers what was used, then what was touched last, and drops what went stale", () => {
  const outputs = [
    output("unused-new", { sourceUpdatedAt: NOW - 1000 }),
    output("used", { usageCount: 3, lastUsage: NOW - 5000, generatedAt: NOW - 10_000 }),
    output("stale", { generatedAt: NOW - MAX_UNUSED_MS - 1, sourceUpdatedAt: NOW - MAX_UNUSED_MS - 1 }),
    output("stale-but-used-lately", { generatedAt: NOW - MAX_UNUSED_MS - 1, usageCount: 1, lastUsage: NOW - 100 }),
  ];
  assert.deepEqual(selectForConsolidation(outputs, NOW).map((item) => item.conversationId), ["used", "stale-but-used-lately", "unused-new"]);
  assert.deepEqual(staleOutputIds(outputs, NOW), ["stale"]);
  const many = Array.from({ length: MAX_CONSOLIDATED + 10 }, (_, index) => output(`c${index}`, { sourceUpdatedAt: NOW - index }));
  assert.equal(selectForConsolidation(many, NOW).length, MAX_CONSOLIDATED);
});

test("recap file names follow Codex: creation time, a four-character id hash, a sanitised slug", () => {
  const o = output("0190a5e4-7b3c-7000-8000-00001a2b3c4d", { slug: "Fix the CI/build — 修复!" });
  const stem = rolloutFileStem(o);
  assert.match(stem, /^2026-01-05T12-30-15-[0-9A-Za-z]{4}-fix_the_ci_build/);
  assert.ok(!stem.endsWith("_"));
  assert.equal(rolloutFileName(o), `${stem}.md`);
  // The hash is the id's low 32 bits in base 62, so the same id always names the same file.
  assert.equal(rolloutFileStem(o), rolloutFileStem({ ...o, rawMemory: "other" } as Stage1Output));
  assert.notEqual(rolloutFileStem(o), rolloutFileStem({ ...o, conversationId: "0190a5e4-7b3c-7000-8000-00001a2b3c4e" }));
  assert.match(rolloutFileStem(output("x", { slug: null })), /^2026-01-05T12-30-15-[0-9A-Za-z]{4}$/);
  assert.ok(rolloutFileStem(output("x", { slug: "a".repeat(200) })).length <= 25 + 60);
  assert.ok(!rolloutFileName(output("../../etc", { slug: "../x" })).includes("/"));
});

test("raw memories and recaps carry the headers Codex's prompts expect", () => {
  const a = output("a");
  const b = output("b", { cwd: "/proj", rolloutPath: "/s/b.jsonl" });
  assert.equal(renderRawMemories([a, b]), renderRawMemories([b, a]), "ascending id order, so a rerun is byte-identical");
  const raw = renderRawMemories([b]);
  assert.match(raw, /^# Raw Memories\n\nMerged stage-1 raw memories \(stable ascending thread-id order\):\n\n## Thread `b`\n/);
  assert.match(raw, /updated_at: 2026-06-15T11:59:59\+00:00\ncwd: \/proj\nrollout_path: \/s\/b\.jsonl\nrollout_summary_file: 2026-01-05T12-30-15-[0-9A-Za-z]{4}-slug_b\.md\n\nraw b\n/);
  assert.match(renderRawMemories([]), /No raw memories yet/);
  assert.match(renderRolloutSummary(b), /^thread_id: b\nupdated_at: .*\nrollout_path: \/s\/b\.jsonl\ncwd: \/proj\n\nsum b\n$/);
});

test("the stage-1 answer is read leniently, redacted, and refused when it is not an answer", () => {
  const ok = parseStage1('Here you go:\n```json\n{"raw_memory":"# T\\nkey sk-abcdefghijklmnopqrstuv","rollout_summary":"did a thing","rollout_slug":"Do A Thing"}\n```');
  assert.ok(ok);
  assert.ok(!ok.rawMemory.includes("sk-abcdef"));
  assert.match(ok.rawMemory, /\[REDACTED_SECRET\]/);
  assert.equal(ok.slug, "Do A Thing");
  assert.deepEqual(parseStage1('{"rollout_summary":"","rollout_slug":null,"raw_memory":""}'), { rawMemory: "", rolloutSummary: "", slug: null });
  assert.equal(parseStage1("I could not do that"), null);
  assert.equal(parseStage1('{"something":"else"}'), null);
});
