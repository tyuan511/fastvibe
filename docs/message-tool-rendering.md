# 消息与工具展示：zcode 逆向分析与 FastVibe 改造方案

> 结论先行：FastVibe 现在"工具全堆在最前面 + 显示 `tool tool`"不是样式问题，是**数据模型丢了顺序、流式事件读错了字段**。zcode 的做法是——保留引擎返回的**有序 content parts**、按 **verb + object** 的句子渲染每个工具、把连续的同类工具**折叠成组**、每组再给**分类详情渲染器**。下面给出证据、差距和分阶段改造方案。

---

## 0. 一句话诊断

| 现象 | 真实原因 | 定位 |
|---|---|---|
| 工具全部堆在消息最前面，正文在后 | `ChatMessage` 被扁平化成 `{text, thinking, tools[]}`，**丢失了引擎 content 数组的顺序**；渲染时又硬编码"工具 → 正文" | `src/shared/types.ts:82`、`src/renderer/src/components/chat/message-list.tsx:201` |
| 工具显示成 `tool tool`（标签和摘要都是 "tool"） | 流式 `toolcall_start` 事件**不携带** `id`/`name`，FastVibe 却去读 `inner.id`/`inner.name`，落到 `"tool"` 兜底；真正的名字在 `inner.partial.content[inner.contentIndex]` | `src/renderer/src/lib/apply-engine-event.ts:239`、`tool-card.tsx:50,103` |
| 每个工具一行原始 JSON，读不下去 | 没有"动词化摘要"，没有分类详情渲染器，没有分组 | `tool-card.tsx:97-174` |

---

## 1. FastVibe 现状：问题出在哪一层

### 1.1 数据模型丢顺序（核心）

引擎（`@mariozechner/pi-ai`）返回的是**有序内容数组**：

```ts
// pi-ai/dist/types.d.ts:146
export interface AssistantMessage {
  role: "assistant";
  content: (TextContent | ThinkingContent | ToolCall)[];  // ← 顺序即真实发生顺序
}
// types.d.ts:117
export interface ToolCall { type: "toolCall"; id: string; name: string; arguments: Record<string, any>; }
```

一次典型的 turn 是 `[thinking, toolCall, text, toolCall, toolCall, text]`。

但 FastVibe 把它拍平了：

```ts
// src/shared/types.ts:82
export type ChatMessage = {
  id: string;
  role: "user" | "assistant" | "system";
  text: string;               // ← 所有 text 分片拼成一个字符串
  thinking?: string;          // ← 所有 thinking 拼成一个字符串
  tools: ToolCallBlock[];     // ← 所有工具按出现次序堆成一个数组
  ...
};
```

顺序信息在校验层就被丢弃（`src/main/engine/map-messages.ts:46` 的 `extractContent` 把 content 分类累加，不保留 index）。

### 1.2 渲染层再固化一次错误顺序

```tsx
// src/renderer/src/components/chat/message-list.tsx:197-218（节选）
{message.thinking && showThinking ? <ThinkingBlock .../> : null}
{message.tools.length > 0 ? (
  <div className="flex w-full max-w-2xl flex-col gap-1">
    {message.tools.map((tool) => <ToolCard key={tool.id} tool={tool} />)}
  </div>
) : null}
{message.text ? <Bubble ...>{message.text}</Bubble> : null}
```

即使模型是"工具 A → 说一句 → 工具 B → 总结"，界面也永远渲染成"工具 A、工具 B → 说一句、总结"。这就是你看到的"全部堆在最前面"。

### 1.3 流式事件读错字段

pi-ai 的流式事件定义（`pi-ai/dist/types.d.ts:219-231`）：

```ts
| { type: "toolcall_start"; contentIndex: number; partial: AssistantMessage }   // 没有 id/name！
| { type: "toolcall_delta"; contentIndex: number; delta: string; partial: AssistantMessage }
| { type: "toolcall_end";   contentIndex: number; toolCall: ToolCall; partial: AssistantMessage }  // 名字在这里
```

`toolcall_start` 的载荷只有 `contentIndex` + `partial`。FastVibe 却这么读：

```ts
// src/renderer/src/lib/apply-engine-event.ts:239-248
if (innerType === "toolcall_start" || innerType === "tool_call_start") {
  const target = ensureAssistant();
  upsertTool(target, {
    id: asString(inner.id) ?? crypto.randomUUID(),        // ← inner.id 不存在
    name: asString(inner.name) ?? "tool",                 // ← inner.name 不存在 → "tool"
    ...
  });
}
```

因为 `inner.name` 永远是 `undefined`，所有工具名都成了 `"tool"`。随后 `toolcard` 的 `toolMeta()` 匹配不到 `bash/read/grep...` 任何关键字，落到兜底分支：

```ts
// src/renderer/src/components/chat/tool-card.tsx:50
return { label: name, icon: <Wrench className="size-3.5" /> };   // label = "tool"
// :103
const summary = argString(tool.args, [...]) || tool.name;        // summary = "tool"
```

于是渲染出 `🔧 tool tool`。

> 补充：正确取值方式是 `inner.partial.content[inner.contentIndex]`。pi-ai 在 `toolcall_start` 时**已经把 block 推入 `partial.content`** 并且 `id`/`name` 已从首个 chunk 填充好（见 `pi-ai/dist/providers/openai-completions.js:150-179` 的 `ensureToolCallBlock`）。另外 SDK 的 `tool_execution_start` 事件（`agent-session.js:439`）带有权威的 `toolCallId` / `toolName` / `args`，可作为第二数据源。

### 1.4 引擎真实工具名与参数

内置工具（`pi-coding-agent/dist/core/tools/*.js`）：

