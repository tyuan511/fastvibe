# 原生 agent 与 codex cli 的差距盘点

盘点日期：2026-10-27。

- FastVibe 基线：`gpui` 分支 `77cb3bf4`，原生实现在 `native/crates/`（`fv-agent` 2585 行、
  `fv-tools` 5044、`fv-server` 18896、`fv-provider` 3703、`fv-store` 3035、`fv-mcp` 2278、
  `fv-sandbox` 328、`fv-protocol` 3867、`fv-gui` 38105）。
- codex 基线：`/tmp/codex-src`，`codex-rs` HEAD `6fe77fc`（2026-10-27，#57394），约 120 个 crate；
  本机安装的 CLI 是 `codex-cli 0.164.0`。仓库 `codex-cli/package.json` 的 version 是 `0.0.0-dev`，无 tag。
- 方法：只读源码取证，每条结论附文件与行号。未运行任何一方的应用。

**范围口径**（三条，决定哪些差异算「差距」）：

1. 比较对象是**原生 Rust/GPUI 版**，不是 Electron 版。但凡是 Electron 版已有、原生版没有的，
   会单独标为「相对自家旧版的回退」——那是移植遗漏，不是设计取舍。
2. codex 侧只认**代码里真实存在且未被标 Removed 的能力**。`GhostCommit`、`Personality`、`JsRepl`、
   `MultiAgentMode`、`SpawnCsv`、`TranscriptV2`、`ExternalMigration` 在 `features/src/lib.rs` 里已是
   no-op（注释「Removed compatibility flag retained as a no-op」），不算差距。反过来
   `ResizeAllImages`、`ItemIds`、`ApplyPatchPreserveLineEndings`、`TerminalResizeReflow` 的注释是
   「Removed compatibility flag for **always-on** …」，即已是常开行为，**算**差距。
3. 与 OpenAI 账号/后端绑定的能力单列在 §10，不计入补齐清单——符合 2026-10-26 定的
   「原生版只支持自定义端点 + API Key，不做订阅登录」范围（见 `native-completion.md`）。

**一句话结论**：agent 主循环（采样 → 工具 → 提交 → 压缩 → 恢复）两边已经同构，FastVibe 在若干点上
更干净（§9）。真正的差距集中在三块——**安全边界**（跨平台沙箱、命令策略语言、网络代理、凭据遮蔽、
Guardian 审查）、**上下文经济学**（world_state 增量注入、可缓存分层、预算可见化、保留式压缩、图片预算）、
**可扩展性**（hooks / plugins / apps / 客户端自定义工具）。工具面与命令面各有一批缺口。

---

## 1. 已经对齐的（不要再列进 backlog）

| 能力 | FastVibe 位置 | codex 对应 |
| --- | --- | --- |
| 回合主循环、steer 队列、取消语义 | `fv-agent/src/turn.rs`（900 行）、`steer.rs` | `core/src/session/turn.rs`、`session/input_queue.rs` |
| 工具并发：读并发 / 写独占（`Arc<RwLock<()>>`） | `fv-agent/src/turn.rs`（整轮共享一把锁，注释明说与 codex 同构） | `core/src/tools/parallel.rs:54,181,279` |
| 会话式 PTY 执行（`exec_command` + `write_stdin`，64 个会话上限） | `fv-tools/src/exec_command.rs`、`exec_sessions/`（`MAX_SESSIONS = 64`） | `tools/handlers/shell_spec.rs`、`unified_exec/` |
| apply_patch（含模糊定位 `seek_sequence`） | `fv-tools/src/apply_patch/`（parser / plan / seek_sequence / instructions.md） | `apply-patch/`、`core/src/apply_patch.rs` |
| 工具输出中间截断 | `fv-tools/src/truncate.rs`（头注：改编自 codex `core/src/truncate.rs` rust-v0.46.0，Apache-2.0，见 NOTICE.md） | `utils/output-truncation`、`utils/head-tail-buffer` |
| 压缩提示词与「保留用户消息」 | `fv-agent/src/compact.rs::SUMMARIZATION_PROMPT`、`fv-core/src/lib.rs:179-204 compaction_text` | `prompts/templates/compact/prompt.md`（9 行）、`summary_prefix.md`——**逐字一致** |
| 窗口自适应：learned ceiling、失败指纹、最多 6 次缩减、分片摘要、投影自校验 | `fv-agent/src/budget.rs`（`MAX_CAPACITY_RECOVERIES = 6`、`Fingerprint{count,hash}`、`Probe` + Drop 还原）、`compact_input.rs` | `compact.rs`、`compact_model_fallback.rs`、`RemoteCompactionV2` |
| 工具声明字节稳定（为提示词缓存排序） | `fv-agent/src/tool.rs::specs_for`（按名字排序） | `tools/spec_plan.rs`、`IncrementalTools` |
| 悬空 tool call 补结果、丢孤儿结果 | `fv-agent/src/history.rs`（72 行，`MISSING_RESULT`） | `context_manager/normalize.rs:ensure_call_outputs_present` |
| tool_search（BM25 over deferred metadata） | `fv-tools/src/tool_search.rs`、`bm25.rs` | `tools/handlers/tool_search`、`tools/tool_search.rs` |
| 子 agent：spawn/send/wait/close/resume、角色、工具天花板、只读角色强制 ReadOnly+Never、深度与数量上限 | `fv-server/src/subagents.rs`（795 行）、`subagents/roles.rs`、`turn.rs:permissions_for` | `tools/handlers/multi_agents`（v1）、`agent-roles/`、`exceeds_thread_spawn_depth_limit` |
| 长期记忆（两阶段：抽取 + 整合，校验后发布） | `fv-server/src/memory.rs`（799 行）、`memory/plan.rs`、`memory/workspace.rs`、`fv-core/src/memory.rs` | `Feature::MemoryTool`（「startup memory extraction and file-backed memory consolidation」）、`memories/` |
| MCP：stdio + Streamable HTTP、OAuth、resources/templates、图片落盘、`tools/list_changed` | `fv-mcp/src/`（`lib.rs:740 on_tool_list_changed` → `catalog_changes.send_modify`）、`tools.rs:102-110` | `core/src/mcp*.rs`、`McpToolListChanged` |
| Code mode（进程内 JS，工具目录 + `__call` 并发 16） | `fv-tools/src/code_mode/`（rquickjs 0.14：64 MB 内存 / 512 KB 栈 / 600 s / interrupt handler） | `code-mode/`、`code-mode-host/`、`Feature::CodeMode*` |
| hosted web_search（Responses） | `fv-tools/src/web_search.rs`、`fv-core/src/web_search.rs` | `core/src/web_search.rs`、`WebSearchRequest` |
| 电脑操控（三平台） | `fv-tools/src/computer.rs`（macOS CGEvent / Linux xdotool / Windows SendKeys） | `Feature::ComputerUse`（requirements-only gate，实现由桌面宿主提供） |
| 模型端重试与错误分类 | `fv-provider/src/model.rs::open_with_retry`、`error.rs`（`status_retryable = 408|409|425|429|5xx`、`retry_after` clamp 0..120s、`is_overflow()`） | `responses_retry.rs`、`PendingUnauthorizedRetry` |
| 重启恢复（先抢监听再恢复，避免误标别人的活子进程） | `fv-server/src/listener.rs:55-84`（`AlreadyRunning` → `schedules.recover()` → `recover_subagents()`） | `session/daemon_recovery.rs`、`app-server-daemon/` |
| git 对象级检查点（隐藏身份） | `fv-store/src/checkpoint.rs:115-140`（`write-tree` + `commit-tree -p HEAD`，`-c user.name=FastVibe`） | `Feature::GhostCommit` —— **已是 Removed no-op，这条 FastVibe 领先** |
| 保持唤醒、Dock 角标、自动归档、定时任务、使用统计、导入 5 类 agent | `fv-server/src/keep_awake.rs`、`schedules`、`stats`、`fv-import/` | `PreventIdleSleep`、`ExternalAgentMemoryImport`（部分） |
| 技能发现/加载/管理 + composer `/` 徽标 | `fv-server/src/context.rs`（583 行）、`fv-gui/src/skill_draft.rs`、`skill_picker.rs` | `skills/`、`Feature::Skill*` |

