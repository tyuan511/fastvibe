# FastVibe Native（Rust + GPUI）重写方案

目标：用 Rust 重写整个桌面端，界面用 GPUI + gpui-kit（0.8），agent 引擎自研（设计借鉴 openai/codex 的
`codex-rs`，Apache-2.0），不再依赖任何 `@earendil-works/pi-*` 包；功能对齐现有 Electron 版（约 11.5 万行 TS/TSX）。

## 0. 已定前提

| 问题 | 决定 |
| --- | --- |
| 代码位置 | 本仓库 `gpui` 分支，`native/` 下的 Cargo workspace；Electron 版继续可发布，直到原生版追平 |
| 旧 Electron 数据 | **最后实施**一次性导入（providers / API Key / MCP / 设置 / 会话目录 / pi v3 转写 / 用量账本）；不作为前期功能的依赖，导入后只用新格式 |
| 手机端与远程协议 | 按当前原生 App Server / `fv-protocol` 重新设计，Flutter 同步适配；不兼容旧 Electron / App Protocol，不做新旧双栈 |
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
  `cargo dev`（仓库根和 `native/` 下都能运行：两处各有一份 `.cargo/config.toml` 别名，而 xtask 按自己所在的 crate 定位工作区、
  用 `--manifest-path` 调 cargo，所以调用目录不参与解析）构建后比较本次服务端二进制的开发 identity 与握手中运行进程的报告：相同直接复用；
  不同且没有回合运行时，停止本次数据目录下的旧 server、等它退出再启动 GUI。有回合运行或旧服务端无法报告状态时保留旧进程并提示，绝不因开发启动而中断会话。直接运行 GUI 仍复用常驻 server。
- 「退出 FastVibe」= 停 server（有运行中的任务先确认）；只关窗口不停 server。是否在没有窗口时继续常驻是一个设置项
  （默认：有定时任务或远程访问开着时常驻）。
- **同一个二进制也是 SSH 主机上的 Agent**：远端跑 `fastvibe-server --listen stdio`，经 `ssh` 的 stdio 直接连，
  不再需要 SSH 端口转发 + 回环令牌那一套。
- 测试与 CLI 可以用 in-process 模式（同一协议，内存 channel），codex 的 `in_process.rs` 同样做法。

### 1.2 协议（`fv-protocol`）

- **JSON-RPC 形状**（不带 `"jsonrpc":"2.0"`，与 codex 一致）：`Request{id, method, params}` / `Response{id, result}` /
  `Error{id, error{code, message, data}}` / `Notification{method, params}`。
- **分帧**：stdio 与 unix socket 一行一条 JSON；WebSocket 一条消息承载一个协议对象。WebRTC 的分片、重组与压缩在新的传输适配层设计并协商，重组后交给同一个协议分发器；不要求沿用旧分片头、尺寸或压缩位。
- **方法表由宏生成四个枚举**：`ClientRequest`、`ServerNotification`、`ServerRequest`、`ClientNotification`
  （codex `app-server-protocol/src/protocol/common.rs` 的做法），新增一个方法只改一处，编译器保证 server 处理了它，
  策略表用 `match` 穷举，漏分类编译不过。
- **类型导出**：`schemars` 生成 JSON Schema 并提交进仓库（`native/schema/`），Flutter 端从 schema 生成 Dart 类型；
  GUI 直接用 Rust 类型。协议快照测试防止无意的破坏性改动。实验性方法用 `#[experimental]` 标注，握手声明后才可用。
- **数据模型 Thread → Turn → Item**（codex `protocol/v2`）。FastVibe 的「会话」= thread，「一轮」= turn，
  Item 至少有：`UserMessage`、`AgentMessage`、`Reasoning`、`ToolCall`（exec_command/write_stdin/apply_patch/MCP/…，按工具族带结构化详情）、
  `FileChange`、`Todo`、`Question`、`Subagent`、`Present`、`ContextCompaction`、`ModelSwitch`、`Error`。

方法架构草案（节选，包含未实现项；当前可调用方法以 `native/crates/fv-protocol/src/methods.rs` 为准）：

| 类别 | 方法 |
| --- | --- |
| 握手 | `initialize` → `initialized`（客户端名、能力、是否接收实验方法、退订哪些通知） |
| 会话 | `thread/list` `thread/start` `thread/resume` `thread/read` `thread/fork` `thread/archive` `thread/delete` `thread/name/set` `thread/unsubscribe` `thread/search` |
| 回合 | `turn/start` `turn/steer` `turn/interrupt` `turn/continue` `turn/retry` `thread/compact/start` |
| 队列 | `thread/queue/list` `thread/queue/add` `thread/queue/reorder` `thread/queue/sendNow` `thread/queue/remove` |
| 工作区 | `project/*` `fs/readDir` `fs/readFile` `fs/writeFile` `fs/createEntry` `fs/renameEntry` `fs/deleteEntry` `fs/search` `git/*` `terminal/*` `office/*` |
| 配置 | `provider/*` `model/list` `config/read` `config/write` `mcpServer/*` `skill/*` `memory/*` `schedule/*` |
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
5. 有工具结果 → 回到 2；模型自然结束 → 回合结束；之后检查排队消息，全部完成才发 `Settled`。
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
| `exec_command`、`write_stdin` | `shell_spec` / `unified_exec`：命令可转后台，返回 session id，再用 `write_stdin` 写入或轮询；可选 pty | 已接通会话池、真实 PTY、增量输出、超时与取消。每个 ThreadRuntime 独立持有；保留现有沙箱与审批；Windows PTY 随平台交付补齐。验证见 native-completion.md |
| `apply_patch` | `apply-patch` crate | 已做。唯一的编辑工具（新建 = Add File，整文件替换 = Delete + Add）；与 codex 的差异：全部能应用才写盘 |
| `update_plan` | `plan` | 已做。工具只校验形状并回 `Plan updated`；清单在调用参数里，server 额外发 `turn/plan/updated`（整张清单，不是差量）给在看的客户端 |
| `request_user_input` | `request_user_input` | 已做。工具把回合停住，server 向客户端发 `item/question/request`（服务端请求），回答作为工具结果（codex 的 JSON 形状）；客户端总是加一个自由输入的 Other |
| `view_image` | `view_image` | 已做。大图先缩小再发（长边 > 2000px 或 > 1 MB → 1568px，有透明保留 PNG，否则 JPEG）；图片落盘，转写只存路径 |
| MCP 工具与资源 | `mcp`、`mcp_resource`（`list_mcp_resources`、`list_mcp_resource_templates`、`read_mcp_resource`），`rmcp` | 核心已接通：每引擎共享 stdio/HTTP 连接、工具快照、延迟搜索、资源和分页。字段表单、动态目录、诊断、图片产物、OAuth/刷新及客户端回调已接通；安装环境与最终验收见 native-completion.md |
| `tool_search` | `tool_search` | 已做（BM25）。codex 靠 Responses API 自带的延迟加载，这里改为通用做法：延迟工具不进请求，搜到才声明；MCP 的延迟工具已接入；没有任何延迟工具时，搜索工具自己也不出现在请求里 |
| 子 agent | `multi_agents`（`spawn_agent`、`send_input`、`wait_agent`、`close_agent`、`resume_agent`），加 `list_agents` | 已接通独立上下文子会话、原生回合引擎、持久化、限额、停止/恢复与任务列表。已接通历史 fork、角色模板/模型/工具范围、只读约束及后代工具授权上限；不迁移旧 `dag_*` 工具 |
| 数学公式 | Markdown AST 的 math text / math flow + 原生公式节点 | 行内/块级 TeX 已接通，常用符号与安全降级已验证；复杂 KaTeX 宏仍待评估 |
| 代码模式 | `code_mode`（执行与 `wait`） | 原生基础已接通：QuickJS 隔离模块、授权工具绑定、打印/图片/音频/存值、增量等待、取消与真实进程生命周期、审批/角色约束及记录；采用普通 JSON `code` 参数适配所有现有协议。验证见补齐清单第二十三、二十九批 |
| `web_search` | 模型端托管的搜索 | 已接通自定义 Responses 模型按需开启、角色授权、进度/来源/引用、取消、历史恢复和分叉；不执行本地搜索或伪造函数结果。验证见补齐清单第二十四批 |
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
| 浏览器、HTML/Office 预览、KaTeX | `fv-gui` 内的 wry 子视图，覆盖在 GPUI 元素区域上 | macOS 浏览器基础、HTML/媒体及 Office 静态/实时预览已接通，含坐标/裁切、焦点、遮挡和恢复；数学公式已接入原生 Markdown 节点与安全降级，复杂 KaTeX 宏及完整浏览器功能仍待补齐，Office 资源封装与签名随交付验收 |
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
   原生浮层经 `Palette::overlay()` 加厚为 96% 暗 / 98% 亮：Electron 还有 28px 的浮层背板模糊，而原生窗口的 vibrancy
   只模糊桌面，无法消除窗口内正文的透字。菜单、对话框与组件库 tooltip 共用这一个适配后的底色；共享主题 token 保持与 Electron 一致。
   Liquid Glass 的高光边框、浮层内亮边用 GPUI 自绘（渐变描边 + 内阴影）近似，并登记为「近似项」。
   吸顶提示词的带子同理：GPUI 没有逐元素的渐变/alpha 遮罩，Electron 版「pin 行不画底色、回复用 `mask-image` 在行底切断」
   （`GLASS_CUT_FEATHER`）无法复刻，改为整条带子铺 `Palette::overlay()` 的浮层色、回复在带子底边硬切断，登记为「近似项」。
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
- **吸顶提示词**（`workspace/sticky.rs`）：滚动时最近一条滚出视口的用户提示词 pin 在转写顶部（Electron 版
  turn-scoped sticky：只在自己回合内生效、被下一回合提示词顶起、两回合的间隙里不 pin）。GPUI 没有 `position: sticky`，
  做法是「第二份副本」：每个回合wrapper 与它的提示词行各埋一个 `canvas` 度量，prepaint _bounds 减 `window.element_offset()`
  与滚动容器 `bounds()` 原点得内容坐标，按回合索引记进 `Workspace.sticky`；下一帧据此与当前 `scroll.offset()` 算出 pin 位，
  把绝对定位的提示词副本画成滚动容器最后一个孩子，流内那份 `.invisible()`。副本的元素 id 带 `-pin` 后缀避免与流内副本
  撞 GlobalElementId。纯函数与坐标换算各有单测（含一个无头 GPUI 用例钉住「滚动后区间不变」）。
