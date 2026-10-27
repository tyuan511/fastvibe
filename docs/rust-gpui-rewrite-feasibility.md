# 用 Rust + GPUI 重写 FastVibe 的可行性分析

状态：**评估，未实施**。数据截至 2026-10-23。本文所有数字都是实测或可复核的（命令、文件路径、issue 编号、crates.io/GitHub API 响应）。

参考对象：`openai/codex`（`codex-rs`，Rust + app-server 架构）、`zed-industries/zed`（`crates/gpui`）。
另附 `can1357/oh-my-pi` 的实测结论，因为它常被认为「是 Rust agent」，实际不是。

---

## 0. 结论（先行）

**这个提案里藏着三个独立决定，风险等级完全不同，绑在一起做是最贵的那条路。**

| 决定 | 结论 | 一句话理由 |
|---|---|---|
| **A. Rust agent 内核 + app-server 架构** | ✅ **值得做，且架构已经建好了** | FastVibe 已有 App Protocol v1 + 中立调用表（258 频道）+ 无头 Agent（`src/agent/` 591 行），引擎对 Electron 的依赖只剩 **11 个文件**、全是桌面宿主能力。换内核语言不动架构。 |
| **B. GPUI 重写 UI 层** | ❌ **不建议** | 缺口里有 **5 项不是「贵」而是「不存在」**：无 webview（浏览器面板）、无数学公式渲染、a11y 不可用于生产、无富文本输入控件、crates.io 分发路径今天是坏的。且 Zed 的控件层（`ui`/`editor`/`markdown`/`terminal_view`）**全部 GPL-3.0-or-later**，闭源商业应用一行都用不了。 |
| **C. 界面对齐现有 Electron 版本** | ❌ **与 B 直接冲突** | 「对齐」的对象是 56,235 行 React + 1,456 行 CSS + 35 个 shadcn 原语 + 24 主题 × 41 token + Liquid Glass/浮动面板。GPUI 没有 CSS 引擎、没有 token 系统、没有控件库（可用的第三方是另一套设计系统），所以这不是重画而是**重造一套设计系统 + 全部界面**。 |

**关键判断：性能瓶颈不在绘制，所以 GPUI 解决不了实测的痛点，Rust 内核能。**

实测（本机 `logs/main.log`，2026-09-17 → 2026-10-23，36 天）：

```
事件循环停顿  count=174  min=200ms  p50=272ms  p90=701ms  p99=2376ms  max=3704ms
其中 >300ms 共 70 次
```

`docs/engine-utility-process.md` 自己写的判定条件是「**常见 500ms 以上**…值得做」进程隔离 —— 实测 p90 已经 701ms、p99 2376ms，**门槛已经被越过**。而这些停顿的来源是 Node 单线程上的同步工作（82 MB 转写解析 150–210 ms、`structuredClone`、git 轮询、JSON 序列化），**没有一项是像素绘制问题**。把 UI 换成 GPU 绘制不会让 p99 从 2376 ms 变短；把那部分工作移出 JS 主线程会。

**推荐路线：Rust 内核（参考 codex 的 app-server 协议设计）+ 保留现有 Electron/React UI，分阶段替换，第一阶段 2–4 周即可验证。** 详见 §6 路线 2 与 §7。

---

## 1. 三个决定为什么必须拆开

它们耦合在一个句子里（「Rust + GPUI + 自研 agent + 对齐现有界面」），但依赖关系是单向的：

```
        ┌─────────────────────────────────────────┐
        │ A. Rust agent 内核（说 App Protocol v1） │ ← 独立，可先做
        └────────────────┬────────────────────────┘
                         │ 不依赖
        ┌────────────────▼────────────────────────┐
        │ B. GPUI UI 层                            │ ← 独立，可永不做
        └────────────────┬────────────────────────┘
                         │ 前提
        ┌────────────────▼────────────────────────┐
        │ C. 界面对齐现有 Electron 版本            │ ← 只在 B 成立时才有意义
        └─────────────────────────────────────────┘
```

A 的收益（性能、内存、单二进制分发、去 Node 供应链）在保留现有 UI 时**全部拿得到**；B 的成本里有一大块**无法用钱解决**（生态缺口）；C 在 B 之上是纯成本无增量收益。

反过来说：**做 A 不需要对 B 表态**。这是本文最重要的一句话。

---

## 2. 现状基线（实测数字）

### 2.1 代码规模

```
src/                       117,958 行 TS/TSX
  src/main/                 51,016  (197 文件)
    engine/                 24,362  (110)
    pi/                     11,638  (31)   ← process-manager.ts 单文件 6,048
    rtc/                     3,213  (11)
    ssh/                     2,501  (7)
    remote/                  1,816  (4)
    server/                  1,604  (6)
    app-server/              1,252  (5)
    ipc/                     1,321  (7)
    顶层 13 文件             3,077
  src/renderer/             56,235  (325)  ← 另有 index.css 1,456 行
    components/settings/    10,280  (45)   ← 17 个 section
    components/chat/         9,916  (37)
    components/layout/       8,242  (26)
    lib/                     8,932  (92)
    components/ui/           3,737  (35)   ← shadcn 原语
    stores/                  3,436  (8)
    mock/                    4,568  (12)   ← 48 个预览参数
  src/shared/               10,025  (61)
  src/agent/                   591  (6)    ← 无头 Agent
resources/extensions/        4,723  (24)   ← 18 个内置扩展
resources/skills/            2,636  (32)   ← 7 个技能
scripts/                     3,923  (30)
test/                       35,906  (249 文件)  ← 25+ 用真 SDK，6 个用真 git 仓库
```

**仓库外的强耦合面**（任何重写都要一起考虑）：

- 手机端 `apps/mobile_flutter`：**80 个 `.dart` / 25,370 行**，说 App Protocol v1 + WebRTC 帧格式（`src/main/rtc/frames.ts` 与 `lib/protocol/rtc_frames.dart` 必须**字节一致**）
- 服务端 `fastvibe-services`（Go，**19,807 行**）：OAuth、设备注册、信令、TURN 计量、Bifrost 网关、计费

### 2.2 协议面

| 项 | 数量 | 证据 |
|---|---|---|
| IPC 频道 | **258** | `src/shared/ipc.ts` |
| 注册为方法（`handle()`） | **235** | `ipc/*.ts`、`main/index.ts`、`src/agent/handlers.ts`(132) |
| 纯推送频道 | **23** | 同上 |
| 远程允许 / 拒绝 | **162 / 73** | `src/shared/remote-policy.ts` 383 行，`assertPolicyCoverage` 漏分类即拒绝启动 |
| App Protocol 能力位 | **12** | `conversations/engine/workspace/git/terminal/providers/settings/stats/imports/extensions/browser/native` |
| i18n 键 | **2,075 (zh) / 2,077 (en)** × 6 ns | `locales/` |
| 设置 section | **17** | `components/settings/settings-sections.tsx` |

### 2.3 分发与运行时成本（实测）

```
安装包                        375 MB
  Electron Framework          239 MB   ← 64%，Chromium + Node
  app.asar                     58 MB
  officecli                    32 MB   ← 与 UI 框架无关，任何路线都要带
  app.asar.unpacked            17 MB   ← 原生模块：node-pty / node-datachannel / quickjs-wasi / koffi …
  file-icons                  7.0 MB   ← 1,303 个 SVG
  models-dev                  552 KB   ← 3,646 模型 / 5,737 别名

运行时内存（当前进程）         ~480 MB
  主进程                       225 MB
  4 个 Renderer helper         255 MB
  cua-driver worker              6 MB

启动 window-shown              典型 1.8 s / 5.2 s，最差 13.4 s（冷 + MCP）
  其中 main-loaded             740–1,227 ms（静态 import 图；单 pi SDK import 就 240–270 ms）
  engine-ready                 1,540–3,408 ms
```

**Rust 化能拿到的分发收益**：去掉 239 MB Chromium 需要**同时**换掉 UI（路线 1/3）；只换内核（路线 2）能去掉的是 `app.asar` 里 pi SDK 那部分与 Node 依赖树，以及**无头 Agent 的整个 tar.gz**（现在是打包 Node 运行时 + npm 依赖，`scripts/check-agent-runtime.mjs` 用 TS AST 走 import 图推断依赖 —— 换成单二进制后这 105 行可以整个删掉）。

---

## 3. 决定 A：Rust agent 内核 + app-server 架构

### 3.1 codex-rs 的真实情况（实测）

仓库 `openai/codex`，`main` @ `e6ebdfe0`（2026-10-23）：

```
130,544 star / 20,578 fork / 24,308 open issue / ≥479 贡献者
近 3 个月 3,998 commit（≈43/天），25 天发 14 个 stable（rust-v0.158.0 → 0.164.0）
codex-rs: 161 workspace member / 5,488 个 .rs / 2,141,283 行
          生产 1,149,968 行，测试 991,315 行（46.3%）
          edition 2024，工具链钉 1.99.1，Apache-2.0
```

最大的几个 crate（生产行数）：

| crate | 生产行 | 职责 |
|---|---|---|
| `codex-tui` | 302,160 | ratatui 全屏 UI，**是 app-server 的客户端** |
| `codex-core` | 149,869 | 会话循环、模型客户端、工具、压缩、沙箱编排 |
| `codex-app-server` | 54,402 | JSON-RPC 服务端 |
| `codex-app-server-protocol` | 35,259 | 协议类型（ts-rs / schemars 生成 TS 与 JSON Schema） |
| `codex-exec-server` | 37,928 | 独立子进程执行服务（PTY + FS RPC） |
| `codex-windows-sandbox` | — (30,368 总行) | ACL + AppContainer |
| `codex-thread-store` | 24,291 | JSONL + SQLite 分页历史 |
| `codex-rmcp-client` | 20,930 | MCP 客户端 |

**app-server 协议规模**：178 个 client request / 9 个 server request / 86 个 server notification。随仓提交 **320 个 JSON Schema + 751 个 TypeScript 类型文件**，由 `codex app-server generate-ts` 生成，测试里比对（`schema_fixtures_tests.rs`），所以协议与代码不会漂移。

**「UI 与内核解耦」在 codex 内部是真做到的**：`codex-tui/Cargo.toml` **没有 `codex-core` 依赖**，走 `codex-app-server-client` 的 in-process typed channel；三种目标 `Embedded / LocalDaemon(UDS) / Remote(ws)`（`tui/src/lib.rs:328`）。唯一后门是 `legacy_core::config`（TUI 里 144 处），只是配置读写。

