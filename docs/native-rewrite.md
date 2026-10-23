# FastVibe Native（Rust + GPUI）重写方案

目标：用 Rust 重写整个桌面端，界面用 GPUI + gpui-kit（0.8），agent 引擎自研（设计借鉴 openai/codex 的
`codex-rs`，Apache-2.0），不再依赖任何 `@earendil-works/pi-*` 包；功能对齐现有 Electron 版（约 11.5 万行 TS/TSX）。

## 0. 已定前提

| 问题 | 决定 |
| --- | --- |
| 代码位置 | 本仓库 `gpui` 分支，`native/` 下的 Cargo workspace；Electron 版继续可发布，直到原生版追平 |
| 旧数据 | 首次启动**一次性导入**（providers / 密钥 / MCP / 设置 / 会话目录 / pi v3 转写），之后只用新格式 |
| 手机端与远程协议 | 重新设计，Flutter 端跟着改 |
| 网页内容 | `wry` 嵌入原生 WKWebView / WebView2 子视图 |
| 平台 | 先 macOS，之后 Windows / Linux |
| 插件 | 不支持第三方 TS 插件；内置功能用 Rust 实现，扩展点只有 MCP 与技能 |

## 1. 总体架构：App Server

照 codex 的 app-server（`codex-rs/app-server*`）来：**引擎是一个独立进程 `fastvibe-server`**，桌面 GUI、手机、SSH 远端、
命令行都是它的客户端，彼此地位相同，走同一套协议。GUI 不直接调用引擎。

```
  GPUI 桌面端          Flutter 手机端              fastvibe CLI / 测试客户端
  (fv-gui)             (apps/mobile_flutter)        (fv-client 的另一个用法)
     │ fv-client           │                              │
     │ unix socket         │ WS(局域网) / WebRTC(官方)     │ stdio / unix socket
     ▼                     ▼                              ▼
┌──────────────────────── fastvibe-server（常驻进程）────────────────────────┐
│ transport：stdio │ unix socket │ ws:// │ WebRTC 数据通道                   │
│     │  每条连接带 Origin（Local / Lan / Official / Ssh）→ 鉴权 + 策略表     │
│     ▼  有界 channel（满了：请求回 overloaded，应答等待）                    │
│ MessageProcessor：握手门禁 → 按域分发（thread/turn/fs/git/config/…）        │
│     │  同一会话的请求串行，不同会话并行                                      │
│     ▼                                                                      │
│ ThreadManager：会话订阅者集合 · 每个会话一个 listener task                  │
│     │  listener：agent 事件 ─► event_mapping（纯映射）+ 有状态翻译          │
│     │            ─► 扇出给订阅该会话的每条连接                              │
│     │  server→client 请求（question / confirm）：id + oneshot，重连后重放   │
│     ▼                                                                      │
│ fv-agent（回合循环 + 工具）· fv-engine 服务（队列/DAG/记忆/MCP/定时任务）    │
│ fv-provider（genai + 适配层）· fv-store（SQLite + JSONL）                    │
└────────────────────────────────────────────────────────────────────────────┘
        ▲ start / stop / version / 升级后重启
  fv-daemon：pid + lock 文件，GUI 启动时拉起或连上已有的 server
```

### 1.1 进程模型

- **server 常驻，GUI 可以随时关、崩溃、重启**，正在跑的回合不受影响。这也直接解决了现在「窗口关掉运行还在
  Main 里」「保持唤醒」「定时任务需要应用开着」的问题：它们都属于 server，不属于窗口。
- GUI 启动时由 `fv-daemon` 连接已有的 server；没有就拉起一个。server 的数据目录内有 `server.pid`、`server.lock`、
  `server.sock`（0600，父目录 0700）。GUI 升级后发现 server 版本不同，等它空闲再重启。
- 「退出 FastVibe」= 停 server（有运行中的任务先确认）；只关窗口不停 server。是否在没有窗口时继续常驻是一个设置项
  （默认：有定时任务或远程访问开着时常驻）。
- **同一个二进制也是 SSH 主机上的 Agent**：远端跑 `fastvibe-server --listen stdio`，经 `ssh` 的 stdio 直接连，
  不再需要 SSH 端口转发 + 回环令牌那一套。
- 测试与 CLI 可以用 in-process 模式（同一协议，内存 channel），codex 的 `in_process.rs` 同样做法。

### 1.2 协议（`fv-protocol`）

- **JSON-RPC 形状**（不带 `"jsonrpc":"2.0"`，与 codex 一致）：`Request{id, method, params}` / `Response{id, result}` /
  `Error{id, error{code, message, data}}` / `Notification{method, params}`。
- **分帧**：stdio 与 unix socket 一行一条 JSON；WebSocket 用 text frame，可协商 zstd；WebRTC 数据通道沿用现有分片头
  （16 / 64 KiB，按路径选择），帧内容与 WS 相同。
- **方法表由宏生成四个枚举**：`ClientRequest`、`ServerNotification`、`ServerRequest`、`ClientNotification`
  （codex `app-server-protocol/src/protocol/common.rs` 的做法），新增一个方法只改一处，编译器保证 server 处理了它，
  策略表用 `match` 穷举，漏分类编译不过。