| 工具 | 参数 | 语义 |
|---|---|---|
| `read` | `{path, offset?, limit?}` | 读文件 |
| `write` | `{path, content}` | 写文件 |
| `edit` | `{path, edits[]}`，结果带 `details.diff` / `details.firstChangedLine` | 编辑文件 |
| `bash` | `{command, timeout?}`，结果带 `details.truncation` / `details.fullOutputPath` | 执行命令 |
| `grep` | `{pattern, path?, glob?, ignoreCase?, literal?, context?, limit?}` | 搜索内容 |
| `find` | `{pattern, path?, limit?}` | 查找文件 |
| `ls` | `{path?, limit?}` | 列目录 |
| MCP/扩展工具 | 动态 | 动态 |

这些名字**已经**能区分 read/edit/bash/search/list，问题纯粹是 FastVibe 没接住。

---

## 2. zcode 的展示设计（从 `zcode.asar` 逆向）

分析对象：

- `/Users/yuantang/Documents/resources/zcode.asar`（307 MB，Electron 打包）
- 关键产物：`out/renderer/assets/IntlProvider-Db46X9QF.js`（i18n，**870 个 `chat.*` 键 × 中英两套**）、`out/renderer/assets/styles-DyAcaLKy.js`（4.4 MB，压缩后的主 bundle，含全部组件）

### 2.1 有序 parts + 按 kind 分派的组件表

zcode 按 `toolCallNode.toolCall.kind` 分派渲染器（`styles-DyAcaLKy.js` 中 `y9e`）：

```js
function y9e(e){
  if (kind === "changesGroup")   return W8e;   // 更改组
  if (kind === "executeGroup")   return J8e;   // 终端组
  if (kind === "cuaGroup")       return xK;    // 电脑控制组
  ...
  switch (family) {
    case "agent":            return L8e;
    case "todo":             return u9e;
    case "file-read":        return p8e;
    case "file-write":       return YW;
    case "explore":          return C8e;   // 探索组
    case "search":           return fG;
    case "shell":            return nG;
    case "skill":            return tq;
    case "session-context":  return R7e;
    ...
    default:                 return MG;
  }
}
```

要点：**先有 kind 分类，再每类一个专用组件**。消息流按顺序遍历 parts，连续同类工具在数据层被归并成 `toolCallNode`（带 `childToolCalls`），渲染时一个组只占一行摘要，展开才是子项。

### 2.2 摘要行的解剖：`ToolLayout`

所有工具行都复用同一个布局组件（`f3e`，导出为 `OU`，`displayName = "ToolLayout"`）。它的 props 就是设计规范：

```
toolId, icon, kindLabel, kindDetail, sourceLabel,
primaryText, secondaryText, separator, diffCount,
statusLabel, statusTooltip, isRunning,
title, expandedTitle, renderContent, canToggle, forceOpen, ...
```

渲染结构（`u3e` = 摘要行）：

```
[icon] [kindLabel] [kindDetail] [sourceLabel] [separator] [primaryText secondaryText] [statusNode] [chevron]
   ↑        ↑            ↑            ↑             ↑              ↑                       ↑         ↑
 分类图标  "Read"    动态补充      "SubAgent"       "·"      文件路径/命令            状态文字   悬停才显形
         font-medium   元信息       小圆角 Badge                          省略号截断    虚线+tooltip  旋转 90°
```

细节来自 `c3e`（前段）与 `l3e`（摘要段）：

```js
// c3e: icon + kindLabel + kindDetail + sourceLabel
<span className="shrink-0 text-foreground-subtlest [&_svg]:...">{icon}</span>
<span className="tool-summary-kind-label ...">{kindLabel}</span>          // font-medium, whitespace-nowrap
<span className="shrink-0 rounded border border-border bg-background-alt px-1.5 py-0.5
                 text-ui-xs leading-none text-foreground-subtlest">{sourceLabel}</span>  // 来源徽标

// l3e: 摘要文本，可截断，带交叉淡入淡出
<div className="tool-summary-content min-w-0 flex max-w-full items-center gap-2 text-foreground-subtlest">
```

折叠箭头默认 `opacity-0`，只有 `group-hover/tool-summary` 或已展开时才可见（`u3e`），所以静止画面非常干净。

**关键点：摘要行是"动词 + 宾语"的一句话，不是"标签 + JSON"。**

### 2.3 动词化文案体系

zcode 不给工具显示内部名，而是按**状态变位**显示自然语言（i18n 键 → 中/英）：

| i18n 键 | 英文 | 中文 | 场景 |
|---|---|---|---|
| `chat.toolCall.read.read` | Read | 已读取 | 读完成 |
| `chat.toolCall.read.reading` | Reading | 正在读取 | 读进行中 |
| `chat.toolCall.edit.edited` | Edited | 已编辑 | 编辑完成 |
| `chat.toolCall.edit.editing` | Editing | 正在编辑 | 编辑中 |
| `chat.toolCall.edit.wrote` | Wrote | 已写入 | 写入完成 |
| `chat.toolCall.edit.deleted` | Deleted | 已删除 | 删除完成 |
| `chat.toolCall.execute.ran` | Ran | 已执行 | 命令完成 |
| `chat.toolCall.execute.running` | Running | 正在执行 | 命令中 |
| `chat.toolCall.search.searched` | Searched | 已搜索 | 搜索完成 |
| `chat.toolCall.search.searching` | Searching | 正在搜索 | 搜索中 |
| `chat.toolCall.explore.label` | Explore | 查阅 | 探索组 |
| `chat.toolCall.changesGroup.label` | Changes | 更改 | 改动组 |
| `chat.toolCall.executeGroup.label` | Terminal | 终端 | 终端组 |
| `chat.toolCall.agent.label` | SubAgent | 子智能体 | 子智能体 |
| `chat.toolCall.skill.label` | Skill | 技能 | 技能 |
| `chat.toolCall.todo.updated` | Updated todo | 已更新待办 | 待办 |
| `chat.toolCall.toolCall` | Tool call | 工具调用 | 未知兜底 |

`kind.*` 是静态类别词表（`read/edit/write/delete/search/terminal/todo/skill/message/response/nodeRepl/sessionContext/taskOutput/taskStop`），状态词表在 `status.*`：