---

## 2. P0：现在就会算错、多花钱或没有安全边界

### 2.1 工具返回的图片没有缩小，也没有请求级预算

**证据**

- `fv-store/src/images.rs:44 save()` 只落盘（0600），**不缩放**；`:75 externalize()` 把消息里的图换成文件引用。
- `fv-provider/src/convert.rs:84-102 picture_parts()`：每次请求对历史里每张图
  `std::fs::read(path)` + base64 **原尺寸内联**，无张数上限、无字节预算。
- 全仓唯一的缩放在 `fv-tools/src/view_image.rs:162 img.resize(...)`——只作用于 `view_image` 这一个工具。
- 非视觉模型这一侧是对的：`fv-agent/src/turn.rs:781 let vision = ctx.model.supports_images()`，
  `convert.rs:86-90` 把图换成「[The `x` tool returned an image, but this model cannot see images.]」。

**codex**：`Feature::ResizeAllImages` 的注释是「Removed compatibility flag for **always-on**
centralized image preparation」，配 `core/src/image_preparation.rs`、`UnifiedImageBudget`、
`ImageResizeNotice`、`original_image_detail.rs`，以及 `client_common.rs::normalize_image_details`
（`use_responses_lite` 清空 detail；`ImageDetail::Original` 且模型不支持则降级为 `DEFAULT_IMAGE_DETAIL`）。

**影响**：MCP 生图/截图工具返回一张 3.8 MB 图，之后**每一条请求**都带着它和此前所有图重发。
Electron 版为此做过两半——`shrinkToolResultImages`（长边 1568 / ≤512 KB，Photon 在 worker 线程）
与 `prepareRequestToolImages`（4 MB 请求预算，超限从最旧丢弃并留一行带路径的说明）——
**原生版没有移植，这是相对自家旧版的回退**。症状是网关 413 / 502 / 超时，换哪个上游都一样。

### 2.2 非 macOS 平台没有沙箱，但提示词仍向模型描述沙箱

**证据**

- `fv-sandbox/src/lib.rs` 文档：只有 macOS Seatbelt（`sandbox-exec` + `base.sbpl` / `network.sbpl` /
  `preferences.sbpl`）；「on another system there is no sandbox to apply, so only `danger-full-access`
  can be honoured and anything else is reported as unavailable」。
- 但 `fv-server/src/turn.rs:689-722 permissions_prompt()` 不区分平台，照样告诉模型
  「Commands run in a sandbox that lets them read files anywhere but write only inside these folders」。
- grep 确认原生 crates 里没有 landlock / seccomp / bwrap / windows_sandbox 任何实现。

**codex**：`sandboxing/`（bwrap、landlock、linux_pid_namespace、policy_transforms、sandbox_integrity、denial）、
`linux-sandbox/`（bundled_bwrap、bazel_bwrap、daemon_mounts、fd_mount、exec_util）、
`windows-sandbox-rs/`（acl、allow、deny_read_acl/resolver/state、app_package、cap、conpty）、
`mxc-sandbox/`（native / availability / transport / windows + `PreferMxc`）、
`WindowsSandboxElevated`、`WindowsSandboxService`。

**影响**：Linux/Windows 用户实际只有 full access，而模型以为自己在沙箱里、按沙箱语义规划并要求
`require_escalated`。要么补沙箱，要么让 `permissions_prompt()` 如实说明当前平台无沙箱——
两者不一致本身就是缺陷。

### 2.3 审批记忆只在内存里，且没有规则化

**证据**

- `fv-server/src/runtime.rs:36-37`：`/// Commands and patches the user approved "for the rest of this conversation"`
  → `approved: HashSet<String>`；`:94 is_approved`、`:99` 插入；`:84`、`:123` 两处 `HashSet::new()`（重启即空）。
- `fv-agent/src/permissions.rs`：`Decision{Approved, ApprovedForSession, Denied}`、
  `ApprovalKind::Command{command,cwd} | Patch{files}`。
- 命令是否「已知安全」由 `fv-sandbox/src/safe.rs::is_known_safe` 判定：19 个命令的白名单
  （`cat cd echo false grep head ls nl pwd tail true wc which whoami stat file date uname basename dirname tree`），
  含 `; & | > < \` $ ( ) \n \\` 任一字符即不安全；`git` 仅允许 `status log diff show branch rev-parse ls-files`
  且禁 `--output/--ext-diff/-c/--exec`（`find`/`rg` 因可执行命令被排除）。

**codex**：`execpolicy/` 是一套规则语言（`parser.rs`、`rule.rs`、`policy.rs`、`decision.rs`、`amend.rs`、
`executable_name.rs`、`sandbox_migration.rs`、`execpolicycheck.rs`）；配 `utils/approval-presets`、
`Feature::RequestRule`（模型可请求新规则）、已批准命令前缀**持久化**并把这件事写回模型上下文
（`core/src/context/approved_command_prefix_saved.rs`）。

**影响**：同一条命令用户批准过，重启或换会话又要问一次；模型也不知道「这个前缀以后不用再问」。