- **类型导出**：`schemars` 生成 JSON Schema 并提交进仓库（`native/schema/`），Flutter 端从 schema 生成 Dart 类型；
  GUI 直接用 Rust 类型。协议快照测试防止无意的破坏性改动。实验性方法用 `#[experimental]` 标注，握手声明后才可用。
- **数据模型 Thread → Turn → Item**（codex `protocol/v2`）。FastVibe 的「会话」= thread，「一轮」= turn，
  Item 至少有：`UserMessage`、`AgentMessage`、`Reasoning`、`ToolCall`（read/write/edit/bash/MCP/…，按工具族带结构化详情）、
  `FileChange`、`Todo`、`Question`、`Subagent`、`Dag`、`Present`、`ContextCompaction`、`ModelSwitch`、`Error`。

主要方法（节选，命名对齐 codex，FastVibe 特有的放在自己的前缀下）：

| 类别 | 方法 |
| --- | --- |
| 握手 | `initialize` → `initialized`（客户端名、能力、是否接收实验方法、退订哪些通知） |
| 会话 | `thread/list` `thread/start` `thread/resume` `thread/read` `thread/fork` `thread/archive` `thread/delete` `thread/name/set` `thread/unsubscribe` `thread/search` |
| 回合 | `turn/start` `turn/steer` `turn/interrupt` `turn/continue` `turn/retry` `thread/compact/start` |
| 队列 | `thread/queue/list` `thread/queue/add` `thread/queue/reorder` `thread/queue/sendNow` `thread/queue/remove` |
| 工作区 | `project/*` `fs/readDir` `fs/readFile` `fs/writeFile` `fs/createEntry` `fs/renameEntry` `fs/deleteEntry` `fs/search` `git/*` `terminal/*` `office/*` |
| 配置 | `provider/*` `model/list` `config/read` `config/write` `mcpServer/*` `skill/*` `memory/*` `schedule/*` `dag/*` |
| 账号与远程 | `account/*` `remote/*`（远程连接上一律拒绝） |

服务端通知：`thread/started|status/changed|archived|deleted|name/updated|tokenUsage/updated|queue/changed`、
`turn/started|completed|diff/updated`、`item/started|completed`、`item/agentMessage/delta`、`item/reasoning/delta`、
`item/toolCall/argumentsDelta|outputDelta`、`catalog/changed`、`serverRequest/resolved`、`account/updated`、`warning`。

服务端请求（server → client，等客户端答复）：`item/question/request`（question 工具、确认、输入、编辑器），
`item/tool/call`（在客户端执行的工具，例如 browser-use 驱动 GUI 里的 wry 页面、computer-use）。

### 1.3 订阅、多客户端与重连

- 一条连接可以订阅多个会话，一个会话可以被多条连接订阅（`ThreadStateManager`：会话 → 连接集合）。
  事件只发给订阅者；目录变更（`catalog/changed`）发给所有连接。**没有「当前会话」这种 server 状态**，
  这就是现在 `#activeId` 被多窗口争抢那一类 bug 的根治。
- 每个会话事件带单调 `seq`。`thread/resume` 原子地返回快照（含进行中的回复、未决的服务端请求）并开始订阅；
  客户端丢弃 `seq ≤ 快照` 的事件。这一点比 codex 多一步（codex 不带 seq），对应现有 `ConversationSnapshot`。
- 未答复的服务端请求在新连接订阅时重放；任一客户端答复后发 `serverRequest/resolved`，其他客户端收起面板。
- 增量节流在 server 侧做（现有 `ToolDeltaThrottle` 的规则），对所有客户端一致。

### 1.4 鉴权与策略

| Origin | 鉴权 | 策略 |
| --- | --- | --- |
| Local（unix socket，同用户） | socket 文件权限 0600 | 全部方法 |
| Ssh（stdio over ssh） | ssh 本身 | 全部方法 |
| Lan（ws://） | 密码换设备令牌（scrypt + 只存哈希），退避 | 拒绝：原生对话框、`remote/*`、`account/*`、宿主桌面操作 |
| Official（WebRTC） | 同账号信令 + DTLS 指纹 | 同 Lan |

非回环监听没有鉴权时拒绝启动（codex `websocket-auth` 的 `is_unauthenticated_non_loopback_listener` 同理，现有「没密码不监听」规则）。

### 1.5 内部分层（对应 codex）

| codex | FastVibe |
| --- | --- |
| `app-server-transport` | `fv-transport`：stdio / unix / ws / webrtc，`TransportEvent{Opened, Closed, Incoming}` |
| `MessageProcessor` + `request_processors/*` | `fv-server::processor` + 每个域一个处理器 |
| `ThreadStateManager` + listener task | `fv-server::threads` |
| `event_mapping` + `bespoke_event_handling` | `fv-server::mapping`（纯映射可单测）+ 有状态翻译 |
| `outgoing_message`（服务端请求 + oneshot） | `fv-server::outgoing` |
| `app-server-client`（InProcess / Remote） | `fv-client`：GUI 与 CLI 共用，自动重连、seq 去重 |
| `app-server-daemon` | `fv-daemon`：pid / lock / 拉起 / 版本检查（不做 codex 的自动更新器，更新归 GUI） |
| `app-server-test-client` + `mock_model_server` | `fv-test-client` + 录制的 SSE 回放服务器 |

## 2. crate 划分

