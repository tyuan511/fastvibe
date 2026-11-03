import type { BotApi, BotChanged, BotConversationMeta, BotAttention, BotChatMessage, WorkSnapshot } from "@shared/bot";
import type { ChatMessage } from "@shared/types";

export function createBotFixture(cwd: string, english = false, empty = false): BotApi {
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
  const snapshot = (): WorkSnapshot => ({ revision, routerConversationId: routerId, conversations: structuredClone(conversations), attention: structuredClone(attention), results: [], deliveries: [], messages: structuredClone(chatMessages) });
  const emit = (conversationId?: string) => { revision++; listeners.forEach((listener) => listener({ revision, conversationId, activity: { running: false, waiting: attention.some((item) => item.status === "pending"), conversationId } })); };
  const api: BotApi = {
    getWorkSnapshot: async () => snapshot(),
    getActivity: async () => ({ running: false, waiting: attention.some((item) => item.status === "pending"), conversationId: routerId }),
    onChanged: (listener) => { listeners.add(listener); return () => listeners.delete(listener); },
    onNavigate: () => () => {},
    submit: async (input) => { const id = input.conversationId ?? routerId; messages.set(id, [...(messages.get(id) ?? []), { id: input.requestId, role: "user", text: input.text, tools: [], parts: [], createdAt: Date.now() }]); if (id === routerId) chatMessages.push({ id: input.requestId, conversationId: routerId, role: "user", text: input.text, createdAt: Date.now(), inputId: input.requestId }); emit(id); return snapshot(); },
    createWork: async (input) => { const conversationId = `vivi-worker-${input.requestId}`; const conversation: BotConversationMeta = { conversationId, role: "worker", owner: "vivi", creationKey: `work:${input.requestId}`, epoch: 0, paused: false, createdAt: Date.now(), updatedAt: Date.now(), title: input.title, project: cwd }; conversations.push(conversation); messages.set(conversationId, [{ id: input.requestId, role: "user", text: input.text, tools: [], parts: [], createdAt: Date.now() }]); emit(conversationId); return conversation; },
    report: async (input) => { const result = { id: `result:${input.requestId ?? Date.now()}`, conversationId: input.conversationId, inputId: input.requestId, epoch: 0, status: input.outcome ?? "idle", summary: input.summary, evidence: input.evidence, artifacts: input.artifacts, createdAt: Date.now() } as const; emit(input.conversationId); return result; },
    ask: async (input) => { const item: BotAttention = { id: `attention:${input.requestId ?? Date.now()}`, conversationId: input.conversationId, inputId: input.requestId, epoch: 0, question: input.question, status: "pending", createdAt: Date.now() }; attention.push(item); emit(input.conversationId); return item; },
    answer: async ({ attentionId, answer }) => { const item = attention.find((entry) => entry.id === attentionId); if (!item) throw new Error("Question is no longer pending"); item.answer = answer; item.status = "resolved"; const conversation = conversations.find((entry) => entry.conversationId === item.conversationId); if (conversation) conversation.paused = false; emit(item.conversationId); return snapshot(); },
    stopConversation: async ({ conversationId }) => { const conversation = conversations.find((entry) => entry.conversationId === conversationId); if (conversation) conversation.paused = true; emit(conversationId); return snapshot(); },
    continueConversation: async ({ conversationId }) => { const conversation = conversations.find((entry) => entry.conversationId === conversationId); if (conversation) conversation.paused = false; emit(conversationId); return snapshot(); },
    stopAll: async () => { conversations.forEach((conversation) => { if (conversation.role === "worker") conversation.paused = true; }); emit(); return snapshot(); },
  };
  return api;
}
