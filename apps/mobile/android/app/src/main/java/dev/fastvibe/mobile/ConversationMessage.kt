package dev.fastvibe.mobile

import androidx.compose.foundation.Image
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.BoxWithConstraints
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.defaultMinSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.LocalTextStyle
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.key
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.runtime.staticCompositionLocalOf
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.draw.drawBehind
import androidx.compose.ui.draw.rotate
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.ColorFilter
import androidx.compose.ui.graphics.SolidColor
import androidx.compose.ui.graphics.StrokeCap
import androidx.compose.ui.graphics.StrokeJoin
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.graphics.vector.addPathNodes
import androidx.compose.ui.res.painterResource
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.semantics.stateDescription
import androidx.compose.ui.text.PlatformTextStyle
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.LineHeightStyle
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import kotlinx.coroutines.delay
import org.json.JSONObject
import java.util.Locale

@Composable
internal fun ConversationMessage(
    message: MessageView,
    streaming: Boolean = false,
    onContinue: (() -> Unit)? = null,
    onFile: (OutputView) -> Unit,
) {
    // CSS has no font padding or tracking. Keep the native transcript on that same type grid.
    CompositionLocalProvider(LocalTextStyle provides LocalTextStyle.current.copy(
        letterSpacing = 0.sp, platformStyle = PlatformTextStyle(includeFontPadding = false),
        lineHeightStyle = LineHeightStyle(LineHeightStyle.Alignment.Center, LineHeightStyle.Trim.None),
    )) {
        if (message.role == "user") {
            BoxWithConstraints(Modifier.fillMaxWidth(), contentAlignment = Alignment.CenterEnd) {
                AccentPanel(
                    Modifier.widthIn(max = maxWidth * .84f),
                    RoundedCornerShape(22.dp, 22.dp, 6.dp, 22.dp),
                    userBubble = true,
                ) {
                    Text(message.text, Modifier.padding(horizontal = 14.dp, vertical = 10.dp), fontSize = 16.sp, lineHeight = 23.52.sp, color = Color.White)
                }
            }
            return@CompositionLocalProvider
        }
        val parts = message.parts.ifEmpty {
            buildList {
                message.thinking?.takeIf(::hasTranscriptContent)?.let { add(PartView("thinking", body = it)) }
                if (hasTranscriptContent(message.text)) add(PartView("text", body = message.text))
                message.tools.forEach { add(PartView("tool", toolId = it.id)) }
            }
        }
        val toolsById = remember(message.tools) { message.tools.associateBy { it.id } }
        val visibleParts = parts.filterIndexed { index, part ->
            when (part.kind) {
                "thinking" -> hasTranscriptContent(part.body) || streaming && index == parts.lastIndex
                "text" -> hasTranscriptContent(part.body)
                else -> true
            }
        }
        val blocks = remember(visibleParts) {
            buildList<List<PartView>> {
                var index = 0
                while (index < visibleParts.size) {
                    if (visibleParts[index].kind == "tool") {
                        val start = index
                        while (index < visibleParts.size && visibleParts[index].kind == "tool") index++
                        add(visibleParts.subList(start, index))
                    } else add(listOf(visibleParts[index++]))
                }
            }
        }
        Column(Modifier.fillMaxWidth(), verticalArrangement = Arrangement.spacedBy(10.dp)) {
            if (message.kind == "compact" && parts.none { it.kind == "compact" }) {
                ConversationCompaction(message.compact, message.text)
            } else for ((index, block) in blocks.withIndex()) {
                val part = block.first()
                key(message.id, index, part.kind, part.toolId) {
                    when (part.kind) {
                        "thinking" -> ConversationThinking(
                            part.body, part.startedAt, part.endedAt,
                            streaming = streaming && block === blocks.last() && part.endedAt == null,
                        )
                        "tool" -> ConversationTools(block.mapNotNull { toolsById[it.toolId] })
                        "model" -> ConversationModelDivider(part.body)
                        "compact" -> ConversationCompaction(part.compact ?: message.compact, part.body)
                        "file", "output" -> Unit
                        else -> if (hasTranscriptContent(part.body)) ReplyMarkdown(part.body, onFile = { path -> onFile(OutputView(path, path.substringAfterLast('/'))) })
                    }
                }
            }
            message.error?.takeIf(::hasTranscriptContent)?.let { error -> ConversationNotice(error, error = true) }
            when (message.stop) {
                "aborted" -> ConversationNotice(
                    if (message.stopCause == "repetition") "回复因重复输出而停止。" else "你停止了这次回复。",
                    onContinue = if (message.stopCause == "repetition") null else onContinue,
                )
                "length" -> ConversationNotice("回复已达到长度上限。", onContinue = onContinue)
            }
            val start = message.runStartedAt ?: message.createdAt.takeIf { it > 0L }
            if (start != null && (streaming || message.completedAt != null) && message.kind !in setOf("compact", "notice")) {
                ConversationTurnMeta(start, message.completedAt, streaming)
            }
            val outputs = (parts.flatMap { it.outputs } + message.outputs).distinctBy { it.path }
            if (outputs.isNotEmpty()) Column(verticalArrangement = Arrangement.spacedBy(4.dp)) {
                outputs.forEach { output ->
                    Row(Modifier.fillMaxWidth().glassClick { onFile(output) }.padding(vertical = 6.dp), verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                        TranscriptIcon(R.drawable.fv_file_text, MaterialTheme.colorScheme.primary, 16)
                        Text(output.name, fontSize = 14.sp, lineHeight = 20.58.sp, fontWeight = FontWeight.Medium, color = MaterialTheme.colorScheme.primary, maxLines = 1, overflow = TextOverflow.Ellipsis)
                    }
                }
            }
        }
    }
}

