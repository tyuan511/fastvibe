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
| `fv-tools` | 内置工具，照 codex-rs `core/src/tools` 移植（见 3.4）：已有 `exec_command`、`apply_patch`；其余按 3.4 的清单逐个做 | portable-pty |
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

**工具集就是 codex 现有的那几个，直接照它实现，不再延续 Electron 版（pi）的旧工具。** 以 codex-rs `core/src/tools/` 为准
（`registry`、`router`、`parallel`、`handlers/*`，以及 `apply-patch`、`mcp` 相关 crate）：参数形状、执行语义、输出截断、错误文案、
取消与超时都对照移植，JSON schema 与说明文字也以它为起点。移植时在 `NOTICE.md` 记下来源文件与标签，保留 Apache-2.0；
codex 的现行版若绑定了它自己的内部 crate，就取最近一个自包含的标签（`apply_patch` 用的是 `rust-v0.46.0`）。
**读文件、列目录、搜索都不做专用工具**：codex 主线已经删掉了 `read_file` / `list_dir` / `grep_files`，一律走 shell。

下表按 codex 主线 `handlers/` 的清单列出（名称开工前逐个对照源码核实）：

| 工具 | codex 对应 | 状态 / 说明 |
| --- | --- | --- |
| `exec_command`、`write_stdin` | `shell_spec` / `unified_exec`：命令可转后台，返回 session id，再用 `write_stdin` 写入或轮询；可选 pty | `exec_command` 已做（跑到结束或超时）；会话式进程与 `write_stdin` 随 pty / 终端面板一起做。去掉沙箱与审批那一层（`with_escalated_permissions` 等） |
| `apply_patch` | `apply-patch` crate | 已做。唯一的编辑工具（新建 = Add File，整文件替换 = Delete + Add）；与 codex 的差异：全部能应用才写盘 |
| `update_plan` | `plan` | 已做。工具只校验形状并回 `Plan updated`；清单在调用参数里，server 额外发 `turn/plan/updated`（整张清单，不是差量）给在看的客户端 |
| `request_user_input` | `request_user_input` | 已做。工具把回合停住，server 向客户端发 `item/question/request`（服务端请求），回答作为工具结果（codex 的 JSON 形状）；客户端总是加一个自由输入的 Other |
| `view_image` | `view_image` | 已做。大图先缩小再发（长边 > 2000px 或 > 1 MB → 1568px，有透明保留 PNG，否则 JPEG）；图片落盘，转写只存路径 |
| MCP 工具与资源 | `mcp`、`mcp_resource`（`list_mcp_resources`、`list_mcp_resource_templates`、`read_mcp_resource`），`rmcp` | 待做。每引擎连一次、所有会话共享 |
| `tool_search` | `tool_search` | 已做（BM25）。codex 靠 Responses API 自带的延迟加载，这里改为通用做法：延迟工具不进请求，搜到才声明；暂时没有延迟工具（MCP 之后才有），此时它自己也不出现在请求里 |
| 子 agent | `multi_agents`（`spawn_agent`、`send_input`、`wait`、`close_agent`、`resume_agent`） | 待做。进程内起一次性会话，沿用它的 agent 控制模型 |
| 代码模式 | `code_mode`（执行与 `wait`） | 待做。沙箱、`tools.<name>()` 绑定和输出规则以它为准，运行时选型开工前对照上游定 |
| `web_search` | 模型端托管的搜索 | 待做。仅在 Responses 协议下透传 |
| 其它小工具 | `get_context_remaining`、`new_context_window`，`sleep`、`current_time` 等 | 按需。`request_permissions`、插件安装类不做（没有审批，也没有插件系统） |

**不再做的旧工具**（Electron 版有、codex 没有）：`present`、`dag_*`、`conversation_search`、`worktree`、`schedule_*`、
`browser_*` / `computer_*`、app config 工具，以及 `read` / `write` / `edit` / `ls` / `grep` / `find`。界面需要区分「读取 / 搜索 / 写入」
这类类别时，按**命令内容**识别（`cat`、`sed -n`、`rg`、`grep`、`ls`…），不靠工具名；Windows 上的等价命令做 Windows 时再处理。
协议里的 `item/tool/call`（服务端请求客户端执行的工具）保留，对应 codex 的动态工具，将来要接 GUI 能力时用得上。

