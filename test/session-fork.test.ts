import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createAgentSession, SessionManager, type SessionEntry } from "@earendil-works/pi-coding-agent";
import { transformMessages } from "@earendil-works/pi-ai/api/transform-messages";
import type { Message, Model } from "@earendil-works/pi-ai";
import {
  FORK_USAGE_SESSION_FIELD,
  SessionForkError,
  cwdUsesWorktree,
  forkPreview,
  inheritedForkEntries,
  selectForkEntries,
  writeForkSession,
} from "../src/main/engine/session-fork.ts";
import { clearSessionUsageCache, parseSessionTurns, turnKey } from "../src/main/engine/usage-ledger.ts";

function entry(id: string, parentId: string | null, role: string, content: unknown, extra: Record<string, unknown> = {}): SessionEntry {
  return {
    type: "message",
    id,
    parentId,
    timestamp: "2025-01-01T00:00:00.000Z",
    message: { role, content, timestamp: 1, ...extra },
  } as unknown as SessionEntry;
}

const branch = [
  entry("user", null, "user", [{ type: "text", text: "question" }]),
  entry("assistant-tools", "user", "assistant", [
    { type: "toolCall", id: "call-a", name: "read", arguments: {} },
    { type: "toolCall", id: "call-b", name: "read", arguments: {} },
  ], { provider: "p", model: "m", stopReason: "toolUse" }),
  entry("result-a", "assistant-tools", "toolResult", [{ type: "text", text: "a" }], { toolCallId: "call-a", toolName: "read", isError: false }),
  entry("result-b", "result-a", "toolResult", [{ type: "text", text: "b" }], { toolCallId: "call-b", toolName: "read", isError: false }),
  entry("assistant-final", "result-b", "assistant", [{ type: "text", text: "done" }], { provider: "p", model: "m", stopReason: "stop" }),
] as SessionEntry[];

test("assistant fork includes all tool results but stops before the next reply", () => {
  assert.deepEqual(
    selectForkEntries(branch, "assistant-tools").map((item) => item.id),
    ["user", "assistant-tools", "result-a", "result-b"],
  );
  assert.deepEqual(
    selectForkEntries(branch, "assistant-final").map((item) => item.id),
    branch.map((item) => item.id),
  );
});

test("fork rejects empty history, targets outside the current branch, and non-assistant targets", () => {
  assert.throws(() => selectForkEntries([]), (error) => error instanceof SessionForkError && error.code === "empty");
  assert.throws(() => selectForkEntries(branch, "other-branch"), (error) => error instanceof SessionForkError && error.code === "not-on-branch");
  assert.throws(() => selectForkEntries(branch, "user"), (error) => error instanceof SessionForkError && error.code === "not-assistant");
});

test("fork preview is inherited and remains non-empty when an old catalog has none", () => {
  assert.equal(forkPreview(branch, " original prompt ", "fallback"), "original prompt");
  assert.equal(forkPreview(branch, undefined, "fallback"), "question");
  const imageOnly = [entry("image", null, "user", [{ type: "image", data: "..." }])] as SessionEntry[];
  assert.equal(forkPreview(imageOnly, undefined, "Conversation"), "Conversation");
});

test("worktree guard catches direct descendants and forks whose cwd belongs to another conversation", () => {
  const root = join(tmpdir(), "fastvibe-worktree-owner");
  assert.equal(cwdUsesWorktree(root, [root]), true);
  assert.equal(cwdUsesWorktree(join(root, "nested"), [root]), true);
  assert.equal(cwdUsesWorktree(`${root}-other`, [root]), false);
  assert.equal(cwdUsesWorktree(tmpdir(), [root]), false);
});

test("unfinished tool calls receive explicit error results without changing the source", () => {
  const source = branch.slice(0, 3);
  const before = structuredClone(source);
  const selected = selectForkEntries(source, "assistant-tools");

  assert.deepEqual(source, before);
  assert.equal(selected.length, 4);
  assert.equal(selected[2].id, "result-a");
  const synthetic = selected[3];
  assert.equal(synthetic.type, "message");
  if (synthetic.type !== "message") return;
  assert.equal(synthetic.message.role, "toolResult");
  assert.equal(synthetic.message.toolCallId, "call-b");
  assert.equal(synthetic.message.isError, true);
  assert.match(JSON.stringify(synthetic.message.content), /分叉时未取得工具结果，工具未在此分叉中执行/);
  assert.equal(synthetic.parentId, "result-a");
});

