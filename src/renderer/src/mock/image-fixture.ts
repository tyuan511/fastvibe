import type { ImageConfig, ImageSession, ImageTask, ImagesApi, ImagesChanged } from "@shared/image-generation";

import { imageModelsFromProviders } from "@shared/image-model";
import type { ChatMessage, ProviderConfig, ToolCallBlock } from "@shared/types";

export const IMAGE_FIXTURE_PROVIDERS: ProviderConfig[] = [
  { id: "image-openai", name: "OpenAI Images", api: "image-gpt", baseUrl: "https://api.openai.com/v1", model: "gpt-image-1", modelName: "GPT Image" },
  { id: "image-google", name: "Google Images", api: "image-gemini", baseUrl: "https://generativelanguage.googleapis.com/v1beta", model: "gemini-2.5-flash-image", modelName: "Gemini Image" },
  { id: "image-xai", name: "xAI Images", api: "image-grok", baseUrl: "https://api.x.ai/v1", model: "grok-imagine-image", modelName: "Grok Imagine" },
].map((p) => ({ id: p.id, name: p.name, kind: "custom", api: p.api as ProviderConfig["api"], baseUrl: p.baseUrl, enabled: true, apiKeyEnv: p.id, hasKey: true, hasOAuth: false, supportsKey: true, models: [{ id: p.model, name: p.modelName, contextWindow: 128000, maxTokens: 8192, reasoning: false, input: ["text"] }] }));

