# FastVibe 作为智能体客户端：重要缺口盘点

盘点日期：2026-09-17。代码基线：`0.5.0`（`1419009`）。本文只做静态核查，未运行应用或插件。

方法：逐条读源码取证，每条结论都附文件与行号。**「已具备」一节是为了避免重复开发**——
下面列出的东西不是从零开始，缺的是补齐、收敛和边界。

---

## 1. 已经做好的（不要再列进 backlog）

| 能力 | 位置 |
| --- | --- |
| 内嵌引擎、多会话、流式事件 | `src/main/pi/process-manager.ts` |
| 工具卡片 / diff / 思考块 / 折叠运行过程 | `src/renderer/src/components/chat/` |
| 文件树 + 预览、终端、Git 审查、浏览器 use、辅助对话 | `src/renderer/src/components/layout/side-pane-*.tsx` |
| 三档权限沙箱 + 内联批准面板 | `resources/extensions/permission-sandbox.ts` |
| plan / goal / todo / subagent / browser / web-search 内置扩展 | `resources/extensions/` |
| zh/en i18n、20 套主题、字号缩放 | `src/renderer/src/lib/themes.ts`、`lib/i18n.ts` |
| 供应商配置（含 OAuth 订阅登录）、models.dev 元数据、价格 | `src/main/engine/` |
| 从 pi / Claude Code / Codex / opencode 导入会话 | `src/main/engine/import/` |
| 使用统计 + ledger、自动更新 | `usage-stats.ts`、`updater.ts` |

---

## 2. P0：正确性与数据安全

这些不是「还缺一个功能」，而是**现在就可能算错、丢数据或卡住**。

### 2.1 多窗口共用一个引擎，「当前会话」是全局的

**证据**

- `process-manager.ts:321` `#activeId: string | null = null` 是引擎级单例；
  `:514` `prompt()` 走 `await this.#active()`；`#activate()`（`:2121`）写的就是它。
- `src/main/index.ts:656` `windowNew` 直接 `createWindow()`，新窗口与旧窗口共用同一个
  `engine` 实例、同一个 `#activeId`。
- 但 `engine:prompt` 的 IPC 不带会话 id（`index.ts:188-200`），渲染层发送时也不带
  （`App.tsx:1024`）。
- 每个窗口有自己的路由态 `activeId`（renderer store），`conversations.open` 会
  `#activate()` 并把引擎的 `#activeId` 改掉（`:831-842`）。

**后果**：窗口 A 打开会话 1，窗口 B 打开会话 2，此时在窗口 A 输入框里发消息，
**消息会落到会话 2**。反过来也一样。`engine:abort`、`engine:steer`、`engine:get-state`
全部同理。

新窗口甚至开局就选错：`App.tsx:332` 用 `conversationIdFromHash() ?? snapshot.activeId`，
后者是**引擎的全局 activeId**，所以第二个窗口一打开就落回第一个窗口的会话，
而不是自己记住的那个。

**建议**：所有会话级 IPC 都显式带 `conversationId`，引擎按 id 取 session；`#activeId`
降级为「默认会话」提示而不是唯一寻址手段。这是 `enginePromptConversation` /
`engineGetConversationMessages` 已经走过的路子（`index.ts:606-614`），把它推广到全部
引擎通道即可，不需要新架构。

### 2.2 停止会话 A 会「拒绝」后台会话 B 的待批准请求

**证据**

- `#pendingUi` 是全局 Map，条目里存了 `conversationId` 却**从未被读**：
  `process-manager.ts:333`。
- `abort()` 无参数（`index.ts:218-220`），第一步就调 `#resolvePendingUi()`
  （`:608-614`），而它是**无条件清空全部**：`:2114-2119`
  用 fallback 结算每一条 —— `confirm` 的 fallback 是 `false`（`:2063`）。

**后果**：会话 A 里点了停止，会话 B（后台正在跑）排队等用户批准的那个
`ctx.ui.confirm` 会被立刻以「用户拒绝」结算，B 的工具被 block。用户从没看见那条提问。

**建议**：`abort(conversationId?)` 与 `#resolvePendingUi(conversationId?)` 都接受作用
域，只结算该会话的条目；`stop()`（应用退出）保留清空全部。

### 2.3 一个会话只能挂一条待答请求，且后到覆盖先到

**证据**

- renderer：`session.ts:61` `pendingPermissions: Record<string, PermissionRequest>` ——
  **每会话一条**；`:373` 新请求直接覆盖同键旧值。
- 子代理复用父会话的 UI 上下文：`process-manager.ts:1890+` 里
  `bindExtensions({ uiContext: this.#extensionUi(conversationId) })`，`conversationId` 是
  **父会话**。并行子代理（`subagent` 扩展支持最多 8 路）同时触发 `bash` 审批时，
  它们的 `confirm` 都带同一个 `conversationId`。

