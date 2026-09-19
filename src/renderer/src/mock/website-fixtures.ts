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
};

const NOW = Date.now();
const MINUTE = 60_000;
const DAY = 24 * 60 * MINUTE;
const CWD = "/Users/demo/Code/fieldnotes";
const ACTIVE_ID = "website-fieldnotes-search";
const SEARCH_PATH = `${CWD}/src/search/useQuickSearch.ts`;
const COMMAND_PATH = `${CWD}/src/components/CommandMenu.tsx`;
const TEST_PATH = `${CWD}/src/search/useQuickSearch.test.ts`;

const copy = {
  zh: {
    conversations: [
      ["快速搜索与键盘导航", "已加入模糊搜索、结果分组与 ⌘K 键盘导航。"],
      ["离线笔记同步", "梳理了断网编辑后的合并策略与冲突提示。"],
      ["移动端编辑器细节", "优化工具栏、图片上传和安全区间距。"],
      ["准备 1.4 发布说明", "整理本周完成项与升级注意事项。"],
    ],
    scratch: ["设计每周回顾模板", "把散落的笔记整理成一份轻量回顾模板。"],
    user: "为 Fieldnotes 加一个快速搜索：支持标题和正文的模糊匹配，用 ⌘K 打开，方向键选择，回车跳转。请保持现有视觉风格，并补测试。",
    intro: "我先检查现有命令菜单、笔记索引和键盘事件的处理方式。",
    finding: "结构很清晰：搜索索引已经在内存中，命令菜单也有可复用的焦点管理。我会把匹配逻辑做成独立 hook，再接入快捷键。",
    finish: "已完成快速搜索：\n\n- `⌘K` 打开搜索，标题与正文支持容错匹配\n- 结果按「最近编辑 / 其他笔记」分组，方向键与回车完整可用\n- 新增 8 个测试，覆盖空查询、排序和键盘边界\n\n`pnpm test` 与类型检查均已通过。",
    todos: ["梳理搜索与命令菜单", "实现模糊匹配和结果排序", "接入键盘导航", "补充测试并验证"],
    readme: "# Fieldnotes\n\n一个安静、离线优先的笔记应用。\n\n- 快速搜索\n- Markdown 编辑\n- 本地优先同步\n",
    testResult: "✓ 8 tests passed\n✓ TypeScript check passed",
  },
  en: {
    conversations: [
      ["Quick search and keyboard navigation", "Added fuzzy search, grouped results, and ⌘K navigation."],
      ["Offline note sync", "Outlined merge behavior and conflict prompts for offline edits."],
      ["Mobile editor polish", "Refined the toolbar, image uploads, and safe-area spacing."],
      ["Prepare the 1.4 release notes", "Collected this week’s changes and upgrade notes."],
    ],
    scratch: ["Design a weekly review template", "Turn scattered notes into a lightweight weekly review."],
    user: "Add Fieldnotes quick search: fuzzy-match titles and note text, open with ⌘K, use arrow keys, and jump with Enter. Keep the style and add tests.",
    intro: "I’ll trace the existing command menu, note index, and keyboard handling first.",
    finding: "The structure is clean: the note index is already in memory, and the command menu has reusable focus management. I’ll keep matching in a small hook, then wire in the shortcut.",
    finish: "Quick search is ready:\n\n- `⌘K` opens search with typo-tolerant title and content matching\n- Results are grouped into “Recently edited” and “Other notes”\n- Arrow keys and Enter work end to end\n- 8 tests cover empty queries, ranking, and keyboard boundaries\n\n`pnpm test` and the TypeScript check both pass.",
    todos: ["Trace search and command menu", "Build fuzzy matching and ranking", "Wire keyboard navigation", "Add tests and verify"],
    readme: "# Fieldnotes\n\nA calm, offline-first place for notes.\n\n- Quick search\n- Markdown editing\n- Local-first sync\n",
    testResult: "✓ 8 tests passed\n✓ TypeScript check passed",
  },
} as const;

