package dev.fastvibe.mobile

import android.os.Build
import androidx.compose.foundation.Canvas
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.defaultMinSize
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.selection.selectable
import androidx.compose.foundation.selection.selectableGroup
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.BasicTextField
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateMapOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.alpha
import androidx.compose.ui.draw.clip
import androidx.compose.ui.draw.shadow
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.ColorFilter
import androidx.compose.ui.graphics.Path
import androidx.compose.ui.graphics.SolidColor
import androidx.compose.ui.graphics.StrokeCap
import androidx.compose.ui.graphics.StrokeJoin
import androidx.compose.ui.graphics.drawscope.Stroke
import androidx.compose.ui.graphics.drawscope.scale
import androidx.compose.ui.res.painterResource
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.semantics.stateDescription
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import org.json.JSONArray
import org.json.JSONObject
import java.util.Locale

@Composable
internal fun MobileSettingsScreen(
    controller: MobileRuntimeController,
    themeKey: String,
    onTheme: (String) -> Unit,
    onCheckUpdates: () -> Unit,
    updateChannel: UpdateChannel = UpdateChannel.GITHUB,
    onUpdateChannel: (UpdateChannel) -> Unit = {},
    contentTop: Dp = 0.dp,
) {
    val context = androidx.compose.ui.platform.LocalContext.current
    val packageInfo = remember(context) {
        context.packageManager.getPackageInfo(context.packageName, 0)
    }
    val deviceName = remember(context) { mobileDeviceName(context) }
    val versionCode = if (Build.VERSION.SDK_INT >= 28) {
        packageInfo.longVersionCode
    } else {
        @Suppress("DEPRECATION")
        packageInfo.versionCode.toLong()
    }

    var showUpdateChannels by remember { mutableStateOf(false) }

    LazyColumn(
        modifier = Modifier.fillMaxSize(),
        contentPadding = PaddingValues(start = 16.dp, top = contentTop, end = 16.dp, bottom = 36.dp),
    ) {
        item {
            GlassPanel(Modifier.fillMaxWidth(), RoundedCornerShape(24.dp)) {
                Column(Modifier.fillMaxWidth()) {
                    Row(
                        Modifier.fillMaxWidth().defaultMinSize(minHeight = 52.dp)
                            .padding(horizontal = 16.dp, vertical = 8.dp),
                        verticalAlignment = Alignment.CenterVertically,
                        horizontalArrangement = Arrangement.spacedBy(12.dp),
                    ) {
                        MobileSettingsAvatar(controller.state.accountUser)
                        Column(Modifier.weight(1f)) {
                            Text(
                                controller.state.accountUser ?: "已登录账号",
                                fontSize = 16.sp,
                                lineHeight = 23.5.sp,
                                fontWeight = FontWeight.SemiBold,
                                maxLines = 1,
                                overflow = TextOverflow.Ellipsis,
                            )
                            controller.state.accountEmail?.takeIf(String::isNotBlank)?.let { email ->
                                Text(email, fontSize = 13.sp, lineHeight = 19.sp, color = MaterialTheme.colorScheme.onSurfaceVariant, maxLines = 1, overflow = TextOverflow.Ellipsis)
                            }
                        }
                    }
                    MobileSettingsDivider()
                    // This is the phone's own name, not the currently connected computer.
                    MobileSettingsRow("本机名称", deviceName)
                }
            }
            Spacer(Modifier.height(22.dp))
        }
        item { MobileSettingsSectionLabel("外观") }
        item {
            GlassPanel(Modifier.fillMaxWidth(), RoundedCornerShape(24.dp)) {
                MobileThemeSegment(themeKey, onTheme)
            }
            Spacer(Modifier.height(22.dp))
        }
        item { MobileSettingsSectionLabel("关于") }
        item {
            GlassPanel(Modifier.fillMaxWidth(), RoundedCornerShape(24.dp)) {
                Column(Modifier.fillMaxWidth()) {
                    MobileSettingsRow("版本", "${packageInfo.versionName} ($versionCode)")
                    MobileSettingsDivider()
                    MobileSettingsRow("更新", "检查新版本", onClick = onCheckUpdates)
                    MobileSettingsDivider()
                    MobileSettingsRow("更新通道", updateChannel.label, onClick = { showUpdateChannels = true })
                }
            }
            Spacer(Modifier.height(22.dp))
        }
        item {
            GlassPanel(Modifier.fillMaxWidth(), RoundedCornerShape(24.dp)) {
                Row(
                    Modifier.fillMaxWidth().defaultMinSize(minHeight = 52.dp)
                        .glassClick(onClick = { controller.logout() })
                        .padding(horizontal = 16.dp, vertical = 8.dp),
                    horizontalArrangement = Arrangement.spacedBy(12.dp, Alignment.CenterHorizontally),
                    verticalAlignment = Alignment.CenterVertically,
                ) {
                    MobileSettingsIcon(R.drawable.fv_log_out, Modifier.size(20.dp), MaterialTheme.colorScheme.error)
                    Text(
                        "退出登录", fontSize = 16.sp, lineHeight = 23.5.sp,
                        fontWeight = FontWeight.SemiBold, color = MaterialTheme.colorScheme.error,
                    )
                }
            }
            Spacer(Modifier.height(22.dp))
        }
    }
    if (showUpdateChannels) {
        GlassBottomSheet(onDismissRequest = { showUpdateChannels = false }) {
            Column(
                Modifier.fillMaxWidth().padding(start = 22.dp, end = 22.dp, top = 18.dp, bottom = 22.dp),
                verticalArrangement = Arrangement.spacedBy(4.dp),
            ) {
                Text("更新通道", fontSize = 18.sp, lineHeight = 26.5.sp, fontWeight = FontWeight.Bold)
                Text("选择检查和下载更新时使用的来源。", fontSize = 13.sp, color = MaterialTheme.colorScheme.onSurfaceVariant)
                Spacer(Modifier.height(8.dp))
                UpdateChannel.entries.forEach { channel ->
                    Row(
                        Modifier.fillMaxWidth().defaultMinSize(minHeight = 52.dp)
                            .glassClick(onClick = {
                                onUpdateChannel(channel)
                                showUpdateChannels = false
                            })
                            .padding(horizontal = 4.dp, vertical = 8.dp),
                        verticalAlignment = Alignment.CenterVertically,
                    ) {
                        Text(channel.label, Modifier.weight(1f), fontSize = 16.sp, lineHeight = 23.5.sp)
                        if (channel == updateChannel) {
                            MobileSettingsIcon(R.drawable.fv_check, Modifier.size(20.dp), MaterialTheme.colorScheme.primary)
                        }
                    }
                }
            }
        }
    }
}

