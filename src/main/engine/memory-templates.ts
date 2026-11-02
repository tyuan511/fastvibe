import { readFileSync } from "node:fs";
import { join } from "node:path";
import { boundedMemorySummary, SUMMARY_PROMPT_MAX_CHARS } from "./memory-summary.ts";

export { SUMMARY_PROMPT_MAX_CHARS } from "./memory-summary.ts";

/**
 * The four prompts of the memory pipeline, which are Codex's own (see `resources/memories/NOTICE.md`):
 * stage 1 reads one finished conversation, consolidation maintains the handbook, and the
 * read path tells a live agent the handbook exists. They are model instructions, so they
 * stay files that can be read and diffed as text, and are loaded by path the way the
 * built-in extensions and skills are (outside the asar, `resourcesPath/memories`).
 */

function templatesDir(): string {
  // Main pins this explicitly; the cwd fallback is for source-level tests (see `extension-manager.ts`).
  return join(process.env.FASTVIBE_RESOURCES_PATH?.trim() || join(process.cwd(), "resources"), "memories");
}

const cache = new Map<string, string>();

function load(name: string): string {
  const key = `${templatesDir()}/${name}`;
  let text = cache.get(key);
  if (text === undefined) {
    text = readFileSync(join(templatesDir(), name), "utf8");
    cache.set(key, text);
  }
  return text;
}

/** Fill `{{ name }}` placeholders. A placeholder with no value is a packaging bug, not an empty string. */
export function renderTemplate(template: string, values: Record<string, string>): string {
  return template.replace(/\{\{\s*([a-z0-9_]+)\s*\}\}/g, (_match, name: string) => {
    const value = values[name];
    if (value === undefined) throw new Error(`memory template placeholder {{ ${name} }} has no value`);
    return value;
  });
}

export const stage1System = (): string => load("stage_one_system.md");

export function stage1Input(input: { rolloutPath: string; rolloutCwd: string; contents: string }): string {
  return renderTemplate(load("stage_one_input.md"), { rollout_path: input.rolloutPath, rollout_cwd: input.rolloutCwd, rollout_contents: input.contents });
}

/** The file the consolidation agent reads first; named in the prompt as well as written by `memory-workspace.ts`. */
export const WORKSPACE_DIFF_FILE = "phase2_workspace_diff.md";

export function consolidationPrompt(memoryRoot: string): string {
  return renderTemplate(load("consolidation.md"), { memory_root: memoryRoot, phase2_workspace_diff_file: WORKSPACE_DIFF_FILE, summary_max_chars: String(SUMMARY_PROMPT_MAX_CHARS) });
}

export function readPathPrompt(input: { basePath: string; summary: string }): string {
  const summary = boundedMemorySummary(input.summary, input.basePath);
  return `\n\n${renderTemplate(load("read_path.md"), { base_path: input.basePath, memory_summary: summary.trim() })}`;
}

/** Keep Codex's read rules stable while the changing summary travels as context. */
export function readPathContext(input: { basePath: string; summary: string }): { systemPrompt: string; content: string } {
  return {
    systemPrompt: readPathPrompt({ basePath: input.basePath, summary: "Use the latest FastVibe memory context snapshot in this conversation for the current MEMORY_SUMMARY." }),
    content: `========= MEMORY_SUMMARY BEGINS =========\n${boundedMemorySummary(input.summary, input.basePath)}\n========= MEMORY_SUMMARY ENDS =========`,
  };
}
