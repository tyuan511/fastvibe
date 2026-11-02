package dev.fastvibe.mobile

import org.json.JSONArray
import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import java.time.Instant

class RuntimeModelsTest {
    @Test
    fun preservesMeasuredThinkingCompactionAndTerminalMetadata() {
        val messages = parseMessages(JSONArray("""
            [{
              "id":"reply","role":"assistant","text":"done",
              "createdAt":1000,"completedAt":99000,"runStartedAt":1000,
              "kind":"message","stop":"aborted","stopCause":"repetition",
              "compact":{"status":"done","reason":"threshold","tokensBefore":182000,"tokensAfter":56000},
              "parts":[
                {"kind":"thinking","text":"reasoning","startedAt":2000,"endedAt":14000},
                {"kind":"compact","text":"summary","compact":{"status":"cancelled","reason":"manual","error":"cancelled"}},
                {"kind":"model","from":{"provider":"p","model":"old"},"to":{"provider":"p","model":"new"}}
              ]
            }]
        """.trimIndent())).single()

        assertEquals(1000L, messages.runStartedAt)
        assertEquals(99000L, messages.completedAt)
        assertEquals("message", messages.kind)
        assertEquals("aborted", messages.stop)
        assertEquals("repetition", messages.stopCause)
        assertEquals(2000L, messages.parts[0].startedAt)
        assertEquals(14000L, messages.parts[0].endedAt)
        assertEquals(CompactView("done", "threshold", 182000L, 56000L), messages.compact)
        assertEquals(CompactView("cancelled", "manual", error = "cancelled"), messages.parts[1].compact)
        assertEquals("模型已切换至 p/new", messages.parts[2].body)
    }

    @Test
    fun absentTranscriptMetadataRemainsUnknownAndOpenThinkingHasNoEnd() {
        val messages = parseMessages(JSONArray("""
            [{"id":"live","role":"assistant","text":"","parts":[
              {"kind":"thinking","text":"still working","startedAt":2000}
            ]}]
        """.trimIndent())).single()

        assertNull(messages.runStartedAt)
        assertNull(messages.completedAt)
        assertNull(messages.kind)
        assertNull(messages.stop)
        assertNull(messages.stopCause)
        assertNull(messages.compact)
        assertEquals(2000L, messages.parts.single().startedAt)
        assertNull(messages.parts.single().endedAt)
        assertNull(messages.parts.single().compact)
    }

    @Test
    fun accountEmailComesFromTheRealAccountUser() {
        val state = parseRuntimeState(JSONObject("""
            {"account":{"user":{"login":"developer","email":"developer@example.com"}}}
        """.trimIndent()))
        assertEquals("developer", state.accountUser)
        assertEquals("developer@example.com", state.accountEmail)
        assertNull(parseRuntimeState(JSONObject("""{"account":{"user":{"login":"developer"}}}""")).accountEmail)
    }

    @Test
    fun parsesCoreSnapshotShapesAndSessionState() {
        val snapshot = JSONObject()
            .put("conversationId", "conversation-1")
            .put(
                "history",
                JSONObject().put("beforeEntryId", "entry-before"),
            )
            .put("running", true)
            .put(
                "queue",
                JSONObject()
                    .put("revision", 7)
                    .put("pause", "error")
                    .put(
                        "items",
                        JSONArray().put(
                            JSONObject()
                                .put("id", "queue-1")
                                .put("conversationId", "conversation-1")
                                .put("text", "继续修复")
                                .put("behavior", "followUp")
                                .put("sending", true)
                                .put("images", JSONArray().put(JSONObject().put("type", "image"))),
                        ),
                    ),
            )
            .put(
                "messages",
                JSONArray().put(
                    JSONObject()
                        .put("id", "message-1")
                        .put("role", "assistant")
                        .put("text", "已写入 [报告](fvpath:%2Ftmp%2Freport.md)")
                        .put("createdAt", 1_700_000_000_000L)
                        .put(
                            "parts",
                            JSONArray()
                                .put(JSONObject().put("kind", "text").put("text", "先检查文件"))
                                .put(JSONObject().put("kind", "tool").put("toolId", "tool-1")),
                        )
                        .put(
                            "tools",
                            JSONArray().put(
                                JSONObject()
                                    .put("id", "tool-1")
                                    .put("name", "write_file")
                                    .put("status", "done")
                                    .put("args", JSONObject().put("path", "report.md").put("content", "ok"))
                                    .put("result", "written")
                                    .put("details", JSONObject().put("changed", true)),
                            ),
                        ),
                ),
            )
            .put("pendingUi", JSONArray())
            .put("turnEvents", JSONArray().put(JSONObject().put("type", "notice").put("message", "完成")))
            .put("overflowed", false)
            .put("seq", 22)

        val state = JSONObject()
            .put("connection", "ready")
            .put("conversationId", "conversation-1")
            .put("snapshot", snapshot)
            .put(
                "sessionState",
                JSONObject()
                    .put("model", JSONObject().put("provider", "fastvibe").put("model", "vivi-1"))
                    .put("thinkingLevel", "high")
                    .put("canResume", true),
            )

        val parsed = parseRuntimeState(state)
        val result = requireNotNull(parsed.snapshot)
        val message = result.messages.single()
        val tool = message.tools.single()

        assertEquals("connected", parsed.connection)
        assertEquals("entry-before", result.historyBeforeEntryId)
        assertEquals("error", result.queue.pause)
        assertTrue(result.queue.paused)
        assertEquals(1, result.queue.items.single().images)
        assertEquals("fastvibe/vivi-1", result.model)
        assertEquals("high", result.thinkingLevel)
        assertEquals(true, result.canResume)
        assertEquals("{\"path\":\"report.md\",\"content\":\"ok\"}", tool.args)
        assertEquals("written", tool.result)
        assertEquals("{\"changed\":true}", tool.details)
        assertEquals(setOf("report.md", "/tmp/report.md"), message.outputs.map { it.path }.toSet())
        assertTrue(message.parts.any { it.kind == "tool" && it.toolId == "tool-1" })
        assertEquals(listOf("完成"), result.turnEvents)
    }

