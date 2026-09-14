# 右侧侧边面板：zcode 逆向分析与 FastVibe 改造方案

> 结论先行：zcode 右侧不是「文件预览抽屉」，而是一个**按 workspace 持久化的多标签工作台**（内部名 `sidePane`）。空着的时候居中画一张「打开标签页」卡片墙——辅助对话 / 审查 / 终端 / 浏览器；有内容时变成可拖拽排序的 tab 条 + 可拖宽度的面板。FastVibe 现在只有左侧会话栏，右侧仅在点开文件时临时挂一个 `PreviewPanel`，Git 是 Dialog、终端是系统终端——整个 `sidePane` 壳都还没做。

证据来源：`zcode.asar` 3.11.2（commit `89817f5b`，2026-09-04），主包 `styles-DyAcaLKy.js` + i18n `IntlProvider-Db46X9QF.js`。

---

## 0. 截图对上了什么

你贴的画面是 **tabs 为空时的空态**，不是缺页面。对应组件壳：

```
side-pane-open-tab-shell          ← container query 根
  h2  sidePane.openTab            「打开标签页」
  p   sidePane.openTabDescription 「选择要在侧边面板中打开的标签。」
  .side-pane-open-tab-list        ← 窄时竖排；宽 ≥ 480px 变卡片网格
    button[data-side-pane-open-tab-item]
```

宽面板（你截图那种）靠 CSS 容器查询，不是另写一套布局：

```css
.side-pane-open-tab-shell { container: side-pane-open-tab / inline-size; }
@container side-pane-open-tab (width >= 480px) {
  .side-pane-open-tab-content { max-width: 34rem; }
  .side-pane-open-tab-list {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(9rem, 1fr));
  }
  .side-pane-open-tab-button {
    flex-direction: column;
    justify-content: center;
    height: 5.5rem;
  }
}
```

窄时是 `h-12` 横条（图标 + 左对齐文字）；变宽后图标在上、文字居中，就是截图里的四张卡。

卡片清单由 `Pjt(...)` **按能力过滤**，不是写死四项：

| 条件 | 卡片 | tab `type` | i18n |
|---|---|---|---|
| 当前有任务（`canOpenSelectionSideConversation`） | 辅助对话 | `selection-side-chat` | `sidePane.selectionChat` |
| 还没有审查 tab（`!hasReviewTab`） | 审查 | `git` | `sidePane.review` |
| 始终 | 终端 | `terminal` | `terminal.title` |
| 支持内嵌浏览器（`supportsEmbeddedBrowser`） | 浏览器 | `browser` | `browser.title` |
| 有任务且 Wiki 已生成 | Wiki 引用 | `wiki-reference` | `wikiReference.panelTitle` |
| localStorage 打开开发者开关 | 开发者工具 | `developer-tools` | `developerTools.title` |

截图只有四张卡 = 有任务 + 无审查 tab + 支持浏览器 + 没 Wiki / 没开发者工具。审查卡在「已经打开过审查 tab」时会从空态里消失（避免再开一份，审查是单例）。

「+ 新增标签」下拉菜单用的是**同一份目录**，只是渲染成 `DropdownMenuItem`，`data-side-pane-add-item` 取值 `selection-side-conversation | terminal | browser | wiki-reference`。

---

## 1. 一句话诊断

| FastVibe 现状 | zcode 做法 | 定位 |
|---|---|---|
| 没有常驻右侧栏 | 可折叠 / 可拖宽的 `sidePane`，默认收起 | FastVibe `App.tsx` 只有 `Sidebar` + `main` + 条件 `PreviewPanel` |
| 点文件才弹出预览 | 预览只是 tab 之一（`code-viewer`） | `preview-panel.tsx` |
| Git 是 Dialog | Git 是侧栏 tab「审查」，左树右 diff | `git-status-dialog.tsx` |
| 终端 `openTerminal(cwd)` 调系统终端 | 侧栏可开多个 PTY tab；另有 `Cmd+J` 底栏终端 | `workspace.openTerminal` |
| 没有内嵌浏览器 | `browser` 人工浏览 + `browser-use` agent 浏览，挂起/恢复 residency | 无 |
| 没有辅助对话 | 主会话里划选 → 在右侧开子会话 | 无 |