test("completed replies are not rejected because older history has an unfinished call", () => {
  const oldCall = entry("old-call", "user", "assistant", [
    { type: "toolCall", id: "lost", name: "read", arguments: {} },
  ], { provider: "p", model: "m", stopReason: "toolUse" });
  const final = entry("later-answer", "old-call", "assistant", [{ type: "text", text: "finished" }], {
    provider: "p", model: "m", stopReason: "stop",
  });
  const selected = selectForkEntries([branch[0], oldCall, final], "later-answer");
  assert.equal(selected.at(-1)?.id, "later-answer");
  assert.equal(selected[2].type, "message");
  if (selected[2].type !== "message") return;
  assert.equal(selected[2].message.role, "toolResult");
  assert.equal(selected[2].message.isError, true);
});

test("aggregated assistant calls are paired with real results before pi-ai transforms them", () => {
  const parallel = [
    branch[0],
    entry("calls-one", "user", "assistant", [{ type: "toolCall", id: "one", name: "read", arguments: {} }], {
      provider: "p", model: "m", stopReason: "toolUse",
    }),
    entry("calls-two", "calls-one", "assistant", [{ type: "toolCall", id: "two", name: "grep", arguments: {} }], {
      provider: "p", model: "m", stopReason: "toolUse",
    }),
    entry("two-result", "calls-two", "toolResult", [{ type: "text", text: "two" }], {
      toolCallId: "two", toolName: "grep", isError: false, metadata: { kept: true },
    }),
    entry("orphan-middle", "two-result", "toolResult", [{ type: "text", text: "valuable orphan" }], {
      toolCallId: "unknown", toolName: "read", isError: false, metadata: { retained: true },
    }),
    entry("one-result", "orphan-middle", "toolResult", [{ type: "text", text: "one" }], {
      toolCallId: "one", toolName: "read", isError: false,
    }),
    branch[4],
  ] as SessionEntry[];
  const selected = selectForkEntries(parallel, "calls-one");

  assert.deepEqual(
    selected.map((item) => item.id),
    ["user", "calls-one", "one-result", "calls-two", "two-result", "orphan-middle"],
  );
  assert.equal(selected.every((item, index) => item.parentId === (selected[index - 1]?.id ?? null)), true);
  assert.deepEqual((selected[4] as typeof parallel[3]).message, parallel[3].message);
  const orphan = selected[5];
  assert.equal(orphan.type, "message");
  if (orphan.type !== "message") return;
  assert.equal(orphan.message.role, "user");
  assert.deepEqual((orphan.message as unknown as { metadata: unknown }).metadata, { retained: true });

  const messages = selected.flatMap((item) => item.type === "message" ? [item.message] : []) as Message[];
  const model: Model<"openai-completions"> = {
    id: "m",
    name: "test",
    api: "openai-completions",
    provider: "p",
    baseUrl: "https://example.invalid/v1",
    reasoning: false,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 128_000,
    maxTokens: 8_192,
  };
  const transformed = transformMessages(messages, model);
  for (const id of ["one", "two"]) {
    const results = transformed.filter((message) => message.role === "toolResult" && message.toolCallId === id);
    assert.equal(results.length, 1, `${id} should have exactly one result`);
    assert.equal(results[0].isError, false, `${id} should retain its real result without a synthetic error`);
  }
  assert.equal(
    transformed.some((message) => message.role === "toolResult" && message.toolCallId === "unknown"),
    false,
  );
});

test("an orphan old tool result keeps its content and metadata in provider-safe context", () => {
  const orphan = entry("orphan", "user", "toolResult", [{ type: "text", text: "valuable old output" }], {
    toolCallId: "missing-call", toolName: "read", isError: false, metadata: { retained: 1 },
  });
  const selected = selectForkEntries([branch[0], orphan, branch[4]]);
  const repaired = selected[1];
  assert.equal(repaired.type, "message");
  if (repaired.type !== "message") return;
  assert.equal(repaired.message.role, "user");
  assert.deepEqual(repaired.message.content, orphan.message.content);
  assert.deepEqual((repaired.message as unknown as { metadata: unknown }).metadata, { retained: 1 });
});

test("a full fork copies only the supplied current branch and preserves usage origins across generations", () => {
  const source = inheritedForkEntries(branch, "source-session");
  assert.notEqual(source, branch);
  assert.equal((source[1] as unknown as Record<string, unknown>)[FORK_USAGE_SESSION_FIELD], "source-session");
  const second = inheritedForkEntries(source, "intermediate-session");
  assert.equal((second[1] as unknown as Record<string, unknown>)[FORK_USAGE_SESSION_FIELD], "source-session");
  assert.deepEqual(selectForkEntries(branch).map((item) => item.id), branch.map((item) => item.id));
});

