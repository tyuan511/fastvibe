import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import {
  CONVERSATION_TRANSCRIPT_MAX_FILE_BYTES,
  CONVERSATION_TRANSCRIPT_MAX_QUERY_CHARS,
  ConversationTranscriptError,
  loadConversationTranscriptBranch,
  searchConversationTranscript,
} from "../src/main/engine/conversation-transcript-search.ts";

const timestamp = "2026-03-20T00:00:00.000Z";

function message(
  id: string,
  parentId: string | null,
  role: string,
  content: unknown,
  extra: Record<string, unknown> = {},
): SessionEntry {
  return {
    type: "message",
    id,
    parentId,
    timestamp,
    message: { role, content, timestamp: Date.parse(timestamp), ...extra },
  } as unknown as SessionEntry;
}

function lines(entries: unknown[]): string {
  return `${entries.map((entry) => JSON.stringify(entry)).join("\n")}\n`;
}

test("searches visible transcript text, tool inputs, and tool results", () => {
  const branch = [
    message("user", null, "user", [
      { type: "text", text: "Please inspect websocket recovery" },
      { type: "image", data: "image-secret-payload", mimeType: "image/png" },
    ]),
    message("hidden-custom", "user", "custom", [{ type: "text", text: "hidden custom payload" }], {
      customType: "state",
      display: false,
    }),
    message("assistant", "hidden-custom", "assistant", [
      { type: "thinking", thinking: "hidden websocket thought" },
      { type: "toolCall", id: "call", name: "grep", arguments: { pattern: "X-Forwarded-Host" } },
    ]),
    message("result", "assistant", "toolResult", [{ type: "text", text: "matched origin policy" }], {
      toolCallId: "call",
      toolName: "grep",
      isError: false,
    }),
    message("system", "result", "system", "private websocket system instruction"),
  ];

  const input = searchConversationTranscript(branch, { query: "X-Forwarded-Host", context: 1 });
  assert.equal(input.totalMatches, 1);
  assert.equal(input.matches[0].entryId, "assistant");
  assert.equal(input.matches[0].role, "assistant");
  assert.equal(input.matches[0].before[0].entryId, "user");
  assert.equal(input.matches[0].after[0].entryId, "result");

  const output = searchConversationTranscript(branch, { query: "origin policy" });
  assert.equal(output.matches[0].role, "tool");
  assert.equal(output.matches[0].source, "grep");

  assert.equal(searchConversationTranscript(branch, { query: "private websocket" }).totalMatches, 0);
  assert.equal(searchConversationTranscript(branch, { query: "hidden websocket" }).totalMatches, 0);
  assert.equal(searchConversationTranscript(branch, { query: "hidden custom" }).totalMatches, 0);
  assert.equal(searchConversationTranscript(branch, { query: "image-secret" }).totalMatches, 0);
  assert.doesNotMatch(JSON.stringify(input), /image-secret|hidden websocket|hidden custom/);
});

test("searches summaries and visible custom messages but not hidden custom messages", () => {
  const branch = [
    {
      type: "compaction",
      id: "compact",
      parentId: null,
      timestamp,
      summary: "Decision: preserve the forwarded host",
      firstKeptEntryId: "visible",
      tokensBefore: 1200,
    },
    {
      type: "custom_message",
      id: "visible",
      parentId: "compact",
      timestamp,
      customType: "audit",
      content: "visible audit marker",
      display: true,
    },
    {
      type: "custom_message",
      id: "hidden",
      parentId: "visible",
      timestamp,
      customType: "state",
      content: "hidden audit marker",
      display: false,
    },
  ] as SessionEntry[];

  assert.equal(searchConversationTranscript(branch, { query: "forwarded host" }).matches[0].role, "summary");
  assert.equal(searchConversationTranscript(branch, { query: "visible audit" }).matches[0].role, "custom");
  assert.equal(searchConversationTranscript(branch, { query: "hidden audit" }).totalMatches, 0);
});

