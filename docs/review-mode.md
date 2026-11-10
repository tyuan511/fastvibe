# Review 模式

Review 是会话内的一类审查任务，使用一个内置 `review` 子代理。设置 → 子代理保留已有 Explorer、Worker 和自定义角色，新增且只新增一个 Review；正确性、契约、安全、性能、UI 和测试都是同一提示词内的检查维度，不注册额外的专项或复核角色。

工程入口见 [Agent 编排合同](engineering/automation.md)、[扩展合同](engineering/extensions.md)、[模型合同](engineering/models.md)。

## 入口与模型

Git 面板的审查入口通过 `engine:start-review` 创建任务，立即返回线程身份，执行过程沿 Agent Team 广播。`spawn_agent(agent_type="review")` 也进入同一入口；可指定 `review_scope`、`review_base` 和 `review_revision`，不会绕回普通可写子代理。

聊天输入框的 `/review` 是同一个入口：引擎在提交路径上识别它，用会话 cwd 与 `worktree` 范围启动审查，命令后面的文字作为本轮审查要求（与审查对话框的要求字段同义），不会作为普通提示词交给模型。命令自身不会写入 SDK 转写，也不记录会话标题或预览；转写里的 `/review` 命令行由持久线程的 `review.command` 派生，因此重载后仍在、且不会重复。审查对话框、Git 面板和 `spawn_agent` 发起的审查没有该字段，也就不显示命令行。队列中的 `/review` 按命令处理（`followUp`，不做 steer），避免把字面命令注入正在生成的回复。

Review 模型和推理强度来自 `SubagentManager` 保存的内置角色配置。未选模型、模型已移除或没有可用鉴权时，明确报错，不继承聊天模型、不使用其它供应商兜底。启动时固定模型对象与经过模型能力约束的推理档位，后续设置变化不改变本轮执行。复查建立新任务，读取新的配置。

## 比较范围与快照

- `worktree`：相对 HEAD 的工作区最终内容，包含暂存与未暂存变化及未跟踪文件。
- `staged`：相对 HEAD 的 index 内容，不混入未暂存修改。
- `branch`：指定基准或 upstream 与 HEAD 的 merge-base 到 HEAD。
- `commit`：指定提交相对第一父提交；根提交相对空树。

快照固定 base/target SHA；工作区文件在启动时捕获，index 文件按 blob 固定。其它上下文读取和搜索从固定 Git 对象进行，不再读取后续工作区内容。位置始终相对仓库根目录。Review 不创建 worktree，不修改 index，不自动提交或修复。

符号链接、子模块、合并冲突、非 UTF-8、二进制及超过读取预算的内容会被明确列为未审查。范围和输出均有边界，超限不会被静默算作审查通过。工作区快照是逐文件捕获；它不宣称为并发写入中的整个文件系统提供原子快照。

报告保存捕获时间、内容摘要、模型、范围及版本。UI 中的代码节选由宿主从捕获内容生成。打开当前文件只用于查看最新工作区，不意味着报告已适用于最新内容；新内容须重新审查。

## 一个角色和三个工具

完整角色提示词位于 `resources/extensions/subagent/agents/review.md`。它先确认范围和项目规则，检查正确性与跨模块契约，再根据内容检查安全/性能/UI，最后逐条自我复核候选发现。

运行时只激活：

- `review_read_file`：分页读取快照的旧版或新版文件。
- `review_search`：在固定目标内容中进行字面搜索，返回截断标志。
- `submit_review_result`：提交最终报告。

不加载普通写入工具、shell、图片工具、MCP 或递归委派。用户/项目同名角色文件不能覆盖内置 Review 的提示词和工具协议。普通 Explorer / Worker 的现有覆盖规则保持不变。

## 结构化报告与完成条件

协议定义于 `src/shared/review.ts`。报告包含摘要、发现项及已审查/未审查文件。每项发现必须包含严重程度 P0～P3、置信度、类别、旧/新文件行范围、触发条件、影响、证据和修复建议。

宿主校验路径、行号、必填字段和覆盖声明，生成发现项 ID 与可信代码节选。合法的 schema 只证明格式和归属，不证明问题语义必然成立；语义复核仍由 Review 角色完成。空发现是有效结果，遗漏文件仍须说明原因。