---

## 2. 面板骨架

### 2.1 在窗口里占哪一块

桌面三栏：`左 sidebar | 中聊天 | 右 sidePane`。右侧用 **resizable panel**（react-resizable-panels 同类）：

```
desktop: collapsedSize 0px / defaultSize 0px / min 240px / max 65%
mobile:  不用 resize；右侧抽屉 overlay，`w-[min(88vw,28rem)]` 从右滑入
```

默认 `isSidePaneCollapsed: true`，所以第一次进工作区右侧是收起的。展开阈值：可见宽度 ≥ 96px 才当「真的可见」（媒体预览在 resize 过程中会延迟挂载，避免闪）。

顶栏有「切换面板」按钮（`sidePane.togglePanel`），快捷键：

| 键 | 动作 |
|---|---|
| `Cmd/Ctrl+B` | 左 sidebar |
| `Cmd/Ctrl+J` | 底栏终端（**不是**侧栏终端 tab） |
| `Ctrl+Alt+B` / `⌃⌥B` | 右侧 `sidePane` |
| Quick Pick | 添加浏览器 / 审查 / 终端标签、切换面板 |

i18n 还有 `sidePane.maximize` / `sidePane.restoreSize`（扩大面板 / 恢复宽度）——把右栏拉到接近上限，再缩回上次宽度。

### 2.2 状态机（按 workspace 一份）

内存 LRU Map，key = `workspaceIdentity || workspacePath`，最多 50 个工作区：

```ts
type WorkspaceSidePaneStore = {
  sidePaneState: { tabs: SidePaneTab[]; activeTabId: string } | null;
  isSidePaneCollapsed: boolean;
  sidePaneCollapsedByOwner: Record<string, boolean>; // 每个对话/任务自己的折叠
  activeGitSourceId: "unstaged" | "staged" | "branch" | "last-turn";
  browserUrls: Record<string, string>;
  browserUrl: string | null;
};

const empty: WorkspaceSidePaneStore = {
  sidePaneState: null,          // null = 空态卡片墙
  isSidePaneCollapsed: true,
  sidePaneCollapsedByOwner: {},
  activeGitSourceId: "unstaged",
  browserUrls: {},
  browserUrl: null,
};
```

折叠是 **owner 维度**的：切到另一个对话，右侧开合跟这个对话走，不跟 workspace 全局绑死。owner 缺省是 `__draft__`。

切对话时会跑一次 scope 同步：把不属于当前任务的 tab 藏起来 / 改 `activeTabId`，必要时自动收起。日志原文：`[App] 同步对话右侧面板 scope`。

核心 reducer（名字是打包后的，语义还原）：

| 函数 | 行为 |
|---|---|
| `Yu(state, tab)` | upsert：同 id 替换并激活，否则 append 并激活 |
| `sd(state, id)` | 关 tab；关光了返回 `null`（回到空态） |
| `cd(state, id)` | 只改 `activeTabId` |
| `Xu(state)` | 当前激活 tab |
| `Wu(state)` | hydrate 清洗：丢掉 `treemapping`；给缺 `ordinal` 的辅助对话补序号 |

### 2.3 有 tab 时的铬（chrome）

```
┌─────────────────────────────────────────────┐
│ [tab][tab][tab]  …scroll…  [+] [概览] [收起] │  h-12
├─────────────────────────────────────────────┤
│                                             │
│              当前 tab 内容                    │
│                                             │
└─────────────────────────────────────────────┘
```

Tab 条：

- 每个 tab：`flex-[1_1_9.75rem] h-7`，图标 + 标题，可拖拽排序（`@dnd-kit` strategy）。
- 超出宽度横向滚动；左右用 mask 渐隐；激活 tab 会 `scrollIntoView`。
- 中键关闭；右键：关闭 / 关闭其他 / 关闭所有。
- `[+]` 打开与空态相同的目录。
- 标签概览（`mjt`）：搜索「打开的标签页」+「最近关闭的标签页」，可 reopen。