执行层同样照搬 codex：`ToolRegistry` 按名字派发，`parallel.rs` 的读写锁让只读工具并发、改动类工具串行，工具自己声明是否支持并行调用。
检查点的「写入前捕获」挂在 `apply_patch` 与 shell 的变更事件上（patch 在应用前已解析出受影响文件，天然适合）。

会话标题、输出语言、AGENTS.md / 技能的发现、长期记忆这类**回合钩子**，也参照 codex 的同类机制（`agents_md.rs`、`memories`）取舍，
不再有插件 API；`goal`、`handoff` 这些 pi 扩展功能不再作为目标，需要时再单独评估。

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
| 未验证 | Liquid Glass 的高光描边自绘、`rem_size` 缩放 |

### 4.4 主界面第一版复刻（2026-10-24）

侧栏、会话标题栏、转写、composer、新对话页已按 Electron 版的类名逐项复刻，用夹具与 `mock.html` 同数据截图对照
（`native/scripts/compare-ui.sh OUT [light|dark]`：同为 1100×720@2x；Electron 用 headless Chrome 截 `mock.html`，
原生用 `fastvibe --fixture theme|new`，夹具内容抄自 `mock/preview-data.ts`）。亮色 `github-light`、暗色 `tokyo-night`
（预览的暗色场景）下，侧栏逐行位置一致，转写与 composer 的宽度、圆角、间距、字号一致。

- **字体**：Instrument Sans 由 Google Fonts 的可变字体实例化为 400/500/600/700 四个静态 TTF 随包（GPUI 不吃 woff2、
  也不按可变轴选字重）。等宽 SF Mono 在 macOS 上藏在 Terminal.app 里、未注册为系统字体，启动时从那里加载。
- **图标**：`native/scripts/export-icons.mjs` 把渲染层 import 的 Hugeicons（`strokeWidth` 2）导出为 SVG；文件图标直接嵌入
  仓库里的 `resources/file-icons`（两版共用一份），解析规则移植自 `shared/file-icons.ts`，彩色图形走 `img()` 而非单色 `svg()`。
- **协议补充**：`Turn` 增加 `startedAt / processEndedAt / completedAt`，`TurnRef / ItemRef / TurnCompleted` 带 `at`
  （服务端时钟）；重开会话时由转写每行已有的时间戳还原。转写据此画「用时」（到答案开始）、悬停时的时间与「耗时」。
- **GPUI 坑**：`Textarea` 的字号是其 size 的 0.875、且自带内边距，按 `Size::Size(16)` 设置并在外层扣掉；离屏截图只截上一帧
  场景，截图前要主动 `window.draw` 几次；`ScrollHandle::scroll_to_bottom` 要等有过布局的那一帧。
- **设置（2026-10-24）**：侧栏「设置」、composer 模型菜单的「管理模型」进入设置；左侧分组列表照 `SETTINGS_SECTIONS`。
  **模型与默认**已可用：会话模型（默认模型 + 推理强度）、供应商列表（启用开关、删除、展开改 Base URL / API 格式 / 密钥、
  模型列表的增删与同步）、添加供应商对话框（内置供应商表 + 自定义；确认后拉取模型、勾选、保存；第一个供应商的第一个模型
  自动成为默认模型）。全部走现有 `provider/*`、`model/*` 协议。内置供应商表是 GUI 里的一张静态表（名称、协议、地址），
  不是 Electron 版那样从 SDK 读取，订阅登录（OAuth）还没有。其余分组的页面暂时显示「这一页还在移植中」。
  开发构建（`capture` 特性）有 `--script-add NAME,URL,KEY` 和 `--settings providers|add-provider`，用来不点鼠标地走完添加流程并截图。
- **弹出层（2026-10-24）**：菜单一律用 `ui::float`（`deferred` + `occlude`，优先级 10）画在整个窗口最上层，否则它是卡片的子元素，
  会被卡片的边框和聚焦环盖住（看起来像透明）。任一弹出层打开时，窗口根上多一块全屏的接收层（优先级 5），点任何别处就关闭全部菜单
  （`any_menu_open` / `close_menus`）。内置供应商已移除，添加供应商只有自定义一种。