- **设置（2026-10-24）**：侧栏「设置」、composer 模型菜单的「管理模型」进入设置；左侧分组列表照 `SETTINGS_SECTIONS`。
  **模型与默认**已可用：会话模型（默认模型 + 推理强度）、供应商列表（启用开关、删除、展开改 Base URL / API 格式 / 密钥、
  模型列表的增删与同步）、自定义供应商对话框（填写地址、协议和 API Key 后拉取模型、勾选、保存；第一个供应商的第一个模型
  自动成为默认模型）。全部走现有 `provider/*`、`model/*` 协议。按 2026-10-26 用户要求，模型订阅登录不在原生版范围内。其余分组的页面暂时显示「这一页还在移植中」。
  开发构建（`capture` 特性）有 `--script-add NAME,URL,KEY` 和 `--settings providers|add-provider`，用来不点鼠标地走完添加流程并截图。
- **弹出层（2026-10-24）**：菜单一律用 `ui::float`（`deferred` + `occlude`，优先级 10）画在整个窗口最上层，否则它是卡片的子元素，
  会被卡片的边框和聚焦环盖住（看起来像透明）。任一弹出层打开时，窗口根上多一块全屏的接收层（优先级 5），点任何别处就关闭全部菜单
  （`any_menu_open` / `close_menus`）。内置供应商已移除，添加供应商只有自定义一种。
- **共享设置与会话操作（协议新增）**：`settings/get|set` + `settings/changed`（主题模式、亮/暗主题、玻璃；存一份 JSON，多个客户端同步），
  `thread/update`（改名、归档、置顶）、`thread/delete`（连转写与图片一起删，运行中的先停），`project/list|add|remove`（项目是用户加的文件夹，
  在其中开会话会自动加入）。`Thread` 多了 `pinned`。GUI：偏好设置页的外观、归档对话页（恢复 / 确认后删除）、侧栏置顶分组、
  行上悬停的置顶与归档按钮、右键菜单（重命名 / 置顶 / 归档）、原位重命名、「+」选文件夹添加项目、项目行的新对话与移除、
  转写里的思考与工具调用可点开（命令、补丁按增删着色、输出）。
- **左侧会话树交互（2026-10-24）**：宽度拖动（220–520px，保留主区域空间，拖过折叠阈值收起、双击复位）、⌘B 折叠/恢复；
  项目、置顶、聊天与各项目内会话分别拖拽排序，支持上下插入线与边缘自动滚动；菜单可切换手动/最近更新/创建时间/名称排序，
  项目展开/折叠、展开更多、宽度与分组顺序通过 `settings/*` 保存并推送给其他客户端，旧设置缺省兼容。设置写入串行合并，
  主文件夹变更时迁移项目分组的顺序与展开状态。前进后退（⌘[ / ⌘]）跳过已归档/删除的会话；新对话入口清除上一个项目选择。
  会话菜单支持重命名（Enter/失焦保存、Esc 取消）、置顶/取消、归档、创建分支和确认后删除；项目支持编辑、显示目录、确认后移除。
  `thread/fork` 复制完整已落盘历史并保留时间戳，图片独立复制，运行中的回合须结束后再分支。侧栏不画插件入口（原生版没有插件系统）。
  定时任务已在 2026-10-26 接入原生调度服务与卡片/编辑/历史页（见补齐清单第二十二批）；账号仍无原生服务接口，入口显示具体未接入说明。侧栏偏好变化不重建整套主题；宽度拖动请求完整窗口重绘，避免复用旧裁剪区域。
- **宽度松手回弹修复（2026-10-24）**：直接运行 GUI 也经 `Daemon::connect_current` 核对构建与握手 `features`，
  `sidebarSettings` 缺失的空闲旧进程会被替换；忙碌或无法报告活动的进程保留并提示稍后重开。过去服务端每次握手读取磁盘上的可执行文件，
  重编译后旧进程会误报新文件的指纹；现在在服务端启动时固定指纹。回归测试模拟「指纹相同但不支持侧栏设置」的旧进程，
  验证替换后宽度可保存与重连恢复、同版本进程复用、忙碌/未知活动的进程不退出。手动缩放后的 GPUI ClickEvent 还必须检查按下/松手距离，
  快速连续拖动不能触发双击复位。
- **发送、快捷键、搜索（2026-10-24）**：发送失败不再静默——文字放回输入框并在输入框上方说明原因，没有任何模型时直接提示去
  设置 → 模型与默认。快捷键：⌘N 新对话、⌘, 设置、⌘K 搜索、⌘Q 退出、Esc 依次关菜单 / 搜索 / 对话框 / 设置；macOS 菜单栏有对应条目。
  ⌘K 搜索按标题找对话并列出「新对话 / 设置」两个命令（正文搜索要服务端新增读转写的调用）。输入框左侧的上下文环按
  `thread/tokenUsage/updated` 画：70% 变警告色、90% 变危险色。开发构建加了 `--script-send TEXT` 走一遍真实发送并截图。
- **多文件夹项目（2026-10-24）**：对齐 Electron 的 `ProjectFoldersDialog`。协议 `project/create`（名称可空，folders 第一个是主文件夹）、
  `project/update`（整体替换名称与文件夹列表；主文件夹变了，项目下的会话 `project` 跟着改，各自的 `cwd` 不动）、`project/remove`、`project/list`；
  `ProjectInfo` 带 `folders`（其余文件夹）。存储仍是一个 JSON，旧版的纯路径列表照读。名称与主文件夹同名时不存，跟着文件夹走。
  **智能体怎么知道**：会话所在项目有多个文件夹时，系统提示追加一段（照 `buildProjectFoldersPrompt`）：列出每个文件夹、当前工作目录、
  是否 git 仓库，并说明可用绝对路径读写其余文件夹；单文件夹项目一个字不加。codex 的 `--add-dir` 是把额外目录加进沙箱的可写根，
  这里没有沙箱，所以只需要告诉模型。GUI：侧栏项目旁「+」打开「创建项目」（名称、文件夹列表、主标记、悬停「设为主文件夹」与移除、
  添加文件夹可一次多选），项目行 ⋯ →「编辑项目」同一个对话框。`@` 跨文件夹搜索与其余文件夹的 AGENTS.md / 技能提示已接通；
  每个仓库单独的 git 面板仍待做。
- **沙箱与审批（2026-10-24，老版没有，照 codex 新加）**：新 crate `fv-sandbox`（codex 的 macOS Seatbelt：`/usr/bin/sandbox-exec` + SBPL 策略，`.git` 只读保护，
  网络默认关）。模式 `read-only / workspace-write / danger-full-access`，审批策略 `untrusted / on-failure / on-request / never`，存在应用设置里（全局）。
  `exec_command` 在沙箱里跑，模型可带 `sandbox_permissions: require_escalated` + `justification` 申请沙箱外运行；`apply_patch` 由服务端按可写根检查。
  需要用户点头时服务端发 `item/approval/request`（客户端用 JSON-RPC 响应作答，`serverRequest/resolved` 撤回），决定为允许一次 / 本会话允许 / 拒绝。
  系统提示会告诉模型当前沙箱。只有 macOS 有沙箱（其它平台除非完全访问否则报错）；还没有按会话覆盖。
  **界面照 codex**：审批和提问不再画在转写里，而是在 composer 区——提问面板（「问题」、编号选项、「或自行撰写回复」、跳过 / 发送）在 composer 上方；
  审批面板（终端 / 文件、问题、等宽命令、「拒绝 Esc」「允许一次 ↵」+ 下拉「本次会话都允许」）直接盖住 composer，Esc 拒绝、Enter 允许一次。
  composer 左下角新增权限按钮与菜单：请求批准 / 沙箱里直接做 / 完全访问权限（橙色胶囊）。实现在 `workspace/ask.rs`；预览 `--fixture approval|question`。
