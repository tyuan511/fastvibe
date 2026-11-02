package dev.fastvibe.mobile

import org.json.JSONObject

/** Sample data transcribed only from design/prototype-standalone.html; no alternate mock source. */
internal object PrototypeData {
    const val NOW = 100_000L
    val devices = listOf(
        DeviceView("mbp", "Yuan 的 MacBook Pro", "macos", "mbp-endpoint", true, path = "direct", onlineKnown = true),
        DeviceView("studio", "工作室 Mac Studio", "macos", "studio-endpoint", true, path = "relay", onlineKnown = true),
        DeviceView("windows", "家里的 Windows", "windows", null, false, lastOnline = "3 小时前", onlineKnown = true),
    )
    val projects = listOf(
        ProjectView("fastvibe", "fastvibe", "~/code/fastvibe"),
        ProjectView("fastvibe-services", "fastvibe-services", "~/code/fastvibe-services"),
    )
    // The reference mentions only this model; it contains no model-picker artwork or options.
    val models = listOf(ModelView("anthropic", "claude-sonnet-4.5"))
    val pending = mapOf(
        "confirm" to PendingUiView(
            "prototype-confirm", "confirm", "允许运行这个命令吗？", "推送后会触发正式发布，无法撤回。\n\n```bash\ngit push origin v0.9.2\n```",
            conversationId = "release",
        ),
        "select" to PendingUiView(
            "prototype-select", "select", "选择发布渠道", "agent 想知道这次推送到哪里。",
            options = listOf(
                PendingOptionView("stable", "正式版", "所有用户会收到更新"),
                PendingOptionView("beta", "测试版", "只推给 beta 渠道"),
                PendingOptionView("prepare", "只准备，不推送", "留在本地，稍后手动发布"),
            ), conversationId = "release",
        ),
        "input" to PendingUiView(
            "prototype-input", "input", "补充 release note 标题", "会写在更新说明的第一行。",
            initialValue = "远程连接更稳定了", conversationId = "release",
        ),
    )

    fun detailId(page: String): String? = when (page) {
        "thread" -> "backpressure"
        "new" -> "new"
        "streaming" -> "pagination"
        "history" -> "native"
        "pending" -> "release"
        else -> null
    }

    private fun conversations(now: Long): List<ConversationView> {
        fun chat(id: String, title: String, subtitle: String, minutes: Long, project: String? = "fastvibe",
                 running: Boolean = false, waiting: Boolean = false, unread: Boolean = false) = ConversationView(
            id, title, project, project, subtitle, now - minutes * 60_000,
            running = running, waiting = waiting, unread = unread,
        )
        return listOf(
            chat("backpressure", "修复远程连接偶发断开", "正在编辑 backpressure.ts…", 0, running = true),
            chat("release", "发布 0.9.2 版本", "要推送 tag v0.9.2 吗？", 2, waiting = true),
            chat("quota", "iroh 中转额度统计", "迁移 00009 已在线上执行。", 12, "fastvibe-services"),
            chat("remote-settings", "设置页的远程访问改版", "已完成，改动了 6 个文件，测试全部通过。", 38, unread = true),
            chat("agents", "整理 AGENTS.md", "把 SQLite 存储那一节拆成了两段。", 1440),
            chat("devices", "设备列表接口加分页", "已停止，可以继续。", 4320, "fastvibe-services"),
            chat("idea", "记录一个新想法", "先整理思路，稍后再关联到项目。", 5760, null),
        )
    }

    fun state(page: String): MobileRuntimeState {
        val id = detailId(page)
        val chats = conversations(System.currentTimeMillis()).toMutableList()
        val extra = when (page) {
            "new" -> ConversationView("new", "新会话", "fastvibe", "fastvibe")
            "streaming" -> ConversationView("pagination", "实现历史分页加载", "fastvibe", "fastvibe", running = true)
            "history" -> ConversationView("native", "讨论 native 移动端设计", "fastvibe", "fastvibe")
            else -> null
        }
        extra?.let { chats += it }
        val workspace = WorkspaceView(
            projects.map { project -> project.copy(conversations = chats.filter { it.projectId == project.id }) },
            chats, id,
        )
        val snapshot = id?.let {
            SnapshotView(
                conversationId = id,
                messages = when (page) {
                    "thread" -> thread
                    "streaming" -> streaming
                    "history" -> history
                    "pending" -> release
                    else -> emptyList()
                },
                historyBeforeEntryId = if (page in listOf("thread", "history")) "prototype-before" else null,
                running = page == "streaming",
                queue = if (page == "streaming") QueueView(listOf(QueueItemView(
                    "prototype-queue", "测试一下，确保滚动加载和快照恢复都没问题",
                ))) else QueueView(),
                pendingUi = if (page == "pending") listOf(pending.getValue("confirm")) else emptyList(),
                turnEvents = emptyList(), overflowed = false, seq = 1,
                model = "anthropic/claude-sonnet-4.5", thinkingLevel = "medium",
            )
        }
        return MobileRuntimeState(
            connection = "connected", path = "direct", endpointId = "8f3c…a91e", deviceId = "mbp",
            conversationId = id, workspace = workspace, snapshot = snapshot, models = models,
            accountUser = "tyuan511", accountEmail = "yuan@example.com", loadingHistory = page == "history",
        )
    }

    private fun args(key: String, value: String) = JSONObject().put(key, value).toString()
    private fun user(id: String, text: String) = MessageView(id, "user", text)
    private fun text(body: String) = PartView("text", body = body)
    private fun tool(id: String) = PartView("tool", toolId = id)

