import type { BotAttention, BotChatMessage, BotConversationMeta, BotProgress, BotResult } from "@shared/bot";
import type { ChatMessage, ToolCallBlock } from "@shared/types";

/**
 * `mock.html?vivi=promo-<stage>`: the promo film's Vivi run. One user request, three Worker
 * conversations, a question, and the delivery, captured at four stages:
 * `request` (draft only), `working`, `question`, `delivered`.
 */
export type ViviPromoStage = "request" | "working" | "question" | "delivered";

export const VIVI_PROMO_CWD = "/Users/demo/Code/orbit";
export const VIVI_PROMO_REQUEST = "下周 Orbit 发 2.4，帮我把「团队共享日历」做完：成员能看到彼此的忙闲，拖拽改期时提示冲突。做完在浏览器里走一遍，再截几张 App Store 用图。顺便准备发布会 PPT 和一张海报，把内测用户的反馈汇总成表格、挑重点放进 PPT。以后每天早上把新反馈汇总给我。";

const MINUTE = 60_000;
const W = {
  dev: "vivi-promo-dev",
  materials: "vivi-promo-materials",
  feedback: "vivi-promo-feedback",
};
const TITLES = {
  [W.dev]: "团队共享日历：开发与验证",
  [W.materials]: "Orbit 2.4 发布物料",
  [W.feedback]: "内测反馈汇总",
};

const tool = (id: string, name: string, args: Record<string, unknown>, extra: Partial<ToolCallBlock> = {}): ToolCallBlock => ({ id, name, args, status: "done", ...extra });
function turn(id: string, text: string, tools: ToolCallBlock[], at: number, thinking?: string): ChatMessage {
  return {
    id, role: "assistant", text, tools, createdAt: at, completedAt: at + MINUTE,
    parts: [
      ...(thinking ? [{ kind: "thinking" as const, text: thinking, startedAt: at, endedAt: at + 5_000 }] : []),
      { kind: "text" as const, text },
      ...tools.map((item) => ({ kind: "tool" as const, toolId: item.id })),
    ],
  };
}
const userTurn = (id: string, text: string, at: number): ChatMessage => ({ id, role: "user", text, tools: [], parts: [{ kind: "text", text }], createdAt: at });

