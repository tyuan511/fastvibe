package dev.fastvibe.mobile

import androidx.compose.foundation.Image
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.TextButton
import androidx.compose.runtime.remember
import androidx.compose.ui.draw.alpha
import androidx.compose.ui.draw.drawWithContent
import androidx.compose.ui.graphics.SolidColor
import androidx.compose.ui.graphics.StrokeCap
import androidx.compose.ui.graphics.StrokeJoin
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.graphics.vector.PathParser
import androidx.compose.ui.unit.Dp
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.ColorFilter
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.compose.ui.res.painterResource

private const val MonitorOffPath = "M12 17v4 M17 17H4a2 2 0 0 1-2-2V5a2 2 0 0 1 1.184-1.826 M2 2l20 20 M8 21h8 M8.656 3H20a2 2 0 0 1 2 2v10a2 2 0 0 1-.293 1.042"

/** The two prototype Lucide glyphs absent from the bundled drawable set. */
@Composable
internal fun PrototypeLineIcon(path: String, modifier: Modifier, tint: Color, strokeWidth: Float = 1.5f) {
    val vector = remember(path, strokeWidth) {
        ImageVector.Builder("prototype-glyph", 24.dp, 24.dp, 24f, 24f).apply {
            addPath(
                pathData = PathParser().parsePathString(path).toNodes(),
                fill = null,
                stroke = SolidColor(Color.Black),
                strokeLineWidth = strokeWidth,
                strokeLineCap = StrokeCap.Round,
                strokeLineJoin = StrokeJoin.Round,
            )
        }.build()
    }
    Image(vector, null, modifier, colorFilter = ColorFilter.tint(tint))
}

@Composable
internal fun ComputersHomeContent(
    devices: List<DeviceView>,
    account: String?,
    loading: Boolean,
    selectedDeviceId: String?,
    busy: Boolean,
    onRefresh: () -> Unit,
    onOffline: (DeviceView) -> Unit,
    onConnect: (DeviceView) -> Unit,
    contentTop: Dp = 0.dp,
) {
    LazyColumn(
        modifier = Modifier.fillMaxSize(),
        contentPadding = PaddingValues(start = 16.dp, top = contentTop, end = 16.dp, bottom = 36.dp),
    ) {
        item(key = "account") {
            Row(
                Modifier.fillMaxWidth().padding(start = 4.dp, end = 4.dp, top = 4.dp, bottom = 20.dp),
                verticalAlignment = Alignment.CenterVertically,
                horizontalArrangement = Arrangement.spacedBy(12.dp),
            ) {
                AccentPanel(Modifier.size(40.dp), CircleShape) {
                    Box(Modifier.fillMaxSize(), contentAlignment = Alignment.Center) {
                        Text(account?.take(1)?.uppercase() ?: "F", fontSize = 16.sp, lineHeight = 23.52.sp, fontWeight = FontWeight.Bold, color = Color.White)
                    }
                }
                Column(Modifier.weight(1f)) {
                    Text(account ?: "FastVibe 账号", fontSize = 17.sp, lineHeight = 24.99.sp, fontWeight = FontWeight.SemiBold, maxLines = 1, overflow = TextOverflow.Ellipsis)
                    Text("${devices.count { it.online }} 台在线 · ${devices.count { !it.online }} 台离线", fontSize = 13.sp, lineHeight = 19.11.sp, color = MaterialTheme.colorScheme.onSurfaceVariant)
                }
            }
        }
        when {
            loading -> item(key = "loading") {
                GlassPanel(Modifier.fillMaxWidth()) {
                    Row(Modifier.padding(16.dp), verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(10.dp)) {
                        CircularProgressIndicator(Modifier.size(20.dp), strokeWidth = 2.dp)
                        Text("正在查找你的电脑…", color = MaterialTheme.colorScheme.onSurfaceVariant)
                    }
                }
            }
            devices.isEmpty() -> item(key = "empty") {
                Column(Modifier.fillMaxWidth().padding(vertical = 42.dp), horizontalAlignment = Alignment.CenterHorizontally, verticalArrangement = Arrangement.spacedBy(10.dp)) {
                    SheetImage(R.drawable.fv_monitor, Modifier.size(36.dp), null, MaterialTheme.colorScheme.onSurfaceVariant)
                    Text("还没有找到电脑", fontWeight = FontWeight.SemiBold)
                    Text("在电脑端打开 FastVibe 并登录同一个账号。", fontSize = 14.sp, color = MaterialTheme.colorScheme.onSurfaceVariant, textAlign = androidx.compose.ui.text.style.TextAlign.Center)
                    TextButton(onClick = onRefresh) { Text("重新查找") }
                }
            }
            else -> items(devices, key = { it.id }) { device ->
                ComputerHomeRow(device, busy && selectedDeviceId == device.id) {
                    if (device.online) onConnect(device) else onOffline(device)
                }
                Spacer(Modifier.height(12.dp))
            }
        }
    }
}

