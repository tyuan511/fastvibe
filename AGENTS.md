# FastVibe

Electron + React 桌面客户端，面向 Code / Office / Cowork；默认引擎是 Electron Main 内嵌的 `@earendil-works/pi-coding-agent` SDK。手机端是 Flutter + Rust core。

本文件只放全项目硬规则和任务入口。**修改某个模块前，先读下方对应的工程合同；跨模块工作继续沿合同中的关联入口阅读。** 实现原因、故障案例、测量、完整流程和回归说明在 `docs/` 按需查阅，不要重新堆进根文件。

## 代码与数据边界

| 目录 | 职责 |
| --- | --- |
| `src/main/engine/` | 运行路径、模型/配置、文件与持久化公共逻辑 |
| `src/main/pi/` | 内嵌 SDK、会话生命周期、扩展/MCP、子代理 |
| `src/main/ipc/` | 传输无关调用表与广播 |
| `src/preload/`、`src/shared/` | Electron transport、公共 API/协议与类型 |
| `src/renderer/src/` | React UI；产品组合在 `components/`，shadcn 原语在 `components/ui/` |
| `src/agent/` | SSH 无头 Agent；尽量共用不依赖 Electron 的引擎逻辑 |
| `apps/mobile/` | Flutter 页面、Dart FFI、Rust 协议和状态；平台目录只保留宿主与系统能力 |
| `resources/extensions/`、`resources/skills/` | 随包扩展与内置技能；不是同一套机制 |

- 会话转写、`fastvibe.db`、队列、检查点、定时任务及历史 DAG 等业务数据始终属于 FastVibe userData。引擎配置可使用隔离目录或用户全局 pi，不能把“数据独立”误写成“不支持全局配置”。切换合同见 [Pi 引擎模式](docs/pi-engine-modes.md)。
- 默认无内置模型供应商；FastVibe 账号登录不等于配置模型。没有模型是正常首启状态，不是引擎启动失败。
- Host / RPC / ACP 适配保持与 renderer 解耦；Office 已通过内置 OfficeCLI 集成。产品界面不暴露后端运行时实现细节。
- 多文件夹项目的其它仓库有自己的规则与技能；修改前读其指令，使用绝对路径，并在拥有文件的仓库内提交。

## 按任务读取

详细目录见 [工程合同索引](docs/engineering/README.md)，设计、协议与研究总入口见 [docs/README.md](docs/README.md)。下表是阅读要求，不依赖子目录规则自动加载；会话 cwd 在仓库根时，编辑子目录文件不会自动加载该目录的 `AGENTS.md`。

| 涉及的修改 | 先读 |
| --- | --- |
| IPC/API、快照、广播、会话作用域、多文件夹上下文 | [架构与调用合同](docs/engineering/architecture.md) |
| 手机 Flutter/FFI、iroh、LAN 发现、连接与登录 | [手机端合同](docs/engineering/mobile.md) → [手机 README](apps/mobile/README.md)、[iroh 节点列表](docs/iroh-relay-nodes.md) |
| 远程鉴权/策略、背压、SSH 手机访问、账号登录 | [远程与账号资料](docs/engineering/remote-access.md) → [App Server 协议](docs/app-server-protocol.md) |
| 数据库、目录写入、转写落盘/修复、导入、用量、检查点 | [持久化合同](docs/engineering/storage.md) → [SQLite](docs/sqlite-storage.md)、[导入格式](docs/import-from-other-agents.md) |
| 运行标记、Stop/Continue、队列、handoff、压缩 | [会话生命周期](docs/engineering/session-lifecycle.md) |
| 布局、主题/玻璃、字号、滚动条、i18n、路由、菜单、设置 | [界面合同](docs/engineering/ui.md) |
| 文件树、Git、文件预览、Office、图片/HTML 交付 | [工作区与媒体](docs/engineering/workspace-and-media.md) → [OfficeCLI](docs/office-officecli.md) |
| 图片生成、图片协议、模型可用性与 Agent 生图工具 | [图片生成工作台](docs/image-generation.md) |
| Markdown、Shiki/diff、Mermaid、HTML 清洗、数学 | [渲染合同](docs/engineering/markdown.md) |
| 转写气泡、错误/中止、折叠、思考、技能、附件、上下文统计 | [转写呈现](docs/engineering/transcript.md) |
| 供应商/OAuth、协议/URL、模型热更新、思考、轻量请求、models.dev | [模型合同](docs/engineering/models.md) |
| 扩展/技能、MCP、浏览器/CUA、问题 UI、codemode/tool_search | [扩展与工具桥接](docs/engineering/extensions.md) |
| Agent Team、Goal/Todo、定时任务及历史 DAG 资料 | [编排合同](docs/engineering/automation.md) |
| 普通记忆、Vivi 的运行/聊天/记忆/宠物 | [补充工程约束](docs/engineering/memory-and-vivi.md) → [普通记忆](docs/memory.md)、[Vivi 当前实现](docs/vivi-bot-implementation.md)、[Vivi 记忆](docs/vivi-memory-design.md) |
| 启动测量、locale、PTY、单实例、通知、唤醒、更新 | [桌面运行环境](docs/engineering/desktop-runtime.md) |
| 依赖升级、打包、发布、测量脚本、文档维护 | [开发与验证资料](docs/engineering/development.md)；发布另读 [.agents/skills/release/SKILL.md](.agents/skills/release/SKILL.md) |

