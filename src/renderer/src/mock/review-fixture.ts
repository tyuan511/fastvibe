import type { AgentThread, AgentThreadMessage } from "@shared/agent-thread";
import type { ChatMessage, SubagentConfig, SubagentDraft } from "@shared/types";
import type { ReviewContext, ReviewFinding, ReviewReport, ReviewStartRequest } from "@shared/review";

/** Real Review UI with deterministic host data; no provider requests or disk writes. */
export function createReviewFixture({ cwd, conversationId, mode, english, emit }: {
  cwd: string; conversationId: string; mode: string | null; english: boolean; emit: (event: unknown) => void;
}) {
  const text = (zh: string, en: string) => english ? en : zh;
  const now = Date.now();
  const threads = new Map<string, AgentThread>();
  const mail = new Map<string, AgentThreadMessage[]>();
  const configs: SubagentConfig[] = [
    { id: "explorer", name: "explorer", description: "Focused codebase investigation", source: "builtin", tools: ["read", "grep", "find", "ls"], systemPrompt: "Inspect and return code evidence.", thinkingLevel: "medium" },
    { id: "worker", name: "worker", description: "Implementation in owned files", source: "builtin", tools: ["read", "grep", "find", "ls", "edit", "write", "bash"], systemPrompt: "Implement assigned work.", thinkingLevel: "medium" },
    { id: "review", name: "review", description: "Review code changes", source: "builtin", tools: ["review_read_file", "review_search", "submit_review_result"], systemPrompt: "Inspect the frozen review snapshot and submit a verified report.", thinkingLevel: "high", ...(mode === "unconfigured" ? {} : { model: "fastvibe/gpt-6.1-sol" }) },
  ];
  const findings: ReviewFinding[] = [
    {
      id: "preview-review-finding-1", severity: "P1", confidence: "high", category: "correctness",
      title: text("迟到的请求可能覆盖新会话状态", "A late response can overwrite the new conversation state"),
      location: { path: "src/main/pi/process-manager.ts", startLine: 420, endLine: 423, side: "new", snippet: "420: const result = await loadSnapshot(id);\n421: state.set({ messages: result.messages });\n422: broadcast({ type: 'snapshot', ...result });\n423: return result;" },
      trigger: text("在旧请求返回之前，用户切换到了另一个会话。", "The user switches conversations before the earlier request returns."),
      impact: text("旧会话的消息会覆盖当前正在查看的会话。", "Messages from the previous conversation replace the conversation currently on screen."),
      evidence: [text("异步结果发布前没有核对请求所属的 conversationId。", "The async result is published without checking its conversationId."), text("此处写入的状态会被当前窗口直接读取。", "The current window consumes the state written here.")],
      recommendation: text("保存请求归属，并在更新和广播前确认仍属于目标会话。", "Keep the request owner and verify it before updating and broadcasting state."),
    },
    {
      id: "preview-review-finding-2", severity: "P2", confidence: "medium", category: "tests",
      title: text("停止后的恢复路径缺少回归覆盖", "The recovery path after Stop lacks regression coverage"),
      location: { path: "src/renderer/src/stores/session.ts", startLine: 118, endLine: 120, side: "new", snippet: "118: const restored = await engine.getSnapshot(id);\n119: applySnapshot(restored);\n120: resumeQueue();" },
      trigger: text("用户停止任务后重开会话，恢复逻辑自动重启了队列。", "A conversation is reopened after Stop and recovery starts the queue automatically."),
      impact: text("用户停止的工作可能在恢复会话时再次运行。", "Work stopped by the user may run again when the conversation is restored."),
      evidence: [text("恢复调用无条件执行 resumeQueue，未检查队列暂停状态。", "Recovery calls resumeQueue without checking the queue pause state.")],
      recommendation: text("保留暂停状态，并覆盖停止、重载与恢复的行为测试。", "Preserve the pause state and cover Stop, reload and recovery in a behavior test."),
    },
  ];
  const makeContext = (id: string, request?: ReviewStartRequest): ReviewContext => ({
    id, scope: request?.scope ?? "worktree", base: "8c32a9dc5d72c033816c6a8110b37f40cf94fba4", target: request?.revision ?? "841bddb0e7a4ac68778d2b3852772bf6c8bfe910", capturedAt: now - 40_000,
    promptVersion: 1, model: configs[2].model!, thinkingLevel: configs[2].thinkingLevel,
    root: request?.cwd ?? cwd, digest: "e8492da62bd4bbd92624e49fa86e2b411c7139096c97856b4e468782fda126542",
    ...(request?.command ? { command: request.command } : {}),
    files: [
      { path: "src/main/pi/process-manager.ts", status: "M", oldLines: 6250, newLines: 6284 },
      { path: "src/renderer/src/stores/session.ts", status: "M", oldLines: 1400, newLines: 1418 },
      ...(mode === "partial" ? [{ path: "resources/model.bin", status: "A", oldLines: 0, newLines: 0, skipped: text("二进制文件，未进行内容审查。", "Binary file; its contents were not reviewed.") }] : []),
    ],
  });
  function makeReport(): ReviewReport {
    return {
      version: 1,
      summary: mode === "empty" || mode === "partial" ? text("已检查本次可读取的代码变更，未发现可确认的问题。", "Reviewed the readable changes and found no confirmed issues.") : text("已检查会话切换、取消和恢复路径，发现一处状态归属问题和一处恢复风险。", "Reviewed conversation switching, cancellation and recovery; found one state ownership issue and one recovery risk."),
      findings: mode === "empty" || mode === "partial" ? [] : structuredClone(findings),
      coverage: { reviewedPaths: findings.map((item) => item.location.path), unreviewedPaths: mode === "partial" ? [{ path: "resources/model.bin", reason: text("二进制文件，未进行内容审查。", "Binary file; its contents were not reviewed.") }] : [] },
    };
  }
  function publish(thread: AgentThread): AgentThread {
    threads.set(thread.id, thread);
    emit({ type: "agent_thread_changed", conversationId: thread.conversationId, thread });
    return thread;
  }
  function finish(thread: AgentThread): AgentThread {
    const report = makeReport();
    const next = { ...thread, status: "completed" as const, reviewReport: report, endedAt: Date.now(), updatedAt: Date.now(), revision: thread.revision + 1 };
    mail.set(thread.id, [{ id: `${thread.id}:result:1`, threadId: thread.id, senderId: thread.id, recipientId: thread.conversationId, kind: "result", turn: 1, status: "completed", text: report.summary, reviewReport: report, createdAt: Date.now() }]);
    return publish(next);
  }
  function makeThread(id: string, request?: ReviewStartRequest): AgentThread {
    const command = request?.command ?? (mode && mode !== "unconfigured" ? "/review 重点看会话切换和停止后的恢复路径" : undefined);
    return { id, rootId: id, conversationId: request?.conversationId ?? conversationId, agent: "review", name: "Swift Owl", avatarSeed: 34759, taskName: "review", task: request?.instructions || text("审查当前代码变更，检查正确性、契约和回归风险。", "Review current code changes for correctness, contracts and regressions."), cwd: request?.cwd ?? cwd, tools: configs[2].tools, review: makeContext(id, request?.command ? request : command ? { ...request, conversationId: request?.conversationId ?? conversationId, cwd: request?.cwd ?? cwd, scope: request?.scope ?? "worktree", command } : request), model: { provider: "fastvibe", id: "gpt-6.1-sol" }, thinkingLevel: "high", status: "working", revision: 1, currentTurn: 1, createdAt: now - 40_000, startedAt: now - 40_000, updatedAt: now };
  }
  if (mode && mode !== "unconfigured") {
    const initial = makeThread("agent-preview-review");
    if (mode === "running") threads.set(initial.id, initial);
    else if (mode === "failed" || mode === "interrupted") {
      threads.set(initial.id, { ...initial, status: mode === "failed" ? "failed" : "interrupted", endedAt: now, lastMessage: text("未提交有效报告。", "No valid report was submitted.") });
    } else finish(initial);
  }
  return {
    get threads() { return [...threads.values()]; },
    configs: () => structuredClone(configs),
    messages: (threadId: string) => structuredClone(mail.get(threadId) ?? []),
    process: (runId: string): ChatMessage[] => threads.has(runId.replace(/:turn:\d+$/, "")) ? [{ id: `${runId}:process`, role: "assistant", text: text("已读取代码快照并检查调用链。", "Read the code snapshot and checked its call chains."), tools: [], parts: [{ kind: "text", text: text("已读取代码快照并检查调用链。", "Read the code snapshot and checked its call chains.") }], createdAt: now - 15_000 }] : [],
    save: (draft: SubagentDraft) => {
      const config = configs.find((item) => item.id === draft.id);
      if (config) { config.model = draft.model; config.thinkingLevel = draft.thinkingLevel ?? "medium"; }
      return structuredClone(configs);
    },
    start: async (request: ReviewStartRequest) => {
      if (!configs[2].model) throw new Error(text("请先在设置 → 智能体中为 Review 选择审查模型。", "Choose a review model for Review in Settings → Agents first."));
      const thread = publish(makeThread(`agent-preview-review-${Date.now()}`, request));
      setTimeout(() => { if (threads.get(thread.id)?.status === "working") finish(thread); }, 900);
      return thread;
    },
    interrupt: async (threadId: string) => {
      const thread = threads.get(threadId);
      if (thread) publish({ ...thread, status: "interrupted", endedAt: Date.now(), revision: thread.revision + 1 });
    },
  };
}
