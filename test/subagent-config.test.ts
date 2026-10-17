import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { parseFrontmatter } from "@earendil-works/pi-coding-agent";
import { THINKING_EFFORT_LEVELS } from "../src/shared/types.ts";
import { discoverAgents } from "../resources/extensions/subagent/agents.ts";
import type { FastVibePaths } from "../src/main/engine/paths.ts";

const require = createRequire(import.meta.url);
const ts = require("typescript") as typeof import("typescript");
const compiled = ts.transpileModule(readFileSync(new URL("../src/main/engine/subagents.ts", import.meta.url), "utf8"), {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
}).outputText;
const exports = {};
// Keep real file persistence and SDK frontmatter parsing; replace Electron's
// bundled-resource lookup so the manager can run under Node's test runner.
const deps: Record<string, unknown> = {
  "@earendil-works/pi-coding-agent": { parseFrontmatter },
  "@shared/types": { THINKING_EFFORT_LEVELS },
  "../pi/extension-manager": {
    BUILTIN_AGENTS: [],
    builtinExtensionFile: (file: string) => fileURLToPath(new URL(`../resources/extensions/${file}`, import.meta.url)),
  },
  "./ui-text": { uiText: (zh: string) => zh },
};
new Function("require", "exports", compiled)((name: string) => {
  if (Object.hasOwn(deps, name)) return deps[name];
  if (name.startsWith("node:")) return require(name);
  throw new Error(`Unexpected subagent dependency: ${name}`);
}, exports);
const { SubagentManager } = exports as typeof import("../src/main/engine/subagents.ts");

function fixture(t: test.TestContext) {
  const dir = mkdtempSync(join(tmpdir(), "fastvibe-subagent-config-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return new SubagentManager({ agentDir: dir, subagentsFile: join(dir, "subagents.json") } as FastVibePaths);
}

test("saved builtin reasoning wins over the discovered template's default", (t) => {
  const manager = fixture(t);
  const discovered = discoverAgents(tmpdir(), "user").agents.find((agent) => agent.name === "worker")!;
  assert.equal(discovered.thinkingLevel, "medium");
  for (const thinkingLevel of THINKING_EFFORT_LEVELS) {
    const config = manager.list().find((agent) => agent.id === "worker")!;
    manager.save({ ...config, thinkingLevel });
    assert.equal(manager.list().find((agent) => agent.id === "worker")!.thinkingLevel, thinkingLevel);
    assert.equal(manager.thinkingLevelFor(discovered.name, discovered.thinkingLevel, discovered.source), thinkingLevel);
  }
});

test("the next delegation reads updated custom reasoning even with a stale declaration", (t) => {
  const manager = fixture(t);
  const draft = { name: "specialist", description: "Specialist", tools: ["read"], systemPrompt: "Inspect the task.", thinkingLevel: "low" as const };
  const config = manager.save(draft).find((agent) => agent.name === draft.name)!;
  manager.save({ ...config, thinkingLevel: "xhigh" });
  assert.equal(manager.thinkingLevelFor(config.name, "low", "user"), "xhigh");
});

test("project and DAG profiles keep their declared reasoning despite a matching saved role", (t) => {
  const manager = fixture(t);
  const worker = manager.list().find((agent) => agent.id === "worker")!;
  manager.save({ ...worker, thinkingLevel: "max" });
  assert.equal(manager.thinkingLevelFor("worker", "low", "project"), "low");
  assert.equal(manager.thinkingLevelFor("worker", undefined, "project"), "medium");
});

test("roles outside settings retain their declared reasoning or the medium default", (t) => {
  const manager = fixture(t);
  assert.equal(manager.thinkingLevelFor("external", "high", "user"), "high");
  assert.equal(manager.thinkingLevelFor("external"), "medium");
});