### 2.4 system prompt 每轮整条重建，任何易变内容都击穿提示词缓存

**证据**

- `fv-server/src/turn.rs:935-947`：
  ```rust
  system: format!(
      "{}{}\n\n{}{}{}\n\n{}{}{}{}{}",
      base_instructions(cwd.as_deref()), folders, permissions_prompt(&permissions),
      discovered, mcp.instructions, state.agent.system, child_prompt, role_prompt,
      state.schedules.instructions(thread_id), personalization
  )
  ```
  其中 `discovered` 是每轮重新扫盘的 AGENTS.md + 技能清单（`context.rs:486 prompt()`，
  经 `spawn_blocking` + 3 s 超时），`mcp.instructions` 随服务器连接状态变化。
- 已经做对的一半：`fv-agent/src/tool.rs::specs_for` 按名字排序工具声明，注释明说是为了字节稳定。

**codex**：`core/src/context/` 约 60 个独立片段 + `context/world_state/`（20 个分区：`agents_md`、
`permissions`、`compact_permissions`、`tools`、`tools_budget`、`top_level_tools`、`context_window_guidance`、
`model_catalog`、`environment`、`environments_instructions`、`multi_agent_mode`、`multi_agent_usage_hint`、
`plugins_instructions`、`apps_instructions`、`collaboration_mode`、`persistent_mode`、`realtime`、
`managed_developer_instructions`、`model`），每段 SHA1 哈希去重，**只在变化时增量追加**
（`Feature::IncrementalTools`：「Track top-level tool definitions in world state and emit incremental
context updates」；`DeferredToolWorldState`：「Describe deferred tool namespaces in the model-visible
world state」）。`ResponseItem` 有 `ConfigurationUpdate` / `ContextCompaction` / `CompactionTrigger` /
`AdditionalTools` 变体——配置与工具变更是**历史里的可信条目**，模型会被告知「你的工具变了」。
`ReasoningEffortOverride`：「Append trusted response configuration items when the selected reasoning
effort changes」。

**同一个问题的安全面**：codex 把项目内容放在低信任位——`core/src/context/user_instructions.rs:23`
的 role 是 `"user"`；`Feature::UntrustedAsToolOutput`：「Render client-supplied untrusted context as
standalone named tool outputs」。FastVibe 把 AGENTS.md、技能清单、MCP instructions 直接拼进
**system prompt（最高信任位）**。

**影响**：装一个技能、改一行 AGENTS.md、记忆快照刷新、MCP 服务器状态变化，都会让整条 system 前缀
字节变化，从而丢掉所有供应商的缓存前缀。对一个按 token 计费的自定义端点用户，这是直接的钱。

---

## 3. P1：能力对齐

### 3.1 上下文预算对模型不可见，也没有跨子 agent 的共享记账

- FastVibe：预算只有 GUI 的上下文环看得到（`fv-protocol` 的 `ContextBudgetChanged{used,window}`），
  模型不知道剩多少，也没有「自己开一个新窗口」的手段。
- codex：`Feature::TokenBudget`（「Add current context-window metadata to model-visible context」）+
  `world_state/tools_budget.rs` + `world_state/context_window_guidance.rs` +
  工具 `get_context_remaining` / `new_context_window`（`tools/handlers/`）+
  `rollout_budget.rs`（`RolloutBudgetState { config, weighted_tokens_used: f64,
  deliveries: HashMap<ThreadId, ThreadBudgetDelivery> }`——一棵会话树共享记账、每线程各自观察阈值，
  `RolloutBudgetReminder { remaining_tokens, reminder_index }` 由后端定义位置、确认后原样返回）+
  `compact_token_budget.rs`（「跳过模型/服务端摘要，直接装一个新上下文窗口」的手动压缩，
  仍走完整压缩生命周期让 hook 与 `ContextCompaction` 观察到）。

### 3.2 压缩缺少保留层、投机层与模型回退

- FastVibe：`fv-agent/src/compact.rs::compact_inner` 成功后 `history.clear(); history.push(Compaction{usage,
  model, user_messages, summary})`——**只保留用户消息**（`fv-core/src/lib.rs:161-163`，
  按 `KEPT_USER_MESSAGE_BYTES` 中间截断），工具输出与助手消息一律不留。压缩是同步阻塞的
  （`turn.rs` 循环里 `needs_compaction → compact_auto`）。
- codex：
  - 投机/异步：`session/async_compaction.rs`（在到达前台限制**之前**后台准备压缩请求，
    `CompactionAttempt { history_version, model_slug, compaction_hash, auth_owner_generation }`；
    被丢弃的请求仍计费已完成 usage；会话关闭取消剩余网络工作）。
  - 模型回退：`compact_model_fallback.rs::should_retry_with_current_model`（排除
    `TurnAborted | Interrupted | SessionBudgetExceeded | ResponseIncomplete`，且 slug 与
    cyber_access_program 都相同才不重试）。
  - 保留：`compact_retained_tool_outputs.rs`（`is_retained_tool_output` =
    `metadata.client_authored && FunctionCallOutput { call_id: None, name: Some(_), .. }`，
    整体保留或整体丢弃、共享正常 token 预算）、`RetainClientDeveloperMessages`、
    `RetainClientToolOutputs`、`history/retained_assistant_messages.rs`、`session/retained_context.rs`
    （retained 输入按**接受时**排序、助手消息按**流开始时**排序、code mode 消息按**确认投递时**排序）。
  - 图片：`CompactionImageBudget`（「Include retained images in the remote compaction context budget」）。
  - 历史规模：`context_manager/history.rs` 1405 行；`normalize.rs` 的合成输出 ID 用固定 UUID 命名空间
    `0x90d38d3e_6a5b_4d52_bfe2_2f1e634bfac4`，注释明确「改这个值会改变模型可见 ID 并使 prompt cache 失效」。

### 3.3 没有 hooks，也没有客户端自定义工具

- FastVibe：grep 全部原生 crates，无 hook 系统；`fv-protocol/src/methods.rs`（251 行）里没有注册
  自定义工具的入口。Electron 版有 pi extensions，原生版尚无替代物。