- **玻璃、markdown、工具折叠对齐（2026-10-24）**：①玻璃：Electron 的 `vibrancy: "under-window"` 保留系统材质的着色与饱和度，而 GPUI 自带的 `Blurred` 会把这两样剥掉
  （只剩模糊），所以窗口对 GPUI 是 `Transparent`，由 `vibrancy.rs` 自己在 contentView 下面垫一个 `NSVisualEffectView`（UnderWindowBackground、BehindWindow、Active，
  和 Electron 同参数）。再把 `index.css` 的 Liquid Glass 移过来：`ui::glass_rim`（1px 渐变高光环，155° 强→透明→弱，两段渐变描边）、`glass_edge`（0.5px 暗边 + 顶部 sheen），
  用在侧栏、composer 卡片（聚焦时让位给焦点环）、弹层与对话框（圆角 14、无边框、`glass-shade` 双层阴影）。**没法在离屏截图里验证模糊本身**（模糊是系统在窗口外合成的），
  透明度另外经真实 Metal 帧回归验证：窗口的组件 Root 清空底色，只让 Workspace 画一次主题 tint；`vendor/gpui-pre-apple` 修正两个最终管线的 destination alpha
  （`One` → `OneMinusSourceAlpha`），避免多层 tint 的 alpha 被相加而显示成不透明灰色。外阴影也按 CSS 从卡片内部挖空，避免 composer 透出整块黑影。
  补丁来源与移除条件见该目录的 `FASTVIBE.md`；`cargo test -p fv-gui --features capture --test glass -- --ignored` 实际开窗截图，检查页面、侧栏和 composer 的 source-over alpha 与颜色。
  ②markdown：使用 gpui-base 的 `TextView`（保留原生选区），`markdown.rs` 把它的 `TextViewStyle` 调成 `.chat-markdown`：
  段间距 0.4em、标题 1.15 / 1.05 / 1rem、代码块圆角边框 + muted/40、行内代码 `code-inline-bg`、表格圆角边框 + 表头 muted/60、高亮主题取 `--code-*`。
  自定义块补上代码块头部「语言 + 复制」、分层列表标记与只留横线的可滚动表格；各块仍由 TextView 渲染行内格式和代码，代码块、列表项与表格单元拥有独立稳定的 ID。
  tree-sitter 开启 TS/TSX/JS、Rust、Python、Bash、HTML/CSS、JSON、TOML/YAML，代码色取主题 `--code-*`。思考行使用与 Electron 相同的 16px Brain 图标。
  ③工具：`presentation::fold_runs` / `run_summary` 照 `collapseToolRuns` / `runSummary`——连续已完成的调用折成一行「已运行 2 个命令，读取 App.tsx」（图标 layers01、chevron 常显），
  进行中的调用、提问、计划、子智能体各占一行并截断批次；单个调用行是「图标 + 类别 + 等宽主体 + 更淡的目录」，chevron 悬停才显示，展开体左侧一条细线。
  工具族按 codex 的工具名（`exec_command`、`apply_patch`、`view_image`…）。预览：`--fixture markdown|process`。

- **对话搜索、思考档位与手动压缩（2026-10-24）**：`thread/search {query, includeArchived}` 按更新时间返回最多 50 个命中（线程信息 + 正文摘要）。
  大小写不敏感的字面子串匹配；标题、项目路径、用户消息、回复正文和工具输出可搜，思考、工具参数、图片数据与压缩摘要不参与。
  未打开的转写逐行扫描，不加载成 runtime；已打开的线程搜索当前可见状态，包含尚未完成的回复。压缩前的原文仍可搜。
  扫描放到阻塞线程，不占 agent 的异步执行器；目前没有跨查询索引，每次查询仍需扫描冷转写。
  ⌘K 输入防抖 200ms，旧查询和已关闭面板的回复被丢弃；结果合并即时标题/项目匹配，显示命中附近摘要、高亮（最多 3 处）、加载与失败状态，支持包括归档。
  正文结果打开后定位到命中回合，展开其处理过程与工具输出。composer 模型菜单可选六档思考强度或跟随默认；新对话保留待选档位，已有对话经
  `thread/model/set` 保存，切换模型保留显式档位。上下文环可点开查看用量、比例并手动压缩，工作中禁用；压缩沿用可停止、有错误反馈的服务端回合。
  预览：`--fixture theme --model-menu`、`--fixture theme --context-menu`、`--search 关键词`；验证覆盖 Unicode 摘要、字面匹配、私有内容排除、重启、归档过滤和流式搜索。

- **上下文弹窗对齐 Electron（2026-10-24）**：288px 宽、14px 内边距；「上下文窗口 + 百分比」、6px 进度条、已用与剩余/总容量、整行描边「压缩上下文」按钮，分隔线下为
  本轮 Token、会话 Token、输出速度、步骤、缓存命中率、费用。统计行悬停解释口径，计数使用 K/M，70% / 90% 改用警告 / 危险色。
  `thread/resume.stats` 和有 seq 的 `thread/stats/updated` 与转写共用原子快照；每条持久化的用户/回复/压缩消息增量更新，重启从完整转写重建，压缩前的用量不会消失。
  本轮从最近用户消息起计；步骤是会话内 assistant 请求数；缓存命中率只用读取 /（未缓存输入 + 缓存读取）。成功压缩请求的用量记在压缩记录里，计入 Token、不替换最新普通请求的速度。
  每次模型请求在开始采样到完成间测量 `durationMs` 并随回复落盘，包含首 token 等待、排除工具等待；旧记录没耗时时显示「—」。
  弹窗挂在上下文环自己的 28px 盒子里（`.relative()` 包住环 + `ui::float`），不是挂在 composer 卡片右缘：环在模型 chip 左边，贴卡片右缘会让弹窗离打开它的图标隔一整个 chip（Electron 是 `side="top" align="end"`，右边对齐环、上方 10px）。同理 `dialog_card` 的 `max_w(relative(0.92))` 是相对父级的，父级变成环之后会塌成 26px，所以卡片自带 `max_w(288px)`。实测（2x 截图）：弹窗右缘与环盒子右缘差 0、竖直间隔 10.5px。

- **models.dev 与费用（2026-10-24）**：`fv-provider` 里那份 models.dev 解码器（`models_dev/meta.rs`，与 Electron 的决定
  版本共用同一份 `resources/models-dev/index.json`，`build.rs` 编进二进制）接上了：`ServerState` 启动时读一次目录，
  `provider/list`、`model/list` 与 `provider/fetchModels` 的每个模型都过 `with_catalog_meta` —— 窗口、输出上限、
  是否看图、缺失的显示名来自目录，目录不认识的模型保持存下来的值（新加的模型因此第一次请求就有真实窗口）。
  `engine_base_url` / 协议推断不变：目录只管参数，不管端点。
  **价格**（`fv-provider/pricing.rs`）：一条回复按它自己记录的 `provider/model` 计价，长上下文档位按**整个 prompt**
  （未缓存输入 + 缓存读取 + 缓存写入）选，与 pi 那边一个价率的差别就在这里。压缩摘要的用量也计价——
  `Message::Compaction` 多了一个 `model` 字段（旧转写缺省为 `None`，那样就不计价）。**只存 token，不存价钱**：
  `SessionStats.cost` 每次由转写重算（重启、改供应商、目录更新后同一份历史得到同一个数），有新的 `LogEvent::StatsSnapshot`
  在重算值真的变了才推一次，所以没配价格的模型不会每轮推一条相同的统计。目录没有价格的模型费用显示「—」，不写「$0.000」。
  目录格式化模块 `fold.rs`（把上游 `api.json` 折成快照）仍是坏的，没有接线：快照由 Electron 仓库的 `pnpm sync:models`
  生成、两版共用，这里不需要第二个生成器。
