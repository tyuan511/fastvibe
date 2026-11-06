import type {
  ChatMessage,
  Conversation,
  DirEntry,
  EngineSessionState,
  FilePreview,
  Project,
  SessionStats,
  ToolCallBlock,
} from "@shared/types";
import type { GitStatus } from "@shared/ipc";

export type WebsiteLanguage = "zh" | "en";

export type WebsiteFixture = {
  language: WebsiteLanguage;
  cwd: string;
  activeId: string;
  projects: Project[];
  conversations: Conversation[];
  messages: ChatMessage[];
  session: EngineSessionState;
  stats: SessionStats;
  tree: Record<string, DirEntry[]>;
  previewPath: string;
  previewFor: (path: string) => FilePreview;
  gitStatus: GitStatus;
  gitDiff: (path?: string) => string;
  /** Repository-relative file the `review` scene opens in the Git pane. */
  reviewPath: string;
  /** The slide deck the run made; `?pane=files&office=pptx` previews it. */
  deckPath: string;
};

/**
 * The run shown on the website, in both READMEs and in the promo film: one task that
 * spans backend, frontend, subagents, a question, a browser check and a slide deck, so a
 * single conversation shows how much FastVibe carries.
 */
const NOW = Date.now();
const MINUTE = 60_000;
const DAY = 24 * 60 * MINUTE;
const CWD = "/Users/demo/Code/orbit";
const ACTIVE_ID = "website-orbit-team-calendar";
const SCRATCH = "/Users/demo/Library/Application Support/FastVibe/scratch";
const P = {
  availability: `${CWD}/server/calendar/availability.ts`,
  permissions: `${CWD}/server/calendar/permissions.ts`,
  events: `${CWD}/server/calendar/events.ts`,
  routes: `${CWD}/server/routes/calendar.ts`,
  week: `${CWD}/web/src/calendar/WeekView.tsx`,
  drag: `${CWD}/web/src/calendar/useDragReschedule.ts`,
};