// Blank thinking must not create an invisible divider between consecutive tool calls.
internal fun hasTranscriptContent(text: String): Boolean = text.any {
    !it.isWhitespace() && Character.getType(it) != Character.FORMAT.toInt() && !it.isISOControl()
}

@Composable
internal fun ConversationThinking(
    text: String,
    startedAt: Long? = null,
    endedAt: Long? = null,
    streaming: Boolean = false,
    initiallyExpanded: Boolean = false,
) {
    if (!hasTranscriptContent(text) && !streaming) return
    var expanded by remember { mutableStateOf(initiallyExpanded) }
    val now = transcriptNow(streaming && startedAt != null)
    val duration = startedAt?.let { start -> (endedAt ?: if (streaming) now else null)?.let { (it - start).coerceAtLeast(0L) } }
    Column(verticalArrangement = Arrangement.spacedBy(0.dp)) {
        Row(Modifier.defaultMinSize(minHeight = 36.dp)
            .semantics { stateDescription = if (expanded) "已展开" else "已收起" }
            .glassClick { expanded = !expanded }.padding(horizontal = 2.dp), verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(6.dp)) {
            TranscriptGlyph(BRAIN_PATH, size = 16)
            Text(when {
                streaming -> if (duration != null) "正在思考 · ${transcriptDuration(duration)}" else "正在思考"
                duration != null -> "思考了 ${transcriptDuration(duration)}"
                else -> "思考"
            }, fontSize = 14.sp, lineHeight = 20.58.sp, color = MaterialTheme.colorScheme.onSurfaceVariant)
            TranscriptIcon(if (expanded) R.drawable.fv_chevron_down else R.drawable.fv_chevron_right, size = 16)
        }
        if (expanded && hasTranscriptContent(text)) {
            val rule = MaterialTheme.colorScheme.outlineVariant
            Box(Modifier.fillMaxWidth().padding(top = 10.dp).drawBehind {
                drawRect(rule, size = androidx.compose.ui.geometry.Size(2.dp.toPx(), size.height))
            }) {
                Text(text, Modifier.fillMaxWidth().padding(start = 14.dp, top = 2.dp, bottom = 2.dp), fontSize = 14.sp, lineHeight = 20.58.sp, color = MaterialTheme.colorScheme.onSurfaceVariant)
            }
        }
    }
}

