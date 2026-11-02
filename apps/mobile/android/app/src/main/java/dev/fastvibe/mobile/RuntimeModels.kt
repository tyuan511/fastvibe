package dev.fastvibe.mobile

import org.json.JSONArray
import org.json.JSONObject
import java.net.URI
import java.net.URLDecoder
import java.nio.charset.StandardCharsets
import java.time.Instant
import java.text.DateFormat
import java.util.Date
import java.util.Locale

internal data class DeviceView(
    val id: String,
    val name: String,
    val platform: String,
    val endpointId: String?,
    val online: Boolean,
    val path: String? = null,
    val lastOnline: String? = null,
    val onlineKnown: Boolean = false,
)

internal data class ProjectView(
    val id: String,
    val name: String,
    val cwd: String? = null,
    val conversations: List<ConversationView> = emptyList(),
)

internal data class ConversationView(
    val id: String,
    val title: String,
    val projectId: String? = null,
    val projectName: String? = null,
    val subtitle: String = "",
    val updatedAt: Long? = null,
    val running: Boolean = false,
    val waiting: Boolean = false,
    val unread: Boolean = false,
    val archived: Boolean = false,
)

internal data class ToolView(
    val id: String,
    val name: String,
    val status: String,
    val args: String? = null,
    val result: String? = null,
    val details: String? = null,
)

internal data class OutputView(
    val path: String,
    val name: String,
    val size: Long? = null,
    val mimeType: String? = null,
)

internal data class PartView(
    val kind: String,
    val title: String = "",
    val body: String = "",
    val toolId: String? = null,
    val outputs: List<OutputView> = emptyList(),
)

internal data class MessageView(
    val id: String,
    val role: String,
    val text: String,
    val thinking: String? = null,
    val tools: List<ToolView> = emptyList(),
    val parts: List<PartView> = emptyList(),
    val error: String? = null,
    val createdAt: Long = 0L,
    val completedAt: Long? = null,
    val outputs: List<OutputView> = emptyList(),
)

internal data class QueueItemView(
    val id: String,
    val text: String,
    val status: String = "queued",
    val images: Int = 0,
)

internal data class QueueView(
    val items: List<QueueItemView> = emptyList(),
    val paused: Boolean = false,
    val revision: Long = 0L,
    val pause: String? = null,
)

internal data class PendingOptionView(
    val value: String,
    val label: String,
    val detail: String? = null,
)

internal data class PendingQuestionView(
    val id: String,
    val label: String,
    val type: String = "input",
    val options: List<PendingOptionView> = emptyList(),
    val placeholder: String? = null,
    val required: Boolean = false,
    val allowOther: Boolean = false,
)

internal data class PendingUiView(
    val id: String,
    val type: String,
    val title: String,
    val message: String,
    val options: List<PendingOptionView> = emptyList(),
    val questions: List<PendingQuestionView> = emptyList(),
    val placeholder: String? = null,
    val initialValue: String = "",
    val multiline: Boolean = false,
    val conversationId: String? = null,
)

internal data class SnapshotView(
    val conversationId: String?,
    val messages: List<MessageView>,
    val historyBeforeEntryId: String?,
    val running: Boolean,
    val queue: QueueView,
    val pendingUi: List<PendingUiView>,
    val turnEvents: List<String>,
    val overflowed: Boolean,
    val seq: Long,
    val model: String? = null,
    val thinkingLevel: String? = null,
    val canResume: Boolean? = null,
)

internal data class ModelView(
    val provider: String,
    val id: String,
    val name: String = id,
    val thinkingLevels: List<String> = emptyList(),
)

internal data class WorkspaceView(
    val projects: List<ProjectView> = emptyList(),
    val conversations: List<ConversationView> = emptyList(),
    val activeConversationId: String? = null,
)

internal data class MobileRuntimeState(
    val connection: String = "disconnected",
    val path: String? = null,
    val endpointId: String? = null,
    val deviceId: String? = null,
    val conversationId: String? = null,
    val error: String? = null,
    val workspace: WorkspaceView = WorkspaceView(),
    val snapshot: SnapshotView? = null,
    val models: List<ModelView> = emptyList(),
    val pendingRequests: Int = 0,
    val accountUser: String? = null,
    val accountOrigin: String? = null,
    val loadingHistory: Boolean = false,
)

