import assert from "node:assert/strict";
import test from "node:test";
import { bindBrowserConversation, bindComputerConversation } from "../src/main/pi/conversation-binding.ts";

const globals = globalThis as Record<string, unknown>;
const browserKey = "__fastvibeBrowserConversationId";
const computerKey = "__fastvibeComputerConversationId";

test("concurrent extension reloads capture their own browser and computer conversation", async () => {
  const beforeBrowser = globals[browserKey];
  const beforeComputer = globals[computerKey];
  const seen: string[] = [];
  const results = await Promise.all(["a", "b", "c"].map((id) =>
    bindBrowserConversation(id, () => bindComputerConversation(id, async () => {
      assert.equal(globals[browserKey], id);
      assert.equal(globals[computerKey], id);
      await new Promise((resolve) => setTimeout(resolve, 5));
      assert.equal(globals[browserKey], id);
      assert.equal(globals[computerKey], id);
      seen.push(id);
      return id;
    })),
  ));
  assert.deepEqual(results, ["a", "b", "c"]);
  assert.deepEqual(seen, results);
  assert.equal(globals[browserKey], beforeBrowser);
  assert.equal(globals[computerKey], beforeComputer);
});

test("failed reload restores existing scope and does not poison the next reload", async () => {
  globals[browserKey] = "previous";
  try {
    await assert.rejects(bindBrowserConversation("failed", async () => {
      assert.equal(globals[browserKey], "failed");
      throw new Error("reload failed");
    }), /reload failed/);
    assert.equal(globals[browserKey], "previous");
    await bindBrowserConversation("next", async () => {
      assert.equal(globals[browserKey], "next");
    });
    assert.equal(globals[browserKey], "previous");
  } finally {
    delete globals[browserKey];
  }
});