const copy = {
  zh: {
    deckName: "团队日历发布.pptx",
    conversations: [
      ["团队共享日历与冲突检测", "忙闲视图、拖拽改期、发布会 PPT 已完成。"],
      ["迁移通知服务到队列", "拆出重试与死信队列。"],
      ["排查周报导出超时", "定位到 N+1 查询。"],
      ["准备 2.3 发布说明", "整理本周变更。"],
    ],
    paper: ["论文摘录的自动归档", "按引用格式归档 PDF 摘录。"],
    mobile: ["推送通知的静默时段", "按时区计算免打扰。"],
    scratch: [["整理用户访谈纪要", "按主题归纳 12 份访谈。"], ["季度 OKR 表格", "汇总各组目标与进度。"]],
    user: "给 Orbit 做团队共享日历：成员能看到彼此的忙闲，拖拽改期时自动检测冲突，私人日程只显示「忙碌」。权限要走现有的角色体系，前后端都补测试，最后用浏览器把周视图走一遍，再给发布会准备一份 PPT。",
    thinking: "需求有四块：忙闲合并、可见性、冲突检测、周视图。权限要复用现有角色，先摸清 requireRole 的调用链；前端的拖拽库和时区处理也要先看。两条线互不依赖，可以并行。",
    plan: "这件事跨前后端，我先拆成七步，并让三个子 Agent 并行摸清权限、前端组件和测试。",
    todos: ["梳理现有日历与角色权限", "设计忙闲合并与可见性规则", "实现后端接口与冲突检测", "实现周视图与拖拽改期", "补充前后端测试", "浏览器验证周视图", "生成发布会 PPT"],
    agents: [
      ["Quiet Heron", "梳理 auth/roles 与现有日历接口的权限检查链路"],
      ["Amber Lynx", "找出前端日历组件、拖拽库和时区处理方式"],
      ["Cobalt Wren", "为忙闲合并与冲突检测补充单元测试"],
    ],
    research: "两个 explorer 都回来了：权限检查集中在 requireRole，前端用 dnd-kit 且时间统一存 UTC。私人日程的可见范围需要你确认一下。",
    sources: [
      ["Free/busy visibility in shared calendars", "https://example.dev/free-busy"],
      ["Drag to reschedule: conflict UX patterns", "https://example.dev/reschedule-ux"],
      ["Time zones in week views", "https://example.dev/week-view-tz"],
    ],
    question: "管理员能看到成员私人日程的标题吗？",
    answer: "不能，私人日程对所有人只显示忙碌",
    build: "规则定了：私人日程对所有人只显示忙碌。我先写忙闲合并和权限，再接周视图和拖拽。",
    verify: "代码就绪。跑测试、类型检查，再在浏览器里拖一次日程看冲突提示。",
    deck: "最后用 Office 技能做发布会 PPT，并提交改动。",
    finish: "团队共享日历已完成，前后端测试都已通过：\n\n| 部分 | 实现 |\n| --- | --- |\n| 忙闲视图 | 合并成员日程为忙闲时段，私人日程只显示「忙碌」 |\n| 权限 | 复用 owner / admin / member / guest 角色，新增 `canSeeDetails` |\n| 冲突检测 | 拖拽松手时检查所有成员，冲突时给出提示并保留原时间 |\n| 周视图 | 新的 `WeekView`，按成员分列，支持拖拽改期 |\n| 测试 | 后端 14 个单测，前端 1 个端到端用例 |\n\n浏览器里走了一遍：拖动「设计评审」到周四 15:00，和 Mia 的日程冲突，提示正常出现；改到 16:30 后保存成功。\n\n发布会 PPT 放在 `docs/launch/团队日历发布.pptx`，共 8 页：问题、方案、权限模型、演示截图和上线计划。",
    privateComment: "私人日程对所有者以外的人只显示「忙碌」。管理员能看到团队日程标题；成员只能看到自己受邀日程的标题。",
    readme: "# Orbit\n\n团队排期与协作。\n\n## 团队日历\n\n成员之间共享忙闲，拖拽改期时检测冲突。私人日程只显示「忙碌」。\n\n## 开发\n\n```sh\npnpm install\npnpm dev\n```\n",
    serverTest: "✓ availability.test.ts (9)\n✓ permissions.test.ts (5)\n\nTest Files  2 passed (2)\n     Tests  14 passed (14)",
    e2eTest: "✓ team-calendar.spec.ts › 拖拽改期时提示冲突 (3.2s)\n\n1 passed (4.1s)",
    eventTitle: "设计评审",
  },
  en: {
    deckName: "team-calendar-launch.pptx",
    conversations: [
      ["Shared team calendar with conflict checks", "Free/busy view, drag to reschedule and the launch deck are done."],
      ["Move notifications onto a queue", "Split out retries and a dead-letter queue."],
      ["Weekly report export times out", "Traced to an N+1 query."],
      ["Prepare the 2.3 release notes", "Collected this week's changes."],
    ],
    paper: ["Auto-archive paper excerpts", "Files PDF excerpts by citation style."],
    mobile: ["Quiet hours for push notifications", "Do-not-disturb by time zone."],
    scratch: [["Summarize user interviews", "Grouped 12 interviews by theme."], ["Quarterly OKR sheet", "Goals and progress for every team."]],
    user: "Build a shared team calendar for Orbit: members see each other's free/busy time, dragging to reschedule checks for conflicts, and private events only show as \"Busy\". Permissions should use the existing roles. Add tests on both ends, walk the week view in a browser, then put together a launch deck.",
    thinking: "Four parts: merging free/busy, visibility, conflict checks, the week view. Permissions must reuse the existing roles, so trace requireRole first; the frontend's drag library and time-zone handling need a look too. The two don't depend on each other, so they can run in parallel.",
    plan: "This spans backend and frontend, so I'll split it into seven steps and send three subagents to map permissions, the frontend components and the tests in parallel.",
    todos: ["Map the calendar and role permissions", "Design free/busy merging and visibility", "Build the API and conflict checks", "Build the week view with drag to reschedule", "Add backend and frontend tests", "Check the week view in a browser", "Make the launch deck"],
    agents: [
      ["Quiet Heron", "Trace permission checks through auth/roles and the calendar API"],
      ["Amber Lynx", "Find the calendar components, drag library and time-zone handling"],
      ["Cobalt Wren", "Add unit tests for free/busy merging and conflict checks"],
    ],
    research: "Both explorers are back: permission checks all go through requireRole, and the frontend uses dnd-kit with times stored in UTC. One call on private events needs you.",
    sources: [
      ["Free/busy visibility in shared calendars", "https://example.dev/free-busy"],
      ["Drag to reschedule: conflict UX patterns", "https://example.dev/reschedule-ux"],
      ["Time zones in week views", "https://example.dev/week-view-tz"],
    ],
    question: "Can admins see the titles of members' private events?",
    answer: "No, private events only show as busy to everyone",
    build: "Settled: private events only show as busy. I'll write free/busy merging and permissions first, then wire in the week view and dragging.",
    verify: "The code is in place. Running the tests and type check, then dragging an event in the browser to see the conflict prompt.",
    deck: "Last, the launch deck with the Office skill, and a commit.",
    finish: "The shared team calendar is done, and tests pass on both ends:\n\n| Area | Behaviour |\n| --- | --- |\n| Free/busy | Members' events merge into busy slots; private events show only as \"Busy\" |\n| Permissions | Reuses the owner / admin / member / guest roles, plus a new `canSeeDetails` |\n| Conflicts | Dropping an event checks every member, warns on a clash and keeps the old time |\n| Week view | A new `WeekView`, one column per member, with drag to reschedule |\n| Tests | 14 backend unit tests, 1 end-to-end test |\n\nI walked it in the browser: dragging \"Design review\" to Thursday 15:00 clashed with Mia's event and the warning appeared; moving it to 16:30 saved.\n\nThe launch deck is at `docs/launch/team-calendar-launch.pptx`, 8 slides: problem, approach, permission model, demo shots and rollout plan.",
    privateComment: "Private events show as \"busy\" to everyone but their owner. Admins see titles of team events; members see titles only of events they were invited to.",
    readme: "# Orbit\n\nTeam scheduling and collaboration.\n\n## Team calendar\n\nMembers share free/busy time, and rescheduling checks for conflicts. Private events only show as \"Busy\".\n\n## Development\n\n```sh\npnpm install\npnpm dev\n```\n",
    serverTest: "✓ availability.test.ts (9)\n✓ permissions.test.ts (5)\n\nTest Files  2 passed (2)\n     Tests  14 passed (14)",
    e2eTest: "✓ team-calendar.spec.ts › drag to reschedule shows conflicts (3.2s)\n\n1 passed (4.1s)",
    eventTitle: "Design review",
  },
} as const;