function devTranscript(now: number, stage: ViviPromoStage): ChatMessage[] {
  const todos = ["梳理日历接口与角色权限", "实现忙闲合并与冲突检测", "实现周视图与拖拽改期", "补充前后端测试", "浏览器走一遍周视图", "截取 App Store 用图"]
    .map((content, index) => ({ id: `dev-${index}`, content, status: stage === "delivered" || index < 3 ? "completed" : index === 3 ? "in_progress" : "pending", ...(index === 3 ? { activeForm: "正在补充前后端测试" } : {}) }));
  const createdAt = now - 40 * MINUTE;
  const threads = [
    { id: "vivi-promo-agent-1", name: "Quiet Heron", avatarSeed: 17, task: "梳理 auth/roles 与现有日历接口的权限链路", agent: "explorer" },
    { id: "vivi-promo-agent-2", name: "Amber Lynx", avatarSeed: 63, task: "找出前端拖拽库与时区处理方式", agent: "explorer" },
    { id: "vivi-promo-agent-3", name: "Cobalt Wren", avatarSeed: 88, task: "在独立 worktree 里补冲突检测的单元测试", agent: "worker" },
  ].map((thread) => ({ ...thread, conversationId: W.dev, rootId: thread.id, taskName: thread.id, cwd: VIVI_PROMO_CWD, status: "completed" as const, createdAt, updatedAt: createdAt + 6 * MINUTE, currentTurn: 1, revision: 1 }));
  const messages: ChatMessage[] = [
    userTurn("dev-user", "为 Orbit 实现团队共享日历：成员忙闲可见、拖拽改期检测冲突、私人日程只显示忙碌；走现有角色权限，前后端补测试；最后用浏览器验证周视图，并在 iOS 模拟器里截 App Store 用图。", now - 41 * MINUTE),
    turn("dev-plan", "这件事跨 server、web、mobile 三个文件夹。我先定下目标，再让三个子 Agent 并行摸清权限、前端和测试。", [
      tool("dev-goal", "create_goal", { objective: "团队共享日历完成并通过前后端测试、浏览器验证与截图" }),
      tool("website-todo", "todo", { todos }, { details: { todos } }),
      ...threads.map((thread, index) => tool(`dev-spawn-${index}`, "spawn_agent", { task_name: thread.taskName, message: thread.task }, { details: { thread } })),
      tool("dev-worktree", "worktree_create", { branch: "feat/team-calendar" }),
    ], now - 40 * MINUTE, "需求有四块：忙闲合并、可见性、冲突检测、周视图。权限要复用现有角色；前端拖拽和时区也要先看。三条线互不依赖，可以并行。"),
    turn("dev-build", "权限检查集中在 requireRole，前端用 dnd-kit。私人日程的可见范围需要用户确认，我先问一句。", [
      tool("dev-read", "read", { path: `${VIVI_PROMO_CWD}/server/calendar/events.ts` }),
      tool("dev-grep", "grep", { pattern: "requireRole|canReadCalendar", path: `${VIVI_PROMO_CWD}/server` }),
      tool("dev-web", "web_search", { query: "free busy calendar privacy busy-only visibility" }, { details: { sources: [{ title: "Free/busy visibility in shared calendars", url: "https://example.dev/free-busy" }, { title: "Drag to reschedule: conflict UX", url: "https://example.dev/reschedule-ux" }] } }),
      tool("dev-ask", "bot_ask_user", { question: "管理员能看到成员私人日程的标题吗？" }),
    ], now - 33 * MINUTE),
  ];
  if (stage === "working" || stage === "request") return messages;
  messages.push(turn("dev-code", "确认了：私人日程对所有人只显示忙碌。忙闲合并、权限和周视图已经写好。", [
    tool("dev-write-1", "write", { path: `${VIVI_PROMO_CWD}/server/calendar/availability.ts`, content: "export function teamAvailability() {}\n" }),
    tool("dev-edit-1", "edit", { path: `${VIVI_PROMO_CWD}/server/calendar/permissions.ts` }, { details: { diff: "@@ -10,3 +10,12 @@\n+export function canSeeDetails(role, event, viewerId) {\n+  if (event.visibility === \"private\") return event.ownerId === viewerId;\n+  return role === \"owner\" || role === \"admin\" || event.attendees.includes(viewerId);\n+}\n" } }),
    tool("dev-write-2", "write", { path: `${VIVI_PROMO_CWD}/web/src/calendar/WeekView.tsx`, content: "export function WeekView() {}\n" }),
    tool("dev-test", "bash", { command: "pnpm --filter server test calendar && pnpm typecheck" }, { result: "✓ availability.test.ts (9)\n✓ permissions.test.ts (5)\n Tests  14 passed (14)" }),
  ], now - 24 * MINUTE));
  if (stage === "question") return messages;
  messages.push(turn("dev-verify", "在浏览器里拖动「设计评审」，冲突提示正常；再到 iOS 模拟器里截了 5 张 App Store 用图。", [
    tool("dev-nav", "browser_navigate", { url: "http://localhost:5173/teams/design/calendar?week=2026-W46" }),
    tool("dev-drag", "browser_click", { text: "设计评审" }),
    tool("dev-snap", "browser_snapshot", {}),
    tool("dev-sim", "computer_click", { app: "Simulator", text: "团队日历" }),
    tool("dev-shot", "computer_screenshot", { app: "Simulator" }),
    tool("dev-commit", "bash", { command: "git commit -m \"feat(calendar): add team free/busy calendar\"" }, { result: "[feat/team-calendar 3f9a2c1] 9 files changed, 412 insertions(+), 38 deletions(-)" }),
  ], now - 14 * MINUTE));
  messages.push(turn("dev-done", "团队共享日历完成：14 个后端测试和 1 个端到端用例通过，改动已提交到 `feat/team-calendar`，App Store 截图在 `mobile/screenshots/`。", [
    tool("dev-goal-done", "update_goal", { status: "complete" }),
    tool("dev-report", "bot_report", { outcome: "ready", summary: "团队共享日历做好了，测试和浏览器验证都通过。" }),
  ], now - 10 * MINUTE));
  return messages;
}