@Composable
internal fun ConversationTools(
    tools: List<ToolView>,
    initiallyExpanded: Boolean = tools.any { it.status in RUNNING_TOOL_STATES },
    initiallyExpandedToolIds: Set<String> = emptySet(),
) {
    if (tools.isEmpty()) return
    val running = tools.any { it.status in RUNNING_TOOL_STATES }
    val failed = tools.count { it.status in FAILED_TOOL_STATES }
    var expanded by remember(tools.first().id) { mutableStateOf(initiallyExpanded) }
    GlassPanel(Modifier.fillMaxWidth(), shape = RoundedCornerShape(22.dp)) {
        Column {
            Row(Modifier.fillMaxWidth().defaultMinSize(minHeight = 44.dp)
                .semantics { stateDescription = if (expanded) "已展开" else "已收起" }
                .glassClick { expanded = !expanded }.padding(horizontal = 14.dp), verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                TranscriptIcon(R.drawable.fv_list_checks, size = 16)
                Text(if (running) "正在执行 ${tools.size} 个步骤" else "执行了 ${tools.size} 个步骤", fontSize = 14.sp, lineHeight = 20.58.sp, fontWeight = FontWeight.SemiBold, color = MaterialTheme.colorScheme.onSurfaceVariant)
                if (failed > 0) TranscriptBadge("$failed 个失败", MaterialTheme.colorScheme.error, .14f)
                Spacer(Modifier.weight(1f))
                TranscriptIcon(if (expanded) R.drawable.fv_chevron_down else R.drawable.fv_chevron_right, size = 16)
            }
            if (expanded) tools.forEach { tool ->
                key(tool.id) {
                    HorizontalDivider(color = MaterialTheme.colorScheme.outlineVariant, thickness = 1.dp)
                    ConversationTool(tool, initiallyExpanded = tool.id in initiallyExpandedToolIds)
                }
            }
        }
    }
}