internal data class ImageAttachment(val data: String, val mimeType: String, val name: String)

internal fun JSONObject.stringOrNull(vararg keys: String): String? {
    for (key in keys) {
        if (!has(key) || isNull(key)) continue
        optString(key).takeIf { it.isNotBlank() && it != "null" }?.let { return it }
    }
    return null
}

internal fun JSONObject.longOrNull(vararg keys: String): Long? {
    for (key in keys) {
        if (!has(key) || isNull(key)) continue
        when (val value = opt(key)) {
            is Number -> return value.toLong()
            is String -> {
                value.toLongOrNull()?.let { return it }
                runCatching { Instant.parse(value).toEpochMilli() }
                    .getOrNull()
                    ?.takeIf { it > 0L }
                    ?.let { return it }
            }
        }
    }
    return null
}

internal fun JSONObject.booleanOrNull(vararg keys: String): Boolean? {
    for (key in keys) {
        if (!has(key) || isNull(key)) continue
        when (val value = opt(key)) {
            is Boolean -> return value
            is String -> when (value.lowercase(Locale.US)) {
                "true" -> return true
                "false" -> return false
            }
        }
    }
    return null
}

internal fun JSONObject.objectOrNull(vararg keys: String): JSONObject? {
    for (key in keys) optJSONObject(key)?.let { return it }
    return null
}

internal fun JSONObject.arrayOrNull(vararg keys: String): JSONArray? {
    for (key in keys) optJSONArray(key)?.let { return it }
    return null
}

internal fun JSONObject.jsonText(vararg keys: String): String? {
    for (key in keys) {
        if (!has(key) || isNull(key)) continue
        val value = opt(key)
        if (value == null || value == JSONObject.NULL) continue
        value.toString().takeIf { it.isNotBlank() && it != "null" }?.let { return it }
    }
    return null
}

internal fun parseWorkspace(raw: JSONObject?): WorkspaceView {
    if (raw == null) return WorkspaceView()
    val workspace = raw.objectOrNull("workspace", "catalog") ?: raw
    val conversations = workspace.arrayOrNull("conversations", "items", "results")
        ?.let(::parseConversations)
        .orEmpty()
    val projects = workspace.arrayOrNull("projects", "groups")
        ?.let { parseProjects(it) }
        .orEmpty()
    val joined = if (projects.isNotEmpty()) {
        val byProject = conversations.groupBy { it.projectId }
        projects.map { project ->
            if (project.conversations.isNotEmpty()) project
            else project.copy(conversations = byProject[project.id].orEmpty())
        }
    } else {
        groupConversations(conversations)
    }
    val activeId = workspace.stringOrNull("activeId", "activeConversationId", "conversationId")
    return WorkspaceView(joined, conversations, activeId)
}

private fun parseProjects(array: JSONArray): List<ProjectView> = buildList {
    for (index in 0 until array.length()) {
        val item = array.optJSONObject(index) ?: continue
        val cwd = item.stringOrNull("cwd", "path")
        val id = item.stringOrNull("id", "projectId") ?: cwd ?: "project-$index"
        val name = item.stringOrNull("name", "title", "label")
            ?: cwd?.substringAfterLast('/')
            ?: id
        val nested = item.arrayOrNull("conversations", "items")
            ?.let(::parseConversations)
            .orEmpty()
        add(ProjectView(id, name, cwd, nested))
    }
}

private fun groupConversations(conversations: List<ConversationView>): List<ProjectView> {
    return conversations
        .groupBy { it.projectId ?: "__unassigned__" }
        .map { (key, values) ->
            val name = values.firstNotNullOfOrNull { it.projectName }
                .orEmpty()
                .ifBlank { "未归属项目" }
            ProjectView(key, name, conversations = values)
        }
}

