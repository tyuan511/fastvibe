import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { CONFIG_DIR_NAME, createAgentSession, DefaultResourceLoader, ModelRuntime, SessionManager, SettingsManager } from "@earendil-works/pi-coding-agent";
import { DAG_WORKER_TOOLS, DAG_COORDINATOR_TOOLS, dagReportExtension } from "../src/main/pi/dag-node-runtime.ts";
import { DagStore } from "../src/main/engine/dag-store.ts";
import { openDagStore } from "./test-db.ts";
import { DagScheduler } from "../src/main/pi/dag-scheduler.ts";
import { runDagTool } from "../src/main/dag-tools.ts";

test("real SDK tools reject independent DAG work and delegate it through subagent", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "dag-routing-sdk-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const agentsDir = join(dir, CONFIG_DIR_NAME, "agents");
  mkdirSync(agentsDir, { recursive: true });
  writeFileSync(join(agentsDir, "routing-reviewer.md"), "---\nname: routing-reviewer\ndescription: Isolated review\ntools: read\n---\nReview the supplied task.\n");
  const settingsManager = SettingsManager.inMemory();
  const modelRuntime = await ModelRuntime.create({ authPath: join(dir, "auth.json"), modelsPath: null, modelsStorePath: join(dir, "models"), allowModelNetwork: false, refreshOnCreate: false });
  const resourceLoader = new DefaultResourceLoader({
    cwd: dir, agentDir: dir, settingsManager, noExtensions: true, noSkills: true, noThemes: true,
    additionalExtensionPaths: ["dag.ts", "subagent/index.ts"].map((file) => fileURLToPath(new URL(`../resources/extensions/${file}`, import.meta.url))),
  });
  await resourceLoader.reload();
  const { session, extensionsResult } = await createAgentSession({ cwd: dir, agentDir: dir, modelRuntime, settingsManager, resourceLoader, tools: ["subagent", "dag_add_tasks"], sessionManager: SessionManager.inMemory(dir) });
  t.after(() => session.dispose());
  assert.deepEqual(extensionsResult.errors, []);
  const store = openDagStore(dir);
  const scheduler = new DagScheduler(store, async () => { assert.fail("independent work must not start a DAG runner"); });
  const requests: Array<{ agent: string; task: string }> = [];
  const ctx = {
    cwd: dir, hasUI: false,
    ui: {
      dag: (request: Parameters<typeof runDagTool>[1]) => runDagTool({ store, scheduler }, request, "parent"),
      runSubagent: async (request: { agent: string; task: string }) => {
        requests.push(request);
        return { exitCode: 0, messages: [{ role: "assistant", content: [{ type: "text", text: "Review complete." }] }] };
      },
    },
  };
  const rejected = await session.getToolDefinition("dag_add_tasks")!.execute("wrong-route", {
    tasks: [{ title: "Review", instruction: "Review the change.", profile: { name: "reviewer", instructions: "Review the supplied task." } }],
  }, undefined, undefined, ctx as any);
  assert.equal(rejected.isError, true);
  assert.match(JSON.stringify(rejected.content), /subagent/);
  assert.equal(store.get("parent"), undefined);
  assert.equal(requests.length, 0);
  const delegated = await session.getToolDefinition("subagent")!.execute("direct-route", {
    agent: "routing-reviewer", task: "Review the change.", agentScope: "project",
  }, undefined, undefined, ctx as any);
  assert.notEqual(delegated.isError, true);
  assert.equal(requests.length, 1);
  assert.equal(requests[0].agent, "routing-reviewer");
  assert.equal(requests[0].task, "Review the change.");
  assert.equal(store.get("parent"), undefined);
});

for (const coordinator of [false, true]) test(`real SDK loads the bounded DAG tool surface (coordinator=${coordinator})`, async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "dag-sdk-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const settingsManager = SettingsManager.inMemory();
  const modelRuntime = await ModelRuntime.create({ authPath: join(dir, "auth.json"), modelsPath: null, modelsStorePath: join(dir, "models"), allowModelNetwork: false, refreshOnCreate: false });
  const resourceLoader = new DefaultResourceLoader({
    cwd: dir, agentDir: dir, settingsManager, noExtensions: true, noSkills: true, noThemes: true,
    additionalExtensionPaths: [fileURLToPath(new URL("../resources/extensions/dag.ts", import.meta.url))],
    extensionFactories: [{ name: "dag-report", factory: dagReportExtension({ childrenReady: () => true, report: () => {} }) }],
  });
  await resourceLoader.reload();
  const allowed = ["read", ...(coordinator ? DAG_COORDINATOR_TOOLS : DAG_WORKER_TOOLS)];
  const { session, extensionsResult } = await createAgentSession({ cwd: dir, agentDir: dir, modelRuntime, settingsManager, resourceLoader, tools: allowed, sessionManager: SessionManager.inMemory(dir) });
  t.after(() => session.dispose());
  assert.deepEqual(extensionsResult.errors, []);
  session.setActiveToolsByName(allowed);
  assert.deepEqual(session.getActiveToolNames().sort(), allowed.sort());
  assert.ok(session.getToolDefinition("dag_report"));
  assert.ok(!session.getActiveToolNames().includes("dag_resume"));
  assert.ok(!session.getActiveToolNames().includes("bash"));
});