- codex：`hooks/` crate，10 个事件（`hooks/src/events/`：`session_start`、`session_end`、
  `user_prompt_submit`、`pre_tool_use`、`post_tool_use`、`permission_request`、`model_request`、
  `compact`、`interrupt`、`stop`）。两条来源：`hooks.json` 配置规则
  （`Feature::CodexHooks` =「Enable Claude-style lifecycle hooks loaded from hooks.json files」，
  `config_rules.rs`）与插件 bundle（`PluginHooks`，`declarations.rs::plugin_hook_declarations`）。
  两种执行器（`hook_environment_executor`、`hook_mcp_executor`），大输出走 `output_spill.rs`。
  TUI 有 `/hooks`。
  运行时契约也比 FastVibe 厚：`core/src/tools/registry.rs::CoreToolRuntime` 有
  `wait_until_ready(session)`（就绪门控）、`immutable_spec()`、
  `cached_code_mode_definitions(input_schema_max_bytes, tool_description_first)`、`is_third_party_tool()`、
  `environments_for_input(invocation) -> ToolEnvironments`、`live_environment_resolver()`、
  `telemetry_tags()`、`on_tool_result_accepted()`、`pre_tool_use_payload()` / `post_tool_use_payload()`
  （Claude-Code 风格载荷：tool_name / tool_input / tool_response / tool_use_id / tool_cwd）、
  `pre_tool_use_cwd()`、**`with_updated_hook_input(invocation, updated_input)`（hook 可改写工具入参）**、
  `finishes_on_cancellation()`、`is_builtin_control_tool()`。
  对照 `fv-agent/src/tool.rs` 的 `trait Tool`：`spec / mutates / hosted / orchestrates /
  finish_turn / deferred / enabled / call`。
- 客户端自定义工具：codex `DynamicToolHandler`、`ExtensionToolAdapter`、
  `MultiAgentV2DynamicTools`（「Inherit client-defined dynamic tools in fresh V2 subagents」）。

### 3.4 工具面缺口（逐个）

codex `core/src/tools/spec_plan.rs` 的处理器全集减去 FastVibe 已有的，剩下：

| codex 工具 | 语义 | FastVibe |
| --- | --- | --- |
| `get_context_remaining` / `new_context_window` | 模型自查剩余窗口 / 主动开新窗口 | 无（§3.1） |
| `request_user_input_async` / `send_message_to_user_async` | **异步**提问与推送（`SendAsyncMessage`、`SendMessageToUserAsync`、`DefaultModeRequestUserInput`） | 只有阻塞式 `fv-tools/src/request_user_input.rs` |
| `request_permissions` | 模型主动申请提权（`RequestPermissionsTool`） | 只有 `exec_command` 的 `sandbox_permissions: "require_escalated"`（等价于 `ExecPermissionApprovals`，这条已有） |
| `current_time` / `sleep` / `wait_for_environment` | 时间、等待、等环境就绪（+ `CurrentTimeReminder` 上下文提醒） | 无；`fv-agent/src/prompt.rs::base_instructions` 里也**没有当前日期时间** |
| `imagegen` | 图像生成（`IMAGE_GEN_NAMESPACE = "image_gen"`、`IMAGEGEN_TOOL_NAME = "imagegen"`、`Feature::ImageGeneration`） | 无 |
| `list_available_plugins_to_install` / `request_plugin_install` | 插件发现与安装 | 无插件系统（§3.5） |
| `plan` | Plan mode 专用；`turn.rs` 有 `PlanModeStreamState`、`handle_plan_segments`、`maybe_complete_plan_item_from_message`、`emit_agent_message_in_plan_mode`——**从模型输出流里解析计划项并实时更新** | 只有 `update_plan` 工具，无 plan mode |
| 多环境工具 | `StableEnvironmentTools`、`MultiEnvCopyFile`、`SubagentThreadEnvironments`（「Inherit configured thread environments instead of temporary turn selections」）、`environments_for_input()`——单次调用可指定在哪个环境/容器执行 | 无环境概念 |
| MCP elicitation | `core/src/elicitation.rs` + `AuthElicitation` + `ToolCallMcpElicitation`（服务器在调用中途向用户征询输入/授权） | `fv-mcp` 无 elicitation（grep 无命中），只有 OAuth；也缺 `McpOAuthRefreshCoordination` |
| 后台终端列举/停止 | TUI `/ps`（list background terminals）、`/stop`（stop all background terminals） | 有 64 个 exec 会话，但**模型和用户都无法列举或杀掉**它们 |

其它工具层差异：

- **命名空间**：codex `ToolName { namespace, name }` + 保留命名空间
  （`config/mod.rs:3251-3269`：`api_tool`、`browser`、`computer`、`container`、`file_search`、`functions`、
  `image_gen`、`multi_tool_use`、`python`、`python_user_visible`、`submodel_delegator`、`terminal`、
  `tool_search`、`web`）+ `NonPrefixedMcpToolNames`（去掉 `mcp__` 前缀）+ `indirect_namespace_prefixes`。
  FastVibe 是扁平 `mcp_{server}_{name}`（`fv-mcp/src/tools.rs:13`）。
- **并行判定的默认值**：codex `tools/src/tool_executor.rs:122 supports_parallel_tool_calls()` 默认 **false**
  （handler 显式 opt-in），且 `core/src/tools/registry.rs:696-698` 把 `ToolExposure::Hidden` 的工具
  排除出并行；另有 per-call 的 `ToolGateTiming` / `ToolBatchTiming` / `ToolAdmission` 计时与
  `CriticalPathTiming` 归因、`direct_path_supported()`（code mode 与 multi-agent 工具不走 direct path，
  `parallel.rs:65-75`）。FastVibe 的默认是 `mutates() -> true`（也是保守的），但没有 hidden 排除与计时归因。
- **终端**：codex `shell_snapshot.rs`（捕获用户 shell 环境/函数快照复用，`CapturedSnapshot` /
  `PreparedSnapshot`；`ShellSnapshotV2` =「Keep policy-filtered shell snapshots entirely in executor
  memory」）、`TerminalResizeReflow`（常开）、`TerminalVisualizationInstructions`、
  `PowerShellShellVersion`、`LoginShellPackagePath`、`ShellZshFork`、`DeferredExecutor`
  （「Allow turns to start while selected executors are still starting」）、
  `ExecutorCapabilityDiscovery(V2)`、独立 `exec-server` / `exec-server-protocol` 进程。
  FastVibe 每条命令跑 `shell -lc` 登录 shell（`exec_command.rs::run`，`login` 默认 true），
  无快照、无 executor 进程、无能力发现——每条命令都重跑用户启动文件。
- **apply_patch**：codex `ApplyPatchStreamingEvents`（「Stream structured progress while apply_patch
  input is being generated」）+ `ApplyPatchPreserveLineEndings`（常开）。FastVibe 有 `BlockDelta`
  流式参数，但没有结构化的 patch 进度事件。
