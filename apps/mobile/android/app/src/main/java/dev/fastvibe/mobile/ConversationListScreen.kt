package dev.fastvibe.mobile

import androidx.compose.animation.core.LinearEasing
import androidx.compose.animation.core.animateFloat
import androidx.compose.animation.core.infiniteRepeatable
import androidx.compose.animation.core.rememberInfiniteTransition
import androidx.compose.animation.core.tween
import androidx.compose.foundation.Image
import androidx.compose.foundation.background
import androidx.compose.foundation.combinedClickable
import androidx.compose.foundation.interaction.MutableInteractionSource
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.FlowRow
import androidx.compose.foundation.layout.ExperimentalLayoutApi
import androidx.compose.foundation.verticalScroll
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.LazyListState
import androidx.compose.foundation.lazy.itemsIndexed
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.BasicTextField
import androidx.compose.foundation.ExperimentalFoundationApi
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.draw.clipToBounds
import androidx.compose.ui.draw.rotate
import androidx.compose.ui.layout.layout
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.ColorFilter
import androidx.compose.ui.res.painterResource
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.semantics.stateDescription
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.Constraints
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import java.util.concurrent.TimeUnit

@Composable
internal fun ConversationCatalogScreen(
    controller: MobileRuntimeController,
    onOpen: (String) -> Unit,
    onCreate: () -> Unit,
    filter: ConversationCatalogFilter = ConversationCatalogFilter(),
    contentTop: androidx.compose.ui.unit.Dp = 0.dp,
) {
    var managedConversation by remember { mutableStateOf<ConversationView?>(null) }
    managedConversation?.let { conversation ->
        ConversationCatalogActionsDialog(controller, conversation) { managedConversation = null }
    }
    ConversationCatalogContent(
        workspace = controller.state.workspace,
        connected = controller.state.connection == "connected",
        onOpen = onOpen,
        onCreate = onCreate,
        onManage = { managedConversation = it },
        filter = filter,
        contentTop = contentTop,
    )
}

@Composable
internal fun ConversationCatalogContent(
    workspace: WorkspaceView,
    connected: Boolean,
    onOpen: (String) -> Unit,
    onCreate: () -> Unit,
    onManage: (ConversationView) -> Unit,
    filter: ConversationCatalogFilter = ConversationCatalogFilter(),
    contentTop: androidx.compose.ui.unit.Dp = 0.dp,
) {
    var query by rememberSaveable { mutableStateOf("") }
    val conversations = remember(workspace, filter, query, connected) {
        if (connected) selectConversationCatalog(workspace, filter, query) else emptyList()
    }
    val listState = rememberLazyListState()

    Box(Modifier.fillMaxSize().clipToBounds()) {
        if (conversations.isNotEmpty()) {
            ConversationCatalogGlass(
                listState = listState,
                conversationCount = conversations.size,
                modifier = Modifier.matchParentSize().padding(horizontal = 16.dp),
            )
        }
        LazyColumn(
            state = listState,
            modifier = Modifier.fillMaxSize(),
            contentPadding = PaddingValues(start = 16.dp, top = contentTop, end = 16.dp, bottom = 112.dp),
            verticalArrangement = Arrangement.spacedBy(0.dp),
        ) {
            item(key = "search") {
                ConversationSearchField(
                    value = query,
                    onValueChange = { query = it },
                    modifier = Modifier
                        .fillMaxWidth()
                        .padding(bottom = 10.dp),
                )
            }

            if (!connected) {
                item(key = "disconnected") {
                    ConversationCatalogEmpty(
                        title = "连接电脑后查看会话",
                        detail = "选择一台电脑并建立连接，真实会话目录会显示在这里。",
                        action = null,
                        onAction = onCreate,
                    )
                }
            } else if (conversations.isEmpty() && (query.isNotBlank() || filter != ConversationCatalogFilter())) {
                item(key = "no-match") {
                    Text(
                        "没有匹配的会话",
                        Modifier.fillMaxWidth().padding(horizontal = 8.dp, vertical = 40.dp),
                        fontSize = 14.sp,
                        lineHeight = 20.58.sp,
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                        textAlign = androidx.compose.ui.text.style.TextAlign.Center,
                    )
                }
            } else if (conversations.isEmpty()) {
                item(key = "empty") {
                    ConversationCatalogEmpty(
                        title = if (query.isBlank() && filter == ConversationCatalogFilter()) "还没有会话" else "没有匹配的会话",
                        detail = if (query.isBlank() && filter == ConversationCatalogFilter()) "新建会话后，它会出现在这里。" else "尝试调整筛选条件或搜索内容。",
                        action = if (query.isBlank()) "新建会话" else null,
                        onAction = onCreate,
                    )
                }
            } else {
                itemsIndexed(conversations, key = { _, conversation -> "conversation:${conversation.id}" }) { index, conversation ->
                    Box {
                        ConversationCatalogRow(
                            conversation = conversation,
                            modifier = Modifier.fillMaxWidth(),
                            onOpen = { onOpen(conversation.id) },
                            onManage = { onManage(conversation) },
                        )
                        if (index > 0) HorizontalDivider(
                            modifier = Modifier.padding(start = 16.dp),
                            thickness = 1.dp,
                            color = MaterialTheme.colorScheme.outlineVariant,
                        )
                    }
                }
            }
        }
    }
}