标题规则（`I8`）：

| type | 标题 |
|---|---|
| `selection-side-chat` | `辅助对话 {ordinal}` |
| `git` | 审查 |
| `terminal` | `tab.title` 或「终端」 |
| `browser` / `browser-use` | 页面 title，否则「浏览器」 |
| `code-viewer` | 文件名 / `codeViewer.title` |
| `subagent-session` | 子智能体名 |
| `subagent-directory` | 子智能体目录 |
| `plan-detail` | Plan tab |
| `whiteboard` | 画板名 |
| `repo-wiki` | 仓库 Wiki |
| `wiki-reference` | Wiki 引用 |
| `model-trajectory` | 模型调用轨迹 |
| `developer-tools` | 开发者工具 |
| `treemapping` | Treemapping |

---

## 3. Tab 类型全表

分两层：**用户从空态 / + 菜单打开的**，和 **系统/agent 塞进来的**。

### 3.1 用户可打开（空态那四张卡 + 隐藏两项）

#### A. 辅助对话 `selection-side-chat`

主会话里划选消息（用户 / 助手 / 推理 / 工具结果）→ 「在辅助对话中提问」。限制：单条 8k 字、最多 8 条、合计 16k 字。

- id：`selection-side-chat:{workspace}:{parentSession}:{childSession}`
- 同一父会话下用 `ordinal` 1、2、3… 编号
- 开 tab 时走 `createSelectionSideSession({ firstInput })`，右侧是一套缩过的聊天（仍能 `onOpenCodeViewer` / `onOpenBrowserUrl` / `onOpenFileLink`）
- 切走父任务时这些 tab 被 scope 掉；关掉要调会话销毁，不是只藏 UI
- 有未处理权限请求时主会话会提示 `chat.selections.sideBlocked`

FastVibe：无。

#### B. 审查 `git`（单例，id 恒为 `"git"`）

不是 FastVibe 那个小 Dialog，是 **左文件树 + 右 Diff** 的审阅台。四个来源：

| id | 文案 | 读写 |
|---|---|---|
| `unstaged` | 未暂存 | 可 stage / discard |
| `staged` | 已暂存 | 可 unstage / commit |
| `branch` | 全部分支更改 | 只读，带 `comparisonLabel` |
| `last-turn` | 上一轮更改 | 只读；agent 本轮写入的 snapshot |

每个来源再按 section 分组：已暂存 / 未暂存 / 未跟踪 / 冲突 / 分支比较 / 上一轮。文件 kind：修改 / 新增 / 删除 / 重命名 / 冲突。

操作：刷新、暂存、取消暂存、丢弃、提交、推送、在文件树/访达中显示、筛选文件树。默认只展示 **当前 workspace 子树** 的改动，不是整个 git repo。

`last-turn` 特别值得抄：agent 写文件后侧栏可以直接审这一轮 diff，不必等用户 `git status`。

单例：空态在 `hasReviewTab` 为真时不再画「审查」卡；再点只是激活已有 tab。

FastVibe：`GitStatusDialog` 列表 + 一段 raw diff 文本，没有来源切换、没有树、没有 last-turn。

#### C. 终端 `terminal`

每次新建一个 tab：`id: terminal:{random}`，可带 `cwd` / `remoteSessionId`。内容是挂在 tab 上的 PTY（`sidePaneTerminalSessionRegistry`：hostEl 在切 tab 时 detach/attach，关 tab 才 `dispose`）。

注意 zcode 其实有 **两路终端**：

- `Cmd+J` / `isTerminalOpen`：底栏终端
- 侧栏 `terminal` tab：空态卡片「终端」、可多开

FastVibe：`workspace.openTerminal(cwd)` 打开系统终端，应用内没有 PTY。

#### D. 浏览器 `browser`