→ **架构参考价值很高，这是 codex 最值得学的一块**：双向 RPC、审批走**服务端反向请求**（`item/*/requestApproval`、`item/tool/requestUserInput`）、事件按 item 生命周期组织（`item/started` → `*/outputDelta` → `item/completed`）、schema 由代码生成并提交入库。

### 3.2 但 codex-rs **不能直接当 FastVibe 的内核**：四个致命不匹配

| # | 不匹配 | 证据 | 对 FastVibe 的后果 |
|---|---|---|---|
| **1** | **只支持一种 wire 协议：OpenAI Responses** | `model-provider-info/src/lib.rs:111` `pub enum WireApi { #[default] Responses }`；`"chat"` 被显式拒绝（`CHAT_WIRE_API_REMOVED_ERROR`，附迁移讨论链接）。全仓 `grep -li anthropic` 只命中「从 Claude Code 导入」与凭据代理；`gemini` / `generativelanguage` **零命中**。Vertex AI 走的是 **OpenAI 兼容端点**，不是 Google 原生协议。 | FastVibe 的 `PROVIDER_APIS` 有 **4 种**（`openai-completions` / `openai-responses` / `anthropic-messages` / `google-generative-ai`，`src/shared/types.ts:977`），且「任意兼容端点」是产品定位（中转站、relay、按模型覆盖协议）。用 codex 内核 = **砍掉核心卖点**。 |
| **2** | **协议本身标注 experimental / 不支持生产** | 官方文档原话（`developers.openai.com/codex/app-server`）：*"The `app-server` command and WebSocket transport are experimental and aren't supported for production workloads."* 无协议版本号、无 semver 承诺；`initialize` 响应不含版本字段；稳定性只靠 `experimentalApi` 能力位 + `#[experimental]` 标注。25 天 14 个 stable。 | 把产品建在它上面 = 每周追协议变更，且上游不接受 PR（`docs/contributing.md`：*"We do not accept external code contributions or pull requests"*），任何改动自己维护。 |
| **3** | **crate 一个都没发布到 crates.io** | 逐个查证：`codex-core` / `codex-tui` / `codex-app-server` / `codex-mcp` / `codex-rollout` / `codex-login` / `codex-rmcp-client` **全部 404**。crates.io 上的 `codex-protocol` 0.63.0 是**第三方 fork**（`namastexlabs/codex`）。依赖图不干净：8 个 git 依赖 + `[patch.crates-io]` 3 处（crossterm / tokio-tungstenite / tungstenite）。 | 「作为依赖引入」这条路不存在。只能 vendor 源码 / fork / 走 JSON-RPC。vendor 150k 生产行 + 追周更 = 维护灾难。 |
| **4** | **产品能力对不上** | codex **没有**：read/write/edit 文件工具（只有 `exec_command` + `apply_patch`）、checkpoint/文件回退（`GhostSnapshotConfig` 注释：*"snapshots are no longer produced"*）、会话树与任意分支跳转（只有 fork 成新 thread + revert 掉尾部 turn）、rollout 文件格式版本号、本地价格表（成本靠每 150 s 轮询 OpenAI 后端 `analytics/codex/turn-costs`）、models.dev 元数据、SSE MCP transport、真正的代码扩展系统（`codex-hooks` 14 个事件但只能跑脚本，`ext/*` 必须改 fork）。 | FastVibe 每一项都有且是已发布功能：checkpoint（`engine/checkpoint.ts` 506 行，重试回退文件）、会话树（pi v3 `parentId` 链 + `navigateTree`）、阶梯计费（`engine/pricing.ts` + models.dev `tiers`）、4 个导入适配器（pi/Claude Code/Codex/opencode）、`resources/extensions/` 18 个真代码扩展。 |

**另外两点值得注意：**

- **沙箱是 codex 的重投入，而 FastVibe 明确不要它**。codex 有 Seatbelt SBPL、Landlock+bwrap（`linux-sandbox` 12,748 行）、Windows ACL+AppContainer（30,368 行）、Guardian 自动审查（9,072 行）、execpolicy、network-proxy 凭据代理（33,963 行）。而 `AGENTS.md` 写着：「**No approvals.** FastVibe never asks the user to approve a tool call: there is no permission mode, no sandbox extension…Do not re-add a gate here without the user asking for one.」→ codex 约 **8 万行**投入在 FastVibe 主动放弃的能力上。
- **商标与商务风险**。Apache-2.0 §6 不授予商标权（不能叫 Codex、不能用 logo、不能暗示 OpenAI 背书）；`AuthMode::ChatgptAuthTokens` 标注 *"[UNSTABLE] FOR OPENAI INTERNAL USE ONLY - DO NOT USE"*；app-server 文档要求企业集成方把 `clientInfo.name` 报备进 known clients list。把产品绑定在 ChatGPT OAuth 上是单点风险。**OpenAI ToS 是否允许第三方客户端使用 ChatGPT 账号 OAuth：未查证。**

### 3.3 决定性事实：FastVibe **已经是** app-server 架构

这是本次评估最重要的发现。`docs/app-server-protocol.md`（559 行）第一句：

> 本文描述 FastVibe App Server v1 的公开接入协议。第三方桌面端、移动端或自动化客户端可以按本文直接连接正在运行的 FastVibe；**不需要 Electron**，也不需要加载 FastVibe 的网页客户端。

已建成的部分：

| 组件 | 规模 | 说明 |
|---|---|---|
| `src/main/app-server/` | **1,252 行** | `AppServer` + `capabilities`(128) + `ClientSession`(389) + `EventBus`(252) + `runtime`(76) |
| `src/shared/app-protocol.ts` | 411 行 | `APP_PROTOCOL = "fastvibe.app"`、`APP_PROTOCOL_VERSION = 1`、`isProtocolCompatible()`、12 项能力位 |
| `src/main/ipc/registry.ts` | 104 行 | **传输中立调用表**：`handle(channel, fn)` / `dispatch(channel, payload, ctx)`，`ctx = { kind: "window"\|"remote", window, origin }` |
| `src/main/ipc/broadcast.ts` | 98 行 | 推送中枢，50 处调用点，`{ except, only }` |
| `src/shared/api.ts` | 740 行 | `createFastVibeApi(transport)`，230 处 `t.invoke`，20 个服务分组 |
| `src/agent/` | **591 行** | 同一引擎跑成无头服务（SSH 主机上的 Agent），132 个 `handle()` |
| `src/main/remote/gateway.ts` | 970 行 | 把远端 App Server 的目录/事件命名空间化后并入本地视图 |

**并且引擎已经基本不依赖 Electron**。实测 `rg -l 'from "electron"' src/main/engine src/main/pi src/main/server src/main/rtc` 只命中 **11 个文件**，全部是桌面宿主能力而非引擎逻辑：

```
pi/browser-bridge.ts        pi/cua-bridge.ts           pi/cua-component.ts
pi/computer-grant-flow.ts   engine/notifications.ts    engine/network-proxy.ts
engine/app-settings.ts      engine/media-protocol.ts   engine/file-icons.ts
engine/logger.ts            engine/keep-awake.ts
```

`src/main/server/`（1,604 行）与 `src/main/rtc/`（3,213 行）**文件头就写着 Electron-free**，以 `dispatch`/`subscribe` 为注入点。`docs/engine-utility-process.md` 已论证：从 `pi/process-manager.ts` 出发可达的 **116 个模块无一直接 `import "electron"`**。

→ **「参考 codex 的 app-server 架构」这件事，FastVibe 已经做完了，而且做得更彻底**：codex 的 app-server 是 experimental、无版本号、协议周更；FastVibe 的 App Protocol v1 是手机端（25,370 行 Dart）的**生产协议**，有版本兼容检查、559 行文档、162/73 的远程策略分类与启动期覆盖检查。

**所以真正的问题不是「要不要 app-server 架构」，而是「内核用什么语言实现」—— 而这个问题可以在不动 UI、不动协议、不动手机端的前提下单独回答。**

### 3.4 oh-my-pi 的实测结论（附，因为它常被误认）

用户最初提到的 `can1357/oh-my-pi`：**不是 Rust agent**。

```
36,322 star / MIT / 9,303 文件
语言分布：TypeScript 76,052,247 B (6,197 个 .ts)  ← 主体
          Rust       11,477,007 B (753 个 .rs)    ← napi 原生扩展
packages/: coding-agent 4,138 文件、ai 1,077、tui 920、catalog 525 …
crates/:   pi-natives 194、pi-builtins 150、pi-edit 49、pi-shell 47、
           pi-predict 22、pi-vfs 16、pi-vcs 13、pi-iso 12、pi-ast 9、
           pi-voice 8、pi-walker 6、pi-diff 1、vendor 215
构建：Bun + Bazel
```

即：**TypeScript 主进程 + Rust 做热点原生扩展**（编辑匹配、shell、tree-sitter、预测）。这恰好是本文 §6 路线 4 的形态 —— 一条比「全量重写」便宜得多的路，而且已被一个 36k star 项目验证。

### 3.5 自研 Rust 内核的工作量分解

以「功能等价于 FastVibe 今天用到的 pi SDK 能力」为口径（不是等价于 pi 的全部）：

