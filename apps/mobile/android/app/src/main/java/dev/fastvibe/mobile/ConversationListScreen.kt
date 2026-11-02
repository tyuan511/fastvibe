package dev.fastvibe.mobile

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
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import java.util.concurrent.TimeUnit

@Composable
internal fun ConversationCatalogScreen(
    controller: MobileRuntimeController,
    onOpen: (String) -> Unit,
    onCreate: () -> Unit,
    filter: ConversationCatalogFilter = ConversationCatalogFilter(),
) {
    var query by rememberSaveable { mutableStateOf("") }
    var managedConversation by remember { mutableStateOf<ConversationView?>(null) }

    managedConversation?.let { conversation ->
        ConversationCatalogActionsDialog(
            controller = controller,
            conversation = conversation,
            onDismiss = { managedConversation = null },
        )
    }

    val connected = controller.state.connection == "connected"
    val conversations = remember(controller.state.workspace, filter, query, connected) {
        if (!connected) {
            emptyList()
        } else {
            selectConversationCatalog(controller.state.workspace, filter, query)
        }
    }
    val listState = rememberLazyListState()

    LazyColumn(
        state = listState,
        modifier = Modifier.fillMaxSize(),
        contentPadding = PaddingValues(start = 16.dp, end = 16.dp, bottom = 116.dp),
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
            itemsIndexed(
                items = conversations,
                key = { _, conversation -> conversation.id },
            ) { index, conversation ->
                val shape = when {
                    conversations.size == 1 -> RoundedCornerShape(24.dp)
                    index == 0 -> RoundedCornerShape(topStart = 24.dp, topEnd = 24.dp, bottomStart = 0.dp, bottomEnd = 0.dp)
                    index == conversations.lastIndex -> RoundedCornerShape(topStart = 0.dp, topEnd = 0.dp, bottomStart = 24.dp, bottomEnd = 24.dp)
                    else -> RoundedCornerShape(0.dp)
                }
                GlassPanel(
                    modifier = Modifier.fillMaxWidth(),
                    shape = shape,
                ) {
                    ConversationCatalogRow(
                        conversation = conversation,
                        modifier = Modifier.fillMaxWidth(),
                        onOpen = { onOpen(conversation.id) },
                        onManage = { managedConversation = conversation },
                    )
                }
            }
        }
    }
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
                    lineHeight = 23.5.sp,
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
                                lineHeight = 23.5.sp,
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
        Column(Modifier.fillMaxWidth().verticalScroll(rememberScrollState()).padding(horizontal = 22.dp, vertical = 12.dp), verticalArrangement = Arrangement.spacedBy(14.dp)) {
            Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
                Text("筛选会话", Modifier.weight(1f), fontSize = 18.sp, fontWeight = FontWeight.Bold)
                GlassIconButton(R.drawable.fv_x, "关闭会话筛选", onDismiss)
            }
            Text("状态", fontSize = 13.sp, fontWeight = FontWeight.SemiBold, color = MaterialTheme.colorScheme.onSurfaceVariant)
            FlowRow(horizontalArrangement = Arrangement.spacedBy(8.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
                statuses.forEach { (value, label) ->
                    ConversationFilterChoice(label, filter.status == value) { onChange(filter.copy(status = value)) }
                }
            }
            Text("项目", fontSize = 13.sp, fontWeight = FontWeight.SemiBold, color = MaterialTheme.colorScheme.onSurfaceVariant)
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
        Text(label, Modifier.weight(1f, fill = false), fontSize = 14.sp, maxLines = 1, overflow = TextOverflow.Ellipsis, color = if (selected) MaterialTheme.colorScheme.primary else MaterialTheme.colorScheme.onSurface)
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
    Column(
        modifier = modifier
            .combinedClickable(
                interactionSource = interaction,
                indication = null,
                role = Role.Button,
                onClick = onOpen,
                onLongClickLabel = "管理会话",
                onLongClick = onManage,
            )
            .padding(horizontal = 16.dp, vertical = 12.dp),
    ) {
        Row(verticalAlignment = Alignment.Top, horizontalArrangement = Arrangement.spacedBy(12.dp)) {
            Column(
                modifier = Modifier.weight(1f),
                verticalArrangement = Arrangement.spacedBy(3.dp),
            ) {
                Text(
                    text = conversation.title,
                    fontSize = 15.5.sp,
                    fontWeight = FontWeight.SemiBold,
                    maxLines = 1,
                    overflow = TextOverflow.Ellipsis,
                )
                Text(
                    text = conversation.subtitle.ifBlank { formatConversationTime(conversation.updatedAt) },
                    fontSize = 14.sp,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                    maxLines = 1,
                    overflow = TextOverflow.Ellipsis,
                )
            }
            Column(horizontalAlignment = Alignment.End, verticalArrangement = Arrangement.spacedBy(5.dp)) {
                relativeConversationTime(conversation.updatedAt).takeIf { it.isNotBlank() }?.let {
                    Text(it, fontSize = 13.sp, color = MaterialTheme.colorScheme.onSurfaceVariant, maxLines = 1)
                }
                when {
                    conversation.waiting -> ConversationStatus("等你操作", warning = true)
                    conversation.running -> ConversationStatus("运行中", warning = false)
                    conversation.unread -> ConversationUnreadDot()
                }
            }
        }
        Row(
            modifier = Modifier.padding(top = 7.dp),
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.spacedBy(5.dp),
        ) {
            ConversationCatalogIcon(
                resource = if (conversation.projectId.isNullOrBlank()) R.drawable.fv_message_square else R.drawable.fv_folder,
                contentDescription = "项目",
                modifier = Modifier.size(14.dp),
                tint = MaterialTheme.colorScheme.onSurfaceVariant,
            )
            Text(
                text = conversation.projectName ?: "未归属项目",
                fontSize = 12.sp,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
                maxLines = 1,
                overflow = TextOverflow.Ellipsis,
            )
        }
    }
}

@Composable
private fun ConversationStatus(label: String, warning: Boolean) {
    Box(
        modifier = Modifier
            .clip(CircleShape)
            .background(
                if (warning) Color(0xFFFF9500).copy(alpha = .16f)
                else MaterialTheme.colorScheme.primary.copy(alpha = .14f),
            )
            .padding(horizontal = 8.dp, vertical = 3.dp),
    ) {
        Text(
            text = label,
            fontSize = 12.sp,
            fontWeight = FontWeight.SemiBold,
            color = if (warning) Color(0xFFFF9500) else MaterialTheme.colorScheme.primary,
            maxLines = 1,
        )
    }
}

@Composable
private fun ConversationUnreadDot() {
    Box(
        modifier = Modifier
            .padding(top = 4.dp, end = 3.dp)
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
        Column(Modifier.fillMaxWidth().padding(horizontal = 22.dp, vertical = 12.dp), verticalArrangement = Arrangement.spacedBy(14.dp)) {
            Text(if (deleting) "删除会话？" else "管理会话", fontSize = 18.sp, fontWeight = FontWeight.Bold)
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
    val age = (System.currentTimeMillis() - timestamp).coerceAtLeast(0L)
    return when {
        age < TimeUnit.MINUTES.toMillis(1) -> "刚刚"
        age < TimeUnit.HOURS.toMillis(1) -> "${age / TimeUnit.MINUTES.toMillis(1)} 分钟"
        age < TimeUnit.DAYS.toMillis(1) -> "${age / TimeUnit.HOURS.toMillis(1)} 小时"
        age < TimeUnit.DAYS.toMillis(2) -> "昨天"
        else -> formatConversationTime(timestamp)
    }
}