const AVAILABILITY = `import type { CalendarEvent, Member, Role } from "./events";
import { canSeeDetails } from "./permissions";

export type Slot = { start: number; end: number; busy: boolean; title?: string };

/** Merge every member's events into free/busy slots the viewer is allowed to see. */
export function teamAvailability(viewer: Member, members: Member[], events: CalendarEvent[]): Map<string, Slot[]> {
  const byMember = new Map<string, Slot[]>();
  for (const member of members) {
    const own = events
      .filter((event) => event.ownerId === member.id && !event.cancelled)
      .sort((a, b) => a.start - b.start);
    byMember.set(member.id, mergeSlots(own.map((event) => ({
      start: event.start,
      end: event.end,
      busy: true,
      title: canSeeDetails(viewer.role as Role, event, viewer.id) ? event.title : undefined,
    }))));
  }
  return byMember;
}

export function findConflicts(slots: Slot[], start: number, end: number): Slot[] {
  return slots.filter((slot) => slot.busy && slot.start < end && start < slot.end);
}

function mergeSlots(slots: Slot[]): Slot[] {
  const merged: Slot[] = [];
  for (const slot of slots) {
    const last = merged.at(-1);
    if (last && slot.start <= last.end && last.title === slot.title) last.end = Math.max(last.end, slot.end);
    else merged.push({ ...slot });
  }
  return merged;
}
`;

