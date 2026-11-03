import type { BotApi, BotChanged, BotConversationMeta, BotAttention, BotChatMessage, BotProgress, BotResult, WorkSnapshot } from "@shared/bot";
import type { ChatMessage } from "@shared/types";

export function createBotFixture(cwd: string, english = false, empty = false, scenario = "sample"): BotApi {
  const word = (zh: string, en: string) => english ? en : zh;
  const now = Date.now();
  const listeners = new Set<(event: BotChanged) => void>();
  const routerId = "vivi-router";
  const workerId = "vivi-worker-guide";
  const conversations: BotConversationMeta[] = empty ? [{ conversationId: routerId, role: "router", owner: "vivi", creationKey: "router", epoch: 0, paused: false, createdAt: now, updatedAt: now, title: "Vivi" }] : [
    { conversationId: routerId, role: "router", owner: "vivi", creationKey: "router", epoch: 0, paused: false, createdAt: now - 100000, updatedAt: now - 10000, title: word("Vivi 工作台", "Vivi workspace") },
    { conversationId: "vivi-worker-release", role: "worker", owner: "vivi", creationKey: "release", epoch: 0, paused: false, createdAt: now - 90000, updatedAt: now - 20000, title: word("整理本周发布记录", "Prepare this week's release notes"), project: cwd },
    { conversationId: workerId, role: "worker", owner: "vivi", creationKey: "guide", epoch: 1, paused: true, createdAt: now - 60000, updatedAt: now - 5000, title: word("编写新用户入门说明", "Write a getting-started guide"), project: cwd },
  ];
  const attention: BotAttention[] = empty ? [] : [{ id: "vivi-attention-guide", conversationId: workerId, epoch: 1, question: word("这份说明主要面向开发者，还是第一次接触 AI 助手的普通用户？", "Is the guide for developers or for people trying an AI assistant for the first time?"), status: "pending", createdAt: now - 5000 }];
  const messages = new Map<string, ChatMessage[]>([[routerId, empty ? [] : [
    { id: "u1", role: "user", text: word("整理一下这个项目本周的发布记录，再帮我写一份新用户说明。", "Prepare this week's release notes and a getting-started guide for this project."), tools: [], parts: [], createdAt: now - 100000 },
    { id: "a1", role: "assistant", text: word("我会分别处理这两件事，完成后把文档交给你。", "I'll work on both tasks and bring you the finished documents."), tools: [], parts: [], createdAt: now - 90000 },
  ]], [workerId, [{ id: "wu1", role: "user", text: word("编写新用户入门说明", "Write a getting-started guide"), tools: [], parts: [], createdAt: now - 60000 }]]]);
  let revision = 1;
  const chatMessages: BotChatMessage[] = empty ? [] : [
    { id: "u1", conversationId: routerId, role: "user", text: word("整理一下这个项目本周的发布记录，再帮我写一份新用户说明。", "Prepare this week's release notes and a getting-started guide for this project."), createdAt: now - 100000, inputId: "u1" },
    { id: "a1", conversationId: routerId, role: "assistant", text: word("我会分别处理这两件事，完成后把文档交给你。", "I'll work on both tasks and bring you the finished documents."), createdAt: now - 90000, inputId: "u1" },
  ];
  const results: BotResult[] = [];
  const progress: BotProgress[] = empty ? [] : conversations.filter((item) => item.role === "worker").map((item) => ({ conversationId: item.conversationId, inputId: `input:${item.conversationId}`, role: item.role, title: item.title, phase: item.paused ? "waiting" : "working", detail: word("正在核对已有材料", "Checking the available material"), startedAt: now - 18000, updatedAt: now, queuedCount: 0 }));
  const conversationPreviews: Record<string, { text: string; updatedAt: number }> = empty ? {} : {
    "vivi-worker-release": { text: word("已核对本周的提交和发布记录，正在补充安装说明与兼容性注意事项。", "Checked this week's commits and releases. I'm filling in the installation notes and compatibility details."), updatedAt: now - 90_000 },
    [workerId]: { text: word("入门说明的结构已经整理好。这份说明主要面向开发者，还是第一次接触 AI 助手的普通用户？", "The guide outline is ready. Is it for developers or for people trying an AI assistant for the first time?"), updatedAt: now - 5000 },
  };
  if (scenario === "cards") {
    const completedId = "vivi-worker-docs";
    conversations.push({ conversationId: completedId, role: "worker", owner: "vivi", creationKey: "docs", epoch: 0, paused: false, createdAt: now - 3_600_000, updatedAt: now - 720_000, title: word("检查项目文档中的链接", "Check links in the project documentation"), project: cwd });
    const result: BotResult = { id: "cards-ready", conversationId: completedId, inputId: "docs-input", epoch: 0, status: "ready", summary: word("已修复 3 处失效链接，检查通过。", "Fixed three broken links. All checks passed."), createdAt: now - 720_000 };
    results.push(result);
    progress.push({ conversationId: completedId, inputId: "docs-input", role: "worker", phase: "completed", startedAt: now - 900_000, updatedAt: now - 720_000, queuedCount: 0, result });
    conversationPreviews[completedId] = { text: result.summary!, updatedAt: result.createdAt };
    conversations.push({ conversationId: "vivi-worker-pending", role: "worker", owner: "vivi", creationKey: "pending", epoch: 0, paused: false, createdAt: now - 1_800_000, updatedAt: now - 1_800_000, title: word("整理下次发布的检查清单", "Prepare the checklist for the next release"), project: cwd });
  }
  if (scenario === "progress") {
    attention.length = 0;
    progress.forEach((item) => { item.phase = "working"; });
    chatMessages.push({ id: "milestone:1", conversationId: routerId, role: "assistant", kind: "progress", text: word("发布记录已整理好，正在核对安装说明。", "Release notes are ready; checking installation instructions."), createdAt: now - 1000 });
  }
  if (scenario === "result" || scenario === "recovery") {
    attention.length = 0;
    for (const item of progress) item.phase = "completed";
    const item = progress[0];
    if (item) {
      const result: BotResult = { id: "fixture-result", conversationId: item.conversationId, inputId: item.inputId, epoch: 0, status: scenario === "recovery" ? "failed" : "ready", summary: word(scenario === "recovery" ? "发布记录已保存，验证安装流程时连接中断。" : "发布记录已整理并检查。", scenario === "recovery" ? "Release notes were saved; the connection failed during installation verification." : "Release notes are ready and checked."), evidence: [word("已核对最近的提交", "Checked recent commits")], artifacts: [`${cwd}/README.md`], createdAt: now };
      conversationPreviews[item.conversationId] = { text: result.summary!, updatedAt: result.createdAt };
      results.push(result); item.result = result; item.phase = scenario === "recovery" ? "failed" : "completed";
      chatMessages.push({ id: "result-message", conversationId: item.conversationId, role: "assistant", kind: "result", title: item.title, result, text: result.summary!, createdAt: now });
    }
  }
  const running = () => progress.some((item) => ["accepted", "understanding", "planning", "delegating", "working", "summarizing"].includes(item.phase));
  const snapshot = (): WorkSnapshot => ({ revision, routerConversationId: routerId, conversations: structuredClone(conversations), attention: structuredClone(attention), results: structuredClone(results), progress: structuredClone(progress), conversationPreviews: structuredClone(conversationPreviews), deliveries: [], messages: structuredClone(chatMessages) });
  const emit = (conversationId?: string) => { revision++; listeners.forEach((listener) => listener({ revision, conversationId, activity: { running: running(), waiting: attention.some((item) => item.status === "pending"), conversationId } })); };
  const api: BotApi = {
    getWorkSnapshot: async () => snapshot(),
    getActivity: async () => ({ running: running(), waiting: attention.some((item) => item.status === "pending"), conversationId: routerId }),
    onChanged: (listener) => { listeners.add(listener); return () => listeners.delete(listener); },
    onNavigate: () => () => {},
    submit: async (input) => {
      const id = input.conversationId ?? routerId;
      if (chatMessages.some((item) => item.inputId === input.requestId && item.role === "user")) return snapshot();
      chatMessages.push({ id: `chat:user:${input.requestId}`, conversationId: id, role: "user", text: input.text, createdAt: Date.now(), inputId: input.requestId });
      if (input.intent === "status") chatMessages.push({ id: `chat:status:${input.requestId}`, conversationId: id, role: "assistant", kind: "status", text: progress.map((item) => `${item.title ?? "Vivi"}: ${item.detail ?? item.phase}`).join("\n") || word("当前没有正在处理的事。", "Nothing is running."), createdAt: Date.now(), inputId: input.requestId });
      else {
        const current = progress.find((item) => item.conversationId === id);
        const next: BotProgress = { conversationId: id, inputId: input.requestId, role: id === routerId ? "router" : "worker", phase: "understanding", detail: word("我先确认你的要求。", "Reviewing your request."), startedAt: Date.now(), updatedAt: Date.now(), queuedCount: 0 };
        if (current) Object.assign(current, next); else progress.unshift(next);
      }
      emit(id); return snapshot();
    },
    createWork: async (input) => { const conversationId = `vivi-worker-${input.requestId}`; const conversation: BotConversationMeta = { conversationId, role: "worker", owner: "vivi", creationKey: `work:${input.requestId}`, epoch: 0, paused: false, createdAt: Date.now(), updatedAt: Date.now(), title: input.title, project: cwd }; conversations.push(conversation); messages.set(conversationId, [{ id: input.requestId, role: "user", text: input.text, tools: [], parts: [], createdAt: Date.now() }]); emit(conversationId); return conversation; },
    report: async (input) => { const result = { id: `result:${input.requestId ?? Date.now()}`, conversationId: input.conversationId, inputId: input.requestId, epoch: 0, status: input.outcome ?? "idle", summary: input.summary, evidence: input.evidence, artifacts: input.artifacts, createdAt: Date.now() } as const; emit(input.conversationId); return result; },
    ask: async (input) => { const item: BotAttention = { id: `attention:${input.requestId ?? Date.now()}`, conversationId: input.conversationId, inputId: input.requestId, epoch: 0, question: input.question, status: "pending", createdAt: Date.now() }; attention.push(item); emit(input.conversationId); return item; },
    answer: async ({ attentionId, answer }) => { const item = attention.find((entry) => entry.id === attentionId); if (!item) throw new Error("Question is no longer pending"); item.answer = answer; item.status = "resolved"; const conversation = conversations.find((entry) => entry.conversationId === item.conversationId); if (conversation) conversation.paused = false; emit(item.conversationId); return snapshot(); },
    stopConversation: async ({ conversationId }) => { const conversation = conversations.find((entry) => entry.conversationId === conversationId); if (conversation) conversation.paused = true; emit(conversationId); return snapshot(); },
    continueConversation: async ({ conversationId }) => { const conversation = conversations.find((entry) => entry.conversationId === conversationId); if (conversation) conversation.paused = false; const state = progress.find((item) => item.conversationId === conversationId); if (state) { state.phase = "working"; state.startedAt = Date.now(); state.inputId = `resume:${Date.now()}`; } emit(conversationId); return snapshot(); },
    stopAll: async () => { progress.forEach((item) => { if (["accepted", "understanding", "planning", "delegating", "working", "summarizing"].includes(item.phase)) item.phase = "paused"; }); conversations.forEach((conversation) => { if (conversation.role === "worker") conversation.paused = true; }); emit(); return snapshot(); },
  };
  return api;
}