function materialsTranscript(now: number, stage: ViviPromoStage): ChatMessage[] {
  const messages: ChatMessage[] = [
    userTurn("mat-user", "为 Orbit 2.4 准备发布物料：一张发布海报、一份发布会 PPT。PPT 里要放内测反馈的重点（来自反馈汇总工作）。", now - 40 * MINUTE),
    turn("mat-poster", "先做海报，主视觉用浮动的日历方块，留出标题位置。", [
      tool("mat-image", "generate_image", { prompt: "Orbit 2.4 团队共享日历发布海报，蓝紫色玻璃质感日历方块，留白给标题" }),
    ], now - 38 * MINUTE),
  ];
  if (stage === "working" || stage === "request") return messages;
  messages.push(turn("mat-deck", "海报好了。PPT 用 Office 技能生成，反馈页等反馈汇总的结果。", [
    tool("mat-skill", "skill", { skill: "office" }),
    tool("mat-deck-write", "write", { path: `${VIVI_PROMO_CWD}/docs/launch/团队日历发布.pptx` }),
  ], now - 26 * MINUTE));
  if (stage === "question") return messages;
  messages.push(turn("mat-done", "海报和 8 页 PPT 已完成，反馈重点放在第 3 页。", [
    tool("mat-present", "present", { items: [{ source: `${VIVI_PROMO_CWD}/docs/launch/团队日历发布.pptx` }, { source: `${VIVI_PROMO_CWD}/docs/launch/poster.png` }] }),
    tool("mat-report", "bot_report", { outcome: "ready", summary: "海报和发布会 PPT 准备好了。" }),
  ], now - 9 * MINUTE));
  return messages;
}

function feedbackTranscript(now: number, stage: ViviPromoStage): ChatMessage[] {
  const messages: ChatMessage[] = [
    userTurn("fb-user", "汇总 Orbit 内测用户关于日历的反馈：从 Linear 和数据库取数据，整理成 Excel，挑出 3 条重点给发布物料用；之后每天早上 9 点汇总新反馈。", now - 40 * MINUTE),
    turn("fb-pull", "从 Linear 拉了 46 条带 calendar 标签的 issue，从数据库读了 312 条内测评分。", [
      tool("fb-linear", "mcp__linear__list_issues", { label: "calendar", state: "all" }),
      tool("fb-db", "mcp__postgres__query", { sql: "select rating, comment from beta_feedback where feature = 'calendar'" }),
    ], now - 37 * MINUTE),
  ];
  if (stage === "working" || stage === "request") return messages;
  messages.push(turn("fb-sheet", "按主题归类后写进表格：冲突提醒、时区、隐私是前三。", [
    tool("fb-codemode", "codemode", { code: "// group feedback by theme" }),
    tool("fb-xlsx", "write", { path: `${VIVI_PROMO_CWD}/docs/launch/内测反馈汇总.xlsx` }),
  ], now - 30 * MINUTE));
  if (stage === "question") return messages;
  messages.push(turn("fb-done", "表格完成，重点已交给发布物料；每天 9:00 的反馈汇总也排好了。", [
    tool("fb-schedule", "schedule_create", { name: "每日内测反馈汇总", schedule: { kind: "daily", time: "09:00", timeZone: "Asia/Shanghai" } }),
    tool("fb-report", "bot_report", { outcome: "ready", summary: "反馈汇总好了，每天早上 9 点会再整理新反馈。" }),
  ], now - 11 * MINUTE));
  return messages;
}