function searchCode(language: WebsiteLanguage): string {
  const placeholder = language === "zh" ? "搜索标题和正文…" : "Search titles and note content…";
  const recent = language === "zh" ? "最近编辑" : "Recently edited";
  return `import { useMemo } from "react";
import { scoreMatch } from "./scoreMatch";
import type { Note } from "../notes/types";

export const SEARCH_PLACEHOLDER = "${placeholder}";
export const RECENT_GROUP_LABEL = "${recent}";

export function useQuickSearch(notes: Note[], query: string) {
  return useMemo(() => {
    const needle = query.trim();
    if (!needle) return [];

    return notes
      .map((note) => ({ note, score: scoreMatch(needle, note.title, note.body) }))
      .filter((result) => result.score > 0)
      .sort((a, b) => b.score - a.score || b.note.updatedAt - a.note.updatedAt)
      .slice(0, 20);
  }, [notes, query]);
}
`;
}

function diffFor(language: WebsiteLanguage): string {
  const placeholder = language === "zh" ? "搜索标题和正文…" : "Search titles and note content…";
  return `diff --git a/src/components/CommandMenu.tsx b/src/components/CommandMenu.tsx
index 28cb541..b84f122 100644
--- a/src/components/CommandMenu.tsx
+++ b/src/components/CommandMenu.tsx
@@ -18,11 +18,17 @@ export function CommandMenu({ notes, onOpen }: Props) {
   const [query, setQuery] = useState("");
+  const results = useQuickSearch(notes, query);
+  const active = useKeyboardSelection(results.length);
 
   useShortcut("mod+k", () => setOpen(true));
 
   return (
     <CommandDialog open={open} onOpenChange={setOpen}>
-      <CommandInput placeholder="Search notes…" value={query} onValueChange={setQuery} />
-      <RecentNotes notes={notes} onOpen={onOpen} />
+      <CommandInput
+        autoFocus
+        placeholder="${placeholder}"
+        value={query}
+        onValueChange={setQuery}
+      />
+      <SearchResults results={results} active={active} onOpen={onOpen} />
     </CommandDialog>
   );
 }
`;
}

function makeTool(id: string, name: string, args: Record<string, unknown>, extra: Partial<ToolCallBlock> = {}): ToolCallBlock {
  return { id, name, args, status: "done", ...extra };
}