- **Code mode**：codex 有独立宿主进程（`CodeModeHost` =「Run JavaScript code mode in the standalone
  host process」、`code-mode/grpc_session/`、`remote_session.rs`）、`CodeModePrewarm`、`CodeModeInterrupt`、
  `CodeModeBufferedExec`、`CodeModeToolDescriptionFirst`、`CodeModeOnly` +
  `CodeModeOnlyStrictThirdPartyTools`（「Ignores deferLoading, omit_tools_from, and namespace skip
  settings」）。FastVibe 是进程内 rquickjs。
- **浏览器**：codex `BrowserUse`（+ `BrowserUseFullCdpAccess`、`BrowserUseExternal`、
  `BrowserAnnotationApi`：「Allow websites to open and customize annotation tools in desktop apps」）、
  `InAppBrowser` / `InAppChat`。FastVibe 原生只有 OS 级 `computer` 工具 + GUI webview 预览，
  **没有结构化浏览器工具**（无 snapshot / 元素 ref / click by ref）——Electron 版的 `browser_*` +
  `data-fv-ref` 元素寻址没有移植，**这是相对自家旧版的第二处回退**。

### 3.5 插件与 apps（生态入口）

- codex `plugin/` + `plugin-host/`（framing、process）+ `core-plugins/`（75 个文件）：
  manifest（`PluginManifestMcpServers`、`PluginManifestHooks`、`PluginManifestInterface`）、
  marketplace（add / remove / upgrade / staging / policy / context）、`npm_source.rs`、
  remote bundle + remote metadata + remote mutations + `remote_plugin_id_resolver`、
  `recommended_plugin_install.rs`、`PluginSharing`、`plugin_metrics_sidecar.rs`、`skill_snapshots.rs`、
  `startup_sync.rs`、`agent_plugin_mcp_overlay.rs`、`app_mcp_routing.rs`、`artifact_operation.rs`、
  `git_policy.rs`、`command_migration.rs`、`plugin_bundle_archive.rs`、`catalog.rs`
  （`PluginCatalogEntry { id, enabled, display_name, version, mcp_servers, connector_ids, locations }`，
  「only a complete empty catalog establishes absence」）。TUI 有 `/plugins`。
- codex apps：`Apps`、`EnableMcpApps`、`Mcp20260728`（MCP 2026-07-28 apps 规范，MCP 服务器可提供 UI）、
  `CodexAppsMcp20260728`、`AppsMcpPathOverride`、`connectors.rs`、`core/src/apps/{mod,render}.rs`。TUI 有 `/apps`。
- codex 内部扩展 API：`codex-extension-api`（`ExtensionRegistry`、`tool_lifecycle_contributors`、
  `WorldStateSectionContribution`、`PreviousWorldStateSection`、`RenderedWorldStateFragment`）——
  world_state 的分区可由扩展贡献。
- **FastVibe 原生：三者都没有。**

### 3.6 技能层的小缺口

codex 多：`SkillCatalogDeltas`（「Append skill additions and edits within a cumulative context budget」，
增量而非整表重发——FastVibe 每轮重发整份清单，`context.rs:486`）、`SkillMcpDependencyInstall`
（「Allow prompting and installing missing MCP dependencies」）、`SkillSearch`（影子模式 + 实验指标）、
`SkillEnvVarDependencyPrompt`、`skills/mentions.rs`（@提及技能）、`skills/assets/`、
`SkipHostSkillDiscovery`。

### 3.7 多 agent 的协作层

FastVibe 已覆盖 codex multi_agents **v1** 的语义面（§1）。codex 多出来的：

- **v2 工具集**：`spawn / wait / send_message / interrupt / list / followup_task`
  （`MultiAgentV2` =「Enable task-path-based multi-agent routing」，`HARD_MAX_MULTI_AGENT_V2_TIMEOUT_MS`
  硬上限校验见 `config/mod.rs:3240-3250`）。
- **agent 间留言板**：`message-board/` crate（api / host / in_memory / local / permissions / tools / types，
  本地-内存-远程可换后端）+ `AgentMessageBoard`（「Enable shared discussion tools for an agent tree」）+
  `WakeOnAgentMessages`（「Allow agent messages to wake idle root sessions after a completed turn」）+
  `DeferMailboxPreemption`（「Pending mail is delivered at the next normal input boundary instead」）+
  `InstantInterrupt`（「Preempt responses and yield foreground code-mode observations on new user input」）+
  `Collab`。FastVibe 只有父子单向 send/wait。
- **拓扑持久化**：`agent-graph-store/`（parent/child 图存储）；`thread_manager/`（managed /
  shared_instructions / shutdown）+ `AgentTreeShutdown{Failure,FailureReason,Report}`。
  FastVibe 有 `interrupt_tree` / `descendants`，但没有整树关闭报告。
- **目标**：`Goals` =「Enable persisted thread goals and automatic goal continuation」+
  `context/user_goal.rs` + TUI `/goal`。Electron 版有 `/goal`（`resources/extensions/goal.ts`），
  **原生版没有**（grep `goal` 只命中 subagent 角色描述）。
- **共享预算**：`RolloutBudget`（§3.1）。
- **工作区依赖**：`WorkspaceDependencies`。
- **指挥中心**：TUI `/agents`、`/side`（「start a side conversation in an ephemeral fork」）。

### 3.8 任务类型：review

codex `core/src/tasks/review.rs`：`/review` 是一个完整的一次性子线程任务
（`run_codex_thread_one_shot`，带自己的 `BaseInstructionsProvenance`、`WebSearchMode`、`AskForApproval`、
`SubAgentSource`），输出是**结构化 findings**（`ReviewOutputEvent`、
`codex_protocol::review_format::{format_review_findings_block, render_review_output_text}`、
`ExitedReviewModeItem`、`render_review_exit_success/interrupted`）。另有 `guardian_review.rs` 与
`core/src/context/node_repl_review_evidence.rs`。FastVibe 无对应物（`review` 一词只出现在
explorer 角色描述与 Git 面板注释里）。

### 3.9 回合挂起

codex `session/turn_suspension.rs::suspend_turn_and_shutdown(session, submission_id)`：把未完成的
root turn 持久化后关闭（只在 `TaskKind::Regular` 时挂起，否则 `UnsupportedTask`；无活动 turn 返回
`NotActive`），可恢复。FastVibe 重启只是把在跑的标为 interrupted（`listener.rs:71`），不能续跑，
只能重试。

---

## 4. P1：安全纵深（在 §2.2 / §2.3 之上）

### 4.1 网络策略