- **排队消息与立即发送（2026-10-24）**：`turn/enqueue` / `turn/queue/remove` / `turn/queue/sendNow` / `turn/queue/resume`，
  推送 `thread/queue/changed`（整份队列，从不是增量），`thread/resume` 也带一份 —— 中途连上的客户端画得出同样的队列。
  队列按行存进 `fastvibe.db` 的 `queue_items` / `queue_pauses`（schema 3）：一次改动写一行，崩溃改不动邻居。
  **一次回复结束时队列在同一段运行里接着走**：服务端在报告「空闲」**之前**把下一个提示词接上（`ThreadRuntime::chain`
  换掉运行中的 token），所以连排两条提示词是一段工作，客户端不会看到中间闪一下空闲——那一下会让侧栏的运行标记和
  「正在工作」掉一帧。没有可接的运行（空闲时入队、或「立即」按在空闲会话上）才 `begin` 一个新回合。
  **「立即」不先删行**：被点的那条留在队列里并以 `preferred` 记下，等服务端真正启动它才移除，断线重连的客户端
  因此一直看得见它；同一条不会被发第二次。
  **两种暂停各有自己的文案**：`QueuePauseReason::{Failed, Stopped}` 存在库里，重启后照旧生效（不靠推断）。
  失败的回合和用户自己按的停止都让队列停下——停止往往是冲着队列里那些提示词按的，自动接着发等于否决这个决定；
  唯一的例外是「立即」，它本来就是冲着队列按的。恢复只有 `turn/queue/resume` 或再按一次「立即」。GUI：composer 上方的队列条（行内「立即」「编辑」「×」、最多 5 行内滚动、
  暂停时警告色与「继续」），composer 的发送按钮在运行中变成「加入队列」，只有输入为空时才是停止。
  标题栏的 `✕` 与 `⋯` 之外没有新入口；预览 `--fixture queue`、`--fixture queue-editing`、`--fixture queue-paused`。
- **队列的排序与编辑（2026-10-29）**：`turn/queue/reorder { threadId, itemIds }` 与
  `turn/queue/edit { threadId, itemId, text }`。
  - **排序提交整份顺序，不是一次移动。** 拖动产出的本来就是整份顺序；提交整份也让一个过期的客户端无害 ——
    已经不在队列里的 id 直接跳过，没被点名的 id 留在原处（追加在末尾），不会因为别的客户端同时删了一条而消失。
    落盘在一个事务里整份重写 `position`（写一半会留下重复的 position，`ORDER BY position, id` 就悄悄按 id 重排了）。
    正在发送的那条（`preferred`）不参与排序：它的运行已经在路上，改顺序只改画面。
  - **编辑保持 id 与位置。** 改的是队列里的那一行本身，所以邻居还在原来的地方；空文本被拒绝（一条没有问题的回合），
    已经在发送的也被拒绝（它已经是模型读到的东西了）。数据库先写，再改内存，写失败就整次失败、界面不变。
  - **编辑就地发生在队列条里，不借用 composer。** composer 是写下一条消息的地方，借它来改一条还没发出去的消息
    会丢掉用户正在打的草稿。Enter 保存、失焦保存、Esc 取消、空文本取消；行在被编辑时不参与拖动（拖一个输入框是在选字）。
  - **拖动沿用侧栏的规则**（`sidebar_state::reordered`：源行先离开再插到目标行之前/之后），落点用一条 2px 的插入线
    画在目标行上缘或下缘。`QueueDrag::drop_order` 是纯函数，窗口之外的算术由它承担，单测钉住上下两个方向与
    「目标已经不在了就什么都不做」。正在被编辑的行、已经不在队列里的行都不拖动；会话切换时编辑结束。
- **重试与编辑（2026-10-24）**：`turn/rewind {threadId, turnId, text?}` —— 不带 `text` 是重试（那一轮自己的话原样再发一次），
  带 `text` 是编辑（换成新的话）。**历史从那一轮的用户消息处切断**，所以重发的是模型当初该看到的东西；
  转写**不缩短**：`TranscriptStore::rewind` 追加一条 `{"type":"rewind","keep":n}` 标记，读的时候在标记处截断，
  下一条消息仍然接在被留下的最后一条后面（`last_entry_id` 也认标记）。用户写下的东西因此不会被一次误点毁掉，
  而磁盘上的旧回复仍然在文件里、可查。运行中不能 rewind（`THREAD_BUSY`）；客户端先停再重试。
  被丢弃的回合连同它后面的一起从画面上消失（`turn/rewound` 事件 + `ThreadView` 截断），否则重试会画成同一句提示词的第二个回复。
  GUI：用户行悬停的「复制 / 编辑」与回复页脚的「复制 / 创建分支 / 重试」都接上了；「编辑」把话放回输入框并在 composer 上
  方显示一条「正在编辑这条提示词，发送会重写这一轮」，Esc 或「取消」退出编辑（切换会话也会退出，避免改到刚打开的会话里的回合）。
- **插话与检查点（2026-10-24，照 codex）**：
  - **`turn/steer { threadId, expectedTurnId, text }`** 是 codex 的 `turn/steer`：用户的话不是新回合、也不排队，
    而是进到**正在跑的那一轮**里。`fv_agent::Steers` 是一个队列，`run_turn` 在**每次模型请求之前**（历史刚以
    上一批工具结果结尾时）把它取出来作为用户消息提交 —— 所以在工具批次中间插进去的话，模型的**下一次判断**就带着它，
    而不是等它把错的事做完。三条不变式：**不会把一条用户消息塞进调用和结果之间**（provider 会拒绝，模型也会缺一半上下文）；
    **模型已经答完之后到的插话不会丢**（答完时若队列非空则 continue 再问一次）；**没有在跑就明确拒绝**
    （`NO_ACTIVE_TURN`，客户端据此把话变成下一条提示词 —— codex 的客户端也是这么做的）。
    `expectedTurnId` 是必填的前置条件：客户端拿错了回合，服务端按 codex 的做法**自己重试一次**并回传真正在跑的那个 id，
    一次往返而不是两次。
  - **composer 在运行中优先插话，插不进去才排队**（codex 的顺序：`fail → enqueue_rejected_steer`）。插话是更好的默认，
    因为模型的下一步就已经带着更正；排队要等它把错事做完。发送按钮的提示因此是「加入队列」只在插话不可用时才出现。
  - **`turn/rewind` 多了 `rewindFiles`**：重试前把工作区退回那一轮开始之前。检查点在 `fv-store/checkpoint.rs`，
    用 git 写**临时 index**（`GIT_INDEX_FILE`）再 `write-tree/commit-tree`，挂在 `refs/fastvibe/checkpoints/<会话>` 下：
    用户自己的暂存区一个字节都不动，而**未跟踪文件（命令刚生成的那些）也在快照里** —— 逐文件拷贝做不到这一点，
    只看工具名的检查点也做不到（`exec_command` 写的文件它认不出来）。`git stash create` 也不行：它忽略未跟踪文件，
    而这正好是命令产物的那一类。还原用 `git restore --source`（只动 worktree，不动 index），快照里没有而现在存在的
    文件被删除；**不是 git 仓库就没有检查点**，重试照常、如实说「没有可退的东西」。
    捕获发生在每轮开始时（`spawn_turn`），**捕获不到就清掉**，免得把上一轮的快照当成这一轮的撤销点。
  - **重试先问文件**：对话框三个选项（取消 / 保留文件改动 / 退回文件并重试），因为「保留」是真实答案 ——
    用户可能在提示词和重试之间自己动过文件。还原不全时列出未退回的路径（`FilesRewound.skipped`），不说成功。
  - **composer 上方的提示分三档**：失败红、完成中性带勾、部分完成琥珀。曾经全部走同一个红色 `send_error`，
    于是「已退回工作区：还原 1 个文件」看起来像出错。
    预览：`--fixture rewound`。
- **回复推荐（2026-10-24）**：一轮回复正常收尾（`Completed`，最后一项是助手文字）后，服务端用**这条对话自己的模型**
  发一个旁路请求，猜用户下一句，画成 composer 的 placeholder，**Tab 填入**（`thread/suggestion/changed`，
  `thread/resume` 也带一份）。`suggestion.rs` 是纯逻辑：`material_from` 决定值不值得猜（停在工具调用、失败、被截断、
  没有文字都不猜），`clean` 决定答案是不是一句建议（首行、剥引号/项目符号/「下一条消息：」标签、`NONE`、超过 120 字
  都当作没有），`completed_first_line` 让请求在**第一行写完就取消**。
  几条不显然的：
  - **只在正常收尾后猜**，且**压缩不猜**（压缩分隔线不是用户会接话的地方），失败或停止时**撤回**已有的推荐。
  - **新一轮开始就撤回**：用户自己那句提示词已经回答了猜测。
  - **旁路请求用对话自己的模型**，和 Electron 版同一条理由——换一个供应商猜，那个供应商可能就是刚被证明不通的那个。
    `ServerState::set_suggestion_model` 只给测试用（脚本化模型会把对话的脚本吃掉），生产从不设置。
  - **输出上限不给小值**：`max_tokens` 只是天花板，短答案在大小限下一样快；而小上限会把先思考的模型截成空
    （思考计费在同一个预算里），于是根本没有推荐。省的钱来自「第一行写完就停」，不是来自把上限调小。
  - **15 秒超时**、异常全吞、`spawn` 成独立任务：没有任何东西等它，失败就保持原 placeholder。
  - 设置 → 偏好设置 → 外观 → **回复推荐**（`replySuggestions`，默认开）。`tests/common` 里有一个
    `disable_reply_suggestions`，脚本化模型的测试用它，免得旁路请求吃掉对话的脚本回复。
  - Tab 只在**输入框为空**时生效（`EmptyComposer` key context）：有字时 Tab 仍是编辑器的缩进。Tab 徽标画在
    placeholder 前面，文字让出空间（Electron 的 `pl-14`）。
    预览：`--fixture suggestion`。