提交后再次读取或搜索会使先前报告失效，必须重新提交。只输出普通文字不能完成 Review；执行器最多再提示一次结构化提交，仍无有效报告则失败。异常或取消后的报告不会作为成功结果发布。

## 持久化、停止与复查

`AgentThread.review` 保存审查上下文，`AgentThread.reviewReport` 与结果 mailbox 的 `reviewReport` 在 `finishTurn` 的同一事务中提交。沿用现有 `agent_threads` / `agent_thread_messages` JSON 数据列，不新增重复存储或迁移号。重载和进程重启可直接恢复正式报告，不依赖临时子代理转写缓存。

会话 Stop 包含所属审查子代理，子代理 Stop 只影响本线程。准备快照期间的 Stop 会使启动失效，不在停止后继续启动新的审查。进程重启沿用 Agent Team 的 interrupted 恢复规则，不自动运行。

对 Review 线程使用 `followup_task` 会创建新快照的审查任务，不会将它作为普通可写 Worker 恢复。

## 展示与验证

主聊天在审查创建的位置展示精简 Review 卡片：标题右侧提供“查看”和“全部修复”，每个问题仅显示优先级、标题和一句影响描述；点击单个问题在独立侧栏定位并展开它的详情，点“查看”则在侧栏按报告顺序一次列出全部问题，每个都直接展开标题、优先级、位置、代码节选、证据与修复建议。报告头与本页不展示模型、推理档位、版本哈希、快照摘要、采集时间或覆盖文件清单。运行、失败、空结果和覆盖不完整使用一行状态说明，运行时保留停止操作。卡片从当前会话的持久线程及结构化报告派生，不依赖父代理转述，不向 SDK 转写伪造用户或助手消息；Git 直接启动的审查同样显示。更新按线程 revision 合并，迟到快照不能覆盖较新的完成事件，跨会话事件不会进入当前卡片。状态更新不会把旧审查移动到下一条用户请求之后，报告卡片也不进入助手的过程折叠。

“全部修复”仅对已完成且有发现项的报告开放。按钮经正常的 `engine:submit-prompt` 流程，向报告所属会话发送一条本地化预设提示词，包含全部发现项、证据、建议、覆盖缺口和审查版本；接收模型先核对当前代码，再逐项修复和验证。空闲时直接提交，运行中沿用普通队列语义，不切换到其它会话、不覆盖当前草稿，也不把提交成功当成问题已解决。连续点击在提交和短暂成功状态中合并，失败后可重试；按钮不自动提交代码或推送。

专用 Review 页使用独立的 `review` 标签类型和 `ReviewView`，不复用 `SidePaneSubagent`、聊天转写或 Composer。页面展示紧凑运行状态与停止按钮、代码节选、证据、建议和重新审查；“查看”以 `reviewShowAll` 打开同一页的全量问题列表，不另建列表页或折叠层级。不显示模型/推理档位、版本哈希、快照摘要、覆盖统计或变更文件清单。Git 启动、工具结果及会话资源都打开该专用页面；后台任务只登记自己的标签，不抢当前会话焦点。没有发现且有未审查文件时展示部分覆盖，不声称全部通过。

预览：`mock.html?review=1&lang=zh`；聊天卡片：`mock.html?review=1&reviewPane=0&lang=zh`；设置：`mock.html?review=1&lang=zh#/settings/subagents`。

验证入口：

```bash
node --test test/review-snapshot.test.ts test/review-result.test.ts test/review-runtime.test.ts test/review-sdk.test.ts test/review-dispatch.test.ts test/review-command.test.ts test/review-chat-messages.test.ts test/review-repair.test.ts test/prompt-submission.test.ts
node --test test/subagent-config.test.ts test/subagent-discovery.test.ts test/subagent-run.test.ts test/agent-team-lifecycle.test.ts test/agent-thread-mailbox.test.ts
pnpm typecheck
```

Node 测试使用临时真实 Git 仓库、真实持久化和可控 SDK harness；不代表已经向用户配置的真实供应商付费发起审查。UI 行为还需通过 mock 渲染核对。
