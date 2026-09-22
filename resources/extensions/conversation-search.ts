import { Type } from "typebox";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

const TOOL = "conversation_search";
const MAX_CONVERSATION_ID_CHARS = 512;
const MAX_QUERY_CHARS = 500;
const MAX_TOOL_TEXT_CHARS = 40_000;

const T = (zh: string, en: string): string =>
  process.env.FASTVIBE_UI_LANGUAGE === "en" ? en : zh;

type SearchLine = {
  entryId: string;
  role: "user" | "assistant" | "tool" | "summary" | "custom";
  timestamp: string;
  source?: string;
  text: string;
};

type SearchMatch = {
  entryId: string;
  role: SearchLine["role"];
  timestamp: string;
  source?: string;
  snippet: string;
  before: SearchLine[];
  after: SearchLine[];
};

type SearchResult = {
  conversationId: string;
  title: string;
  cwd: string;
  query: string;
  totalMatches: number;
  matches: SearchMatch[];
  truncated: boolean;
};

type ConversationSearchHost = {
  searchConversation?(request: {
    conversationId: string;
    query: string;
    maxResults?: number;
    context?: number;
  }): Promise<SearchResult>;
};

function hostOf(ctx: ExtensionContext): ConversationSearchHost {
  return ctx.ui as unknown as ConversationSearchHost;
}

function roleLabel(role: SearchLine["role"]): string {
  if (role === "user") return T("用户", "user");
  if (role === "assistant") return T("助手", "assistant");
  if (role === "tool") return T("工具", "tool");
  if (role === "summary") return T("摘要", "summary");
  return T("扩展", "extension");
}

function describeLine(line: SearchLine): string {
  const source = line.source ? ` · ${line.source}` : "";
  return `[${roleLabel(line.role)}${source} · ${line.entryId}] ${line.text}`;
}

function formatResult(result: SearchResult): string {
  const heading = T(
    `会话：${result.title}（${result.conversationId}）`,
    `Conversation: ${result.title} (${result.conversationId})`,
  );
  if (result.matches.length === 0) {
    return boundedText(`${heading}\n${T(`没有找到“${result.query}”`, `No matches for “${result.query}”`)}`);
  }

  const count = T(
    `找到 ${result.totalMatches} 处，返回 ${result.matches.length} 处${result.truncated ? "（结果已截断，请缩小搜索范围）" : ""}`,
    `Found ${result.totalMatches} matches; returned ${result.matches.length}${result.truncated ? " (truncated; refine the query)" : ""}`,
  );
  const blocks = result.matches.map((match, index) => {
    const source = match.source ? ` · ${match.source}` : "";
    const before = match.before.length > 0
      ? `${T("前文", "Before")}:\n${match.before.map(describeLine).join("\n")}`
      : "";
    const after = match.after.length > 0
      ? `${T("后文", "After")}:\n${match.after.map(describeLine).join("\n")}`
      : "";
    return [
      `#${index + 1} [${roleLabel(match.role)}${source} · ${match.entryId}] ${match.timestamp}`,
      before,
      `${T("命中", "Match")}:\n${match.snippet}`,
      after,
    ].filter(Boolean).join("\n");
  });
  return boundedText(`${heading}\n${count}\n\n${blocks.join("\n\n---\n\n")}`);
}

function boundedText(text: string): string {
  if (text.length <= MAX_TOOL_TEXT_CHARS) return text;
  const notice = T("\n…结果已达到长度上限，请缩小搜索范围。", "\n…Result limit reached; refine the query.");
  return `${text.slice(0, MAX_TOOL_TEXT_CHARS - notice.length)}${notice}`;
}

function errorText(error: unknown): string {
  if (error instanceof Error && error.message.trim()) return error.message;
  return T("搜索会话失败", "Failed to search the conversation");
}

export default function conversationSearchExtension(pi: ExtensionAPI): void {
  pi.registerTool({
    name: TOOL,
    label: "Conversation Search",
    description: "按会话 ID 搜索另一个会话的已完成历史，返回匹配片段及少量前后文，不读取整段会话。",
    promptSnippet: "Search another conversation by its conversation ID and a focused text query",
    promptGuidelines: [
      "Use conversation_search when the user provides a conversation ID and relevant context may exist there.",
      "Search with focused terms and refine the query instead of trying to enumerate the whole conversation.",
      "Results contain completed transcript entries only; a reply still being generated is not included.",
    ],
    parameters: Type.Object({
      conversationId: Type.String({ maxLength: MAX_CONVERSATION_ID_CHARS, description: "Conversation ID, usually copied from the chat's context menu" }),
      query: Type.String({ maxLength: MAX_QUERY_CHARS, description: "Case-insensitive literal text to search for" }),
      maxResults: Type.Optional(Type.Number({ description: "Maximum matches to return (default 10, hard limit 30)" })),
      context: Type.Optional(Type.Number({ description: "Visible transcript items before and after each match (default 1, hard limit 3)" })),
    }),
    async execute(_id, params, _signal, _onUpdate, ctx) {
      const host = hostOf(ctx);
      if (!host.searchConversation) {
        return {
          content: [{ type: "text", text: T("当前宿主不支持会话搜索。", "This host does not support conversation search.") }],
          details: { conversationId: params.conversationId, query: params.query, error: true },
          isError: true,
        };
      }

      const conversationId = typeof params.conversationId === "string" ? params.conversationId.trim() : "";
      const query = typeof params.query === "string" ? params.query.trim() : "";
      if (!conversationId || !query) {
        return {
          content: [{ type: "text", text: T("会话 ID 和搜索词都不能为空。", "Conversation ID and query are required.") }],
          details: { conversationId, query, error: true },
          isError: true,
        };
      }
      if (conversationId.length > MAX_CONVERSATION_ID_CHARS || query.length > MAX_QUERY_CHARS) {
        return {
          content: [{ type: "text", text: T("会话 ID 或搜索词过长。", "The conversation ID or query is too long.") }],
          details: {
            conversationId: conversationId.slice(0, MAX_CONVERSATION_ID_CHARS),
            query: query.slice(0, MAX_QUERY_CHARS),
            error: true,
          },
          isError: true,
        };
      }

      try {
        const result = await host.searchConversation({
          conversationId,
          query,
          maxResults: typeof params.maxResults === "number" ? params.maxResults : undefined,
          context: typeof params.context === "number" ? params.context : undefined,
        });
        return {
          content: [{ type: "text", text: formatResult(result) }],
          details: {
            conversationId: result.conversationId,
            title: result.title.slice(0, 200),
            query: result.query.slice(0, MAX_QUERY_CHARS),
            totalMatches: result.totalMatches,
            returnedMatches: result.matches.length,
            truncated: result.truncated,
          },
        };
      } catch (error) {
        return {
          content: [{ type: "text", text: boundedText(errorText(error)) }],
          details: {
            conversationId: conversationId.slice(0, MAX_CONVERSATION_ID_CHARS),
            query: query.slice(0, MAX_QUERY_CHARS),
            error: true,
          },
          isError: true,
        };
      }
    },
  });
}