internal fun parseConversations(array: JSONArray): List<ConversationView> = buildList {
    for (index in 0 until array.length()) {
        val item = array.optJSONObject(index) ?: continue
        val id = item.stringOrNull("id", "conversationId", "conversation_id") ?: continue
        val project = item.opt("project")
        val projectId = item.stringOrNull("project", "projectId", "project_id")
            ?: (project as? JSONObject)?.stringOrNull("id", "cwd")
            ?: project as? String
        val projectName = item.stringOrNull("projectName", "project_name")
            ?: (project as? JSONObject)?.stringOrNull("name", "title")
        val lastMessage = item.objectOrNull("lastMessage", "last_message")
        val subtitle = item.stringOrNull("preview", "subtitle", "lastText", "last_text")
            ?: lastMessage?.stringOrNull("text", "content")
            .orEmpty()
        add(
            ConversationView(
                id = id,
                title = item.stringOrNull("title", "name") ?: "未命名会话",
                projectId = projectId,
                projectName = projectName,
                subtitle = subtitle,
                updatedAt = item.longOrNull(
                    "updatedAt",
                    "updated_at",
                    "lastActivityAt",
                    "last_activity_at",
                    "createdAt",
                    "created_at",
                ),
                running = item.booleanOrNull("running", "isRunning") ?: false,
                waiting = item.booleanOrNull("waiting", "pending", "needsInput", "needs_input") ?: false,
                unread = item.booleanOrNull("unread", "hasUnread") ?: false,
                archived = item.booleanOrNull("archived", "isArchived") ?: false,
            ),
        )
    }
}

internal fun parseSnapshot(
    raw: JSONObject?,
    fallbackConversationId: String? = null,
    sessionState: JSONObject? = null,
): SnapshotView? {
    val snapshot = raw?.objectOrNull("snapshot", "conversationSnapshot") ?: raw ?: return null
    if (!snapshot.has("messages") && !snapshot.has("queue") &&
        !snapshot.has("pendingUi") && !snapshot.has("pendingUI")
    ) return null

    val conversationId = snapshot.stringOrNull("conversationId", "conversation_id")
        ?: fallbackConversationId
    val embeddedSessionState = snapshot.objectOrNull("sessionState", "session_state")
    val session = (sessionState ?: embeddedSessionState)?.takeIf { candidate ->
        val sessionConversationId = candidate.stringOrNull("conversationId", "conversation_id")
        sessionConversationId == null || sessionConversationId == conversationId
    }
    val history = snapshot.objectOrNull("history")
    val historyBefore = history?.stringOrNull("beforeEntryId", "before_entry_id")
        ?: snapshot.stringOrNull("historyBeforeEntryId", "history_before_entry_id")
    val model = modelLabel(snapshot.opt("model"))
        ?: snapshot.stringOrNull("modelId", "model_id")
        ?: modelLabel(session?.opt("model"))
    val thinkingLevel = snapshot.stringOrNull("thinkingLevel", "thinking_level")
        ?: session?.stringOrNull("thinkingLevel", "thinking_level")
    val canResume = snapshot.booleanOrNull("canResume", "can_resume")
        ?: session?.booleanOrNull("canResume", "can_resume")

    return SnapshotView(
        conversationId = conversationId,
        messages = snapshot.arrayOrNull("messages")?.let(::parseMessages).orEmpty(),
        historyBeforeEntryId = historyBefore,
        running = snapshot.booleanOrNull("running", "isRunning") ?: false,
        queue = parseQueue(snapshot.objectOrNull("queue")),
        pendingUi = snapshot.arrayOrNull("pendingUi", "pendingUI")
            ?.let { parsePendingUi(it, conversationId) }
            .orEmpty(),
        turnEvents = parseTurnEvents(snapshot.arrayOrNull("turnEvents", "turn_events")),
        overflowed = snapshot.booleanOrNull("overflowed") ?: false,
        seq = snapshot.longOrNull("seq") ?: 0L,
        model = model,
        thinkingLevel = thinkingLevel,
        canResume = canResume,
    )
}

private fun parseTurnEvents(array: JSONArray?): List<String> = buildList {
    if (array == null) return@buildList
    for (index in 0 until array.length()) {
        val value = array.opt(index)
        val text = when (value) {
            is JSONObject -> value.stringOrNull("message", "text", "detail", "type")
            is String -> value
            else -> null
        }
        if (!text.isNullOrBlank()) add(text)
    }
}

internal fun parseQueue(raw: JSONObject?): QueueView {
    if (raw == null) return QueueView()
    val pause = raw.stringOrNull("pause", "pauseReason", "pause_reason")
    val paused = pause != null || raw.booleanOrNull("paused") == true
    val items = raw.arrayOrNull("items", "messages")
        ?.let(::parseQueueItems)
        .orEmpty()
    return QueueView(
        items = items,
        paused = paused,
        revision = raw.longOrNull("revision") ?: 0L,
        pause = pause,
    )
}

