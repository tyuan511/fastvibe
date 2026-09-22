import { useSessionStore } from "@/stores/session";
import { useSidePaneStore } from "@/stores/side-pane";
import type { ChatMessage, SubagentInfo, ToolCallBlock } from "@shared/types";

/** No SDK/provider calls: reproduces a stale tab + scoped snapshot while the pane
 * and parent tool card must keep the live run's state and composer metadata. */
export function previewSubagent(mode: string): void {
  const conversationId = useSessionStore.getState().activeId;
  if (!conversationId) return;
  const id = "preview-subagent:0";
  const startedAt = Date.now() - 10000;
  const info: SubagentInfo = {
    id, conversationId, name: "explorer", agent: "explorer", detail: "检查子 Agent 状态同步",
    status: mode === "aborted" ? "aborted" : mode === "error" ? "error" : "running",
    phase: mode === "retrying" ? "retrying" : mode === "waiting" ? "waiting" : "working",
    model: { provider: "preview", id: "preview-model" },
    thinkingLevel: "high", contextUsage: { contextWindow: 128000, tokens: 24000, percent: 18.75 },
    revision: 20, startedAt,
    error: mode === "error" ? "Preview: stream ended before a terminal response event" : undefined,
  };
  const tool: ToolCallBlock = { id: "preview-subagent", name: "subagent", status: info.status === "running" ? "running" : "error", args: { agent: "explorer", task: info.detail } };
  const messages: ChatMessage[] = [{ id: "preview-parent", role: "assistant", text: "", tools: [tool], parts: [{ kind: "tool", toolId: tool.id }], createdAt: startedAt }];
  useSessionStore.setState({
    subagents: [info], messages,
    subagentStreams: { [id]: [{ id: "preview-child", role: "assistant", text: "已检查状态链路。", tools: [], parts: [{ kind: "text", text: "已检查状态链路。" }], createdAt: startedAt }] },
  });
  useSidePaneStore.getState().openSubagent(id, { conversationId, title: "explorer", status: "running", brief: info.detail });
  // Neither a different conversation's list nor a stale in-flight read may erase
  // the live row or turn a stopped run back into a running one.
  useSessionStore.getState().setSubagents([]);
  useSessionStore.getState().setSubagents([{ ...info, revision: 10, status: "running", model: undefined, thinkingLevel: undefined }]);
}