| crate | 内容 | 主要依赖 |
| --- | --- | --- |
| `fv-core` | 消息、内容块、工具调用、用量、思考强度、模型与供应商描述 | serde |
| `fv-protocol` | 线协议：四个方法枚举、Thread/Turn/Item、所有参数类型、JSON Schema 导出 | serde、schemars |
| `fv-provider` | 模型层：genai 之上的适配（见 3.3） | genai、tokio |
| `fv-store` | 数据目录、SQLite（会话目录、队列、DAG、定时任务、检查点、思考耗时、记忆、用量）、JSONL 转写、凭据（0600） | rusqlite |
| `fv-agent` | 回合循环、工具注册与派发、系统提示词、AGENTS.md / 技能、历史规范化、压缩 | fv-provider、fv-store |
| `fv-tools` | 内置工具，以 codex-rs `core/src/tools` 为基准移植（见 3.4）：read_file / list_dir / grep_files / apply_patch / shell / update_plan / request_user_input / view_image / tool_search / code_mode / web_search，加 FastVibe 自有的 present / conversation_search / worktree / dag / schedule | portable-pty、ignore |
| `fv-engine` | 会话外的服务：排队、检查点、子 agent、DAG、记忆、MCP（`rmcp`）、定时任务、回复推荐、标题 | fv-agent、rmcp |
| `fv-workspace` | Git、文件树、文件搜索、终端（`alacritty_terminal` 的 pty 与网格）、OfficeCLI | alacritty_terminal |
| `fv-transport` | stdio / unix socket / ws / WebRTC、设备令牌、mDNS、背压、心跳 | tokio-tungstenite、mdns-sd |
| `fv-server` | app server 本体与 `fastvibe-server` 二进制 | 上面全部 |
| `fv-client` | 协议客户端（in-process / unix socket / stdio-over-ssh） | fv-protocol |
| `fv-daemon` | server 生命周期 | fv-client |
| `fv-import` | Electron 版数据导入；从 pi / Claude Code / Codex / opencode 导入会话 | rusqlite |
| `fv-theme` | 24 套 `ThemeSeed`、`buildTokens`、`glassTokens`、度量常量表；不依赖 GPUI，与 TS 版逐值对拍 | serde |
| `fv-ui` | 按 shadcn base-nova 重新上皮肤的组件层（包装 gpui-kit），视图只用它 | gpui-kit、fv-theme |
| `fv-gui` | GPUI 视图、wry 子视图（浏览器 / HTML / Office / KaTeX）、computer-use、通知、Dock 角标、更新 | gpui-kit、wry、fv-client |

依赖规则：`fv-gui` 只依赖 `fv-client` + `fv-protocol`，**不得**依赖 `fv-agent` / `fv-store`，从结构上保证 GUI 能做的事
手机也能做。`fv-server` 不依赖任何 GUI 库，可在无显示器的 Linux 上运行（SSH 主机）。

## 3. Agent 引擎设计（借鉴 codex-rs）

### 3.1 回合循环

对应 codex `core/src/session/turn.rs` 的 `run_turn` → `try_run_sampling_request`：

1. 回合开始：划检查点边界，必要时先压缩（≥ 90% 窗口），把用户输入写进历史与转写。
2. 组装请求：系统提示词 + 规范化后的历史 + 当前激活的工具。
3. 流式采样：文本 / 思考 / 工具参数增量逐条发事件；收到完整工具调用即派发执行。
4. 工具执行：读类工具并发、写类工具串行（照搬 codex `tools/parallel.rs` 的读写锁），结果按调用顺序回收并写回历史。
5. 有工具结果 → 回到 2；模型自然结束 → 回合结束；之后检查排队消息、goal 续跑，全部完成才发 `Settled`。
6. 「运行中」以 `Settled` 为界（不是单次请求结束），重试退避、压缩、续跑都在同一个 run 内。

取消：每个 run 一个 `CancellationToken`，贯穿 HTTP 流、工具、子进程组；中止统一呈现为「已中断」，与失败分开。

### 3.2 历史与转写

- 内存历史是 `Vec<Entry>`，每条带 `id` / `parent_id`（支持重试、编辑分支与分叉）。
- 发给模型前规范化（照搬 codex `context_manager/normalize.rs`）：缺结果的工具调用补一条错误结果，孤儿结果丢弃，
  工具结果紧跟它的调用；不支持图片的模型去掉图片。
- 转写：`sessions/<conversation_id>.jsonl`，首行 `SessionMeta`，之后每行一条条目，**只追加**，
  首轮写入用「临时文件 → fsync → rename」。打开时补齐悬空工具调用、接续断链（沿用现有修复规则）。
- 工具产生的图片落盘到 `tool-images/<会话>/`，转写只存引用；请求前按 4 MB 预算回填，旧图换成带路径的说明。

### 3.3 模型协议层：genai + 薄适配

调研结论（2026-10）：四种协议都能用现成 crate，选 **genai**（jeremychone/rust-genai，MIT/Apache-2.0，0.7.0 于 2026-10-20 发布，
基本日更）。