## 跨端接口与运行不变式

- 一个桥、一个调用表：公共 API 属于 `src/shared/api.ts`，注册用 `handle(payload, ctx)`，不能新建 `ipcMain.handle` 分支；所有注册在 `wireElectronTransport()` 前完成。`settings:get-sync` 是明确的同步例外。
- 状态推送走 `broadcast()`，不能遍历窗口代替；本机窗口专属的 `menu:action` / `window:state` 保留定向发送例外。新增方法必须在远程策略中分类，桌面与 SSH/手机能力按其公共合同接入。
- 会话级调用一路传递 `conversationId`；renderer 走 `lib/engine-client.ts` 默认取本窗口 activeId。不能让未加载会话的读取退回另一个活动会话。
- 快照的 `messages` 已含正在流式生成的内容，不能再回放相同 delta；`pendingUi` 反映实际停住的请求，事件按单调 `seq` 去重。后台会话也保留恢复所需状态。
- “运行结束”是 `agent_settled`，不是 `agent_end`；压缩另计 busy。Main 拥有运行状态，迟到的转写/state/预览结果必须核对所属会话，不能覆盖当前界面。
- 提交提示词的应答表示已接受，不等待整轮结束；无可用模型或真正拒绝时保留草稿。供应商修改热更新现有 runtime/registry，不用 `stop()` + `start()` 中断正在生成的回复。
- 插件阻塞请求按会话排队、按请求 id 应答/撤回；Stop 只结束该会话及其团队。等待问题的超时不是同意，不得擅自恢复用户已停止的工作。

## 存储、凭据与工具边界

- 只有 `src/main/engine/db.ts` 可以引用 `node:sqlite`。数据用 SQLite、配置与凭据用各自文件、转写用 SDK JSONL；schema 已使用的迁移号不能删除、复用或回退。
- 目录按变化行落盘，不能恢复整份覆盖；转写以追加为主，不能恢复常规整文件重写。首次落盘与必要修复的原子写入、孤儿工具结果恢复和检查点回退必须遵守持久化合同。
- 账号令牌、远程密码哈希和供应商凭据不能放入会整份发给 renderer 的普通 settings；不能写入用户登录 shell 或终端环境。MCP 编辑表单会返回其 env/headers，这是既有明确例外，不能据此扩大其它凭据暴露。
- `settings:set` 不能用客户端旧快照覆盖 Main 管理的 `remote*` / `proxy*`；设置广播的接收方不回写形成循环。其它设备的 UI 局部状态不得覆盖桌面共享偏好。
- FastVibe 不设通用工具审批门禁、权限模式或沙箱扩展；插件 `confirm/select/input/editor/questions` 仍是有效的阻塞问题。不要新增审批层，除非用户明确要求。
- Worktree 创建/绑定会切换工作区，遵循工具要求事先征得用户同意。修改已有代码前核对工作区，保留其它会话的未提交改动；文档或重试流程不能悄悄回退用户文件。
- 文件系统、媒体与 HTML 的路径/符号链接边界、CSP、sandbox 与远程策略遵守所属合同；不要为兼容渲染而放宽安全边界。产物展示使用 `present`，不从普通命令输出猜测交付物。