人工浏览。同一 owner 默认复用已有浏览器 tab；`forceNew` / 指定 `tabId` / `initialUrl` 才新开。字段：`faviconUrl`、`initialUrl`、`agentOpened`、`residency`。

地址栏 / 前进后退 / 刷新 / 外部打开 / DevTools / 自由尺寸视口（改宽高、缩放、适应窗口）。证书错误有「忽略证书校验」引导。

另有 `browser-use`：agent 驱动的浏览器，id `browser-use:{tabId}`，带 `sessionId`、截图 surface、挂起（`suspended` / `suspend-pending` / `restoring`）。非当前任务时后台挂载不展开面板（日志：`后台挂载 browser-use tab`）。

FastVibe：无。

### 3.2 系统打开（用户不会在空态看到）

这些不进 `Pjt` 目录，由聊天 / 工具 / 其它入口 `Yu` 进去，并 **展开** 侧栏。

#### E. 代码查看 `code-viewer` ← FastVibe `PreviewPanel` 的真身

id 按「工作区 + 类型 + 路径」去重，同一文件反复点只激活已有 tab。source 类型：

```
file | code-review | image | media | pdf | pptx | text | html | markdown | patch | multi-file-diff
```

能力远超 FastVibe 现在的预览：

- 文本：高亮、换行开关、markdown/svg 预览模式
- 行选 / gutter 评论（`code-review` 除外）→ 加到聊天
- `patch` / `multi-file-diff`：两边 diff 查看器
- 图片 / 音视频 / PDF（页码缩放）/ Office（docx / doc / xlsx 懒加载）/ PPTX（完整性校验，残缺数据拒绝解析）
- 「用已安装编辑器打开」、文件监视刷新
- 大文件 / 二进制 / 缺失路径都有独立文案（`codeViewer.*`）

FastVibe `PreviewPanel`：条件 aside，无 tab、无去重、无 Office/PPTX、无行选、无 diff viewer。点关闭就没了。

#### F. 其它

| type | 何时出现 | 要点 |
|---|---|---|
| `subagent-session` | 点聊天里的子智能体 | 右侧看子会话全文；可再开浏览器 / 文件 |
| `subagent-directory` | 一个父会话下多个子 agent | 运行中 / 已结束列表，点进去变成 `subagent-session` |
| `plan-detail` | ExitPlanMode / plan 工具 | 看计划 markdown，id 绑 `toolCallId` |
| `whiteboard` | 画板 | 笔/橡皮/颜色/粗细/撤销重做/清空，可「添加到对话区」 |
| `repo-wiki` | 生成仓库 Wiki | 左目录右文章，生成/停止/删/补失败页（单例） |
| `wiki-reference` | 把 Wiki 页/组引用进聊天 | 空态第五张卡；只读预览 + 回写引用 |
| `model-trajectory` | 调试模型调用 | 输入/输出 token，按 `taskId` |
| `developer-tools` | `localStorage['zcode:developer-tools:enabled']` | Token 调试 + 网络状态（单例） |
| `treemapping` | 文件活动热力 | **hydrate 时会被丢掉**（`Wu` filter），等于半废弃 |

单例集合：`git | repo-wiki | developer-tools | treemapping`。workspace 级的 tab（审查、Wiki）切任务还在；绑定 `ownerTaskId` / `parentSessionId` 的（辅助对话、browser-use、子智能体、plan）会跟对话走。

---

## 4. 打开 / 关闭 / 切任务 的规则

```
打开某 tab
  → Yu upsert
  → 设 activeTabId
  → isSidePaneCollapsed = false     // 「展开并激活」
  → 记到该 workspace 的 Map

agent 的 browser-use 且不属于当前任务
  → 仍 Yu 挂上
  → 不改 collapsed                 // 「后台挂载」

关闭当前 tab
  → 浏览器要先 browserViewCloseTab
  → 辅助对话要拆掉 child session
  → 终端 registry.release(id)
  → 推进 recentlyClosed
  → 若 tabs 空了：sidePaneState = null → 空态卡片墙
  → 若一个可见 tab 都没有：自动 collapsed

切对话
  → 按 owner 过滤可见 tab
  → 没有可见 tab 就收起
  → 恢复该 owner 上次的 collapsed
```