| 需求 | genai 现状 |
| --- | --- |
| OpenAI Chat Completions（任意兼容 base URL） | `openai` 适配器；流里读 `delta.reasoning_content` / `delta.reasoning`（DeepSeek、Qwen 这类） |
| OpenAI Responses | `openai_resp` 适配器；reasoning、`encrypted_content` 捕获与回放 |
| Anthropic Messages | thinking + `signature_delta` 拼成带签名的块并在工具轮回放；`cache_control` |
| Google Gemini v1beta | `generateContent` / `streamGenerateContent?alt=sse`，thought part 与签名 |
| 统一流事件 | `ChatStreamEvent::{Start, Chunk, ReasoningChunk, ThoughtSignatureChunk, ToolCallChunk, End}` |
| 用量 | prompt / completion / total + `cached_tokens` / `cache_creation_tokens`，四家已归一 |
| 自定义端点与头 | `ServiceTarget{endpoint, auth, headers}` + resolver；`with_extra_headers` / `with_extra_body` |
| 思考强度 | `ReasoningEffort::{Zero, Low, Medium, High, XHigh, Max, Budget}` |
| 取消 | drop `ChatStream` |

其余候选不选的理由：rig（8.9k stars，四协议齐，但带 agent / 向量库抽象，0.46 仍是 rc，API 变动频繁）、
async-openai（只有 OpenAI 两种协议）、llm / aisdk / langchain-rust（缺 Responses 或 reasoning 建模不足）、
Zed 的 provider crate（GPL-3.0-or-later，不能用）、codex 的 `codex-api`（只有 Responses，未发 crates.io）。

`fv-provider` 在 genai 之上只做 FastVibe 自己的策略（约 1k 行），业务代码不直接见到 genai 类型，将来要换实现只改这一层：

1. **自有消息模型 → genai 的单向映射**；转写格式不依赖 genai。
2. **路由**：每个模型自己的协议（`claude-*` → Anthropic、`gemini-*` → Google 的自动推断）、按协议换算 base URL
   （Anthropic 去掉 `/v1`，Google `v1` → `v1beta`），经 `ServiceTarget` resolver 注入。
3. **思考强度**：FastVibe 档位 → genai `ReasoningEffort` 或供应商自己的值（`effortMap`）；不提供 off；关思考补丁
   （`enable_thinking:false` 等）走 `extra_body`，被拒后去掉补丁重试一次并记住。
4. **取消**：`CancellationToken` + `select!` 包住流，取消后立刻返回「已中断」，而不是等 drop。
5. **重试**：429 / 5xx / 传输错误、且尚未产生输出时，指数退避 + 抖动，最多 5 次（codex 默认值）。
6. **请求发出时刻**：在 genai 发请求前回调一次，用于「模型已切换」分隔线（现有 `onPayload` 时机）。

风险：genai 0.6 → 0.7 有破坏性改动，锁精确版本；适配层用录制的真实 SSE 做回放测试，升级时整套跑一遍。
需要先做一次验证：用现有四个供应商（FastVibe 中转 Responses、packy Responses、Qwen Chat、a6 Chat）各跑一轮
「思考 + 工具调用 + 工具结果 + 继续」，确认增量、签名回放、缓存用量都对；不满足的地方给上游提 PR 或在适配层补。

### 3.4 工具

**总原则：所有内置工具以 codex-rs 的实现为准**（`core/src/tools/`：`registry`、`router`、`spec`、`parallel`、`handlers/*`，
以及 `apply-patch`、`mcp` 相关 crate）。codex 有对应实现的，直接对照移植它的参数模式、执行语义、输出截断、错误文案、
取消与超时处理，不再沿用 pi 版本的工具行为；工具的 JSON schema 和提示词也以 codex 为起点，FastVibe 只在必须的地方改
（见下表「偏离」列）。移植时记录对应的 codex 文件与提交，保留 Apache-2.0 的 NOTICE，升级时可对照上游。
codex 没有的工具才自己写，且沿用 codex 的 handler 抽象（`ToolHandler` + 注册表 + 读写锁并行）。

| 工具 | codex 对应 | 偏离 / 说明 |
| --- | --- | --- |
| 读文件 / 列目录 / 搜索 | `handlers/read_file`、`list_dir`、`grep_files` | 按 codex 的分页、缩进感知读取与输出上限；FastVibe 的 `read` 并入 `read_file` 的语义 |
| 改文件 | `apply-patch` crate + `handlers/apply_patch` | **以 apply_patch 为唯一的编辑工具**，不再单独做 `write` / `edit`（新建 = Add File，整文件替换 = Delete + Add）。vendor `parser` / `seek_sequence` / `invocation`，只依赖 `similar`，保留 NOTICE；变更事件映射为 `FileChange` item |
| shell | `handlers/shell`、`unified_exec`（含 `write_stdin` 的会话式进程） | 进程组、超时、取消、输出首尾截断、长命令转后台并可轮询；FastVibe 不做审批与沙箱，所以去掉 `with_escalated_permissions` / sandbox policy 那一层 |
| todo | `handlers/plan`（`update_plan`） | 工具名与参数用 codex 的；状态仍存在工具结果 `details` 里以便随分支重建 |
| question | `request_user_input` | 对应协议里的 `item/question/request`；多问题分页沿用 codex 的参数形状 |
| 看图 | `handlers/view_image` | 对应「工具图片落盘 + 引用」；`present` 在它之上扩展视频 / HTML / Office |
| MCP | `handlers/mcp` + `rmcp` | 工具命名、结果转换、`isError` 处理照 codex；连接管理保持每引擎一次、所有会话共享；`direct / deferred` 两种暴露方式（见 tool_search） |
| tool_search | codex 的 `tool_search`（BM25） | 按 codex 的检索与「延迟声明」流程 |
| 代码模式 | codex 的 `code_mode` / `js_repl` | 以 codex 的沙箱、`tools.<name>()` 绑定和输出规则为准，取代原来的 QuickJS 自研方案；是否复用其 V8 / QuickJS 选型，M4 开工前对照上游定 |
| web_search | codex 的 `web_search` | 由模型端托管的搜索工具时直接透传；仅在 Responses 协议下激活 |
| subagent | codex 的 `multi_agents`（spawn / wait / close agent 等） | 角色、并行与链式沿用 codex 的 agent 控制模型；FastVibe 的角色文件与模型继承规则叠加其上 |
| 以下 codex 没有，自己写 | — | `dag_*`（调度、写入范围、等待释放名额）、`present`、`conversation_search`、`worktree`、app config、`browser_*` / `computer_*`、`schedule_*`；`browser_*` / `computer_*` 由 server 发 `item/tool/call`、`fv-gui` 执行，没有 GUI 连接时不激活 |