@Composable
private fun MobileSettingsAvatar(accountUser: String?) {
    val initial = accountUser?.trim()?.firstOrNull()?.uppercaseChar()?.toString() ?: "F"
    AccentPanel(Modifier.size(40.dp), CircleShape) {
        Box(Modifier.fillMaxSize(), contentAlignment = Alignment.Center) {
            Text(initial, color = Color.White, fontSize = 16.sp, fontWeight = FontWeight.Bold)
        }
    }
}

@Composable
private fun MobileThemeSegment(themeKey: String, onTheme: (String) -> Unit) {
    Row(
        Modifier.fillMaxWidth().padding(horizontal = 12.dp, vertical = 10.dp)
            .clip(CircleShape).background(MaterialTheme.colorScheme.surfaceVariant)
            .padding(3.dp).selectableGroup(),
    ) {
        MobileThemeOption("跟随系统", "auto", themeKey, onTheme, Modifier.weight(1f))
        MobileThemeOption("浅色", "light", themeKey, onTheme, Modifier.weight(1f))
        MobileThemeOption("深色", "dark", themeKey, onTheme, Modifier.weight(1f))
    }
}

@Composable
private fun MobileThemeOption(
    label: String,
    value: String,
    selected: String,
    onSelect: (String) -> Unit,
    modifier: Modifier,
) {
    val active = selected == value
    val selectedColor = if (MaterialTheme.colorScheme.background.red < .1f) Color.White.copy(alpha = .20f) else Color.White
    Box(
        modifier.then(if (active) Modifier.shadow(2.dp, CircleShape).background(selectedColor, CircleShape) else Modifier)
            .clip(CircleShape).selectable(active, role = Role.RadioButton, onClick = { onSelect(value) })
            .heightIn(min = 38.dp),
        contentAlignment = Alignment.Center,
    ) {
        Text(
            label, fontSize = 14.sp, lineHeight = 20.5.sp, fontWeight = FontWeight.SemiBold,
            color = if (active) MaterialTheme.colorScheme.onSurface else MaterialTheme.colorScheme.onSurfaceVariant,
        )
    }
}