- **右侧面板 · 文件树与预览（2026-10-24，M3 开始）**：协议三个方法 `workspace/readDir` / `workspace/preview` /
  `workspace/writeFile`，实现照 Electron 的 `engine/workspace-fs.ts` 与 `engine/file-preview.ts`（那一版是规格，
  差异就是 bug）：
  - **列目录**：`.git` 与 `node_modules` 永不出现；只列真实文件与目录（符号链接跳过——树预览的是它显示的那条路径，
    跟着链接就会写到别处）；目录在前、文件在后、各自按名排序。
  - **预览按种类分开**：图片 / 视频 / PDF 只报名字与 mime，不读字节（客户端按 URL 加载，200 MB 的片子不会变成 base64）；
    Office 三种是**要渲染的页面**而不是要抽取的文本；旧版 Office / ODF / 启用宏的变体**明确列为不支持**而不是当文本读
    （那样会把 `.doc` 显示成一屏乱码）；超过 4 MB 或含 NUL 字节的是二进制；`.md` 排版渲染、`.csv`/`.tsv` 解析成行、
    `.diff`/`.patch` 走 diff 视图，其余是代码。
  - **失败要说人话**：`reason` 是 `missing` / `permission` / `not-a-file` / `unknown` 之一（**必填**），`message` 是结论，
    `detail` 才是宿主原话（`ENOENT: ...` 只出现在小字里），`directory` 给「它本该在的目录」——一个已经不在的文件
    不能被「在文件夹中显示」。`test/workspace.rs` 钉住「结论里不含 errno」。
  - **写入是原子的**，并且拒绝它做不到的事：符号链接、二进制、超过上限；原来是 CRLF 的写回还是 CRLF（否则一次保存
    就重写整个文件的换行）。
  - **文件树操作（2026-10-26）**：公共协议 `workspace/createEntry|renameEntry|deleteEntry` 与全局 `workspace/entryChanged`；GUI 根目录/条目右键菜单接通新建、重命名、废纸篓与明确的永久删除。路径受根目录与真实父目录约束，禁止 `.git`，排他创建与内核排他重命名拒绝覆盖。
    默认废纸篓失败不改为永久删除；macOS 使用 NSFileManager。目录改名保留各标签和草稿，通知同步其它客户端，读取代次拒绝旧目录结果。多文件夹树与 `@` 搜索已带入其它根目录；逐仓库 Git 视图仍待下一批。验证边界见 `native-completion.md`。
  - **GUI**：`workspace/pane.rs`，每个会话一套（一个标签页属于一个对话，切会话不会把 A 的文件带到 B）；树是懒加载的
    （展开才读，一个 2000 项的仓库根不会一次画 2000 行）。
    **窄面板切换而不是并排**：Electron 的 `@min-[32rem]/files` 规则——380px 的默认宽度下并排会让文件只剩约 150px，
    那不是预览。所以默认显示树，打开文件后文件占满面板、标题行有「返回」；拖宽过 512px 才并排。
    树的列宽可拖动（默认 224，最少 120，最多占面板 75%），和侧栏一样按 pointer 位置算。
  - **编辑与保存（2026-10-24）**：`workspace/writeFile` 接上了 GUI。**哪些文件可编辑是有规则的**
    （Electron 的 `editableFileText`）：代码、diff、`.md`/`.markdown`、HTML 的正文**就是文件本身**，所以能写回；
    一份从 `.docx` 抽取出来的 Markdown 不是那个文档，写回去会把它替换成抽取结果，所以不能。
    **代码和 diff 打开就是源码，Markdown / HTML 打开是渲染后的样子**（`prefersSourceEditor`），
    标题栏右侧的眼睛按钮切到另一边。⌘S 保存（窗口级绑定，指针在树里也生效），保存成功才清 dirty 点。
  - **编辑器用 `EditorState` + `Editor`，不是 `TextareaState`**（2026-10-24 修正）。`gpui-base` 的文档写得很清楚：
    `TextareaState` 是"普通多行文本"，**语言、诊断、折叠、LSP 在它上面不存在**，那些方法只在 `EditorState` 上。
    第一版用了 `TextareaState` + `auto_grow`（后者还把它降级成 `AutoGrow`，连行号都没了），于是只能自己画
    gutter，并因为软换行而错位——`Editor` 自带 gutter、当前行高亮、缩进参考线、代码折叠和 tree-sitter 高亮。
    **语法特性本来就在依赖树里**：`gpui-kit` 的 features 已经开着 `tree-sitter-{rust,typescript,tsx,javascript,python,bash,html,css,toml,yaml}`，
    `gpui-component` 在渲染时自己装 `input_highlighter_factory`，只要语言名对就上色（实测 `Cargo.toml` 键名红、字符串绿、`false` 蓝）。
  - **`Editor` 要 `h(relative(1.0))` 才会填满面板。** 它内部是 `size.height = relative(1)` 且
    `min_size.height = rows * line_height`（`CodeEditor` 的 `rows` 默认 2），所以父容器没有确定高度时它就塌成两行。
    实测：不加这一行，500 行的文件只显示 3 行；加上就撑满，文件在编辑器内部滚动、gutter 跟着滚。
    另外**预览外面不能再套 `overflow_y_scroll`**：滚动容器按内容测量子元素，编辑器在里面同样塌掉。
  - **设置顺序**：先 `set_value`，再 `set_highlighter(language, cx)`，最后 `refresh(cx)`——`set_highlighter` 会丢掉缓存的语法树，
    值放在它后面会让第一帧没有颜色。
  - 预览：`--fixture pane`（读本仓库的真实目录与 `AGENTS.md`，并打开源码视图——否则截图里看不到编辑器、
    切换按钮和 dirty 点；fixture 走的是**同一套**判断，不是另写一份形状——否则截图拍到的会是一个不存在的 bug）。
- **变更视图（2026-10-24）**：`git.rs`（服务端）+ `pane_git.rs`（GUI），照 Electron 的
  `main/source-control.ts` 与 `main/workspace-git.ts`。九个方法：`workspace/gitStatus` / `gitDiff` /
  `gitComparison` / `gitHistory` / `gitStage` / `gitUnstage` / `gitDiscard` / `gitDeleteUntracked` / `gitCommit`。
  几条规则都是 Electron 那边踩出来的，原样带过来：
  - **读操作一律 `--no-optional-locks`。** 面板在后台轮询 `status`，而同一棵树里智能体自己可能正在
    `git add`；带锁的读会占住 `index.lock` 让对方的写失败。
  - **路径一律 `--literal-pathspecs`。** 一个叫 `*.txt` 的文件是文件不是模式；不加这条，一次「丢弃」
    可能作用在比那一行更多的文件上。
  - **`-z` 记录而不是按行解析**：Unicode、空格、重命名的目标都原样保留，路径里有换行也仍是一条。
  - **未跟踪文件的 diff 是 `--no-index` 对 `/dev/null`，退出码 1 表示「补丁生成成功」**而不是失败 ——
    当成失败就是未跟踪文件点开永远是空白视图。
  - **`revision` 只接受裸 hash**，不接受 revision 表达式：`HEAD~1^{tree}` 出现在一个自称 commit id 的字段里，
    就是让 git 去取一个不是 commit 的东西。
  - **分页钉住第一页的 tips**：两页之间来了新提交，否则每行都会移位，读者会看到同一个提交两次、
    又漏掉另一个。
  - **一个文件可以同时出现在两组**（已暂存 + 又改了），因为两行回答的是两个问题：「会被提交的是什么」和
    「还没提交的是什么」。所以 **patch 从「这一行属于哪一组」读**，不是从文件名读 —— 按文件名读的结果是
    点开一个已暂存的改动，视图是空的。
  - **提交按钮先暂存整个树**（Electron 的「这个提交有问题」那条），但 `gitCommit` 本身仍然只提交 index，
    所以故意只暂存一部分的调用方拿到的就是它暂存的那些。
  - **丢弃会问，并且说清退回到哪里**：已跟踪文件回到 **index**（不是 HEAD —— 用户可能故意暂存过），
    未跟踪文件是删除，而且只删状态里列出的那些路径，**绝不递归删目录**。
  - 预览：`--fixture git`。fixture 读的是**同一批 git 命令**（真实仓库、真实补丁），不是自己编一份
    变更列表 —— 否则截图拍到的是一个没人能有的视图。