| 子系统 | 现有 TS 侧 | Rust 参考量 | 人月 |
|---|---|---|---|
| **wire 协议客户端**（4 种：Responses / Chat Completions / Anthropic Messages / Google GenAI；SSE 流式；reasoning/thinking；重试与错误分类；`baseUrl` 按协议翻译） | pi-ai（外部包）+ `provider-url.ts` 51 + `model-api.ts` 40 + `thinking-off.ts` 396 | codex 只有 1 种，`model-provider-info` + `client` | **14–22** |
| **会话内核**（agent loop、turn 边界、`agent_settled` 语义、工具调用编排、steer/queue、会话树 v3 `parentId` 链、`navigateTree`、分支） | pi-agent-core + `process-manager.ts` 6,048 | `codex-core` 149,869 生产行 | **18–30** |
| **compaction + 窗口保护**（90% 触发、分片摘要、缩窗重试 6 次、预算学习、尾部重切、SDK 内存投影预演） | `native-compaction.ts` **569**（适配 11 个 `_` 私有方法） | codex `compact*.rs` 三种实现 | **5–8** |
| **转写持久化**（pi v3 JSONL 契约、relink、`closeOrphanToolCalls`、原子写、82 MB 会话 150–170 ms 打开、4 个外部 agent 导入适配器） | `transcript-file.ts` 336 + `session-open.ts` 29 + `import/` 3,914 | `codex-thread-store` 24,291 + `rollout` 12,447 | **8–13** |
| **provider/模型系统**（models.dev 快照 v5 编解码 3,646 模型 / 5,737 别名、全序折叠、每小时刷新、`models.json` 生成、OAuth PKCE 订阅登录、阶梯计费、轻量模型、模型自检） | ≈ 3,500 行 | codex 用自带 `models.json`（OpenAI 模型形状）+ `/models`，**无本地价格表** | **6–10** |
| **MCP 客户端**（stdio + streamable HTTP、图片结果保真、`isError`、后台连接、代次隔离、按服务器重连、exposure 三档） | `mcp-manager.ts` 300 + pi-mcp（外部） | **`rmcp` 现成 crate（3.7.0，3,900 万下载，Apache/MIT）可直接用** | **3–5** |
| **扩展系统**（18 个内置扩展 4,723 行、jiti 从 asar 外加载、`ctx.ui` 桥、TUI 组件→GUI、`rpc` 模式、阻塞式提问按会话排队） | `extension-manager.ts` 122 + `tui-bridge.ts` 270 + 扩展本体 | codex `hooks` 17,105 行（**能力更弱**：不能注册工具/改消息） | **12–20** |
| **技能**（发现 4 种落点、同名遮蔽诊断、市场搜索/安装、自写 gzip-tar 解包器） | `skill-manager.ts` 205 + `skills-market.ts` 475 + `gzip-tar.ts` | codex `ext/skills`（`SKILL.md` + 渐进披露） | **3–5** |
| **子 agent / DAG / 定时任务 / 记忆** | subagent 1,033 + agents 171 + dag-scheduler 635 + dag-store 325 + scheduled 682 + memory 1,299 + 4 份提示词模板 1,595 行 | codex `multi_agents`（9 个工具）+ `thread-store` | **10–16** |
| **工具面**（read/edit/write/bash/grep/find/ls、present、worktree、conversation_search、web_search 旁路、codemode(QuickJS)、tool_search、browser_*、computer_*、question、todo、goal、handoff、schedule_*、fastvibe_config_*） | 分散在扩展与 `engine/` | codex 工具面**小得多**（无文件工具） | **12–20** |
| **工具图片管线**（原图落盘、长边 1568/512 KB 缩小、按字节预算裁剪、引用化、分叉硬链接、旧转写在内存里换引用） | `tool-images.ts` 375 + `context-images.ts` 155 + 扩展 | codex 无对应 | **3–5** |
| **Git / 工作区 / 文件**（source-control、变更树、历史图形泳道、提交信息 AI 生成、检查点捕获、文件树增删改、realpath 边界） | ≈ 3,000 行 | `git2`（libgit2 绑定）现成 | **6–10** |
| **存储层**（SQLite 9 步迁移、`RowWriter` 按行落盘、多进程合并、旧 JSON 导入 + `.migrated-` 改名、检查点事务） | `db.ts` 629 + `db-schema.ts` 237 + 各 store | `rusqlite` / `sqlx` 现成 | **4–7** |
| **远程访问 + WebRTC**（RemoteServer、scrypt、背压、心跳、mDNS、policy 235 分类；帧分片、netpath、portmap、signaling、channel-socket） | server 1,604 + rtc 3,213 + shared/remote-* 687 | `axum`/`tungstenite`/`mdns-sd`/`webrtc-rs` 现成，但 **netpath/portmap/帧格式是自研逻辑** | **12–20** |
| **无头 Agent（SSH）** | `src/agent/` 591 + `ssh/` 2,501 + `build-agent-runtime.mjs` 226 | Rust 单二进制，**这块是净简化** | **4–7** |
| **测试重建** | 249 文件 / 35,906 行（25+ 用真 SDK、6 个真 git、若干真网络/真 WebRTC） | codex 测试占 46% | **15–25** |
| **内核侧小计** | | | **135–223 人月** |

**注**：以上是「等价功能 + 等价质量 + 等价测试」口径。若砍掉可砍的（扩展系统改为纯 hooks、只支持 2 种 wire 协议、不做导入适配器、不做记忆），可压到 **60–90 人月**，但那是另一个产品。

---

## 4. 决定 B：GPUI 重写 UI 层

### 4.1 分发与版本：**官方推荐路径今天是坏的**

crates.io API 实测（`curl -sL -A 'research/1.0' https://crates.io/api/v1/crates/gpui`）：

```
max_version = 0.2.2   updated_at = 2025-10-22   num_versions = 7
downloads = 388,921   recent_downloads = 219,324
可用版本只有 3 个，全部集中在 2025-10-09 ~ 10-22 那 13 天
0.2.2 之后没有任何新版本（index.crates.io/gp/ui/gpui 确认）
```

- 落后 main：`69e2130...main` → `ahead_by: 8471`；只看 `crates/gpui` 路径，`since=2025-10-23` 的 commit = **610**
- 代码量差：crates.io 0.2.2 = **63,048 行 / 127 文件**；main = **102,118 行 / 147 文件**（+62%）
- 0.2.2 缺什么：**零 a11y 代码**（`grep -ril accesskit src/` → 0 个文件）、无 `SystemNotification`、无 `gpui_platform`

**README 与现实矛盾（已实机复现）**：main 的 `crates/gpui/README.md` 让你写

```toml
gpui_platform = { version = "*", features = ["font-kit", "wayland", "x11"] }
```

但 `crates/gpui_platform/Cargo.toml` 是 `publish.workspace = true`，而 `[workspace.package] publish = false` → **不可发布**。`gpui_platform` / `gpui_linux` / `gpui_windows` / `gpui_apple` / `gpui_wgpu` / `gpui_web` / `gpui_ios` 在 crates.io **全部 404**。实机结果：

```
error: no matching package named gpui_platform found
```

即：**crates.io 的 0.2.2 是「旧世界」（`Application::new()` 自己造平台），main 的 README 是「新世界」（平台拆成独立 crate 且未发布），两者对不上。**

semver 承诺：`crates/gpui/README.md` 原文 —— *"GPUI is still in active development as we work on the Zed code editor, and is still pre-1.0. **There will often be breaking changes between versions.**"* 破坏性变更实例：`ScrollWheelEvent` → `ScrollEvent`（PR #65805，merged 2026-10-20）；issue #46183「Examples are outdated and incompatible with current gpui version」。

**现实中的 5 条获取路径，且类型互不兼容**：

| 方式 | 版本 | 日期 | 维护方 | 问题 |
|---|---|---|---|---|
| crates.io `gpui` | 0.2.2 | 2025-10-22 | Zed | 12 个月未动，缺 a11y/通知/新平台拆分 |
| `git = zed` main | 每日变 | — | Zed | 无版本、天天破 API |
| `gpui-pre-*` 快照 | 0.3.9（= zed@93d7456） | 2026-10-12 | **第三方个人**（huacnlee） | 靠个人每周打快照 |
| `gpui-ce`（社区 fork） | 0.3.0 | 2026-10-20 | gpui-ce 组织 | *"mostly API compatible, but that is changing"* |
| `gpui-unofficial` / `gpui-fast` | 1.25.2 / 0.1.10 | 2026-10-22 | iamnbutler / longbridge | 前者镜像 Zed tag，后者改过布局引擎 |

`gpui-tray` 的 README 明说：*"Select exactly one of `gpui`, `gpui-kit`, or `gpui-ce`… must use the same GPUI source and compatible versions to share Rust types."* → **选错一次，两个第三方库就不能组合**。这对一个要维护多年的商业产品是结构性风险。

### 4.2 许可分裂：**GPL 挡住建控件层**

- `crates/gpui/Cargo.toml`：`license = "Apache-2.0"` → **本体闭源商用没问题**，无 CLA（CLA 只对贡献者，`CONTRIBUTING.md:65`）
- 整个 gpui 家族全部 Apache-2.0（`gpui_apple/linux/macos/windows/wgpu/web/ios/platform/macros/util/collections/sum_tree/http_client/refineable/media`，逐个查过）
- 仓库整体：*"Zed source code is licensed primarily under **GPL-3.0-or-later**, with Apache-2.0 components where marked."*
- **产品层 crate 全 GPL-3.0-or-later**：

| crate | 行数 | 许可 |
|---|---|---|
| `ui`（Zed 的控件库，36 个组件） | 29,736 | **GPL** |
| `editor`（文本编辑器） | **190,633** | **GPL** |
| `markdown` | 9,488 | **GPL** |
| `terminal` + `terminal_view` | 22,864 | **GPL** |
| `agent_ui` / `workspace` / `theme` | — | **GPL** |
| `ui_input` / `component` / `notifications` / `title_bar` | — | **GPL** |
| `auto_update` / `auto_update_ui` / `mermaid_render` / `syntax_theme` | — | **GPL** |
| `html_to_markdown` | — | Apache-2.0（少数例外） |

→ **闭源商业应用可以链接 `gpui`，但不能链接 `ui`/`editor`/`markdown`/`terminal_view`/`auto_update`。** 这直接决定了：Zed 自己为解决这些问题写下的 **25 万行**，FastVibe 一行都用不了。

未解决的许可争议：issue **#14753「License clarification」**（open，2024-07-18 至今）—— Apache-2.0 与 GPLv3 的兼容性被质疑，官方只回了「每个 crate 各自带 LICENSE 符号链接」，**到今天没有正式澄清**。商标政策：仓库与 `legal/terms.md` 里**未找到明文条款**（未查证）。

**可用的替代控件库**：`longbridge/gpui-kit` 的 `gpui-component`（**Apache-2.0**，85 个模块 / 75+ 组件，crates.io 0.8.0、319,669 下载，含 DataTable / VirtualList / Dock / Chart / Tree / Markdown / CodeEditor / sidebar / message_scroller / bubble / input）。生态是**真实存在**的（`awesome-gpui` 141 条项目，gpui 反向依赖 140 个；OpenLogi 23,971★、gpui-kit 18,539★、disktree 3,504★、zeron 3,327★…）。

但：**它是另一套设计系统，不是 shadcn Nova。** 用它 = 界面语言重做，与决定 C（对齐现有界面）冲突。

### 4.3 能力缺口表：5 项「不存在」，不是「贵」

gpui 本体只有 **14 个元素原语**，零控件：

```
crates/gpui/src/elements/
  anchored  animation  canvas  container_query  deferred  div
  image_cache  img  list  surface  svg  text  uniform_list
```