- codex `network-proxy/`（38 个模块）：`mitm`、`mitm_hook`、`domain_matcher`、`connect_policy`、
  `socks5`、`http_proxy`、`attribution`（`PROXY_ATTRIBUTION_TOKEN_ENV_KEY`、`write_attribution_frame`，
  把请求归因到 tool call，配 `CODEX_TOOL_CALL_ID_ENV_VAR`）、`body_budget`、`credential_broker` +
  `aws_sigv4`（`AwsSigV4Config`、`ProxySecretSource`）+ `secret_substitution`（凭据由代理注入而不进环境）、
  `certs` / `native_certs`（`CUSTOM_CA_ENV_KEYS`）、`system_dns`（macOS）、`windows_tcp_attribution`、
  `windows_proxy_ingress`、`remote_config`、`request_cancellation`、`request_disconnect`、
  `connection_lifecycle`、`environment_policy`、`network_policy`、`reasons`、`socket_path`、`state`。
  配 `core/src/network_policy_decision.rs`、`context/network_rule_saved.rs`（把「已保存的网络规则」写回上下文）、
  `RespectSystemProxy`、`SystemProxyFallback`（「Retry eligible bootstrap requests through the system
  proxy after normal routing fails」）、`NetworkProxy`（「Start the managed network proxy for sandboxed
  sessions」）、`CredentialMasking`（「Mask credentials and inject them through an already enabled
  network proxy」）。
- FastVibe：沙箱策略里一个 `network: bool`（`fv-sandbox/src/policy.rs`），全局开关 `settings.sandbox_network`
  （`turn.rs:permissions_for`）。原生 crates 里 `proxy` 只出现在 office watch / update 的无关用法。

### 4.2 Guardian（自动审查审批）

- codex `core/src/guardian/`（20 个文件：`approval_request`、`coverage`、`decision`、`feedback`、
  `input_budget`、`permissions`、`prompt`、`request_budget`、`review`、`review_request`、`review_session`、
  `review_session_context`、`review_session_setup`、`reviewer_config`、`runtime`），`mod.rs` 头注：
  「Hosts approval decisions and the isolated synchronous reviewer. The extension chooses policy and
  evidence; core enforces permissions and mandatory review requirements. Each approval retains its
  issuing context and cancellation.」
  Feature：`GuardianApproval`（「Enable automatic review for approval prompts」）、`GuardianV2`、
  `GuardianV2DecisionsComparison`（「Run Decisions alongside Guardian V2 for measurement without
  changing approvals」）、`GuardianV3`、`GuardianRecordedItems`、`GuardianThreadContext`、
  `GuardianReuseParentCompaction`、`GuardianRootHandoffContext`、`GuardianEnhancedNodeReplTranscripts`、
  `GuardianNodeReplTranscriptImages`、`GuardianTrustOrchestratorConnectors`、
  `GuardianConversationHistoryTools`。`context/guardian_*`（10+ 个上下文片段）。
  TUI `/approve` =「approve one retry of a recent auto-review denial」。
- FastVibe：无。审批是纯人工（`permissions.rs::Approver::approve()`）。

### 4.3 凭据与遮蔽

- codex：`secrets` crate、`utils/redacted-string`、`keyring-store`、`SecretAuthStorage`
  （「Store CLI auth in the encrypted local secrets backend when keyring storage is selected」）、
  `CredentialMasking`、`process-hardening`、`user-verification`、`attestation.rs`、`agent-identity`、
  `workload-identity`、`installation_id.rs`。
- FastVibe：`fv-store/src/credentials.rs` 明文 JSON（0600，独立文件，文档写明
  「Nothing in the protocol returns what is in here」——**这一点做对了**）。遮蔽只存在于记忆管道
  `fv-server/src/memory/plan.rs:106 redact()` → `[REDACTED_SECRET]`（`:125`、`:130` 两组正则），
  **不覆盖工具输出与日志**。

### 4.4 补丁拒绝的原因粒度

- codex `core/src/safety.rs`（184 行）：`SafetyCheck{AutoApprove, AskUser, Reject{reason}}`、
  `PatchSandboxRoute{ExecutorManaged, Platform(WindowsSandboxLevel)}`，两个明确常量
  `PATCH_REJECTED_OUTSIDE_PROJECT_REASON = "writing outside of the project; rejected by user approval
  settings"`、`PATCH_REJECTED_READ_ONLY_REASON = "writing is blocked by read-only sandbox; rejected by
  user approval settings"`。
- FastVibe：靠沙箱 + `ApprovalKind::Patch{files}` 询问；判断「是不是被沙箱挡了」用输出字符串匹配
  （`fv-sandbox/src/safe.rs::looks_denied`：exit 0 → false，否则匹配 "operation not permitted" /
  "read-only file system" / "permission denied" / "sandbox"…），再按 `ApprovalPolicy` 分支
  （`exec_command.rs::execute`：OnFailure → 询问后重跑无沙箱；OnRequest → 在输出后追加提示让模型用
  `require_escalated` 再调；Untrusted/Never → 追加「沙箱可能阻止了它，当前策略下无法询问」）。
  这套语义是对的，但依赖字符串匹配，且没有 Windows 路由概念。

---

## 5. P2：模型传输与请求层

- **双通道与预热**：codex `client.rs`（3258 行）有 `WebsocketSession`、`preconnect_websocket`、
  `prewarm_websocket`、`ResponsesHttpExecutor`、`stamp_ws_stream_request_start_ms`、
  `sideband_websocket_auth_headers`、`AppServerWebSocketCompression`；回合开始前可预热客户端会话
  （`turn.rs:run_turn` 的 `prewarmed_client_session: Option<ModelClientSession>` 参数）。
  FastVibe 只有 genai 的 HTTP SSE。
- **取消传播到上游**：codex `client_common.rs::ResponseStream { rx_event, interrupt:
  Option<oneshot::Sender<ResponseInterrupt>>, consumer_dropped: CancellationToken }`，`Drop` 里
  `consumer_dropped.cancel()`——消费者提前退出会**主动通知上游停止生成**。FastVibe 只有本地
  `CancellationToken` + `tokio::select!`（`turn.rs::sample`），请求侧靠 drop。
- **流中断后的续命**：codex `UnboundedConnectionRetries`（「Keep active sampling turns alive until a
  failed network connection recovers」）。FastVibe `open_with_retry` **只在第一个有意义事件到达之前重试**
  （条件 `!retryable || attempt >= max_retries || capture.activity`），流中断即交回调用方 → 回合失败 →
  用户手动「继续」。
- **增量工具声明**：`IncrementalTools` + `PredictionPreserveParentTools`（预测时保留父工具集），
  减少每请求重复的 schema 字节。FastVibe 每请求发全量工具。
