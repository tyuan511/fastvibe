import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createAgentSession, DefaultResourceLoader, ModelRuntime, SessionManager, SettingsManager } from "@earendil-works/pi-coding-agent";
import { DAG_WORKER_TOOLS, DAG_COORDINATOR_TOOLS, dagReportExtension } from "../src/main/pi/dag-node-runtime.ts";

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