/** Browser-only sample artwork and jobs; production always uses the host service. */
function artwork(index: number): string {
  const palettes = [["#e9e7dd", "#526d56", "#b4c4a4"], ["#e8daca", "#795246", "#cd9b78"], ["#e0e5e8", "#465d73", "#9db7c5"], ["#ede1c7", "#8a7251", "#c5b07c"]];
  const [paper, ink, accent] = palettes[index % palettes.length]!;
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="1024" height="1024" viewBox="0 0 1024 1024"><defs><radialGradient id="bg"><stop stop-color="${paper}"/><stop offset="1" stop-color="${accent}"/></radialGradient><filter id="s"><feGaussianBlur stdDeviation="28"/></filter><linearGradient id="v" x1="0" x2="1"><stop stop-color="${ink}"/><stop offset=".5" stop-color="${accent}"/><stop offset="1" stop-color="${ink}"/></linearGradient></defs><rect width="1024" height="1024" fill="url(#bg)"/><circle cx="775" cy="260" r="220" fill="${paper}" opacity=".7"/><ellipse cx="508" cy="846" rx="225" ry="30" fill="${ink}" opacity=".2" filter="url(#s)"/><path d="M385 470Q475 398 445 303L555 303Q525 398 615 470Q755 610 642 800Q510 855 378 800Q265 610 385 470" fill="url(#v)"/><ellipse cx="500" cy="304" rx="55" ry="13" fill="${ink}"/><path d="M501 304Q470 205 390 136M500 290Q544 169 630 96M500 270Q484 155 505 61" fill="none" stroke="${ink}" stroke-width="5"/><g fill="${ink}"><ellipse cx="394" cy="150" rx="16" ry="55" transform="rotate(-42 394 150)"/><ellipse cx="429" cy="199" rx="13" ry="43" transform="rotate(38 429 199)"/><ellipse cx="589" cy="145" rx="15" ry="57" transform="rotate(42 589 145)"/><ellipse cx="535" cy="201" rx="13" ry="42" transform="rotate(-24 535 201)"/><ellipse cx="503" cy="117" rx="13" ry="47"/></g><text x="70" y="92" font-family="Georgia,serif" font-size="30" fill="${ink}" letter-spacing="7">STILL / FORM</text><text x="74" y="935" font-family="Arial,sans-serif" font-size="15" fill="${ink}" letter-spacing="5">OBJECTS OF EVERYDAY CALM — ${String(index + 1).padStart(2, "0")}</text></svg>`;
  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
}

export function createImageFixture(sample: boolean, readConfig?: () => ImageConfig): ImagesApi {
  const now = Date.now();
  let revision = 1;
  const historyModels = imageModelsFromProviders(IMAGE_FIXTURE_PROVIDERS);
  const config: ImageConfig = {
    defaultModelId: "image-openai/gpt-image-1",
    models: historyModels,
  };
  let sessions: ImageSession[] = sample ? [
    { id: "image-session-still", title: "日常之物 · 陶器视觉探索", createdAt: now - 86400000, updatedAt: now, modelId: config.models[0]?.id, options: { count: 4, aspectRatio: "1:1" } },
    { id: "image-session-brand", title: "品牌图形与色彩", createdAt: now - 172800000, updatedAt: now - 3600000, modelId: config.models[1]?.id },
  ] : [];
  let tasks: ImageTask[] = sample ? [
    { id: "image-job-finished", requestId: "fixture-finished", sessionId: sessions[0]!.id, createdAt: now - 100000, completedAt: now - 60000, status: "succeeded", prompt: "一组宁静的陶器静物海报。自然光，温润的手作质感，鼠尾草绿与暖白色调，留白克制。", model: config.models[0]!, options: { count: 4, aspectRatio: "1:1" }, references: [], images: [0, 1, 2, 3].map((i) => ({ id: `sample-${i}`, path: artwork(i), mimeType: "image/svg+xml", width: 1024, height: 1024 })) },
    { id: "image-job-running", requestId: "fixture-running", sessionId: sessions[0]!.id, createdAt: now - 8000, status: "generating", prompt: "保持陶器的造型，试试更冷静的雾蓝色和柔和的晨光，画面再轻盈一点。", model: config.models[0]!, options: { count: 2, aspectRatio: "1:1" }, references: [], images: [] },
  ] : [];
  const listeners = new Set<(event: ImagesChanged) => void>();
  const changed = (sessionId?: string): void => { revision++; for (const listener of listeners) listener({ revision, sessionId }); };
  const clone = <T,>(value: T): T => structuredClone(value);
  const create = (title?: string): ImageSession => {
    const session: ImageSession = { id: crypto.randomUUID(), title: title || "新图片会话", createdAt: Date.now(), updatedAt: Date.now(), modelId: config.defaultModelId };
    sessions.unshift(session); changed(session.id); return clone(session);
  };
  return {
    getConfig: async () => clone(readConfig?.() ?? config),
    snapshot: async (sessionId) => clone({ revision, sessions: [...sessions].sort((a, b) => b.updatedAt - a.updatedAt), tasks: tasks.filter((task) => task.sessionId === sessionId).sort((a, b) => a.createdAt - b.createdAt) }),
    createSession: async (title) => create(title),
    renameSession: async (id, title) => { sessions = sessions.map((session) => session.id === id ? { ...session, title } : session); changed(id); },
    deleteSession: async (id) => { sessions = sessions.filter((session) => session.id !== id); tasks = tasks.filter((task) => task.sessionId !== id); changed(id); },
    deleteTask: async (id) => { const task = tasks.find((item) => item.id === id); tasks = tasks.filter((item) => item.id !== id); changed(task?.sessionId); },
    generate: async (request) => {
      const existing = tasks.find((task) => task.requestId === request.requestId);
      if (existing) return clone(existing);
      const sessionId = request.sessionId || create(request.prompt.slice(0, 25)).id;
      const liveConfig = readConfig?.() ?? config;
      const model = liveConfig.models.find((item) => item.id === (request.modelId || liveConfig.defaultModelId))!;
      const task: ImageTask = { id: crypto.randomUUID(), requestId: request.requestId, sessionId, createdAt: Date.now(), prompt: request.prompt, model, options: request.options || {}, status: "generating", references: request.references?.flatMap((ref) => "path" in ref ? [ref] : []) || [], images: [] };
      tasks.push(task);
      sessions = sessions.map((session) => session.id === sessionId ? { ...session, updatedAt: Date.now(), modelId: model.id, options: task.options } : session);
      changed(sessionId);
      for (let index = 0; index < (task.options.count ?? 1); index++) {
        window.setTimeout(() => {
          const live = tasks.find((item) => item.id === task.id);
          if (!live || live.status !== "generating") return;
          live.images.push({ id: crypto.randomUUID(), path: artwork(index + 2), mimeType: "image/svg+xml", width: 1024, height: 1024 });
          if (live.images.length === (live.options.count ?? 1)) { live.status = "succeeded"; live.completedAt = Date.now(); }
          changed(sessionId);
        }, 4000 + index * 1600);
      }
      return clone(task);
    },
    cancel: async (id) => { const task = tasks.find((item) => item.id === id); if (task) { task.status = "cancelled"; task.completedAt = Date.now(); changed(task.sessionId); } },
    onChanged: (listener) => { listeners.add(listener); return () => { listeners.delete(listener); }; },
  };
}

/** A transcript using the same task payload delivered by the real image tool. */
export function imageToolFixture(mode: string): ChatMessage[] {
  const now = Date.now();
  const running = mode !== "done" && mode !== "partial";
  const task: ImageTask = {
    id: "image-tool-task", requestId: "image-tool-request", sessionId: "image-tool-session", createdAt: now - 9000,
    prompt: "生成四张陶器静物海报，分别尝试鼠尾草绿、暖陶色、雾蓝和奶油黄。",
    model: imageModelsFromProviders(IMAGE_FIXTURE_PROVIDERS)[0]!, options: { count: 4, aspectRatio: "1:1" },
    status: running ? "generating" : mode === "partial" ? "partial" : "succeeded", references: [],
    images: (mode === "running" ? [] : mode === "done" ? [0, 1, 2, 3] : [1]).map((index) => ({ id: `tool-image-${index}`, index, path: artwork(index), mimeType: "image/svg+xml", width: 1024, height: 1024 })),
  };
  const tool: ToolCallBlock = { id: "image-tool-call", name: "generate_image", args: { prompt: task.prompt, count: 4, aspect_ratio: "1:1" }, status: running ? "running" : "done", details: { taskId: task.id, sessionId: task.sessionId, task, items: task.images.map((image) => ({ ref: image.path, ok: true })) } };
  return [
    { id: "image-tool-prompt", role: "user", text: task.prompt, tools: [], createdAt: now - 10000 },
    { id: "image-tool-reply", role: "assistant", text: "", tools: [tool], parts: [{ kind: "tool", toolId: tool.id }], createdAt: now - 9000, ...(running ? {} : { completedAt: now }) },
  ];
}