    private val readBackpressure = ToolView(
        "r1", "read", "done", args("path", "src/main/server/backpressure.ts"),
        "export const SOFT_LIMIT = 2 * 1024 * 1024;\nif (ws.bufferedAmount > SOFT_LIMIT) close(4004);",
    )
    private val searchBackpressure = ToolView(
        "r2", "rg", "error", args("pattern", "trackSend src/main/rtc"),
        "rg: src/main/rtc: 没有找到匹配项",
    )
    private val failingTest = ToolView(
        "r3", "bash", "done", args("command", "pnpm test backpressure"),
        "✔ closes a stalled client (31ms)\n✖ keeps a compressed 3 MB burst open\n  expected open, got 4004",
    )
    private val editBackpressure = ToolView(
        "r4", "edit", "done", args("path", "backpressure.ts"),
        "@@ -12,4 +12,6 @@\n- if (ws.bufferedAmount > SOFT_LIMIT) close(4004);\n+ if (ws.bufferedAmount > HARD_LIMIT) return close(4004);\n+ if (ws.bufferedAmount > SOFT_LIMIT) stall.start(GRACE_MS);\n+ else stall.clear();",
    )
    private val passingTest = ToolView(
        "r5", "bash", "done", args("command", "pnpm test backpressure"),
        "✔ closes a stalled client (29ms)\n✔ keeps a compressed 3 MB burst open (42ms)\n✔ expires after grace period without progress (15s)",
    )
    private val thread = listOf(
        MessageView("compact", "assistant", "", parts = listOf(
            PartView("compact", body = "182k → 56k tokens · 自动压缩", compact = CompactView("done", "auto", 182_000, 56_000)),
        )),
        user("thread-user-1", "手机上看长回复时远程连接总会断，错误码 4004。帮我查一下原因。"),
        MessageView("thread-assistant-1", "assistant", "", stop = "aborted", tools = listOf(readBackpressure, searchBackpressure, failingTest), parts = listOf(
            PartView("thinking", body = "4004 是服务端主动断开的慢客户端码。大回复先进 zlib 压缩，bufferedAmount 会把还没压完的字节也算进去，所以瞬时阈值会被一次性的大帧顶爆。先确认阈值和计算方式。", startedAt = 1_000, endedAt = 13_000),
            text("4004 是服务端判定“客户端太慢”时主动断开的。我先看一下背压的实现。"),
            tool("r1"), tool("r2"), tool("r3"),
            text("找到了：`bufferedAmount` 把等待压缩的字节也算了进去，一个 3 MB 的快照后面紧跟一个小事件就会触发断开。"),
        )),
        user("thread-user-2", "继续，把瞬时阈值改成软水位加宽限期，再补一个测试。"),
        MessageView("thread-assistant-2", "assistant", "", runStartedAt = 1_000, completedAt = 99_000, tools = listOf(editBackpressure, passingTest), parts = listOf(
            PartView("model", body = "模型已切换至 claude-sonnet-4.5"),
            PartView("thinking", body = "软水位 2 MiB，宽限 15 秒；一次成功的写回调或净排空 64 KiB 就续期。硬上限 32 MiB 立即停写。", startedAt = 1_000, endedAt = 6_000),
            text("改成软水位：超过 2 MiB 先给 15 秒宽限，期间有写入进展就续期；超过 32 MiB 才立刻断开。"),
            tool("r4"), tool("r5"),
            text("修改完成，测试全部通过。大快照不再触发断开了。"),
        )),
    )

    private val streaming = listOf(
        user("streaming-user", "把历史分页加上吧，参考桌面端的实现。"),
        MessageView("streaming-assistant", "assistant", "", runStartedAt = NOW - 18_000, tools = listOf(
            ToolView("r7", "read", "done", args("path", "src/shared/transcript-page.ts"),
                "export type MessagesPageRequest = {\n  conversationId: string;\n  beforeEntryId: string;\n  turnLimit?: number;\n};"),
            ToolView("r8", "rg", "running", args("pattern", "get-messages-page src/main"), "… 搜索中"),
        ), parts = listOf(
            PartView("thinking", body = "桌面端用 engine:get-messages-page，带 beforeEntryId 和 turnLimit。移动端需要先请求初始快照带 historyLimit，然后老消息滚到顶时调分页接口，把结果 prepend 到本地窗口前面。要处理 reset: true 的情况——那是分支编辑后要替换当前窗口。", startedAt = 1_000, endedAt = 7_000),
            tool("r7"), tool("r8"),
        )),
    )

    private val history = listOf(
        user("history-user-1", "SwiftUI 和 Compose 的共同点是什么？"),
        MessageView("history-assistant-1", "assistant", "两者都是声明式 UI 框架，用状态驱动视图更新……"),
        user("history-user-2", "那 Rust core 要暴露什么样的状态接口？"),
        MessageView("history-assistant-2", "assistant", "", tools = listOf(
            ToolView("r6", "edit", "done", args("path", "apps/mobile/core/src/lib.rs"),
                "@@ -156,0 +157,48 @@\n+ #[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]\n+ pub struct MobileState {\n+     pub connection_status: String,\n+     pub messages: Vec<ChatMessage>,\n+     pub queue: QueueState,\n+     pub pending_ui: Vec<serde_json::Value>,\n+     pub overflowed: bool,\n+ }"),
        ), parts = listOf(
            text("建议用 JSON 状态快照加增量事件。Core 维护一个 `MobileState`，每次变化生成 JSON。"),
            tool("r6"),
        )),
    )

    private val release = listOf(
        user("release-user", "版本号和 release note 都准备好了就发布吧。"),
        MessageView("release-assistant", "assistant", "", tools = listOf(
            ToolView("release-push", "bash", "pending", args("command", "git push origin v0.9.2")),
        ), parts = listOf(
            text("版本号已改成 0.9.2，中英文 release note 写好了。下一步需要推送 tag 触发 CI。"),
            tool("release-push"),
        )),
    )
}
