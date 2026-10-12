import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import type { Conversation } from "../src/shared/types.ts";
import { MemoryManager, readMemoryConfig, removeLegacyMemory } from "../src/main/engine/memory.ts";
import type { MemoryRuntime } from "../src/main/engine/memory-host.ts";
import { MEMORY_CONFIG_VERSION } from "../src/shared/memory.ts";

const HOUR = 3_600_000;
const UUID = (n: number): string => `0190a5e4-7b3c-7000-8000-${String(n).padStart(12, "0")}`;
const entry = (role: string, text: string): SessionEntry => ({ type: "message", id: text.slice(0, 6), parentId: null, timestamp: "", message: { role, content: text } } as unknown as SessionEntry);
const BRANCH = [entry("user", "把构建脚本改成并行，并保持 pnpm 不变。".repeat(6)), entry("assistant", "已经改好 package.json 里的 build 脚本。".repeat(6))];

type Harness = {
  dir: string;
  manager: MemoryManager;
  calls: { complete: number; agent: number };
  chats: Conversation[];
  files: { memoryFile: string; memoriesDir: string; memoriesBaselineDir: string; memoryStateFile: string };
  agentSaw: string[];
  answer: { value: string | Error };
  agentWrites: { value: boolean };
};

function harness(options: { enabled?: boolean; chats?: number } = {}): Harness {
  const dir = mkdtempSync(join(tmpdir(), "fv-memory-"));
  const files = { memoryFile: join(dir, "memory.json"), memoriesDir: join(dir, "memories"), memoriesBaselineDir: join(dir, "memories-baseline"), memoryStateFile: join(dir, "memory-state.json") };
  if (options.enabled !== false) writeFileSync(files.memoryFile, JSON.stringify({ version: MEMORY_CONFIG_VERSION, enabled: true }));
  const chats: Conversation[] = [];
  for (let index = 0; index < (options.chats ?? 2); index += 1) {
    const sessionFile = join(dir, `c${index}.jsonl`);
    writeFileSync(sessionFile, "{}\n");
    const old = new Date(Date.now() - 8 * HOUR);
    utimesSync(sessionFile, old, old);
    chats.push({ id: UUID(index), title: `Chat ${index}`, cwd: "/work/app", project: "/work/app", sessionFile, createdAt: 0, updatedAt: 0 });
  }
  const calls = { complete: 0, agent: 0 };
  const agentSaw: string[] = [];
  const answer: Harness["answer"] = { value: JSON.stringify({ raw_memory: "# Build\n- 用 pnpm", rollout_summary: "改了并行构建", rollout_slug: "parallel-build" }) };
  const agentWrites = { value: true };
  const runtime: MemoryRuntime = {
    conversations: () => chats,
    loadBranch: async () => BRANCH,
    complete: async () => {
      calls.complete += 1;
      if (answer.value instanceof Error) throw answer.value;
      return answer.value;
    },
    inputBudgetChars: () => 450_000,
    runAgent: async ({ cwd, task }) => {
      calls.agent += 1;
      // What the agent is shown: Codex's prompt, and the diff file it names, present while it runs.
      assert.match(task, /Memory Writing Agent: Phase 2 \(Consolidation\)/);
      agentSaw.push(readFileSync(join(cwd, "phase2_workspace_diff.md"), "utf8"));
      if (!agentWrites.value) return;
      writeFileSync(join(cwd, "MEMORY.md"), "# Task Group: app\n- build: pnpm, parallel\n");
      writeFileSync(join(cwd, "memory_summary.md"), "v1\n\n## User Profile\n偏好 pnpm。\n");
    },
  };
  const manager = new MemoryManager(files);
  manager.attach(runtime);
  return { dir, manager, calls, chats, files, answer, agentWrites, agentSaw };
}

const cleanup = (h: Harness): void => { h.manager.close(); rmSync(h.dir, { recursive: true, force: true }); };
const ids = (h: Harness): string[] => h.chats.map((chat) => chat.id);