- **`@` 文件提及（2026-10-24）**：`project_files.rs`（服务端）+ `file_mention.rs`（GUI 的纯逻辑与面板），
  照 Electron 的 `engine/project-files.ts` 与 `lib/file-mention.ts`。协议一个方法 `workspace/searchFiles
  { cwd, query, otherFolders }`，`blocking` 执行（走一遍大目录树不能占住跑 agent 流的执行器）。
  排序规则是原样搬过来的，因为那是读者唯一感觉得到的部分：
  - **git 工作树用 `ls-files` 列，不遍历** —— 被忽略的构建产因此不出现在菜单里，这正是问 git 的理由；
    一个把 `node_modules/**` 也列出来的 `@` 菜单是文件树自己都拒绝画的噪音。
  - **不是仓库才遍历**，跳过同样那几个重目录，**不跟随符号链接**（那会离开项目），并且有上限。
  - **列表缓存十秒**：菜单每次按键都过滤，而 spawn 一次 git 才是慢的那部分；文件集合按秒变，不按按键变。
  - **分数说明这个文件为什么在这里**：完全同名 > 前缀 > 后缀 > 子串 > 路径里任意位置 > 模糊匹配，
    而**模糊匹配只作用于文件名、且必须从一个边界开始** —— 跨整条路径的子序列几乎能匹配所有东西
    （`nope` 在 `compact-notice` 里），那会把用户真正要的文件埋掉。
  - **多文件夹项目每个文件夹都列**，以文件夹名开头（`web/src/App.tsx`），两个 `README.md` 因此分得清；
    从两个根都能到的文件只列一次。
  - **`@` 必须开启一个 token**：草稿开头、空白，或任何不可能属于邮箱本地部分的字符 —— `user@host` 是普通文本。
    **空格结束提及**。
  - **选中的文件变成附件，不是文本**：token 从草稿里移除（留下的 `@path` 会让它被发两次），
    文件以 `<fastvibe-attachments>` 引用块附在提示词后面 —— 与 Electron 同一个标签，所以两边写下的转写读起来一样。
    `prompt_with_attachments` 是唯一的拼装点，**每一条发送路径**（回合、排队、插话）都经过它，
    所以文件不会被其中某一条悄悄丢掉。
  - 菜单开着的三个键单独绑在 `MentionOpen` key context 上（↑ / ↓ 选、Esc 关掉并留下已输入的 `@query`）——
    否则方向键动光标、Esc 去关别的东西。
  - **顺带修正**：右侧面板现在**默认收起**，有标签页时才展开。之前默认展开，会话旁边永远挂着一列
    读者没要过的 380px 空白。
  - 预览：`--fixture mention`（用本仓库真实文件和同一套排序规则，fixture 不自己编文件列表）。
- **隔离工作区（worktree，2026-10-24）**：`worktree.rs` + 四个方法 `thread/worktree/{create,bind,unbind,list}`，
  照 Electron 的 `main/engine/worktree.ts` 与 `main/pi/git-worktree.ts`。`Thread` 多一个 `worktree { path, branch }`。
  规则逐条保留，因为每条都对应一次能踩到的坑：
  - **FastVibe 创建的 worktree 落在 `~/.fastvibe/worktree/<项目>/`**。别处的话，应用就分不清哪些 checkout 是自己的
    —— 而它在删之前必须先知道这件事。
  - **分支已存在就检出，不存在就从 `HEAD` 建**。两者只差一个 `-b`，所以「绑到 `dev`」不需要第二条命令。
  - **分支名是校验，不是转义**：开头的 `-` 会被 git 当成选项，空白不可能是分支名，直接拒绝比引用更便宜。
  - **显式路径已存在是错误；默认路径已存在加后缀**。用户写了路径就是那个路径；应用自己挑的名字可以绕开残留。
  - **只有这个应用创建的 checkout 才会被删**。用户自己做的 checkout 不归它删，`remove` 在那种情况下的回答就是什么都不做。
  - **绑定要求同一个仓库**：另一个项目的 worktree 会给这个会话一段和它项目毫无关系的历史。
  - **解除绑定回到项目，不是回到草稿目录**：会话在隔离之前属于那个项目，之后也属于它。checkout 留在磁盘上
    （界面上的「解除」不删目录），因为那次实验的 diff 可能还值得看。
  - GUI：会话右键菜单里一行（「创建隔离工作区」/「解除隔离工作区」，按是否已绑定切换）。
  - **踩到的坑（写下来免得再踩）**：`HOME` 是进程级的，所以这一组测试**不能并行**——实测没有串行时，四次运行里
    有两到三次是某个测试的 `HOME` 在另一个测试调用中途把它换掉。`std::sync::Mutex` 的 guard 不能跨 `await`
    （会堵住运行时，clippy 也拒绝），所以串行用的是 `Arc<tokio::sync::Mutex<()>>` 的 owned guard。串行之后连跑四次全过。
