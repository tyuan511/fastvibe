import { existsSync, mkdirSync, readdirSync, readFileSync, unlinkSync, writeFileSync, renameSync } from "node:fs";
import { join, basename } from "node:path";
import { parseFrontmatter } from "@earendil-works/pi-coding-agent";
import { THINKING_EFFORT_LEVELS, type SubagentConfig, type SubagentDraft, type ThinkingLevel } from "@shared/types";
import { BUILTIN_AGENTS, builtinExtensionFile } from "../pi/extension-manager";
import type { FastVibePaths } from "./paths";
import { uiText } from "./ui-text";

type Frontmatter = {
  name?: unknown;
  description?: unknown;
  tools?: unknown;
  model?: unknown;
  thinkingLevel?: unknown;
};

type StoredOverrides = {
  version: 2;
  models: Record<string, string>;
  thinkingLevels: Record<string, ThinkingLevel>;
};

const BUILTIN_IDS = ["explorer", "planner", "worker", "reviewer"] as const;
const LEGACY_SCOUT_ID = "scout";
const NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;
const MODEL_PATTERN = /^[^\s/]+\/[^\s]+$/;

function parseTools(value: unknown): string[] {
  const raw = Array.isArray(value) ? value : typeof value === "string" ? value.split(",") : [];
  return raw.filter((item): item is string => typeof item === "string").map((item) => item.trim()).filter(Boolean);
}

function readMarkdown(filePath: string, source: "builtin" | "custom", id: string): SubagentConfig | null {
  try {
    const content = readFileSync(filePath, "utf8");
    const { frontmatter, body } = parseFrontmatter<Frontmatter>(content);
    if (typeof frontmatter.name !== "string" || typeof frontmatter.description !== "string") return null;
    return {
      id,
      name: frontmatter.name,
      description: frontmatter.description,
      tools: parseTools(frontmatter.tools),
      model: typeof frontmatter.model === "string" && frontmatter.model.trim() ? frontmatter.model.trim() : undefined,
      thinkingLevel: safeThinkingLevel(frontmatter.thinkingLevel) ?? "medium",
      systemPrompt: body.trim(),
      source,
    };
  } catch {
    return null;
  }
}

function quote(value: string): string {
  return JSON.stringify(value.replace(/[\r\n]/g, " "));
}

function renderMarkdown(draft: SubagentDraft): string {
  const lines = [
    "---",
    `name: ${quote(draft.name)}`,
    `description: ${quote(draft.description)}`,
    `tools: ${JSON.stringify(draft.tools)}`,
  ];
  if (draft.model) lines.push(`model: ${quote(draft.model)}`);
  lines.push(`thinkingLevel: ${quote(safeThinkingLevel(draft.thinkingLevel) ?? "medium")}`);
  lines.push("---", "", draft.systemPrompt.trim(), "");
  return `${lines.join("\n")}\n`;
}

function safeModel(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const model = value.trim();
  return model && MODEL_PATTERN.test(model) ? model : undefined;
}

function safeThinkingLevel(value: unknown): ThinkingLevel | undefined {
  return typeof value === "string" && THINKING_EFFORT_LEVELS.includes(value as ThinkingLevel)
    ? value as ThinkingLevel
    : undefined;
}

export class SubagentManager {
  readonly #paths: FastVibePaths;
  readonly #customDir: string;