浏览器 tab 有 residency：看不见时 `suspended`，主进程里的 BrowserView 卸掉，回来再 `restoring`。所以侧栏可以堆很多浏览器而不把 Chromium 视图全挂在屏幕上。

---

## 5. FastVibe 对照

当前壳（`App.tsx`）：

```
┌──────────┬─────────────────────────────┬─────────────────┐
│ Sidebar  │ header + MessageList        │ PreviewPanel    │
│ 会话/项目 │ Composer                    │ （仅 preview 时）│
└──────────┴─────────────────────────────┴─────────────────┘
                 GitStatusDialog / 系统终端 / Settings 都是 overlay
```

zcode 壳：

```
┌──────────┬─────────────────────────────┬─────────────────┐
│ 左栏     │ 聊天                         │ sidePane        │
│          │                             │ 空态卡片 或 tabs │
└──────────┴─────────────────────────────┴─────────────────┘
                 底栏终端是第三条轴，和侧栏终端 tab 不是一回事
```

已有、能复用的：

- 左 `Sidebar`（会话列表）——留着，对标 zcode 左栏，不是右栏。
- `PreviewPanel` + `file-preview.ts` —— 应降级成 `code-viewer` tab 的一种 source，而不是「整个右栏」。
- `GitStatusDialog` 的 IPC（status / diff / stage / commit / push / pull / branches）——审查 tab 的数据层雏形，缺来源切换、文件树、last-turn snapshot。
- `workspace.openTerminal` —— 只是逃生舱；侧栏终端需要 in-app PTY。

完全没有的：`sidePane` 状态、tab 条、空态、resize、辅助对话、内嵌浏览器、Wiki/画板/轨迹。

---

## 6. 分阶段改造（建议）

目标不是一次把 zcode 十七种 tab 搬完。先把 **壳 + 截图那四张卡** 立住，预览和 Git 从「临时 overlay」迁进去。

### P0 — 壳（对上截图）

1. `App` 改成三栏：左 sidebar | 中聊天 | 右 `SidePane`。
2. 右栏默认收起；顶栏按钮 + `Ctrl+Alt+B` 切换；桌面 `min 240px / max 65%` 可拖。
3. `sidePaneState === null` 渲染空态：标题「打开标签页」+ 描述 + 卡片。容器查询 ≥480px 变网格，窄时横条。
4. 卡片先做四项，能力不够的 disable / 隐藏（没任务就没有辅助对话；没内嵌浏览器就没有浏览器）。
5. 有 tab 后换成 tab 条 + `[+]` + 关闭/关其它/关全部；关光回到空态。
6. 状态按 `project.cwd`（或 conversation id）存在 store / `localStorage`，折叠按会话分。

这一阶段右侧可以先是空白内容区，但空态必须和截图一致。

### P1 — 审查（把 Dialog 搬进 tab）

- 单例 `git` tab。
- 左：来源切换（先做 未暂存 / 已暂存；branch、last-turn 随后）。
- 右：选中文件的 diff（已有 `gitDiff` IPC）。
- 暂存 / 提交 / 推送走现有 IPC。
- 打开审查 = 展开侧栏；header 上的 git pill 改为 `open git tab` 而不是 Dialog。

### P2 — 代码查看（消化 `PreviewPanel`）

- 点聊天里的路径 / 工具卡片 → `code-viewer` tab，按 path 去重。
- 先迁移现有 kind：text / markdown / image / pdf / csv / html / diff。
- 关掉的是 tab，不是整个右栏。
- Office / PPTX / 行选评论放到更后。

### P3 — 终端 tab

- 侧栏多开 PTY（xterm + node-pty 或 electron utility process）。
- 保留「在系统终端打开」作后备。
- `Cmd+J` 底栏可以暂缓，避免两条终端轴同时做。

### P4 — 浏览器