export function websiteFixture(language: WebsiteLanguage): WebsiteFixture {
  const text = copy[language];
  const todoItems = text.todos.map((content, index) => ({ id: `task-${index + 1}`, content, status: "completed" }));
  const todo = makeTool("website-todo", "todo", { todos: todoItems }, { details: { todos: todoItems } });
  const read = makeTool("website-read", "read", { path: COMMAND_PATH });
  const search = makeTool("website-grep", "grep", { pattern: "CommandDialog|useShortcut", path: `${CWD}/src` });
  const edit = makeTool("website-edit", "edit", { path: COMMAND_PATH }, { details: { diff: diffFor(language), patch: diffFor(language) } });
  const test = makeTool("website-test", "bash", { command: "pnpm test && pnpm typecheck" }, { result: text.testResult });

  const messages: ChatMessage[] = [
    {
      id: "website-user",
      role: "user",
      text: text.user,
      tools: [],
      parts: [{ kind: "text", text: text.user }],
      createdAt: NOW - 12 * MINUTE,
    },
    {
      id: "website-assistant-explore",
      role: "assistant",
      text: text.intro,
      tools: [todo, read, search],
      parts: [
        { kind: "text", text: text.intro },
        { kind: "tool", toolId: todo.id },
        { kind: "tool", toolId: read.id },
        { kind: "tool", toolId: search.id },
      ],
      createdAt: NOW - 11.5 * MINUTE,
      completedAt: NOW - 10.8 * MINUTE,
    },
    {
      id: "website-assistant-build",
      role: "assistant",
      text: text.finding,
      tools: [edit, test],
      parts: [
        { kind: "text", text: text.finding },
        { kind: "tool", toolId: edit.id },
        { kind: "tool", toolId: test.id },
      ],
      createdAt: NOW - 10.7 * MINUTE,
      completedAt: NOW - 9.5 * MINUTE,
    },
    {
      id: "website-assistant-final",
      role: "assistant",
      text: text.finish,
      tools: [],
      parts: [{ kind: "text", text: text.finish }],
      createdAt: NOW - 9.4 * MINUTE,
      completedAt: NOW - 9 * MINUTE,
    },
  ];

  const projects: Project[] = [
    { cwd: CWD, name: "Fieldnotes", createdAt: NOW - 45 * DAY, updatedAt: NOW - 9 * MINUTE },
    { cwd: "/Users/demo/Code/luma-calendar", name: "Luma Calendar", createdAt: NOW - 80 * DAY, updatedAt: NOW - 3 * DAY },
  ];

  const conversations: Conversation[] = [
    ...text.conversations.map(([title, preview], index) => ({
      id: index === 0 ? ACTIVE_ID : `website-fieldnotes-${index + 1}`,
      title,
      cwd: CWD,
      project: CWD,
      createdAt: NOW - (index + 1) * DAY,
      updatedAt: index === 0 ? NOW - 9 * MINUTE : NOW - (index + 1) * DAY,
      preview,
      sessionId: `website-session-${index + 1}`,
    })),
    {
      id: "website-scratch",
      title: text.scratch[0],
      cwd: "/Users/demo/Library/Application Support/FastVibe/scratch",
      createdAt: NOW - 6 * DAY,
      updatedAt: NOW - 6 * DAY,
      preview: text.scratch[1],
      sessionId: "website-session-scratch",
    },
  ];

  const tree: Record<string, DirEntry[]> = {
    [CWD]: [
      { name: "public", path: `${CWD}/public`, kind: "directory" },
      { name: "src", path: `${CWD}/src`, kind: "directory" },
      { name: "package.json", path: `${CWD}/package.json`, kind: "file" },
      { name: "README.md", path: `${CWD}/README.md`, kind: "file" },
      { name: "vite.config.ts", path: `${CWD}/vite.config.ts`, kind: "file" },
    ],
    [`${CWD}/src`]: [
      { name: "components", path: `${CWD}/src/components`, kind: "directory" },
      { name: "notes", path: `${CWD}/src/notes`, kind: "directory" },
      { name: "search", path: `${CWD}/src/search`, kind: "directory" },
      { name: "App.tsx", path: `${CWD}/src/App.tsx`, kind: "file" },
    ],
    [`${CWD}/src/components`]: [
      { name: "CommandMenu.tsx", path: COMMAND_PATH, kind: "file" },
      { name: "Editor.tsx", path: `${CWD}/src/components/Editor.tsx`, kind: "file" },
      { name: "NoteList.tsx", path: `${CWD}/src/components/NoteList.tsx`, kind: "file" },
    ],
    [`${CWD}/src/search`]: [
      { name: "scoreMatch.ts", path: `${CWD}/src/search/scoreMatch.ts`, kind: "file" },
      { name: "useQuickSearch.test.ts", path: TEST_PATH, kind: "file" },
      { name: "useQuickSearch.ts", path: SEARCH_PATH, kind: "file" },
    ],
  };

  const previewFor = (path: string): FilePreview => {
    const name = path.split("/").pop() ?? path;
    if (name === "README.md") return { kind: "markdown", path, name, text: text.readme };
    return {
      kind: "code",
      path,
      name,
      language: name.endsWith(".tsx") ? "tsx" : "typescript",
      text: name === "useQuickSearch.ts" ? searchCode(language) : diffFor(language).split("\n").filter((line) => !/^(diff|index|---|\+\+\+|@@)/.test(line)).map((line) => line.replace(/^[ +-]/, "")).join("\n"),
    };
  };

  const gitStatus: GitStatus = {
    cwd: CWD,
    isRepository: true,
    branch: "feat/quick-search",
    changed: 3,
    staged: 0,
    additions: 86,
    deletions: 12,
    ahead: 1,
    behind: 0,
    files: [
      { path: "src/components/CommandMenu.tsx", index: " ", worktree: "M" },
      { path: "src/search/useQuickSearch.ts", index: "?", worktree: "?" },
      { path: "src/search/useQuickSearch.test.ts", index: "?", worktree: "?" },
    ],
  };

  return {
    language,
    cwd: CWD,
    activeId: ACTIVE_ID,
    projects,
    conversations,
    messages,
    session: {
      model: { provider: "fastvibe", id: "claude-sonnet-4-5" },
      thinkingLevel: "high",
      isStreaming: false,
      messageCount: messages.length,
      autoCompactionEnabled: true,
      contextUsage: { tokens: 18_420, contextWindow: 200_000, percent: 9 },
    },
    stats: {
      tokens: { input: 14_820, output: 1_940, cacheRead: 6_200, cacheWrite: 0, total: 22_960 },
      cost: 0.12,
      toolCalls: 5,
      steps: 2,
      timing: { totalMs: 42_000, modelMs: 25_000, toolMs: 12_000 },
    },
    tree,
    previewPath: SEARCH_PATH,
    previewFor,
    gitStatus,
    gitDiff: () => diffFor(language),
  };
}