- **共享设置与会话操作（协议新增）**：`settings/get|set` + `settings/changed`（主题模式、亮/暗主题、玻璃；存一份 JSON，多个客户端同步），
  `thread/update`（改名、归档、置顶）、`thread/delete`（连转写与图片一起删，运行中的先停），`project/list|add|remove`（项目是用户加的文件夹，
  在其中开会话会自动加入）。`Thread` 多了 `pinned`。GUI：偏好设置页的外观、归档对话页（恢复 / 确认后删除）、侧栏置顶分组、
  行上悬停的置顶与归档按钮、右键菜单（重命名 / 置顶 / 归档）、原位重命名、「+」选文件夹添加项目、项目行的新对话与移除、
  转写里的思考与工具调用可点开（命令、补丁按增删着色、输出）。
- **发送、快捷键、搜索（2026-10-24）**：发送失败不再静默——文字放回输入框并在输入框上方说明原因，没有任何模型时直接提示去
  设置 → 模型与默认。快捷键：⌘N 新对话、⌘, 设置、⌘K 搜索、⌘Q 退出、Esc 依次关菜单 / 搜索 / 对话框 / 设置；macOS 菜单栏有对应条目。
  ⌘K 搜索按标题找对话并列出「新对话 / 设置」两个命令（正文搜索要服务端新增读转写的调用）。输入框左侧的上下文环按
  `thread/tokenUsage/updated` 画：70% 变警告色、90% 变危险色。开发构建加了 `--script-send TEXT` 走一遍真实发送并截图。
- **还缺（需要新的协议数据或组件）**：标题栏与新对话页的 git 分支 / 改动 chip、composer 的上下文环、压缩分隔线的
  「接近上限 · 128.0K → 24.4K」、工具卡展开后的详细样式、各种弹出菜单的 Nova 皮肤、右侧面板与设置页。

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

**Provider（`fv-provider`，genai 0.7.0 锁精确版本）**：

- 一个 `GenaiModel` 对应一个配置好的模型，协议、端点、密钥都由我们给 genai 的 `ServiceTargetResolver`，不让它按模型名猜适配器、不读环境变量。
- **genai 的 base URL 要带版本段**（它只在后面拼 `messages` / `chat/completions` / `models/…`），和 pi 的客户端相反，所以
  `engine_base_url` 重新翻译：Anthropic 补 `/v1`（用户已给的 `…/v4` 保留），Google 把 `/v1` 换成 `/v1beta`，OpenAI 两种原样，一律补尾斜杠。
- 思考签名（Anthropic signature、Responses encrypted_content、Gemini thought signature）存在 `ContentBlock::Thinking.signature`，
  回放时**只发给写它的那个模型**（`AssistantMessage.model`），换模型后丢弃，否则上游会拒绝。
- 用量：genai 的 `prompt_tokens` 含缓存，换算成 FastVibe 的「不含缓存的输入」，缓存命中率才有意义。
- **重试**：429 / 5xx / 408 / 409 / 断线，在**还没有任何内容到达之前**按指数退避加抖动重发（默认最多 5 次，优先用 `retry-after`）；
  有内容之后的失败交给调用方，不重放半条回复。genai 把 HTTP 错误放在流的第一个有意义的元素里（`Start` 先于状态码到达），所以先读到那一个再决定。
  `WebStream` 包着真正的错误，必须拆开判断，否则 401 也会被当成可重试。
- 已知风险：genai 的 Responses 流式解析要求 `response.completed` 里有 `model` 字段，缺了会**静默丢掉工具调用**（只打 warn）。
  离线测试用的 SSE 是手写的，不是录制的；**真实供应商验证用 `cargo run -p fv-provider --example live`**（密钥走 `FV_API_KEY`）。

**真实验证（2026-10-23，FastVibe 中转站 `deepseek-v4.1-flash`）**：`chat` 与 `responses` 两种协议都跑通了完整回合
（工具调用 → 结果 → 续答，用量含缓存读取），经 `fastvibe-server` 端到端（stdio）也通，重启后目录、转写和快照都恢复。观察到的事实：

- 该中转站的 `responses` 协议会流出思考文本，但**不返回 `encrypted_content`**，所以思考块没有签名；没有签名的思考不回放（见上），第二轮仍能引用第一轮的内容。
- `chat` 协议加了 `reasoning_effort` 也没有流出 `reasoning_content`：这个模型走 chat 路由时不输出思考。
- 手写的 SSE 夹具与真实流在这两个协议上没有分歧；Anthropic 与 Gemini 仍只有手写夹具。