private fun parseQueueItems(array: JSONArray): List<QueueItemView> = buildList {
    for (index in 0 until array.length()) {
        val item = array.optJSONObject(index) ?: continue
        val claimed = item.booleanOrNull("claimed") == true
        val sending = item.booleanOrNull("sending") == true
        add(
            QueueItemView(
                id = item.stringOrNull("id", "queueId", "queue_id") ?: "queue-$index",
                text = item.stringOrNull("text", "content", "prompt").orEmpty(),
                status = item.stringOrNull("status")
                    ?: if (claimed || sending) "sending" else "queued",
                images = imageCount(item.arrayOrNull("images", "attachments")),
            ),
        )
    }
}

private fun imageCount(array: JSONArray?): Int {
    if (array == null) return 0
    var count = 0
    for (index in 0 until array.length()) {
        val item = array.optJSONObject(index)
        if (item == null || item.stringOrNull("kind", "type") == "image") count++
    }
    return count
}

internal fun parseMessages(array: JSONArray): List<MessageView> = buildList {
    for (index in 0 until array.length()) {
        val item = array.optJSONObject(index) ?: continue
        val tools = item.arrayOrNull("tools")?.let(::parseTools).orEmpty()
        val directParts = item.arrayOrNull("parts")
            ?.let { partsArray -> parseParts(partsArray, tools) }
            .orEmpty()
        val outputs = mergeOutputs(
            item.arrayOrNull("outputs", "files", "outputFiles")?.let(::parseOutputs).orEmpty(),
            deriveOutputs(item, tools),
        )
        val text = item.stringOrNull("text").orEmpty()
        val thinking = item.stringOrNull("thinking")
        val parts = partsForDisplay(directParts, text, thinking, tools, outputs)
        add(
            MessageView(
                id = item.stringOrNull("id", "messageId", "message_id") ?: "message-$index",
                role = item.stringOrNull("role") ?: "assistant",
                text = text,
                thinking = thinking,
                tools = tools,
                parts = parts,
                error = item.stringOrNull("error"),
                createdAt = item.longOrNull("createdAt", "created_at") ?: 0L,
                completedAt = item.longOrNull("completedAt", "completed_at"),
                outputs = outputs,
            ),
        )
    }
}

private fun parseParts(array: JSONArray, tools: List<ToolView>): List<PartView> = buildList {
    for (index in 0 until array.length()) {
        val part = array.optJSONObject(index) ?: continue
        add(parsePart(part, tools))
    }
}

private fun partsForDisplay(
    parsed: List<PartView>,
    text: String,
    thinking: String?,
    tools: List<ToolView>,
    outputs: List<OutputView>,
): List<PartView> {
    if (outputs.isEmpty()) return parsed
    if (parsed.isNotEmpty()) {
        return if (parsed.any { it.kind == "output" }) parsed
        else parsed + PartView("output", "产出文件", outputs = outputs)
    }
    val fallback = buildList {
        if (thinking.orEmpty().isNotBlank()) add(PartView("thinking", "思考", thinking.orEmpty()))
        if (text.isNotBlank()) add(PartView("text", body = text))
        tools.forEach { add(PartView("tool", "工具 · ${it.name}", toolId = it.id)) }
        add(PartView("output", "产出文件", outputs = outputs))
    }
    return fallback
}

private fun parseTools(array: JSONArray): List<ToolView> = buildList {
    for (index in 0 until array.length()) {
        val item = array.optJSONObject(index) ?: continue
        add(
            ToolView(
                id = item.stringOrNull("id", "toolCallId", "tool_call_id") ?: "tool-$index",
                name = item.stringOrNull("name") ?: "工具",
                status = item.stringOrNull("status") ?: "running",
                args = item.jsonText("args", "arguments"),
                result = item.jsonText("result", "output"),
                details = item.jsonText("details"),
            ),
        )
    }
}

