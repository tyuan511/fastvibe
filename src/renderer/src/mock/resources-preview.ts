import type { AgentThread } from "@shared/agent-thread";
import { subagentKey } from "@shared/subagent-state";
import type { ChatMessage, ToolCallBlock } from "@shared/types";
import { useSessionStore } from "@/stores/session";
import { useSidePaneStore } from "@/stores/side-pane";

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
      { id: "resource-explorer", conversationId: id, name: "explorer", detail: "检查会话切换与状态隔离", status: "running", phase: "working" },
      { id: "resource-waiting", conversationId: id, name: "designer", detail: "确认产出文件的展示顺序", status: "running", phase: "waiting" },
      { id: "T-resource", conversationId: id, name: "tester", detail: "检查多仓库审查跳转", status: "running" },
      { id: "other-conversation", conversationId: "other", name: "must-not-appear", status: "running" },
    ],
  });
  if (mode === "agents" || mode === "agent-actions") {
    const createdAt = Date.now() - 50000;
    const threads: AgentThread[] = [
      { id: "agent-preview-one", name: "Warm Seal", avatarSeed: 42, task: "为当前改动添加真实 SDK 集成测试", status: "working" },
      { id: "agent-preview-two", name: "Bright Fox", avatarSeed: 91, task: "检查消息历史和线程身份恢复", status: "completed" },
    ].map((thread) => ({ ...thread, status: thread.status as AgentThread["status"], conversationId: id, rootId: thread.id, agent: "worker", taskName: "sdk-tests", cwd: "/preview", createdAt, updatedAt: createdAt, currentTurn: 1, revision: 1 }));
    window.fastvibe.engine.getAgentThreads = async () => threads;
    window.fastvibe.engine.getAgentThreadMessages = async () => [];
    const currentRun: ChatMessage[] = [{ id: "agent-current", role: "assistant", text: "正在检查 SDK 集成测试的上下文。", tools: [{ id: "agent-read", name: "read", status: "done", args: { path: "test/agent-thread-store.test.ts" }, result: "Test setup" }], parts: [{ kind: "tool", toolId: "agent-read" }, { kind: "text", text: "正在检查 SDK 集成测试的上下文。" }], createdAt }];
    const creations: ToolCallBlock[] = threads.map((thread, index) => ({ id: `spawn-preview-${index}`, name: "spawn_agent", status: "done", args: { task_name: thread.taskName, message: thread.task }, details: { thread } }));
    const actions: ToolCallBlock[] = mode === "agent-actions" ? [
      { id: "action-send", name: "send_message", status: "done", args: { target: threads[0].id, message: "请补充测试证据。" } },
      { id: "action-followup", name: "followup_task", status: "done", args: { target: threads[1].id, message: "继续检查边界情况。" }, details: { result: threads[1] } },
      { id: "action-interrupt", name: "interrupt_agent", status: "done", args: { target: threads[1].id } },
      { id: "action-list", name: "list_agents", status: "done", args: {}, details: { threads } },
      ...Array.from({ length: 8 }, (_, index): ToolCallBlock => ({ id: `action-wait-many-${index}`, name: "wait_agent", status: "done", args: { targets: threads.map((thread) => thread.id) }, details: { threads } })),
      { id: "action-error", name: "send_message", status: "error", args: { target: threads[1].id }, result: "Thread is closed" },
      { id: "action-wait", name: "wait_agent", status: "running", args: { targets: [threads[0].id] } },
    ] : [];
    const displayed = [...creations, ...actions];
    const history: ChatMessage[] = [
      { id: "agents-user", role: "user", text: "安排智能体检查这次改动。", tools: [], createdAt },
      { id: "agents-process", role: "assistant", text: "", tools: displayed, parts: [{ kind: "thinking", text: "把两个检查任务交给不同的智能体。" }, ...displayed.map((tool) => ({ kind: "tool" as const, toolId: tool.id }))], createdAt: createdAt + 1000, completedAt: createdAt + 5000 },
      { id: "agents-answer", role: "assistant", text: "已创建两位智能体，点击名字可以查看对应线程。", tools: [], createdAt: createdAt + 5000, completedAt: createdAt + 6000 },
    ];
    useSessionStore.setState({ messages: history, subagentStreams: { [subagentKey(`${threads[0].id}:turn:1`, id)]: currentRun }, streaming: mode === "agent-actions", running: { ...store.running, [id]: mode === "agent-actions" }, subagents: threads.map((thread) => ({ id: `${thread.id}:turn:1`, conversationId: id, name: thread.name, avatarSeed: thread.avatarSeed, detail: thread.task, status: thread.status === "working" ? "running" : "completed" })) });
  }
  useSidePaneStore.getState().setCollapsed(true);
}