test("memory is off unless this version's config switched it on", () => {
  const h = harness({ enabled: false });
  try {
    assert.equal(h.manager.config.enabled, false);
    writeFileSync(h.files.memoryFile, JSON.stringify({ enabled: true, mode: "jev", autoCapture: true }));
    assert.equal(readMemoryConfig(h.files.memoryFile).enabled, false);
  } finally { cleanup(h); }
});

test("off means nothing runs", async () => {
  const h = harness({ enabled: false });
  try {
    const state = await h.manager.run();
    assert.equal(h.calls.complete, 0);
    assert.equal(state.config.enabled, false);
    assert.equal(existsSync(h.files.memoriesDir), false);
  } finally { cleanup(h); }
});

test("a pass distils quiet conversations, hands the agent the diff, and the second pass finds nothing to do", async () => {
  const h = harness();
  try {
    const state = await h.manager.run();
    assert.equal(state.error, undefined);
    assert.equal(state.conversations, 2);
    assert.equal(state.ready, true);
    assert.equal(h.calls.complete, 2);
    assert.equal(h.calls.agent, 1);
    const dir = h.files.memoriesDir;
    assert.equal(readdirSync(join(dir, "rollout_summaries")).length, 2);
    const raw = readFileSync(join(dir, "raw_memories.md"), "utf8");
    assert.match(raw, /^# Raw Memories\n\nMerged stage-1 raw memories/);
    assert.match(raw, /## Thread `0190a5e4-7b3c-7000-8000-000000000000`/);
    const recap = readFileSync(join(dir, "rollout_summaries", readdirSync(join(dir, "rollout_summaries"))[0]), "utf8");
    assert.match(recap, /^thread_id: 0190a5e4-7b3c-7000-8000-00000000000[01]\nupdated_at: /);
    assert.match(recap, /改了并行构建/);

    // The first run shows everything as new; the diff file is gone once the run is over.
    assert.match(h.agentSaw[0], /- added raw_memories\.md\n- added rollout_summaries\/.*\.md/);
    assert.equal(existsSync(join(dir, "phase2_workspace_diff.md")), false);
    assert.ok(readdirSync(h.files.memoriesBaselineDir).includes("MEMORY.md"), "the baseline is the folder as the agent left it");

    await h.manager.run();
    assert.equal(h.calls.complete, 2, "nothing changed, nothing is read again");
    assert.equal(h.calls.agent, 1, "an unchanged folder does not wake the agent");
  } finally { cleanup(h); }
});

test("a conversation that moved on is read again and the agent is shown just what changed", async () => {
  const h = harness({ chats: 1 });
  try {
    await h.manager.run();
    const file = h.chats[0].sessionFile!;
    const later = new Date(Date.now() - 7 * HOUR);
    utimesSync(file, later, later);
    h.answer.value = JSON.stringify({ raw_memory: "# Build\n- 改用 turbo", rollout_summary: "改成 turbo", rollout_slug: "turbo-build" });
    await h.manager.run();
    assert.equal(h.calls.complete, 2);
    assert.equal(h.calls.agent, 2);
    assert.match(h.agentSaw[1], /- modified raw_memories\.md/);
    assert.match(h.agentSaw[1], /^-.*并行构建|^\+.*turbo/m);
    assert.match(h.agentSaw[1], /- added rollout_summaries\/.*turbo_build\.md/);
    assert.match(h.agentSaw[1], /- deleted rollout_summaries\/.*parallel_build\.md/);
  } finally { cleanup(h); }
});

test("a failed extraction is reported, retried later, and never becomes memory", async () => {
  const h = harness({ chats: 1 });
  try {
    h.answer.value = new Error("429 rate limited");
    let state = await h.manager.run();
    assert.equal(state.conversations, 0);
    assert.match(state.error ?? "", /429/);
    assert.equal(h.calls.complete, 1);
    await h.manager.run();
    assert.equal(h.calls.complete, 1, "backing off for an hour");
    h.answer.value = "not json at all";
    state = await h.manager.run();
    assert.equal(state.conversations, 0);
  } finally { cleanup(h); }
});

test("a note without a recap, or the reverse, is nothing worth saving and is not asked again", async () => {
  const h = harness({ chats: 1 });
  try {
    h.answer.value = JSON.stringify({ raw_memory: "# only a note", rollout_summary: "", rollout_slug: "" });
    const state = await h.manager.run();
    assert.equal(state.conversations, 0);
    assert.equal(state.error, undefined);
    await h.manager.run();
    assert.equal(h.calls.complete, 1);
    assert.equal(h.calls.agent, 0);
    assert.equal(existsSync(h.files.memoriesDir), false);
  } finally { cleanup(h); }
});

test("consolidation that leaves no valid summary is an error, and does not become the baseline", async () => {
  const h = harness({ chats: 1 });
  try {
    h.agentWrites.value = false;
    const state = await h.manager.run();
    assert.equal(state.ready, false);
    assert.match(state.error ?? "", /MEMORY\.md was not written/);
    assert.equal(existsSync(h.files.memoriesBaselineDir), false);
    assert.equal(existsSync(join(h.files.memoriesDir, "phase2_workspace_diff.md")), false);
    h.agentWrites.value = true;
    const retried = await h.manager.run();
    assert.equal(retried.ready, true, "the next pass tries the consolidation again");
    assert.equal(retried.error, undefined);
  } finally { cleanup(h); }
});

test("a summary that does not start with v1 is refused", async () => {
  const h = harness({ chats: 1 });
  try {
    h.manager.attach({
      conversations: () => h.chats,
      loadBranch: async () => BRANCH,
      complete: async () => String(h.answer.value),
      inputBudgetChars: () => 450_000,
      runAgent: async ({ cwd }) => {
        writeFileSync(join(cwd, "MEMORY.md"), "# Task Group: x\n");
        writeFileSync(join(cwd, "memory_summary.md"), "## User Profile\n");
      },
    });
    const state = await h.manager.run();
    assert.match(state.error ?? "", /does not start with the line v1/);
    assert.equal(state.ready, false);
  } finally { cleanup(h); }
});

test("a deleted conversation takes its memory with it", async () => {
  const h = harness();
  try {
    await h.manager.run();
    h.chats.pop();
    const state = await h.manager.run();
    assert.equal(state.conversations, 1);
    assert.equal(readdirSync(join(h.files.memoriesDir, "rollout_summaries")).length, 1);
    assert.match(h.agentSaw[1], /- deleted rollout_summaries\//);
  } finally { cleanup(h); }
});

test("a live agent is shown Codex's read prompt with the summary, only when there is one", async () => {
  const h = harness({ chats: 1 });
  try {
    const handlers = new Map<string, (event: any) => any>();
    h.manager.extension()({ on: (name: string, handler: (event: any) => any) => { handlers.set(name, handler); } } as never);
    assert.equal(await handlers.get("before_agent_start")!({ systemPrompt: "BASE" }), undefined, "no summary yet, nothing to add");

    await h.manager.run();
    const after = await handlers.get("before_agent_start")!({ systemPrompt: "BASE" });
    assert.match(after.systemPrompt, /^BASE\n\n## Memory\n/);
    assert.match(after.systemPrompt, /Never update memories\. You can only read them\./);
    assert.match(after.systemPrompt, /========= MEMORY_SUMMARY BEGINS =========\nv1\n/);
    assert.match(after.systemPrompt, /偏好 pnpm/);
    assert.ok(after.systemPrompt.includes(`${h.files.memoriesDir}/MEMORY.md`));
  } finally { cleanup(h); }
});

test("a reply that cites a conversation counts as a use of it, and use decides what stays", async () => {
  const h = harness();
  try {
    await h.manager.run();
    const cited = ids(h)[1];
    const block = `Done.\n\n<oai-mem-citation>\n<citation_entries>\nMEMORY.md:1-2|note=[x]\n</citation_entries>\n<rollout_ids>\n${cited}\n${UUID(99)}\n</rollout_ids>\n</oai-mem-citation>`;
    h.manager.noteReply("no citation here");
    h.manager.noteReply(block);
    h.manager.close(); // flushes the debounced state write
    const saved = JSON.parse(readFileSync(h.files.memoryStateFile, "utf8"));
    assert.equal(saved.outputs[cited].usageCount, 1);
    assert.equal(saved.outputs[ids(h)[0]].usageCount, 0);
    assert.ok(saved.outputs[cited].lastUsage > 0);
  } finally { cleanup(h); }
});

test("switching off stops injecting but keeps the files; clearing removes them and the baseline", async () => {
  const h = harness({ chats: 1 });
  try {
    await h.manager.run();
    const handlers = new Map<string, (event: any) => any>();
    h.manager.extension()({ on: (name: string, handler: (event: any) => any) => { handlers.set(name, handler); } } as never);
    await h.manager.setConfig({ enabled: false });
    assert.equal(await handlers.get("before_agent_start")!({ systemPrompt: "BASE" }), undefined);
    assert.ok(existsSync(join(h.files.memoriesDir, "MEMORY.md")));
    assert.equal(JSON.parse(readFileSync(h.files.memoryFile, "utf8")).enabled, false);
    h.manager.noteReply("<oai-mem-citation><rollout_ids>\nx\n</rollout_ids></oai-mem-citation>");

    const state = await h.manager.clear();
    assert.equal(state.conversations, 0);
    assert.equal(state.ready, false);
    assert.equal(existsSync(h.files.memoriesDir), false);
    assert.equal(existsSync(h.files.memoriesBaselineDir), false);
  } finally { cleanup(h); }
});

test("a model chosen for memory reaches both stages, survives a restart, and clears with null", async () => {
  const h = harness({ chats: 1 });
  try {
    const seen: Array<string | undefined> = [];
    const pick = (model?: { provider: string; id: string }): string | undefined => (model ? `${model.provider}/${model.id}` : undefined);
    h.manager.attach({
      conversations: () => h.chats,
      loadBranch: async () => BRANCH,
      complete: async (_system, _user, _signal, model) => { seen.push(`complete:${pick(model)}`); return String(h.answer.value); },
      inputBudgetChars: (model) => { seen.push(`budget:${pick(model)}`); return 450_000; },
      runAgent: async ({ cwd, model }) => {
        seen.push(`agent:${pick(model)}`);
        writeFileSync(join(cwd, "MEMORY.md"), "# Task Group: x\n");
        writeFileSync(join(cwd, "memory_summary.md"), "v1\n");
      },
    });
    let state = await h.manager.setConfig({ model: { provider: "anthropic", id: "claude-x" } });
    assert.deepEqual(state.config.model, { provider: "anthropic", id: "claude-x" });
    assert.equal(state.config.enabled, true, "choosing a model does not switch memory on or off");
    await h.manager.run();
    assert.deepEqual(seen, ["budget:anthropic/claude-x", "complete:anthropic/claude-x", "agent:anthropic/claude-x"]);

    assert.deepEqual(readMemoryConfig(h.files.memoryFile).model, { provider: "anthropic", id: "claude-x" });
    state = await h.manager.setConfig({ model: null });
    assert.equal(state.config.model, undefined);
    assert.equal(readMemoryConfig(h.files.memoryFile).model, undefined);
    state = await h.manager.setConfig({ model: { provider: "", id: "x" } });
    assert.equal(state.config.model, undefined, "a half-formed model is no model");
  } finally { cleanup(h); }
});

test("the retired SQLite and embedding files are removed", () => {
  const dir = mkdtempSync(join(tmpdir(), "fv-legacy-"));
  try {
    writeFileSync(join(dir, "memory.sqlite"), "x");
    writeFileSync(join(dir, "memory.sqlite-wal"), "x");
    removeLegacyMemory(dir);
    assert.deepEqual(readdirSync(dir), []);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