private fun parsePart(part: JSONObject, tools: List<ToolView>): PartView {
    val kind = part.stringOrNull("kind", "type") ?: "text"
    return when (kind) {
        "text" -> PartView(kind, body = part.stringOrNull("text").orEmpty())
        "tool" -> {
            val id = part.stringOrNull("toolId", "tool_id")
            val tool = tools.firstOrNull { it.id == id }
            PartView(kind, "工具 · ${tool?.name ?: id.orEmpty()}", toolId = id)
        }
        "thinking" -> PartView(kind, "思考", part.stringOrNull("text").orEmpty())
        "model" -> {
            val from = modelLabel(part.opt("from"))
            val to = modelLabel(part.opt("to"))
            PartView(kind, "模型切换", listOfNotNull(from, to).joinToString(" → "))
        }
        "compact" -> PartView(kind, "上下文压缩", part.stringOrNull("text").orEmpty())
        else -> PartView(kind, body = part.stringOrNull("text", "content").orEmpty())
    }
}

private fun parseOutputs(array: JSONArray): List<OutputView> = buildList {
    for (index in 0 until array.length()) {
        val value = array.opt(index)
        val path = when (value) {
            is JSONObject -> value.stringOrNull("path", "relativePath", "relative_path", "ref", "source")
            is String -> value
            else -> null
        }
        val localPath = path?.let(::localPathOrNull) ?: continue
        val item = value as? JSONObject
        add(
            OutputView(
                path = localPath,
                name = item?.stringOrNull("name", "filename", "title") ?: fileName(localPath),
                size = item?.longOrNull("size", "bytes"),
                mimeType = item?.stringOrNull("mimeType", "mime_type", "type"),
            ),
        )
    }
}

private val WRITE_TOOL = Regex("^(write|write_file|writefile|create_file|createfile|create)$", RegexOption.IGNORE_CASE)
private val EDIT_TOOL = Regex("^(edit|edit_file|editfile|apply_patch|applypatch|patch|str_replace|strreplace)$", RegexOption.IGNORE_CASE)
private val MARKDOWN_LOCAL_LINK = Regex("\\]\\((file://[^)\\s]+|fvpath:[^)\\s]+)\\)")
private val OUTPUT_PATH_KEYS = arrayOf("path", "file_path", "filePath", "filename", "file", "target_file", "target")

private fun deriveOutputs(message: JSONObject, tools: List<ToolView>): List<OutputView> {
    val byPath = linkedMapOf<String, OutputView>()
    fun add(path: String?, metadata: JSONObject? = null) {
        val localPath = path?.let(::localPathOrNull) ?: return
        if (byPath.containsKey(localPath)) return
        byPath[localPath] = OutputView(
            path = localPath,
            name = metadata?.stringOrNull("name", "filename", "title") ?: fileName(localPath),
            size = metadata?.longOrNull("size", "bytes"),
            mimeType = metadata?.stringOrNull("mimeType", "mime_type", "type"),
        )
    }

    val rawTools = message.arrayOrNull("tools")
    if (rawTools != null) {
        for (index in 0 until rawTools.length()) {
            val tool = rawTools.optJSONObject(index) ?: continue
            if (tool.stringOrNull("status") != "done") continue
            val name = tool.stringOrNull("name").orEmpty()
            if (WRITE_TOOL.matches(name) || EDIT_TOOL.matches(name)) {
                val args = tool.objectOrNull("args", "arguments")
                add(OUTPUT_PATH_KEYS.firstNotNullOfOrNull { args?.stringOrNull(it) })
            }
            if (name == "present") {
                val items = tool.objectOrNull("details")?.arrayOrNull("items")
                if (items != null) {
                    for (itemIndex in 0 until items.length()) {
                        val item = items.optJSONObject(itemIndex) ?: continue
                        if (item.booleanOrNull("ok") == false) continue
                        add(item.stringOrNull("ref"), item)
                    }
                }
            }
        }
    }

    val text = message.stringOrNull("text").orEmpty()
    for (match in MARKDOWN_LOCAL_LINK.findAll(text)) add(match.groupValues[1])
    return byPath.values.toList()
}

private fun mergeOutputs(first: List<OutputView>, second: List<OutputView>): List<OutputView> {
    val result = linkedMapOf<String, OutputView>()
    (first + second).forEach { result.putIfAbsent(it.path, it) }
    return result.values.toList()
}