test("SessionManager roundtrip keeps repaired history, compaction metadata, and nested usage identity", async () => {
  const root = await mkdtemp(join(tmpdir(), "fastvibe-fork-roundtrip-"));
  try {
    const compacted = [
      branch[0],
      entry("open-call", "user", "assistant", [{ type: "toolCall", id: "missing", name: "bash", arguments: {} }], {
        provider: "p", model: "m", stopReason: "toolUse",
      }),
      {
        type: "compaction",
        id: "compact",
        parentId: "open-call",
        timestamp: "2025-01-01T00:00:01.000Z",
        summary: "summary",
        firstKeptEntryId: "open-call",
        tokensBefore: 10,
        details: { retained: true },
      },
      entry("answer-after-compact", "compact", "assistant", [{ type: "text", text: "done" }], {
        provider: "p", model: "m", stopReason: "stop",
      }),
    ] as SessionEntry[];
    const selected = selectForkEntries(compacted, "answer-after-compact");
    const first = writeForkSession({
      sessionDir: root,
      cwd: root,
      sourceSessionId: "original-session",
      entries: selected,
    });

    let manager = SessionManager.open(first.sessionFile, root);
    const opened = manager.getBranch();
    assert.equal(opened.every((item, index) => item.parentId === (opened[index - 1]?.id ?? null)), true);
    const compaction = opened.find((item) => item.type === "compaction");
    assert.equal(compaction?.type, "compaction");
    if (compaction?.type === "compaction") {
      assert.equal(compaction.firstKeptEntryId, "open-call");
      assert.deepEqual(compaction.details, { retained: true });
    }
    const context = manager.buildSessionContext().messages;
    assert.equal(context.at(-1)?.role, "assistant");

    const { session } = await createAgentSession({
      cwd: root,
      agentDir: join(root, "agent"),
      sessionManager: manager,
      noTools: "all",
    });
    session.setSessionName("named fork");
    session.dispose();
    manager = SessionManager.open(first.sessionFile, root);
    assert.equal(manager.getSessionName(), "named fork");
    assert.equal(manager.getBranch().some((item) => item.id === "answer-after-compact"), true);

    const second = writeForkSession({
      sessionDir: root,
      cwd: root,
      sourceSessionId: first.sessionId,
      sourceSessionFile: first.sessionFile,
      entries: selectForkEntries(manager.getBranch()),
    });
    const nested = SessionManager.open(second.sessionFile, root);
    const inheritedAnswer = nested.getBranch().find((item) => item.id === "answer-after-compact");
    assert.equal(
      (inheritedAnswer as unknown as Record<string, unknown>)[FORK_USAGE_SESSION_FIELD],
      "original-session",
    );
    assert.equal(nested.buildSessionContext().messages.at(-1)?.role, "assistant");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("fork transcript has a new session id while inherited turns deduplicate with the source", async () => {
  const root = await mkdtemp(join(tmpdir(), "fastvibe-fork-"));
  try {
    const sourceFile = join(root, "source.jsonl");
    const assistant = entry("answer", null, "assistant", [{ type: "text", text: "ok" }], {
      provider: "provider",
      model: "model",
      timestamp: 1000,
      usage: { input: 2, output: 3, totalTokens: 5, cost: { total: 0.01 } },
      stopReason: "stop",
    });
    await writeFile(sourceFile, `${JSON.stringify({ type: "session", version: 3, id: "source-session", timestamp: "2025-01-01T00:00:00.000Z", cwd: root })}\n${JSON.stringify(assistant)}\n`);
    const written = writeForkSession({
      sessionDir: root,
      cwd: root,
      sourceSessionId: "source-session",
      sourceSessionFile: sourceFile,
      entries: [assistant],
    });
    assert.notEqual(written.sessionId, "source-session");
    const firstLine = JSON.parse((await readFile(written.sessionFile, "utf8")).split("\n")[0]);
    assert.equal(firstLine.fastvibeFork.sourceSessionId, "source-session");
    assert.equal(firstLine.fastvibeFork.inheritedThroughEntryId, "answer");

    clearSessionUsageCache();
    const sourceTurns = await parseSessionTurns(sourceFile);
    const forkTurns = await parseSessionTurns(written.sessionFile);
    assert.equal(turnKey(sourceTurns.turns[0]), turnKey(forkTurns.turns[0]));
    assert.equal(forkTurns.turns[0].sessionId, "source-session");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
