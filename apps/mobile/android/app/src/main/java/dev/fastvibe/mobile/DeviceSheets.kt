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
                lineHeight = 23.5.sp,
                fontWeight = FontWeight.SemiBold,
                maxLines = 1,
                overflow = TextOverflow.Ellipsis,
                color = MaterialTheme.colorScheme.onSurface.copy(alpha = if (enabled) 1f else .55f),
            )
            Text(
                text = project?.cwd ?: "不绑定项目，直接开始会话",
                fontSize = 13.sp,
                lineHeight = 19.sp,
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
    val shape = RoundedCornerShape(14.dp)
    val dark = MaterialTheme.colorScheme.background.red < .1f
    Box(
        modifier = Modifier.size(44.dp).clip(shape)
            .background(
                if (unassigned) Color(0xFF767680).copy(alpha = if (dark) .24f else .12f)
                else Color.White.copy(alpha = if (dark) .08f else .72f),
            )
            .border(.5.dp, Color.White.copy(alpha = if (dark) .16f else .95f), shape),
        contentAlignment = Alignment.Center,
    ) {
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
                val dark = MaterialTheme.colorScheme.background.red < .1f
                val tileShape = RoundedCornerShape(14.dp)
                Box(
                    modifier = Modifier.size(44.dp).clip(tileShape)
                        .background(Color(0xFF767680).copy(alpha = if (dark) .24f else .12f))
                        .border(.5.dp, Color.White.copy(alpha = if (dark) .16f else .95f), tileShape),
                    contentAlignment = Alignment.Center,
                ) {
                    SheetImage(
                        resource = R.drawable.fv_cloud_off,
                        modifier = Modifier.size(20.dp),
                        contentDescription = null,
                        tint = MaterialTheme.colorScheme.onSurfaceVariant,
                    )
                }
                Column(
                    modifier = Modifier.weight(1f),
                    verticalArrangement = Arrangement.spacedBy(4.dp),
                ) {
                    Text(
                        text = "${device.name} 不在线",
                        fontSize = 18.sp,
                        lineHeight = 26.5.sp,
                        fontWeight = FontWeight.Bold,
                        maxLines = 2,
                        overflow = TextOverflow.Ellipsis,
                    )
                    Text(
                        text = device.lastOnline?.takeIf { it.isNotBlank() }?.let { "最后在线是 $it。" }
                            ?: "还没有记录到这台电脑的在线时间。",
                        fontSize = 14.sp,
                        lineHeight = 20.5.sp,
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                    )
                }
            }

            OfflineSteps(account = account)

            Text(
                text = "上线后会自动出现在列表里，不用刷新。",
                fontSize = 14.sp,
                lineHeight = 20.5.sp,
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
            lineHeight = 23.sp,
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
            Text(title, fontSize = 18.sp, lineHeight = 26.5.sp, fontWeight = FontWeight.Bold)
            Text(subtitle, fontSize = 14.sp, lineHeight = 20.5.sp, color = MaterialTheme.colorScheme.onSurfaceVariant)
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