- **`OutputTokenReplay`**：「Request encrypted sampled output for token-preserving replay」。
- **`StepModelSwitching`**：「Enable explicitly requested model changes for later step captures」——
  回合内不同 step 用不同模型。FastVibe 一个线程一个模型（`thread/model/set`）。

---

## 6. P2：存储与线程生命周期

- codex `thread-store/`（storage-neutral：`ThreadId` 是唯一持久句柄，可解析到本地 rollout 文件 / RPC /
  其它后端；`in_memory`、`live_thread`、`local/`、`projects`、`queue_store`、`thread_attachments`、
  `thread_metadata_sync`）、`state/`（SQLite 镜像 rollout 元数据：`audit`、`delegated_preview`、`extract`、
  `log_db`、`migrations`、`model/`）、`rollout/`（`compression/`、`config`、`list`、`list_files`、
  `maintenance`、`metadata`；导出 `RolloutRecorder`、`SessionMeta`、`ThreadItem`、`ThreadsPage`、`Cursor`、
  `ARCHIVED_SESSIONS_SUBDIR`）、`thread_rollout_truncation.rs`（按 user turn 边界截断）、
  `LocalThreadStoreCompression`（「Compress cold local thread-store rollout files, including shared
  histories」）、`BackgroundPaginatedRolloutMigration`。
- FastVibe `fv-store/`（SQLite：transcripts、checkpoints、stats、search index、usage、turn records）——
  功能面相当，缺 rollout 压缩、分页游标与后台迁移。
- codex 还有 `executed_tool_calls/`（`ExecutedToolCallMetadata`：记录已执行的工具调用供审查/分析）、
  `turn_diff_tracker.rs`（逐轮 diff：`TrackedPath { environment_id, path }`、`DIFF_TIMEOUT = 100ms`
  「Normal edits finish well within 100 ms; pathological inputs fall back to a coarse, content-exact
  diff without stalling tool completion」、`ZERO_OID` / `DEV_NULL` / `REGULAR_FILE_MODE` 构造合成补丁）、
  `CwdRelativeTurnDiffs`（「Use the current working directory for turn diff display paths」）。
  FastVibe 的 `fv-protocol` 里 `Item` 只有 `UserMessage / AgentMessage / Reasoning / ToolCall / Audio /
  Image / Error / ContextCompaction`（`types.rs:283-323`），**没有逐轮改动文件聚合项**——
  Electron 版有「已修改 N 个文件」卡片，原生版要靠 Git 面板（`GitFileChange`，`types.rs:743`）间接看。

---

## 7. P2：可观测性与配置

- **遥测**：codex `otel/`、`otel-trace-websocket/`、`analytics/`、`diagnostics/`、`direct-tool-timing/`、
  `turn_timing.rs`、`utils/critical-path/`、`utils/elapsed/`、`RuntimeMetrics`（「Enable runtime metrics
  snapshots via a manual reader」）、`CriticalPathTiming`（「Capture internal direct-tool dependency paths
  for turn attribution」）、`Chronicle`、`feedback/`、`prompt_debug.rs`、`turn_metadata.rs`、
  `tools/control_tool_analytics.rs`、`tools/metadata_metrics.rs`、`tools/tool_dispatch_trace.rs`、
  `tools/call_trace.rs`。
  **FastVibe 原生：`native/crates/` 下没有任何 `tracing` 依赖，也没有 otel**（已 grep 确认）。
  只有 `fv-server/src/log.rs` 与协议方法 `diagnostics/get`。这意味着「回合慢在哪」在原生版无法归因——
  Electron 版有 `engine/startup-timeline.ts` 与 event-loop stall 日志，原生版没有对应物。
- **配置**：codex `config/` crate（TOML 分层：managed / system / user / project / CLI + profiles）、
  `config-schema/`（生成 JSON Schema）、`config/src/resolve.rs`（requirement sources）、
  TUI `/debug-config`（显示每层来源）。FastVibe 是单份 settings JSON（`fv-server/src/settings.rs`），
  无 profiles、无分层、无 schema、无「这个值从哪来」。
- **灰度**：codex `features/`（4032 行：`lib.rs` 2300 + `feature_configs.rs` 605 + `legacy.rs` 115 +
  `tests.rs` 981），200+ feature 带 `Stage::{UnderDevelopment, Experimental, Stable, Removed}` +
  `default_enabled`。FastVibe 用散落的 settings 布尔（如 `code_mode_enabled`，`turn.rs:864-871`）。
- **用户可见诊断**：codex `/warnings`（「view retained warnings and diagnostic details」）、`/status`、
  `/usage`。FastVibe 无。

---

## 8. P2：交互命令面

codex TUI 有约 60 个斜杠命令（`tui/src/slash_command.rs:12-190`）。FastVibe 原生 composer 只有技能
palette（`/skill:name`，`fv-gui/src/skill_draft.rs:56`「The palette owns a single leading command,
never a path, URL or later slash in prose」），其余能力是 GUI 按钮/菜单
（如 `fv-gui/src/workspace/composer.rs:658` 的 `compact-context`）。

缺失且值得补的（按价值排序）：

| codex | 语义 | 备注 |
| --- | --- | --- |
| `/plan` | switch to Plan mode | 见 §3.4 |
| `/review` | review my current changes and find issues | 见 §3.8 |
| `/init` | create an AGENTS.md | 生成项目指令，FastVibe 无 |
| `/recap` | summarize the current conversation now | FastVibe 只有 compact（会替换历史） |
| `/goal` | set or view the goal for a long-running task | Electron 版有 |
| `/side`、`/btw` | start a side conversation in an ephemeral fork | FastVibe 有分叉，但无「临时旁支」语义 |
| `/presets` | run or save reusable prompts and slash commands | 对应 `~/.codex/prompts` |
| `/permissions` | choose what Codex is allowed to do | FastVibe 在设置里，非命令 |
| `/ps`、`/stop` | list / stop background terminals | 见 §3.4 |
| `/hooks`、`/plugins`、`/apps`、`/agents` | 管理面 | 依赖 §3.3 / §3.5 / §3.7 |
| `/warnings`、`/usage`、`/status`、`/diff`、`/export`、`/raw` | 诊断与导出 | |
| `/memories`、`/skills`、`/mcp`、`/worktree`、`/import` | FastVibe 有对应 GUI 面板 | 只是没有命令入口 |

---

## 9. FastVibe 反超的地方（避免只看到差距）

1. **git 对象级检查点**：`fv-store/src/checkpoint.rs:115-140` 用 `write-tree` + `commit-tree -p HEAD`，
   以 `-c user.name=FastVibe -c user.email=checkpoint@fastvibe.dev` 隐藏身份（注释：「the identity is
   ours so a user who inspects it is not told they made it」）。codex 的 `Feature::GhostCommit` 已是
   「Removed compatibility flag retained as a no-op」。
