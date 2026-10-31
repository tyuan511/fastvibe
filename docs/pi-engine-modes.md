# Pi 引擎模式

FastVibe 的内嵌 pi SDK 支持两种配置来源，切换入口在 设置 → 关于 → 引擎：

- **使用隔离 pi**（默认）：模型、鉴权、MCP、插件和技能配置保存在 FastVibe 的运行目录；会话转写和 FastVibe 的队列、检查点等数据始终保存在 FastVibe 数据目录。
- **使用全局 pi**：直接使用 `PI_CODING_AGENT_DIR` 指定的目录，未指定时使用 `~/.pi/agent`。pi 的 `models.json`、`auth.json`、`settings.json`、`mcp.json`、插件、技能和包由 FastVibe 与 pi 共享。

切换前必须没有运行中的会话、等待中的插件问题或子 Agent。迁移先备份目标配置，再迁移模型、鉴权、默认模型、MCP 与资源目录，最后写入模式标记并重启应用。当前会话、会话目录、SQLite 数据、队列、检查点、DAG 和定时任务不随配置模式搬动。

全局模式下供应商编辑使用 pi 的模型和鉴权文件，并保留未被编辑的字段；MCP 保存为 pi 的 `mcpServers` 格式。切回隔离模式时，全局 pi 的配置转换回 FastVibe 的供应商、OAuth 和 MCP 格式。迁移不会删除源目录，目标目录的原内容保存在 `engine-backups/` 下。
