import { Type } from "typebox";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

/**
 * FastVibe's built-in web search — a client `web_search` tool that, on execute,
 * opens a *side* Responses request with the provider's hosted `{ type: "web_search" }`
 * tool. The main conversation never receives that hosted tool (pi-ai cannot parse
 * `web_search_call`), so the transcript shows a normal tool card instead.
 *
 * Only models whose api is `openai-responses` get the tool. Completions / Messages
 * sessions drop it from the active set rather than failing at call time.
 */
const TOOL = "web_search";
const TIMEOUT_MS = 60_000;

type Source = { title: string; url: string };

function isResponsesApi(api: string | undefined): boolean {
  return api === "openai-responses";
}

function asText(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function responsesUrl(baseUrl: string): string {
  const base = baseUrl.replace(/\/+$/, "");
  return base.endsWith("/responses") ? base : `${base}/responses`;
}

function hasAuthHeader(headers: Record<string, string>): boolean {
  return Object.keys(headers).some((name) => {
    const key = name.toLowerCase();
    return key === "authorization" || key === "x-api-key" || key === "api-key";
  });
}

function errorResult(message: string) {
  return {
    content: [{ type: "text" as const, text: message }],
    details: { error: true as const },
  };
}

function addSource(list: Source[], seen: Set<string>, title: unknown, url: unknown): void {
  const href = asText(url);
  if (!href || seen.has(href)) return;
  seen.add(href);
  list.push({ title: asText(title) || href, url: href });
}

function collectSources(data: unknown): Source[] {
  const list: Source[] = [];
  const seen = new Set<string>();
  if (!data || typeof data !== "object") return list;
  const output = (data as { output?: unknown }).output;
  if (!Array.isArray(output)) return list;

  for (const item of output) {
    if (!item || typeof item !== "object") continue;
    const row = item as Record<string, unknown>;
    if (row.type === "web_search_call") {
      const action = row.action && typeof row.action === "object" ? (row.action as Record<string, unknown>) : {};
      const sources = Array.isArray(action.sources) ? action.sources : [];
      for (const source of sources) {
        if (!source || typeof source !== "object") continue;
        const entry = source as Record<string, unknown>;
        addSource(list, seen, entry.title ?? entry.display_name ?? entry.name, entry.url);
      }
    }
    if (row.type === "message" && Array.isArray(row.content)) {
      for (const block of row.content) {
        if (!block || typeof block !== "object") continue;
        const content = block as Record<string, unknown>;
        const annotations = Array.isArray(content.annotations) ? content.annotations : [];
        for (const annotation of annotations) {
          if (!annotation || typeof annotation !== "object") continue;
          const mark = annotation as Record<string, unknown>;
          const nested =
            mark.url_citation && typeof mark.url_citation === "object"
              ? (mark.url_citation as Record<string, unknown>)
              : mark;
          if (mark.type === "url_citation" || nested.url) {
            addSource(list, seen, nested.title ?? mark.title, nested.url ?? mark.url);
          }
        }
      }
    }
  }
  return list;
}

function collectText(data: unknown): string {
  if (!data || typeof data !== "object") return "";
  const output = (data as { output?: unknown }).output;
  if (!Array.isArray(output)) return "";
  const parts: string[] = [];
  for (const item of output) {
    if (!item || typeof item !== "object") continue;
    const row = item as Record<string, unknown>;
    if (row.type !== "message" || !Array.isArray(row.content)) continue;
    for (const block of row.content) {
      if (!block || typeof block !== "object") continue;
      const text = asText((block as Record<string, unknown>).text);
      if (text) parts.push(text);
    }
  }
  return parts.join("\n").trim();
}

function formatResult(text: string, sources: Source[]): string {
  const body = text || (sources.length > 0 ? "未返回摘要，仅有来源。" : "未找到结果。");
  if (sources.length === 0) return body;
  const lines = sources.map((source) => `- [${source.title}](${source.url})`);
  return `${body}\n\n## 来源\n${lines.join("\n")}`;
}

function syncActive(pi: ExtensionAPI, model: { api?: string } | undefined): void {
  const active = pi.getActiveTools();
  const on = active.includes(TOOL);
  const want = isResponsesApi(model?.api);
  if (want === on) return;
  pi.setActiveTools(want ? [...active, TOOL] : active.filter((name) => name !== TOOL));
}

async function search(query: string, signal: AbortSignal | undefined, ctx: ExtensionContext) {
  const model = ctx.model;
  if (!model || !isResponsesApi(model.api)) {
    return errorResult("当前模型不是 OpenAI Responses 协议，无法使用 web_search。请在设置 → 供应商中把该模型的协议改为 Responses。");
  }
  if (!ctx.modelRegistry.hasConfiguredAuth(model)) {
    return errorResult("当前模型没有可用的 API 密钥。");
  }

  const auth = await ctx.modelRegistry.getApiKeyAndHeaders(model);
  if (!auth.ok) return errorResult(auth.error || "无法读取当前模型的鉴权信息。");

  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    ...(model.headers ?? {}),
    ...(auth.headers ?? {}),
  };
  if (auth.apiKey && !hasAuthHeader(headers)) {
    headers.Authorization = `Bearer ${auth.apiKey}`;
  }

  const url = responsesUrl(auth.baseUrl?.trim() || model.baseUrl);
  const controller = new AbortController();
  const onAbort = () => controller.abort();
  signal?.addEventListener("abort", onAbort, { once: true });
  const timeout = setTimeout(() => controller.abort(), TIMEOUT_MS);

  let response: Response;
  try {
    response = await fetch(url, {
      method: "POST",
      headers,
      signal: controller.signal,
      body: JSON.stringify({
        model: model.id,
        input: query,
        tools: [{ type: "web_search" }],
        stream: false,
        store: false,
      }),
    });
  } catch (error) {
    if (controller.signal.aborted) return errorResult("搜索已取消。");
    const message = error instanceof Error ? error.message : String(error);
    return errorResult(`搜索请求失败：${message}`);
  } finally {
    clearTimeout(timeout);
    signal?.removeEventListener("abort", onAbort);
  }

  const raw = await response.text();
  let data: unknown = null;
  try {
    data = raw ? JSON.parse(raw) : null;
  } catch {
    data = null;
  }

  if (!response.ok) {
    const fromJson =
      data && typeof data === "object"
        ? asText((data as { error?: { message?: unknown } }).error?.message) ||
          asText((data as { message?: unknown }).message)
        : "";
    const detail = fromJson || raw.slice(0, 400) || response.statusText;
    return errorResult(`搜索失败（${response.status}）：${detail}`);
  }

  const text = collectText(data);
  const sources = collectSources(data);
  return {
    content: [{ type: "text" as const, text: formatResult(text, sources) }],
    details: { query, sources, model: `${model.provider}/${model.id}` },
  };
}