```
pending → Pending / 等待中
running → Running / 执行中
completed → Completed / 已执行
failed → Failed / 执行失败
denied → Denied / 已拒绝
stopped → Stopped / 已停止
```

注意中英文**并非直译**，中文用了更符合中文口语的"已读取/正在读取"，这是刻意的本地化。

### 2.4 分组：把连续同类工具折叠成一行

三类主要分组，各有自己的分类器与汇总函数：

**（a）Explore 组** —— 把一批 `read/grep/find/ls` 折叠成"查阅 · 3 个搜索, 2 个列表, 5 个文件"

```js
// _8e: 单个子工具归类为 search / list / file
function _8e({kind, title, input}) {
  const r = `${kind} ${title ?? ""}`.toLowerCase();
  const i = extractCommands(input).join(" ; ").toLowerCase();
  if (/(\bgrep\b|\bsearch\b|\bfetch\b|\bweb.?search\b|\bweb.?fetch\b)/i.test(r) ||
      /(^|\s)(rg|grep|ripgrep|git\s+grep)(\s|$)/i.test(i)) return "search";
  if (/(\bglob\b|\bfind\b|\blist\b|\btree\b|\bdir\b|\bls\b)/i.test(r) ||
      /(^|\s)(ls|find|tree|dir)(\s|$)/i.test(i)) return "list";
  return "file";
}

// v8e: 汇总成一句
// → "3 searches, 2 lists, 5 files" / "3 个搜索, 2 个列表, 5 个文件"
// 空时: "0 files" / "0 个文件"
```

运行中会**动态显示最后一个子动作**（`_G` 从后往前找第一个能出摘要的子工具），所以 streaming 时这行文字是活的。

**（b）Changes 组** —— 把一批文件编辑折叠成"更改 · N 个文件 · +12 −3"，文件 chip 还会按可用宽度自动折叠成 `+N`（`H8e` 做宽度测量）：

```js
// W8e 内的汇总
const summary = files.length === 1
  ? "1 个文件"
  : ["N 个文件", "·", <FileChips/>];       // 单文件直接显示文件名
// diff 统计只在运行中显示，展开后隐藏（hideDiffCountWhenOpen: true）
```

**（c）Execute/Terminal 组** —— 折叠成"终端 · 3 个命令"：

```js
// q8e: "3 commands" + 可选 ", 1 failed" + ", 1 stopped"
function q8e(intl, statuses) {
  const parts = [intl.formatMessage({ id: statuses.length === 1
    ? "chat.toolCall.executeGroup.command.one"
    : "chat.toolCall.executeGroup.command.other" }, { count: statuses.length })];
  const failed = statuses.filter(s => s === "failed").length;
  const stopped = statuses.filter(s => s === "stopped").length;
  if (failed > 0)  parts.push(formatMessage("...executeGroup.failed",  { count: failed }));
  if (stopped > 0) parts.push(formatMessage("...executeGroup.stopped", { count: stopped }));
  return parts.join(", ");
}
```

**组的子项缩进样式**（三处一致，是个可复用常量）：

```js
"ml-2 space-y-2 border-border border-l pl-3.5"   // 左侧竖线 + 缩进，子项不再显示图标(showIcon:false)
```

### 2.5 每类工具的详情渲染 + 快照懒加载

展开后的内容按类型专门渲染，而不是无脑 `<pre>{JSON}</pre>`：

- **edit**：结构化 diff（`chat.toolCall.edit.multipleFiles`、`diff.preview.truncatedLines`），行级红绿 + `box-shadow: inset 3px 0 0` 的左侧色条，可选行号、可切换自动换行
- **bash/terminal**：`execute.noOutput` = "没有输出。"，输出行数上限提示
- **mcp**：分成 `mcp.description`（工具说明）/ `mcp.parameters`（调用参数）/ `mcp.result`（结果）三段，还有 `mcp.callDetails`、`mcp.wrapLines`
- **nodeRepl**：`nodeRepl.result` / `technicalDetails` / `executionDetails` 分区
- **cua（电脑控制）**：最细，约 90 个 `details.*` 键（截图、窗口、坐标、权限…）

**懒加载与截断**是成体系的（含失败重试）：

| i18n 键 | 英文 | 中文 |
|---|---|---|
| `chat.toolCall.snapshot.notice` | `{fields} tool field(s) were truncated. Showing preview {previewBytes} / {fullBytes}.` | `该工具有 {fields} 个字段被裁剪，当前显示预览 {previewBytes} / {fullBytes}` |
| `chat.toolCall.snapshot.loadFull` | Load full tool data | 加载完整工具数据 |
| `chat.toolCall.snapshot.retry` | Load failed, retry | 加载失败，重试 |
| `chat.message.toolSlice.notice` | `Showing {shown} / {total} tool calls.` | `当前已显示 {shown} / {total} 条工具调用。` |
| `chat.message.toolSlice.loadMore` | Load more tool calls | 加载更多工具调用 |
| `chat.message.toolSnapshot.notice` | `{toolCount} tool calls ({fullBytes}) total, previewing {previewBytes}.` | `{toolCount} 个工具调用仅预览 {previewBytes} / {fullBytes}` |
| `chat.message.bodyPreview.notice` | `This reply is large. Showing a preview only ({previewBytes} / {fullBytes}).` | `这条回复较大，当前只显示预览（{previewBytes} / {fullBytes}）。` |
| `chat.message.copy.requiresFull` | Load full message before copying | 加载完整消息后复制 |

**长会话的性能设计**：工具调用**默认只渲染最近 N 条**，更早的用"加载更多"按需拉取；单条工具的巨型字段也先给 preview。这是 FastVibe 目前完全缺失的一层。

### 2.6 Turn 级聚合

`IntlProvider` 里还有 turn 维度的键，说明 zcode 在"当前轮"和"历史轮"之间做了分层：

```
"Current turn tool activity"      / "当前轮 tool call 活动"
"Turn {turn} tool activity"       / "第 {turn} 轮 tool call 活动"
```

即：**正在跑的这轮展开细节，跑完的历史轮折叠成一行**。这直接对应"工具不要堆在最前面"的诉求。