@Composable
private fun MobileSettingsSectionLabel(text: String) {
    Text(
        text, Modifier.padding(start = 18.dp, bottom = 8.dp), fontSize = 13.sp,
        lineHeight = 19.sp, fontWeight = FontWeight.SemiBold, color = MaterialTheme.colorScheme.onSurfaceVariant,
    )
}

@Composable
private fun MobileSettingsRow(label: String, value: String, onClick: (() -> Unit)? = null) {
    Row(
        Modifier.fillMaxWidth().defaultMinSize(minHeight = 52.dp)
            .then(if (onClick == null) Modifier else Modifier.glassClick(onClick = onClick))
            .padding(horizontal = 16.dp, vertical = 8.dp),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(12.dp),
    ) {
        Text(label, Modifier.weight(1f), fontSize = 16.sp, lineHeight = 23.5.sp)
        Text(
            value, Modifier.weight(1f), fontSize = 15.sp, lineHeight = 22.sp, textAlign = TextAlign.End,
            color = MaterialTheme.colorScheme.onSurfaceVariant, maxLines = 1, overflow = TextOverflow.Ellipsis,
        )
    }
}

@Composable
private fun MobileSettingsDivider() {
    HorizontalDivider(Modifier.padding(start = 16.dp), thickness = 1.dp, color = MaterialTheme.colorScheme.outlineVariant)
}

@Composable
private fun MobileSettingsIcon(resourceId: Int, modifier: Modifier, tint: Color) {
    androidx.compose.foundation.Image(painterResource(resourceId), null, modifier, colorFilter = ColorFilter.tint(tint))
}

@Composable
internal fun MobileModelPickerSheet(controller: MobileRuntimeController, onDismiss: () -> Unit) {
    var models by remember { mutableStateOf(controller.state.models) }
    LaunchedEffect(Unit) { controller.loadModels { models = it } }
    MobileModelPickerContent(
        models, controller.state.snapshot?.model, controller.state.snapshot?.thinkingLevel, onDismiss,
        onSelect = { controller.setModel(it, onDismiss) },
        onThinking = { controller.setThinking(it, onDismiss) },
    )
}