@Composable
private fun ConversationCatalogGlass(
    listState: LazyListState,
    conversationCount: Int,
    modifier: Modifier = Modifier,
) {
    // Read only measured rows, during layout: scrolling never composes the catalog.
    // Lazy offsets are relative to the content origin, before the top padding.
    GlassPanel(
        modifier.layout { measurable, constraints ->
            val info = listState.layoutInfo
            val first = info.visibleItemsInfo.firstOrNull { it.index in 1..conversationCount }
            val last = info.visibleItemsInfo.lastOrNull { it.index in 1..conversationCount }
            val viewportHeight = constraints.maxHeight
            // Keep off-screen corners and their shadows outside the clipped viewport.
            val overscan = 32.dp.roundToPx()
            val top = when {
                first == null -> 0
                first.index == 1 -> first.offset - info.viewportStartOffset
                else -> -overscan
            }
            val bottom = when {
                last == null -> top
                last.index == conversationCount -> last.offset + last.size - info.viewportStartOffset
                else -> viewportHeight + overscan
            }
            val panel = measurable.measure(Constraints.fixed(constraints.maxWidth, (bottom - top).coerceAtLeast(0)))
            layout(constraints.maxWidth, viewportHeight) { panel.placeRelative(0, top) }
        },
        RoundedCornerShape(24.dp),
    ) {}
}

