# FastVibe 文档索引

本目录保留当前实现、持续维护的协议/操作说明，以及明确标注边界的外部研究。产品介绍见 [中文 README](../README.zh-CN.md) / [English README](../README.md)，仓库约定见 [AGENTS.md](../AGENTS.md)。

## 工程开发合同（按需阅读）

根 `AGENTS.md` 只保留全项目硬规则与任务入口；原有的模块约束、实现原因、故障案例、历史测量与回归指引已迁到 [engineering/README.md](engineering/README.md)。修改模块前按任务选择文档，不把整个目录作为常驻提示词加载。

| 领域 | 工程合同 |
| --- | --- |
| 引擎、协议与恢复 | [架构与调用表](engineering/architecture.md)、[会话生命周期](engineering/session-lifecycle.md)、[持久化](engineering/storage.md) |
| 手机与远程 | [Flutter / Rust / iroh](engineering/mobile.md)、[远程服务与账号](engineering/remote-access.md) |
| 界面与交付 | [UI / 主题 / 布局](engineering/ui.md)、[转写呈现](engineering/transcript.md)、[Markdown / 图表](engineering/markdown.md)、[文件 / Git / Office / 媒体](engineering/workspace-and-media.md) |
| 模型、工具与自动化 | [供应商与模型](engineering/models.md)、[扩展 / 技能 / MCP](engineering/extensions.md)、[Agent Team / Goal / 定时任务 / 历史 DAG](engineering/automation.md) |
| 记忆、Vivi 与应用维护 | [记忆与 Vivi 补充约束](engineering/memory-and-vivi.md)、[桌面运行环境](engineering/desktop-runtime.md)、[开发 / 依赖 / 发布 / 验证](engineering/development.md) |

专项设计与工程接入约束的关系、当前实现与历史资料的边界见工程索引；以下设计、协议与研究入口继续保留。

## 当前架构与功能

| 文档 | 内容与维护入口 |
| --- | --- |
| [Vivi 架构与实现](vivi-bot-implementation.md) | Router/Worker 持久会话、输入/epoch、结果投递、停止恢复、聊天 feed 与当前限制；接口类型以 `src/shared/bot.ts` 为准 |
| [Vivi Markdown 记忆](vivi-memory-design.md) | 常开私有记忆、明确更新、提炼、发布、来源与共享遗忘规则 |
| [普通长期记忆](memory.md) | 可选全局记忆、提炼与整合、读取和引用；不等于 Vivi 记忆 |
| [多文件夹项目](multi-folder-projects.md) | 主文件夹重键、会话 cwd、额外规则/技能发现、Git 与检查点 |
| [图片生成工作台](image-generation.md) | 独立图片会话、并行异步任务、GPT/Gemini/Grok 模型、默认模型与 Agent 工具 |
| [OfficeCLI 集成](office-officecli.md) | 内置二进制、静态/live 预览、引用选中、文件回退、SSH/手机；§7 是升级验收入口 |
| [从其他 Agent 导入](import-from-other-agents.md) | 源格式证据和唯一写出器契约；各来源当前是否启用以 adapter 注册表为准 |
| [SQLite 存储](sqlite-storage.md) | 数据/配置边界、事务、旧文件迁移与历史测量；schema 以 `db-schema.ts` 为准 |
| [Pi 引擎模式](pi-engine-modes.md) | 隔离/全局配置模式、切换和数据保留边界 |
| [浏览器自动化](browser-automation.md) | 紧凑语义快照、Codemode 结构化结果、严格 Ref、内嵌与系统浏览器的原生输入和验证边界 |
| [网络代理](network-proxy.md) | 客户端代理配置及请求路径 |

## 已确定的重构方向

[Vivi 采用 DSH 完整架构](vivi-dsh-architecture.md)：整体替换当前会话运行器，完整保留 Source、Policy/Evaluation/Mandate、Ticket/Assignment、同步 Engine、Effects/Outbox、Session 投递、资源与恢复机制。GitHub Issue/PR 外部事件闭环是首个验收场景，不以最小闭环为由省略核心架构。此文是目标与迁移设计，当前实现仍以上表为准。

## 协议、部署与维护

| 文档 | 内容 |
| --- | --- |
| [App Server 协议](app-server-protocol.md) | 外层鉴权、App Protocol、快照与事件、能力和第三方客户端边界 |
| [iroh 中继节点列表](iroh-relay-nodes.md) | 完整节点列表、兼容回退、刷新撤销与桌面/手机传递合同 |
| [Agent runtime](agent-runtime.md) | SSH 无头运行时的版本与发布 |
| [发布记录](release/README.md) | 桌面和移动端版本说明；已发布内容作为历史记录保留 |
| [Flutter 手机端](../apps/mobile/README.md) | Flutter UI、Rust core、构建与真实协议验证 |

## 研究与未实施方向

这些文档提供取舍依据，不能作为已上线功能清单。固定提交、测量日期、验证范围和未实施项应随正文保留。

| 文档 | 性质 |
| --- | --- |
| [DSH Superagent 源码架构报告](dsh-superagent-architecture.md) | 固定上游提交 `8c32a9dc`，分析领域、执行、授权、持久投递和安全边界；未运行真实集成 |
| [Vivi 产品参考与外部渠道](vivi-product-references.md) | Muse/Grok 历史产品资料和未来渠道身份、去重、回执约束；不是内部实现证明 |
| [Pi Durable 参考](pi-durable.md) | 对现有引擎的机制参考，部分已落地；未采用该实验 harness |
| [引擎 utilityProcess 评估](engine-utility-process.md) | 整个引擎移出 Main 的取舍；与已有只读转写 utility 实验分开 |
| [Rust + GPUI 可行性](rust-gpui-rewrite-feasibility.md) | 技术调研与历史比较，不能视作当前产品迁移承诺 |

## 文档维护规则

- 当前行为优先引用源码、类型与回归入口；不另存会持续漂移的接口伪代码副本。
- 已完成方案转为实现说明，删除待开工步骤、已解决缺口和过期验收流水账。被替代的整篇计划在提取独有资料后删除，不保留多个互相矛盾的“当前架构”。
- 外部研究写明固定版本和证据边界；上游事实、FastVibe 已实现行为和未来建议分别表述。
- 测试命令用于复验；历史某次通过数量不能当成当前结果。静态检查、fixture、脚本模型和真实供应商/设备验证不能混称。
- 删除或改名时更新 README、AGENTS、其他文档和维护脚本的引用。发布记录、schema 迁移及已有用户数据不作为文档清理对象。