执行层同样照搬 codex：`ToolRegistry` 按名字派发，`ToolRouter` 从模型输出构造调用，`parallel.rs` 的读写锁让只读工具并发、
改动类工具串行；工具声明是否 `supports_parallel_tool_calls` 由 handler 自己声明。

**这一点对其它章节的影响**：`fv-tools` 的工具清单随上表调整；检查点的「写入前捕获」要挂在 apply_patch 与 shell 的
变更事件上（codex 的 patch 在应用前已解析出受影响文件，天然适合）；3.2 的历史规范化已经是 codex 做法，保持不变。

`goal`、`handoff`、会话标题、输出语言、项目多文件夹上下文、记忆读取，这些原来是 pi 扩展，
改为引擎内的「回合钩子」（`before_turn` / `after_message` / `on_settled`），不再有插件 API。

### 3.5 系统提示词

基础指令自写（不照搬 codex 的 prompt.md）；AGENTS.md 发现照搬 codex `agents_md.rs`（项目根到 cwd 逐级拼接）；
技能目录沿用现有四个位置（`~/.agents/skills`、`<cwd>/.agents/skills`、内置、私有目录）；AI 偏好语言、记忆摘要、
多文件夹快照作为隐藏上下文追加。

## 4. 界面映射（gpui-kit）

| 现有界面 | gpui-kit 组件 | 备注 |
| --- | --- | --- |
| 三栏布局、可拖动 | `resizable`、`dock` | 浮动面板、8px 内缩照搬 |
| 侧栏会话 / 项目树 | `sidebar`、`tree`、`virtual_list` | 拖拽排序自写 |
| 转写 | `message_scroller`（虚拟列表 + 跟随底部）、`text::markdown` | 思考块、工具卡、折叠运行过程、连续工具折叠自写 |
| 代码高亮 | `highlighter`（syntect） | 主题 token 对应现有 `--code-*` |
| diff | `diff` | 统一 / 并排、换行、hunk 跳转 |
| composer | `input::Textarea`、`popover`、`menu` | `@` 文件、`/` 命令、技能 badge、Tab 采纳推荐 |
| 提问面板 | `questionnaire`、`stepper` | — |
| 设置 | `setting`、`form`、`switch`、`select` | master/detail |
| 命令面板 | `command` | — |
| 通知 / 对话框 | `notification`、`dialog`、`sheet` | — |
| 终端 | 自绘（`alacritty_terminal` 网格 + GPUI 文本） | 参考 Zed 的做法 |
| 浏览器、HTML/Office 预览、KaTeX | `fv-gui` 内的 wry 子视图，覆盖在 GPUI 元素区域上 | 需要处理坐标同步、焦点、遮挡 |
| 文件图标 / 供应商图标 | 复用 `resources/file-icons`、LobeHub SVG | — |

### 4.1 与 Electron 版 1:1 复刻

**目标**：每个面板在相同视口、相同数据、相同主题下，布局、间距、字号、颜色、状态、动效和交互与 Electron 版一致。
AGENTS.md 里写下的界面细节（折叠规则、空状态、hover 显隐、触屏规则除外、各种「为什么这样」）就是行为规格，原样带过来。

关键决定：**gpui-kit 只提供交互骨架，不提供外观。** 它的默认样式不是 shadcn Nova，直接用就做不到 1:1。所以新增一层
`fv-ui`：把用到的 gpui-kit 组件（button、input、select、menu、popover、dialog、tooltip、tabs、switch、scroll 等）按
shadcn `base-nova` 的类名逐个重新上皮肤，视图代码只引用 `fv-ui`，不直接用 gpui-kit 的默认样式。