### 2.7 动效（克制的两处）

1. **摘要文字交叉淡入**（`wU`）：`contentKey` 变化时旧文字 `y: 0.8em → -0.8em` 淡出、新文字淡入（`popLayout`），排队/节流（`SU` 延迟、最多缓存 `t3e` 条），避免流式刷屏时闪跳。仅在 `enabled && !isExpanded` 时启用。
2. **工具行入场**：`data-zcode-tool-stream-animate` 标记，入场 key 去重（`gUe`，上限 800 条 LRU），只对新出现的工具做一次动画。

运行态标签用 `.animated-gradient-text`（同色相微光扫过），静止态是 `text-foreground-subtlest`。

### 2.8 推理（reasoning）的展示

推理块是独立的一套 `Reasoning / ReasoningTrigger / ReasoningContent`，与工具行**共享同一套视觉语言**，但有自己的克制:

**触发器（收起态即一行）**

```
[brain 16px, subtlest] [label] [· ticker（流式中）] [chevron，hover 才现形]
```

- 流式中且未展开：label 是 `.animated-gradient-text` 的「正在思考」
- 已结束：`思考 · 持续了 12 秒`（三段分别为 `font-medium` / `·` / `font-normal`，同色 subtlest）
- duration 由数据层给：`Math.max(1, Math.ceil(durationMs / 1000))`，**最小 1 秒**
- **ticker**：流式中且收起时，在 label 右侧展示推理文本的**最后一行非空内容**，带 `y: 0.55em → 0` 的滚入动画；左右各 16px 渐隐遮罩（`linear-gradient(to right, transparent 0, black 16px, black calc(100% - 16px), transparent 100%)`）在溢出时启用。这样"思考进度"可见，却不需要展开一大块文字。

**内容（展开态）**

```js
<div className="pt-3">
  <div className="max-h-60 space-y-2 overflow-auto text-ui-base text-foreground-subtlest
                  ml-2 border-border border-l pl-3.5">   // ← default variant
    <div className="min-w-0 whitespace-pre-wrap break-words">{text}</div>
  </div>
</div>
```

要点：**左侧竖线 + 缩进，没有填充背景、没有圆角盒**——和工具组的子项缩进是同一种语言。`max-h-60`(240px)，滚动时上下各 24px 渐隐遮罩:

```js
function kD({showBottom, showTop}) { /* TD = 24px 渐隐 */ }
// OD(): overflow = max(0, scrollHeight - clientHeight)
//       overflow <= 1 → 无遮罩
//       else → { showTop: scrollTop > 1, showBottom: scrollTop < overflow - 1 }
```

**行为**

- **默认收起**（`defaultOpen: false`）——`isStreaming && e.text.length === 0` 时整块不渲染
- 流式结束后**自动收起**，但一旦用户手动展开过（`userInteracted`）就不再收（`Qet()`）
- 关闭后内容延迟 300ms 卸载（`Xet = 300`，给退场动画留时间）
- 流式时自动滚到底部

---

## 3. 差距对照

| 维度 | zcode | FastVibe 现状 |
|---|---|---|
| 数据模型 | 有序 content parts → `toolCallNode[]`，带 `childToolCalls` | `{text, thinking, tools[]}`，**顺序丢失** |
| 渲染顺序 | 按 parts 顺序，连续同类归组 | 硬编码 thinking → tools → text |
| 工具命名 | 读 `partial.content[contentIndex]` / `tool_execution_start.toolName` | 读不存在的 `inner.name` → `"tool"` |
| 摘要文案 | verb + object（`Read src/a.ts`） | `标签 + 原始 args` 兜底成 `tool tool` |
| 状态词 | 6 态 × 变位文案（完成/进行中分开） | 只有图标（✓/✗/spinner） |
| 分组 | Explore / Changes / Terminal / CUA，带动态汇总 | 无，一行一个工具 |
| 详情渲染 | 每类专用（diff、终端、MCP 三段、CUA） | 统一 `<pre>` 原始文本 |
| 关闭态 | 干净的一行摘要，箭头悬停才出现 | 每行带图标+标签+截断 args |
| 懒加载 | 工具切片 + 字段 preview + 加载更多 + 重试 | 无（单条上限 4000 字符硬截断） |
| 性能 | 只渲染最近 N 条工具 | 全量渲染 + memo |
| 动效 | 摘要交叉淡入、入场动画、渐变运行态 | 仅 streaming caret 与思考计时 |

---

## 4. 改造方案（按依赖分阶段，每阶段可独立发版）

### P0 — 修正确性（必须，改动最小）

**P0.1 修 `tool tool`：从 `partial` 取工具名**

```ts
// src/renderer/src/lib/apply-engine-event.ts — 替换 toolcall_start 分支
if (innerType === "toolcall_start" || innerType === "tool_call_start") {
  const target = ensureAssistant();
  const index = typeof inner.contentIndex === "number" ? inner.contentIndex : undefined;
  const part = Array.isArray((inner.partial as any)?.content) && index != null
    ? (inner.partial as any).content[index] as { id?: string; name?: string; arguments?: unknown } | undefined
    : undefined;
  upsertTool(target, {
    id: asString(part?.id) ?? asString(inner.id) ?? crypto.randomUUID(),
    name: asString(part?.name) ?? asString(inner.name) ?? "tool",
    args: part?.arguments ?? inner.arguments ?? inner.args ?? inner.input,
    status: "running",
  });
  nextStreaming = true;
}
```

`toolcall_end` 同理改用 `inner.toolCall`（有 `id`/`name`/`arguments`），并**回填名字**（防止某些 provider 首 chunk 无 name）：

```ts
if (innerType === "toolcall_end" || innerType === "tool_call_end") {
  const call = isRecord(inner.toolCall) ? inner.toolCall : undefined;
  const id = asString(call?.id) ?? asString(inner.id) ?? trailingAssistant(next)?.tools.at(-1)?.id;
  if (id) {
    const target = ensureAssistant();
    upsertTool(target, {
      id,
      name: asString(call?.name),                        // ← 回填，undefined 时不覆盖
      args: call?.arguments ?? undefined,
      result: toolText(inner.result) ?? toolText(inner.output),
      status: inner.isError === true ? "error" : "done",
    });
  }
}
```