@Composable
private fun ComputerHomeRow(device: DeviceView, connecting: Boolean, onClick: () -> Unit) {
    GlassPanel(Modifier.fillMaxWidth().glassClick(onClick = onClick), RoundedCornerShape(24.dp)) {
        Row(
            Modifier.fillMaxWidth().heightIn(min = 76.dp).padding(horizontal = 16.dp, vertical = 14.dp),
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.spacedBy(14.dp),
        ) {
            val laptop = device.name.contains("mbp", true) || device.name.contains("book", true) || device.name.contains("laptop", true)
            PrototypeTile(Modifier.alpha(if (device.online) 1f else .55f)) {
                if (!device.online) PrototypeLineIcon(MonitorOffPath, Modifier.size(20.dp), MaterialTheme.colorScheme.onSurface)
                else SheetImage(if (laptop) R.drawable.fv_laptop else R.drawable.fv_monitor, Modifier.size(20.dp), null, MaterialTheme.colorScheme.onSurface)
            }
            Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(5.dp)) {
                Text(device.name, Modifier.alpha(if (device.online) 1f else .55f), fontSize = 16.sp, lineHeight = 23.52.sp, fontWeight = FontWeight.SemiBold, maxLines = 1, overflow = TextOverflow.Ellipsis)
                ComputerHomeMeta(device)
            }
            if (connecting) CircularProgressIndicator(Modifier.size(20.dp), strokeWidth = 2.dp)
            else SheetImage(R.drawable.fv_chevron_right, Modifier.size(20.dp), null, MaterialTheme.colorScheme.onSurfaceVariant)
        }
    }
}

@OptIn(androidx.compose.foundation.layout.ExperimentalLayoutApi::class)
@Composable
private fun ComputerHomeMeta(device: DeviceView) {
    val dark = MaterialTheme.colorScheme.background.red < .1f
    val success = if (dark) Color(0xFF32D74B) else Color(0xFF34C759)
    val warning = if (dark) Color(0xFFFF9F0A) else Color(0xFFFF9500)
    val platform = when (device.platform.lowercase()) {
        "darwin", "macos" -> "macOS"
        "windows", "win32" -> "Windows"
        "linux" -> "Linux"
        else -> device.platform
    }
    androidx.compose.foundation.layout.FlowRow(
        horizontalArrangement = Arrangement.spacedBy(6.dp),
        verticalArrangement = Arrangement.spacedBy(0.dp),
        itemVerticalAlignment = Alignment.CenterVertically,
    ) {
        Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(6.dp)) {
            Box(Modifier.size(8.dp).background(if (device.online) success else MaterialTheme.colorScheme.onSurfaceVariant, CircleShape))
            Text(
                if (device.online) "在线 · $platform" else "离线 · ${device.lastOnline?.let { if (it.endsWith("在线")) it else "${it}在线" } ?: "最近未在线"}",
                fontSize = 13.sp, lineHeight = 19.11.sp, color = MaterialTheme.colorScheme.onSurfaceVariant,
            )
        }
        val relay = device.path?.lowercase() in listOf("relay", "中转")
        if (device.online && (relay || device.path?.lowercase() in listOf("direct", "直连"))) {
            val color = if (relay) warning else success
            Box(Modifier.height(22.dp).background(color.copy(alpha = if (relay) .17f else .15f), CircleShape).padding(horizontal = 8.dp), contentAlignment = Alignment.Center) {
                Text(if (relay) "中转" else "直连", fontSize = 12.sp, lineHeight = 17.64.sp, fontWeight = FontWeight.SemiBold, color = color)
            }
        }
    }
}

@Composable
private fun PrototypeTile(modifier: Modifier = Modifier, quiet: Boolean = false, content: @Composable () -> Unit) {
    val dark = MaterialTheme.colorScheme.background.red < .1f
    val shape = RoundedCornerShape(14.dp)
    Box(
        modifier.size(44.dp).clip(shape)
            .background(if (quiet) MaterialTheme.colorScheme.surfaceVariant else Color.White.copy(alpha = if (dark) .08f else .72f))
            .border(.5.dp, if (dark) Color.Black.copy(alpha = .5f) else Color.Black.copy(alpha = .06f), shape)
            .drawWithContent {
                drawContent()
                drawLine(Color.White.copy(alpha = if (dark) .16f else .95f), androidx.compose.ui.geometry.Offset(14.dp.toPx(), .5.dp.toPx()), androidx.compose.ui.geometry.Offset(size.width - 14.dp.toPx(), .5.dp.toPx()), 1.dp.toPx())
            },
        contentAlignment = Alignment.Center,
    ) { content() }
}