@Composable
private fun ConversationSearchField(
    value: String,
    onValueChange: (String) -> Unit,
    modifier: Modifier = Modifier,
) {
    GlassPanel(
        modifier = modifier.height(40.dp),
        shape = RoundedCornerShape(20.dp),
        high = true,
    ) {
        Row(
            modifier = Modifier
                .fillMaxSize()
                .padding(horizontal = 12.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            ConversationCatalogIcon(
                resource = R.drawable.fv_search,
                contentDescription = "搜索",
                modifier = Modifier.size(20.dp),
                tint = MaterialTheme.colorScheme.onSurfaceVariant,
            )
            BasicTextField(
                value = value,
                onValueChange = onValueChange,
                modifier = Modifier
                    .weight(1f)
                    .padding(start = 8.dp),
                singleLine = true,
                textStyle = TextStyle(
                    color = MaterialTheme.colorScheme.onSurface,
                    fontSize = 16.sp,
                    lineHeight = 23.52.sp,
                    letterSpacing = 0.sp,
                ),
                keyboardOptions = KeyboardOptions(imeAction = ImeAction.Search),
                decorationBox = { field ->
                    Box {
                        if (value.isEmpty()) {
                            Text(
                                text = "搜索会话",
                                color = MaterialTheme.colorScheme.onSurfaceVariant,
                                fontSize = 16.sp,
                                lineHeight = 23.52.sp,
                                letterSpacing = 0.sp,
                            )
                        }
                        field()
                    }
                },
            )
        }
    }
}

@OptIn(ExperimentalLayoutApi::class)
@Composable
internal fun ConversationFilterSheet(
    workspace: WorkspaceView,
    filter: ConversationCatalogFilter,
    onChange: (ConversationCatalogFilter) -> Unit,
    onDismiss: () -> Unit,
) {
    val projects = workspace.projects.filter { it.id != UNASSIGNED_CONVERSATION_PROJECT }
        .distinctBy { it.id }
    val statuses = listOf("all" to "全部会话", "running" to "运行中", "waiting" to "等你操作", "unread" to "未读", "archived" to "已归档")
    GlassBottomSheet(onDismissRequest = onDismiss) {
        Column(Modifier.fillMaxWidth().verticalScroll(rememberScrollState()).padding(horizontal = 22.dp).padding(top = 18.dp, bottom = 22.dp), verticalArrangement = Arrangement.spacedBy(14.dp)) {
            Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
                Text("筛选会话", Modifier.weight(1f), fontSize = 18.sp, lineHeight = 26.46.sp, fontWeight = FontWeight.Bold)
                GlassIconButton(R.drawable.fv_x, "关闭会话筛选", onDismiss)
            }
            Text("状态", fontSize = 13.sp, lineHeight = 19.11.sp, fontWeight = FontWeight.SemiBold, color = MaterialTheme.colorScheme.onSurfaceVariant)
            FlowRow(horizontalArrangement = Arrangement.spacedBy(8.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
                statuses.forEach { (value, label) ->
                    ConversationFilterChoice(label, filter.status == value) { onChange(filter.copy(status = value)) }
                }
            }
            Text("项目", fontSize = 13.sp, lineHeight = 19.11.sp, fontWeight = FontWeight.SemiBold, color = MaterialTheme.colorScheme.onSurfaceVariant)
            FlowRow(horizontalArrangement = Arrangement.spacedBy(8.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
                ConversationFilterChoice("所有项目", filter.projectId == null) { onChange(filter.copy(projectId = null)) }
                projects.forEach { project ->
                    ConversationFilterChoice(project.name, filter.projectId == project.id) { onChange(filter.copy(projectId = project.id)) }
                }
                ConversationFilterChoice("未归属项目", filter.projectId == UNASSIGNED_CONVERSATION_PROJECT) { onChange(filter.copy(projectId = UNASSIGNED_CONVERSATION_PROJECT)) }
            }
            AccentPanel(Modifier.fillMaxWidth().height(52.dp).glassClick(onClick = onDismiss), CircleShape) {
                Box(Modifier.fillMaxSize(), contentAlignment = Alignment.Center) { Text("完成", fontSize = 16.sp, fontWeight = FontWeight.SemiBold, color = Color.White) }
            }
        }
    }
}

@Composable
private fun ConversationFilterChoice(label: String, selected: Boolean, onClick: () -> Unit) {
    Row(Modifier.clip(RoundedCornerShape(14.dp))
        .background(if (selected) MaterialTheme.colorScheme.primary.copy(alpha = .13f) else MaterialTheme.colorScheme.surfaceVariant)
        .semantics { stateDescription = if (selected) "已选择" else "未选择" }
        .glassClick(onClick = onClick).heightIn(min = 40.dp).padding(horizontal = 12.dp, vertical = 8.dp),
        verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
        Text(label, Modifier.weight(1f, fill = false), fontSize = 14.sp, lineHeight = 20.58.sp, maxLines = 1, overflow = TextOverflow.Ellipsis, color = if (selected) MaterialTheme.colorScheme.primary else MaterialTheme.colorScheme.onSurface)
        Box(Modifier.size(14.dp)) {
            if (selected) ConversationCatalogIcon(R.drawable.fv_check, null, Modifier.size(14.dp), MaterialTheme.colorScheme.primary)
        }
    }
}

@OptIn(ExperimentalFoundationApi::class)
@Composable
private fun ConversationCatalogRow(
    conversation: ConversationView,
    modifier: Modifier = Modifier,
    onOpen: () -> Unit,
    onManage: () -> Unit,
) {
    val interaction = remember { MutableInteractionSource() }
    Row(
        modifier = modifier
            .heightIn(min = 70.dp)
            .combinedClickable(
                interactionSource = interaction,
                indication = null,
                role = Role.Button,
                onClick = onOpen,
                onLongClickLabel = "管理会话",
                onLongClick = onManage,
            )
            .padding(horizontal = 16.dp, vertical = 12.dp),
        verticalAlignment = Alignment.Top,
        horizontalArrangement = Arrangement.spacedBy(12.dp),
    ) {
        Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(3.dp)) {
            Text(
                text = conversation.title,
                fontSize = 15.5.sp,
                lineHeight = 22.785.sp,
                fontWeight = FontWeight.SemiBold,
                maxLines = 1,
                overflow = TextOverflow.Ellipsis,
            )
            Text(
                text = conversation.subtitle.ifBlank { formatConversationTime(conversation.updatedAt) },
                fontSize = 14.sp,
                lineHeight = 20.58.sp,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
                maxLines = 1,
                overflow = TextOverflow.Ellipsis,
            )
            Row(
                modifier = Modifier.padding(top = 3.dp),
                verticalAlignment = Alignment.CenterVertically,
                horizontalArrangement = Arrangement.spacedBy(5.dp),
            ) {
                ConversationCatalogIcon(
                    resource = if (conversation.projectId.isNullOrBlank() || conversation.projectId == UNASSIGNED_CONVERSATION_PROJECT) R.drawable.fv_message_square else R.drawable.fv_folder,
                    contentDescription = "项目",
                    modifier = Modifier.size(13.dp),
                    tint = MaterialTheme.colorScheme.onSurfaceVariant,
                )
                Text(
                    text = conversation.projectName ?: "未归属项目",
                    fontSize = 12.sp,
                    lineHeight = 17.64.sp,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                    maxLines = 1,
                    overflow = TextOverflow.Ellipsis,
                )
            }
        }
        Column(
            Modifier.padding(top = 2.dp),
            horizontalAlignment = Alignment.End,
            verticalArrangement = Arrangement.spacedBy(7.dp),
        ) {
            relativeConversationTime(conversation.updatedAt).takeIf { it.isNotBlank() }?.let {
                Text(it, fontSize = 13.sp, lineHeight = 19.11.sp, color = MaterialTheme.colorScheme.onSurfaceVariant, maxLines = 1)
            }
            when {
                conversation.waiting -> ConversationStatus("等你操作", warning = true)
                conversation.running -> ConversationStatus("运行中", warning = false)
                conversation.unread -> ConversationUnreadDot()
            }
        }
    }
}

@Composable
private fun ConversationStatus(label: String, warning: Boolean) {
    val dark = MaterialTheme.colorScheme.background.red < .1f
    val color = if (warning) { if (dark) Color(0xFFFF9F0A) else Color(0xFFFF9500) }
        else MaterialTheme.colorScheme.primary
    Row(
        modifier = Modifier.height(22.dp).clip(CircleShape)
            .background(color.copy(alpha = if (warning) .17f else .14f))
            .padding(horizontal = 8.dp),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(4.dp),
    ) {
        if (warning) {
            PrototypeLineIcon(
                path = "M18 11V6a2 2 0 0 0-2-2a2 2 0 0 0-2 2 M14 10V4a2 2 0 0 0-2-2a2 2 0 0 0-2 2v2 M10 10.5V6a2 2 0 0 0-2-2a2 2 0 0 0-2 2v8 M18 8a2 2 0 1 1 4 0v6a8 8 0 0 1-8 8h-2c-2.8 0-4.5-.86-5.99-2.34l-3.6-3.6a2 2 0 0 1 2.83-2.82L7 15",
                modifier = Modifier.size(12.dp),
                tint = color,
                strokeWidth = 2f,
            )
        } else {
            val transition = rememberInfiniteTransition(label = "catalog-running")
            val angle by transition.animateFloat(0f, 360f, infiniteRepeatable(tween(1000, easing = LinearEasing)), label = "rotation")
            ConversationCatalogIcon(R.drawable.fv_loader_circle, null, Modifier.size(12.dp).rotate(angle), color)
        }
        Text(label, fontSize = 12.sp, lineHeight = 17.64.sp, fontWeight = FontWeight.SemiBold, color = color, maxLines = 1)
    }
}

@Composable
private fun ConversationUnreadDot() {
    Box(
        modifier = Modifier
            .size(8.dp)
            .clip(CircleShape)
            .background(MaterialTheme.colorScheme.primary),
    )
}

@Composable
private fun ConversationCatalogEmpty(
    title: String,
    detail: String,
    action: String?,
    onAction: () -> Unit,
) {
    Column(
        modifier = Modifier
            .fillMaxWidth()
            .padding(horizontal = 16.dp, vertical = 42.dp),
        horizontalAlignment = Alignment.CenterHorizontally,
        verticalArrangement = Arrangement.spacedBy(10.dp),
    ) {
        ConversationCatalogIcon(
            resource = R.drawable.fv_message_square,
            contentDescription = null,
            modifier = Modifier.size(32.dp),
            tint = MaterialTheme.colorScheme.onSurfaceVariant.copy(alpha = .7f),
        )
        Text(text = title, fontWeight = FontWeight.SemiBold)
        Text(
            text = detail,
            fontSize = 14.sp,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
            maxLines = 3,
            overflow = TextOverflow.Ellipsis,
        )
        if (action != null) TextButton(onClick = onAction) { Text(action) }
    }
}

@Composable
private fun ConversationCatalogActionsDialog(
    controller: MobileRuntimeController,
    conversation: ConversationView,
    onDismiss: () -> Unit,
) {
    var title by remember(conversation.id) { mutableStateOf(conversation.title) }
    var deleting by remember(conversation.id) { mutableStateOf(false) }

    GlassBottomSheet(onDismissRequest = onDismiss) {
        Column(Modifier.fillMaxWidth().padding(horizontal = 22.dp).padding(top = 18.dp, bottom = 22.dp), verticalArrangement = Arrangement.spacedBy(14.dp)) {
            Text(if (deleting) "删除会话？" else "管理会话", fontSize = 18.sp, lineHeight = 26.46.sp, fontWeight = FontWeight.Bold)
            if (deleting) {
                Text("删除“${conversation.title}”后无法从会话列表恢复。", fontSize = 14.sp, color = MaterialTheme.colorScheme.onSurfaceVariant)
            } else {
                OutlinedTextField(
                    value = title,
                    onValueChange = { title = it },
                    label = { Text("会话标题") },
                    singleLine = true,
                    shape = RoundedCornerShape(18.dp),
                    modifier = Modifier.fillMaxWidth(),
                )
                Text("删除会话", Modifier.glassClick { deleting = true }.padding(vertical = 8.dp), fontSize = 14.sp, color = MaterialTheme.colorScheme.error)
            }
            AccentPanel(Modifier.fillMaxWidth().height(52.dp).glassClick(enabled = deleting || title.isNotBlank()) {
                if (deleting) controller.deleteConversation(conversation.id, onDismiss)
                else controller.renameConversation(conversation.id, title.trim(), onDismiss)
            }) {
                Box(Modifier.fillMaxSize(), contentAlignment = Alignment.Center) {
                    Text(if (deleting) "删除" else "保存", fontSize = 16.sp, fontWeight = FontWeight.SemiBold, color = Color.White)
                }
            }
            GlassPanel(Modifier.fillMaxWidth().height(52.dp).glassClick(onClick = onDismiss), CircleShape, high = true) {
                Box(Modifier.fillMaxSize(), contentAlignment = Alignment.Center) { Text("取消", fontSize = 16.sp, fontWeight = FontWeight.SemiBold) }
            }
        }
    }
}

@Composable
private fun ConversationCatalogIcon(
    resource: Int,
    contentDescription: String?,
    modifier: Modifier,
    tint: Color,
) {
    Image(
        painter = painterResource(resource),
        contentDescription = contentDescription,
        modifier = modifier,
        colorFilter = ColorFilter.tint(tint),
    )
}

private fun relativeConversationTime(timestamp: Long?): String {
    if (timestamp == null || timestamp <= 0L) return ""
    val now = java.time.ZonedDateTime.now()
    val then = java.time.Instant.ofEpochMilli(timestamp).atZone(now.zone)
    val age = (System.currentTimeMillis() - timestamp).coerceAtLeast(0L)
    val day = then.toLocalDate()
    val today = now.toLocalDate()
    val weekStart = today.with(java.time.temporal.TemporalAdjusters.previousOrSame(java.time.DayOfWeek.MONDAY))
    return when {
        age < TimeUnit.MINUTES.toMillis(1) -> "刚刚"
        age < TimeUnit.HOURS.toMillis(1) -> "${age / TimeUnit.MINUTES.toMillis(1)} 分钟"
        day == today -> "${age / TimeUnit.HOURS.toMillis(1)} 小时"
        day == today.minusDays(1) -> "昨天"
        !day.isBefore(weekStart) -> "周${listOf("一", "二", "三", "四", "五", "六", "日")[day.dayOfWeek.value - 1]}"
        !day.isBefore(weekStart.minusWeeks(1)) -> "上周"
        else -> java.text.DateFormat.getDateInstance(java.text.DateFormat.SHORT).format(java.util.Date(timestamp))
    }
}