> 注意 `upsertTool` 目前 `{...existing, ...patch}` 会把 `name: undefined` 覆盖掉，需要过滤掉 `undefined` 值，或在这里条件构造 patch。

同时建议在 `tool_execution_start` 分支（`:292`）用它自带的 `toolName`/`args` 作为**权威补丁**：按 `toolCallId` 找到已有条目（若 id 不一致则合并到最后一个 running 项），写入正确的 `name`/`args`。这是最稳的兜底。

**P0.2 保留顺序：引入有序 parts**

把 `ChatMessage` 从"拍平"改为"有序分片 + 便捷视图"：

```ts
// src/shared/types.ts
export type MessagePart =
  | { kind: "text"; text: string }
  | { kind: "thinking"; text: string }
  | { kind: "tool"; toolId: string };

export type ChatMessage = {
  id: string;
  role: "user" | "assistant" | "system";
  parts: MessagePart[];          // ← 新增：真实顺序
  text: string;                  // 保留：整体正文（复制/搜索/兼容用）
  thinking?: string;
  tools: ToolCallBlock[];
  createdAt: number;
  kind?: "message" | "notice" | "compact" | "goal";
  attachments?: ChatAttachment[];
};
```

- `mapEngineMessages`（`src/main/engine/map-messages.ts:46`）：遍历 content 时**按 index 顺序** push 到 `parts`，同时继续累加 `text`/`tools`（向后兼容）。
- `applyEngineEvent`：`text_delta`/`thinking_delta` 时若 `parts` 末尾不是同 kind 就 push 一个新的；`toolcall_start` 时 push `{kind:"tool", toolId}`。
- `message-list.tsx`：改成遍历 `parts` 渲染；`parts` 为空（旧数据/旧会话回放）时回退到现有顺序，保证兼容。

这是"不堆在最前面"的根本修复，也是后面分组的**前提**。

### P1 — 动词化摘要（体验提升最大的一步）

把 `toolMeta` 从"图标映射"升级为"**kind → 动词短语 + 图标**"，并接上真实参数：

```ts
type ToolPresentation = {
  kind: "read" | "edit" | "write" | "delete" | "search" | "list" | "terminal" | "skill" | "agent" | "todo" | "mcp";
  label: string;                 // 折叠态："已读取" / "正在读取"
  labelRunning: string;
  icon: JSX.Element;
  summary: (tool: ToolCallBlock) => { primary?: string; secondary?: string };
  renderDetail?: (tool: ToolCallBlock) => JSX.Element;
};

const PRESENTATION: Record<ToolPresentation["kind"], ToolPresentation> = {
  read: {
    kind: "read", label: "已读取", labelRunning: "正在读取", icon: <FileText/>,
    summary: (t) => ({ primary: basename(argString(t.args, ["path"])) }),
  },
  terminal: {
    kind: "terminal", label: "已执行", labelRunning: "正在执行", icon: <SquareTerminal/>,
    summary: (t) => ({ primary: argString(t.args, ["command"]) }),
  },
  edit: {
    kind: "edit", label: "已编辑", labelRunning: "正在编辑", icon: <FileCode/>,
    summary: (t) => ({ primary: basename(argString(t.args, ["path"])) }),
  },
  // ... search / list / write / skill / ...
};
```

映射引擎真实工具名：`read→read`、`write→write`、`edit→edit`、`bash→terminal`、`grep→search`、`find→list`、`ls→list`，MCP 工具走 `mcp` 兜底并显示工具说明。

摘要行结构照搬 zcode 的 `ToolLayout` 思路：

```
[图标] [动词短语] [路径/命令（可点击打开）] [状态] [悬停出现的箭头]
```

要点：
- 动词按状态变位（"正在读取" → "已读取"），而不是只有图标
- **不显示原始 JSON**，展开才显示
- 路径做成可点击（打开预览/在 Finder 显示），复用已有的 `openPreview` / `workspace.reveal`
- 折叠态保持"一行 + 省略号"，箭头默认透明、hover 才显示

### P2 — 分组（Expl A / Changes / Terminal）

在 `parts` 顺序化的基础上，渲染前做一次**归并**：把 parts 中**连续相邻**的同类工具合并成一个 group part。

```ts
// 伪代码：仅归并相邻同类，跨越正文的不合并
function groupParts(parts: MessagePart[]): RenderPart[] { ... }

// Explore: read/grep/find/ls 连续 ≥3 个 → "查阅 · 3 个搜索, 2 个列表, 5 个文件"
// Changes: edit/write 连续 ≥2 个     → "更改 · 4 个文件 · +12 −3"
// Terminal: bash 连续 ≥2 个           → "终端 · 3 个命令, 1 个失败"
```

阈值（≥2 或 ≥3）建议可配；单个工具不分组，直接平铺一行。

- 分类器直接照搬 `_8e` 的正则思路（grep/搜索 → search；ls/find/glob → list；其余 → file）
- 汇总句照搬 `v8e` / `q8e` 的写法（含 `failed` / `stopped` 计数）
- 组的子项用统一缩进：`ml-2 space-y-2 border-l border-border pl-3.5`，子项 `showIcon: false`

### P3 — 分类详情渲染 + 懒加载

- `renderDetail` 按 kind 分支：
  - `edit`：结构化 diff（**引擎已经给了 `details.diff`**，不必自己从文本猜 `looksLikeDiff`）。现在的 `tool-card.tsx:66` 只能靠正则猜 diff，应该改用 `details`
  - `terminal`：输出 + "没有输出。" + 行数截断提示
  - `mcp`：参数 / 结果 / 说明三段
  - 其他：保留 `<pre>` 兜底
