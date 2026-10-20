#!/usr/bin/env node
// 冷会话打开里「extensions」这一段的耗时基线（`[session] opening … extensions N` 日志里最大的一项）。
//
// 用与 `PiProcessManager.#createSession` 相同的方式构造 `DefaultResourceLoader`
// （同样的内置扩展与技能），在一个全新的临时 agentDir 里反复 `reload()`，每次换一个 cwd
// ——SDK 的扩展缓存按 cwd 失效，所以这就是第二个、第三个对话打开时付出的代价。
// 不碰真实的 userData，所以可以在安装版运行时直接跑。
//
//   node scripts/bench-session-open.mjs [rounds]
//   node --cpu-prof --cpu-prof-dir=/tmp/prof scripts/bench-session-open.mjs 6
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { DefaultResourceLoader, SettingsManager } from "@earendil-works/pi-coding-agent";

const root = resolve(import.meta.dirname, "..");
const resources = join(root, "resources");
const rounds = Number(process.argv[2] ?? 5);

const EXTENSIONS = [
  "goal.ts", "handoff.ts", "todo.ts", "question.ts", "output-language.ts", "folder-consent.ts",
  "session-title.ts", "browser-use.ts", "computer-use.ts", "web-search.ts", "conversation-search.ts",
  "worktree.ts", "present.ts", "app-config.ts", "dag.ts", "schedules.ts", "pdf-attachment.ts", "subagent/index.ts",
].map((file) => join(resources, "extensions", file));
const SKILLS = ["browser-use", "computer-use", "fastvibe-setup", "skill-creator", "find-skills", "pdf", "office"]
  .map((name) => join(resources, "skills", name, "SKILL.md"));

const agentDir = mkdtempSync(join(tmpdir(), "fv-bench-agent-"));
writeFileSync(join(agentDir, "settings.json"), JSON.stringify({ packages: [] }));

async function once(cwd) {
  const settingsManager = SettingsManager.create(cwd, agentDir);
  const loader = new DefaultResourceLoader({
    cwd,
    agentDir,
    settingsManager,
    additionalExtensionPaths: EXTENSIONS,
    additionalSkillPaths: SKILLS,
  });
  const started = performance.now();
  await loader.reload();
  const ms = performance.now() - started;
  const result = loader.getExtensions();
  return { ms, extensions: result.extensions.length, errors: result.errors.length };
}

for (let i = 0; i < rounds; i++) {
  const cwd = join(agentDir, `project-${i}`);
  mkdirSync(cwd, { recursive: true });
  const { ms, extensions, errors } = await once(cwd);
  console.log(`round ${i + 1}: reload ${ms.toFixed(0)} ms  extensions=${extensions} errors=${errors}`);
}