@Composable
internal fun ProjectSelectionSheet(
    projects: List<ProjectView>,
    creating: Boolean,
    onDismiss: () -> Unit,
    onSelect: (ProjectView?) -> Unit,
) {
    GlassBottomSheet(onDismissRequest = onDismiss) {
        Column(
            modifier = Modifier
                .fillMaxWidth()
                .padding(start = 22.dp, end = 22.dp, top = 28.dp, bottom = 22.dp),
        ) {
            SheetHeader(
                title = "新建会话",
                subtitle = "选择这次会话的项目",
                onDismiss = onDismiss,
            )
            Spacer(Modifier.height(30.dp))

            Column(
                modifier = Modifier
                    .fillMaxWidth()
                    .heightIn(max = 420.dp)
                    .verticalScroll(rememberScrollState()),
            ) {
                projects.forEachIndexed { index, project ->
                    ProjectSelectionRow(
                        project = project,
                        enabled = !creating,
                        showDivider = index > 0,
                        onClick = {
                            onSelect(project)
                            onDismiss()
                        },
                    )
                }
                ProjectSelectionRow(
                    project = null,
                    enabled = !creating,
                    showDivider = projects.isNotEmpty(),
                    onClick = {
                        onSelect(null)
                        onDismiss()
                    },
                )
            }
        }
    }
}