- **大结果懒加载**：主进程在 `tool_execution_end` 时，若结果超阈值只回传 preview + `truncated: {previewBytes, fullBytes}`，渲染"加载完整工具数据 / 加载失败，重试"；点击后按需拉取全量（避免一次 turn 塞几十万字符进渲染层）
- 长会话：`parts` 里只渲染最近 N 条工具，更早的显示"当前已显示 {shown} / {total} 条工具调用" + 加载更多

### P4 — Turn 聚合与动效（可选）

- 历史轮的工具活动折叠成一行（"第 N 轮工具活动 · 5 个工具"），当前轮展开细节
- 摘要文字交叉淡入（`contentKey` 变化时），节流 + 队列，避免流式闪跳
- 运行态标签用渐变文字；工具行入场只对新 toolId 做一次动画

---

## 6. 实施记录（已完成）

以下改动已落地，与上面的方案一一对应。**§6.1 是用户反馈后追加的关键修正**。

### 6.1 整轮合并：一次回复一个块、一个页脚

**问题**：引擎每完成一次 LLM 往返就产出一条 assistant 消息。一次带工具调用的回复因此是**多条** `ChatMessage`，每条都渲染成独立区块并各自带一个 copy/retry 页脚 —— 一次回复出现 N 个 `19:46 ⧉ ↺` / `19:48 ⧉ ↺`。

**改动**（`src/renderer/src/lib/group-parts.tsx`）：

- `groupMessageRows(messages)` —— 把**连续相邻的 assistant 消息**归并成一行（`MessageRow`）；user / system 永远独立成行，保证"提问 → 回复"的交替结构。
- `mergeAssistantRun(messages)` —— 合并成一条逻辑消息：parts 按顺序拼接、tools 按 id 去重合并、`text` 用 `\n\n` 连接、`id`/`createdAt` 取**第一条**（streaming 期间保持身份稳定，避免整块重挂载）。
  - 跨消息边界的**相邻 text part 会被拼接**，避免一句被拆成两个气泡。
  - thinking part **不**合并，每一段推理仍是独立可折叠的「思考过程」。

**渲染**（`src/renderer/src/components/chat/message-list.tsx`）：

- `MessageList` 先算 `rows = groupMessageRows(messages)`，按行渲染。
- `ChatMessageRow` 接收 `messages: ChatMessage[]`，内部合并后再 `groupParts`。
- 结果：**每个页脚对应一次提问或一次完整回复**，而不是一次 LLM 往返。

**顺带收益**：工具分组现在**跨整条回复**生效。以前 `groupParts` 只能看到单条引擎消息里的工具，相邻但分属不同引擎消息的 `read`/`grep` 无法合并；现在可以（有测试覆盖）。

### 6.2 已落地的其余改动

| 方案 | 文件 | 状态 |
|---|---|---|
| P0.1 修 `tool tool` | `lib/apply-engine-event.ts` | ✅ `toolcall_start` 从 `partial.content[contentIndex]` 取 `id`/`name`；`toolcall_end` 用 `inner.toolCall` 回填；`tool_execution_start` 用 `toolCallId`/`toolName` 作权威补丁；`toolcall_delta` 不再把参数 JSON 当结果写入；`upsertTool` 忽略 `undefined`，不让空值覆盖已有字段 |
| P0.2 有序 parts | `shared/types.ts`、`main/engine/map-messages.ts`、`lib/apply-engine-event.ts` | ✅ 新增 `MessagePart`；`ChatMessage.parts?`（可选，旧会话回退到 `resolveParts`） |
| P1 动词化 | `lib/tool-presentation.tsx` | ✅ `familyOf()` 家族分类 + `describeTool()` 动词变位（读取/正在读取…）+ 图标 + `subject`/`context` 拆分 |
| P1 工具行 | `components/chat/tool-row.tsx` | ✅ zcode `ToolLayout` 结构：`[图标][动词][宾语][灰色上下文][失败提示][hover 才出现的箭头]`；展开态按 toolId 记忆（`EXPANDED` Map，上限 800） |
| P2 分组 | `lib/group-parts.tsx`、`components/chat/tool-group.tsx` | ✅ 相邻同类归并：查阅 / 更改 / 终端；汇总句与失败计数；组内子项 `border-l` 缩进 + `showIcon: false` |
| P3 详情渲染 | `components/chat/diff-view.tsx`、`tool-card.tsx` | ✅ `edit` 优先用引擎 `details.diff`；终端用 `$ command` + 输出面板；其余参数 + 结果 |
| P4 运行态 | `index.css`、`tool-row.tsx` | ✅ 运行中标签用 `.animated-gradient-text`（同色相微光扫过，非换色） |
| P4 推理样式 | `components/chat/thinking-block.tsx`、`index.css` | ✅ 见 §6.3 |

未做：单条消息的字段级懒加载 / "加载更多工具调用"（zcode 的 `snapshot` / `toolSlice` 体系）—— 需要主进程配合按需 IPC，目前用 4000 字符截断代替。

### 6.3 推理展示改造（对齐 zcode）

原实现是**灰色填充圆角盒 + 「思考完成 · 1s」标签**，视觉很重。改为 zcode 的克制方案：

| 项 | 改造前 | 改造后 |
|---|---|---|
| 正文容器 | `rounded-lg border bg-muted/40 p-2.5 max-h-48` | `ml-2 border-l border-border pl-3.5 max-h-60`，**无填充、无圆角** |
| 正文颜色 | `text-muted-foreground` | `text-muted-foreground/80`，12px/20px |
| 收起态 | 流式时自动展开，塞满文字 | **默认收起**，流式时标签右侧滚动**末行 ticker** |
| 流式标签 | spinner + 「思考中 · 3s」 | `.animated-gradient-text` 的「正在思考」 |
| 结束标签 | 「思考完成 · 1s」 | 「思考 · 持续了 N 秒」 |
| 箭头 | 常显 | hover 才现形（`group/reasoning`） |
| 滚动 | 硬边裁剪 | 上下 24px 渐隐遮罩 |
| 图标 | `BrainIcon` 14px | `BrainIcon` 16px |

