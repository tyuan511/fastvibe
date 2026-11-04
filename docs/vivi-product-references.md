# Vivi 产品参考与外部渠道边界

本文保留 2026-11-01 产品调研中仍有价值的资料与取舍，供后续讨论使用。来源是公开设计说明和产品页，未取得内部实现，也没有在本轮重新验证页面或产品能力；不能据此宣称竞品当前功能或 FastVibe 已有相同机制。

当前实现见 [Vivi 架构与实现](vivi-bot-implementation.md)。DeepSeek 的源码机制单独见 [DSH Superagent 报告](dsh-superagent-architecture.md)，其证据级别与本篇产品资料不同。

## Muse：持续关系与轻量主聊天

历史调研参考 [Muse](https://ai.meta.com/muse) 与 [How We Designed Muse](https://introducing.muse.ai)，提取的交互方向是：

- 一个长期主聊天承载连续交办，复杂主题再分开上下文。
- 前台对话与后台执行分离；回来看到结果或需要处理的问题，而非全量工具日志。
- 产物可以离开聊天继续使用，不必全部压成文字回答。
- 主动反馈需要有价值，不能为了展示活跃而打断用户。
- 名字、头像与性格支持长期协作的体验。

对 Vivi 保留的取舍：一个主聊天、短反馈、真实工作详情按需打开。公开产品里的 Goals、Activity、Approval 等界面不是 FastVibe 的必做清单，也不能用“界面看不到 Task”反推内部没有工作状态。

## Grok Bot：有身份的专业助手

历史调研参考 [Grok Bot](https://x.ai/bot)、[Introducing Grok Bot](https://x.ai/news/introducing-grok-bot) 和 [Marketplace](https://x.ai/bot/marketplace)。页面呈现的方向包括有名字/职位的长期 Bot、真实工具交付、并行协作，以及示范后复用的 Routine。

这些资料提供的是另一种产品心智：个人助手之外，还可能有多个专业工作对象。它们不证明当前 FastVibe 应增加 BotProfile、共享云电脑、Routine 或 Bot-to-Bot 协议；也不证明产品介绍中的能力已经过独立验证。

| 问题 | Vivi 的当前取舍 |
| --- | --- |
| 一个助手还是多个专业 Bot | 一个 Vivi；内部 Worker 是执行会话，不是用户需要管理的团队成员 |
| 执行过程放在哪 | 主聊天简短汇报，完整工具历史留在右侧真实会话 |
| 连续追加如何保持关系 | 同一主题复用原 Worker conversationId |
| 是否需要 Task/Run/Attempt 产品层级 | 不建立该三层对象；保留输入、epoch、问题、结果、投递等事实 |
| 是否需要全套审批或风险面板 | 不因竞品呈现而引入；有具体问题时复用现有提问通路 |
| 是否复用真实应用和产物 | 使用现有文件、Office、Git 和其他执行工具 |

## 未来外部渠道：尚未实现

接入飞书、Telegram、Slack 或 Webhook 时，渠道应是统一领域的 Source 适配器，不再建立第二套模型运行时。Vivi 已确定整体采用 DSH；GitHub 事件、授权工作与交付的完整目标以 [DSH 架构重构设计](vivi-dsh-architecture.md) 为准。本节仅保留通用外部身份边界，当前没有完成这些渠道的端到端接入。

适配器需要维护：

- 平台账号、channel、thread、message 和 reply target 的映射。
- 稳定 external ID 到内部 requestId 的映射，游标、断线补收和重复消息处理。
- 出站 receipt、平台幂等键、可重试失败与永久不可达目标。
- 结果先保存再发送；“进入 Router”“已向平台发送”“用户已读”分别表达。

底层连接可以复用 [App Protocol](app-server-protocol.md) 与传输中立调用表，但普通远程客户端的凭据不应直接成为外部机器人的权限：当前远程策略服务的是已经获得整台宿主访问权限的客户端，开放面较宽。

真正接入时还需明确独立 subject/credential、发送者名单、窄 capability、输入/附件限制、速率和并发限制，以及独立撤销和审计。外部文本不能自动获得本机用户的完整授权，工具白名单与 cwd 也不是 OS 沙箱。

渠道如何映射到现有 Vivi、是否需要独立 Router，以及新增哪几个方法，应随具体渠道合同确定。此处不保留未经实现的 TypeScript 接口副本或旧 `BotRun` scope 设计。