function permissionsDiff(language: WebsiteLanguage): string {
  return `diff --git a/server/calendar/permissions.ts b/server/calendar/permissions.ts
index 4c1e7a2..9b03d5f 100644
--- a/server/calendar/permissions.ts
+++ b/server/calendar/permissions.ts
@@ -1,14 +1,32 @@
 import type { Role } from "../auth/roles";
+import type { CalendarEvent } from "./events";
 
 export const CALENDAR_ROLES: Record<Role, { read: boolean; write: boolean }> = {
   owner: { read: true, write: true },
   admin: { read: true, write: true },
   member: { read: true, write: false },
   guest: { read: false, write: false },
 };
 
 export function canReadCalendar(role: Role): boolean {
-  return CALENDAR_ROLES[role].read;
+  return CALENDAR_ROLES[role]?.read ?? false;
+}
+
+/**
+ * ${copy[language].privateComment}
+ */
+export function canSeeDetails(role: Role, event: CalendarEvent, viewerId?: string): boolean {
+  if (event.ownerId === viewerId) return true;
+  if (event.visibility === "private") return false;
+  if (role === "owner" || role === "admin") return true;
+  return viewerId !== undefined && event.attendees.includes(viewerId);
 }
`;
}

const WEEK_VIEW = `import { useMemo } from "react";
import { findConflicts } from "../../../server/calendar/availability";
import { useDragReschedule } from "./useDragReschedule";
import { useTeamAvailability } from "./useTeamAvailability";

export function WeekView({ teamId, week }: { teamId: string; week: Date }) {
  const { members, slots } = useTeamAvailability(teamId, week);
  const drag = useDragReschedule({
    onDrop: (event, start, end) => {
      const conflicts = members.flatMap((member) => findConflicts(slots.get(member.id) ?? [], start, end));
      return conflicts.length ? { status: "conflict", conflicts } : { status: "ok" };
    },
  });

  const columns = useMemo(() => buildWeekColumns(week), [week]);

  return (
    <div className="week-grid" onPointerMove={drag.move} onPointerUp={drag.drop}>
      <TimeRail />
      {columns.map((day) => (
        <DayColumn key={day.key} day={day} members={members} slots={slots} drag={drag} />
      ))}
      {drag.preview ? <DragGhost {...drag.preview} /> : null}
    </div>
  );
}
`;

const DRAG_HOOK = `import { useRef, useState } from "react";

type Drop = (event: CalendarEvent, start: number, end: number) => { status: "ok" } | { status: "conflict"; conflicts: Slot[] };

export function useDragReschedule({ onDrop }: { onDrop: Drop }) {
  const origin = useRef<{ event: CalendarEvent; y: number } | null>(null);
  const [preview, setPreview] = useState<DragPreview | null>(null);
  return {
    preview,
    start: (event: CalendarEvent, y: number) => (origin.current = { event, y }),
    move: (e: React.PointerEvent) => origin.current && setPreview(previewAt(origin.current, e.clientY)),
    drop: () => {
      if (origin.current && preview) onDrop(origin.current.event, preview.start, preview.end);
      origin.current = null;
      setPreview(null);
    },
  };
}
`;

function tool(id: string, name: string, args: Record<string, unknown>, extra: Partial<ToolCallBlock> = {}): ToolCallBlock {
  return { id, name, args, status: "done", ...extra };
}