**一处偏离 zcode**：duration 未知时（历史回放没有 `durationMs`），zcode 显示「持续了几秒」。但 FastVibe 不持久化耗时，**所有历史推理块**都会命中这个回退，满屏重复「持续了几秒」。因此改为**只显示「思考」**；只有真正测到耗时的块才带 `· 持续了 N 秒`。

`.animated-gradient-text` 按 zcode 原样实现（§2.7）：同色相、`background-size: 300% 100%`、`gradient-flow 4s linear infinite`、soft = strong 的 22% alpha。工具行的运行态标签也换用它（zcode 里两者本就是同一个 class）。

### 6.4 运行期不展示操作栏（消除闪烁）

**现象**：agent 运行时，那条「时间 / 复制 / 重试」工具栏反复闪烁。

**根因有两层**，缺一不可：

**（1）`streaming` 在每个工具边界被错误地置回 false**

看引擎真实的事件顺序（`pi-agent-core/dist/agent-loop.js`）：

```
agent_start
turn_start → 流式输出 → deep 「done(toolUse)」 → turn_end → tool_execution_* → turn_start → …
agent_end          ← 整轮运行真正的结束
```

- `turn_end` 携带 `toolResults`，是**每轮**都发的（`TurnEndEvent` 里**没有** `isTerminal` 字段）。旧代码判断 `event.isTerminal === false` 属于**死分支**，于是每个 `turn_end` 都把 `streaming` 置 false。
- `message_update` 里的内层 `done` 只是"这一条 assistant 消息流完了"。`reason === "toolUse"` 时 agent 还要执行工具并继续下一轮，旧代码也把它当成了运行结束。

结果 `streaming` 在每个工具调用处 false→true 跳一次，工具栏就闪一次。

修复（`lib/apply-engine-event.ts`）：

```ts
// turn_end 只返回当前状态，不再清空：运行只在 agent_end 结束
if (type === "turn_end") return { messages: next, streaming: nextStreaming };
if (type === "agent_end") return { messages: next, streaming: false };

// done 只在非 toolUse 时才意味着流式结束
if (innerType === "done") {
  if (asString(inner.reason) !== "toolUse") nextStreaming = false;
}
```

实测一整轮（3 次工具调用）现在**只有一次状态翻转**，就发生在 `done(stop)`：

```
… turn_end:T tool_execution_start:T tool_execution_end:T
turn_start:T message_update:text_delta:T message_update:done(stop):F turn_end:F agent_end:F
```

**（2）工具栏在流式期间仍然挂载**

旧代码用 `visible={last && !streaming}` 控制，但 false 分支只是 `opacity-0` —— 元素**仍占约 20px**，且带 `group-hover/row:opacity-100`。内容流式增长时元素在光标下反复进出 hover，加上那 20px 空行随内容重排，就是看见的闪烁。

现在流式期间**整行不渲染**（`components/chat/message-list.tsx`）：

```tsx
{streaming ? null : <MessageActions ... visible={last} />}
```

这同时也更合理：运行中「重试」无意义（回复还没结束），「复制」会复制到半成品。

用户自己的消息行不受影响——它不在流式中，仍可 hover 复制/编辑自己的输入。

### 6.5 验证

```bash
pnpm typecheck          # 通过
pnpm build              # 通过
```

行为验证覆盖（临时脚本，已删除）：

- `toolcall_start` 只用 `partial` 解析出 `read`（修复前是字面量 `tool`）
- parts 顺序 = 引擎顺序：`text → tool → text`
- 失败状态与 `details` 透传
- 5 条连续 assistant 消息 → **2 个页脚**（1 用户 + 1 回复）
- 跨消息的工具仍能分组；相邻 prose 不分裂
- 6 个 `read/grep/ls` → "查阅 · 2 个搜索, 1 个列表, 3 个文件"
- 2 个 `edit` 带 `details.diff` → "更改 · 2 个文件 +2 −2"
- 无 `parts` 的旧消息仍能渲染
- **运行期无闪烁**：按 `agent-loop.js` 的真实顺序（3 次工具调用）逐事件喂入 `applyEngineEvent`，`streaming` 全程**只有 1 次翻转**，且发生在 `done(stop)`；3 次 `tool_execution_start` 时 `streaming` 均为 true
- 运行中断时：流式那一行**没有页脚**（只有用户行保留），且不含时间戳/操作按钮的 DOM
- 运行结束后：页脚恢复（2 个）
- **真实会话回放**：扫描 `~/Library/Application Support/FastVibe/runtime/engine/agent/sessions/` 全部会话，116 个工具调用中未命名工具 = **0**（修复前全部是 `tool`）
- **真实 Electron DOM**：`data-slot="tool-row"` 7 行、`data-slot="message-footer"` 2 个、5 个思考块、0 控制台错误

推理样式额外验证（`pnpm build` 后对真实 Electron 渲染进程取 `getComputedStyle`）：

```
[data-slot="reasoning-body"]
  borderLeftWidth: 1px          ← 左侧竖线
  background:      rgba(0,0,0,0) ← 无填充
  borderRadius:    0px           ← 无圆角盒
  paddingLeft:     14px
  maxHeight:       240px
  fontSize:        12px / lineHeight 20px
  color:           oklab(0.556 0 0 / 0.8)

.animated-gradient-text
  backgroundImage:  linear-gradient(90deg, oklch(0.556 0 0) 0%, … oklab(0.556 0 0 / 0.22) 50%, …)
  backgroundClip:   text
  animation:        gradient-flow 4s infinite
  rendered size:    64×24  (确认文本没有被 transparent 吃掉)
```

历史回放（4 个真实会话，80 条消息）: `unnamed=0`、`dupParts=0`、每个会话的 `rows` 与 `messages` 比值符合"每条回复一行"。


---

## 5. 落地清单