@Composable
private fun ProjectSelectionRow(
    project: ProjectView?,
    enabled: Boolean,
    showDivider: Boolean,
    onClick: () -> Unit,
) {
    if (showDivider) {
        HorizontalDivider(
            color = if (MaterialTheme.colorScheme.background.red < .1f) Color.White.copy(alpha = .09f) else Color(0xFF3C3C43).copy(alpha = .13f),
            thickness = .5.dp,
        )
    }

    Row(
        modifier = Modifier
            .fillMaxWidth()
            .heightIn(min = 76.dp)
            .clip(RoundedCornerShape(18.dp))
            .glassClick(enabled = enabled, onClick = onClick)
            .padding(vertical = 14.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        ProjectTile(unassigned = project == null)
        Spacer(Modifier.width(12.dp))
        Column(
            modifier = Modifier.weight(1f),
            verticalArrangement = Arrangement.spacedBy(4.dp),
        ) {
            Text(
                text = project?.name ?: "未归属项目",
                fontSize = 16.sp,
                lineHeight = 23.52.sp,
                fontWeight = FontWeight.SemiBold,
                maxLines = 1,
                overflow = TextOverflow.Ellipsis,
                color = MaterialTheme.colorScheme.onSurface.copy(alpha = if (enabled) 1f else .55f),
            )
            Text(
                text = project?.cwd ?: "不绑定项目，直接开始会话",
                fontSize = 13.sp,
                lineHeight = 19.11.sp,
                color = MaterialTheme.colorScheme.onSurfaceVariant.copy(alpha = MaterialTheme.colorScheme.onSurfaceVariant.alpha * if (enabled) 1f else .55f),
                maxLines = 1,
                overflow = TextOverflow.Ellipsis,
            )
        }
        Spacer(Modifier.width(10.dp))
        SheetImage(
            resource = R.drawable.fv_chevron_right,
            modifier = Modifier.size(18.dp),
            contentDescription = null,
            tint = MaterialTheme.colorScheme.onSurfaceVariant.copy(alpha = MaterialTheme.colorScheme.onSurfaceVariant.alpha * if (enabled) 1f else .55f),
        )
    }
}

@Composable
private fun ProjectTile(unassigned: Boolean) {
    PrototypeTile(quiet = unassigned) {
        SheetImage(
            resource = if (unassigned) R.drawable.fv_message_square else R.drawable.fv_folder,
            modifier = Modifier.size(20.dp),
            contentDescription = null,
            tint = if (unassigned) MaterialTheme.colorScheme.onSurfaceVariant else MaterialTheme.colorScheme.onSurface,
        )
    }
}

@Composable
internal fun OfflineComputerSheet(
    device: DeviceView,
    account: String?,
    onDismiss: () -> Unit,
) {
    GlassBottomSheet(onDismissRequest = onDismiss) {
        Column(
            modifier = Modifier
                .fillMaxWidth()
                .padding(start = 22.dp, end = 22.dp, top = 18.dp, bottom = 22.dp),
            verticalArrangement = Arrangement.spacedBy(14.dp),
        ) {
            Row(
                modifier = Modifier.fillMaxWidth(),
                horizontalArrangement = Arrangement.spacedBy(12.dp),
                verticalAlignment = Alignment.Top,
            ) {
                PrototypeTile(quiet = true) {
                    PrototypeLineIcon(MonitorOffPath, Modifier.size(20.dp), MaterialTheme.colorScheme.onSurfaceVariant)
                }
                Column(
                    modifier = Modifier.weight(1f),
                    verticalArrangement = Arrangement.spacedBy(0.dp),
                ) {
                    Text(
                        text = "${device.name} 不在线",
                        fontSize = 18.sp,
                        lineHeight = 26.46.sp,
                        fontWeight = FontWeight.Bold,
                        maxLines = 2,
                        overflow = TextOverflow.Ellipsis,
                    )
                    Text(
                        text = device.lastOnline?.takeIf { it.isNotBlank() }?.let { "最后在线是 $it。" }
                            ?: "还没有记录到这台电脑的在线时间。",
                        fontSize = 14.sp,
                        lineHeight = 20.58.sp,
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                    )
                }
            }

            OfflineSteps(account = account)

            Text(
                text = "上线后会自动出现在列表里，不用刷新。",
                fontSize = 14.sp,
                lineHeight = 20.58.sp,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
            )

            AccentPanel(
                modifier = Modifier
                    .fillMaxWidth()
                    .height(52.dp)
                    .glassClick(onClick = onDismiss),
            ) {
                Box(Modifier.fillMaxSize(), contentAlignment = Alignment.Center) {
                    Text(
                        text = "知道了",
                        color = Color.White,
                        fontSize = 16.sp,
                        fontWeight = FontWeight.SemiBold,
                    )
                }
            }
        }
    }
}

@Composable
private fun OfflineSteps(account: String?) {
    val accountStep = account?.takeIf { it.isNotBlank() }?.let { "确认登录的是 $it 这个账号" }
        ?: "确认登录的是同一个账号"

    Column(
        modifier = Modifier
            .fillMaxWidth()
            .padding(vertical = 4.dp),
        verticalArrangement = Arrangement.spacedBy(12.dp),
    ) {
        OfflineStep(1, "唤醒这台电脑，打开 FastVibe")
        OfflineStep(2, "进入 设置 → 远程访问，确认开关已打开")
        OfflineStep(3, accountStep)
    }
}

@Composable
private fun OfflineStep(number: Int, text: String) {
    Row(
        modifier = Modifier.fillMaxWidth(),
        horizontalArrangement = Arrangement.spacedBy(12.dp),
        verticalAlignment = Alignment.Top,
    ) {
        Box(
            modifier = Modifier.padding(top = 1.dp).size(24.dp)
                .background(MaterialTheme.colorScheme.primary.copy(alpha = .14f), CircleShape),
        ) {
            Box(Modifier.fillMaxSize(), contentAlignment = Alignment.Center) {
                Text(
                    text = number.toString(),
                    fontSize = 13.sp,
                    fontWeight = FontWeight.SemiBold,
                    color = MaterialTheme.colorScheme.primary,
                )
            }
        }
        Text(
            text = text,
            fontSize = 15.5.sp,
            lineHeight = 22.785.sp,
            color = MaterialTheme.colorScheme.onSurface,
        )
    }
}

@Composable
private fun SheetHeader(
    title: String,
    subtitle: String,
    onDismiss: () -> Unit,
) {
    Row(
        modifier = Modifier.fillMaxWidth(),
        horizontalArrangement = Arrangement.spacedBy(12.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Column(
            modifier = Modifier.weight(1f),
            verticalArrangement = Arrangement.spacedBy(4.dp),
        ) {
            Text(title, fontSize = 18.sp, lineHeight = 26.46.sp, fontWeight = FontWeight.Bold)
            Text(subtitle, fontSize = 14.sp, lineHeight = 20.58.sp, color = MaterialTheme.colorScheme.onSurfaceVariant)
        }
        GlassPanel(
            modifier = Modifier
                .size(44.dp)
                .clip(CircleShape)
                .glassClick(onClick = onDismiss),
            shape = CircleShape,
            high = true,
        ) {
            Box(Modifier.fillMaxSize(), contentAlignment = Alignment.Center) {
                SheetImage(
                    resource = R.drawable.fv_x,
                    modifier = Modifier.size(20.dp),
                    contentDescription = "关闭",
                    tint = MaterialTheme.colorScheme.onSurface,
                )
            }
        }
    }
}

@Composable
private fun SheetImage(
    resource: Int,
    modifier: Modifier,
    contentDescription: String?,
    tint: Color,
) {
    Image(
        painter = painterResource(resource),
        contentDescription = contentDescription,
        modifier = modifier,
        colorFilter = ColorFilter.tint(tint),
    )
}