export function websiteFixture(language: WebsiteLanguage): WebsiteFixture {
  const text = copy[language];
  const deckPath = `${CWD}/docs/launch/${text.deckName}`;
  const diff = permissionsDiff(language);
  const todoItems = text.todos.map((content, index) => ({ id: `task-${index + 1}`, content, status: "completed" }));
  // `website-todo` is the row the workspace scene opens (see `mock/preview.ts`).
  const todo = tool("website-todo", "todo", { todos: todoItems }, { details: { todos: todoItems } });
  const createdAt = NOW - 26 * MINUTE;
  const threads = text.agents.map(([name, task], index) => ({
    id: `website-agent-${index + 1}`, name, avatarSeed: [17, 63, 88][index], task,
    conversationId: ACTIVE_ID, rootId: `website-agent-${index + 1}`, agent: index === 2 ? "worker" : "explorer",
    taskName: `website-agent-${index + 1}`, cwd: CWD, status: "completed" as const,
    createdAt, updatedAt: createdAt + 4 * MINUTE, currentTurn: 1, revision: 1,
  }));
  const spawns = threads.map((thread, index) => tool(`website-spawn-${index}`, "spawn_agent", { task_name: thread.taskName, message: thread.task }, { details: { thread } }));
  const wait = tool("website-wait", "wait_agent", { targets: threads.slice(0, 2).map((thread) => thread.id) }, { details: { threads: threads.slice(0, 2) } });
  const read = tool("website-read", "read", { path: P.events });
  const grep = tool("website-grep", "grep", { pattern: "requireRole|canReadCalendar", path: `${CWD}/server` });
  const list = tool("website-list", "ls", { path: `${CWD}/web/src/calendar` });
  const web = tool("website-web", "web_search", { query: "free busy calendar privacy busy-only visibility team scheduling" }, {
    details: { sources: text.sources.map(([title, url]) => ({ title, url })) },
  });
  const ask = tool("website-question", "question", { questions: [{ question: text.question }] }, {
    details: { questions: [{ question: text.question, answer: text.answer }] },
  });
  const writeAvail = tool("website-write-availability", "write", { path: P.availability, content: AVAILABILITY });
  const editPerm = tool("website-edit-permissions", "edit", { path: P.permissions }, { details: { diff, patch: diff } });
  const routesDiff = "@@ -40,3 +40,4 @@\n router.get(\"/teams/:id/events\", requireRole(\"member\"), listEvents);\n+router.get(\"/teams/:id/availability\", requireRole(\"member\"), availabilityHandler);\n";
  const editRoutes = tool("website-edit-routes", "edit", { path: P.routes }, { details: { diff: routesDiff, patch: routesDiff } });
  const writeWeek = tool("website-write-week", "write", { path: P.week, content: WEEK_VIEW });
  const writeDrag = tool("website-write-drag", "write", { path: P.drag, content: DRAG_HOOK });
  const testServer = tool("website-test-server", "bash", { command: "pnpm --filter server test calendar" }, { result: text.serverTest });
  const typecheck = tool("website-typecheck", "bash", { command: "pnpm typecheck" }, { result: "" });
  const testE2E = tool("website-test-e2e", "bash", { command: "pnpm --filter web exec playwright test team-calendar" }, { result: text.e2eTest });
  const nav = tool("website-browser-open", "browser_navigate", { url: "http://localhost:5173/teams/design/calendar?week=2026-W46" });
  const drag = tool("website-browser-drag", "browser_click", { text: text.eventTitle });
  const snap = tool("website-browser-snapshot", "browser_snapshot", {});
  const skill = tool("website-skill", "skill", { skill: "office" });
  const deck = tool("website-write-deck", "write", { path: deckPath });
  const commit = tool("website-commit", "bash", { command: "git add server/calendar web/src/calendar web/e2e docs/launch && git commit -m \"feat(calendar): add team free/busy calendar\"" }, {
    result: "[feat/team-calendar 3f9a2c1] feat(calendar): add team free/busy calendar\n 9 files changed, 412 insertions(+), 38 deletions(-)",
  });

  const step = (id: string, body: string, tools: ToolCallBlock[], at: number, thinking?: string): ChatMessage => ({
    id, role: "assistant", text: body, tools,
    parts: [
      ...(thinking ? [{ kind: "thinking" as const, text: thinking, startedAt: at, endedAt: at + 6_000 }] : []),
      { kind: "text" as const, text: body },
      ...tools.map((item) => ({ kind: "tool" as const, toolId: item.id })),
    ],
    createdAt: at,
    completedAt: at + MINUTE,
  });

  // One turn that shows the run end to end: it thinks, plans, delegates, researches,
  // asks, builds, verifies in a browser, makes a deck, then answers with a table.
  const messages: ChatMessage[] = [
    { id: "website-user", role: "user", text: text.user, tools: [], parts: [{ kind: "text", text: text.user }], createdAt: NOW - 27 * MINUTE },
    step("website-assistant-plan", text.plan, [todo, ...spawns, wait], NOW - 26.8 * MINUTE, text.thinking),
    step("website-assistant-research", text.research, [read, grep, list, web, ask], NOW - 22 * MINUTE),
    step("website-assistant-build", text.build, [writeAvail, editPerm, editRoutes, writeWeek, writeDrag], NOW - 18 * MINUTE),
    step("website-assistant-verify", text.verify, [testServer, typecheck, testE2E, nav, drag, snap], NOW - 12 * MINUTE),
    step("website-assistant-deck", text.deck, [skill, deck, commit], NOW - 7 * MINUTE),
    { id: "website-assistant-final", role: "assistant", text: text.finish, tools: [], parts: [{ kind: "text", text: text.finish }], createdAt: NOW - 5 * MINUTE, completedAt: NOW - 4.5 * MINUTE },
  ];

  const projects: Project[] = [
    { cwd: CWD, name: "Orbit", createdAt: NOW - 60 * DAY, updatedAt: NOW - 5 * MINUTE },
    { cwd: "/Users/demo/Code/paper-trail", name: "Paper Trail", createdAt: NOW - 90 * DAY, updatedAt: NOW - DAY },
    { cwd: "/Users/demo/Code/orbit-mobile", name: "Orbit Mobile", createdAt: NOW - 40 * DAY, updatedAt: NOW - 2 * DAY },
  ];
  const conversation = (id: string, [title, preview]: readonly [string, string], cwd: string, updatedAt: number, project = true): Conversation => ({
    id, title, cwd, ...(project ? { project: cwd } : {}), createdAt: updatedAt - DAY, updatedAt, preview, sessionId: `${id}-session`,
  });
  const conversations: Conversation[] = [
    ...text.conversations.map((entry, index) =>
      conversation(index === 0 ? ACTIVE_ID : `website-orbit-${index + 1}`, entry, CWD, index === 0 ? NOW - 5 * MINUTE : NOW - (index + 1) * DAY)),
    conversation("website-paper-1", text.paper, "/Users/demo/Code/paper-trail", NOW - DAY),
    conversation("website-mobile-1", text.mobile, "/Users/demo/Code/orbit-mobile", NOW - 2 * DAY),
    ...text.scratch.map((entry, index) => conversation(`website-scratch-${index + 1}`, entry, SCRATCH, NOW - (3 + index) * DAY, false)),
  ];

  const dir = (path: string, names: Array<[string, "file" | "directory"]>): DirEntry[] =>
    names.map(([name, kind]) => ({ name, path: `${path}/${name}`, kind }));
  const tree: Record<string, DirEntry[]> = {
    [CWD]: dir(CWD, [["docs", "directory"], ["server", "directory"], ["web", "directory"], ["package.json", "file"], ["pnpm-workspace.yaml", "file"], ["README.md", "file"]]),
    [`${CWD}/docs`]: dir(`${CWD}/docs`, [["launch", "directory"], ["architecture.md", "file"]]),
    [`${CWD}/docs/launch`]: dir(`${CWD}/docs/launch`, [[text.deckName, "file"]]),
    [`${CWD}/server`]: dir(`${CWD}/server`, [["auth", "directory"], ["calendar", "directory"], ["routes", "directory"], ["index.ts", "file"]]),
    [`${CWD}/server/calendar`]: dir(`${CWD}/server/calendar`, [["availability.test.ts", "file"], ["availability.ts", "file"], ["events.ts", "file"], ["permissions.test.ts", "file"], ["permissions.ts", "file"]]),
    [`${CWD}/web`]: dir(`${CWD}/web`, [["e2e", "directory"], ["src", "directory"], ["vite.config.ts", "file"]]),
    [`${CWD}/web/src`]: dir(`${CWD}/web/src`, [["calendar", "directory"], ["components", "directory"], ["App.tsx", "file"]]),
    [`${CWD}/web/src/calendar`]: dir(`${CWD}/web/src/calendar`, [["DayColumn.tsx", "file"], ["useDragReschedule.ts", "file"], ["useTeamAvailability.ts", "file"], ["WeekView.tsx", "file"]]),
  };

  const permissionsSource = diff
    .split("\n")
    .filter((line) => !/^(diff|index|---|\+\+\+|@@)/.test(line) && !line.startsWith("-"))
    .map((line) => line.replace(/^[ +]/, ""))
    .join("\n");
  const previewFor = (path: string): FilePreview => {
    const name = path.split("/").pop() ?? path;
    if (name.endsWith(".pptx")) return { kind: "office", path, name, format: "pptx", size: 2_480_000 };
    if (name === "README.md") return { kind: "markdown", path, name, text: text.readme };
    const source = name === "WeekView.tsx" ? WEEK_VIEW
      : name === "useDragReschedule.ts" ? DRAG_HOOK
        : name === "permissions.ts" ? permissionsSource
          : AVAILABILITY;
    return { kind: "code", path, name, language: name.endsWith(".tsx") ? "tsx" : "typescript", text: source };
  };

  const gitStatus: GitStatus = {
    cwd: CWD,
    isRepository: true,
    branch: "feat/team-calendar",
    changed: 9,
    staged: 0,
    additions: 412,
    deletions: 38,
    ahead: 1,
    behind: 0,
    files: [
      { path: "server/calendar/permissions.ts", index: " ", worktree: "M" },
      { path: "server/routes/calendar.ts", index: " ", worktree: "M" },
      { path: "server/calendar/availability.ts", index: "?", worktree: "?" },
      { path: "server/calendar/availability.test.ts", index: "?", worktree: "?" },
      { path: "server/calendar/permissions.test.ts", index: " ", worktree: "M" },
      { path: "web/src/calendar/WeekView.tsx", index: "?", worktree: "?" },
      { path: "web/src/calendar/useDragReschedule.ts", index: "?", worktree: "?" },
      { path: "web/e2e/team-calendar.spec.ts", index: "?", worktree: "?" },
      { path: `docs/launch/${text.deckName}`, index: "?", worktree: "?" },
    ],
  };

  const weekDiff = `diff --git a/web/src/calendar/WeekView.tsx b/web/src/calendar/WeekView.tsx
new file mode 100644
--- /dev/null
+++ b/web/src/calendar/WeekView.tsx
@@ -0,0 +1,26 @@
${WEEK_VIEW.trimEnd().split("\n").map((line) => `+${line}`).join("\n")}
`;

  return {
    language,
    cwd: CWD,
    activeId: ACTIVE_ID,
    projects,
    conversations,
    messages,
    session: {
      model: { provider: "fastvibe", id: "claude-fable-5-1" },
      thinkingLevel: "high",
      isStreaming: false,
      messageCount: messages.length,
      autoCompactionEnabled: true,
      contextUsage: { tokens: 64_210, contextWindow: 200_000, percent: 32 },
    },
    stats: {
      tokens: { input: 52_400, output: 8_920, cacheRead: 31_000, cacheWrite: 0, total: 92_320 },
      turn: { tokens: { input: 9_100, output: 1_240, cacheRead: 31_000, cacheWrite: 0, total: 41_340 }, modelMs: 48_000 },
      lastRequest: { outputTokens: 620, durationMs: 6_000 },
      cost: 0.86,
      toolCalls: 27,
      steps: 12,
      timing: { totalMs: 22 * MINUTE, modelMs: 9 * MINUTE, toolMs: 11 * MINUTE },
    },
    tree,
    previewPath: P.week,
    previewFor,
    gitStatus,
    gitDiff: (path?: string) => (path?.includes("WeekView") ? weekDiff : diff),
    reviewPath: "server/calendar/permissions.ts",
    deckPath,
  };
}
