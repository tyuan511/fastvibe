import test from "node:test";
import assert from "node:assert/strict";
import type { ExtensionAPI, ToolDefinition } from "@earendil-works/pi-coding-agent";
import browserUse, { formatBrowserSnapshot } from "../resources/extensions/browser-use.ts";

function snapshotTool() {
  const tools = new Map<string, ToolDefinition>();
  browserUse({ registerTool: (tool: ToolDefinition) => tools.set(tool.name, tool) } as unknown as ExtensionAPI);
  return tools.get("browser_snapshot")!;
}

const globals = globalThis as Record<string, unknown>;
test("snapshot scope and source options reach the bridge without changing structured results", async () => {
  const previous = globals.__fastvibeBrowserRequest;
  const requests: any[] = [];
  const page = { tabId: "tab-a", url: "https://example.com", title: "Settings", text: "Ready", elementCount: 0, truncated: true,
    source: "cdp-accessibility", scope: { rootRef: "old:panel" }, limitations: ["Iframe contents not expanded"],
    nodes: [{ role: "region", name: "Settings", ref: "new:panel", childrenCount: 20, subtreeTruncated: true }], elements: [] };
  globals.__fastvibeBrowserRequest = async (request: unknown) => { requests.push(request); return page; };
  try {
    const tool = snapshotTool();
    const params = { tabId: "tab-a", snapshotMode: "accessibility", rootRef: "old:panel", maxDepth: 2, maxElements: 40 };
    const result = await tool.execute("snapshot", params, undefined, undefined, {} as never) as any;
    assert.equal(result.structuredContent, page);
    assert.equal(result.details, page);
    assert.equal(requests[0].action, "snapshot");
    for (const [key, value] of Object.entries(params)) assert.equal(requests[0][key], value);
    assert.match(result.content[0].text, /Source: cdp-accessibility/);
    assert.match(result.content[0].text, /Iframe contents not expanded/);
    assert.match(result.content[0].text, /\[children=20\] \[truncated\]/);
    assert.match(result.content[0].text, /Partial snapshot/);
    assert.doesNotMatch(result.content[0].text, /"elements"/);
    await tool.execute("snapshot", { selector: "#settings" }, undefined, undefined, {} as never);
    assert.equal(requests[1].selector, "#settings");
    assert.equal(requests[1].snapshotMode, undefined, "the existing DOM default is retained");
  } finally { globals.__fastvibeBrowserRequest = previous; }
});

test("invalid snapshot scopes and budgets stop before calling the bridge", async () => {
  const previous = globals.__fastvibeBrowserRequest;
  let calls = 0;
  globals.__fastvibeBrowserRequest = async () => { calls++; return {}; };
  try {
    const tool = snapshotTool();
    for (const params of [
      { selector: "#a", rootRef: "s:b" }, { selector: " " }, { rootRef: "" },
      { snapshotMode: "unknown" }, { maxDepth: 0 }, { maxDepth: 51 }, { maxDepth: 1.5 },
      { maxElements: 0 }, { maxElements: 501 },
    ]) await assert.rejects(tool.execute("snapshot", params, undefined, undefined, {} as never), /browser_snapshot/);
    assert.equal(calls, 0);
  } finally { globals.__fastvibeBrowserRequest = previous; }
});

test("scope errors remain failures instead of formatting an unrelated page as a snapshot", async () => {
  const previous = globals.__fastvibeBrowserRequest;
  globals.__fastvibeBrowserRequest = async () => ({ ok: false, code: "STALE_REF", error: "Scope expired" });
  try {
    await assert.rejects(snapshotTool().execute("snapshot", { rootRef: "old:panel" }, undefined, undefined, {} as never), /STALE_REF/);
  } finally { globals.__fastvibeBrowserRequest = previous; }
  const text = formatBrowserSnapshot({ title: "A", nodes: [{ role: "alert", name: "Failed to save" }], text: "Failed to save\nFailed to save: retry later" });
  assert.match(text, /alert "Failed to save"/);
  assert.match(text, /Failed to save: retry later/);
});