@Composable
internal fun MobileModelPickerContent(
    models: List<ModelView>,
    currentModel: String?,
    selectedThinking: String?,
    onDismiss: () -> Unit,
    onSelect: (ModelView) -> Unit,
    onThinking: (String) -> Unit,
) {
    val groups = remember(models) { models.groupBy { it.provider } }
    var expandedProvider by remember { mutableStateOf<String?>(null) }
    val selectedModel = models.firstOrNull { "${it.provider}/${it.id}" == currentModel }
    val thinkingLevels = selectedModel?.thinkingLevels.orEmpty()
    val maxHeight = (androidx.compose.ui.platform.LocalConfiguration.current.screenHeightDp * .65f).coerceAtMost(560f).dp
    GlassBottomSheet(onDismissRequest = onDismiss) {
        Column(Modifier.fillMaxWidth().padding(start = 22.dp, end = 22.dp, top = 18.dp, bottom = 22.dp), verticalArrangement = Arrangement.spacedBy(14.dp)) {
            Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
                Text("模型", Modifier.weight(1f), fontSize = 18.sp, lineHeight = 26.5.sp, fontWeight = FontWeight.Bold)
                GlassIconButton(R.drawable.fv_x, "关闭模型选择", onDismiss)
            }
            LazyColumn(Modifier.fillMaxWidth().heightIn(max = maxHeight), verticalArrangement = Arrangement.spacedBy(8.dp)) {
                if (models.isEmpty()) item { Text("没有可用模型", fontSize = 14.sp, color = MaterialTheme.colorScheme.onSurfaceVariant) }
                groups.forEach { (provider, providerModels) ->
                    val expanded = expandedProvider == provider
                    item(key = "provider:$provider") {
                        Row(
                            Modifier.fillMaxWidth().clip(RoundedCornerShape(18.dp))
                                .background(MaterialTheme.colorScheme.surfaceVariant)
                                .semantics { stateDescription = if (expanded) "已展开" else "已收起" }
                                .glassClick { expandedProvider = if (expanded) null else provider }
                                .defaultMinSize(minHeight = 56.dp).padding(horizontal = 14.dp, vertical = 8.dp),
                            verticalAlignment = Alignment.CenterVertically,
                            horizontalArrangement = Arrangement.spacedBy(12.dp),
                        ) {
                            Column(Modifier.weight(1f)) {
                                Text(provider, fontSize = 16.sp, lineHeight = 23.5.sp, fontWeight = FontWeight.SemiBold, maxLines = 1, overflow = TextOverflow.Ellipsis)
                                if (selectedModel?.provider == provider) Text("当前：${selectedModel.name}", fontSize = 13.sp, lineHeight = 19.sp, color = MaterialTheme.colorScheme.primary, maxLines = 1, overflow = TextOverflow.Ellipsis)
                            }
                            Text("${providerModels.size}", fontSize = 13.sp, color = MaterialTheme.colorScheme.onSurfaceVariant)
                            MobileSettingsIcon(if (expanded) R.drawable.fv_chevron_down else R.drawable.fv_chevron_right, Modifier.size(16.dp), MaterialTheme.colorScheme.onSurfaceVariant)
                        }
                    }
                    if (expanded) items(providerModels.size, key = { "model:$provider:${providerModels[it].id}" }) { index ->
                        val model = providerModels[index]
                        MobileModelRow(model, "${model.provider}/${model.id}" == currentModel) { onSelect(model) }
                    }
                }
                if (thinkingLevels.isNotEmpty()) {
                    item { Text("思考深度", Modifier.padding(top = 8.dp), fontSize = 13.sp, fontWeight = FontWeight.SemiBold, color = MaterialTheme.colorScheme.onSurfaceVariant) }
                    items(thinkingLevels.size, key = { "thinking:${thinkingLevels[it]}" }) { index ->
                        val level = thinkingLevels[index]
                        MobilePickerOption(level, level == selectedThinking) { onThinking(level) }
                    }
                }
            }
        }
    }
}

@Composable
private fun MobileModelRow(model: ModelView, selected: Boolean, onClick: () -> Unit) {
    Row(
        Modifier.mobileOption(selected, onClick).padding(horizontal = 14.dp, vertical = 8.dp),
        verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(12.dp),
    ) {
        MobileSettingsIcon(R.drawable.fv_cpu, Modifier.size(20.dp), MaterialTheme.colorScheme.primary)
        Column(Modifier.weight(1f)) {
            Text(model.name, fontSize = 16.sp, lineHeight = 23.5.sp, maxLines = 1, overflow = TextOverflow.Ellipsis)
            Text(model.provider, fontSize = 13.sp, lineHeight = 19.sp, color = MaterialTheme.colorScheme.onSurfaceVariant, maxLines = 1, overflow = TextOverflow.Ellipsis)
        }
        MobileRadioDot(selected)
    }
}