private fun localPathOrNull(value: String): String? {
    val path = value.trim()
    if (path.isBlank() || path.startsWith("data:", ignoreCase = true) ||
        path.startsWith("http://", ignoreCase = true) || path.startsWith("https://", ignoreCase = true)
    ) return null
    return runCatching {
        when {
            path.startsWith("file://", ignoreCase = true) -> URI(path).path
            path.startsWith("fvpath:", ignoreCase = true) ->
                URLDecoder.decode(path.substringAfter(':'), StandardCharsets.UTF_8.name())
            else -> path
        }
    }.getOrNull()?.takeIf { it.isNotBlank() }
}

private fun fileName(path: String): String = path.substringAfterLast('/').substringAfterLast('\\').ifBlank { path }

internal fun parsePendingUi(array: JSONArray, activeConversationId: String? = null): List<PendingUiView> = buildList {
    for (index in 0 until array.length()) {
        val item = array.optJSONObject(index) ?: continue
        val method = item.stringOrNull("method") ?: continue
        if (method !in BLOCKING_UI_METHODS) continue
        val conversationId = item.stringOrNull("conversationId", "conversation_id")
        if (activeConversationId != null && conversationId != activeConversationId) continue
        add(
            PendingUiView(
                id = item.stringOrNull("id", "requestId", "request_id") ?: "pending-$index",
                type = method,
                title = item.stringOrNull("title") ?: "需要你的操作",
                message = item.stringOrNull("message") ?: "",
                options = parseOptions(item.arrayOrNull("options"), item.arrayOrNull("optionDetails")),
                questions = parseQuestions(item.arrayOrNull("questions")),
                placeholder = item.stringOrNull("placeholder"),
                initialValue = item.stringOrNull("prefill").orEmpty(),
                multiline = method == "editor" || method == "input" && item.booleanOrNull("multiline") == true,
                conversationId = conversationId,
            ),
        )
    }
}

private val BLOCKING_UI_METHODS = setOf("confirm", "select", "input", "editor", "questions")

private fun parseOptions(options: JSONArray?, details: JSONArray? = null): List<PendingOptionView> = buildList {
    if (options == null) return@buildList
    for (index in 0 until options.length()) {
        val option = options.opt(index)
        val optionObject = option as? JSONObject
        val value = when (option) {
            is JSONObject -> option.stringOrNull("value", "id", "label", "title")
            is String -> option
            else -> null
        } ?: continue
        val label = optionObject?.stringOrNull("label", "title", "name", "value", "id") ?: value
        val detail = optionObject?.stringOrNull("description", "detail")
            ?: details?.optJSONObject(index)?.stringOrNull("description", "detail")
        add(PendingOptionView(value, label, detail))
    }
}

private fun parseQuestions(array: JSONArray?): List<PendingQuestionView> = buildList {
    if (array == null) return@buildList
    for (index in 0 until array.length()) {
        val question = array.optJSONObject(index) ?: continue
        val questionText = question.stringOrNull("question", "prompt", "label") ?: "请输入"
        add(
            PendingQuestionView(
                id = question.stringOrNull("id", "key") ?: "question-$index",
                label = questionText,
                type = question.stringOrNull("type", "kind") ?: "input",
                options = parseOptions(
                    question.arrayOrNull("options"),
                    question.arrayOrNull("optionDetails"),
                ),
                placeholder = question.stringOrNull("placeholder"),
                required = question.booleanOrNull("required") ?: false,
                allowOther = question.booleanOrNull("allowOther", "allow_other") ?: false,
            ),
        )
    }
}

private fun modelLabel(value: Any?): String? {
    return when (value) {
        is JSONObject -> {
            val provider = value.stringOrNull("provider")
            val id = value.stringOrNull("model", "id", "name")
            when {
                provider != null && id != null -> "$provider/$id"
                id != null -> id
                else -> null
            }
        }
        is String -> value.takeIf { it.isNotBlank() }
        else -> null
    }
}

private fun parseStringArray(array: JSONArray?): List<String> = buildList {
    if (array == null) return@buildList
    for (index in 0 until array.length()) {
        array.optString(index).takeIf { it.isNotBlank() }?.let(::add)
    }
}