export default function webSearch(pi: ExtensionAPI): void {
  pi.registerTool({
    name: TOOL,
    label: "网络搜索",
    description:
      "通过当前模型供应商的 OpenAI Responses hosted web_search 搜索公开网页，返回摘要和来源链接。仅在当前模型使用 Responses 协议时可用；不要用它打开或操作本地浏览器。",
    promptSnippet: "用 web_search 检索公开网页上的最新信息",
    promptGuidelines: [
      "需要当前事实、文档、新闻或出处时使用 web_search，而不是猜测。",
      "web_search 只在 Responses 协议的模型上可用；它不会打开内置浏览器。",
    ],
    parameters: Type.Object({
      query: Type.String({ description: "搜索查询或要回答的问题" }),
    }),
    async execute(_id, params, signal, onUpdate, ctx) {
      const query = asText(params.query);
      if (!query) return errorResult("请提供搜索查询。");
      onUpdate?.({
        content: [{ type: "text", text: `正在搜索「${query}」…` }],
        details: { query, streaming: true },
      });
      return search(query, signal, ctx);
    },
  });

  pi.on("session_start", (_event, ctx) => syncActive(pi, ctx.model));
  pi.on("session_tree", (_event, ctx) => syncActive(pi, ctx.model));
  pi.on("model_select", (event) => syncActive(pi, event.model));
}
