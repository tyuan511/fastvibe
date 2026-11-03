import assert from "node:assert/strict";
import test from "node:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { memoryToolPathAllowed } from "../src/main/pi/memory-agent-boundary.ts";
import { runMemoryAgent } from "../src/main/pi/memory-agent.ts";
import { ModelRegistry, ModelRuntime } from "@earendil-works/pi-coding-agent";
import { createFauxCore, fauxAssistantMessage, fauxToolCall, InMemoryModelsStore } from "@earendil-works/pi-ai";
import type { FastVibePaths } from "../src/main/engine/paths.ts";

test("Vivi整理器允许副本内正常编辑，拒绝越界、链接和执行工具", (t) => {
  const dir = mkdtempSync(join(tmpdir(), "vivi-memory-boundary-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const root = join(dir, "workspace");
  mkdirSync(root);
  writeFileSync(join(root, "MEMORY.md"), "# Notes");
  writeFileSync(join(dir, "outside.md"), "private");
  assert.equal(memoryToolPathAllowed(root, "read", { path: "MEMORY.md" }), true);
  assert.equal(memoryToolPathAllowed(root, "write", { path: "rollout_summaries/new.md" }), true);
  assert.equal(memoryToolPathAllowed(root, "grep", { pattern: "notes" }), true);
  for (const name of ["read", "write", "edit", "grep", "find", "ls"]) {
    assert.equal(memoryToolPathAllowed(root, name, { path: "../outside.md" }), false);
    assert.equal(memoryToolPathAllowed(root, name, { path: join(dir, "outside.md") }), false);
  }
  assert.equal(memoryToolPathAllowed(root, "read", {}), false);
  assert.equal(memoryToolPathAllowed(root, "bash", { command: "echo hi" }), false);
  for (const path of ["~/.ssh/id_rsa", "@../outside.md", "file:///tmp/private.md"]) assert.equal(memoryToolPathAllowed(root, "read", { path }), false);
  assert.equal(memoryToolPathAllowed(root, "write", { path: "unexpected.html" }), false);
  assert.equal(memoryToolPathAllowed(root, "write", { path: "skills/auto/SKILL.md" }), false);
  symlinkSync(dir, join(root, "escape"), "dir");
  assert.equal(memoryToolPathAllowed(root, "write", { path: "escape/new.md" }), false);
  symlinkSync(join(root, "MEMORY.md"), join(root, "alias.md"));
  assert.equal(memoryToolPathAllowed(root, "read", { path: "alias.md" }), false);
});

test("真实SDK整理器确实拦截副本外写入，同时允许更新记忆正文", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "vivi-scoped-agent-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const cwd = join(dir, "memories"), agentDir = join(dir, "agent");
  mkdirSync(cwd); mkdirSync(agentDir);
  writeFileSync(join(agentDir, "settings.json"), JSON.stringify({ compaction: { enabled: false }, retry: { enabled: false } }));
  writeFileSync(join(dir, "outside.md"), "original");
  writeFileSync(join(cwd, "MEMORY.md"), "# Original");
  writeFileSync(join(cwd, "memory_summary.md"), "v1\n## Index\nSee MEMORY.md\n");
  const faux = createFauxCore({ api: "faux-api", provider: "faux", models: [{ id: "scripted" }] });
  faux.setResponses([
    fauxAssistantMessage([fauxToolCall("write", { path: "../outside.md", content: "should not be written" })], { stopReason: "toolUse" }),
    (context) => {
      const blocked = context.messages.filter((message) => message.role === "toolResult").at(-1);
      assert.equal(blocked?.isError, true);
      assert.match(JSON.stringify(blocked), /only its own workspace/);
      return fauxAssistantMessage([fauxToolCall("write", { path: "MEMORY.md", content: "# Updated safely" })], { stopReason: "toolUse" });
    },
    fauxAssistantMessage("Done"),
  ]);
  const runtime = await ModelRuntime.create({ authPath: join(agentDir, "auth.json"), modelsPath: null, modelsStore: new InMemoryModelsStore(), allowModelNetwork: false, refreshOnCreate: false });
  runtime.registerProvider("faux", { baseUrl: "http://faux.invalid", api: "faux-api" as never, apiKey: "unused", streamSimple: faux.streamSimple as never, models: [{ id: "scripted", name: "scripted", reasoning: false, input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 100000, maxTokens: 4096 }] });
  await runMemoryAgent({ runtime, models: new ModelRegistry(runtime), paths: { agentDir } as FastVibePaths, model: runtime.getModel("faux", "scripted") }, { cwd, task: "Consolidate memory", workspaceOnly: true });
  assert.equal(readFileSync(join(dir, "outside.md"), "utf8"), "original");
  assert.equal(readFileSync(join(cwd, "MEMORY.md"), "utf8"), "# Updated safely");
});