  constructor(paths: FastVibePaths) {
    this.#paths = paths;
    this.#customDir = join(paths.agentDir, "agents");
    mkdirSync(this.#customDir, { recursive: true });
  }

  list(): SubagentConfig[] {
    const overrides = this.#readOverrides();
    const builtins = BUILTIN_IDS.map((id) => {
      const filePath = builtinExtensionFile(`subagent/agents/${id}.md`);
      const fallback = BUILTIN_AGENTS.find((item) => item.id === id);
      const config = filePath ? readMarkdown(filePath, "builtin", id) : null;
      return {
        id,
        name: config?.name ?? id,
        description: config?.description ?? fallback?.description ?? "",
        tools: config?.tools ?? [...(fallback?.tools ?? [])],
        systemPrompt: config?.systemPrompt ?? "",
        source: "builtin" as const,
        thinkingLevel: overrides.thinkingLevels[id] ?? config?.thinkingLevel ?? "medium",
        ...((overrides.models[id] ?? config?.model) ? { model: overrides.models[id] ?? config?.model } : {}),
      } satisfies SubagentConfig;
    });

    const custom: SubagentConfig[] = [];
    if (existsSync(this.#customDir)) {
      for (const entry of readdirSync(this.#customDir, { withFileTypes: true })) {
        if (!entry.isFile() || !entry.name.endsWith(".md")) continue;
        const id = basename(entry.name, ".md");
        const config = readMarkdown(join(this.#customDir, entry.name), "custom", id);
        if (config) custom.push(config);
      }
    }
    return [...builtins, ...custom];
  }

  modelFor(agentName: string, declared?: string, source?: "user" | "project"): string | undefined {
    if (source === "project" || declared) return declared;
    const config = this.list().find((item) => item.id === agentName || item.name === agentName);
    return config?.model;
  }

  thinkingLevelFor(
    agentName: string,
    declared?: ThinkingLevel,
    source?: "user" | "project",
  ): ThinkingLevel {
    if (source === "project" || declared) return declared ?? "medium";
    const config = this.list().find((item) => item.id === agentName || item.name === agentName);
    return config?.thinkingLevel ?? "medium";
  }

  save(draft: SubagentDraft): SubagentConfig[] {
    const name = draft.name.trim();
    const description = draft.description.trim();
    const systemPrompt = draft.systemPrompt.trim();
    const tools = [...new Set(draft.tools.map((tool) => tool.trim()).filter(Boolean))];
    const current = draft.id ? this.list().find((item) => item.id === draft.id) : undefined;

    // Built-in agents only persist model and reasoning overrides. Their prompt comes
    // from the bundled role file and is intentionally not sent back by the settings form.
    if (current?.source === "builtin") {
      if (draft.model && !MODEL_PATTERN.test(draft.model.trim())) throw new Error(uiText("模型格式应为 provider/model", "Model must use the provider/model format"));
      const overrides = this.#readOverrides();
      if (draft.model?.trim()) overrides.models[current.id] = draft.model.trim();
      else delete overrides.models[current.id];
      overrides.thinkingLevels[current.id] = safeThinkingLevel(draft.thinkingLevel) ?? "medium";
      this.#writeOverrides(overrides);
      return this.list();
    }

    if (!NAME_PATTERN.test(name)) throw new Error(uiText("子 Agent 名称只能包含字母、数字、下划线和连字符", "Subagent names may contain only letters, numbers, underscores and hyphens"));
    if (!description) throw new Error(uiText("子 Agent 描述不能为空", "Subagent description is required"));
    if (!systemPrompt) throw new Error(uiText("子 Agent 提示词不能为空", "Subagent system prompt is required"));
    if (draft.model && !MODEL_PATTERN.test(draft.model.trim())) throw new Error(uiText("模型格式应为 provider/model", "Model must use the provider/model format"));

    const id = current?.id ?? this.#newId(name);
    const duplicate = this.list().find((item) => item.id !== id && item.name.toLowerCase() === name.toLowerCase());
    if (duplicate) throw new Error(uiText("已经存在同名的子 Agent", "A subagent with that name already exists"));
    const next: SubagentDraft = {
      id,
      name,
      description,
      tools,
      systemPrompt,
      model: draft.model?.trim() || undefined,
      thinkingLevel: safeThinkingLevel(draft.thinkingLevel) ?? "medium",
    };
    const filePath = join(this.#customDir, `${id}.md`);
    const tempPath = `${filePath}.tmp-${process.pid}`;
    writeFileSync(tempPath, renderMarkdown(next), { mode: 0o600 });
    renameSync(tempPath, filePath);
    return this.list();
  }

  remove(id: string): SubagentConfig[] {
    const config = this.list().find((item) => item.id === id);
    if (!config) throw new Error(uiText("子 Agent 不存在", "Subagent not found"));
    if (config.source === "builtin") throw new Error(uiText("内置子 Agent 不能删除", "Built-in subagents cannot be deleted"));
    unlinkSync(join(this.#customDir, `${id}.md`));
    return this.list();
  }

  #newId(name: string): string {
    const base = name.toLowerCase().replace(/[^a-z0-9_-]+/g, "-").replace(/^-+|-+$/g, "") || "agent";
    const used = new Set(this.list().map((item) => item.id));
    if (!used.has(base)) return base;
    for (let index = 2; ; index += 1) {
      const candidate = `${base}-${index}`;
      if (!used.has(candidate)) return candidate;
    }
  }

  #readOverrides(): StoredOverrides {
    try {
      const value = JSON.parse(readFileSync(this.#paths.subagentsFile, "utf8")) as Partial<StoredOverrides>;
      const models = value.models && typeof value.models === "object" ? value.models : {};
      const thinkingLevels = value.thinkingLevels && typeof value.thinkingLevels === "object" ? value.thinkingLevels : {};
      const safeModels = Object.fromEntries(
        Object.entries(models).filter(([key, model]) => Boolean(key) && typeof model === "string" && MODEL_PATTERN.test(model)),
      );
      const safeThinkingLevels = Object.fromEntries(
        Object.entries(thinkingLevels).filter(([key, level]) => Boolean(key) && Boolean(safeThinkingLevel(level))),
      ) as Record<string, ThinkingLevel>;

      // `scout` was renamed to `explorer`; preserve an existing built-in override
      // unless the user has already saved an explicit value under the new id.
      if (safeModels.explorer === undefined && safeModels[LEGACY_SCOUT_ID] !== undefined) {
        safeModels.explorer = safeModels[LEGACY_SCOUT_ID];
      }
      if (safeThinkingLevels.explorer === undefined && safeThinkingLevels[LEGACY_SCOUT_ID] !== undefined) {
        safeThinkingLevels.explorer = safeThinkingLevels[LEGACY_SCOUT_ID];
      }
      delete safeModels[LEGACY_SCOUT_ID];
      delete safeThinkingLevels[LEGACY_SCOUT_ID];

      return { version: 2, models: safeModels, thinkingLevels: safeThinkingLevels };
    } catch {
      return { version: 2, models: {}, thinkingLevels: {} };
    }
  }

  #writeOverrides(value: StoredOverrides): void {
    const tempPath = `${this.#paths.subagentsFile}.tmp-${process.pid}`;
    writeFileSync(tempPath, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
    renameSync(tempPath, this.#paths.subagentsFile);
  }
}
