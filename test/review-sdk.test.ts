import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createAgentSession, DefaultResourceLoader, ModelRuntime, SessionManager, SettingsManager } from "@earendil-works/pi-coding-agent";
import { InMemoryModelsStore } from "@earendil-works/pi-ai";
import { createReviewSnapshot } from "../src/main/engine/review-snapshot.ts";
import { createReviewTools } from "../src/main/pi/review-tools.ts";

const usage = { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
const reply = (name?: string, args?: object) => ({
  role: "assistant", provider: "review-fixture", model: "review", api: "openai-completions", timestamp: Date.now(), usage,
  stopReason: name ? "toolUse" : "stop",
  content: name ? [{ type: "toolCall", id: `${name}-${Math.random()}`, name, arguments: args }] : [{ type: "text", text: "Review finished" }],
});

test("real SDK exposes only Review tools, executes validated submission, and rejects shell calls", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "fastvibe-review-sdk-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const git = (...args: string[]) => execFileSync("git", ["-C", dir, ...args], { stdio: "pipe" });
  git("init");
  git("config", "user.name", "Review Test"); git("config", "user.email", "review@example.invalid");
  writeFileSync(join(dir, "file.ts"), "export const ready = false;\n");
  git("add", "file.ts"); git("commit", "-m", "Fixture");
  writeFileSync(join(dir, "file.ts"), "export const ready = true;\n");
  const snapshot = await createReviewSnapshot({ conversationId: "conversation", cwd: dir, scope: "worktree" }, { id: "review-sdk", model: "review-fixture/review", thinkingLevel: "medium" });
  const tools = createReviewTools(snapshot);
  const report = {
    version: 1, summary: "Confirmed review fixture", coverage: { reviewedPaths: ["file.ts"], unreviewedPaths: [] },
    findings: [{ title: "Premature readiness", severity: "P2", confidence: "high", category: "correctness", location: { path: "file.ts", startLine: 1, endLine: 1, side: "new" }, trigger: "Before initialization", impact: "Consumers see ready too early", evidence: ["The target sets ready unconditionally"], recommendation: "Set ready after initialization" }],
  };
  const script = [
    reply("review_read_file", { path: "file.ts" }),
    reply("bash", { command: "touch should-not-exist" }),
    reply("submit_review_result", { ...report, findings: [{ ...report.findings[0], location: { ...report.findings[0].location, endLine: 999 } }] }),
    reply("submit_review_result", report), reply(),
  ];
  let requests = 0;
  const runtime = await ModelRuntime.create({ credentials: undefined, authPath: join(dir, "auth.json"), modelsPath: null, modelsStore: new InMemoryModelsStore(), allowModelNetwork: false, refreshOnCreate: false });
  runtime.registerProvider("review-fixture", {
    baseUrl: "http://review.invalid", api: "openai-completions", apiKey: "fixture-only",
    models: [{ id: "review", name: "Review fixture", contextWindow: 100_000, maxTokens: 4096, input: ["text"], reasoning: false, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }],
    streamSimple: (() => {
      const message = script[requests++];
      assert.ok(message, "unexpected model continuation");
      return { async *[Symbol.asyncIterator]() { yield { type: "start", partial: message }; yield { type: "done", reason: message.stopReason, message }; }, result: async () => message };
    }) as never,
  });
  const settingsManager = SettingsManager.inMemory({ compaction: { enabled: false }, retry: { enabled: false } });
  const resourceLoader = new DefaultResourceLoader({ cwd: dir, agentDir: join(dir, "agent"), settingsManager, noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, extensionFactories: [{ name: "fastvibe-review", factory: tools.factory }] });
  await resourceLoader.reload();
  const { session } = await createAgentSession({ cwd: dir, agentDir: join(dir, "agent"), modelRuntime: runtime, model: runtime.getModel("review-fixture", "review"), sessionManager: SessionManager.inMemory(dir), settingsManager, resourceLoader, tools: ["review_read_file", "review_search", "submit_review_result"] });
  t.after(() => session.dispose());
  await session.bindExtensions({ mode: "rpc" });
  assert.deepEqual(session.getActiveToolNames().sort(), ["review_read_file", "review_search", "submit_review_result"].sort());
  await session.prompt(snapshot.task);
  const results = session.messages.filter((message) => message.role === "toolResult");
  assert.equal(requests, 5);
  assert.equal(results.length, 4);
  assert.equal(results[0].isError, false);
  assert.equal(results[1].isError, true, "shell tool is never enabled");
  assert.equal(results[2].isError, true, "a schema-valid out-of-bounds report is rejected by the host");
  assert.equal(results[3].isError, false);
  assert.equal(tools.getReport()?.findings[0].location.snippet, "1: export const ready = true;");
  assert.equal(readFileSync(join(dir, "file.ts"), "utf8"), "export const ready = true;\n");
  assert.throws(() => readFileSync(join(dir, "should-not-exist")), /ENOENT/);
});
