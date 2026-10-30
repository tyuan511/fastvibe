# Native 与 Electron 工具核对（2026-10-30）

按当前工作区代码核对模型可调用的工具，不把客户端 RPC 或界面功能算成 Agent 工具。工具目录还受模型协议、设置、MCP 连接、角色授权和运行模式影响，因此不存在一份所有会话都相同的静态清单。

## 工具差异

| 用途 | Electron | Native | 结论 |
| --- | --- | --- | --- |
| 读写、搜索、列目录 | SDK 的 `read`、`write`、`edit`、`bash`、`grep`、`find`、`ls` | `exec_command`、`apply_patch`、`view_image` | Native 用命令完成读取和搜索，没有独立 read/grep/ls 工具；展示为终端符合实际工具身份 |
| 长命令交互 | `bash` | `exec_command`、`write_stdin`、`manage_exec_sessions` | Native 提供会话、轮询、输入和清理；当前 GUI 已有终端投影合并逻辑 |
| 计划 | `todo` | `update_plan` | 工具改名，Native 有计划事件和独立状态；工具展开仍是通用参数/结果文本 |
| 阻塞提问 | `question`、扩展 UI | `request_user_input` | Native 有问题面板；转写工具详情仍是通用文本 |
| 异步沟通 | 无同名内置工具 | `request_user_input_async`、`send_message_to_user_async` | Native 可提问后继续工作或发送通知 |
| 委派 | `subagent`、`dag_*` | `spawn_agent`、`send_input`、`wait_agent`、`close_agent`、`resume_agent`、`list_agents` | 生命周期控制模型不同；现有原生计划明确不恢复旧 DAG 工具 |
| 代理间协作 | DAG 输入/结果和通知 | `post_to_board`、`read_board` | Native 仅在子任务树存在时启用共享留言板 |
| 代码模式 | `codemode` | `code_mode`、`wait` | Native 支持脚本运行、等待和终止；嵌套调用持久化成独立工具活动 |
| 工具搜索 | `tool_search` | `tool_search` | 均受配置和授权工具目录约束 |
| 浏览器 | 多个 `browser_*` | `browser` 的 `action` | Native 单一入口覆盖打开、导航、查找、脚本、快照、点击、输入、按键、滚动等 |
| 电脑操控 | 多个 `computer_*` | Cua Driver MCP 工具，基础 `computer` 作回退 | 默认关闭；平台和驱动状态决定是否提供，不能将基础回退当完整工具集 |
| 网页搜索 | Responses 旁路 `web_search` 请求 | 提供方托管 `web_search` | Native 不是本地函数，不可通过 code_mode 调用；需要模型支持和设置启用 |
| MCP | `mcp_<id>_<tool>` | `mcp__…` 工具、`list_mcp_resources`、`list_mcp_resource_templates`、`read_mcp_resource` | Native 另有资源工具；具体目录由连接决定 |
| 目标完成 | goal 扩展识别完成标记 | `goal_complete` | Native 仅在运行目标模式时提供 |
| 时间和上下文 | 无这些同名内置工具 | `current_time`、`sleep`、`get_context_remaining`、`new_context_window` | Native 新增显式工具；new_context_window 不等同于创建另一条会话 |
| 会话检索 | `conversation_search` | 无同名 Agent 工具 | 客户端能搜索不代表模型能调用 |
| 产物展示 | `present` | 无同名 Agent 工具 | Native 有图片等内容项和预览能力，但缺少 Electron 的显式 present 工具契约 |
| 应用设置 | `fastvibe_config_get`、`fastvibe_config_apply` | 无对应 Agent 工具 | 设置 RPC 和界面存在，不等于模型有配置入口 |
| 定时任务 | `schedule_*` | 无对应 Agent 工具 | Native 已有调度器和公共 RPC；现有原生计划明确不恢复旧工具 |
| 工作树 | `worktree_list/create/bind/unbind` | 无对应 Agent 工具 | Native 有工作树功能，模型专用入口不同步存在 |
| 技能 | 技能文件通过 read 读取；斜杠调用展开 | 项目上下文发现、命令读取技能文件 | 不应把没有独立 load_skill 工具判成技能功能缺失 |

主要依据：`native/crates/fv-tools/src/lib.rs`、`fv-server/src/turn.rs`、`fv-server/src/{subagents,browser,board,async_ask}.rs`、`fv-mcp/src/tools.rs`、`fv-server/tests/tools.rs`；Electron 的 `resources/extensions/` 和 SDK 工具目录。`docs/native-completion.md` 记录了 DAG 和定时工具的范围决定。

## 本次确认并修复的展示问题

- `browser` 和基础 `computer` 原先落入 Other，只有通用扳手与工具名。补独立类别、中英文标签和已存在的图标；摘要显示 action 与 URL/ref/selector 等操作对象。
- `list_agents` 漏出子代理类别；异步提问漏出 Question 类别。两者会被错误并入连续工具批次，现按相应类别保持独立行。
- 三个 MCP 资源工具原先落入 Other，现归入 MCP。
- `tool_path` 会把所有工具的 `target` 当文件路径，导致 `send_input` 等工具的子会话 ID 被画成可打开的文件链接。现仅从读取/修改文件的工具取路径；子代理目标显示为上下文。
- 读取摘要仅认 `path`，而文件链接还认 `file_path` 等别名；编辑摘要只认 apply_patch。现共用路径解析，避免摘要与链接指向不一致。该项主要影响外来或历史工具记录。
- 网页搜索摘要现直接读取托管 action 的 query、queries、url，支持多查询。当前协议通常已把首个查询复制到顶层，此前普通单查询并非一律缺失；问题在于摘要只读顶层，不能完整呈现多查询或仅有 action 的记录。

## 仍需区分的展示差距

- `tool_detail` 对计划、问题、子代理控制、MCP、留言板、时钟和上下文工具仍用通用 JSON 参数及文本结果。计划/问题/子任务另有自己的界面，但转写卡片尚未达到 Electron 的专用内容呈现。
- 子代理行仍以原始操作名区分 spawn/send/wait 等，目标已补上下文；没有实现 Electron 那种工具卡内直接列出子任务并点击打开的专用呈现。
- 通用详情只显示前 400 行，尾部仅说明省略行数；超长结果仍需从其他入口查看，不能把它称为完整输出。
- 工具参数增量事件在 GUI 被明确忽略，服务端快照也不保留半截 JSON。这是现有约定：参数完成前不会逐字出现，不宜仅改 GUI 就宣称已支持流式参数。
- 当前工作区已有终端卡、write_stdin 合并、文件列表和滚动修改。本次沿用这些实现，未将其算成本次新修复。

本次验证针对纯展示映射、折叠和既有终端/视图模型回归；未进行真实桌面截图或提供方端到端视觉验收。