| 层 | 做法 |
| --- | --- |
| 设计 token | 间距、圆角、字号（Tailwind `text-xs/sm/base/xl/2xl`）、阴影、边框、动效时长全部从 Electron 版 `index.css` / Nova 组件里抄成常量表（`fv-theme::metrics`），视图不写魔法数字 |
| rem | 窗口 `rem_size` = 「界面字号」设置（默认 16px），所有尺寸以 rem 为单位，和 Electron 版一样整体缩放；容器查询断点同理按 rem |
| 字体 | 打包 Instrument Sans（OFL）与等宽字体；中文回落到系统字体（苹方），回落顺序与 Electron 版一致 |
| 图标 | Hugeicons 用到的那部分导出为 SVG 随包；文件图标沿用 `resources/file-icons`；供应商图标沿用 LobeHub 的 `currentColor` 路径，14px + 内缩留白的比例照旧 |
| 面板清单 | 先把 Electron 版每个面板列成清单（侧栏、转写各种 item、composer 及其面板、右侧各 tab、设置各 pane、插件页、命令面板、各种弹窗），每项记录：用到的组件、尺寸、状态、`mock.html` 预览参数 |
| 窄视口 | 手机已经走 Flutter 客户端，原生桌面版**不做**窄视口与触屏分支（drawer、`pointer-coarse`、master/detail 设置），这些规则不复刻 |

**怎么验证「1:1」，不靠肉眼：**

- Electron 版已有 `mock.html?…` 预览夹具（固定数据，覆盖几乎每个面板和状态）。原生版做一个同样的**夹具模式**，
  接受同名参数，加载同一份夹具数据，不连真实 server。
- 视觉回归：同一视口、同一主题、同一字号下，对 Electron（Chromium 截图）和 GPUI（离屏渲染或窗口截图）各出一张，
  逐像素比较并设容差（抗锯齿、字体栅格化差异）；超限的面板列入差异清单，逐项修或明确接受。每个里程碑把该里程碑范围内的面板
  纳入回归集，作为验收条件之一。（GPUI 的离屏截图能力需要在 M1 先验证，不行就用系统窗口截图。）
- 度量断言：对关键面板额外断言布局数值（侧栏宽、行高、composer 高度、转写正文列宽 `48rem` 等），比截图更稳。
- 已知做不到完全一致的地方（文字渲染引擎不同、`backdrop-filter`、CSS `mask` 与 `color-mix`）要提前登记，给出替代做法，
  不要在验收时才发现。

### 4.2 主题（皮肤）

Electron 版的皮肤 = 24 套 `ThemeSeed`（12 亮 12 暗）→ `buildTokens` 派生出完整 token 集 → 内联写到 `<html>`；
亮色与暗色各选一套，`themeMode` 为 light / dark / system；叠加「玻璃效果」「界面字号」两个正交的外观设置。
原生版完整保留这个模型，只换承载方式：

1. **`fv-theme` crate（不依赖 GPUI，可单测）**：把 `themes.ts` 的 `SEEDS`、`LIGHT_THEME_IDS` / `DARK_THEME_IDS`、
   `buildTokens`、`glassTokens` 逐函数移植成 Rust。输出一个强类型 `Tokens` 结构，字段与 CSS 变量一一对应
   （`background`、`foreground`、`primary`、`sidebar_*`、`warning/success/info`、`destructive(_foreground)`、`code_*`、
   `scrollbar_thumb`、`glass_pane`、`glass_overlay` …）。新增主题 = 追加一个 `ThemeSeed`，其它代码不动，规则不变。
2. **与 TS 版逐值对拍**：在 Electron 仓库里加一个脚本，把 24 套主题 × {实色, 玻璃} 的 `buildTokens` 结果导出成 JSON
   快照，提交进 `native/`；Rust 测试逐字段比较（颜色按 sRGB 容差，色彩空间运算以 TS 版为准）。以后任何一边改主题都会触发失败，
   两个实现不会悄悄分叉。
3. **运行时下发**：`Tokens` 放进 GPUI 的全局状态（`cx.set_global`），所有 `fv-ui` 组件按语义 token 取色
   （`cx.tokens().muted_foreground` 之类），**视图里禁止出现具体颜色值**，规则与 Electron 版「不得硬编码调色板」一致。
   切换主题 / 亮暗 / 字号只改全局并 `notify`，无需重建窗口，效果即时。
4. **gpui-kit 的主题结构**只当作一个下游：`fv-theme` 产出 `Tokens` 之后，由一个适配函数填充 gpui-kit 需要的主题对象，
   保证未被 `fv-ui` 重写的那部分组件也不会出现错色。
5. **system 模式**：监听系统外观变化（GPUI 的窗口外观观察），`themeMode = system` 时在 `lightTheme` / `darkTheme` 间切换。
6. **代码高亮**：`highlighter`（syntect）用的主题**由 `Tokens.code_*` 生成**，不另存一份，这样每套皮肤自动有对应的高亮，
   对应 Electron 版 `createCssVariablesTheme` 映射到 `--code-*` 的做法；diff 的增删底色同样取自 token。
7. **玻璃效果**：窗口创建时由设置决定是否带 `NSVisualEffectView`（`under-window`、`visualEffectState: active`）和透明底；
   `glassTokens` 把背景、侧栏、卡片、浮层改为带 alpha 的 token（背景 42% 暗 / 46% 亮，浮层 84% / 90%，数值照 AGENTS.md）。
   Liquid Glass 的高光边框、浮层内亮边用 GPUI 自绘（渐变描边 + 内阴影）近似，并登记为「近似项」。
   窗口透明与原生阴影能否兼得需在 M1 验证（Electron 版同样为保住阴影不用 `transparent: true`）。
   窗口不在前台时 macOS 会把 vibrancy 压成灰，这一点沿用「始终 active」的处理。