| # | FastVibe 需要 | GPUI 侧现状 | 判定 |
|---|---|---|---|
| **1** | **应用内浏览器面板**：导航任意站点、注入脚本、DOM 快照（`data-fv-ref`）、点击/输入、`findInPage`、`setZoomFactor`、`capturePage` 截图、打印、`persist:` 分区、UA 改写、设备预设、下载/历史库。渲染层 **1,681 行**（`browser-guest.ts` 797 + `side-pane-browser.tsx` 710 + `@shared/browser-page.ts` 174），另有 `engine/browser-cdp.ts` 488 | gpui **与 Zed 都没有 webview**（`grep -rn "wry" Cargo.lock` → 0 命中）；Zed 的 markdown 预览是原生元素不是 webview。PR **#54433「Add WebView element backed by wry + WebKitGTK」closed, merged=false**；issue #21208「Webview via Extensions」open 自 2024-11-26。第三方 `gpui-webview`(wry, Apache) 的 README 自己写：Windows **"Not yet; the WebView covers overlays"**、Linux Wayland **不支持（必须 XWayland）**、*"the native view covers GPUI content in its bounds, including popovers, dialogs, menus and tooltips. **It cannot be clipped either**"* | ❌ **不可行**（Windows 上弹层被 webview 盖住是产品级硬伤；且 `findInPage`/`capturePage`/`print` 在 wry 侧无等价物） |
| **2** | **数学公式**：`$…$` / `$$…$$` / ` ```math `，KaTeX 排版，20 个 woff2，`throwOnError:false`，Pandoc `tex_math_dollars` 严格内联判定（`remark-strict-inline-math.ts` 95 行） | Zed `crates/markdown/src/parser.rs:734`：`Event::InlineMath(_) \| Event::DisplayMath(_) => {}` —— **直接丢弃**。PR #57339（用 `ratex` 转 SVG，2026-05-21 open）、#54668（open）、#58593 与 #61892（**closed, merged=false**）、issue #40813（open 自 2025-10-21）。第三方 `ratex-gpui` 在一个 71★ 仓库内 | ❌ **不存在**（要么自研 TeX 排版引擎，要么等上游，要么砍功能） |
| **3** | **无障碍**：设置面板、聊天、表格、对话框的可读性；macOS VoiceOver / Windows UIA / Linux AT-SPI | AccessKit 支持 **2026-05-27 才进 main**（commit `1d029c5ff5`，PR #56065）；crates.io 0.2.2 **零 a11y**；即使 main，全仓库只有 **31 处** `.role(Role::…)`（AccessKit 提供 182 个 role）。issue **#41138「Windows: Screen reader accessibility missing completely」**（open，JAWS/NVDA 实测「绝对沉默」），Zed 员工回复：*"Zed has a long way to go when it comes to accessibility… **not something we'll get to in the near future**."* 另有 #14390「Mac: Full Keyboard Access renders Zed inoperable」、#65111、#65623 | ❌ **不可用于生产** |
| **4** | **富文本输入框**（composer 1,228 行）：多行编辑、IME 组合、选区、撤销、`@` 文件选择与 `/` 斜杠面板的触发与光标计数、技能 badge 草稿态、textarea + 高亮层双层叠加（`.chat-editor-layer`）、16px 触控规则、Tab 采纳推荐 | gpui **无任何输入控件**，只给 `ElementInputHandler` / `EntityInputHandler` trait。可用实现：① `crates/gpui/examples/input.rs`（**920 行**，且 issue #64389 指出其 IME 选区算错、**copy 会 panic**）；② Zed `editor`（190,633 行，**GPL**）；③ `gpui-component` 的 Input/Textarea/Editor（Apache，行为不同，需改造） | ⚠️ **需自研或改造，数万行量级** |
| **5** | **自动更新**：`electron-updater`（363 行）+ release notes HTML 白名单解析 + 侧栏按钮与对话框共用 `update:state` | Zed 自研（`crates/auto_update`，**GPL**）且深度耦合 `client`/`db`/`release_channel`/`paths`/`workspace` → **抽不出来**；macOS 用 `hdiutil` + rsync，Windows 需独立 `auto_update_helper` 进程。Rust 侧无 electron-updater 等价物：`self_update`(MIT) 能覆盖单二进制替换但**未查证**能否正确处理 `.app` bundle 原子替换 + 保持 codesign/公证；`tauri-plugin-updater` 硬依赖 `tauri`（依赖列表里有 `tauri ^2.6`） | ⚠️ **需自研**（下载器 + 签名校验 + 三平台安装器 + 重启） |
| 6 | 系统托盘 | gpui main **0 处** `NSStatusItem`/`tray`；0.2.2 的 `src/platform/mac/status_item.rs` **模块没被 `mod` 声明**（死代码）。PR #13098「linux: Implement tray icons」**closed 2024-08-22**，官方理由「没有令人信服的用例」。替代：第三方 `gpui-tray 0.3.0` | ⚠️ 第三方 |
| 7 | 全局快捷键 | gpui **0 处** `RegisterHotKey`；只有应用内 keymap。替代：`global-hotkey 0.9.0`（tauri 系） | ⚠️ 第三方 |
| 8 | 图表（使用统计折线/饼图、记忆散点） | Zed **无任何 chart/plot**。`gpui-component` 有 `area/bar/line/pie/radar/sankey/candlestick`（Apache）；另有 `plotters-gpui`、`gpui-d3rs`（星数都很小） | ⚠️ 第三方（现有 `recharts` + `ui/chart.tsx` 370 行） |
| 9 | 拖拽排序（侧栏项目/会话、排队托盘 250ms 长按、供应商与模型排序） | gpui 有 `on_drag`/`on_drag_move`/`on_drop`/`drag_over` 原语 + `examples/drag_drop.rs`，但**没有** dnd-kit 那样的通用 sortable 容器。`gpui-component` 的 DataTable 支持列头拖动、Dock 支持 tab 拖拽 | ⚠️ 需自建（现有 `@dnd-kit/*` 5 处） |
| 10 | **代码高亮**：140 种 Shiki 语法（`LANGUAGE_LOADERS`）、wasm oniguruma、`@shikijs/stream` 增量、`embeddedLanguages`（markdown 里的围栏，上限 8）、CSS 变量主题映射 `--code-*`、围栏行号 + 语言文件图标 | Zed 用 **tree-sitter**（`crates/language` 的 `highlight_text`）+ 自己的 `SyntaxTheme`；`gpui-component` 的 `highlighter` 支持 tree-sitter 或 syntect（200 语言） | ✅ 有等价物，但**技术栈不同**：140 个 Shiki 语法与 `--shiki-*` 映射要重做为 tree-sitter grammars + 主题映射；`test/syntax-highlighter.test.ts` 钉住的「每个 loader 键必须是语法 id」这类不变式全部重建 |
| 11 | **Markdown 管线**：raw → sanitize → KaTeX 顺序、`MARKDOWN_HTML_SCHEMA` 白名单（`fvpath:`/`file:`/`data:image` 协议、`class` 只放行 3 个数学 class）、`splitMarkdownBlocks` 不切断开标签、`blank-output`/`thinking-row` 占行规则 | Zed `markdown` crate **GPL**；`gpui-component` `text::TextView` 是另一套。gpui 侧的内联 HTML 只认 20 个标签（`html_parser.rs`），**不认识 `details/summary/kbd/sup/sub/video/div/span`**，且**没有 CSS 引擎** | ⚠️ 需自研（现有 `lib/markdown-*` 5 个文件 + 3 个自写 remark 插件 + 6 个纯函数测试） |
| 12 | 虚拟滚动长列表 + 跟随底部 | ✅ **一等公民**：`gpui::list` + `ListState`（不等高，`SumTree` 测量，`ListAlignment::Bottom` 注释即 *"like a chat log"*）、`ListState::set_follow_mode` / `is_following_tail`、`uniform_list`（等高） | ✅ 可用 |
| 13 | 终端（xterm + fit/search/web-links addon + node-pty） | Zed 用 `alacritty_terminal`（zed fork）+ `vte`，但 `terminal`/`terminal_view` 是 **GPL 22,864 行**。上游 `alacritty_terminal 0.26.0` 是 **Apache-2.0**，可合法复用其 `Term`/`Grid` + `vte::Parser`，**渲染层需自写**（字形网格、选区、滚动、光标、查找条、链接） | ⚠️ 解析可复用，渲染自写 |
| 14 | 窗口/系统集成 | ✅ 多窗口、`WindowBackgroundAppearance::{Opaque,Transparent,Blurred,MicaBackdrop,MicaAltBackdrop}`（macOS 自建 `BlurredView : NSVisualEffectView`）、`TitlebarOptions{traffic_light_position}` + `set_traffic_light_position`、`WindowButtonLayout`、`set_menus`/`set_dock_menu`、`prompt_for_paths`/`reveal_path`/`open_with_system`、`FileDropEvent`、`WindowAppearance` + `on_appearance_changed`、`scale_factor()`、`WindowInsets{safe_area, ime, corner_radii}`、`prevent_idle_sleep`/`prevent_app_nap`、`register_url_scheme`/`on_open_urls`、`thermal_state`、`screen-capture` | ✅ 大体齐全（X11 无背景模糊，issue #14590 open；`Transparent` 在 Windows 上有 #65402） |

### 4.4 中文 / CJK / IME：**这是生死线，现状是「能跑但不稳」**

**字形整形分平台三套实现**（不可能完全一致）：

| 平台 | 实现 | 文件 |
|---|---|---|
| macOS | **CoreText**（`CTLine::new_with_attributed_string`） | `crates/gpui_apple/src/text_system.rs:583` |
| Windows | **DirectWrite**（自绘光栅化） | `crates/gpui_windows/src/direct_write.rs` |
| Linux / wgpu | **cosmic-text 0.19**（harfrust 整形 + swash 光栅 + unicode-bidi + fontdb） | `crates/gpui_wgpu/src/cosmic_text_system.rs` |

**BiDi**：Windows 侧 `bidiLevel: 0` **硬编码 3 处**（`direct_write.rs:693, 933, 1941`）→ RTL 强制 LTR。实证 issue #65506「Persian (RTL) agent messages render LTR — unreadable on Windows」（2026-10-12 以 `not_planned` 关闭）。PR #65344「Improve Arabic and bidirectional text support」**merged: false，已关闭**；#57239、#57240 同样未合。→ 对纯中文应用影响有限，但说明文本栈的完成度。

**CJK 未修 issue（全部 open）**：

| # | 日期 | 问题 |
|---|---|---|
| **#65973** | **2026-10-22（昨天）** | 长行含 CJK 全角字符且紧邻另一长行时**文本被截断**（`soft_wrap: none`）—— 字符在 buffer 里但画不出来 |
| #60059 | 2026-06-29 | **U+3000 全角空格渲染成半角** → 中文对齐排版直接失效 |
| #64832 | 2026-09-26 | CJK 来自 `buffer_font_fallbacks` 时，重启后**斜体注释里的中文乱码** |
| #61829 | 2026-07-29 | 终端里 East Asian Ambiguous 宽度字符（①②③）在 macOS **重叠相邻单元格** |
| #19940 | 2024-10-30（**open 两年**） | **无 CJK 分词** → 双击选词按标点走 |
| #60155 | — | `font_weight` ≠ 400 时字体回退设置失效 |
| #62803 / #42255 / #15925 / #55890 | — | 彩色 emoji 不完整（COLRv1、位图 emoji） |

字体回退机制是「每个 `Font` 显式带一组回退族名」（`FontFallbacks(Arc<Vec<String>>)`），**不是按码位自动找覆盖字体**；macOS 默认回退到 `.AppleSystemUIFont`。

**IME：14 个 open issue**（`area:controls/ime` label 共 37 个），三平台都实现了（macOS `NSTextInputClient`、Windows `WM_IME_*` + TSF、Wayland `zwp_text_input_v3`、X11 `zed-xim` fork），但持续出问题：

| # | 平台 | 严重度 | 问题 |
|---|---|---|---|
| **#65868** | macOS | **S2** | 2026-10-20：**中文输入法处于 ASCII 模式时 Option 系快捷键全部失效** |
| **#59882** | Windows | **S2** | 2026-06-25：**中文输入在 editor / Agent panel / Git commit 输入框间歇性失效** |
| #60578 | Linux X11 | — | `XIMClientError` 之后 IME **永久损坏，无重连** |
| #54959 / #58192 / #52952 | Linux X11 | — | fcitx5 中文输入不工作 / 间歇失效 / 中英切换失效 |
| #64687 | macOS | — | Google 日语输入时 `NSTextInputContext` **崩溃** |
| #61937 | macOS | — | 用中文输入法时菜单栏一闪即关 |
| #59193 | Windows | — | 中文输入时文本垂直跳动 |
| #64850 | Windows | — | 候选窗位置错，盖住正在输入的文本 |
| #65302 / #65847 | Wayland | — | preedit 子段无视觉区分；修复 PR **未合入** |
| #62764 / #64597 | 跨平台 | — | 多击键绑定（`Ctrl+K`）被 IME 截获 / 之后吃掉下一次输入 |

已修的（说明在动，但**没收敛**）：#62808（2026-08-18 CJK IME insert mode）、#63311（2026-08-27 IME race）、#65610（2026-10-14 单行编辑器 IME 下划线缺失）、#65455（2026-10-10）。

→ **对一个中文优先、以「输入框 + 聊天」为核心的产品，这是要预留长期修 bug 预算的领域，而且修的地方在上游（Zed 不接受外部 PR）。**

### 4.5 性能：GPUI 快，但**默认模型不含增量**

三阶段渲染：`request_layout` → `prepaint` → `paint`（`crates/gpui/src/element.rs:74/84/96`）。`gpui-fast` fork 的 `docs/retained-mode.md` 原文：*"A frame walks the element tree three times… **Upstream GPUI normally does all three from scratch every frame**, except where an explicitly cached view is reused."*

该 fork 实测（Linux release，对照 `gpui-pre 0.3.7`）：

| 负载 | 上游 GPUI | gpui-fast |
|---|---|---|
| 空窗口 | 3.31 ms | 0.19 ms（−94%） |
| 侧栏滚动 | 5.95 ms | 0.79 ms（−87%） |
| 行情流式刷新 | 5.06 ms | 1.35 ms（−73%） |

→ 「上游 GPUI 空窗口一帧 3.31 ms」这个数字本身就说明：**GPUI 的性能优势是相对 Canvas/DOM 的，不是绝对的；要拿到极致还得用改过布局引擎的第三方 fork**（又一处版本分裂）。

**已知性能陷阱（open）**：
- **#43772「Agent thread performance degrades significantly with large content, needs lazy loading」**（2025-11-29 open）—— 正是「聊天转写里塞大段内容」这个场景，Zed 自己的 Agent 面板也有
- **#23288「Implement graceful recovery for GPU device loss」**（open 自 2025-01-17）—— **GPU 掉线不恢复**，生产级隐患
- #61469 Windows 持续键盘输入下停止呈现数秒（WM_PAINT starvation）
- #65645 / #65730 / #65427 Wayland 滚动与 resize 掉帧

### 4.6 开发体验（本机实测：macOS 27.0.1 / arm64 / rustc 1.99.1）

| 项 | 实测值 |
|---|---|
| 最小可运行示例 | **17 行**（`Application::new().run(...)` + 一个 `Render` impl，成功启动窗口） |
| `examples/input.rs`（唯一多行输入参考） | **920 行** |
| 干净 debug 构建 | **161 s**（454 个 crate，target **2.3 GB**） |
| 改一行重建 | **24 s** |
| release 构建 | 86 s |
| `Cargo.lock` | 709 个包 |
| macOS 26+ 默认构建 | **直接失败**：`metal shader compilation failed: cannot execute tool 'metal' due to missing Metal Toolchain`；绕法 `features = ["runtime_shaders"]` 或 `xcodebuild -downloadComponent MetalToolchain`（`docs/src/development/macos.md:155` 承认） |
| 文档 | **无官方 book**。`crates/gpui/src/_ownership_and_data_flow.rs`(140 行) + `_accessibility.rs`(295 行) + `docs/contexts.md` + `docs/key_dispatch.md` + 46 个 example。docs.rs 0.2.2：206 struct / 45 trait / 10 macro。`///` 注释占比：顶层 `src/*.rs` 12.7%，全目录 3.4%。README 自己说：*"the best way to learn about these APIs is to **read the Zed source code** or drop a question in the Zed Discord."* 社区 `MatinAniss/gpui-book`（278★）**最后 push 2025-10-09，停更一年** |
| 热重载 | **2026-10-17 才有**（commit `670a779a5e`，Subsecond，`feature = "hot-reload"`，仅 debug）；PR 明确两个限制：部分 Zed crate 因 dev-dependencies 循环不能热补；**自定义 `Element` 的三阶段不能热补** |
| Inspector | `feature = "inspector"` + `crates/inspector_ui`（**GPL**）；第三方 `gpui-devtools`（25★） |
| 测试 | `#[gpui::test]` + `TestAppContext` + `VisualTestContext` |

对照 FastVibe 现在的开发体验：`pnpm dev` 秒级 HMR、`mock.html` 有 **48 个预览参数**能在浏览器里免 Electron 复现几乎任何界面状态（含 `platform=win32`、`desktop=1` 模拟 vibrancy、`phone=on`）、`pnpm test` 249 个文件裸 node 跑、`pnpm check:scripts` 静态校验注入脚本。**这套「可预览、可单测、免宿主」的工程基建，在 GPUI 上没有等价物，需要重建。**

---

## 5. 决定 C：界面对齐现有 Electron 版本

### 5.1 需要重画的东西（实测数字）

```
渲染层                     56,235 行 TS/TSX（325 文件）
index.css                   1,456 行  ← 其中约 800–900 行（55–60%）是
                                       浮动面板 / 玻璃 / Liquid Glass rim /
                                       滚动条 / 消息态 / 文件树 / 编辑器叠层
className= 出现            2,550 处（163 个文件）
shadcn 原语                   35 个（components/ui/ 3,737 行）
主题                          24 个（12 亮 / 12 暗）× 41 个 CSS token
玻璃 token                    +15（glassTokens），7 个仅玻璃态
界面字号                      rem 根字号 12–20px 全站缩放
设置 section                  17 个（45 文件 / 10,280 行）
i18n 键                    2,075 / 2,077 × 6 namespace
mock 预览参数                 48 个（preview.ts 1,860 行 fixture 桥）
渲染层纯函数测试              ~49 个文件
```

界面清单（穷举见附录 A）：侧边栏（项目树 / 会话行 / 拖拽排序 / 折叠 / 命令面板 / 账号行 / 更新按钮）、聊天主区（消息流虚拟列表 / 粘性提示词 / TurnRail / 思考块 / 工具卡 / 折叠运行过程 / 连续工具折叠 / 每轮改动 chips / 报错行 / 模型与压缩分隔线 / todo 面板 / question 面板 / DAG 内联图 / 子 agent 卡 / 内联预览与 Viewer）、composer（1,228 行：双层高亮输入 / `@` / `/` / 技能 badge / 附件 / 模型与思考 chip / 上下文环与统计弹层 / 发送-停止-继续 / 排队托盘 / 目标面板）、右侧面板（终端 / 文件树与预览与就地编辑 / Git 变更视图与历史与提交表单 / 浏览器 / DAG 执行页 / 子 agent 页 / 辅助对话）、17 个设置 section、插件页、定时任务页。

### 5.2 为什么「对齐」在 GPUI 上不是重画而是重造

1. **没有 CSS 引擎，没有 token 系统。** 现有 41 个 CSS 变量 × 24 主题 × 玻璃态 +15 的机制（`buildTokens(seed)` 从 21 字段 `ThemeSeed` 派生）在 GPUI 里要换成 Rust 侧的样式解析层。`index.css` 里那些「一条规则同时约束多个组件」的写法（如 `[data-process-body] [data-process-body]` 把内层折叠体的上限交还外层、`html[data-glass] .overlay-surface:not(.fixed,.absolute)` 重写 position）**没有对应表达方式**。
2. **`className` 的 2,550 处是布局语义，不是装饰。** Tailwind 的 flex/grid/gap/container-query/pointer-coarse 变体在 GPUI 里要逐个换成 `div().flex().gap_2()` 之类的调用；容器查询断点（`min-[27.5rem]/files`）与 `pointer-coarse:` 这类媒体/指针查询 GPUI 无原生等价物。
3. **可用控件库是另一套设计系统。** `gpui-component` 85 个模块覆盖了 sidebar / list / message_scroller / bubble / input / menu / popover / dialog / table / tree / chart / notification …，**但外观与行为不是 shadcn Nova**。要么接受界面语言改变（与 C 冲突），要么在 gpui 原语上自建一套等价于 `components/ui/` 35 个原语的库（Zed 自己那份是 29,736 行，且 GPL）。
4. **视觉细节是量出来的，不是写出来的。** AGENTS.md 里大量这类记录：provider 图标画在 14px 且 `viewBox` 扩到 `-2 -2 28 28`（「两个数都是承重的，单独修任何一个都会看起来更大」）、折叠正文上限是 `calc(var(--thread-height)/2)` 且必须 `scrollbar-gutter:stable`（否则展开时闪出横向滚动条，实测 672 → 661）、gutter 两列固定宽度含 1px border、toast 必须带 `absolute` 类以被玻璃 rim 规则排除（`test/toast-stacking.test.ts` 钉住两半）。**这些是在 Chromium 里实测调出来的平衡，换渲染后端意味着全部重新实测。**
5. **两处纯功能缺失会让「对齐」不成立**：浏览器面板（§4.3 #1）与数学公式（#2）。前者是一个已发布的工具能力（`browser_*` 12 个动作），后者是回复渲染的一部分。

---

## 6. 四条路线对比

### 路线 1：全量 Rust + GPUI（用户提案）

| 项 | 评估 |
|---|---|
| 工作量 | 内核侧 **135–223 人月**（§3.5）+ GPUI UI 侧 **60–120 人月** = **195–343 人月 ≈ 16–29 人年** |
| | *UI 侧估算依据*：Zed 自己为解决同类问题写了 `editor` 190,633 行 + `ui` 29,736 + `markdown` 9,488 + `terminal`+`terminal_view` 22,864 = **25.3 万行 GPL 代码，一行不能用**。取 60–120 人月已假设大量复用 `gpui-component`(Apache) |
| 3 人全职 | **5.4–9.5 年** |
| 收益 | 去掉 239 MB Chromium；内存从 ~480 MB 降到（估计）80–150 MB；GPU 绘制；单二进制 |
| **不可行项** | 浏览器面板（无 webview，Windows 上 wry 盖住弹层）、数学公式（无渲染器）、生产级 a11y（31 处 role，官方说近期不做） |
| **高风险项** | gpui 分发路径分裂（5 套类型不互通、crates.io 12 个月未更新、README 今天是坏的）、中文 IME 14 个 open issue 含 2 个 S2、CJK 视觉 bug（U+3000 半角、长行截断）、GPU 掉线不恢复、Agent 面板大内容性能退化、自动更新需自研、无热重载/无 mock 预览体系 |
| 判定 | ❌ **不建议**。「界面对齐」这一条在这个路线上不成立 |

### 路线 2：Rust 内核（app-server）+ 保留 Electron/React UI ← **推荐**

| 项 | 评估 |
|---|---|
| 工作量 | **95–160 人月 ≈ 8–13 人年**（内核 135–223 减去「窗口/菜单/托盘/对话框/更新/媒体协议/图标协议」这些 Electron 保留部分约 25–40 人月，减去渲染层全部） |
| 架构改动 | **零**。Rust 内核作为子进程说 **现有 App Protocol v1**，Electron 侧把 `dispatch`/`subscribe` 从「进程内调用引擎」换成「调用子进程」。这条缝项目已经量过：`docs/engine-utility-process.md` 记「桌面端直接调用引擎共 **137 个方法、168 处调用**」，远程网关的 `localDispatch`/`localSnapshot` 是现成单点入口 |
| 保住什么 | 全部 56,235 行 React、24 主题、markdown/shiki/katex、**浏览器面板**、终端、recharts、dnd-kit、mock 预览 48 参数、249 个测试、**手机端 25,370 行 Dart 零改动**、`fastvibe-services` 零改动 |
| 拿到什么 | 事件循环停顿的根治（把 82 MB 转写解析、`structuredClone`、git、SQLite、JSON 序列化移出 JS 主线程）；无头 Agent 变单二进制（删掉 `check-agent-runtime.mjs` 那套 import 图推断）；去 pi SDK 的 Node 供应链与 240–270 ms import 成本；内存中引擎部分下降 |
| **拿不到什么** | 239 MB Chromium 仍在；渲染层 ~255 MB 仍在；UI 侧性能不变（但实测 UI 侧问题已修，见 §6.1） |
| 可渐进 | ✅ 每一步可单独发布、单独回退（§7） |
| 判定 | ✅ **推荐**。收益/风险比最好，且**第一步 2–4 周就能验证** |

#### 6.1 一个反直觉但重要的观察：UI 侧的性能问题**已经被修完了**

AGENTS.md「上下文用量」一节记录了实测与修复：

> Three things grew with the number of tool calls in the reply being streamed (measured by replaying 5 → 400 calls and then 300 text deltas in an offscreen window: **main-thread busy 0.6 s → 2.4 s**, long tasks from 400 calls on; **now 0.8 s → 1.0 s, none**).

修法是 React 层的（`TurnRail` 只在 tick 数变化时用 `useLayoutEffect` 重测、`builtGroups` 按 tool block 身份复用 `ToolGroup`），**不是换绘制后端**。同理 `groupParts` 的缓存、`ToolDeltaThrottle` 的源头节流（100 KB 文件 2,500 事件 / 125 MB → 84 事件 / 2.5 MB）、`coalesce.ts` 的读取合并（state+transcript 16 ms、stats 250 ms）。

→ **「UI 层使用 gpui 实现高性能绘制」这个前提，针对的是一个已经不存在的问题。** 而没被修的那个问题（主进程 p99 2376 ms 停顿）恰好是 Rust 内核能解决的。

### 路线 3：Tauri 2（Rust 后端 + 系统 webview + 保留 React）

| 项 | 评估 |
|---|---|
| 工作量 | 内核侧同路线 2（95–160 人月）**或**保留 TS 内核（Tauri 可 sidecar Node，但那等于没去掉 Node）+ 宿主层重写 **20–35 人月** |
| 保住什么 | 全部 React / Tailwind / shadcn / markdown / shiki / katex / recharts / dnd-kit / xterm（都在 webview 里跑） |
| 拿到什么 | 去掉 239 MB Chromium（用系统 WKWebView / WebView2 / WebKitGTK）；安装包可能降到 60–120 MB；Rust 后端 |
| **代价（严重）** | **三平台 webview 引擎不同** → 现有全部「在 Chromium 里实测调出来的平衡」要在三个引擎上重新验证（`--webkit-scrollbar` 美化、`backdrop-filter` 玻璃、容器查询、`interactive-widget=resizes-content`、KaTeX woff2 加载、`wasm-unsafe-eval` CSP）。AGENTS.md 里大量「实测」结论会失效 |
| **不可行/需重做** | **`<webview>` 标签没有等价物** —— 浏览器面板（1,681 行 + `executeJavaScript` + `findInPage` + `setZoomFactor` + `capturePage` + `print` + `persist:` 分区 + `disableDialogs` + popup 拦截）在 Tauri 里要用多 webview / child window 重建，且 `findInPage`/`capturePage`/`print` **无等价 API**。`node-datachannel` → `webrtc-rs`（rtc 3,213 行重写，含 netpath/portmap/帧格式）。`node-pty` → `portable-pty`（有官方 plugin）。`node:sqlite` → `rusqlite`。`electron-updater` → `tauri-plugin-updater`（**这个反而是净收益**，Tauri 的更新器成熟）。vibrancy → `window-vibrancy`（有） |
| 判定 | ⚠️ **可选但不推荐**。它同时承担「换内核」和「换宿主」两份风险，而浏览器面板这个已发布功能会退化。如果哪天决定放弃浏览器面板，这条路线的性价比会显著上升 |

### 路线 4：Electron + Rust 侧车（热点用 napi / 子进程）← **立刻可做**

| 项 | 评估 |
|---|---|
| 工作量 | **2–6 人月** |
| 做法 | 保留全部现有代码。把实测的同步阻塞点换成 Rust：① 大转写解析（82 MB 会话 `prepareTranscriptForOpen` 150–210 ms）② usage 解析与统计聚合（`usage-stats.ts` + `turn-usage.ts`）③ SQLite 层（`db.ts` 已经收口在一个模块，**换 `better-sqlite3` 或 Rust napi 只改这一个文件** —— 这是 AGENTS.md 明写的设计意图）④ models.dev 快照解码与折叠 ⑤ 工具图片缩小（现在用 Photon 跑在 worker 线程）⑥ 帧分片/压缩（`rtc/frames.ts`） |
| 依据 | `can1357/oh-my-pi`（36,322★）就是这个形态：**TypeScript 主体（76 MB / 6,197 个 .ts）+ Rust napi 扩展（11 MB / 753 个 .rs：`pi-natives` `pi-builtins` `pi-edit` `pi-shell` `pi-predict` `pi-vfs` `pi-vcs` `pi-ast`）**。FastVibe 已经在用同构方案：`quickjs-wasi`（codemode）、`@silvia-odwyer/photon`（图片缩小）、`node-datachannel`（libdatachannel）都是原生模块 |
| 收益 | 直接命中实测 p99 2376 ms；风险极低；每步可单独发布回退 |
| 局限 | 不去掉 Chromium；不改架构；不解决「Node 供应链」 |
| 判定 | ✅ **无论最终选哪条路线，这条都应该先做** —— 它既独立见效，又是路线 2 的第一阶段（§7 阶段 0/1） |

### 路线对比汇总

| | 路线 1<br>全量 Rust+GPUI | **路线 2**<br>**Rust 内核+Electron UI** | 路线 3<br>Tauri 2 | 路线 4<br>Rust 侧车 |
|---|---|---|---|---|
| 人月 | 195–343 | **95–160** | 115–195 | **2–6** |
| 3 人团队年限 | 5.4–9.5 | **2.6–4.4** | 3.2–5.4 | **0.2–0.6** |
| 浏览器面板 | ❌ 不可行 | ✅ 保留 | ⚠️ 退化 | ✅ 保留 |
| 数学公式 | ❌ 不可行 | ✅ 保留 | ✅ 保留 | ✅ 保留 |
| a11y | ❌ 不可用 | ✅ 现状 | ✅ 现状 | ✅ 现状 |
| 中文 IME | ⚠️ 14 open issue | ✅ Chromium | ⚠️ 三引擎各异 | ✅ Chromium |
| 界面对齐现有版本 | ❌ 重造设计系统 | ✅ **100% 保留** | ✅ 保留（需三引擎复验） | ✅ 100% 保留 |
| 手机端零改动 | ⚠️ 需重写协议或保持 | ✅ **零改动** | ✅ 零改动 | ✅ 零改动 |
| 包体积 | ~30–60 MB | 375 MB（−Agent tar.gz） | ~60–120 MB | 375 MB |
| 内存 | ~80–150 MB | ~480 MB → **~350 MB** | ~200–300 MB | ~480 → ~430 MB |
| 事件循环停顿 | ✅ 根治 | ✅ **根治** | ✅ 根治 | ✅ 大幅缓解 |
| 开发体验（HMR/预览/单测） | ❌ 重建 | ✅ 保留 | ✅ 保留 | ✅ 保留 |
| 框架供应链风险 | ❌ **极高**（5 套不兼容 gpui） | ✅ 低 | ⚠️ 中（Tauri 成熟） | ✅ 低 |
| 可渐进 / 可回退 | ❌ | ✅ | ⚠️ | ✅ |
| **判定** | ❌ 不建议 | ✅ **推荐** | ⚠️ 备选 | ✅ **先做** |

---

## 7. 推荐路径（分阶段，每步可单独发布、单独回退）

沿用 `docs/engine-utility-process.md` 的分阶段思路（那份文档的第 2 步「只读通道验证」原则在这里同样适用：**没有验证就不要动用户数据的唯一写者**）。

### 阶段 0：验证（2–4 周，1 人）— **决定后面所有估算的可信度**

目标：证明「Rust 内核说现有 App Protocol，Electron UI 零改动」这条缝真的能走通。

1. Rust 写一个最小 wire 协议客户端：**只做 `openai-responses` + `openai-completions`**，SSE 流式 + 工具调用 + 重试/错误分类
2. 实现最小子集：`engine:prompt`、`engine:get-snapshot`、`engine:get-state`、`engine:event` 推送（含 `message_update` 的 `slimStreamEvent` 瘦身语义、`seq` 单调、`RETAIN_FROM_STREAM`/`RETAIN_FROM_EMIT` 保留集）
3. 转写用**现有 pi v3 格式**读写（`version:3` 头、`parentId` 链、tool result 紧随 assistant）—— 不发明新格式，这样两条内核可以互换会话
4. 挂在一个默认关闭的开关后面（`FASTVIBE_ENGINE=rust`），跑一个真会话：发提示词 → 工具调用 → 流式渲染 → 重开转写 → 手机端连接同一个会话
5. **量三个数**：与 TS 内核的 p99 停顿对比、内存对比、首字延迟对比

产出：一份「实测 vs 估算」的偏差报告。**如果这一步做不到「UI 零改动」，路线 2 就要重新评估。**

### 阶段 1：Rust 侧车（与阶段 0 并行或紧随，2–6 人月）

不改架构，先把实测痛点打掉（路线 4 的全部内容）。**这一步的收益不依赖后面任何阶段**：

1. `db.ts` 换 Rust napi 或 `better-sqlite3`（AGENTS.md 已把 `node:sqlite` 收口在一个模块，明写「换成 better-sqlite3 只改这一个文件」）
2. 大转写解析与 usage 聚合移到 Rust
3. models.dev 解码与全序折叠移到 Rust（`test/models-dev-index.test.ts` 洗牌后断言字节一致 —— 这是现成的等价性测试）
4. `rtc/frames.ts` 的分片/压缩移到 Rust
5. 每步都保留 TS 实现与开关，跑对比测试

### 阶段 2：内核主路径（6–12 人月）

Rust 内核覆盖：多会话生命周期、会话树与分支、compaction + 窗口保护、checkpoint 捕获与还原、MCP 客户端（直接用 `rmcp`）、技能、工具面（read/edit/write/bash/grep/find/ls/present/todo/question）。仍为可选后端。

**注意**：`native-compaction.ts`（569 行，适配 11 个 SDK `_` 私有方法）与 `thinking-off.ts`（猴补 runtime 两个方法）这类**对 JS 对象运行时的补丁，在 Rust 里没有等价物，只能等价重写语义**。这是最容易低估的部分：它们的价值不在代码量，而在于「实测出来的行为」（触发阈值 90%、缩窗重试 6 次、预算按会话+端点+模型+声明窗口隔离、`roomForThinking` 放宽到 1024）。`test/native-compaction.test.ts` 用真 SDK 验证 7 类场景，是重写的验收标准。

### 阶段 3：编排与旁路（6–10 人月）

子 agent（4 角色 + 用户角色）、DAG（调度器 635 行 + store 325 + 结果产物 + 5 并发/3 per-provider 租约 + 3 层协调者）、定时任务、长期记忆（7 文件 1,299 行 + 4 份 Codex 提示词模板 1,595 行）、导入适配器（4 个外部 agent）、回复推荐、会话标题、轻量模型路由。

**扩展系统是最大的未知**：18 个内置扩展是**被 jiti 从 asar 外按路径加载的 TypeScript 文件**（`resources/extensions/*.ts`，4,723 行），且用户可运行时安装第三方扩展（`ExtensionManager` → SDK `DefaultPackageManager`）。Rust 侧要么①内嵌 JS 引擎（`quickjs-wasi` 已经在依赖里，`boa`/`deno_core` 亦可）②改成 WASM 插件 ③改成子进程 + RPC ④放弃第三方扩展只保留内置（内置扩展改成 Rust crate）。**这个决定需要单独评估，本文不结论。**

### 阶段 4：传输层（4–8 人月）

`server/`（1,604 行，Electron-free）与 `rtc/`（3,213 行，Electron-free，`peer.ts` 是唯一 native 胶水）移到 Rust。**这两块本来就是按「可脱离 Electron」写的**，是搬迁性价比最高的部分。WebRTC 用 `webrtc-rs`（纯 Rust）或继续 FFI libdatachannel。

**硬约束**：`frames.ts` 与手机端 `lib/protocol/rtc_frames.dart` **必须字节一致**（1 字节头 `LAST/BINARY/PING/PONG/CLOSE/DEFLATE`、16 KiB / 直连 64 KiB 分片、`COMPRESS_MIN_BYTES=1024`、`ASYNC_COMPRESS_MIN_BYTES=64KiB`、level 3）。SCTP 调参（`SACK_DELAY_MS=5`、cwnd 10→64 MTU）在 `webrtc-rs` 上是否可调：**未查证**。

### 阶段 5：默认切换

Rust 内核成为默认，TS 内核保留至少一个发布周期作回退。删除 `src/agent/` 的 Node 打包链（`build-agent-runtime.mjs` 226 行 + `check-agent-runtime.mjs` 105 行 + `agent-runtime-v*` 版本线）。

### 明确不做

- ❌ GPUI UI 层（§4）
- ❌ 「界面对齐」的重造（§5）
- ❌ 直接 vendor `codex-core`（150k 生产行 + 8 个 git 依赖 + 3 处 patch + 周更 + 不接受 PR）
- ❌ 把产品绑定在 ChatGPT OAuth 上（`AuthMode::ChatgptAuthTokens` 标注 FOR OPENAI INTERNAL USE ONLY）
- ❌ 引入 codex 的沙箱/审批模型（AGENTS.md 明写不要，且那是 codex 约 8 万行的投入）

---

## 8. 风险登记册

| # | 风险 | 概率 | 影响 | 缓解 |
|---|---|---|---|---|
| R1 | **Rust 内核工作量被低估**（尤其扩展系统、compaction 语义、4 种 wire 协议的边角） | 高 | 高 | 阶段 0 用 2–4 周实测校准；§3.5 的估算按子系统拆分便于逐项复核 |
| R2 | **两套内核并存期的行为漂移**（同一会话在 TS/Rust 内核对 `agent_settled`、`canResume`、`todoIsCurrent` 等语义判定不同） | 高 | 高 | 转写格式共用 pi v3；把 249 个测试里 25+ 个「用真 SDK」的改成「对两个内核都跑」的契约测试 |
| R3 | **手机端协议破坏**（25,370 行 Dart，`ConversationSnapshot` / `slimStreamEvent` / `seq` / 帧格式） | 中 | 极高 | App Protocol v1 冻结；`isProtocolCompatible()` 已有；帧格式做字节级对拍测试 |
| R4 | GPUI 分发路径变动（crates.io 已 12 个月未更新；`gpui_platform` 未发布；5 套 fork 类型不互通） | **已发生** | 高 | 只在路线 1 里存在 —— 这正是不推荐它的理由之一 |
| R5 | 中文 IME / CJK 上游 bug 无法自修（Zed 不接受外部 PR） | 中（路线 1） | 极高 | 路线 2/3/4 规避 |
| R6 | Rust 工程师招聘/上手成本（团队现有 TS/Go/Dart 栈；GPUI 官方建议「读 Zed 源码」） | 中 | 中 | 阶段 0/1 用 napi 侧车，TS 团队可参与；内核侧招 1–2 名有 Rust 系统编程经验的人 |
| R7 | 构建时间拖慢迭代（干净 debug 161 s、改一行 24 s、target 2.3 GB、709 个依赖包） | 高（路线 1/2） | 中 | workspace 拆分 + `sccache` + 增量编译；对比现在 `pnpm dev` 的秒级 HMR 是**确定的体验退化** |
| R8 | 双内核期的包体积增加（Rust 二进制 + 现有 asar） | 高（过渡期） | 低 | 阶段 5 删 TS 内核后回落 |
| R9 | 放弃 pi SDK 的持续上游收益（pi 1.3.0 在活跃演进；FastVibe 已多次「同步 pi SDK 更新」） | 中 | 中 | 明确取舍：自研内核换来协议自主权，失去上游免费功能。**这是产品决定，不是技术决定** |
| R10 | macOS 文件夹授权（TCC）在子进程里的归属未验证 | 中 | 中 | `docs/engine-utility-process.md` 已列为难点 7：「`folder-consent` 故意在主线程 stat 受保护目录，因为系统只记得自己弹的文件夹对话框来自哪个进程。子进程里 stat 是否归到同一个应用，**没验证过**」→ 阶段 0 必须在**打包后**的应用上实测 |
| R11 | 网络代理：子进程拿不到 Chromium 的 `defaultSession.resolveProxy`（系统代理 + PAC） | 高 | 中 | `docs/engine-utility-process.md` 难点 2 已给解法：把「这个 URL 走哪个代理」做成回主进程的 RPC |
| R12 | SQLite 单写者约束（`fastvibe.db` 设计是一个进程一个连接，主进程 `index.ts` 里现在就有 `openDatabase` 用于 `MemoryManager`） | 高 | 高 | `docs/engine-utility-process.md` 难点 4 + 分阶段第 3 步「单写者切换」；**没有阶段 0 的验证不要进这一步** |

---

## 9. 未查证 / 需要进一步验证

按对决策的影响排序：

1. **`webrtc-rs` 能否调 SCTP 参数**（`SACK_DELAY_MS`、初始 cwnd）—— 阶段 4 的前提。FastVibe 现在靠 `node-datachannel` 在第一个 peer 之前改进程级设置（`rtc/peer.ts`）
2. **macOS TCC 文件夹授权在子进程里的归属** —— 阶段 0 必须在打包应用上实测（R10）
3. **OpenAI ToS 是否允许第三方客户端使用 ChatGPT 账号 OAuth** —— 只影响「是否复用 codex 的登录路径」，不影响自研内核
4. **`self_update` 对 macOS `.app` bundle 原子替换 + 保持 codesign/公证的支持程度** —— 路线 1 才需要（路线 2 保留 electron-updater）
5. **`gpui-component`(Apache) 的实际质量与可改造性** —— 只影响路线 1；未实机跑过
6. **`libghostty-vt` 的许可与 API 稳定性**（GPUI 侧终端的备选）
7. **Rust 内核对 pi v3 转写的读写兼容性**（尤其 `closeOrphanToolCalls`、relink、工具图片引用 `fastvibeImage` 字段）—— 阶段 0 的核心验证项
8. **`quickjs-wasi` / `boa` / `deno_core` 承载 18 个内置扩展的可行性**（扩展用了 `ctx.ui.confirm/select/input/editor/questions`、`ctx.modelRegistry`、`pi.setSessionName`、`ctx.sendMessage` 等宿主桥）—— 阶段 3 的最大未知
9. Zed 的商标使用政策（仓库与 `legal/terms.md` 里都没有明文条款）
10. `apps/mobile_flutter` 与 `src/shared/*` 的字段级对应关系（本次只核对了 `frames.ts` ↔ `rtc_frames.dart` 与 `blank_output.dart` 两处明确注释的镜像）

---

## 附录 A：界面清单（渲染层，按区域）

**壳层与侧边栏**：`App.tsx`(2166) · `collapsible-panel.tsx`(70, 窄视口抽屉 100vw) · `sidebar.tsx`(805) · `sidebar-rows.tsx`(929, 项目/会话行 + 拖拽 + 折叠 + 吸附) · `sidebar-account.tsx`(153) · `sidebar-update-button.tsx`(75) · `command-palette.tsx`(334, cmdk) · `title-bar.tsx`(157, Win/Linux 自绘) · `conversation-resources.tsx`(330, 常驻/浮窗 300px)

**聊天主区**：`message-list.tsx`(868, 虚拟列表 + 跟随底部 + 粘性提示词 + TurnRail) · `message-row.tsx`(907) · `markdown-view.tsx`(303) · `thinking-block.tsx`(262) · `tool-card.tsx`(518) · `tool-row.tsx`(292) · `tool-group.tsx`(115) · `run-collapse.tsx`(106, 折叠运行过程) · `file-chips.tsx`(194) · `error-notice.tsx`(175) · `model-change-notice.tsx`(42) · `compact-notice.tsx`(70) · `todo-list.tsx`(180) · `permission-panel.tsx`(637) · `permission-dialog.tsx`(107) · `inline-preview.tsx`(435, 含 Viewer) · `preview-panel.tsx`(419) · `dag-inline.tsx`(102)/`dag-dialog.tsx`(143)/`dag-canvas.tsx`(339) · `highlighted-editor.tsx`(287) · `diff-view.tsx`(160) · `csv-preview.tsx`(162) · `office-frame.tsx`(238) · `tui-lines.tsx`(78) · `extension-surface.tsx`(268) · `new-session.tsx`(137) · `selection-action-bar.tsx`(137) · `git-branch-chip.tsx`(254)/`git-status-popover.tsx`(339)

**composer**(1228)：双层高亮输入 · `@` 文件选择 · `/` 斜杠面板 · 技能 badge + 草稿态 · 附件 chips · 模型/思考强度 chip(`model-thinking-select.tsx` 256) · 上下文环 + 统计弹层 · 发送/停止/继续/合并 · 排队托盘(`message-queue.tsx` 369) · GoalPanel · 分支 chip · Tab 采纳回复推荐

**右侧面板**：`side-pane.tsx`(566, 7 种 tab) · `side-pane-terminal.tsx`(313)+registry(46) · `side-pane-files.tsx`(891) · `file-tree-dialogs.tsx`(161) · `file-breadcrumb.tsx`(235) · `side-pane-git.tsx`(401) · `git-change-list.tsx`(220) · `git-history.tsx`(175) · `git-commit-form.tsx`(78) · `side-pane-browser.tsx`(710)+`browser-guest.ts`(797) · `browser-downloads-popover.tsx`(96)/`browser-library-dialog.tsx`(70) · `side-pane-chat.tsx`(240) · `side-pane-subagent.tsx`(180) · `side-pane-dag-node.tsx`(62) · `split-handle.tsx`(148)

**设置 17 个 section**（45 文件 / 10,280 行）：general · personalization · shortcuts · archived(305) · usage(447+39, recharts) · providers(438+474+402+409+354+147+121+191+243+151+156) · subagents(390) · memory(72) · mcp(673) · skills(186+295) · import(596) · remote(171+238+117+63+97, qrcode) · ssh(518+100) · computer(483) · proxy(86) · browser(138) · about(211+78+176+169)

**独立页面**：插件页 `#/plugins`(309+119+113) · 定时任务页 `#/tasks`(673+291+156)

**状态**：`stores/session.ts`(1208) · `side-pane.ts`(987) · `session-reducer.ts`(544) · `settings.ts`(480) · `session-subagents.ts`(76) · `archive.ts`(67) · `dag.ts`(64) · `transcript-navigation.ts`(10) · `lib/apply-engine-event.ts`(**1035**, 30+ 事件类型) · `lib/coalesce.ts`

---

## 附录 B：证据索引

**本机实测命令**

```bash
# 规模
find src -name '*.ts' -o -name '*.tsx' | wc -l                       # 553
find src/main \( -name '*.ts' \) -print0 | xargs -0 wc -l            # 51,016
wc -l src/renderer/src/index.css                                     # 1,456
rg -c 'className=' src/renderer/src | awk -F: '{s+=$2} END{print s}'  # 2,550

# 引擎对 Electron 的依赖面（11 个文件）
rg -l 'from ["'"'"']electron["'"'"']' src/main/engine src/main/pi src/main/server src/main/rtc

# 打包体积
du -sh /Applications/FastVibe.app                                    # 375M
du -sh /Applications/FastVibe.app/Contents/Frameworks/*              # Electron Framework 239M

# 事件循环停顿分布（36 天 174 条）
rg -o 'stalled up to (\d+) ms' -r '$1' \
  "$HOME/Library/Application Support/FastVibe/logs/main.log" | sort -n \
  | awk '{a[NR]=$1} END{printf "count=%d p50=%d p90=%d p99=%d max=%d\n",NR,a[int(NR*.5)],a[int(NR*.9)],a[int(NR*.99)],a[NR]}'
# → count=174 p50=272 p90=701 p99=2376 max=3704

# 启动
rg -n '\[startup\]' "$HOME/Library/Application Support/FastVibe/logs/main.log" | tail -3
```

**GPUI / Zed**（`zed-industries/zed`，92,083★）：crates.io API `crates/gpui`；`crates/gpui/README.md`；`crates/gpui/src/elements/`；`crates/gpui_apple/src/text_system.rs`；`crates/gpui_windows/src/direct_write.rs`；`crates/gpui_wgpu/src/cosmic_text_system.rs`；`crates/markdown/src/parser.rs:734`；`crates/gpui_platform/Cargo.toml`；issue #41138 / #14753 / #21208 / #23288 / #43772 / #46183 / #60059 / #64389 / #64832 / #65506 / #65765 / #65868 / #65973 / #19940；PR #13098(closed) / #54433(closed,merged=false) / #57339 / #58593(closed) / #61892(closed) / #65344(closed,merged=false) / #65805 / #65738(热重载)；commit `1d029c5ff5`(AccessKit, 2026-05-27) / `670a779a5e`(热重载, 2026-10-17) / `a47f721832`(gpui_ios, 2026-10-14)；`longbridge/gpui-kit`（gpui-component 0.8.0, Apache-2.0）；`awesome-gpui/projects.json`(141 条)。

**codex-rs**（`openai/codex` @ `e6ebdfe0`，130,544★）：`codex-rs/Cargo.toml`(161 member)；`rust-toolchain.toml`(1.99.1)；`model-provider-info/src/lib.rs:105,111-124,696-728`；`app-server-protocol/src/protocol/common.rs:21-60`；`app-server-protocol/src/rpc.rs`；`app-server-transport/src/transport/mod.rs:123`；`tui/Cargo.toml:32-34`；`tui/src/lib.rs:328,1056-1090`；`app-server-client/src/lib.rs:88-100`；`rollout/src/lib.rs:86-87`；`protocol/src/protocol.rs:885,1097-1140,1183-1230`；`core/src/config/mod.rs:235-237`(ghost_snapshot)；`app-server/src/turn_cost_worker.rs`；`hooks/src/lib.rs:41-56`；`ext/skills/src/host_roots.rs:24-26`；`LICENSE`(Apache-2.0 §6)；`docs/contributing.md`；`developers.openai.com/codex/app-server`；`learn.chatgpt.com/docs/mcp-server.md`（MCP server removal）；crates.io 逐个 404 查证。

**oh-my-pi**（`can1357/oh-my-pi`，36,322★，MIT）：GitHub API `languages`（TypeScript 76,052,247 B / Rust 11,477,007 B）；`git/trees/main?recursive=1`（9,303 文件，6,197 `.ts` / 753 `.rs`）；`crates/*/Cargo.toml` 13 个 + `crates/vendor/` 8 个。

**FastVibe 内部**：`AGENTS.md`（架构、性能实测记录、设计意图）；`docs/engine-utility-process.md`（进程隔离评估，**判定条件已被实测越过**）；`docs/app-server-protocol.md`(559 行)；`docs/sqlite-storage.md`；`docs/memory.md`；`src/main/app-server/*`(1,252)；`src/shared/app-protocol.ts`(411)；`src/shared/remote-policy.ts`(383)；`src/main/ipc/registry.ts`(104)/`broadcast.ts`(98)；`src/agent/*`(591)。
