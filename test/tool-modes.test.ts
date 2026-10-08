import test from "node:test";
import assert from "node:assert/strict";
import { applyToolModes, DAG_AGENT_TOOLS, toolModes, toolModeSettingsChanged, type ToolModes } from "../src/main/engine/tool-modes.ts";

/** Existing cases are about the other two switches, so the DAG tools stay out of their results. */
function modes(patch: Partial<ToolModes>): ToolModes {
  return { codemode: false, toolSearch: false, dynamicDag: false, ...patch };
}

test("both tools are on by default, with nothing saved and no servers", () => {
  assert.deepEqual(toolModes({}, []), { codemode: true, toolSearch: true, dynamicDag: true });
});

test("the user's switches turn each tool off, independently", () => {
  assert.deepEqual(toolModes({ codemode: false }, []), { codemode: false, toolSearch: true, dynamicDag: true });
  assert.deepEqual(toolModes({ toolSearch: false }, []), { codemode: true, toolSearch: false, dynamicDag: true });
  assert.deepEqual(toolModes({ codemode: false, toolSearch: false }, []), { codemode: false, toolSearch: false, dynamicDag: true });
  assert.deepEqual(toolModes({ dynamicDag: false }, []), { codemode: true, toolSearch: true, dynamicDag: false });
});

test("only a literal false is off; anything else a settings file might hold is on", () => {
  assert.deepEqual(toolModes({ codemode: "false", toolSearch: 0, dynamicDag: "false" }, []), { codemode: true, toolSearch: true, dynamicDag: true });
  assert.deepEqual(toolModes({ codemode: null, toolSearch: undefined, dynamicDag: null }, []), { codemode: true, toolSearch: true, dynamicDag: true });
});

test("a codemode server keeps codemode on and a deferred one keeps tool_search on, switches off or not", () => {
  const off = { codemode: false, toolSearch: false };
  assert.deepEqual(toolModes(off, [{ enabled: true, exposure: "codemode" }]), { codemode: true, toolSearch: false, dynamicDag: true });
  assert.deepEqual(toolModes(off, [{ enabled: true, exposure: "deferred" }]), { codemode: false, toolSearch: true, dynamicDag: true });
});

test("a direct server, or none, implies nothing, and never turns the DAG tools back on", () => {
  const off = { codemode: false, toolSearch: false, dynamicDag: false };
  assert.deepEqual(toolModes(off, [{ enabled: true, exposure: "direct" }, { enabled: true }]), { codemode: false, toolSearch: false, dynamicDag: false });
});

test("a disabled server does not keep anything on", () => {
  const off = { codemode: false, toolSearch: false, dynamicDag: false };
  assert.deepEqual(toolModes(off, [{ enabled: false, exposure: "codemode" }, { enabled: false, exposure: "deferred" }]), {
    codemode: false,
    toolSearch: false,
    dynamicDag: false,
  });
});

test("applying adds the missing tools once and keeps the order of the rest", () => {
  assert.deepEqual(applyToolModes(["read", "bash"], modes({ codemode: true, toolSearch: true })), ["read", "bash", "codemode", "tool_search"]);
  assert.deepEqual(applyToolModes(["read", "codemode"], modes({ codemode: true })), ["read", "codemode"]);
});

test("applying removes a tool that is no longer wanted and touches nothing else", () => {
  assert.deepEqual(applyToolModes(["read", "codemode", "tool_search", "mcp_x_y"], modes({})), ["read", "mcp_x_y"]);
  assert.deepEqual(applyToolModes(["read", "codemode", "tool_search"], modes({ codemode: true })), ["read", "codemode"]);
});

test("a set another extension narrowed keeps what it kept, and off adds nothing", () => {
  assert.deepEqual(applyToolModes(["read", "grep"], modes({})), ["read", "grep"]);
  assert.deepEqual(applyToolModes(["read", "grep"], modes({ codemode: true, toolSearch: true })), ["read", "grep", "codemode", "tool_search"]);
});

test("dynamic DAG adds every dag tool when on and removes only those when off", () => {
  assert.deepEqual(applyToolModes(["read"], modes({ dynamicDag: true })), ["read", ...DAG_AGENT_TOOLS]);
  const active = ["read", "dag_add_tasks", "dag_wait", "bash", "dag_retry"];
  assert.deepEqual(applyToolModes(active, modes({})), ["read", "bash"]);
  const next = applyToolModes(active, modes({ dynamicDag: true }));
  assert.deepEqual(next.filter((name) => !name.startsWith("dag_")), ["read", "bash"]);
  assert.deepEqual([...next].filter((name) => name.startsWith("dag_")).sort(), [...DAG_AGENT_TOOLS].sort());
  assert.equal(new Set(next).size, next.length);
});

test("applying does not mutate its input", () => {
  const active = ["read"];
  applyToolModes(active, modes({ codemode: true, toolSearch: true, dynamicDag: true }));
  assert.deepEqual(active, ["read"]);
});

test("settings changes: absent reads as on, so turning off is the change and writing true is not", () => {
  assert.equal(toolModeSettingsChanged({}, { codemode: false }), true);
  assert.equal(toolModeSettingsChanged({ toolSearch: false }, {}), true);
  assert.equal(toolModeSettingsChanged({}, { codemode: true }), false);
  assert.equal(toolModeSettingsChanged({ codemode: true }, {}), false);
  assert.equal(toolModeSettingsChanged({ theme: "a" }, { theme: "b" }), false);
  assert.equal(toolModeSettingsChanged({ codemode: false, toolSearch: true }, { codemode: false }), false);
  assert.equal(toolModeSettingsChanged({}, { dynamicDag: false }), true);
  assert.equal(toolModeSettingsChanged({ dynamicDag: false }, {}), true);
  assert.equal(toolModeSettingsChanged({}, { dynamicDag: true }), false);
});
