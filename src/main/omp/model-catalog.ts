import type { ThinkingLevel } from "@shared/types";

export type ModelInput = "text" | "image" | "video" | "file";

/** Effort values omp accepts in `thinking.efforts`. `off` is not a valid effort. */
export const VALID_EFFORTS: readonly string[] = ["minimal", "low", "medium", "high", "xhigh", "max"];

export function toValidEfforts(levels: readonly string[] | undefined): string[] {
  if (!levels) return [];
  return levels.filter((level) => VALID_EFFORTS.includes(level));
}

export type BuiltinModelInfo = {
  id: string;
  name: string;
  contextWindow: number;
  maxTokens: number;
  reasoning: boolean;
  input: ModelInput[];
  thinkingLevels: ThinkingLevel[];
  defaultThinkingLevel: ThinkingLevel;
  thinkingFormat?: "openai" | "zai";
};

const CATALOG: Record<string, BuiltinModelInfo> = {
  "grok-4.6": {
    id: "grok-4.6",
    name: "Grok 4.6",
    contextWindow: 500_000,
    maxTokens: 128_000,
    reasoning: true,
    input: ["text", "image"],
    thinkingLevels: ["low", "medium", "high", "xhigh"],
    defaultThinkingLevel: "high",
    thinkingFormat: "openai",
  },
  "kimi-k3": {
    id: "kimi-k3",
    name: "Kimi K3",
    contextWindow: 1_048_576,
    maxTokens: 131_072,
    reasoning: true,
    input: ["text", "image"],
    thinkingLevels: ["low", "high", "max"],
    defaultThinkingLevel: "high",
  },
  "glm-5.3": {
    id: "glm-5.3",
    name: "GLM-5.3",
    contextWindow: 1_048_576,
    maxTokens: 128_000,
    reasoning: true,
    input: ["text"],
    thinkingLevels: ["low", "high", "max"],
    defaultThinkingLevel: "max",
    thinkingFormat: "zai",
  },
  "glm-5.3-flash": {
    id: "glm-5.3-flash",
    name: "GLM-5.3 Flash",
    contextWindow: 1_048_576,
    maxTokens: 128_000,
    reasoning: true,
    input: ["text", "image", "video", "file"],
    thinkingLevels: ["low", "high", "max"],
    defaultThinkingLevel: "max",
    thinkingFormat: "zai",
  },
  "deepseek-flash": {
    id: "deepseek-flash",
    name: "DeepSeek Flash",
    contextWindow: 1_048_576,
    maxTokens: 384_000,
    reasoning: true,
    input: ["text", "image"],
    thinkingLevels: ["low", "high", "max"],
    defaultThinkingLevel: "high",
    thinkingFormat: "openai",
  },
  "deepseek-v4-pro": {
    id: "deepseek-v4-pro",
    name: "DeepSeek V4 Pro",
    contextWindow: 1_048_576,
    maxTokens: 384_000,
    reasoning: true,
    input: ["text"],
    thinkingLevels: ["low", "high", "max"],
    defaultThinkingLevel: "high",
    thinkingFormat: "openai",
  },
};

const ALIASES: Record<string, string> = {
  "grok-4.6": "grok-4.6",
  "grok-4-6": "grok-4.6",
  grok46: "grok-4.6",
  "kimi-k3": "kimi-k3",
  kimi_k3: "kimi-k3",
  "moonshot-kimi-k3": "kimi-k3",
  "glm-5.3": "glm-5.3",
  "glm-5-3": "glm-5.3",
  glm53: "glm-5.3",
  "glm-5.3-flash": "glm-5.3-flash",
  "glm-5-3-flash": "glm-5.3-flash",
  glm53flash: "glm-5.3-flash",
  "deepseek-flash": "deepseek-flash",
  "deepseek-v4-flash": "deepseek-flash",
  "deepseek-v4-flash-vision-exp": "deepseek-flash",
  "deepseek-v4.1-flash": "deepseek-flash",
  "deepseek-v4-1-flash": "deepseek-flash",
  "deepseek-v41-flash": "deepseek-flash",
  "deepseek-v4-pro": "deepseek-v4-pro",
  "deepseek-v4-pro-0813": "deepseek-v4-pro",
};

export const PREFERRED_MODEL_IDS = [
  "grok-4.6",
  "kimi-k3",
  "glm-5.3",
  "glm-5.3-flash",
  "deepseek-flash",
  "deepseek-v4-pro",
] as const;

export function normalizeModelId(id: string): string {
  return id.trim().toLowerCase().replaceAll("_", "-");
}

export function lookupBuiltinModel(id: string): BuiltinModelInfo | undefined {
  const normalized = normalizeModelId(id);
  const direct = ALIASES[normalized] ?? (CATALOG[normalized] ? normalized : undefined);
  if (direct) return CATALOG[direct];

  for (const canonical of Object.keys(CATALOG)) {
    if (normalized === canonical || normalized.endsWith(`-${canonical}`) || normalized.endsWith(`/${canonical}`)) {
      return CATALOG[canonical];
    }
  }
  return undefined;
}

export function pickDefaultModelId(ids: string[]): string {
  for (const preferred of PREFERRED_MODEL_IDS) {
    const match = ids.find((id) => lookupBuiltinModel(id)?.id === preferred);
    if (match) return match;
  }
  return ids[0] ?? PREFERRED_MODEL_IDS[0];
}