- 人工 `browser` tab（Electron `WebContentsView` 嵌进右侧）。
- agent `browser-use` 等 Cowork / 浏览器工具真正落地再做 residency。

### P5 — 辅助对话

- 依赖主会话的划选模型和「子会话」生命周期（pi SDK 的 session fork / 并行 session）。
- 没有子会话 API 之前不要做空壳，否则卡片点了无处去。

Wiki / 画板 / 轨迹 / 开发者工具：产品需要再单开，不挡 P0–P2。

---

## 7. FastVibe 落地时注意

- **空态是一等公民**。右栏展开但没 tab ≠ 空白，必须是卡片墙。审查一旦打开，空态里就不要再出现「审查」。
- **右栏不是 PreviewPanel**。Preview 只是 tab。现在 `preview ? <PreviewPanel/> : null` 这条要废掉。
- **单例 vs 多开**：审查 / Wiki 单例；终端 / 浏览器 / 辅助对话 / 代码查看多开，代码查看按 path 去重。
- **scope**：切会话不要把别人的辅助对话、browser-use 露出来；审查可以留。
- **别把底栏终端和侧栏终端做成两个入口还不说明关系**。先只做侧栏 tab。
- **主题**：卡片用 `bg-surface` / `text-foreground-subtle` / `hover:bg-surface-hover`。FastVibe 没有 `--surface` 的话对到 `bg-muted` / `text-muted-foreground`，不要写死灰。
- **不要手写 shadcn 已有件**：tab 条的 `+` 用 Button + DropdownMenu；空态按钮用 Button；右栏用现有 Tooltip。

---

## 附录 A：还原后的 tab 工厂（节选）

```ts
git:        { id: "git", type: "git", openedAt }
terminal:   { id: `terminal:${uid}`, type: "terminal", title, cwd?, remoteSessionId? }
browser:    { id: tabId ?? `browser:${uid}`, type: "browser", ownerTaskId?, workspaceKey?,
              faviconUrl: null, initialUrl, agentOpened?, title: null }
side-chat:  { id: `selection-side-chat:${ws}:${parent}:${child}`, type: "selection-side-chat",
              ordinal, parentSessionId, childSessionId, workspaceKey, workspacePath }
code-viewer:{ id: `code-viewer:${sourceKey}`, type: "code-viewer", source, sourceKey }
wiki-ref:   { id: `wiki-reference:${ownerTaskId}`, type: "wiki-reference", ownerTaskId, workspaceKey }
dev-tools:  { id: "developer-tools", type: "developer-tools" }
repo-wiki:  { id: "repo-wiki", type: "repo-wiki" }
```

`sourceKey` 对文件类：`{workspace}:{kind}:{path}`；对 patch / multi-file-diff 再 hash 内容，避免两次不同 diff 撞 id。

## 附录 B：i18n 速查

```
sidePane.openTab                 打开标签页
sidePane.openTabDescription      选择要在侧边面板中打开的标签。
sidePane.selectionChat           辅助对话
sidePane.review                  审查
sidePane.addTab                  新增标签
sidePane.expand / collapse       展开侧边面板 / 收起侧边面板
sidePane.togglePanel             切换面板
sidePane.maximize                扩大面板
sidePane.restoreSize             恢复面板宽度
sidePane.tabOverview             搜索标签页
sidePane.searchTabs              搜索标签页...
sidePane.openTabs                打开的标签页
sidePane.recentlyClosedTabs      最近关闭的标签页
sidePane.closeTab                关闭 {title}
sidePane.closeCurrentTab         关闭标签
sidePane.closeOtherTabs          关闭其他标签
sidePane.closeAllTabs            关闭所有标签
sidePane.openFile*               从 workspace 搜文件并在侧栏打开
terminal.title                   终端
browser.title                    浏览器
codeViewer.title                 代码查看
git.source.unstaged/staged/...   未暂存 / 已暂存 / 全部分支更改 / 上一轮更改
wikiReference.panelTitle         Wiki 引用
developerTools.title             开发者工具
```