8. **设置项与持久化**：`lightTheme` / `darkTheme` / `themeMode` / `glass` / `uiFontSize` 放进新配置文件，
   由 server 持有并经 `config/*` 同步到所有 GUI 客户端（跨窗口同步规则照旧），Flutter 手机端另有自己的皮肤，互不影响。
9. **从 Electron 导入**：旧 `settings.json` 里的主题 id、亮暗选择、玻璃开关和字号随设置一并导入，主题 id 保持不变。
10. **主题选择器**：设置 → 通用 → 外观里的选择器按同样的预览样式重做，选项里的色块由 `fv-theme` 直接给出。

### 4.3 M1 技术验证结论（`native/crates/fv-gui`，2026-10-23）

| 问题 | 结论 |
| --- | --- |
| gpui-kit 0.8 能否起窗口 | 能。`gpui_kit::application().run` + `open_window`；底层是 `gpui-pre 0.3.9`（Zed GPUI 的发布版分支），Metal 渲染 |
| 玻璃（vibrancy） | `WindowBackgroundAppearance::Blurred` 即 `NSVisualEffectView`（`UnderWindowBackground`、`Active`，窗口失焦也不变灰，与 Electron 版一致）。窗口透明用 alpha 0.0001 的背景而不是 clear，**保住了原生阴影**——实机窗口（圆角、阴影、红绿灯、背后内容被模糊）已目视确认 |
| 红绿灯位置 | `TitlebarOptions{ appears_transparent, traffic_light_position }`，可设到 (24,24)，对应现有 `WINDOW_BUTTON_POSITION` |
| 离屏截图 | `Window::render_to_image()` 可用（Metal 渲染，2× 屏幕给 1920×1280）。**注意两点**：① 它在 `test-support` 特性后面，而经 `gpui-kit/test-support` 开启会把可选的 gpui-fast 后端拉进依赖解析并冲突，所以 `fv-gui` 的 `capture` 特性直接给 `gpui-pre` / `gpui-pre-macos` 开 `test-support`；② 截的是 GPUI 场景，**不含 NSVisualEffectView 的模糊**，玻璃主题的回归截图只能比对场景本身（半透明叠在固定底色上），模糊效果靠实机目检 |
| 主题 token → 画面 | `fv-theme` 的 token 直接转成 `Rgba` 使用，24 套主题的实色 / 玻璃都能画出；`GlassPane` 等玻璃专用 token 在实色下不存在，视图要有回退 |
| gpui-kit 默认外观 | `Button::primary()` 是黑底，不跟随主题——印证了需要 `fv-ui` 重新上皮肤 |
| 未验证 | 字体回退（目前用系统字体，未打包 Instrument Sans）、Liquid Glass 的高光描边自绘、`rem_size` 缩放 |

## 5. 数据迁移

首次启动检测到 `~/Library/Application Support/FastVibe/` 时，弹窗确认后导入，之后**不再读写旧目录**：

| 旧数据 | 去向 |
| --- | --- |
| `providers.json` + `agent/.env` + `agent/oauth.json` | 新供应商表 + 凭据文件（0600） |
| `mcp.json`、`settings.json`、`memory.json` | 新配置文件（字段名对齐，`remote*` 不导入，需重新设置） |
| `fastvibe.db`（会话目录、队列、DAG、定时任务、检查点、思考耗时、记忆账本） | 逐表转换 |
| pi v3 转写 JSONL | 转成新转写格式（沿用 `import/writer.ts` 已验证的配对规则，反向执行） |
| `memories/`、`tool-images/`、`usage-ledger.jsonl` | 复制 |

导入逐会话出结果（失败的列出原因），不做全有或全无；旧目录保持原样，可回退到 Electron 版。

## 6. 远程访问与手机端

远程访问不再是一套单独的协议：手机就是 app server 的另一个客户端（见第 1 节）。

- 局域网：`fv-transport` 的 ws 监听（`::` 双栈、密码换设备令牌、mDNS 广播 `_fastvibe._tcp`），帧就是 JSON-RPC 文本帧。
- 官方连接：WebRTC 数据通道（libdatachannel 的 Rust 绑定 `datachannel`，或 `webrtc-rs`；先验证 NAT 行为与现有一致），
  通道内容同样是 JSON-RPC。信令、STUN 计划、端口预测、NAT-PMP / UPnP、只在中转时压缩、背压与心跳等已测出来的规则全部保留。
- Flutter 端改为同一协议的客户端：从 `native/schema/` 生成 Dart 类型，换掉现在的 App Protocol 层；
  过渡期内手机端同时支持新旧两种服务端。

## 7. 里程碑

每个里程碑结束：`cargo fmt --check`、`cargo clippy -D warnings`、`cargo test` 全绿，真实启动窗口跑通，
且该里程碑范围内的面板通过与 Electron 版的视觉回归（见 4.1）。`fv-theme` / `fv-ui` / 视觉回归基础设施在 M1 就位，
M1 工期因此增加约 1–2 周；24 套主题与玻璃效果的**机制**在 M1 做完，M5 只剩设置页与主题选择器。