test("keeps case-insensitive snippets aligned when lowercase changes UTF-16 length", () => {
  const prefix = "İ".repeat(700);
  const result = searchConversationTranscript(
    [message("unicode", null, "user", `${prefix} TARGET suffix`)],
    { query: "target", context: 0 },
  );
  assert.equal(result.totalMatches, 1);
  assert.match(result.matches[0].snippet, /TARGET/);
});

test("rejects a query too large to keep tool output bounded", () => {
  assert.throws(
    () => searchConversationTranscript([], { query: "x".repeat(CONVERSATION_TRANSCRIPT_MAX_QUERY_CHARS + 1) }),
    (error) => error instanceof ConversationTranscriptError && error.code === "query-too-long",
  );
});

test("caps returned matches and reports truncation", () => {
  const branch = Array.from({ length: 8 }, (_, index) =>
    message(`m-${index}`, index === 0 ? null : `m-${index - 1}`, "user", `needle ${index}`),
  );
  const result = searchConversationTranscript(branch, { query: "needle", maxResults: 3, context: 0 });
  assert.equal(result.totalMatches, 8);
  assert.equal(result.matches.length, 3);
  assert.equal(result.truncated, true);
});

test("loads only the current persisted branch without modifying the transcript", async () => {
  const dir = await mkdtemp(join(tmpdir(), "fastvibe-conversation-search-"));
  const file = join(dir, "session.jsonl");
  const raw = lines([
    { type: "session", version: 3, id: "session", timestamp, cwd: dir },
    message("root", null, "user", "root"),
    message("old", "root", "assistant", "old branch needle"),
    message("current", "root", "assistant", "current branch needle"),
  ]);
  try {
    await writeFile(file, raw, "utf8");
    const branch = await loadConversationTranscriptBranch(file, dir);
    assert.deepEqual(branch.map((entry) => entry.id), ["root", "current"]);
    assert.equal(searchConversationTranscript(branch, { query: "old branch" }).totalMatches, 0);
    assert.equal(searchConversationTranscript(branch, { query: "current branch" }).totalMatches, 1);
    assert.equal(await readFile(file, "utf8"), raw);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("migrates a legacy hidden hook message in memory without exposing or rewriting it", async () => {
  const dir = await mkdtemp(join(tmpdir(), "fastvibe-conversation-search-legacy-"));
  const file = join(dir, "session.jsonl");
  const raw = lines([
    { type: "session", version: 2, id: "session", timestamp, cwd: dir },
    {
      ...message("hidden", null, "hookMessage", "legacy hidden payload"),
      message: {
        role: "hookMessage",
        content: "legacy hidden payload",
        customType: "state",
        display: false,
        timestamp: Date.parse(timestamp),
      },
    },
    message("visible", "hidden", "user", "visible payload"),
  ]);
  try {
    await writeFile(file, raw, "utf8");
    const branch = await loadConversationTranscriptBranch(file, dir);
    assert.equal(searchConversationTranscript(branch, { query: "legacy hidden" }).totalMatches, 0);
    assert.equal(searchConversationTranscript(branch, { query: "visible payload" }).totalMatches, 1);
    assert.equal(await readFile(file, "utf8"), raw);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("rejects a cyclic parent chain instead of looping in the SDK reader", async () => {
  const dir = await mkdtemp(join(tmpdir(), "fastvibe-conversation-search-cycle-"));
  const file = join(dir, "session.jsonl");
  try {
    await writeFile(file, lines([
      { type: "session", version: 3, id: "session", timestamp, cwd: dir },
      message("a", "b", "user", "first"),
      message("b", "a", "assistant", "second"),
    ]));
    await assert.rejects(
      loadConversationTranscriptBranch(file, dir),
      (error) => error instanceof ConversationTranscriptError && error.code === "invalid",
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("rejects oversized transcripts before parsing them", async () => {
  const dir = await mkdtemp(join(tmpdir(), "fastvibe-conversation-search-large-"));
  const file = join(dir, "session.jsonl");
  try {
    await writeFile(file, Buffer.alloc(CONVERSATION_TRANSCRIPT_MAX_FILE_BYTES + 1, 32));
    await assert.rejects(
      loadConversationTranscriptBranch(file, dir),
      (error) => error instanceof ConversationTranscriptError && error.code === "too-large",
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