**内置工具（`fv-tools`）**：`apply_patch`、`exec_command`，参数形状、限制和输出格式照 codex
（来源与改动逐项记在 `crates/fv-tools/NOTICE.md`，Apache-2.0）。

- **`apply_patch`**：vendor 了 `rust-v0.46.0` 的 parser 与 `seek_sequence`（连同它们的上游测试），因为现行版已绑定 codex 自己的路径库。
  与 codex 的**一处行为差异**：补丁先对每个文件在内存里算出结果（后一个 hunk 能看到前一个的修改），**全部成功才写盘**，
  codex 是边算边写，失败时留下一半。接受相对路径（相对线程工作目录）和绝对路径；没有工作目录时相对路径直接拒绝，不猜。
  codex 的 freeform（自定义工具语法）形式 genai 表达不了，所以用 JSON 函数 `{input}`，也容忍模型直接传裸字符串或 `<<'EOF'` 包装。
- **`exec_command`**：进程组启动，超时或调用被丢弃（用户停止回合）时杀掉**整个进程组**；两路输出按到达顺序合并；
  内存里只留头 2 MiB 加尾 2 MiB，给模型的部分用 codex 的 `truncate_middle` 按 token 预算（默认 10000，4 字节一个）截中间；
  命令退出后只再等 300 ms 收尾，后台进程握着管道不会挂住调用。
  **与 codex 的差异**：命令跑到结束或超时（默认 120 s），没有「超过 `yield_time_ms` 返回 session id、再用 `write_stdin` 轮询」；
  那一套要 pty，随终端面板一起做。因此基础提示词里写明「不要用它起服务或 watcher」。
- 每个线程用自己的工作目录（`Thread.cwd`），基础提示词 `fv_agent::base_instructions` 自写（不照搬 codex 的），说明工具用法与工作目录。
- **真实验证**：FastVibe 中转站的 `deepseek-v4.1-flash`，`responses` 与 `chat` 两种协议下都完成了
  「新建文件 → 修改文件 → 运行验证 → 汇报」，以及「列目录 → 找关键字 → 读文件」（后一项是在还有 `read_file` / `grep_files` 时测的；去掉专用工具、全走 `exec_command` 后重测见下）。
- 这一轮顺手抓到并修了两处：`Item` 与 `Message` / `ContentBlock` 的枚举变体字段是 snake_case（`is_error`），
  与其它协议类型的 camelCase 不一致，会让手机端的类型对不上，现用 `rename_all_fields` 统一；
  `main` 里工具没注册上，是因为替换没匹配却没有断言——现在 server 的 agent 由 `agent_with_builtin_tools` 一处构造，主程序与测试共用。

**计划与提问（`update_plan`、`request_user_input`）**：

- **服务端请求机制**（`ServerRequest` 不再是空枚举）：server 以 JSON-RPC 请求发给客户端，客户端用同 id 的**响应**回答，或用**错误**拒绝；
  `fv-client` 新增 `take_requests()` / `respond()` / `decline()`。工具通过 `ToolCtx.ui`（`fv_agent::UserInput`）提问，与传输无关，没有 UI 时返回「没有可答复的客户端」。
- **提问不绑定某个客户端**：请求发给当时订阅该线程的所有连接；先答的生效，随后发 `serverRequest/resolved`（带 `seq` 的线程事件）让其余客户端收起面板，
  迟到或重复的回答被忽略。客户端断开不取消提问——请求留在服务端，**之后任何客户端 `thread/resume` 都会在回复之后被重放同一个请求**（同一 id，谁都能答）。
- **停止回合会撤回提问**：工具 future 被丢弃时，`Withdraw` 在析构里同步摘掉待答项并通过通道交给回合驱动器，驱动器**先**发 `serverRequest/resolved`、
  **再**发 `turn/completed`，不会留下一个没人在等的问题；析构里不做 await，所以不会晚于「空闲」。
- 拒绝（错误响应）也让回合继续：模型收到「was cancelled before receiving a response」。
- 一路抓到的：`thread/start` 按文档应订阅调用者，但上一轮的替换因格式化没匹配而静默失败了，这次补上并修正了对应测试；
  `register_builtin` 同样漏过一次，现在有 `tests/registry.rs` 钉住注册清单（按名字排序），不会再静默。