export function viviPromoScenario(now: number, stage: ViviPromoStage) {
  const routerId = "vivi-router";
  const conversations: BotConversationMeta[] = [
    { conversationId: routerId, role: "router", owner: "vivi", creationKey: "router", epoch: 0, paused: false, createdAt: now - 3 * 86_400_000, updatedAt: now, title: "Vivi" },
  ];
  const chatMessages: BotChatMessage[] = [
    { id: "promo-old-user", conversationId: routerId, role: "user", text: "早，今天主要忙 Orbit 2.4 的发布。", createdAt: now - 48 * MINUTE },
    { id: "promo-old-vivi", conversationId: routerId, role: "assistant", text: "好，需要我做什么直接说。", createdAt: now - 47.8 * MINUTE },
  ];
  const transcripts = new Map<string, ChatMessage[]>();
  const progress: BotProgress[] = [];
  const results: BotResult[] = [];
  const attention: BotAttention[] = [];
  const previews: Record<string, { text: string; updatedAt: number }> = {};
  if (stage === "request") return { routerId, conversations, chatMessages, transcripts, progress, results, attention, previews, draft: VIVI_PROMO_REQUEST };

  chatMessages.push(
    { id: "promo-user", conversationId: routerId, role: "user", text: VIVI_PROMO_REQUEST, createdAt: now - 42 * MINUTE, inputId: "promo-input" },
    { id: "promo-ack", conversationId: routerId, role: "assistant", text: "收到。我拆成三件事同时做：开发与验证、发布物料、反馈汇总。物料会等反馈的重点再定稿。", createdAt: now - 41.5 * MINUTE, inputId: "promo-input" },
  );
  const workers = [W.dev, W.materials, W.feedback];
  for (const [index, id] of workers.entries()) {
    conversations.push({ conversationId: id, role: "worker", owner: "vivi", creationKey: `work:${id}`, epoch: 0, paused: false, createdAt: now - (41 - index) * MINUTE, updatedAt: now - 10 * MINUTE, title: TITLES[id], project: VIVI_PROMO_CWD });
  }
  transcripts.set(W.dev, devTranscript(now, stage));
  transcripts.set(W.materials, materialsTranscript(now, stage));
  transcripts.set(W.feedback, feedbackTranscript(now, stage));

  const detail = {
    working: { [W.dev]: "三个子 Agent 正在摸清权限和前端", [W.materials]: "正在生成发布海报", [W.feedback]: "正在从 Linear 和数据库拉取反馈" },
    question: { [W.dev]: "等你确认私人日程的可见范围", [W.materials]: "正在做发布会 PPT", [W.feedback]: "正在按主题整理反馈表" },
  } as const;
  if (stage === "working" || stage === "question") {
    for (const id of workers) {
      const waiting = stage === "question" && id === W.dev;
      progress.push({ conversationId: id, inputId: `in:${id}`, role: "worker", title: TITLES[id], phase: waiting ? "waiting" : "working", detail: detail[stage][id], startedAt: now - 40 * MINUTE, updatedAt: now, queuedCount: 0 });
      previews[id] = { text: detail[stage][id], updatedAt: now };
    }
  }
  if (stage === "question") {
    chatMessages.push({ id: "promo-milestone", conversationId: routerId, role: "assistant", kind: "progress", text: "海报出好了，反馈也拉回来了：46 条 issue、312 条评分。", createdAt: now - 30 * MINUTE });
    attention.push({ id: "promo-attention", conversationId: W.dev, epoch: 0, question: "私人日程对管理员也只显示「忙碌」，还是管理员能看到标题？", status: "pending", createdAt: now - 33 * MINUTE });
  }
  if (stage === "delivered") {
    const summaries = {
      [W.dev]: "团队共享日历做好了，测试和浏览器验证都通过，已提交到 feat/team-calendar。",
      [W.materials]: "海报和 8 页发布会 PPT 准备好了。",
      [W.feedback]: "反馈汇总成表格了，每天早上 9 点会再整理新反馈。",
    };
    const artifacts = {
      [W.dev]: [`${VIVI_PROMO_CWD}/mobile/screenshots`],
      [W.materials]: [`${VIVI_PROMO_CWD}/docs/launch/团队日历发布.pptx`, `${VIVI_PROMO_CWD}/docs/launch/poster.png`],
      [W.feedback]: [`${VIVI_PROMO_CWD}/docs/launch/内测反馈汇总.xlsx`],
    };
    for (const id of workers) {
      const result: BotResult = { id: `result:${id}`, conversationId: id, inputId: `in:${id}`, epoch: 0, status: "ready", summary: summaries[id], artifacts: artifacts[id], createdAt: now - 9 * MINUTE };
      results.push(result);
      progress.push({ conversationId: id, inputId: `in:${id}`, role: "worker", title: TITLES[id], phase: "completed", startedAt: now - 40 * MINUTE, updatedAt: now - 9 * MINUTE, queuedCount: 0, result });
      previews[id] = { text: summaries[id], updatedAt: now - 9 * MINUTE };
      chatMessages.push({ id: `promo-result:${id}`, conversationId: id, role: "assistant", kind: "result", title: TITLES[id], result, text: summaries[id], createdAt: now - 9 * MINUTE });
    }
    chatMessages.push(
      { id: "promo-milestone", conversationId: routerId, role: "assistant", kind: "progress", text: "海报出好了，反馈也拉回来了：46 条 issue、312 条评分。", createdAt: now - 30 * MINUTE },
      { id: "promo-answer-user", conversationId: routerId, role: "user", text: "管理员也只看到忙碌。", createdAt: now - 28 * MINUTE },
      { id: "promo-answer-vivi", conversationId: routerId, role: "assistant", text: "好，按这个做。", createdAt: now - 27.8 * MINUTE },
      { id: "promo-delivery", conversationId: routerId, role: "assistant", text: "都做完了：\n\n- **团队共享日历**：测试和浏览器验证通过，已提交到 `feat/team-calendar`\n- **App Store 截图**：5 张，在 `mobile/screenshots/`\n- **发布物料**：`团队日历发布.pptx`（8 页）和一张海报\n- **反馈汇总**：`内测反馈汇总.xlsx`，重点放在 PPT 第 3 页\n\n以后每天早上 9 点，我会把新反馈整理给你。", createdAt: now - 8 * MINUTE },
    );
  }
  return { routerId, conversations, chatMessages, transcripts, progress, results, attention, previews, draft: undefined as string | undefined };
}