## UI 与文案

- 包管理器用 **pnpm**；样式为 **shadcn Nova / Base UI**。原语仅用 `pnpm shadcn add <component> -y` 安装，禁止手写 `src/renderer/src/components/ui/`。产品组合在该目录之外，优先复用原语。
- Base UI 的 GroupLabel 必须放在所属 Group 中；树使用 `TooltipProvider`。设置行复用 `SettingsGroup` / `SettingsRow`。
- `themes.ts` 是配色来源；产品用语义 token，不假设浅色、不硬编码调色板。明确的纸张面和 Vivi 固定气泡配色遵循各自既有合同。
- 字号用 Tailwind 标准 `text-*`，布局优先 rem；会话正文和工具内容用 `text-sm`，chrome 用 `text-xs`。自定义字号、滚动条、玻璃或折叠布局前读对应合同。
- 所有产品可见文案走 i18next，补齐 `locales/{zh,en}/`；Main/扩展使用 `uiText`。界面语言与 AI 偏好语言独立，提交信息始终英文。设置描述只说做什么，不塞实现原理或数据目录细节。
- Markdown、diff、错误、工具与附件的共有规则复用现有实现；主聊天、侧边 Agent、手机的表现差异必须符合各自合同，不另造易漂移的渲染规则。

## 手机与 Vivi 的当前基线

- 手机只维护 Flutter 页面 + Dart FFI + Rust core；阻塞命令在专用 isolate，Dart 管交互、Rust 管协议与状态。网络用账号鉴权 iroh + App Protocol；不要恢复旧 WebRTC、密码扫码、Compose/SwiftUI 产品页或 JNI/SwiftPM 桥接。
- 保留 `dev.fastvibe.mobile` 与现有发布签名；版本源是 `pubspec.yaml`，同步 Android 发布元数据。iroh `relays` 必须保留完整节点列表，显式空/损坏报错；LAN 地址仅作线索，设备与端点身份必须匹配当前账号。
- Vivi 当前是 Router/Worker 持久会话，见当前实现文档；[整体采用 DSH](docs/vivi-architecture.md) 是已确定但尚未实现的目标，不能描述成已上线，也不沿用已删除的旧审核技能流程。
- Vivi 与普通记忆的数据、开关和清理边界独立；停止、恢复、epoch、迟到结果隔离等约束先读对应合同。

## 开发与验证

```bash
pnpm dev                  # 开发桌面客户端
pnpm typecheck            # 注入脚本、依赖变体和 TypeScript 检查
pnpm check:scripts        # 单独检查浏览器注入脚本
node --test test/<name>.test.ts  # 按修改范围运行相关 Node 测试
pnpm test                 # Node 测试全集；无 DOM 的模块与 SDK harness
pnpm mobile:analyze
pnpm mobile:test
pnpm mobile:core:test
```

- UI、运行时与协议变化要选能证明实际行为的验证；纯类型检查不能替代布局、Base UI 运行时不变式或真实协议验证。完整构建、性能测量与手机命令见所属文档。
- 升级 pi 时同步 `undici` / `typebox` 与 SDK 声明版本，保留实例内部方法适配的真实 SDK 回归；运行 `pnpm typecheck` 和安装包依赖检查，不能只凭开发态成功验收。
- 主进程英文字符串避免独立单词 `import`，electron-vite 的正则 shim 会误判；原理与打包验证见开发资料。
- 提交 subject 和正文都用英文。发布版本、双语 release note、tag 与公开 Release 的流程见发布技能；整理文档不代表授权发布。

## 文档维护

新增全局硬约束才更新本文件；模块事实写所属工程合同或已有专项文档，并更新索引。源码/类型与回归是核对入口，旧测量不能当成当前保证；历史传输资料、当前实现与目标设计明确区分。

移动或删除资料前保留独有内容并更新引用；不因文档清理删除发布记录、数据库迁移或用户数据。避免把同一模块的完整合同复制到多处，保留专项文档与工程接入约束的分工。
