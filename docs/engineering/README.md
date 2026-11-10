# 工程合同与按需阅读索引

根 [AGENTS.md](../../AGENTS.md) 只保留全项目硬规则与任务入口。本目录保存原根文件中的模块合同、实现原因、历史故障、测量和回归指引，按任务读取，不整目录注入每次请求。

## 按任务选择

| 涉及的工作 | 先读 | 配套设计或协议 |
| --- | --- | --- |
| 架构、调用表与会话快照 | [architecture.md](architecture.md) | [App Server 协议](../app-server-protocol.md)、[多文件夹项目](../multi-folder-projects.md) |
| 手机端当前工程合同 | [mobile.md](mobile.md) | [手机端开发说明](../../apps/mobile/README.md)、[iroh 节点列表](../iroh-relay-nodes.md) |
| 远程服务、账号与连接资料 | [remote-access.md](remote-access.md) | [App Server 协议](../app-server-protocol.md)、[iroh 节点列表](../iroh-relay-nodes.md)、[手机端当前工程合同](mobile.md) |
| 持久化、转写与用量 | [storage.md](storage.md) | [SQLite 设计与测量](../sqlite-storage.md)、[会话导入格式](../import-from-other-agents.md)、[Pi 引擎模式](../pi-engine-modes.md) |
| 界面、主题与桌面布局 | [ui.md](ui.md) | [转写呈现](transcript.md)、[工作区与媒体](workspace-and-media.md) |
| 工作区、Git、Office 与媒体交付 | [workspace-and-media.md](workspace-and-media.md) | [OfficeCLI 集成与升级验收](../office-officecli.md)、[多文件夹项目](../multi-folder-projects.md) |
| Markdown、代码与图表 | [markdown.md](markdown.md) | [转写呈现](transcript.md)、[界面规范](ui.md) |
| 转写呈现与运行过程 | [transcript.md](transcript.md) | [Markdown 渲染](markdown.md)、[会话生命周期](session-lifecycle.md) |
| 供应商、模型与旁路请求 | [models.md](models.md) | [Pi 引擎模式](../pi-engine-modes.md)、[扩展与 MCP](extensions.md) |
| 扩展、技能、MCP 与工具桥接 | [extensions.md](extensions.md) | [Agent 编排](automation.md)、[会话生命周期](session-lifecycle.md)、[工作区与媒体](workspace-and-media.md) |
| 普通记忆与 Vivi 的补充工程约束 | [memory-and-vivi.md](memory-and-vivi.md) | [普通长期记忆](../memory.md)、[Vivi 当前实现](../vivi-bot-implementation.md)、[Vivi 记忆](../vivi-memory-design.md)、[Vivi DSH 目标](../vivi-architecture.md) |
| 桌面运行环境与应用服务 | [desktop-runtime.md](desktop-runtime.md) | [Agent runtime](../agent-runtime.md)、[引擎进程隔离评估](../engine-utility-process.md) |
| Agent Team、Goal、Todo、定时任务与历史 DAG | [automation.md](automation.md) | [扩展与 MCP](extensions.md)、[会话生命周期](session-lifecycle.md) |
| 会话生命周期、队列与压缩 | [session-lifecycle.md](session-lifecycle.md) | [持久化与恢复](storage.md)、[Agent 编排](automation.md) |
| 开发、依赖、发布与验证资料 | [development.md](development.md) | [发布记录规范](../release/README.md)、[发布技能](../../.agents/skills/release/SKILL.md)、[文档总索引](../README.md) |

## 当前实现、历史资料与设计目标

- 手机端以 [Flutter + Rust FFI / iroh 合同](mobile.md)、[手机 README](../../apps/mobile/README.md) 和 [iroh 节点列表](../iroh-relay-nodes.md) 为当前基线。[远程资料](remote-access.md) 中旧 WebRTC/TURN、密码扫码及旧服务发现章节有单独范围标注；仍保留的 HTTP/WS/SSH 服务端合同不能据此删除。
- [Vivi 当前实现](../vivi-bot-implementation.md)、[Vivi 记忆](../vivi-memory-design.md) 与 [DSH 目标设计](../vivi-architecture.md) 各有明确边界；[补充工程约束](memory-and-vivi.md) 只承接运行时与呈现细节，不另立一套完整架构。
- [SQLite](../sqlite-storage.md)、[OfficeCLI](../office-officecli.md)、[普通记忆](../memory.md)、[导入格式](../import-from-other-agents.md) 与 [Pi 引擎模式](../pi-engine-modes.md) 仍是各自的专项文档。工程合同保留原根文件的接入约束、故障案例与验证入口，修改同一事实时同步相关段落，避免扩写第二套设计。
- 当前独立委派使用 [Agent Team 持久线程](automation.md)；同页的旧 DAG 调度、`subagent` 批量参数及相关测试路径保留为历史资料，不能当成当前内置能力。
- 实测数字、固定上游提交、历史版本和未在真实设备/供应商上验证的限制随原资料保留；它们不是当前测试通过声明。

## 维护方式

修改模块前读所属文档；跨模块修改沿“关联入口”继续阅读，不要求一次读完所有主题。会话 cwd 在仓库根时，子目录规则不会因编辑某个文件自动加载，因此根文件保留显式的任务阅读映射。

新增通用硬规则写根 `AGENTS.md`；模块细节、bug 原因、测量、完整样例和测试解释写所属主题或现有专项文档。新增主题同时更新本页、[文档总索引](../README.md) 和根文件的任务入口。发布记录、数据库迁移和用户数据不属于文档清理对象。