internal fun parseModels(raw: Any?): List<ModelView> {
    val array = when (raw) {
        is JSONArray -> raw
        is JSONObject -> raw.arrayOrNull("models", "items", "result")
            ?: if (raw.has("provider") && (raw.has("id") || raw.has("model"))) JSONArray().put(raw) else null
        else -> null
    } ?: return emptyList()
    return buildList {
        for (index in 0 until array.length()) {
            val item = array.optJSONObject(index) ?: continue
            val id = item.stringOrNull("id", "model") ?: continue
            add(
                ModelView(
                    provider = item.stringOrNull("provider").orEmpty(),
                    id = id,
                    name = item.stringOrNull("name", "label") ?: id,
                    thinkingLevels = parseStringArray(item.arrayOrNull("thinkingLevels", "thinking_levels")),
                ),
            )
        }
    }
}

private fun normalizeConnectionStatus(value: String): String = when (value.lowercase(Locale.US)) {
    "ready" -> "connected"
    "connecting", "handshaking", "connected" -> "connecting"
    else -> value
}

internal fun parseRuntimeState(raw: JSONObject?, currentConversationId: String? = null): MobileRuntimeState {
    if (raw == null) return MobileRuntimeState(conversationId = currentConversationId)
    val state = raw.objectOrNull("state") ?: raw
    val sessionState = state.objectOrNull("sessionState", "session_state")
    val snapshot = parseSnapshot(
        state.objectOrNull("snapshot"),
        state.stringOrNull("conversationId", "conversation_id") ?: currentConversationId,
        sessionState,
    )
    val connectionObject = state.objectOrNull("connection")
    val rawConnection = connectionObject?.stringOrNull("status", "state")
        ?: state.stringOrNull("connection", "status")
        ?: "disconnected"
    val account = state.objectOrNull("account")
    return MobileRuntimeState(
        connection = normalizeConnectionStatus(rawConnection),
        path = connectionObject?.stringOrNull("path", "route", "kind")
            ?: state.stringOrNull("path", "route", "connectionPath"),
        endpointId = state.stringOrNull("endpointId", "endpoint_id"),
        deviceId = state.stringOrNull("deviceId", "device_id"),
        conversationId = state.stringOrNull("conversationId", "conversation_id")
            ?: snapshot?.conversationId
            ?: currentConversationId,
        error = state.stringOrNull("error", "errorMessage"),
        workspace = parseWorkspace(state.objectOrNull("workspace", "catalog")),
        snapshot = snapshot,
        models = parseModels(state.opt("models")),
        pendingRequests = state.arrayOrNull("pendingRequests", "pending_requests")?.length() ?: 0,
        accountUser = account?.objectOrNull("user")?.stringOrNull("login", "name", "email")
            ?: account?.stringOrNull("login", "name", "email")
            ?: state.stringOrNull("accountUser", "account_user"),
        accountOrigin = state.stringOrNull("accountOrigin", "origin")
            ?: account?.stringOrNull("origin"),
        loadingHistory = state.booleanOrNull("loadingHistory", "loading_history") ?: false,
    )
}

internal fun formatConversationTime(timestamp: Long?): String {
    if (timestamp == null || timestamp <= 0) return ""
    return DateFormat.getDateTimeInstance(DateFormat.SHORT, DateFormat.SHORT).format(Date(timestamp))
}

internal fun parseDevices(raw: JSONArray?): List<DeviceView> = raw?.let { array ->
    buildList {
        for (index in 0 until array.length()) {
            val item = array.optJSONObject(index) ?: continue
            val id = item.stringOrNull("id", "deviceId", "device_id") ?: continue
            val endpoint = item.stringOrNull("irohEndpointId", "iroh_endpoint_id", "endpointId", "endpoint_id")
            val onlineKnown = item.has("online") && !item.isNull("online")
            add(
                DeviceView(
                    id = id,
                    name = item.stringOrNull("name", "deviceName", "device_name") ?: id,
                    platform = item.stringOrNull("platform") ?: "computer",
                    endpointId = endpoint,
                    online = item.booleanOrNull("online") ?: false,
                    path = item.stringOrNull("path", "route"),
                    lastOnline = item.stringOrNull("lastOnline", "last_online", "lastSeen", "last_seen"),
                    onlineKnown = onlineKnown,
                ),
            )
        }
    }
} ?: emptyList()