@Composable
internal fun ConversationTool(
    tool: ToolView,
    initiallyExpanded: Boolean = false,
    waitingLabel: String? = null,
) {
    var expanded by remember(tool.id) { mutableStateOf(initiallyExpanded) }
    val error = tool.status in FAILED_TOOL_STATES
    val running = tool.status in RUNNING_TOOL_STATES
    val waiting = waitingLabel ?: if (tool.status in WAITING_TOOL_STATES) "等你确认" else null
    val presentation = remember(tool.name, tool.args) { toolPresentation(tool) }
    val diff = remember(tool.details, tool.result) { transcriptToolDiff(tool) }
    val stats = remember(diff) { diff?.let(::transcriptDiffStats) }
    Column {
        Row(Modifier.fillMaxWidth().defaultMinSize(minHeight = 48.dp)
            .semantics { stateDescription = waiting ?: if (expanded) "已展开" else "已收起" }
            .glassClick { expanded = !expanded }.padding(horizontal = 14.dp, vertical = 6.dp), verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(10.dp)) {
            TranscriptIcon(presentation.icon, size = 20)
            Text(presentation.label, fontSize = 15.sp, lineHeight = 22.05.sp, fontWeight = FontWeight.SemiBold)
            Text(presentation.summary, Modifier.weight(1f), fontSize = 13.sp, lineHeight = 19.11.sp, fontFamily = FontFamily.Monospace, maxLines = 1, overflow = TextOverflow.Ellipsis, color = MaterialTheme.colorScheme.onSurfaceVariant)
            when {
                waiting != null -> TranscriptBadge(waiting, transcriptWarning(), .17f)
                running -> TranscriptSpinner(18)
                error -> TranscriptIcon(R.drawable.fv_circle_x, MaterialTheme.colorScheme.error, 18)
                stats != null -> TranscriptBadge("+${stats.first} −${stats.second}", transcriptSuccess(), .15f)
                tool.status in SUCCESS_TOOL_STATES -> TranscriptIcon(R.drawable.fv_check, transcriptSuccess(), 18)
                else -> Text(tool.status, fontSize = 12.sp, color = MaterialTheme.colorScheme.onSurfaceVariant)
            }
            if (waiting == null) TranscriptIcon(if (expanded) R.drawable.fv_chevron_down else R.drawable.fv_chevron_right, size = 16)
        }
        if (expanded) Column(Modifier.padding(start = 14.dp, end = 14.dp, bottom = 14.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
            if (diff != null) ConversationDiff(diff)
            else tool.result?.takeIf(::hasTranscriptContent)?.let {
                TranscriptCode(if (error) "错误" else if (presentation.label == "命令") "输出" else "结果", it)
            }
            // A returned result or engine diff is the useful detail. Show arguments only
            // before any output exists; don't repeat a command/path already in the row.
            if (diff == null && !hasTranscriptContent(tool.result.orEmpty())) {
                tool.args?.takeIf(::hasTranscriptContent)?.let { TranscriptCode("参数", prettyJson(it)) }
            }
            if (diff == null) tool.details?.takeIf {
                hasTranscriptContent(it) && it !in setOf("{}", "[]", "null") && it != tool.result && it != tool.args
            }?.let { TranscriptCode("详情", prettyJson(it)) }
        }
    }
}

@Composable
internal fun ConversationDiff(text: String) {
    Column(Modifier.fillMaxWidth().clip(RoundedCornerShape(10.dp)).background(transcriptCodeBackground())) {
        text.split('\n').forEach { line ->
            val kind = transcriptDiffLineKind(line)
            Text(line, Modifier.fillMaxWidth()
                .background(when (kind) { 1 -> transcriptSuccess().copy(alpha = .14f); -1 -> MaterialTheme.colorScheme.error.copy(alpha = .12f); else -> Color.Transparent })
                .padding(horizontal = 12.dp, vertical = if (line.startsWith("@@")) 4.dp else 0.dp),
                style = LocalTextStyle.current.copy(lineHeightStyle = LineHeightStyle(LineHeightStyle.Alignment.Center, LineHeightStyle.Trim.None)),
                fontSize = 12.5.sp, lineHeight = 19.375.sp, fontFamily = FontFamily.Monospace,
                letterSpacing = 0.sp, color = if (line.startsWith("@@")) MaterialTheme.colorScheme.onSurfaceVariant else MaterialTheme.colorScheme.onSurface)
        }
    }
}

internal fun transcriptDiffLineKind(line: String): Int = when {
    line.startsWith("+++") || line.startsWith("---") -> 0
    line.startsWith('+') -> 1
    line.startsWith('-') -> -1
    // pi's edit tool emits a signed, baked-in source line number rather than @@ hunks.
    else -> 0
}

internal fun transcriptDiffStats(text: String): Pair<Int, Int> {
    val kinds = text.lineSequence().map(::transcriptDiffLineKind).toList()
    return kinds.count { it == 1 } to kinds.count { it == -1 }
}

internal fun transcriptToolDiff(tool: ToolView): String? {
    val details = runCatching { JSONObject(tool.details.orEmpty()) }.getOrNull()
    details?.optString("diff")?.takeIf(::hasTranscriptContent)?.let { return it }
    val result = tool.result.orEmpty()
    return result.takeIf { body -> body.lineSequence().any { it.startsWith("@@") } && body.lineSequence().any { transcriptDiffLineKind(it) != 0 } }
}

private data class TranscriptToolPresentation(val label: String, val icon: Int, val summary: String)
private fun toolPresentation(tool: ToolView): TranscriptToolPresentation {
    val args = runCatching { JSONObject(tool.args.orEmpty()) }.getOrNull()
    val label = when (tool.name.lowercase(Locale.ROOT)) {
        "read", "read_file", "readfile" -> "读取"
        "write", "write_file", "writefile", "create_file" -> "写入"
        "edit", "apply_patch", "edit_file", "str_replace", "patch" -> "编辑"
        "bash", "shell", "exec", "command", "exec_command" -> "命令"
        "grep", "rg", "search", "find", "glob", "ls", "web_search" -> "搜索"
        else -> tool.name
    }
    fun arg(vararg keys: String) = keys.firstNotNullOfOrNull { args?.optString(it)?.takeIf(::hasTranscriptContent) }
    val summary = when (label) {
        "读取", "写入", "编辑" -> arg("path", "file_path", "filePath", "filename", "file", "target_file", "target")
        "命令" -> arg("command", "cmd", "script")
        "搜索" -> listOfNotNull(arg("pattern", "query", "search_query"), arg("path", "cwd", "directory")).joinToString(" ").takeIf(String::isNotBlank)
        else -> arg("description", "path", "query", "command", "url")
    } ?: tool.args?.replace('\n', ' ').orEmpty()
    return TranscriptToolPresentation(label, when (label) {
        "读取" -> R.drawable.fv_file_text
        "编辑", "写入" -> R.drawable.fv_file_pen
        "搜索" -> R.drawable.fv_text_search
        else -> R.drawable.fv_terminal
    }, summary)
}

@Composable
internal fun ConversationModelDivider(label: String) {
    Row(Modifier.fillMaxWidth().padding(vertical = 2.dp), verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(10.dp)) {
        HorizontalDivider(Modifier.weight(1f), color = MaterialTheme.colorScheme.outlineVariant, thickness = 1.dp)
        TranscriptIcon(R.drawable.fv_cpu, size = 14)
        Text(label, Modifier.widthIn(max = 260.dp), fontSize = 13.sp, lineHeight = 19.11.sp, color = MaterialTheme.colorScheme.onSurfaceVariant)
        HorizontalDivider(Modifier.weight(1f), color = MaterialTheme.colorScheme.outlineVariant, thickness = 1.dp)
    }
}

@Composable
internal fun ConversationCompaction(compact: CompactView?, summary: String = "") {
    var expanded by remember { mutableStateOf(false) }
    GlassPanel(Modifier.fillMaxWidth().glassClick { expanded = !expanded }, RoundedCornerShape(22.dp)) {
        Column {
            Row(Modifier.fillMaxWidth().padding(horizontal = 14.dp, vertical = 12.dp), verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(12.dp)) {
                val dark = MaterialTheme.colorScheme.background.red < .1f
                val tileShape = RoundedCornerShape(10.dp)
                Box(Modifier.size(36.dp).clip(tileShape)
                    .background(Color.White.copy(alpha = if (dark) .08f else .72f))
                    .border(.5.dp, Color.White.copy(alpha = if (dark) .16f else .95f), tileShape), contentAlignment = Alignment.Center) {
                    if (compact?.status == "running") TranscriptSpinner(20)
                    else TranscriptGlyph(FOLD_PATH, size = 20)
                }
                Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(2.dp)) {
                    Text(when (compact?.status) { "running" -> "正在压缩上下文"; "cancelled" -> "上下文压缩已取消"; "error" -> "上下文压缩失败"; else -> "上下文已压缩" }, fontSize = 15.sp, lineHeight = 22.05.sp, fontWeight = FontWeight.Bold)
                    val before = compact?.tokensBefore
                    val after = compact?.tokensAfter
                    val tokens = if (before != null && after != null) "${transcriptTokens(before)} → ${transcriptTokens(after)} tokens" else null
                    val reason = when (compact?.reason) { "auto", "automatic", "threshold", "overflow" -> "自动压缩"; "manual" -> "手动压缩"; else -> null }
                    val detail = listOfNotNull(tokens, reason, compact?.error).joinToString(" · ")
                    if (detail.isNotEmpty()) Text(detail, fontSize = 13.sp, lineHeight = 19.11.sp, color = MaterialTheme.colorScheme.onSurfaceVariant)
                    if (before != null && before > 0 && after != null) {
                        Box(Modifier.fillMaxWidth().padding(top = 6.dp).height(6.dp).clip(CircleShape).background(MaterialTheme.colorScheme.surfaceVariant)) {
                            Box(Modifier.fillMaxWidth((after.toFloat() / before).coerceIn(0f, 1f)).height(6.dp).clip(CircleShape).background(MaterialTheme.colorScheme.primary))
                        }
                    }
                }
            }
            if (expanded && hasTranscriptContent(summary)) Text(summary, Modifier.padding(start = 14.dp, end = 14.dp, bottom = 12.dp), fontSize = 14.sp, lineHeight = 20.58.sp, color = MaterialTheme.colorScheme.onSurfaceVariant)
        }
    }
}

