package dev.fastvibe.mobile

import android.content.pm.PackageInfo
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.defaultMinSize
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
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
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.semantics.stateDescription
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.ColorFilter
import androidx.compose.ui.res.painterResource
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.compose.material3.ExperimentalMaterial3Api
import org.json.JSONArray
import org.json.JSONObject
import java.util.Locale

@Composable
internal fun MobileSettingsScreen(
    controller: MobileRuntimeController,
    themeKey: String,
    onTheme: (String) -> Unit,
    onCheckUpdates: () -> Unit,
) {
    val context = androidx.compose.ui.platform.LocalContext.current
    val packageInfo = remember(context) {
        context.packageManager.getPackageInfo(context.packageName, 0)
    }
    val versionCode = if (android.os.Build.VERSION.SDK_INT >= 28) {
        packageInfo.longVersionCode
    } else {
        @Suppress("DEPRECATION")
        packageInfo.versionCode.toLong()
    }

    LazyColumn(
        modifier = Modifier.fillMaxSize(),
        contentPadding = PaddingValues(16.dp, 4.dp, 16.dp, 36.dp),
        verticalArrangement = Arrangement.spacedBy(12.dp),
    ) {
        item {
            GlassPanel(
                modifier = Modifier.fillMaxWidth(),
                shape = RoundedCornerShape(24.dp),
            ) {
                Row(
                    modifier = Modifier.fillMaxWidth().padding(horizontal = 16.dp, vertical = 14.dp),
                    verticalAlignment = Alignment.CenterVertically,
                ) {
                    MobileSettingsAvatar(controller.state.accountUser)
                    Column(
                        modifier = Modifier.padding(start = 12.dp),
                        verticalArrangement = Arrangement.spacedBy(3.dp),
                    ) {
                        Text(
                            controller.state.accountUser ?: "已登录账号",
                            fontSize = 16.sp,
                            fontWeight = FontWeight.SemiBold,
                            maxLines = 1,
                            overflow = TextOverflow.Ellipsis,
                        )
                    }
                }
            }
        }

        item { MobileSettingsSectionLabel("外观") }
        item {
            GlassPanel(
                modifier = Modifier.fillMaxWidth(),
                shape = RoundedCornerShape(24.dp),
            ) {
                MobileThemeSegment(themeKey, onTheme)
            }
        }

        item { MobileSettingsSectionLabel("此手机") }
        item {
            GlassPanel(
                modifier = Modifier.fillMaxWidth(),
                shape = RoundedCornerShape(24.dp),
            ) {
                MobileSettingsRow(
                    label = "本机连接标识",
                    value = controller.state.endpointId?.let { mobileTruncate(it, 20) } ?: "尚未建立",
                    mono = true,
                )
            }
        }

        item { MobileSettingsSectionLabel("关于") }
        item {
            GlassPanel(
                modifier = Modifier.fillMaxWidth(),
                shape = RoundedCornerShape(24.dp),
            ) {
                Column(Modifier.fillMaxWidth()) {
                    MobileSettingsRow(
                        label = "版本",
                        value = "${packageInfo.versionName} ($versionCode)",
                    )
                    MobileSettingsDivider()
                    MobileSettingsRow(
                        label = "更新",
                        value = "检查新版本",
                        onClick = onCheckUpdates,
                    )
                }
            }
        }

        item {
            GlassPanel(
                modifier = Modifier.fillMaxWidth(),
                shape = RoundedCornerShape(24.dp),
            ) {
                Row(
                    modifier = Modifier.fillMaxWidth()
                        .defaultMinSize(minHeight = 52.dp)
                        .glassClick(onClick = { controller.logout() }),
                    horizontalArrangement = Arrangement.Center,
                    verticalAlignment = Alignment.CenterVertically,
                ) {
                    MobileSettingsIcon(
                        resourceId = R.drawable.fv_log_out,
                        modifier = Modifier.size(18.dp),
                        tint = MaterialTheme.colorScheme.error,
                    )
                    Text(
                        text = "退出登录",
                        modifier = Modifier.padding(start = 8.dp),
                        fontSize = 16.sp,
                        fontWeight = FontWeight.SemiBold,
                        color = MaterialTheme.colorScheme.error,
                    )
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
            Text(initial, color = Color.White, fontSize = 16.sp, fontWeight = FontWeight.SemiBold)
        }
    }
}

@Composable
private fun MobileThemeSegment(themeKey: String, onTheme: (String) -> Unit) {
    Row(
        modifier = Modifier.fillMaxWidth()
            .padding(10.dp)
            .clip(CircleShape)
            .background(MaterialTheme.colorScheme.onSurface.copy(alpha = .09f))
            .padding(3.dp),
        horizontalArrangement = Arrangement.spacedBy(3.dp),
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
    val selectedColor = if (MaterialTheme.colorScheme.background.red < .1f) {
        Color.White.copy(alpha = .20f)
    } else {
        Color.White
    }
    Box(
        modifier = modifier
            .clip(CircleShape)
            .then(if (selected == value) Modifier.background(selectedColor) else Modifier)
            .glassClick(onClick = { onSelect(value) })
            .heightIn(min = 40.dp),
        contentAlignment = Alignment.Center,
    ) {
        Text(
            label,
            fontSize = 15.sp,
            fontWeight = if (selected == value) FontWeight.SemiBold else FontWeight.Normal,
            color = MaterialTheme.colorScheme.onSurface,
        )
    }
}

@Composable
private fun MobileSettingsSectionLabel(text: String) {
    Text(
        text = text,
        modifier = Modifier.padding(start = 18.dp, top = 8.dp, bottom = 0.dp),
        fontSize = 13.sp,
        fontWeight = FontWeight.SemiBold,
        color = MaterialTheme.colorScheme.onSurfaceVariant,
    )
}

@Composable
private fun MobileSettingsRow(
    label: String,
    value: String,
    mono: Boolean = false,
    onClick: (() -> Unit)? = null,
) {
    Row(
        modifier = Modifier.fillMaxWidth()
            .defaultMinSize(minHeight = 52.dp)
            .then(if (onClick == null) Modifier else Modifier.glassClick(onClick = onClick))
            .padding(horizontal = 16.dp, vertical = 8.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Text(text = label, modifier = Modifier.weight(1f), fontSize = 16.sp)
        Text(
            text = value,
            fontSize = 15.sp,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
            fontFamily = if (mono) FontFamily.Monospace else FontFamily.Default,
            maxLines = 1,
            overflow = TextOverflow.Ellipsis,
        )
    }
}

@Composable
private fun MobileSettingsDivider() {
    HorizontalDivider(
        modifier = Modifier.padding(start = 16.dp),
        color = MaterialTheme.colorScheme.onSurface.copy(alpha = .09f),
    )
}

@Composable
private fun MobileSettingsIcon(resourceId: Int, modifier: Modifier, tint: Color) {
    androidx.compose.foundation.Image(
        painter = painterResource(resourceId),
        contentDescription = null,
        modifier = modifier,
        colorFilter = ColorFilter.tint(tint),
    )
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
internal fun MobileModelPickerSheet(
    controller: MobileRuntimeController,
    onDismiss: () -> Unit,
) {
    var models by remember { mutableStateOf(controller.state.models) }
    LaunchedEffect(Unit) { controller.loadModels { models = it } }

    MobileModelPickerContent(
        models = models,
        currentModel = controller.state.snapshot?.model,
        selectedThinking = controller.state.snapshot?.thinkingLevel,
        onDismiss = onDismiss,
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
        Column(Modifier.fillMaxWidth().padding(horizontal = 22.dp, vertical = 12.dp), verticalArrangement = Arrangement.spacedBy(12.dp)) {
            Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
                Text("模型", Modifier.weight(1f), fontSize = 18.sp, fontWeight = FontWeight.Bold)
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
                                .padding(horizontal = 14.dp, vertical = 12.dp),
                            verticalAlignment = Alignment.CenterVertically,
                            horizontalArrangement = Arrangement.spacedBy(10.dp),
                        ) {
                            Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(3.dp)) {
                                Text(provider, fontSize = 15.sp, fontWeight = FontWeight.SemiBold, maxLines = 1, overflow = TextOverflow.Ellipsis)
                                if (selectedModel?.provider == provider) Text("当前：${selectedModel.name}", fontSize = 12.sp, color = MaterialTheme.colorScheme.primary, maxLines = 1, overflow = TextOverflow.Ellipsis)
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
            Spacer(Modifier.height(10.dp))
        }
    }
}

@Composable
private fun MobileModelRow(model: ModelView, selected: Boolean, onClick: () -> Unit) {
    Row(
        modifier = Modifier.fillMaxWidth()
            .heightIn(min = 52.dp)
            .clip(RoundedCornerShape(18.dp))
            .background(
                if (selected) MaterialTheme.colorScheme.primary.copy(alpha = .13f)
                else MaterialTheme.colorScheme.onSurface.copy(alpha = .08f),
            )
            .glassClick(onClick = onClick)
            .padding(horizontal = 14.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        MobileSettingsIcon(R.drawable.fv_cpu, Modifier.size(18.dp), MaterialTheme.colorScheme.primary)
        Column(Modifier.weight(1f).padding(horizontal = 10.dp), verticalArrangement = Arrangement.spacedBy(2.dp)) {
            Text(model.name, fontSize = 16.sp, maxLines = 1, overflow = TextOverflow.Ellipsis)
            Text(
                model.provider,
                fontSize = 13.sp,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
                maxLines = 1,
                overflow = TextOverflow.Ellipsis,
            )
        }
        MobileRadioDot(selected)
    }
}

@Composable
private fun MobilePickerOption(label: String, selected: Boolean, onClick: () -> Unit) {
    Row(
        modifier = Modifier.fillMaxWidth()
            .heightIn(min = 52.dp)
            .clip(RoundedCornerShape(18.dp))
            .background(
                if (selected) MaterialTheme.colorScheme.primary.copy(alpha = .13f)
                else MaterialTheme.colorScheme.onSurface.copy(alpha = .08f),
            )
            .glassClick(onClick = onClick)
            .padding(horizontal = 14.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Text(label, Modifier.weight(1f), fontSize = 16.sp)
        MobileRadioDot(selected)
    }
}

@Composable
private fun MobileRadioDot(selected: Boolean) {
    Box(
        modifier = Modifier.size(20.dp).border(
            width = 1.dp,
            color = if (selected) MaterialTheme.colorScheme.primary else MaterialTheme.colorScheme.onSurfaceVariant,
            shape = CircleShape,
        ),
        contentAlignment = Alignment.Center,
    ) {
        if (selected) {
            Box(Modifier.size(10.dp).clip(CircleShape).background(MaterialTheme.colorScheme.primary))
        }
    }
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
internal fun MobilePendingUiSheet(
    controller: MobileRuntimeController,
    request: PendingUiView,
    onDismiss: () -> Unit,
) {
    var value by remember(request.id) { mutableStateOf(request.initialValue) }
    var selected by remember(request.id) { mutableStateOf(request.options.firstOrNull()?.value) }
    val answers = remember(request.id) { mutableStateMapOf<String, String>() }

    GlassBottomSheet(onDismissRequest = {}) {
        Column(
            modifier = Modifier.verticalScroll(rememberScrollState())
                .padding(horizontal = 22.dp, vertical = 12.dp),
            verticalArrangement = Arrangement.spacedBy(12.dp),
        ) {
            Text(request.title, fontSize = 18.sp, fontWeight = FontWeight.Bold)
            if (request.message.isNotBlank()) {
                Text(
                    request.message,
                    fontSize = 14.sp,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
            }
            when (request.type.lowercase(Locale.US)) {
                "confirm" -> {
                    Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(10.dp)) {
                        MobileSheetButton(
                            text = "取消",
                            modifier = Modifier.weight(1f),
                            accent = false,
                            onClick = {
                                controller.respondPending(
                                    request,
                                    JSONObject().put("confirmed", false),
                                    onDismiss,
                                )
                            },
                        )
                        MobileSheetButton(
                            text = "确认",
                            modifier = Modifier.weight(1f),
                            onClick = {
                                controller.respondPending(
                                    request,
                                    JSONObject().put("confirmed", true),
                                    onDismiss,
                                )
                            },
                        )
                    }
                }
                "select" -> {
                    request.options.forEach { option ->
                        MobilePendingOption(
                            option = option,
                            selected = selected == option.value,
                            onClick = { selected = option.value },
                        )
                    }
                    MobileSheetButton(
                        text = "继续",
                        modifier = Modifier.fillMaxWidth(),
                        enabled = selected != null,
                        onClick = {
                            selected?.let {
                                controller.respondPending(request, JSONObject().put("value", it), onDismiss)
                            }
                        },
                    )
                }
                "input", "editor" -> {
                    MobilePendingTextField(
                        value = value,
                        onValueChange = { value = it },
                        placeholder = request.placeholder ?: "请输入",
                        multiline = request.multiline || request.type.equals("editor", ignoreCase = true),
                    )
                    MobileSheetButton(
                        text = "提交",
                        modifier = Modifier.fillMaxWidth(),
                        onClick = {
                            controller.respondPending(request, JSONObject().put("value", value), onDismiss)
                        },
                    )
                }
                "questions" -> {
                    request.questions.forEach { question ->
                        Column(verticalArrangement = Arrangement.spacedBy(6.dp)) {
                            Text(question.label, fontSize = 16.sp, fontWeight = FontWeight.Medium)
                            question.options.forEach { option ->
                                MobilePendingOption(
                                    option = option,
                                    selected = answers[question.id] == option.value,
                                    onClick = { answers[question.id] = option.value },
                                )
                            }
                            if (question.options.isEmpty() || question.allowOther) {
                                MobilePendingTextField(
                                    value = answers[question.id].orEmpty(),
                                    onValueChange = { answers[question.id] = it },
                                    placeholder = question.placeholder ?: "请输入",
                                    multiline = question.type.equals("editor", ignoreCase = true),
                                )
                            }
                        }
                    }
                    MobileSheetButton(
                        text = "提交",
                        modifier = Modifier.fillMaxWidth(),
                        onClick = {
                            controller.respondPending(
                                request,
                                JSONObject().put("answers", JSONArray().apply {
                                    request.questions.forEach { question ->
                                        put(answers[question.id]?.takeIf { it.isNotBlank() } ?: JSONObject.NULL)
                                    }
                                }),
                                onDismiss,
                            )
                        },
                    )
                }
                else -> {
                    Text(
                        "暂不支持的请求类型：${request.type}",
                        fontSize = 14.sp,
                        color = MaterialTheme.colorScheme.error,
                    )
                }
            }
            if (!request.type.equals("confirm", ignoreCase = true)) {
                MobileSheetButton(
                    text = "取消",
                    modifier = Modifier.fillMaxWidth(),
                    accent = false,
                    onClick = {
                        controller.respondPending(request, JSONObject().put("cancelled", true), onDismiss)
                    },
                )
            }
            Spacer(Modifier.height(10.dp))
        }
    }
}

@Composable
private fun MobilePendingOption(
    option: PendingOptionView,
    selected: Boolean,
    onClick: () -> Unit,
) {
    Row(
        modifier = Modifier.fillMaxWidth()
            .heightIn(min = 52.dp)
            .clip(RoundedCornerShape(18.dp))
            .background(
                if (selected) MaterialTheme.colorScheme.primary.copy(alpha = .13f)
                else MaterialTheme.colorScheme.onSurface.copy(alpha = .08f),
            )
            .glassClick(onClick = onClick)
            .padding(horizontal = 14.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        MobileRadioDot(selected)
        Column(Modifier.weight(1f).padding(start = 10.dp), verticalArrangement = Arrangement.spacedBy(2.dp)) {
            Text(option.label, fontSize = 16.sp)
            option.detail?.let {
                Text(it, fontSize = 14.sp, color = MaterialTheme.colorScheme.onSurfaceVariant)
            }
        }
    }
}

@Composable
private fun MobilePendingTextField(
    value: String,
    onValueChange: (String) -> Unit,
    placeholder: String,
    multiline: Boolean,
) {
    OutlinedTextField(
        value = value,
        onValueChange = onValueChange,
        modifier = Modifier.fillMaxWidth(),
        placeholder = { Text(placeholder, fontSize = 15.sp) },
        minLines = if (multiline) 4 else 1,
        maxLines = if (multiline) 8 else 1,
        keyboardOptions = KeyboardOptions(
            keyboardType = if (multiline) KeyboardType.Text else KeyboardType.Text,
            imeAction = if (multiline) ImeAction.Default else ImeAction.Done,
        ),
        shape = RoundedCornerShape(18.dp),
    )
}

@Composable
private fun MobileSheetButton(
    text: String,
    modifier: Modifier,
    onClick: () -> Unit,
    accent: Boolean = true,
    enabled: Boolean = true,
) {
    val shape = CircleShape
    if (accent) {
        AccentPanel(
            modifier = modifier.heightIn(min = 52.dp)
                .clip(shape)
                .glassClick(enabled = enabled, onClick = onClick),
            shape = shape,
        ) {
            Box(Modifier.fillMaxWidth().heightIn(min = 52.dp), contentAlignment = Alignment.Center) {
                Text(text, fontSize = 16.sp, fontWeight = FontWeight.SemiBold, color = Color.White)
            }
        }
    } else {
        GlassPanel(
            modifier = modifier.heightIn(min = 52.dp)
                .glassClick(enabled = enabled, onClick = onClick),
            shape = shape,
            high = true,
        ) {
            Box(Modifier.fillMaxWidth().heightIn(min = 52.dp), contentAlignment = Alignment.Center) {
                Text(text, fontSize = 16.sp, fontWeight = FontWeight.SemiBold)
            }
        }
    }
}

private fun mobileTruncate(value: String, max: Int): String =
    if (value.length <= max) value else value.take(max) + "…"