- **真实验证**（`deepseek-v4.1-flash`，`responses`）：模型先 `update_plan` 列 2 步，再 `request_user_input` 问文件名（选项 `a.txt (Recommended)` / `b.txt`），
  收到回答 `b.txt` 后用 `apply_patch` 建了 `b.txt`，并把计划更新为全部完成。

**图片（`view_image`）与延迟工具（`tool_search`）**：

- **图片放在哪**：provider 的工具结果只能是字符串（genai 的 `ToolResponse` 如此，OpenAI chat 的工具消息也不能带图），
  所以图片作为新的消息 `ToolImages` **紧跟在这一批全部工具结果之后**，转成一条用户消息；若插在两个工具结果中间，OpenAI 会因工具消息被打断而拒绝。
  四种协议的请求形状都有测试：chat 的 `image_url` data URL、responses 的 `input_image`、anthropic 的 `image` block、gemini 的 `inline_data`。
- **转写只存路径**：内存里是 base64，`persist` 落盘前由 `ImageStore` 写成 `tool-images/<会话>/<id>.<ext>`（0600/0700），转写行里是 `File{path}`；
  重启后请求构建时再读文件。文件没了就换成一句「图片已不可用」，不丢整条请求。这是吸取 Electron 版 82 MB 转写的教训。
- **模型看不了图**：`Model::supports_images()` → `ToolCtx.vision`；`view_image` 用 codex 原话拒绝，已有的图片换成一句说明。命令行 `--no-images`。
- **延迟工具**：`Tool::deferred()` 的工具不出现在请求里，也不能被调用（报「not loaded yet，先用 tool_search」）；`tool_search` 搜到后写进线程的
  `LoadedTools`，之后整个线程都继续声明它们（提示词缓存友好）。重启后需要重新搜索（未持久化）。
- **真实验证**（`deepseek-v4.1-flash`，`chat`）：模型 `view_image` 一张纯红 PNG，答「整张图是纯红色」；第一次给错路径时自己查目录后改正。

**供应商与模型配置（经协议，`provider/*`、`model/*`）**：

- **方法**：`provider/list`、`provider/upsert`、`provider/delete`、`provider/reorder`、`provider/fetchModels`、`model/list`、`model/defaults/get|set`、
  `thread/model/set`；变更后广播 `providers/changed`，各客户端重读 `model/list`。会话的模型是 `provider_id/model_id`，存在 `Thread.model` / `Thread.thinking` 上。
- **密钥只写不读**：`ProviderInfo` 没有密钥字段，只有 `hasKey`；`upsert` 的 `apiKey` 缺省 = 保留原值、空串 = 清除、其它 = 替换。
  密钥在 `credentials.json`（0600，临时文件 + fsync + rename 整体替换，**读不出来就报错而不是当空文件**，否则下一次写入会毁掉没人读过的密钥），
  数据库里没有，协议里没有任何方法返回；删除供应商时一并删掉它的密钥，以及指向它的默认模型。测试直接扫数据库字节和响应 JSON 里有没有密钥。
- **模型怎么选**：会话自己的 → 默认的 → 还没配任何供应商时用服务器启动时给的那个（命令行或测试）；配了供应商却没选，回合以
  「No model is selected…」失败，而不是猜一个。模型不可用（供应商没了、被关、没密钥、模型不在列表里）同样让**回合失败并说明原因**，不是断连；
  设置时（`thread/start`、`thread/model/set`、`model/defaults/set`）会先校验，不可用的直接拒绝。
- **协议判定**：模型自己的 `protocol` 优先，否则按 id 推断（`claude-*` → Anthropic、`gemini-*` → Google，供应商已说那个协议则不改）。
- **拉模型列表**（`provider/fetchModels`）：已存的供应商用它的密钥，表单里新输入的密钥优先，没存的供应商用传来的协议、地址、密钥；
  三类接口（OpenAI 风格 `/models`、Anthropic `/v1/models`、Google `/v1beta/models`，过滤掉不能 `generateContent` 的），兼容中转站的 `{models:[]}` 与裸数组形状。
  **远程连接一律拒绝这个方法**（它会让本机去请求调用方指定的地址）；其余 provider 方法远程可用。
- **存储**：schema 迁移到 2（`providers`、`settings` 两张表，旧库原地升级，旧会话新字段取默认）。
- **真实验证**（FastVibe 中转站）：不带任何模型参数启动 → 拉到 40 个模型 → 保存 → 设默认 `fastvibe/deepseek-v4.1-flash` + high → 重启后新建会话直接跑通一轮；
  响应里没有密钥，`credentials.json` 为 0600，数据库字节里没有密钥。