@Composable
internal fun ConversationNotice(text: String, error: Boolean = false, onContinue: (() -> Unit)? = null) {
    GlassPanel(Modifier.fillMaxWidth(), RoundedCornerShape(22.dp)) {
        Row(Modifier.fillMaxWidth().then(if (error) Modifier.background(MaterialTheme.colorScheme.error.copy(alpha = .09f)) else Modifier).padding(horizontal = 14.dp, vertical = 12.dp), verticalAlignment = Alignment.Top, horizontalArrangement = Arrangement.spacedBy(10.dp)) {
            TranscriptIcon(if (error) R.drawable.fv_circle_x else R.drawable.fv_square, if (error) MaterialTheme.colorScheme.error else MaterialTheme.colorScheme.onSurfaceVariant, 20)
            Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(8.dp)) {
                Text(text, fontSize = 14.sp, lineHeight = 20.58.sp)
                if (onContinue != null) Row(Modifier.defaultMinSize(minHeight = 36.dp).clip(CircleShape)
                    .background(MaterialTheme.colorScheme.onSurface).semantics { contentDescription = "继续" }
                    .glassClick(onClick = onContinue).padding(horizontal = 14.dp),
                    verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                    TranscriptGlyph(PLAY_PATH, color = MaterialTheme.colorScheme.background, size = 16)
                    Text("继续", fontSize = 14.sp, lineHeight = 20.58.sp, fontWeight = FontWeight.SemiBold, color = MaterialTheme.colorScheme.background)
                }
            }
        }
    }
}

