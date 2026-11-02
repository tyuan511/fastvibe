import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ModelRegistry, ModelRuntime } from "@earendil-works/pi-coding-agent";
import { createFauxCore, fauxAssistantMessage, InMemoryModelsStore, type Context } from "@earendil-works/pi-ai";
import type { FastVibePaths } from "../src/main/engine/paths.ts";
import { SUMMARY_PROMPT_MAX_CHARS } from "../src/main/engine/memory-summary.ts";
import { validateArtifacts } from "../src/main/engine/memory-workspace.ts";
import { runMemoryAgent } from "../src/main/pi/memory-agent.ts";

const TASK = "Consolidate the memory handbook and its routing summary.";
const VALID_SUMMARY = "v1\n\n## What's in Memory\n- build: pnpm, workspace\n";
const OVERSIZED_SUMMARY = `v1\n${"x".repeat(SUMMARY_PROMPT_MAX_CHARS)}`;

async function harness(t: TestContext, respond: (attempt: number, summaryFile: string) => void) {
  const dir = mkdtempSync(join(tmpdir(), "memory-agent-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const cwd = join(dir, "memories");
  const agentDir = join(dir, "agent");
  mkdirSync(cwd);
  mkdirSync(agentDir);
  // All writable SDK settings and generated artifacts stay in the temporary install.
  writeFileSync(join(agentDir, "settings.json"), JSON.stringify({ compaction: { enabled: false }, retry: { enabled: false } }));
  writeFileSync(join(cwd, "MEMORY.md"), "# Task Group: build\n- Use pnpm.\n");
  const summaryFile = join(cwd, "memory_summary.md");
  const requests: Context[] = [];
  const faux = createFauxCore({ api: "faux-api", provider: "faux", models: [{ id: "scripted" }] });
  // Extra responses let the assertion catch an accidental third repair without hanging.
  faux.setResponses(Array.from({ length: 6 }, () => (context: Context) => {
    requests.push(structuredClone(context));
    respond(requests.length, summaryFile);
    return fauxAssistantMessage(`consolidation response ${requests.length}`);
  }));
  const runtime = await ModelRuntime.create({
    credentials: undefined, authPath: join(agentDir, "auth.json"), modelsPath: null,
    modelsStore: new InMemoryModelsStore(), allowModelNetwork: false, refreshOnCreate: false,
  });
  runtime.registerProvider("faux", {
    baseUrl: "http://faux.invalid", api: "faux-api" as never, apiKey: "unused",
    streamSimple: faux.streamSimple as never,
    models: [{ id: "scripted", name: "scripted", reasoning: false, input: ["text"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 100_000, maxTokens: 4096 }],
  });
  const host = {
    runtime, models: new ModelRegistry(runtime), paths: { agentDir } as FastVibePaths,
    model: runtime.getModel("faux", "scripted"),
  };
  return {
    cwd, requests,
    summary: () => readFileSync(summaryFile, "utf8"),
    run: (signal?: AbortSignal) => runMemoryAgent(host, { cwd, task: TASK, signal }),
  };
}

test("oversized consolidation is repaired once with the original SDK conversation intact", async (t) => {
  const h = await harness(t, (attempt, file) => writeFileSync(file, attempt === 1 ? OVERSIZED_SUMMARY : VALID_SUMMARY));
  await h.run();
  assert.equal(h.requests.length, 2);
  assert.equal(h.summary(), VALID_SUMMARY);
  assert.equal(await validateArtifacts(h.cwd), null);
  const [first, repair] = h.requests;
  assert.equal(repair.systemPrompt, first.systemPrompt);
  assert.deepEqual(repair.messages.slice(0, first.messages.length), first.messages, "repair retains the original task and evidence");
  assert.ok(repair.messages.some((message) => message.role === "assistant" && JSON.stringify(message.content).includes("consolidation response 1")), "repair continues the same session");
  const repairPrompt = JSON.stringify(repair.messages.at(-1));
  assert.match(repairPrompt, /maximum is 20000/);
  assert.match(repairPrompt, /Preserve all project routing coverage and complete entries/);
  assert.match(repairPrompt, /Do not truncate the file/);
});

test("a summary exactly at the budget does not cause an additional SDK request", async (t) => {
  const summary = `v1\n${"x".repeat(SUMMARY_PROMPT_MAX_CHARS - 3)}`;
  const h = await harness(t, (_attempt, file) => writeFileSync(file, summary));
  await h.run();
  assert.equal(h.requests.length, 1);
  assert.equal(h.summary(), summary);
  assert.equal(await validateArtifacts(h.cwd), null);
});

test("a repair that remains oversized is not retried again and fails final artifact validation", async (t) => {
  const h = await harness(t, (_attempt, file) => writeFileSync(file, OVERSIZED_SUMMARY));
  await h.run();
  assert.equal(h.requests.length, 2, "only one repair request is allowed");
  assert.equal(h.summary(), OVERSIZED_SUMMARY, "the host never slices the generated file to pass validation");
  assert.match(await validateArtifacts(h.cwd) ?? "", /maximum is 20000/);
});

test("cancelling an in-flight consolidation prevents a repair request", async (t) => {
  const controller = new AbortController();
  const h = await harness(t, (_attempt, file) => {
    writeFileSync(file, OVERSIZED_SUMMARY);
    controller.abort();
  });
  await h.run(controller.signal);
  assert.equal(h.requests.length, 1);
  assert.equal(h.summary(), OVERSIZED_SUMMARY);
});

test("an already cancelled consolidation sends no SDK request", async (t) => {
  const controller = new AbortController();
  controller.abort();
  const h = await harness(t, () => assert.fail("cancelled work must not reach the model"));
  await h.run(controller.signal);
  assert.equal(h.requests.length, 0);
});