- 还没做：模型元数据（上下文窗口、价格、是否看图——要等 models.dev 快照，现在 `supportsImages` 默认 true、窗口为空）、
  把 `ProviderUpsert` 的 OAuth 登录式供应商、命令行 `--protocol` 等参数现在只是没配供应商时的后备。

**上下文压缩（`fv-agent::compact`，`thread/compact/start`）**：照 codex 的内联压缩（`rust-v0.46.0` 的 `codex/compact.rs`）做，提示词和桥接文案取自它的模板（Apache-2.0）。

- **触发**：每次请求前，用「provider 报告的上一次请求用量 + 其后新增内容的估算（4 字节一个 token）」判断，达到窗口的 **90%** 就先压缩；
  窗口取 `Model::context_window()`（来自 `ModelInfo.contextWindow`），不知道时按 128k。provider 报「请求超窗」（`ModelError.overflow`，按各家的措辞识别：
  `context_length_exceeded`、`prompt is too long`、`token count … exceeds`、413 等；429 的 token 限流**不算**，那是等一等的事）时也压缩一次再重试，
  压缩后仍然超窗就如实失败，不循环。
- **做法**：让同一个模型按 codex 的「写给下一位 agent 的备忘录」提示写摘要（不带工具），历史换成一条 `Message::Compaction { user_messages, summary }`。
  模型看到的是**一条用户消息**：用户原话（累计，超过约 2 万 token 时取头尾、截中间）+ 摘要。因为 `user_messages` 随每次压缩累计，**用户的原话压缩多少次都留着**。
  摘要请求自己超窗时，和 codex 一样**从最旧的消息开始丢再问**（每次丢完重新规整，孤儿工具结果不留）。
- **落盘与恢复**：`Compaction` 是转写里追加的一行，之前的消息**全部还在**（界面照常显示，中间画一条「已压缩上下文」分隔）；
  重启后 `effective_history`（最后一条 `Compaction` 起）才是送给模型的历史。内存里的历史与重启后重建的一致，有测试钉住。
- **失败与停止**：摘要失败或用户停止，历史**原样不动**（只发 `CompactionFailed` 收起进行中的条目），自动压缩失败时该回合失败并说明原因。
- **手动**：`thread/compact/start` 是一个独立的回合（`turn/started` → 压缩条目 → `turn/completed`），可 `turn/interrupt`；线程忙返回 `THREAD_BUSY`，没有历史返回「nothing to summarize」。
- **上下文环**：每次请求后发 `thread/tokenUsage/updated {used, window}`（带 `seq` 的线程事件），`thread/resume` 的回复里也带一份。
- **真实验证**（`deepseek-v4.1-flash`，窗口设成 5000）：几轮长回复后自动压缩多次触发，最后问「项目叫什么、最爱的颜色、灯塔管理员是谁」仍答对。
- 注意：窗口很小时系统提示与工具说明本身占 ~2.8k token，所以会每轮都压缩；真实窗口（128k 以上）下不会。还没做的是 Electron 版那套「按被拒绝的请求学习实际容量、缩小触发阈值」的自适应，以及按提供方的真实窗口（models.dev）填 `contextWindow`。

**存储（`fv-store`）**：`fastvibe.db`（目录，`PRAGMA user_version` 迁移、0600、`auto_vacuum` 先于 WAL、高版本拒绝打开）+
`sessions/<id>.jsonl`（只追加，首行 header，之后每行一条消息并用 `parentId` 串成链）。写入跟着 agent 的 `Committed` 事件走：
消息进入历史的那一刻就落盘（`sync_data`），崩溃最多丢当前这一条，写到一半的末行读取时跳过、下次追加前补换行。
重启后线程的历史从转写读回，`turns_from_history` 用位置派生 id（`t3`、`t3i7`）重建快照，所以同一份转写总得到同样的 id。
首个提示词的第一行（最多 60 字）作为线程标题。

尚未做：重试之外的恢复（压缩、排队消息、steer）、内置工具里的 todo / question / present 等、provider 配置经协议下发（目前只有命令行 `--protocol/--base-url/--model-id`，密钥走 `FV_API_KEY`）、
失败的回合在重启后不再显示错误项（错误没有对应的消息）。

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