@Composable
internal fun ConversationTurnMeta(startedAt: Long, completedAt: Long? = null, streaming: Boolean = false) {
    val now = transcriptNow(streaming)
    val end = if (streaming) now else completedAt ?: return
    Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(6.dp)) {
        TranscriptGlyph(CLOCK_PATH, size = 14)
        Text("已处理 ${transcriptDuration((end - startedAt).coerceAtLeast(0L))}", fontSize = 13.sp, lineHeight = 19.11.sp, letterSpacing = 0.sp, color = MaterialTheme.colorScheme.onSurfaceVariant)
    }
}

internal fun transcriptDuration(milliseconds: Long): String {
    val seconds = milliseconds.coerceAtLeast(0L) / 1000
    return if (seconds < 60) "$seconds 秒" else "${seconds / 60} 分 ${seconds % 60} 秒"
}
private fun transcriptTokens(value: Long) = if (value >= 1000) "${value / 1000}k" else "$value"
private fun prettyJson(text: String) = runCatching { JSONObject(text).toString(2) }.getOrDefault(text)

internal val LocalTranscriptClock = staticCompositionLocalOf<() -> Long> { System::currentTimeMillis }

@Composable
private fun transcriptNow(ticking: Boolean): Long {
    val clock = LocalTranscriptClock.current
    var now by remember(clock) { mutableStateOf(clock()) }
    LaunchedEffect(ticking, clock) { if (ticking) while (true) { now = clock(); delay(1000) } }
    return now
}

@Composable
private fun TranscriptCode(title: String, text: String) {
    Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
        Text(title, fontSize = 12.sp, lineHeight = 17.64.sp, letterSpacing = .48.sp, fontWeight = FontWeight.SemiBold, color = MaterialTheme.colorScheme.onSurfaceVariant)
        Text(text, Modifier.fillMaxWidth().clip(RoundedCornerShape(10.dp)).background(transcriptCodeBackground()).padding(horizontal = 12.dp, vertical = 10.dp), fontSize = 12.5.sp, lineHeight = 19.375.sp, letterSpacing = 0.sp, fontFamily = FontFamily.Monospace)
    }
}

