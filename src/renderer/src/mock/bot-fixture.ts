import type { BotApi, BotChanged, BotConversationMeta, BotAttention, BotChatMessage, BotExecutionError, BotProgress, BotResult, WorkSnapshot } from "@shared/bot";
import type { ChatMessage, EngineEvent } from "@shared/types";
import { viviPromoScenario, type ViviPromoStage } from "./vivi-promo-fixture";

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
  let chatGeneration = 0;
  const chatMessages: BotChatMessage[] = empty ? [] : [
    { id: "u1", conversationId: routerId, role: "user", text: word("整理一下这个项目本周的发布记录，再帮我写一份新用户说明。", "Prepare this week's release notes and a getting-started guide for this project."), createdAt: now - 100000, inputId: "u1" },
    { id: "a1", conversationId: routerId, role: "assistant", text: word("我会分别处理这两件事，完成后把文档交给你。", "I'll work on both tasks and bring you the finished documents."), createdAt: now - 90000, inputId: "u1" },
  ];
  const results: BotResult[] = [];
  const executionErrors: BotExecutionError[] = [];
  const progress: BotProgress[] = empty ? [] : conversations.filter((item) => item.role === "worker").map((item) => ({ conversationId: item.conversationId, inputId: `input:${item.conversationId}`, role: item.role, title: item.title, phase: item.paused ? "waiting" : "working", detail: word("正在核对已有材料", "Checking the available material"), startedAt: now - 18000, updatedAt: now, queuedCount: 0 }));
  const conversationPreviews: Record<string, { text: string; updatedAt: number }> = empty ? {} : {
    "vivi-worker-release": { text: word("已核对本周的提交和发布记录，正在补充安装说明与兼容性注意事项。", "Checked this week's commits and releases. I'm filling in the installation notes and compatibility details."), updatedAt: now - 90_000 },
    [workerId]: { text: word("入门说明的结构已经整理好。这份说明主要面向开发者，还是第一次接触 AI 助手的普通用户？", "The guide outline is ready. Is it for developers or for people trying an AI assistant for the first time?"), updatedAt: now - 5000 },
  };
  if (scenario === "chat") {
    attention.length = 0;
    progress.length = 0;
    const yesterday = new Date(now);
    yesterday.setDate(yesterday.getDate() - 1);
    yesterday.setHours(18, 40, 0, 0);
    const minute = 60_000;
    chatMessages.splice(0, chatMessages.length,
      { id: "chat:yesterday-user", conversationId: routerId, role: "user", text: word("明天帮我一起整理一下新用户入门文档吧。", "Let's work on the getting-started guide tomorrow."), createdAt: yesterday.getTime() },
      { id: "chat:yesterday-vivi", conversationId: routerId, role: "assistant", text: word("好，明天我们接着聊。", "Sure, we can pick it up tomorrow."), createdAt: yesterday.getTime() + minute },
      { id: "chat:today-user", conversationId: routerId, role: "user", text: word("我们继续昨天的文档。希望写得像朋友在介绍这个软件，让第一次接触 AI 助手的人也能看懂。", "Let's continue yesterday's guide. Make it feel like a friend introducing the app, so someone new to AI assistants can follow along."), createdAt: now - 22 * minute },
      { id: "chat:today-user-extra", conversationId: routerId, role: "user", text: word("先讲怎么开始聊天，再讲文件和项目。", "Start with chatting, then introduce files and projects."), createdAt: now - 21.8 * minute },
      { id: "chat:today-vivi", conversationId: routerId, role: "assistant", text: word("明白。我会从第一次打开软件开始，把术语换成具体的操作。", "Got it. I'll start from opening the app and explain the concrete steps in plain language."), createdAt: now - 21.5 * minute },
      { id: "chat:today-vivi-extra", conversationId: routerId, role: "assistant", text: word("例子也会用日常的事情，比如整理资料、写周报和看文件。", "I'll use everyday examples, like organizing notes, writing an update, and reading a file."), createdAt: now - 21.3 * minute },
      { id: "chat:later-vivi", conversationId: routerId, role: "assistant", text: word("初稿整理好了，分成三个小节：\n\n- **开始聊天**：直接告诉我你想做什么\n- **带上文件**：把资料拖进输入框\n- **接着聊**：随时补充要求\n\n你可以先看看，哪里太正式我们再一起改。", "The draft is ready, in three short sections:\n\n- **Start chatting**: tell me what you need\n- **Bring a file**: drag your material into the composer\n- **Keep talking**: add instructions whenever you like\n\nTake a look, and we can soften anything that feels too formal."), createdAt: now - 9 * minute },
      { id: "chat:latest-user", conversationId: routerId, role: "user", text: word("这个结构可以！最后再补一句：不用一次把要求说完整，想到什么都可以接着发。这样更像日常聊天，也能让刚开始用的人放松一点。", "I like the structure! Add that you don't have to explain everything at once: you can send another message whenever something comes to mind. That should help new users feel at ease."), createdAt: now - 2 * minute },
      { id: "chat:latest-vivi", conversationId: routerId, role: "assistant", text: word("加上了。你想到什么就接着说，我会把前后连起来。", "Added. Send things as they come to mind; I'll connect the dots."), createdAt: now - minute },
    );
  }
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
  if (scenario === "execution-error") {
    attention.length = 0;
    for (const conversation of conversations) conversation.paused = false;
    for (const item of progress) item.phase = "failed";
    for (const conversationId of [routerId, "vivi-worker-release"]) {
      const inputId = `failed:${conversationId}`;
      const error = conversationId === routerId ? "Vivi execution timed out" : "503: Our servers are currently overloaded. Please try again later.";
      executionErrors.push({ conversationId, inputId, error, startedAt: now - 100_000, createdAt: now });
      const result: BotResult = { id: `result:${inputId}`, conversationId, inputId, epoch: 0, status: "failed", summary: error, createdAt: now };
      results.push(result);
      chatMessages.push({ id: `chat:${inputId}`, conversationId, inputId, role: "assistant", kind: "result", result, text: error, createdAt: now });
    }
  }
  if (scenario.startsWith("promo-")) {
    // `?vivi=promo-<stage>`: the promo film's run (see vivi-promo-fixture.ts).
    const promo = viviPromoScenario(now, scenario.slice("promo-".length) as ViviPromoStage);
    conversations.splice(0, conversations.length, ...promo.conversations);
    attention.splice(0, attention.length, ...promo.attention);
    chatMessages.splice(0, chatMessages.length, ...promo.chatMessages);
    progress.splice(0, progress.length, ...promo.progress);
    results.splice(0, results.length, ...promo.results);
    for (const key of Object.keys(conversationPreviews)) delete conversationPreviews[key];
    Object.assign(conversationPreviews, promo.previews);
    messages.clear();
    for (const [id, transcript] of promo.transcripts) messages.set(id, transcript);
  }
  const running = () => progress.some((item) => ["accepted", "understanding", "planning", "delegating", "working", "summarizing"].includes(item.phase));
  const snapshot = (): WorkSnapshot => ({ revision, chatGeneration, routerConversationId: routerId, conversations: structuredClone(conversations), attention: structuredClone(attention), results: structuredClone(results), progress: structuredClone(progress), conversationPreviews: structuredClone(conversationPreviews), executionErrors: structuredClone(executionErrors), deliveries: [], messages: structuredClone(chatMessages) });
  const emit = (conversationId?: string) => { revision++; listeners.forEach((listener) => listener({ revision, conversationId, activity: { running: running(), waiting: attention.some((item) => item.status === "pending"), conversationId } })); };
  const api: BotApi = {
    getWorkSnapshot: async () => snapshot(),
    clearChat: async () => { chatMessages.length = 0; chatGeneration++; emit(); return snapshot(); },
    getActivity: async () => ({ running: running(), waiting: attention.some((item) => item.status === "pending"), conversationId: routerId }),
    onChanged: (listener) => { listeners.add(listener); return () => listeners.delete(listener); },
    onNavigate: () => () => {},
    submit: async (input) => {
      const id = input.conversationId ?? routerId;
      if (chatMessages.some((item) => item.inputId === input.requestId && item.role === "user")) return snapshot();
      chatMessages.push({ id: `chat:user:${input.requestId}`, conversationId: id, role: "user", text: input.text, createdAt: Date.now(), inputId: input.requestId });
      {
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
    continueConversation: async ({ conversationId, inputId }) => {
      if (inputId) {
        const index = executionErrors.findIndex((item) => item.conversationId === conversationId && item.inputId === inputId);
        if (index < 0) return snapshot();
        executionErrors.splice(index, 1);
        if (conversationId === routerId) chatMessages.push({ id: `retry:${inputId}`, conversationId, inputId: `resume:${inputId}`, role: "assistant", text: word("已根据保存的结果重新整理完成。", "Summarized the saved results successfully."), createdAt: Date.now() });
      }
      const conversation = conversations.find((entry) => entry.conversationId === conversationId);
      if (conversation) conversation.paused = false;
      const state = progress.find((item) => item.conversationId === conversationId);
      if (state) { state.phase = inputId ? "completed" : "working"; state.startedAt = Date.now(); state.inputId = `resume:${Date.now()}`; }
      emit(conversationId); return snapshot();
    },
    stopAll: async () => { progress.forEach((item) => { if (["accepted", "understanding", "planning", "delegating", "working", "summarizing"].includes(item.phase)) item.phase = "paused"; }); conversations.forEach((conversation) => { if (conversation.role === "worker") conversation.paused = true; }); emit(); return snapshot(); },
  };
  return api;
}

export type ViviPendingUiFixture = {
  requests: () => Array<Record<string, unknown>>;
  respond: (payload: { id: string; confirmed?: boolean; value?: string; cancelled?: boolean; answers?: Array<string | null> }) => void;
  add: (request: Record<string, unknown>) => void;
  dismiss: (id: string) => void;
  onEvent: (listener: (event: EngineEvent) => void) => () => void;
  responses: Array<{ id: string; confirmed?: boolean; value?: string; cancelled?: boolean; answers?: Array<string | null> }>;
};

export function createViviPendingUiFixture(english = false, enabled = false, ordinaryConversationId = "ordinary-chat"): ViviPendingUiFixture {
  const word = (zh: string, en: string) => english ? en : zh;
  const listeners = new Set<(event: EngineEvent) => void>();
  const responses: ViviPendingUiFixture["responses"] = [];
  const requests: Array<Record<string, unknown>> = enabled ? [
    { type: "extension_ui_request", id: "vivi-plugin-confirm", conversationId: "vivi-worker-release", method: "confirm", title: word("需要确认", "Confirmation needed"), message: word("发布说明已经准备好，是否继续运行发布检查？", "The release notes are ready. Continue the release checks?"), timeout: 0 },
    { type: "extension_ui_request", id: "vivi-plugin-select", conversationId: "vivi-worker-release", method: "select", title: word("选择发布渠道", "Choose a release channel"), message: word("请选择这次检查使用的渠道。", "Choose the channel for this check."), options: [word("测试环境", "Staging"), word("正式环境", "Production")], optionDetails: [{ description: word("只验证构建和安装流程", "Validate build and installation only") }, { description: word("会检查正式发布配置", "Check production release settings") }] },
    { type: "extension_ui_request", id: "vivi-plugin-input", conversationId: "vivi-worker-guide", method: "input", title: word("需要一个文件名", "A filename is needed"), message: word("请输入入门说明的输出文件名。", "Enter the output filename for the guide."), placeholder: word("例如：getting-started.md", "e.g. getting-started.md") },
    { type: "extension_ui_request", id: "vivi-plugin-editor", conversationId: "vivi-worker-guide", method: "editor", title: word("补充发布说明", "Add release notes"), message: word("请补充一段会写入文档的说明。", "Add a paragraph that will be written to the document."), prefill: word("这次更新包含……", "This update includes…") },
    { type: "extension_ui_request", id: "vivi-plugin-questions", conversationId: "vivi-worker-guide", method: "questions", title: word("需要确认几项信息", "A few details need confirmation"), questions: [{ header: word("受众", "Audience"), question: word("这份文档面向谁？", "Who is this document for?"), options: [word("开发者", "Developers"), word("普通用户", "General users")], allowOther: true }, { header: word("语气", "Tone"), question: word("文档使用什么语气？", "What tone should the document use?"), options: [word("简洁", "Concise"), word("详细", "Detailed")], allowOther: false }] },
    { type: "extension_ui_request", id: "ordinary-plugin-confirm", conversationId: ordinaryConversationId, method: "confirm", title: word("普通聊天请求", "Ordinary chat request"), message: word("这条请求不应出现在 Vivi 面板。", "This request should not appear in Vivi.") },
  ] : [];
  const emit = (event: EngineEvent): void => { for (const listener of listeners) listener(event); };
  const requestSnapshot = (): Array<Record<string, unknown>> => structuredClone(requests);
  const remove = (id: string): void => { const index = requests.findIndex((item) => item.id === id); if (index >= 0) requests.splice(index, 1); };
  const respond = (payload: ViviPendingUiFixture["responses"][number]): void => {
    const request = requests.find((item) => item.id === payload.id);
    if (!request) return;
    remove(payload.id); responses.push(structuredClone(payload));
    emit({ type: "extension_ui_dismiss", id: payload.id, conversationId: request.conversationId } as EngineEvent);
  };
  const fixture: ViviPendingUiFixture = {
    requests: requestSnapshot,
    respond,
    add: (request) => { if (typeof request.id !== "string" || requests.some((item) => item.id === request.id)) return; requests.push({ type: "extension_ui_request", ...request }); emit({ ...request, type: "extension_ui_request" } as EngineEvent); },
    dismiss: (id) => { const request = requests.find((item) => item.id === id); if (!request) return; remove(id); emit({ type: "extension_ui_dismiss", id, conversationId: request.conversationId } as EngineEvent); },
    onEvent: (listener) => { listeners.add(listener); return () => listeners.delete(listener); },
    responses,
  };
  return fixture;
}
