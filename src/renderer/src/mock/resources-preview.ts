import type { ChatMessage, ToolCallBlock } from "@shared/types";
import { useSessionStore } from "@/stores/session";
import { useSidePaneStore } from "@/stores/side-pane";
import { useDagStore } from "@/stores/dag";

/** Read-only renderer fixture: no provider or command execution. */
export function previewResources(mode: string, attempt = 0): void {
  const store = useSessionStore.getState();
  const id = store.activeId;
  if (!id || store.session?.conversationId !== id || !store.messages.length) {
    if (attempt < 100) window.setTimeout(() => previewResources(mode, attempt + 1), 100);
    return;
  }
  const tools: ToolCallBlock[] = [
    { id: "resources-todo", name: "todo", status: "done", args: { todos: [
      { content: "梳理会话资源的数据来源", status: "completed" },
      { content: "实现右上角资源面板", status: "completed" },
      { content: "验证多会话与长列表", activeForm: "正在验证多会话与长列表", status: "in_progress" },
      { content: "检查明暗主题", status: "pending" },
    ] } },
    ...["report.md", "architecture.html", "summary.pdf", "design.png", "demo.mp4", "notes.md", "results.json"].map((path, index): ToolCallBlock => ({ id: "output-" + index, name: "write", status: "done", args: { path: "out/" + path } })),
    { id: "command-done", name: "bash", status: "done", args: { command: "pnpm exec tsc --noEmit -p tsconfig.web.json" }, result: "" },
    { id: "command-live", name: "bash", status: "running", args: { command: "pnpm test" }, result: "Running tests…" },
  ];
  const messages: ChatMessage[] = [{ id: "resources-user", role: "user", text: "把会话资源集中放到右上角。", tools: [], createdAt: Date.now() - 50000 }, { id: "resources-reply", role: "assistant", text: "资源面板已接入，正在检查各项状态。", tools, createdAt: Date.now() - 45000 }];
  useSessionStore.setState({
    messages: mode === "empty" ? [] : messages,
    running: { ...store.running, [id]: mode !== "empty" },
    subagents: mode === "empty" ? [] : [
      { id: "resource-worker", conversationId: id, name: "worker", detail: "完成资源面板的数据接入", status: "completed" },
      { id: "resource-reviewer", conversationId: id, name: "reviewer", detail: "检查会话切换与状态隔离", status: "running", phase: "working" },
      { id: "resource-waiting", conversationId: id, name: "designer", detail: "确认产出文件的展示顺序", status: "running", phase: "waiting" },
      { id: "T-resource", conversationId: id, name: "tester", detail: "检查多仓库审查跳转", status: "running" },
      { id: "other-conversation", conversationId: "other", name: "must-not-appear", status: "running" },
    ],
  });
  useDagStore.getState().apply(id, mode === "empty" ? null : { conversationId: id, nodes: [{ id: "T-resource", runId: "T-resource", title: "检查多仓库审查跳转", instruction: "检查多仓库审查跳转", status: "running", createdAt: Date.now(), dependsOn: [], profile: { name: "tester", instructions: "检查跳转" } }], revision: 1, createdAt: Date.now(), updatedAt: Date.now() });
  useSidePaneStore.getState().setCollapsed(true);
}
