import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { CONFIG_DIR_NAME } from "@earendil-works/pi-coding-agent";
import { discoverAgents, type AgentScope } from "../resources/extensions/subagent/agents.ts";

function fixture(t: test.TestContext) {
  const root = mkdtempSync(join(tmpdir(), "fastvibe-agent-discovery-"));
  const agentDir = join(root, "user");
  const project = join(root, "project");
  const cwd = join(project, "src");
  mkdirSync(cwd, { recursive: true });
  const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = agentDir;
  t.after(() => {
    if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
    rmSync(root, { recursive: true, force: true });
  });
  return { cwd, userRoles: join(agentDir, "agents"), projectRoles: join(project, CONFIG_DIR_NAME, "agents") };
}

function writeRole(dir: string, name: string, description: string) {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${name}.md`), `---\nname: ${name}\ndescription: ${description}\n---\n${description}\n`);
}

for (const scope of ["user", "project", "both"] as const satisfies readonly AgentScope[]) {
  test(`built-in roles remain available with ${scope} scope in an unconfigured project`, (t) => {
    const { cwd } = fixture(t);
    const result = discoverAgents(cwd, scope);
    assert.equal(result.projectAgentsDir, null);
    assert.deepEqual(result.agents.map((agent) => agent.name).sort(), ["explorer", "review", "worker"]);
    for (const agent of result.agents) {
      assert.ok(agent.systemPrompt.trim(), `${agent.name} must retain its bundled instructions`);
      assert.ok(agent.tools?.includes(agent.name === "review" ? "submit_review_result" : "read"));
    }
  });

  test(`${scope} scope filters only additional user and project roles`, (t) => {
    const { cwd, userRoles, projectRoles } = fixture(t);
    writeRole(userRoles, "personal", "User role");
    writeRole(projectRoles, "specialist", "Project role");
    const result = discoverAgents(cwd, scope);
    assert.equal(result.projectAgentsDir, projectRoles);
    const expected = ["explorer", "review", "worker"];
    if (scope !== "project") expected.push("personal");
    if (scope !== "user") expected.push("specialist");
    assert.deepEqual(result.agents.map((agent) => agent.name).sort(), expected.sort());
  });
}

test("scoped overrides retain the precedence builtin, user, then project", (t) => {
  const { cwd, userRoles, projectRoles } = fixture(t);
  writeRole(userRoles, "explorer", "User explorer");
  writeRole(projectRoles, "explorer", "Project explorer");
  for (const scope of ["user", "project", "both"] as const) {
    const agents = discoverAgents(cwd, scope).agents;
    assert.equal(agents.filter((agent) => agent.name === "explorer").length, 1);
    const explorer = agents.find((agent) => agent.name === "explorer")!;
    assert.equal(explorer.description, scope === "user" ? "User explorer" : "Project explorer");
    assert.equal(explorer.source, scope === "user" ? "user" : "project");
    assert.ok(agents.some((agent) => agent.name === "worker"));
  }
});