@Composable
private fun MobilePickerOption(label: String, selected: Boolean, onClick: () -> Unit) {
    Row(Modifier.mobileOption(selected, onClick).padding(horizontal = 14.dp, vertical = 8.dp), verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(12.dp)) {
        Text(label, Modifier.weight(1f), fontSize = 16.sp, lineHeight = 23.5.sp)
        MobileRadioDot(selected)
    }
}

@Composable
private fun Modifier.mobileOption(selected: Boolean, onClick: () -> Unit): Modifier {
    val shape = RoundedCornerShape(18.dp)
    val primary = MaterialTheme.colorScheme.primary
    return fillMaxWidth().clip(shape)
        .background(if (selected) primary.copy(alpha = .13f) else MaterialTheme.colorScheme.surfaceVariant)
        .then(if (selected) Modifier.border(1.5.dp, primary.copy(alpha = .55f), shape) else Modifier)
        .selectable(selected, role = Role.RadioButton, onClick = onClick).defaultMinSize(minHeight = 56.dp)
}

@Composable
private fun MobileRadioDot(selected: Boolean) {
    val dark = MaterialTheme.colorScheme.background.red < .1f
    Box(
        Modifier.size(22.dp).border(1.5.dp, if (selected) MaterialTheme.colorScheme.primary else if (dark) Color(0xFF48484A) else Color(0xFFC7C7CC), CircleShape),
        contentAlignment = Alignment.Center,
    ) {
        if (selected) Box(Modifier.size(12.dp).background(MaterialTheme.colorScheme.primary, CircleShape))
    }
}

@Composable
internal fun MobilePendingUiSheet(controller: MobileRuntimeController, request: PendingUiView, onDismiss: () -> Unit) {
    var value by remember(request.id) { mutableStateOf(request.initialValue) }
    var selected by remember(request.id) { mutableStateOf(request.options.firstOrNull()?.value) }
    val answers = remember(request.id) { mutableStateMapOf<String, String>() }
    val type = request.type.lowercase(Locale.US)
    // A command belongs to the request message. Keep its Markdown intact rather than inventing metadata.
    val fence = request.message.indexOf("```")
    val description = if (fence >= 0) request.message.substring(0, fence).trimEnd() else request.message
    val markdown = if (fence >= 0) request.message.substring(fence) else null

    GlassBottomSheet(onDismissRequest = {}) {
        Column(
            Modifier.fillMaxWidth().verticalScroll(rememberScrollState())
                .padding(start = 22.dp, end = 22.dp, top = 18.dp, bottom = 22.dp),
            verticalArrangement = Arrangement.spacedBy(14.dp),
        ) {
            Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(12.dp), verticalAlignment = Alignment.Top) {
                MobilePendingTile(type)
                Column(Modifier.weight(1f)) {
                    Text(request.title, fontSize = 18.sp, lineHeight = 26.5.sp, fontWeight = FontWeight.Bold)
                    if (description.isNotBlank()) Text(description, fontSize = 14.sp, lineHeight = 20.5.sp, color = MaterialTheme.colorScheme.onSurfaceVariant)
                }
            }
            if (markdown != null) {
                val command = remember(markdown) {
                    Regex("\\A```[^\\r\\n]*\\r?\\n([\\s\\S]*?)\\r?\\n```\\s*\\z").matchEntire(markdown)?.groupValues?.get(1)
                }
                if (command != null) Text(
                    command, Modifier.fillMaxWidth().background(MaterialTheme.colorScheme.surfaceVariant, RoundedCornerShape(10.dp))
                        .padding(horizontal = 12.dp, vertical = 10.dp),
                    fontFamily = FontFamily.Monospace, fontSize = 12.5.sp, lineHeight = 19.375.sp,
                ) else ReplyMarkdown(markdown, Modifier.fillMaxWidth())
            }
            when (type) {
                "select" -> Column(Modifier.selectableGroup(), verticalArrangement = Arrangement.spacedBy(8.dp)) {
                    request.options.forEach { option ->
                        MobilePendingOption(option, selected == option.value) { selected = option.value }
                    }
                }
                "input", "editor" -> MobilePendingTextField(
                    value, { value = it }, request.placeholder ?: "请输入",
                    request.multiline || type == "editor",
                )
                "questions" -> request.questions.forEach { question ->
                    Column(Modifier.fillMaxWidth().selectableGroup(), verticalArrangement = Arrangement.spacedBy(8.dp)) {
                        Text(question.label, fontSize = 16.sp, lineHeight = 23.5.sp, fontWeight = FontWeight.Medium)
                        question.options.forEach { option ->
                            MobilePendingOption(option, answers[question.id] == option.value) { answers[question.id] = option.value }
                        }
                        if (question.options.isEmpty() || question.allowOther) MobilePendingTextField(
                            answers[question.id].orEmpty(), { answers[question.id] = it }, question.placeholder ?: "请输入",
                            question.type.equals("editor", ignoreCase = true),
                        )
                    }
                }
                "confirm" -> Unit
                else -> Text("暂不支持的请求类型：${request.type}", fontSize = 14.sp, color = MaterialTheme.colorScheme.error)
            }
            Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(10.dp)) {
                MobileSheetButton(
                    text = when (type) { "confirm" -> "拒绝"; "select" -> "跳过"; else -> "取消" },
                    modifier = Modifier.weight(1f), accent = false,
                    onClick = {
                        controller.respondPending(request, if (type == "confirm") JSONObject().put("confirmed", false) else JSONObject().put("cancelled", true), onDismiss)
                    },
                )
                if (type in setOf("confirm", "select", "input", "editor", "questions")) MobileSheetButton(
                    text = when (type) { "confirm" -> "允许"; "select" -> "确定"; else -> "提交" },
                    modifier = Modifier.weight(1f), enabled = type != "select" || selected != null,
                    onClick = {
                        val response = when (type) {
                            "confirm" -> JSONObject().put("confirmed", true)
                            "select" -> JSONObject().put("value", selected)
                            "questions" -> JSONObject().put("answers", JSONArray().apply {
                                request.questions.forEach { put(answers[it.id]?.takeIf(String::isNotBlank) ?: JSONObject.NULL) }
                            })
                            else -> JSONObject().put("value", value)
                        }
                        controller.respondPending(request, response, onDismiss)
                    },
                )
            }
        }
    }
}

