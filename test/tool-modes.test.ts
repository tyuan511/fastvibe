import test from "node:test";
import assert from "node:assert/strict";
import { applyToolModes, toolModes, toolModeSettingsChanged } from "../src/main/engine/tool-modes.ts";

test("both tools are on by default, with nothing saved and no servers", () => {
  assert.deepEqual(toolModes({}, []), { codemode: true, toolSearch: true });
});

test("the user's switches turn each tool off, independently", () => {
  assert.deepEqual(toolModes({ codemode: false }, []), { codemode: false, toolSearch: true });
  assert.deepEqual(toolModes({ toolSearch: false }, []), { codemode: true, toolSearch: false });
  assert.deepEqual(toolModes({ codemode: false, toolSearch: false }, []), { codemode: false, toolSearch: false });
});

test("only a literal false is off; anything else a settings file might hold is on", () => {
  assert.deepEqual(toolModes({ codemode: "false", toolSearch: 0 }, []), { codemode: true, toolSearch: true });
  assert.deepEqual(toolModes({ codemode: null, toolSearch: undefined }, []), { codemode: true, toolSearch: true });
});

test("a codemode server keeps codemode on and a deferred one keeps tool_search on, switches off or not", () => {
  const off = { codemode: false, toolSearch: false };
  assert.deepEqual(toolModes(off, [{ enabled: true, exposure: "codemode" }]), { codemode: true, toolSearch: false });
  assert.deepEqual(toolModes(off, [{ enabled: true, exposure: "deferred" }]), { codemode: false, toolSearch: true });
});

test("a direct server, or none, implies nothing", () => {
  const off = { codemode: false, toolSearch: false };
  assert.deepEqual(toolModes(off, [{ enabled: true, exposure: "direct" }, { enabled: true }]), { codemode: false, toolSearch: false });
});

test("a disabled server does not keep anything on", () => {
  const off = { codemode: false, toolSearch: false };
  assert.deepEqual(toolModes(off, [{ enabled: false, exposure: "codemode" }, { enabled: false, exposure: "deferred" }]), {
    codemode: false,
    toolSearch: false,
  });
});

test("applying adds the missing tools once and keeps the order of the rest", () => {
  assert.deepEqual(applyToolModes(["read", "bash"], { codemode: true, toolSearch: true }), ["read", "bash", "codemode", "tool_search"]);
  assert.deepEqual(applyToolModes(["read", "codemode"], { codemode: true, toolSearch: false }), ["read", "codemode"]);
});

test("applying removes a tool that is no longer wanted and touches nothing else", () => {
  assert.deepEqual(applyToolModes(["read", "codemode", "tool_search", "mcp_x_y"], { codemode: false, toolSearch: false }), ["read", "mcp_x_y"]);
  assert.deepEqual(applyToolModes(["read", "codemode", "tool_search"], { codemode: true, toolSearch: false }), ["read", "codemode"]);
});

test("a set another extension narrowed keeps what it kept, and off adds nothing", () => {
  assert.deepEqual(applyToolModes(["read", "grep"], { codemode: false, toolSearch: false }), ["read", "grep"]);
  assert.deepEqual(applyToolModes(["read", "grep"], { codemode: true, toolSearch: true }), ["read", "grep", "codemode", "tool_search"]);
});

test("applying does not mutate its input", () => {
  const active = ["read"];
  applyToolModes(active, { codemode: true, toolSearch: true });
  assert.deepEqual(active, ["read"]);
});

test("settings changes: absent reads as on, so turning off is the change and writing true is not", () => {
  assert.equal(toolModeSettingsChanged({}, { codemode: false }), true);
  assert.equal(toolModeSettingsChanged({ toolSearch: false }, {}), true);
  assert.equal(toolModeSettingsChanged({}, { codemode: true }), false);
  assert.equal(toolModeSettingsChanged({ codemode: true }, {}), false);
  assert.equal(toolModeSettingsChanged({ theme: "a" }, { theme: "b" }), false);
  assert.equal(toolModeSettingsChanged({ codemode: false, toolSearch: true }, { codemode: false }), false);
});