**后果**：8 路里只有最后一条能显示，其余 7 条的 promise 永远悬着（对应工具挂起），
用户批准的是「碰巧排在最后」的那条。

**建议**：`pendingPermissions` 改成 `Record<string, PermissionRequest[]>` + 一个游标，
面板显示「1/3」；`#resolvePendingUi` 按会话清理；`respondPermission` 已经是按 id 幂等
的（`:809-812`），不用改。

### 2.4 后台会话要人批准时没有任何信号

**证据**

- 侧栏只画「运行中」：`sidebar.tsx:838` 只传 `running[item.id]`，`:464` 只渲染
  `RunningMark`；没有「等待你输入 / 等你批准」的第二种状态。
- 系统通知只在**完成**时发：`index.ts:755-756` 判断 `conversation_activity`。
  权限请求不走 `conversation_activity`（`process-manager.ts:1530` 只在
  `agent_settled` 发）。
- 权限请求本身**没有超时**：`permission-sandbox.ts:270` 调
  `ctx.ui.confirm(...)` 不传 `opts.timeout`，`process-manager.ts:2063` 于是永远不
  `resolve`。

**后果**：用户在会话 A 干活，会话 B 在后台卡在审批上；不切回 B 就永远不会知道，
切走再切回来之前也没有任何提示，而且它会一直卡着。

**建议**（三件小事，收益很大）：
1. 侧栏为「有待答请求的会话」加第二个标记（与 `running` 并列的一个 map）。
2. `extension_ui_request`（method 属于阻塞类）且窗口未聚焦时发一条系统通知。
3. 给权限确认一个默认超时（比如 5 分钟），超时以「未批准」结算并明确告知，
   或至少在面板上显示已等待多久。

### 2.5 没有测试，也没有 Error Boundary

**证据**

- `package.json` 无 `test` 脚本；`find` 找不到任何 `*.test.ts` / `*.spec.ts`。
- 渲染层全树没有 `ErrorBoundary` / `componentDidCatch`；主进程只在
  `logger.ts:179` 记了 `render-process-gone`。

**后果**：AGENTS.md 自己记着的那个事故——composer 模型菜单在无模型时抛
`MenuGroupContext is missing`，**整棵树卸载**——正是这一缺口的产物：一次渲染期异常
（typecheck 抓不到）就能把应用变成白屏，且没有任何恢复路径。而这类回归现在完全靠人眼。

**建议**：最低限度加一个顶层 Error Boundary（显示错误 + 「重新加载界面」），
再加上 `node:test` 跑主进程纯函数（`process-manager` 的映射、`usage-stats` 的计价、
`import/writer` 的 v3 契约、`diff.ts`/`todos.ts`）。ROADMAP 里已经写了 fixture 方案，
但一直没落地——这是第一阶段最大的一块欠账。

---

## 3. P1：体验闭环（用起来会疼的地方）

### 3.1 无法停止后台会话

侧栏没有任何「停止」入口，`engine:abort` 只能停当前会话（`index.ts:218-220`）。
一个跑飞的 `/goal` 会话只能切过去再停。可以和 2.4 的标记一起做：悬停时的停止按钮。

### 3.2 重试/编辑只回退对话，不回退文件

`App.tsx:995` 附近的重试走 `engine.abort()` + `branch(entryId)`；`navigateTree` 只
改会话树（`process-manager.ts:1392`）。**工作区文件停在原地**，于是「重试这一轮」
经常在一个已经被这一轮改过的代码上跑，得到与上一轮不同的结果。这是 agent 客户端里
最经典的坑，也是 pi 插件生态里 `pi-rewind` / checkpoint 类需求存在的原因。

最小可行版：每轮开始时对 `cwd` 做一次轻量快照（git stash 式，或在有 git 的仓库里记
`HEAD` + 脏文件列表），重试时提示「要不要一并回退文件改动」。

### 3.3 上下文用量看不到「快满了」的预警

`session.contextUsage` 只在状态回包里（`turn_end` 刷新），但界面只有一个环，
没有「距离自动压缩还有多少」的显式提示，也没有手动压缩入口以外的动作。长任务里
用户意识不到即将 compaction、以及 compaction 会丢什么。

### 3.4 会话内查找缺失

命令面板（`command-palette.tsx`）能搜**会话**内容并给出 snippet，但点击只是打开会话，
没有跳到那一条消息（`hits` 的 snippet 仅用于展示，`:126`、`:198-200`）。
会话内部（当前线程）没有 `Cmd+F`，快捷键表里也没有 `find`
（`lib/shortcuts.ts` 的 17 项中没有）。

对于动辄几百轮的转录，这是高频操作。

### 3.5 终端/文件/Git 与「本次改动」没有合流

