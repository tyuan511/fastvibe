package dev.fastvibe.mobile

import androidx.compose.foundation.Image
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
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
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.ColorFilter
import androidx.compose.ui.res.painterResource
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import org.json.JSONObject

@Composable
internal fun ConversationMessage(message: MessageView, onFile: (OutputView) -> Unit) {
    if (message.role == "user") {
        Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.End) {
            Box(Modifier.fillMaxWidth(.84f), contentAlignment = Alignment.CenterEnd) {
                AccentPanel(shape = RoundedCornerShape(22.dp, 22.dp, 6.dp, 22.dp)) {
                    Text(message.text, Modifier.padding(horizontal = 14.dp, vertical = 10.dp), fontSize = 16.sp, lineHeight = 23.5.sp, color = Color.White)
                }
            }
        }
        return
    }
    val parts = message.parts.ifEmpty {
        buildList {
            message.thinking?.takeIf(String::isNotBlank)?.let { add(PartView("thinking", body = it)) }
            if (message.text.isNotBlank()) add(PartView("text", body = message.text))
            message.tools.forEach { add(PartView("tool", toolId = it.id)) }
        }
    }
    val blocks = remember(parts, message.tools) {
        buildList<List<PartView>> {
            var index = 0
            while (index < parts.size) {
                if (parts[index].kind == "tool") {
                    val start = index
                    while (index < parts.size && parts[index].kind == "tool") index++
                    add(parts.subList(start, index))
                } else add(listOf(parts[index++]))
            }
        }
    }
    Column(Modifier.fillMaxWidth(), verticalArrangement = Arrangement.spacedBy(10.dp)) {
        for (block in blocks) {
            val part = block.first()
            when (part.kind) {
                "thinking" -> ConversationThinking(part.body)
                "tool" -> ConversationTools(block.mapNotNull { row -> message.tools.firstOrNull { it.id == row.toolId } })
                "model" -> Row(Modifier.fillMaxWidth().padding(vertical = 2.dp), verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(10.dp)) {
                    HorizontalDivider(Modifier.weight(1f), color = MaterialTheme.colorScheme.outlineVariant)
                    Text(part.body, fontSize = 13.sp, color = MaterialTheme.colorScheme.onSurfaceVariant)
                    HorizontalDivider(Modifier.weight(1f), color = MaterialTheme.colorScheme.outlineVariant)
                }
                "compact" -> GlassPanel(shape = RoundedCornerShape(22.dp)) {
                    Row(Modifier.fillMaxWidth().padding(14.dp), verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(12.dp)) {
                        TranscriptIcon(R.drawable.fv_sparkles)
                        Column {
                            Text("上下文已压缩", fontSize = 15.sp, fontWeight = FontWeight.SemiBold)
                            if (part.body.isNotBlank()) Text(part.body, fontSize = 13.sp, color = MaterialTheme.colorScheme.onSurfaceVariant)
                        }
                    }
                }
                "file", "output" -> Unit
                else -> if (part.body.isNotBlank()) ReplyMarkdown(part.body, onFile = { path -> onFile(OutputView(path, path.substringAfterLast('/'))) })
            }
        }
        message.error?.let { error ->
            GlassPanel(shape = RoundedCornerShape(22.dp)) {
                Text(error, Modifier.padding(horizontal = 14.dp, vertical = 12.dp), fontSize = 14.sp, color = MaterialTheme.colorScheme.error)
            }
        }
        val outputs = (parts.flatMap { it.outputs } + message.outputs).distinctBy { it.path }
        if (outputs.isNotEmpty()) {
            Column(verticalArrangement = Arrangement.spacedBy(4.dp)) {
                outputs.forEach { output ->
                    Row(Modifier.fillMaxWidth().glassClick { onFile(output) }.padding(vertical = 6.dp), verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                        TranscriptIcon(R.drawable.fv_file_text, MaterialTheme.colorScheme.primary, 16)
                        Text(output.name, fontSize = 14.sp, fontWeight = FontWeight.Medium, color = MaterialTheme.colorScheme.primary, maxLines = 1, overflow = TextOverflow.Ellipsis)
                    }
                }
            }
        }
    }
}

@Composable
internal fun ConversationThinking(text: String) {
    var expanded by remember { mutableStateOf(false) }
    Column(verticalArrangement = Arrangement.spacedBy(4.dp)) {
        Row(Modifier.defaultMinSize(minHeight = 36.dp).glassClick { expanded = !expanded }.padding(horizontal = 2.dp), verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(6.dp)) {
            TranscriptIcon(R.drawable.fv_sparkles, size = 16)
            Text("思考", fontSize = 14.sp, color = MaterialTheme.colorScheme.onSurfaceVariant)
            TranscriptIcon(if (expanded) R.drawable.fv_chevron_down else R.drawable.fv_chevron_right, size = 16)
        }
        if (expanded) Row {
            Box(Modifier.width(2.dp).height(40.dp).background(MaterialTheme.colorScheme.outlineVariant))
            Text(text, Modifier.padding(start = 12.dp, top = 2.dp, bottom = 2.dp), fontSize = 14.sp, lineHeight = 21.sp, color = MaterialTheme.colorScheme.onSurfaceVariant)
        }
    }
}