@Composable
private fun MobilePendingTile(type: String) {
    val dark = MaterialTheme.colorScheme.background.red < .1f
    val warning = if (dark) Color(0xFFFF9F0A) else Color(0xFFFF9500)
    val shape = RoundedCornerShape(14.dp)
    Box(
        Modifier.size(44.dp).background(warning.copy(alpha = .16f), shape)
            .border(.5.dp, Color.Black.copy(alpha = if (dark) .5f else .06f), shape),
        contentAlignment = Alignment.Center,
    ) {
        if (type == "select" || type == "questions") MobileSettingsIcon(R.drawable.fv_list_checks, Modifier.size(20.dp), warning)
        else Canvas(Modifier.size(20.dp)) {
            scale(size.width / 24f, size.height / 24f, pivot = androidx.compose.ui.geometry.Offset.Zero) {
                val path = Path().apply {
                    if (type == "confirm") {
                        moveTo(20f, 13f); cubicTo(20f, 18f, 16.5f, 20.5f, 12.34f, 21.95f)
                        cubicTo(12.12f, 22.03f, 11.88f, 22.03f, 11.67f, 21.94f)
                        cubicTo(7.5f, 20.5f, 4f, 18f, 4f, 13f); lineTo(4f, 6f)
                        quadraticTo(4f, 5f, 5f, 5f); cubicTo(7f, 5f, 9.5f, 3.8f, 11.24f, 2.28f)
                        quadraticTo(12f, 1.7f, 12.76f, 2.28f); cubicTo(14.51f, 3.81f, 17f, 5f, 19f, 5f)
                        quadraticTo(20f, 5f, 20f, 6f); close()
                        moveTo(9f, 12f); lineTo(11f, 14f); lineTo(15f, 10f)
                    } else {
                        moveTo(12f, 20f); lineTo(11f, 20f); quadraticTo(9f, 20f, 9f, 18f)
                        quadraticTo(9f, 20f, 7f, 20f); lineTo(6f, 20f)
                        moveTo(13f, 8f); lineTo(20f, 8f); quadraticTo(22f, 8f, 22f, 10f)
                        lineTo(22f, 14f); quadraticTo(22f, 16f, 20f, 16f); lineTo(13f, 16f)
                        moveTo(5f, 16f); lineTo(4f, 16f); quadraticTo(2f, 16f, 2f, 14f)
                        lineTo(2f, 10f); quadraticTo(2f, 8f, 4f, 8f); lineTo(5f, 8f)
                        moveTo(6f, 4f); lineTo(7f, 4f); quadraticTo(9f, 4f, 9f, 6f)
                        quadraticTo(9f, 4f, 11f, 4f); lineTo(12f, 4f); moveTo(9f, 6f); lineTo(9f, 18f)
                    }
                }
                drawPath(path, warning, style = Stroke(1.5f, cap = StrokeCap.Round, join = StrokeJoin.Round))
            }
        }
    }
}