    @Test
    fun pendingUiUsesBlockingMethodAndActiveConversation() {
        val requests = JSONArray()
            .put(
                JSONObject()
                    .put("id", "confirm-1")
                    .put("conversationId", "conversation-1")
                    .put("method", "confirm")
                    .put("title", "确认")
                    .put("message", "继续吗？"),
            )
            .put(
                JSONObject()
                    .put("id", "select-1")
                    .put("conversationId", "conversation-1")
                    .put("method", "select")
                    .put("title", "选择")
                    .put("options", JSONArray().put("one").put("two"))
                    .put(
                        "optionDetails",
                        JSONArray().put(JSONObject().put("description", "第一个")).put(JSONObject().put("description", "第二个")),
                    ),
            )
            .put(
                JSONObject()
                    .put("id", "questions-1")
                    .put("conversationId", "conversation-1")
                    .put("method", "questions")
                    .put(
                        "questions",
                        JSONArray().put(
                            JSONObject()
                                .put("question", "部署到哪里？")
                                .put("header", "环境")
                                .put("options", JSONArray().put("staging").put("production"))
                                .put("optionDetails", JSONArray().put(JSONObject().put("description", "测试")).put(JSONObject().put("description", "生产")))
                                .put("allowOther", true),
                        ),
                    ),
            )
            .put(
                JSONObject()
                    .put("id", "editor-1")
                    .put("conversationId", "conversation-1")
                    .put("method", "editor")
                    .put("prefill", "已有内容"),
            )
            .put(
                JSONObject()
                    .put("id", "other-chat")
                    .put("conversationId", "conversation-2")
                    .put("method", "confirm"),
            )
            .put(
                JSONObject()
                    .put("id", "notify-1")
                    .put("conversationId", "conversation-1")
                    .put("method", "notify"),
            )

        val parsed = parsePendingUi(requests, "conversation-1")

        assertEquals(listOf("confirm", "select", "questions", "editor"), parsed.map { it.type })
        assertEquals(listOf("one", "two"), parsed[1].options.map { it.value })
        assertEquals("第二个", parsed[1].options[1].detail)
        assertEquals("已有内容", parsed[3].initialValue)
        assertEquals("部署到哪里？", parsed[2].questions.single().label)
        assertEquals("staging", parsed[2].questions.single().options[0].value)
        assertEquals("生产", parsed[2].questions.single().options[1].detail)
        assertTrue(parsed[2].questions.single().allowOther)
    }

    @Test
    fun parseModelsAcceptsArrayOrObjectAndKeepsThinkingLevels() {
        val models = JSONArray()
            .put(
                JSONObject()
                    .put("provider", "openai")
                    .put("id", "gpt-5")
                    .put("name", "GPT-5")
                    .put("thinkingLevels", JSONArray().put("low").put("high")),
            )
            .put(JSONObject().put("provider", "anthropic").put("model", "claude-sonnet"))

        assertEquals(listOf("low", "high"), parseModels(models).first().thinkingLevels)
        assertEquals("claude-sonnet", parseModels(JSONObject().put("result", models))[1].id)
        assertTrue(parseModels(JSONObject().put("result", "not-models")).isEmpty())
    }

    @Test
    fun ignoresSessionStateForAnotherConversation() {
        val snapshot = JSONObject()
            .put("conversationId", "conversation-2")
            .put("messages", JSONArray())
            .put("pendingUi", JSONArray())
        val state = JSONObject()
            .put("snapshot", snapshot)
            .put(
                "sessionState",
                JSONObject()
                    .put("conversationId", "conversation-1")
                    .put("model", JSONObject().put("provider", "old").put("model", "model"))
                    .put("thinkingLevel", "high")
                    .put("canResume", true),
            )

        val parsed = requireNotNull(parseRuntimeState(state).snapshot)

        assertNull(parsed.model)
        assertNull(parsed.thinkingLevel)
        assertNull(parsed.canResume)
    }

    @Test
    fun normalizesTransportStatusesUntilWelcomeIsValidated() {
        assertEquals("connecting", parseRuntimeState(JSONObject().put("connection", "connected")).connection)
        assertEquals("connecting", parseRuntimeState(JSONObject().put("connection", "handshaking")).connection)
        assertEquals("connected", parseRuntimeState(JSONObject().put("connection", "ready")).connection)
        assertEquals("connecting", parseRuntimeState(JSONObject().put("connection", "connecting")).connection)
    }

    @Test
    fun parsesIsoCatalogTimesAndDoesNotInferDevicePresence() {
        val timestamp = Instant.parse("2025-01-02T03:04:05Z").toEpochMilli()
        val conversations = parseConversations(
            JSONArray().put(
                JSONObject()
                    .put("id", "c1")
                    .put("title", "时间")
                    .put("updatedAt", "2025-01-02T03:04:05Z"),
            ),
        )
        assertEquals(timestamp, conversations.single().updatedAt)

        val devices = parseDevices(
            JSONArray()
                .put(JSONObject().put("id", "d1").put("irohEndpointId", "endpoint-1"))
                .put(JSONObject().put("id", "d2").put("online", false)),
        )
        assertFalse(devices[0].online)
        assertFalse(devices[0].onlineKnown)
        assertFalse(devices[1].online)
        assertTrue(devices[1].onlineKnown)
        assertNull(devices[0].lastOnline)
    }
}