- **变更视图的目录树、并排 diff 与真正的行号（2026-10-24）**：`workspace/diff.rs`（纯逻辑）+ `pane_git.rs`。
  - **行号来自 diff 本身，不是数行数。** 之前那个补丁视图是自己数行，于是 pi 的内联格式（`- 12   label`）
    和真实 `@@` 头都会给出错位的编号。`diff.rs` 是 Electron `lib/diff.ts` 的移植，两种形状都认：
    带 `@@ -12,4 +12,4 @@` 的真实 diff 从头部推两个计数器；pi 的格式则把**烘进每一行的号码读回来**
    （右对齐的号段 + 一个空格）。两者都没有的手写 ```diff 围栏**不画 gutter**——一个凭行数编出来的号码
    比没有号码更糟。7 个测试钉住这几种形状，包括「一行看起来像带号码的散文不算 diff」。
  - **并排只配对同一变更块里的相邻增删**；context 行和 hunk 头是边界。跨过一个 context 行去配对，
    会把两边都没改的行画成「改过」。
  - **差异保留源码空白并横向滚动**，统一与并排均不把长行折成一列字；并排的列宽由内容区约束。
  - **普通面板给会话保留 420px**，需要更宽时用最大化按钮；还原恢复原宽。
  - **目录树默认开**（字段为 `flat`）。按冲突、已暂存、未暂存分别建树；一个文件同时在两组时各画一行，
    选中态跟随 diff 来源，避免点已暂存却高亮未暂存。
- **面板样式与开合对齐 Electron（2026-10-25）**：`workspace/panel_motion.rs`、`pane.rs`、`sidebar.rs`、`transcript.rs`。
  - 两侧以 280ms `cubic-bezier(.22,1,.36,1)` 过渡宽度；外层裁切、内容保持原宽。反向切换从当前宽度接续，拖动直接跟随指针。
  - 左栏完全收至 0；展开、新对话与导航回到主区域顶栏，macOS 窗口按钮留白同步变化。右栏收起时主区域显示展开图标，展开后由右栏显示收起图标。
  - 右栏与左栏共用 8px 外留白、16px 内圆角、主题色、玻璃表层和内描边。44px 标签栏、28px 标签、添加菜单、关闭按钮、中键关闭、右键关闭其他/全部、最大化/还原均按 Electron 排布。
  - 空态使用同样文案与入口，窄时 48px 列表，内容宽度达到 480px 时使用 88px 网格。浏览器入口已接通原生标签与导航，辅助对话入口已复用真实子 Agent 线程；浏览器控制设置、主页/搜索模板、下载目录及书签/历史已接通。
  - 文件树使用同一份 vscode-icons 的文件/文件夹映射、根目录分组及 40px 预览工具栏；切换标签保留草稿和编辑器。
  - Git 为左侧提交/分组文件树/历史，右侧差异的布局；分栏可拖动、文件树可收起。侧栏默认宽 288px、范围 200–480px，与 Electron 一致。
  - 代码验证覆盖动画连续反转、时间边界、直接拖动、曲线单调性及切换标签后恢复草稿。开发 fixture：`pane-empty`、`pane-maximized`、`panels-collapsed`。
- **项目指令与技能（2026-10-25）**：`fv-server::context` 在阻塞线程读取会话 cwd 与其它项目文件夹的指令和技能；GUI 不直接读引擎数据。
  AGENTS 从最近仓库根到 cwd 逐级拼接，同级优先非空 `AGENTS.override.md`，全局 `~/.agents/AGENTS.md` 先加载，兄弟文件夹指令有各自作用域。
  每轮重读以支持即时修改；单文件上限 1 MiB、累计指令上限 2 MiB，读取失败或超限会写入上下文诊断，不假装已读完。
  技能来源为项目 `.agents/skills`、数据目录 `skills`、`~/.agents/skills` 与内置目录；同名由项目、私有、全局、内置依次优先，冲突路径会展示。
  模型常驻只接收元数据，明确 `/skill:名称` 才注入全文；手动技能不自动提供给模型。支持 YAML 多行说明、CRLF、符号链接发现与环路去重。
  `skill/list|read|create|import|remove` 是公共协议，设置 → 技能用同一目录；导入支持单技能与集合及其资源，重名不覆盖、失败回滚本次创建的目录。
  删除只作用于私有技能，来源目录不归应用删除。`skills/changed` 通知所有连接，不消耗会话事件 seq。
  自动化测试覆盖作用域、override、同名覆盖、即时刷新、多文件夹、跨会话隔离、导入回滚及模型实际收到的上下文。
- **还缺（需要新的协议数据或组件）**：标题栏与新对话页的 git 分支 / 改动 chip、压缩分隔线的
  「接近上限 · 128.0K → 24.4K」、工具卡展开后的详细样式、各种弹出菜单的 Nova 皮肤、右侧面板的终端 / Git / 浏览器标签页与设置页。

## 5. 数据迁移（旧 Electron 导入最后实施）

先完成其余原生功能、手机适配和交付验证，再实现本节旧 Electron 导入，最终切换前验收；不作为开发期启动、供应商配置或其它功能的前置依赖。以下保留最终导入范围。

首次启动检测到 `~/Library/Application Support/FastVibe/` 时，弹窗确认后导入，之后**不再读写旧目录**：

| 旧数据 | 去向 |
| --- | --- |
| `providers.json` + `agent/.env` | 自定义端点、模型配置与 API Key → 新供应商表 + 凭据文件（0600）；不导入 `agent/oauth.json` 等模型订阅凭据 |
| `mcp.json`、`settings.json`、`memory.json` | 新配置文件（字段名对齐，`remote*` 不导入，需重新设置） |
| `fastvibe.db`（会话目录、队列、DAG、定时任务、检查点、思考耗时、记忆账本） | 逐表转换 |
| pi v3 转写 JSONL | 转成新转写格式（沿用 `import/writer.ts` 已验证的配对规则，反向执行） |
| `memories/`、`tool-images/` | 复制 |
| `usage-ledger.jsonl` | 导入原生 SQLite 用量账本，保留原请求来源（迁移仍待实现） |

导入逐会话出结果（失败的列出原因），不做全有或全无；旧目录保持原样，可回退到 Electron 版。

## 6. 远程访问与手机端（按新架构重新设计）

实施顺序（2026-10-26 用户修正）：先补齐应用本身的功能，远程连接与手机适配后置。旧 Electron 完整数据导入仍最后实施。

以当前原生 `fastvibe-server`、`fv-protocol` 和事件模型为唯一业务协议。Flutter 手机端可以重新适配；不支持旧 Electron App Protocol、旧远程服务端、旧 WebRTC 帧格式或旧 SSH Agent，不做兼容转换和新旧双栈。既有实现只供连接经验参考，不作为新协议的格式约束。

### 6.1 统一协议和传输边界

- 桌面、手机、SSH 与测试客户端调用同一份方法表、快照、通知和服务端交互请求。远程不另建功能缺失的调用集合。
- `initialize` 校验原生协议版本并返回实际能力；版本不匹配明确提示更新，不能静默降级到旧 App Protocol。
- WebSocket 一条消息承载一个原生 JSON 协议对象；WebRTC 的分片头、重组、压缩及大小上限按新传输设计与协商。两种传输最终进入同一个分发器，不改业务事件的序号、载荷或顺序。
- 鉴权在注册客户端与订阅推送前完成。`ClientOrigin` 由已验证的传输上下文决定，客户端不能自行声明为 Local / Ssh；远程方法继续由穷举策略分类。
- 背压、消息大小、分片超时、心跳和断连回收须在新传输上验证。慢连接不能阻塞模型输出或控制请求；重连重新取原子快照并按 `seq` 处理事件，后台会话与未决问题也必须恢复。

### 6.2 连接方式

- **局域网**：双栈监听、设备发现/扫码和设备身份认证由原生服务提供；密码换设备令牌、逐设备撤销与凭据隔离继续作为能力目标。发现与握手明确标识原生协议版本；未鉴权连接不得获得会话、配置或推送。
- **官方连接**：账号设备发现、已认证信令、WebRTC 通道共同建立可信连接，随后使用同一套原生 RPC。信令和手机侧连接状态可随新设计调整；不受旧信令消息和候选投递格式约束。直连/中转识别、网络变化恢复和大数据传输按新桌面/手机组合验证，旧 NAT 优化只在证据支持时采用。
- **SSH 主机**：连接和启动远端原生 `fastvibe-server`，复用原生协议与服务生命周期；安装、版本检查、终端和文件路径均面向远端主机，不适配旧 Electron 无头 Agent。

### 6.3 Flutter 适配与验收

- 从 `native/schema/` 生成 Dart 类型，替换旧 App Protocol 和远程传输适配；手机界面可复用，但账号、设备列表、LAN/官方连接、重连和协议状态须接入新服务。
- 验收覆盖双端版本握手、鉴权/撤销、同账号设备隔离、多客户端与后台会话、流式回复、工具交互、Stop、快照重连、文件读取、终端及弱网络/中转大数据。只检测并拒绝不支持的版本，不测试旧协议兼容。
- 当前 `native/` 的 Unix/stdio 通路与权限分类是已有基础；网络监听、官方连接和 Flutter 新适配仍属待实现工作。仅有设计文档或入口不能勾选远程完成。

## 7. 里程碑

每个里程碑结束：`cargo fmt --check`、`cargo clippy -D warnings`、`cargo test` 全绿。
本轮按用户要求仅检查代码与自动化测试，不使用 computer use；窗口操作与视觉回归须用户另行指定，不能把无界面用例写成视觉验收。
`fv-theme` / `fv-ui` / 视觉回归基础设施在 M1 就位，
M1 工期因此增加约 1–2 周；24 套主题与玻璃效果的**机制**在 M1 做完，M5 只剩设置页与主题选择器。

| 里程碑 | 范围 | 粗估 |
| --- | --- | --- |
| M1 第一条通路 | workspace、`fv-protocol` 骨架与 schema 导出、`fastvibe-server`（unix socket + stdio）、`fv-client`、`fv-daemon`；自定义端点配置；genai 四协议验证；exec_command / apply_patch；回合循环、取消、重试、转写、会话目录；GPUI 窗口：侧栏、转写、composer、模型选择 | 4–5 周 |
| M2 对话体验 | Anthropic / Google；models.dev 与价格；上下文环与用量统计；压缩；排队与立即发送；重试 / 编辑 / 分叉；检查点回退；标题；回复推荐；todo / question；各种折叠与报错呈现 | 5–6 周（主要通路、错误持久化与压缩窗口自适应已做；代码与自动化验收见 native-completion.md） |
| M3 工作区 | 项目与多文件夹、`@` 搜索、右侧面板（文件树、预览编辑、终端、Git 变更 / 历史 / 提交）、worktree、apply_patch | 5–6 周（文件树操作、多目录 Git、hunk 跳转、PTY 基础与工作区重启恢复已做；终端输入法接口、选择复制和历史回滚等交互的 macOS 定向代码与自动化验收已通过；跨平台仍列入交付） |
| M4 能力 | 子 agent、记忆、MCP、代码模式、工具搜索、技能、内联产物预览、wry（浏览器 / HTML / Office / KaTeX）、电脑操控、web_search、定时任务 | 6–8 周（子 agent（含历史 fork 与角色模板）、代码模式基础、定时任务、托管网页搜索、长期记忆、MCP、工具搜索、技能加载/管理及输入框选择与徽标已做；其余待补，详见补齐清单） |
| M5 外围 | 全部设置面板、24 套主题与玻璃、i18n、通知、Dock 角标、保持唤醒、命令面板、自动归档、账号、远程访问 + Flutter 适配、SSH 主机 Agent、从其他 Agent 导入、自动更新、签名打包 | 6–8 周 |
| M6 最后实施与切换 | 在其余功能、Flutter 新适配及交付验证完成后，最后实现并验收旧 Electron 完整数据导入；随后进行切换验证、灰度和 Electron 版下线 | 2–3 周 |

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
  有内容或托管搜索活动之后的失败交给调用方，不重放半条回复或重复搜索。genai 把 HTTP 错误放在流的第一个有意义的元素里（`Start` 先于状态码到达），所以先读到那一个再决定。
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
- **`exec_command` / `write_stdin`**：每个对话持有进程池，默认等 10 秒后返回仍在运行的 session id；后续回合可输入或轮询，只返回新输出。
  可选真实 PTY；非 PTY 使用管道，stdin 同样可继续写入。显式 `timeout_ms` 表示等待完成，到期杀掉进程，不返回后台会话；省略则没有默认硬超时。
  Stop 取消当前回合正在操作的进程，删除对话或退出 server 清理整个池；窗口断连与正常回合结束不清理。仍有命令运行时，升级握手报告忙碌。
  进程组启动并清理；每流独立解码 UTF-8 后合并，内存保留头尾各 512 KiB，模型输出按 token 预算（默认 10000，4 字节一个）截中间。
  退出后至多等 300 ms 排空输出；64 个运行会话上限，已结束未读取的结果在容量压力下可淘汰。PTY I/O 使用异步 readiness，满输入队列与取消不会占住阻塞读写线程。
  保留沙箱与审批；发送新输入时检查当前策略不能收紧后继续操作更宽权限的旧进程。Windows PTY 尚在跨平台交付范围内。
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
- 模型元数据（上下文窗口、价格、是否看图）已接入 models.dev；仅支持自定义端点与 API Key，不实现订阅登录。
  命令行 `--protocol` 等参数现在只是没配供应商时的后备。

**上下文压缩（`fv-agent::compact`，`thread/compact/start`）**：照 codex 的内联压缩（`rust-v0.46.0` 的 `codex/compact.rs`）做，提示词和桥接文案取自它的模板（Apache-2.0）。

- **触发与容量**：每次请求前计算实际投影，包含系统指令、工具声明和记忆地图，并结合 provider 已报告的用量；达到窗口的 **90%** 前后按输出与安全余量留位。
  初始窗口取 `Model::context_window()`，不知道时按 128k。真实 `ModelError.overflow` 按被拒绝请求学习实际容量，会话内按物理地址、协议、模型和声明窗口隔离；
  压缩后的普通回复仍超窗可以继续有界恢复，总共最多六次缩减。鉴权、限流与网络失败不缩窗，容量学习不改供应商配置。容量耗尽的历史记录指纹，继续提示不会反复请求；编辑/回退、换物理模型/窗口或手动压缩可恢复。
- **做法**：让同一个模型按 codex 的「写给下一位 agent 的备忘录」提示写摘要（不带工具），历史换成一条 `Message::Compaction { user_messages, summary }`。
  模型看到的是**一条用户消息**：用户原话的有界投影 + 摘要；原文预算受实际空间约束，最多 80 KiB，保留头尾。因为 `user_messages` 保存完整原文并随每次压缩累计，**转写里的用户原话不会被截短**。
  摘要输入独立计量，超出预算时按 UTF-8 边界分片，逐片携带摘要，完整处理用户要求、工具调用与结果；旧摘要也可重排，不再丢最旧消息。各片用量累计，取消停止后续请求。
  摘要输出最多 4K，并给后续普通请求的必需前缀留位。只有最终请求投影装得下、自动压缩确实变小时才提交；主动输出上限不会被当作普通回复的自动重跑理由，截断的工具调用以未执行结果收尾。
- **落盘与恢复**：`Compaction` 是转写里追加的一行，之前的消息**全部还在**（界面照常显示，中间画一条「已压缩上下文」分隔）；
  重启后 `effective_history`（最后一条 `Compaction` 起）才是送给模型的历史。内存里的历史与重启后重建的一致，有测试钉住。
- **失败与停止**：摘要失败或用户停止，历史**原样不动**（只发 `CompactionFailed` 收起进行中的条目），自动压缩失败时该回合失败并说明原因。
- **手动**：`thread/compact/start` 是一个独立的回合，可 `turn/interrupt`；线程忙返回 `THREAD_BUSY`，没有历史返回「nothing to summarize」。手动压缩重新探测声明容量，失败或取消恢复此前保护，只有验证通过的压缩点才采用新预算。
- **上下文环**：请求完成、容量学习和压缩提交后经 `thread/tokenUsage/updated {used, window}` 推送，带单调 `seq`；`thread/resume` 在同一把回合锁中读取最后的有效投影，避免把固定原文预算的旧估算当成新请求用量。
- **真实验证**（`deepseek-v4.1-flash`，窗口设成 5000）：几轮长回复后自动压缩多次触发，最后问「项目叫什么、最爱的颜色、灯塔管理员是谁」仍答对。
- 必需指令本身已超出容量时明确失败，不循环压缩。models.dev 的 `contextWindow` 继续作为声明窗口；容量保护实现与本批验收见 `native-completion.md` 第十一批。通用偏好的自动压缩开关、持久化及实时策略已接通，验证见 `native-completion.md` 第十二批。

**存储（`fv-store`）**：`fastvibe.db`（目录，`PRAGMA user_version` 迁移、0600、`auto_vacuum` 先于 WAL、高版本拒绝打开）+
`sessions/<id>.jsonl`（只追加，首行 header，之后每行一条消息并用 `parentId` 串成链）。写入跟着 agent 的 `Committed` 事件走：
消息进入历史的那一刻就落盘（`sync_data`），崩溃最多丢当前这一条，写到一半的末行读取时跳过、下次追加前补换行。
重启后线程的历史从转写读回；旧转写继续用位置派生 id（`t3`、`t3i7`），新转写的独立开始/结束记录保留原回合 id、时间和错误卡片。插话、自动压缩和后续回复仍归同一轮，错误元数据不进入模型消息。分叉复制有效回合结果，回退标记按完整转写中的绝对位置和回合边界切分，避免压缩后的偏移错误或恢复旧分支错误；详见 `native-completion.md` 第十批。
首个提示词的第一行（最多 60 字）作为线程标题。

尚未做：present。失败回合错误项已通过独立转写记录持久化，无需伪造对应的模型消息。

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
| 远程协议改版，手机端需同步适配 | 按原生 schema 更新 Flutter；握手拒绝不支持的协议版本，不提供旧协议兼容层 |

## 9. 规则继承

AGENTS.md 里与框架无关的不变式原样带过来，例如：会话级调用带 `conversationId`；「运行中」以 settle 为界；
打开转写时补齐悬空工具调用；凭据不进 settings；提交信息一律英文；设置文案只写「做什么」。
与 pi SDK、Electron、React 绑定的规则（jiti 缓存、asar 补丁、shadcn、Base UI 分组陷阱、CSP）随旧实现作废。


### 个性化说明（2026-10-26）

原生个性化页现已接通：公共 `customSystemPrompt` 偏好、跨客户端通知、持久化与每轮系统提示词后缀共用一条通路，支持清空停用；运行中的回合不被改写，下一轮及排队回合读取新值。编辑器保留本地草稿，陈旧保存由 `expectedCustomSystemPrompt` 比较保护。验证范围与仍未完成的设置页见 `native-completion.md` 第十三批。


### 快捷键（2026-10-26）

原生快捷键页接通 11 项操作、录入/清除/恢复、冲突处理和回车发送。偏好经公共设置协议持久化并通知各客户端；单项修改在服务端锁内合并。窗口在编辑器键表之前读取当前绑定，旧固定应用绑定已移除，终端控制键和原生文字输入保留自身路径。验证记录及跨平台交付边界见 `native-completion.md` 第十四批。


### 应用使用统计（2026-10-26）

原生使用统计页与 `stats/usage` 已接通。SQLite 用量账本独立于可回退/可删除的转写，分叉继承请求来源；统计按客户端时区归日，费用按当前加载的模型目录逐请求估算，缺少价格保持未知。汇总、项目/对话分布、日/周/累计热图、逐模型趋势和占比已实现。完整服务端、存储、协议与 GUI 的代码验证及旧账本迁移等未完成边界见 `native-completion.md` 第十五批。


### 模型目录刷新（2026-10-26）

`model/catalog/get|refresh` 与每小时更新已接通，原生编码与 Electron 共用的快照格式/选择规则对拍。目录在后台下载、校验和原子替换，成功后新请求、模型列表及费用估算读取新快照；正在生成的模型请求继续使用原参数。关于页显示目录状态并支持手动更新，其余关于功能仍在迁移范围。完整验证与边界见 `native-completion.md` 第十六批。


### 模型详情（2026-10-26）

自定义供应商的模型详情已接通公共读取/单模型保存、并发比较保护、参数/输入能力/思考档位编辑与恢复目录值。已编辑元数据在模型同步和目录刷新时保留，价格继续从当前目录读取；明确继承协议、旧原生路由的一次迁移、混合网关鉴权和下一回合生效均有自动化用例。代码与验证范围见 `native-completion.md` 第十七批。

### 模型连通性自检（2026-10-26）

已保存模型的行内自检通过公共 `provider/model/test` 使用当前协议、鉴权和元数据，分别验证普通回复与不执行的测试工具。两个独立请求不创建对话、账本或工具副作用；结果只返回安全分类和耗时。请求有超时、输出及全局并发上限，断连清理资源；配置变化或切换设置页后拒绝旧结果。完整验证记录见 `native-completion.md` 第十八批。


### 供应商范围（2026-10-26 用户修正）

原生版仅支持用户配置的自定义端点、API 格式与 API Key；不支持 Claude、ChatGPT、Copilot 等任何模型订阅登录。未提交的订阅实现、协议和依赖已撤回，订阅凭据不纳入迁移目标。模型目录刷新、参数编辑和自检继续使用自定义供应商通路；MCP OAuth 属于工具服务认证，继续保留。