2. **窗口自适应预算**：learned ceiling 按 `format!("{}/{}", model.context_key(), context_window(model))`
   隔离、`MAX_CAPACITY_RECOVERIES = 6`、历史前缀指纹（count + hash）只在**未变化的前缀**上阻塞、
   `Probe` + Drop 未 commit 则还原、`reject()` 取 `(min(ceiling, input+output+margin)/2).max(floor)`、
   摘要投影自校验（必须 < `input_limit` 且 auto 时 < before）。codex 的对应物是 remote compaction +
   model fallback，思路不同；FastVibe 这套在「供应商声明窗口大于实际容量」的场景下更实用。
3. **模糊补丁定位**：`fv-tools/src/apply_patch/seek_sequence.rs`。
4. **重启恢复的顺序**：`fv-server/src/listener.rs:55-84` 先抢 Unix socket（`AlreadyRunning`）再
   `schedules.recover()` + `recover_subagents()`，注释写明「A second launch must not relabel the first
   server's live children as interrupted before discovering it is already up」。
5. **steer 语义显式对齐并有改进**：`fv-agent/src/steer.rs` 注释与 codex 一致（队列、不中断、只在下次
   请求前 drain、永不切开工具批次），差别是 leftover 由 server 在运行结束时转成普通排队提示。
6. **子 agent 的安全收敛**：只读角色强制 `SandboxMode::ReadOnly + ApprovalPolicy::Never`
   （`turn.rs:permissions_for`），子 agent 提示词明确「继承的是父上下文，工具会话与进程句柄不可复用，
   审批属于父级」（`child_prompt`，`turn.rs:907-928`）。
7. **压缩保留全部用户消息**：`fv-core/src/lib.rs:161-163` + `compaction_text_with_budget`
   （`KEPT_USER_MESSAGE_BYTES` 中间截断）——codex 的 compact 提示词没有这一层保证。
8. **GUI 宽度**：24 套主题 + 玻璃效果、Office 静态/实时预览 + 选中引用、PDF/HTML/图片/视频预览、
   并排 diff 与 Git 树、文件树增删改、导入 5 类 agent、i18n、Dock 角标、保持唤醒、自动归档、定时任务。
   codex 是 TUI，这块不可比。

---

## 10. 明确不在范围内（与 OpenAI 账号/后端绑定）

按 2026-10-26 的范围决策（原生版只支持自定义端点 + API Key），以下不计入补齐清单：

`RemoteCompactionV2`（已是 removed key，仅向后端广告）、`AsyncCompaction` 的**远程**那一半、
`ContextManagement` + `session/token_budget.rs::experimental_context_is_eligible`
（要求 `auth_mode == ChatGPT && plan_type ∈ {Plus, Pro, ProLite, ProMax}`）、`Psp`、`UseAgentIdentity`、
`RuntimeAgentInstances`、`workload-identity`、`cyber_access_program.rs` + `ApiKeyCyberAccessPrograms`、
`cloud-tasks/` + `cloud-client/`、`chatgpt/`（订阅登录）、`/usage` 的额度与限额重置、
`EnableRequestCompression`（zstd 到 codex-backend）、`RemoteModels`、`BedrockSetupWizard`、
`AnalyticsPlanHistory`、`CliDaybreak`、`FastMode` / `UltrafastMode`（service tier）、`attestation`、
`UseXaa`（enterprise refresh-token authorization）、`model_catalog` 里由后端下发的部分。

**其中三条可以脱离后端做，应从这一堆里挑出来**：`AsyncCompaction` 的本地投机压缩、
`StepModelSwitching`、`ReasoningEffortOverride`（把配置变更作为可信历史条目追加）。

---

## 11. 建议顺序

**P0（正确性、成本、安全边界）**

1. 工具输出图片的缩小 + 请求级字节预算（§2.1）。移植 Electron 版的两半：落盘时缩到长边 1568 / ≤512 KB；
   每请求总量超 4 MB 从最旧丢弃并留一行带路径的说明。
2. 非 macOS 的沙箱，或让 `permissions_prompt()` 如实说明当前平台无沙箱（§2.2）。
3. 审批持久化 + 已批准命令前缀写回上下文（§2.3）。规则语言可以后做。
4. system prompt 分层：稳定的 `base_instructions` 单独作为系统消息，易变内容改成哈希去重的 contextual
   条目追加在 input 里，并把项目内容从 system 降到低信任位（§2.4）。

**P1（能力对齐）**

5. hooks（10 事件 + 配置规则 + 可改写入参）与客户端自定义工具（§3.3）——生态入口，也是 Electron 版
   pi extensions 的替代物。
6. 模型可见的上下文预算：`get_context_remaining` / `new_context_window` + `TokenBudget` 式上下文条目 +
   跨子 agent 共享预算（§3.1）。
7. 保留式压缩（retained tool outputs / developer messages / assistant messages）+ 本地投机压缩 +
   压缩模型回退（§3.2）。
8. plan mode（含从输出流解析计划项）与 review task（结构化 findings 落转写）（§3.4、§3.8）。
9. 异步交互工具、`current_time` / `sleep` / `wait_for_environment`、系统提示补当前日期时间（§3.4）。
10. 结构化浏览器工具（移植 Electron 的 `browser_*` + 元素 ref，或走 CDP）（§3.4）。
11. exec 会话可列举/可杀（对齐 `/ps`、`/stop`），并给模型一个 list/kill 工具（§3.4）。
12. goals（持久化目标 + 自动续跑）与 agent 留言板（子 agent 间直接通信 + 空闲唤醒）（§3.7）。
13. MCP elicitation + OAuth refresh coordination（§3.4）。
14. Guardian 式自动审查（§4.2）——大件，可放在 hooks 之后。

**P2（工程化与运维）**

15. 引入 `tracing` + turn timing + critical path 归因（§7）。
16. 配置分层 / profiles / JSON Schema /「这个值从哪来」（§7）。
17. shell snapshot（省掉每条命令的登录 shell 启动文件开销）（§3.4）。
18. feature flag 系统（带 stage 与默认值），替代散落的 settings 布尔（§7）。
19. 技能目录增量 + 技能 MCP 依赖安装提示（§3.6）。
20. 逐轮改动文件聚合项 + turn diff tracker（§6）。
21. rollout 压缩 / 分页 / 后台迁移（§6）。
22. 斜杠命令面（§8）。
23. 插件与 apps 市场（§3.5）——最大件，按产品定位取舍；语音、图像生成同理。