| 里程碑 | 范围 | 粗估 |
| --- | --- | --- |
| M1 第一条通路 | workspace、`fv-protocol` 骨架与 schema 导出、`fastvibe-server`（unix socket + stdio）、`fv-client`、`fv-daemon`；导入 providers；genai 四协议验证；read/write/edit/bash；回合循环、取消、重试、转写、会话目录；GPUI 窗口：侧栏、转写、composer、模型选择 | 4–5 周 |
| M2 对话体验 | Anthropic / Google；models.dev 与价格；上下文环与用量统计；压缩；排队与立即发送；重试 / 编辑 / 分叉；检查点回退；标题；回复推荐；todo / question；各种折叠与报错呈现 | 5–6 周 |
| M3 工作区 | 项目与多文件夹、`@` 搜索、右侧面板（文件树、预览编辑、终端、Git 变更 / 历史 / 提交）、worktree、apply_patch | 5–6 周 |
| M4 能力 | 子 agent、DAG、记忆、MCP、代码模式、工具搜索、技能、present / 内联预览、wry（浏览器 / HTML / Office / KaTeX）、computer-use、web_search、定时任务、goal、handoff | 6–8 周 |
| M5 外围 | 全部设置面板、24 套主题与玻璃、i18n、通知、Dock 角标、保持唤醒、命令面板、自动归档、账号、远程访问 + Flutter 适配、SSH 主机 Agent、从其他 Agent 导入、自动更新、签名打包 | 6–8 周 |
| M6 切换 | 全量数据导入、对照测试、灰度、Electron 版下线 | 2–3 周 |

合计约 6–8 个月（一人全职 + agent 辅助的估计）。M1 完成后可以作为内部日用版，逐步替代。

### 7.1 实现进度（`native/`）

M1 已完成：`fv-theme`（24 套主题，与 TS 版逐值对拍）、`fv-protocol`（含 schema 快照）、`fv-core`、
`fv-agent`（回合循环、工具读写锁并行、取消、历史规范化、假模型）、`fv-server` + `fv-client`（unix socket / stdio、握手、
策略表、订阅、`turn/start` / `turn/interrupt` 事件流、`thread/resume` 原子快照）、`fv-gui` 技术验证。

事件流的几条约定（测试里钉住了）：

- 每个线程一个单调 `seq`，应用事件、编号、算订阅者在同一把锁下完成；`thread/resume` 的快照与订阅同样在这把锁下，
  所以快照包含进行中的回复，之后的事件从 `seq + 1` 无缝接上，不重不漏。
- 「运行中」以 `thread/status/changed{running:false}` 为界，它**晚于** `turn/completed`：看到空闲的客户端一定已经看到这一轮的全部内容。
- 中断不是失败：`turn/completed.status = interrupted`，没有 Error item；写到一半的回复保留并收尾，所有已发出的工具调用都有结果
  （「被用户停止」），历史随时可以再发给模型。
- 慢订阅者超过 5 秒没腾出位置就被踢出该线程（`seq` 出现缺口，重新 `thread/resume` 即可），不拖累其他客户端。
- `thread/start` 与 `turn/start` 自动订阅调用者；没有订阅的连接收不到线程事件。

尚未做：真实 provider、`fv-store`（目录与转写目前只在内存）、转写落盘、重试、压缩、排队消息、steer、内置工具。

## 8. 风险

| 风险 | 应对 |
| --- | --- |
| wry 子视图与 GPUI 的叠放、焦点、滚动同步 | M4 前先做一周技术验证（浏览器面板 + browser-use 一个完整来回） |
| gpui-kit 0.x API 变动 | 锁版本；视图只经 `fv-ui` 包装 gpui-kit |
| 1:1 复刻达不到像素一致（字体栅格化、CSS 特性） | 视觉回归带容差 + 度量断言；差异清单逐项登记，近似项提前约定 |
| 主题两个实现分叉 | 导出 TS 版 token 快照，Rust 测试逐值对拍 |
| 玻璃效果在 GPUI 窗口里的实现 | M1 验证 vibrancy + 透明底 + 阴影能否兼得，不行则退化为纯实色并登记 |
| 终端渲染性能与输入法 | 参考 Zed 终端；M3 先测中文输入法与大量输出 |
| Markdown：原始 HTML、数学公式 | gpui-kit `text` 能画的直接画；`<details>` 等白名单标签自绘；公式交给 wry 或预渲染成图片 |
| genai 覆盖不到的协议细节或破坏性升级 | 锁版本；适配层隔离；录制 SSE 回放测试；必要时上游 PR 或在适配层直连 |
| server 与 GUI 版本不一致 | `initialize` 交换版本；不兼容时 GUI 等 server 空闲后重启它 |
| 功能面太大，长期双线维护 | Electron 版只修 bug 不加功能；新功能只进原生版 |
| 远程协议改版，手机端需同步发版 | 新旧协议在过渡期由手机端同时支持 |

## 9. 规则继承

AGENTS.md 里与框架无关的不变式原样带过来，例如：会话级调用带 `conversationId`；「运行中」以 settle 为界；
打开转写时补齐悬空工具调用；凭据不进 settings；提交信息一律英文；设置文案只写「做什么」。
与 pi SDK、Electron、React 绑定的规则（jiti 缓存、asar 补丁、shadcn、Base UI 分组陷阱、CSP）随旧实现作废。