@Composable
internal fun ConversationTools(tools: List<ToolView>) {
    if (tools.isEmpty()) return
    val running = tools.any { it.status in setOf("running", "pending", "queued") }
    val failed = tools.count { it.status in setOf("error", "failed") }
    var expanded by remember(tools.first().id) { mutableStateOf(running) }
    GlassPanel(shape = RoundedCornerShape(22.dp)) {
        Column {
            Row(Modifier.fillMaxWidth().defaultMinSize(minHeight = 44.dp).glassClick { expanded = !expanded }.padding(horizontal = 14.dp, vertical = 8.dp), verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                TranscriptIcon(R.drawable.fv_list_checks, size = 16)
                Text(if (running) "正在执行 ${tools.size} 个步骤" else "执行了 ${tools.size} 个步骤", Modifier.weight(1f), fontSize = 14.sp, fontWeight = FontWeight.SemiBold, color = MaterialTheme.colorScheme.onSurfaceVariant)
                if (failed > 0) Text("$failed 个失败", fontSize = 12.sp, color = MaterialTheme.colorScheme.error)
                TranscriptIcon(if (expanded) R.drawable.fv_chevron_down else R.drawable.fv_chevron_right, size = 16)
            }
            if (expanded) tools.forEach { tool ->
                HorizontalDivider(color = MaterialTheme.colorScheme.outlineVariant, thickness = .5.dp)
                ConversationTool(tool)
            }
        }
    }
}

@Composable
private fun ConversationTool(tool: ToolView) {
    var expanded by remember(tool.id) { mutableStateOf(false) }
    val error = tool.status in setOf("error", "failed")
    val running = tool.status in setOf("running", "pending", "queued")
    val args = remember(tool.args) { runCatching { JSONObject(tool.args.orEmpty()) }.getOrNull() }
    val label = when (tool.name.lowercase()) {
        "read", "read_file" -> "读取"
        "write", "write_file" -> "写入"
        "edit", "apply_patch", "edit_file" -> "编辑"
        "bash", "shell", "exec", "command" -> "命令"
        "grep", "rg", "search", "find" -> "搜索"
        else -> tool.name
    }
    val icon = when (label) {
        "读取" -> R.drawable.fv_file_text
        "编辑", "写入" -> R.drawable.fv_file_pen
        "搜索" -> R.drawable.fv_text_search
        else -> R.drawable.fv_terminal
    }
    val summary = listOf("path", "file_path", "filePath", "command", "pattern", "query", "description")
        .firstNotNullOfOrNull { key -> args?.optString(key)?.takeIf { it.isNotBlank() } }
        ?: tool.args?.replace('\n', ' ').orEmpty()
    Column {
        Row(Modifier.fillMaxWidth().defaultMinSize(minHeight = 48.dp).glassClick { expanded = !expanded }.padding(horizontal = 14.dp, vertical = 6.dp), verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(10.dp)) {
            TranscriptIcon(icon, size = 18)
            Text(label, fontSize = 15.sp, fontWeight = FontWeight.SemiBold)
            Text(summary, Modifier.weight(1f), fontSize = 13.sp, fontFamily = FontFamily.Monospace, maxLines = 1, overflow = TextOverflow.Ellipsis, color = MaterialTheme.colorScheme.onSurfaceVariant)
            if (running) CircularProgressIndicator(Modifier.size(16.dp), strokeWidth = 1.5.dp)
            else TranscriptIcon(if (error) R.drawable.fv_circle_x else R.drawable.fv_check, if (error) MaterialTheme.colorScheme.error else Color(0xFF34C759), 18)
            TranscriptIcon(if (expanded) R.drawable.fv_chevron_down else R.drawable.fv_chevron_right, size = 16)
        }
        if (expanded) Column(Modifier.padding(start = 14.dp, end = 14.dp, bottom = 14.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
            tool.args?.let { TranscriptCode("参数", it) }
            tool.result?.let { TranscriptCode(if (error) "错误" else "结果", it) }
            tool.details?.let { TranscriptCode("详情", it) }
        }
    }
}

@Composable
private fun TranscriptCode(title: String, text: String) {
    Column(verticalArrangement = Arrangement.spacedBy(6.dp)) {
        Text(title, fontSize = 12.sp, fontWeight = FontWeight.SemiBold, color = MaterialTheme.colorScheme.onSurfaceVariant)
        Text(text.take(12000), Modifier.fillMaxWidth().clip(RoundedCornerShape(10.dp)).background(if (MaterialTheme.colorScheme.background.red < .1f) Color.Black.copy(alpha = .32f) else Color.White.copy(alpha = .7f)).padding(horizontal = 12.dp, vertical = 10.dp), fontSize = 12.5.sp, lineHeight = 19.sp, fontFamily = FontFamily.Monospace)
    }
}

@Composable
private fun TranscriptIcon(resource: Int, color: Color = MaterialTheme.colorScheme.onSurfaceVariant, size: Int = 20) {
    Image(painterResource(resource), null, Modifier.size(size.dp), colorFilter = ColorFilter.tint(color))
}