@Composable
private fun MobilePendingOption(option: PendingOptionView, selected: Boolean, onClick: () -> Unit) {
    Row(
        Modifier.mobileOption(selected, onClick).padding(horizontal = 14.dp, vertical = 8.dp),
        verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(12.dp),
    ) {
        MobileRadioDot(selected)
        Column(Modifier.weight(1f)) {
            Text(option.label, fontSize = 16.sp, lineHeight = 23.5.sp)
            option.detail?.takeIf(String::isNotBlank)?.let {
                Text(it, fontSize = 13.sp, lineHeight = 19.sp, color = MaterialTheme.colorScheme.onSurfaceVariant)
            }
        }
    }
}

@Composable
private fun MobilePendingTextField(value: String, onValueChange: (String) -> Unit, placeholder: String, multiline: Boolean) {
    BasicTextField(
        value, onValueChange,
        modifier = Modifier.fillMaxWidth().clip(RoundedCornerShape(18.dp))
            .background(MaterialTheme.colorScheme.surfaceVariant).heightIn(min = 96.dp)
            .padding(horizontal = 14.dp, vertical = 12.dp).semantics { contentDescription = "回答" },
        textStyle = TextStyle(color = MaterialTheme.colorScheme.onSurface, fontSize = 16.sp, lineHeight = 23.5.sp, fontFamily = FontFamily.SansSerif),
        cursorBrush = SolidColor(MaterialTheme.colorScheme.primary),
        singleLine = !multiline,
        maxLines = if (multiline) 8 else 1,
        keyboardOptions = KeyboardOptions(imeAction = if (multiline) ImeAction.Default else ImeAction.Done),
        decorationBox = { inner ->
            Box {
                if (value.isEmpty()) Text(placeholder, fontSize = 16.sp, lineHeight = 23.5.sp, color = MaterialTheme.colorScheme.onSurfaceVariant)
                inner()
            }
        },
    )
}

@Composable
private fun MobileSheetButton(text: String, modifier: Modifier, onClick: () -> Unit, accent: Boolean = true, enabled: Boolean = true) {
    val buttonModifier = modifier.heightIn(min = 52.dp).alpha(if (enabled) 1f else .4f)
        .clip(CircleShape).glassClick(enabled = enabled, onClick = onClick)
    val content: @Composable androidx.compose.foundation.layout.BoxScope.() -> Unit = {
        Box(Modifier.fillMaxWidth().heightIn(min = 52.dp), contentAlignment = Alignment.Center) {
            Text(text, fontSize = 16.sp, lineHeight = 23.5.sp, fontWeight = FontWeight.SemiBold, color = if (accent) Color.White else MaterialTheme.colorScheme.onSurface)
        }
    }
    if (accent) AccentPanel(buttonModifier, CircleShape, content = content)
    else GlassPanel(buttonModifier, CircleShape, high = true, content = content)
}