| 阶段 | 文件 | 改动 |
|---|---|---|
| P0.1 | `src/renderer/src/lib/apply-engine-event.ts` | `toolcall_start`/`toolcall_end` 改读 `partial.content[contentIndex]` / `inner.toolCall`；`tool_execution_start` 按 id 补名字与参数；`upsertTool` 忽略 `undefined` |
| P0.2 | `src/shared/types.ts` | 新增 `MessagePart`，`ChatMessage` 加 `parts` |
| P0.2 | `src/main/engine/map-messages.ts` | 按 content index 生成 `parts`；`toolCall` 名字兜底从 `"tool"` 改为可诊断值 |
| P0.2 | `src/renderer/src/lib/apply-engine-event.ts` | 流式时维护 `parts` 追加顺序 |
| P0.2 | `src/renderer/src/components/chat/message-list.tsx` | 改遍历 `parts`；`parts` 缺失时回退旧顺序 |
| P1 | `src/renderer/src/components/chat/tool-card.tsx` | `toolMeta` → `ToolPresentation`（动词短语 + 状态变位 + 参数提取 + 详情渲染钩子） |
| P1 | 新增 `src/renderer/src/lib/tool-presentation.tsx` | 分类表、`basename`、参数提取、（可选）i18n 词表 |
| P2 | 新增 `src/renderer/src/lib/group-parts.ts` | 相邻同类归并 + 汇总句 |
| P2 | 新增 `src/renderer/src/components/chat/tool-group.tsx` | 组摘要行 + 缩进子项容器 |
| P3 | `src/main/pi/process-manager.ts` | 工具结果大字段截断 + 按需全量 IPC |
| P3 | `src/renderer/src/components/chat/tool-card.tsx` | 用引擎 `details.diff` 替代 `looksLikeDiff` 猜测 |
| P4 | `tool-card.tsx` / `message-list.tsx` | 交叉淡入、入场动画、turn 折叠 |

**建议顺序**：P0.1 先单独发（一个 bug fix，立刻消掉 `tool tool`），再 P0.2（修顺序），然后 P1、P2。

---

## 附录 A：证据索引

**FastVibe（本仓库）**

- `src/shared/types.ts:59-91` — `ToolCallBlock`、`ChatMessage`（顺序丢失处）
- `src/main/engine/map-messages.ts:46-108` — `extractContent` 分类累加
- `src/renderer/src/lib/apply-engine-event.ts:239-272` — `toolcall_start` / `toolcall_end` 读错字段
- `src/renderer/src/lib/apply-engine-event.ts:79-92` — `upsertTool`
- `src/renderer/src/components/chat/message-list.tsx:197-218` — 硬编码渲染顺序
- `src/renderer/src/components/chat/tool-card.tsx:34-51,97-174` — `toolMeta` 兜底与原始 JSON 渲染
- `src/main/pi/process-manager.ts:349-357` — SDK 事件原样转发（无重排）

**引擎（`@mariozechner/pi-ai` / `pi-coding-agent`）**

- `pi-ai/dist/types.d.ts:98-123` — `TextContent` / `ThinkingContent` / `ToolCall`
- `pi-ai/dist/types.d.ts:144-149` — `AssistantMessage.content`（有序）
- `pi-ai/dist/types.d.ts:158-165` — `ToolResultMessage`
- `pi-ai/dist/types.d.ts:219-231` — `toolcall_start/delta/end` 事件载荷
- `pi-ai/dist/providers/openai-completions.js:150-179` — `ensureToolCallBlock`（`toolcall_start` 时 block 已入 `partial.content` 且带 `id`/`name`）
- `pi-coding-agent/dist/core/agent-session.js:439-460` — `tool_execution_start/update/end` 带 `toolCallId`/`toolName`/`args`
- `pi-coding-agent/dist/core/tools/*.js` — 工具名与参数 schema；`edit` 产出 `details.diff`、`bash` 产出 `details.truncation`

**zcode（`/Users/yuantang/Documents/resources/zcode.asar`）**

- `out/renderer/assets/IntlProvider-Db46X9QF.js` — 870 个 `chat.*` 键 × 中英；`chat.toolCall.*` 292 个
- `out/renderer/assets/styles-DyAcaLKy.js`（主 bundle）
  - `f3e` / `OU` `ToolLayout` — 通用工具行布局
  - `u3e` — 摘要行；`c3e` — 图标/类别/来源徽标；`l3e` — 摘要文本段
  - `wU` — 摘要交叉淡入动画
  - `y9e` — kind → 组件分派表
  - `C8e` — Explore 组；`W8e` — Changes 组；`J8e` — Terminal 组
  - `_8e` — Explore 分类器；`v8e` — Explore 汇总句；`q8e` — Terminal 汇总句
  - `S8e` / `_G` — 从子工具提取"一句话摘要"（运行中取最后一个）
  - `b9e` / `dq` — `ToolCallBlock` 组件

## 附录 B：关键 i18n 键速查

```
chat.toolCall.read.read / read.reading          已读取 / 正在读取
chat.toolCall.edit.edited / .editing            已编辑 / 正在编辑
chat.toolCall.edit.wrote / .deleted             已写入 / 已删除
chat.toolCall.execute.ran / .running            已执行 / 正在执行
chat.toolCall.search.searched / .searching      已搜索 / 正在搜索
chat.toolCall.explore.label                     查阅
chat.toolCall.changesGroup.label                更改
chat.toolCall.executeGroup.label                终端
chat.toolCall.agent.label                       子智能体
chat.toolCall.status.*                          pending/running/completed/failed/denied/stopped
chat.toolCall.snapshot.notice                   该工具有 {fields} 个字段被裁剪，当前显示预览 {previewBytes} / {fullBytes}
chat.toolCall.collapseDetails / expandDetails   收起工具详情 / 展开工具详情
chat.message.toolSlice.notice                   当前已显示 {shown} / {total} 条工具调用
chat.message.toolSlice.loadMore                 加载更多工具调用
chat.message.bodyPreview.notice                 这条回复较大，当前只显示预览（{previewBytes} / {fullBytes}）
chat.message.copy.requiresFull                  加载完整消息后复制
```
