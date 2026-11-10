import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import test from "node:test";
import { resolveReviewModel } from "../src/main/pi/review-model.ts";

const ts = createRequire(import.meta.url)("typescript") as typeof import("typescript");
const file = ts.createSourceFile("manager.ts", readFileSync(new URL("../src/main/pi/process-manager.ts", import.meta.url), "utf8"), ts.ScriptTarget.Latest, true);
const methods: string[] = [];
const visit = (node: import("typescript").Node): void => {
  if (ts.isMethodDeclaration(node) && ["startReview", "spawnAgent"].includes(node.name.getText(file))) methods.push(node.getText(file).replaceAll("#", ""));
  ts.forEachChild(node, visit);
};
visit(file);
assert.equal(methods.length, 2);
const compiled = ts.transpileModule(`class Harness { ${methods.join("\n")} }`, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None } }).outputText;

function fixture(options: { prepare?: () => Promise<void>; configured?: boolean } = {}) {
  const captured: any[] = [];
  const previews: Array<{ id: string; text: string }> = [];
  const configs = [{ id: "review", source: "builtin", model: options.configured === false ? undefined : "review/chosen", systemPrompt: "Built-in review prompt", thinkingLevel: "high" }];
  const model = { provider: "review", id: "chosen" };
  let preparations = 0;
  const dependencies = {
    randomUUID: () => "fixed", resolveReviewModel, clampThinkingLevel: (_model: unknown, level: string) => level, uiText: (_zh: string, en: string) => en,
    createReviewSnapshot: async (request: any, selected: any) => {
      preparations++;
      await options.prepare?.();
      return { task: "Frozen snapshot", context: { ...selected, root: "/repo-root", instructions: request.instructions } };
    },
  };
  const Harness = new Function(...Object.keys(dependencies), `${compiled}; return Harness;`)(...Object.values(dependencies));
  const host = new Harness();
  Object.assign(host, {
    catalog: { get: (id: string) => id === "owner" ? { id: "owner", cwd: "/repo" } : undefined },
    queueEpochs: new Map(), ensureReady: async () => {}, ensureSession: async () => {},
    writePromptPreview: (id: string, text: string) => previews.push({ id, text }),
    subagentManager: { list: () => configs },
    models: { find: (provider: string, id: string) => provider === "review" && id === "chosen" ? model : undefined, hasConfiguredAuth: () => true },
    spawnAgentThread: (request: any) => { captured.push(request); return { id: "agent-review", conversationId: request.conversationId }; },
  });
  return { host, captured, configs, model, previews, get preparations() { return preparations; } };
}

const request = { conversationId: "owner", cwd: "/repo/subdir", scope: "worktree", instructions: "Check cancellation" };

test("Review dispatch pins its configuration, uses repository root and forks no parent history", async () => {
  const f = fixture();
  const result = await f.host.startReview(request);
  assert.equal(result.id, "agent-review");
  assert.equal(f.captured.length, 1);
  assert.equal(f.captured[0].conversationId, "owner");
  assert.equal(f.captured[0].cwd, "/repo-root");
  assert.equal(f.captured[0].systemPrompt, "Built-in review prompt");
  assert.equal(f.captured[0].pinnedModel, f.model);
  assert.equal(f.captured[0].thinkingLevel, "high");
  assert.equal(f.captured[0].forkTurns, "none");
  assert.deepEqual(f.captured[0].tools, ["review_read_file", "review_search", "submit_review_result"]);
  assert.deepEqual(f.previews, [{ id: "owner", text: "Code review" }], "a UI-started report must not remain an empty draft");
});

test("generic spawn cannot override the built-in Review model, prompt or read-only tools", async () => {
  const f = fixture();
  await f.host.spawnAgent({ conversationId: "owner", cwd: "/repo", agent: "Review", task: "Review branch", systemPrompt: "Override", model: "chat/default", tools: ["bash", "write"], forkTurns: "all", reviewScope: "branch", reviewBase: "main" });
  assert.equal(f.captured.length, 1);
  assert.equal(f.captured[0].model, "review/chosen");
  assert.equal(f.captured[0].systemPrompt, "Built-in review prompt");
  assert.equal(f.captured[0].forkTurns, "none");
  assert.equal(f.captured[0].tools.includes("write"), false);
});

test("missing preset or unknown owner fails before snapshot preparation and delegation", async () => {
  const f = fixture({ configured: false });
  await assert.rejects(f.host.startReview(request), /Review/);
  await assert.rejects(f.host.startReview({ ...request, conversationId: "missing" }), /conversation/);
  assert.equal(f.preparations, 0);
  assert.equal(f.captured.length, 0);
  assert.deepEqual(f.previews, []);
});

test("Stop during snapshot preparation prevents a late Review child from starting", async () => {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const f = fixture({ prepare: () => gate });
  const pending = f.host.startReview(request);
  await new Promise((resolve) => setImmediate(resolve));
  f.host.queueEpochs.set("owner", 1);
  release();
  await assert.rejects(pending, { name: "AbortError" });
  assert.equal(f.captured.length, 0);
});

test("changing saved settings while a snapshot is prepared cannot change this run's model", async () => {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const f = fixture({ prepare: () => gate });
  const pending = f.host.startReview(request);
  await new Promise((resolve) => setImmediate(resolve));
  f.configs[0] = { ...f.configs[0], model: "another/model", thinkingLevel: "low" };
  release();
  await pending;
  assert.equal(f.captured[0].pinnedModel, f.model);
  assert.equal(f.captured[0].model, "review/chosen");
  assert.equal(f.captured[0].thinkingLevel, "high");
});