每轮消息底部有 `TurnFileChips`（`message-list.tsx:495`），Git 面板能看 diff，
但两者没有连起来：从「这一轮改了这 3 个文件」点到具体 diff 需要自己去 Git 面板找。
Code 场景的核心诉求是「**验收这次改动**」，这里差一步。

### 3.6 权限「始终允许」不跨会话、不跨重启

`permissionAlways` 是 renderer store 里的一个数组（`session.ts:524`），不持久化
（store 没有 persist）。同一个 bash 模式换个会话就要再批一次；重启后全部清零。
「始终允许」名不副实。

### 3.7 设置不跨窗口同步

`settings:set` 写盘 + 应用副作用（`index.ts:682-692`），但**没有广播**给其他窗口；
其他窗口只在启动时 `settings:get` 一次（preload `initial`）。两个窗口改同一个设置会
互相覆盖，主题/字号也会不一致。

### 3.8 通知没有开关，且文案写死

`index.ts:756` 的正文是硬编码 `uiText("任务已完成…")`，没有设置项，
也没有「只在未聚焦时通知」以外的粒度（虽然已判断聚焦）。桌面客户端的通知策略
应该可配（完成 / 需要批准 / 关闭）。

---

## 4. P2：能力广度（竞品有、目前没有）

按「投入产出」排序，不做成必须项。

| 能力 | 现状 | 说明 |
| --- | --- | --- |
| **MCP 只有 tools** | `mcp-manager.ts` 只调 `listTools` / `callTool` | 没有 `listPrompts` / `listResources`，也没有 HTTP 认证头（`McpServerConfig` 只有 `env`/`url`，`:298-307`）。带鉴权的远端 MCP 直接接不上，这是实际接入时最先撞到的墙。 |
| **成果工作台** | 文件预览存在，但没有「本次产物列表」 | ROADMAP 的 P1-1。Office 闭环（生成→预览→圈选反馈→再生成→导出）还不成立。 |
| **持久化定时任务** | 无 | `/goal` 是回合循环，不是调度器。 |
| **会话树 / 分支可视化** | `navigateTree` 支持分支，但没有树 UI | 只能「编辑/重试最新一轮」，看不到分叉也无法在分叉间跳。 |
| **助手/项目预设** | 无 | 模型+提示词+技能+插件+MCP+权限的组合无法保存复用。 |
| **预算与限额** | 无 | 有成本统计，但没有「这一轮/这个会话最多花 $X」的硬闸。长任务容易失控。 |
| **使用统计导出** | 无 csv/json 导出 | 只有面板展示。 |
| **`ctx.ui.custom()`** | 直接抛错（`process-manager.ts:2092`） | README 已公开声明不支持。ROADMAP P0-3 的通用 TUI 宿主仍未做，这决定了「任意插件即插即用」能不能兑现。 |
| **entry / markdown transformer / autocomplete / setEditorComponent / theme** | 全为空实现（`process-manager.ts:2070-2076`、`:2098-2100`） | 同上，属于「插件兼容面」的欠账。 |
| **扩展 fork** | 固定 `{ cancelled: true }`（`:1391`） | 同上。 |
| **全局快捷键 / 托盘** | 无 `globalShortcut`、无 `Tray` | 「后台任务跑完提醒我」在窗口全关时失效（`window-all-closed` 直接 quit，非 mac 平台）。 |
| **插件进程隔离** | 扩展跑在 Electron 主进程里（jiti 加载，无 `utilityProcess`） | ROADMAP 已标为发布前评估项：一个死循环插件会冻结整个应用。 |

---

## 5. 本轮完成的任务

1. 取证式盘点：逐条读 `process-manager.ts`（2412 行）、`index.ts`、renderer store、
   `mcp-manager.ts`、内置扩展与 IPC 通道表，确认每个结论的文件与行号。
2. 与 `docs/roadmap-2026-09-16.md` 对照，区分「ROADMAP 已写但未做」与「ROADMAP 未覆盖
   的新发现」。**2.1 / 2.2 / 2.3 / 2.4 是本次新发现的四条 P0**，路线图里没有。
3. 产出本文。

**结论：目标（列出重要缺口）已达成，但产品本身远未完成。**

---

## 6. 建议的下一步顺序

1. **会话作用域收口**（2.1 + 2.2 + 2.3）——三者是同一根因的三个面：引擎的会话身份
   没有贯穿到 IPC 与待答请求。改完再谈插件兼容才有意义，否则每加一个插件都放大它。
2. **待答请求可见性**（2.4 + 3.1 + 3.6）——「后台在等我」必须看得见、能停止、
   「始终允许」要真的记住。
3. **顶层 Error Boundary + 第一批纯函数测试**（2.5）——这是唯一能防止已有功能
   随改动静默崩塌的手段。
4. 再回到 ROADMAP 的 M1（通用 TUI 桥接）与 M4（成果闭环）。