@Composable
private fun TranscriptBadge(label: String, color: Color, alpha: Float) {
    Box(Modifier.height(22.dp).clip(CircleShape).background(color.copy(alpha = alpha)).padding(horizontal = 8.dp), contentAlignment = Alignment.Center) {
        Text(label, fontSize = 12.sp, lineHeight = 17.64.sp, letterSpacing = 0.sp, fontWeight = FontWeight.SemiBold, color = color)
    }
}

@Composable
private fun TranscriptSpinner(size: Int) {
    var rotation by remember { mutableStateOf(0f) }
    LaunchedEffect(Unit) { while (true) { delay(16); rotation = (rotation + 5.76f) % 360f } }
    Image(painterResource(R.drawable.fv_loader_circle), null, Modifier.size(size.dp).rotate(rotation), colorFilter = ColorFilter.tint(MaterialTheme.colorScheme.primary))
}

@Composable
private fun transcriptCodeBackground() = if (MaterialTheme.colorScheme.background.red < .1f) Color.Black.copy(alpha = .32f) else Color.White.copy(alpha = .7f)
@Composable
private fun transcriptSuccess() = if (MaterialTheme.colorScheme.background.red < .1f) Color(0xFF32D74B) else Color(0xFF34C759)
@Composable
private fun transcriptWarning() = if (MaterialTheme.colorScheme.background.red < .1f) Color(0xFFFF9F0A) else Color(0xFFFF9500)

@Composable
private fun TranscriptIcon(resource: Int, color: Color = MaterialTheme.colorScheme.onSurfaceVariant, size: Int = 20) {
    Image(painterResource(resource), null, Modifier.size(size.dp), colorFilter = ColorFilter.tint(color))
}

// These are the prototype's Lucide paths. Keep missing glyphs here rather than substituting
// sparkles for brain, or adding resources outside this component's ownership.
@Composable
private fun TranscriptGlyph(path: String, color: Color = MaterialTheme.colorScheme.onSurfaceVariant, size: Int) {
    val vector = remember(path) {
        ImageVector.Builder("Transcript", 24.dp, 24.dp, 24f, 24f).addPath(
            pathData = addPathNodes(path), fill = null, stroke = SolidColor(Color.Black),
            strokeLineWidth = 1.5f, strokeLineCap = StrokeCap.Round, strokeLineJoin = StrokeJoin.Round,
        ).build()
    }
    Image(vector, null, Modifier.size(size.dp), colorFilter = ColorFilter.tint(color))
}

private val RUNNING_TOOL_STATES = setOf("running", "pending", "queued")
private val FAILED_TOOL_STATES = setOf("error", "failed")
private val SUCCESS_TOOL_STATES = setOf("done", "success", "completed")
private val WAITING_TOOL_STATES = setOf("waiting", "waiting_for_user", "awaiting_confirmation")
private const val BRAIN_PATH = "M12 18V5 M15 13a4.17 4.17 0 0 1-3-4 4.17 4.17 0 0 1-3 4 M17.598 6.5A3 3 0 1 0 12 5a3 3 0 1 0-5.598 1.5 M17.997 5.125a4 4 0 0 1 2.526 5.77 M18 18a4 4 0 0 0 2-7.464 M19.967 17.483A4 4 0 1 1 12 18a4 4 0 1 1-7.967-.517 M6 18a4 4 0 0 1-2-7.464 M6.003 5.125a4 4 0 0 0-2.526 5.77"
private const val FOLD_PATH = "M12 22v-6 M12 8V2 M4 12H2 M10 12H8 M16 12h-2 M22 12h-2 M15 19l-3-3-3 3 M15 5l-3 3-3-3"
private const val CLOCK_PATH = "M22 12a10 10 0 1 1-20 0a10 10 0 1 1 20 0 M12 6v6l4 2"
private const val PLAY_PATH = "M5 5a2 2 0 0 1 3.008-1.728l11.997 6.998a2 2 0 0 1 .003 3.458l-12 7A2 2 0 0 1 5 19z"
