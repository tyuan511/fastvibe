package dev.fastvibe.mobile

import androidx.compose.foundation.Image
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.ColorFilter
import androidx.compose.ui.res.painterResource
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import androidx.compose.ui.text.PlatformTextStyle
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.material3.LocalTextStyle
import androidx.compose.ui.unit.sp

@Composable
internal fun ConnectionProgressScreen(controller: MobileRuntimeController, onBack: () -> Unit) {
    val device = controller.devices.firstOrNull { it.id == controller.selectedDeviceId() }
    ConnectionProgressContent(
        deviceName = device?.name ?: "正在连接电脑",
        failed = controller.state.connection == "error",
        error = controller.state.error,
        onBack = onBack,
        onRetry = device?.let { { controller.connect(it) } },
    )
}

@Composable
internal fun ConnectionProgressContent(
    deviceName: String,
    failed: Boolean,
    error: String? = null,
    onBack: () -> Unit,
    onRetry: (() -> Unit)? = null,
) {
    val dark = MaterialTheme.colorScheme.background.red < .1f
    CompositionLocalProvider(LocalTextStyle provides LocalTextStyle.current.copy(
        fontFamily = androidx.compose.ui.text.font.FontFamily.SansSerif,
        letterSpacing = 0.sp,
        platformStyle = PlatformTextStyle(includeFontPadding = false),
    )) {
    GlassBackground {
        Column(Modifier.fillMaxSize().mobileStatusBarsPadding().mobileNavigationBarsPadding()) {
            Row(Modifier.fillMaxWidth().height(56.dp).padding(horizontal = 12.dp), verticalAlignment = Alignment.CenterVertically) {
                GlassIconButton(R.drawable.fv_chevron_left, "返回电脑列表", onBack)
            }
            Column(
                Modifier.weight(1f).fillMaxWidth().padding(horizontal = 32.dp),
                horizontalAlignment = Alignment.CenterHorizontally,
                verticalArrangement = Arrangement.Center,
            ) {
                Box(
                    Modifier.size(64.dp).clip(RoundedCornerShape(18.dp))
                        .background(Color.White.copy(alpha = if (dark) .08f else .72f))
                        .border(.5.dp, Color.White.copy(alpha = if (dark) .16f else .95f), RoundedCornerShape(18.dp)),
                    contentAlignment = Alignment.Center,
                ) { ConnectionIcon(R.drawable.fv_laptop, 30, MaterialTheme.colorScheme.onSurface) }
                Spacer(Modifier.height(14.dp))
                Text(
                    if (failed) "没能连上这台电脑" else deviceName,
                    fontSize = 22.sp,
                    lineHeight = 32.sp,
                    letterSpacing = (-.44).sp,
                    fontWeight = FontWeight.Bold,
                    textAlign = TextAlign.Center,
                )
                Column(Modifier.fillMaxWidth().padding(top = 26.dp), verticalArrangement = Arrangement.spacedBy(2.dp)) {
                    ConnectionStep("找到电脑", null, 0)
                    ConnectionStep("建立连接", if (failed) error ?: "电脑暂时没有响应" else "正在尝试直连，不行会自动走中转", if (failed) 3 else 1)
                    if (!failed) ConnectionStep("同步会话", null, 2)
                }
                if (failed) {
                    Spacer(Modifier.height(14.dp))
                    GlassPanel(Modifier.fillMaxWidth(), RoundedCornerShape(22.dp)) {
                        Column(
                            Modifier.fillMaxWidth()
                                .background(MaterialTheme.colorScheme.error.copy(alpha = .11f))
                                .padding(horizontal = 16.dp, vertical = 14.dp),
                            verticalArrangement = Arrangement.spacedBy(6.dp),
                        ) {
                            Text("可能的原因", fontSize = 16.sp, lineHeight = 23.5.sp, fontWeight = FontWeight.Bold)
                            Text("电脑进入了睡眠，或者网络切换后还没重新上线。唤醒电脑并确认 FastVibe 在运行，然后重试。", fontSize = 14.sp, lineHeight = 20.5.sp)
                        }
                    }
                }
            }
            Column(
                Modifier.fillMaxWidth().padding(start = 20.dp, end = 20.dp, top = 12.dp, bottom = 20.dp),
                verticalArrangement = Arrangement.spacedBy(12.dp),
            ) {
                if (failed && onRetry != null) AccentPanel(Modifier.fillMaxWidth().height(52.dp).glassClick(onClick = onRetry)) {
                    Row(Modifier.fillMaxSize(), horizontalArrangement = Arrangement.spacedBy(8.dp, Alignment.CenterHorizontally), verticalAlignment = Alignment.CenterVertically) {
                        ConnectionIcon(R.drawable.fv_refresh_cw, 20, Color.White)
                        Text("重试", color = Color.White, fontSize = 16.sp, fontWeight = FontWeight.SemiBold)
                    }
                }
                GlassPanel(Modifier.fillMaxWidth().height(52.dp).glassClick(onClick = onBack), CircleShape, high = true) {
                    Box(Modifier.fillMaxSize(), contentAlignment = Alignment.Center) {
                        Text(if (failed) "返回电脑列表" else "取消", fontSize = 16.sp, fontWeight = FontWeight.SemiBold)
                    }
                }
            }
        }
    }
    }
}

@Composable
private fun ConnectionStep(title: String, detail: String?, state: Int) {
    val dark = MaterialTheme.colorScheme.background.red < .1f
    val color = when (state) {
        0 -> if (dark) Color(0xFF32D74B) else Color(0xFF34C759)
        1 -> MaterialTheme.colorScheme.primary
        3 -> MaterialTheme.colorScheme.error
        else -> MaterialTheme.colorScheme.onSurfaceVariant
    }
    val background = when (state) {
        0 -> color.copy(alpha = .16f)
        1, 3 -> color.copy(alpha = .14f)
        else -> Color(0xFF767680).copy(alpha = if (dark) .24f else .12f)
    }
    Row(
        Modifier.fillMaxWidth().heightIn(min = 48.dp),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(12.dp),
    ) {
        Box(Modifier.size(28.dp).background(background, CircleShape), contentAlignment = Alignment.Center) {
            when (state) {
                0 -> ConnectionIcon(R.drawable.fv_check, 16, color)
                1 -> CircularProgressIndicator(Modifier.size(16.dp), color = color, strokeWidth = 1.5.dp)
                3 -> ConnectionIcon(R.drawable.fv_x, 16, color)
                else -> Box(Modifier.size(13.dp).border(1.3.dp, color, CircleShape))
            }
        }
        Column {
            Text(title, fontSize = 16.sp, lineHeight = 23.5.sp, color = if (state == 2) color else MaterialTheme.colorScheme.onSurface)
            if (detail != null) Text(detail, fontSize = 13.sp, lineHeight = 19.sp, color = MaterialTheme.colorScheme.onSurfaceVariant)
        }
    }
}

@Composable
private fun ConnectionIcon(resource: Int, size: Int, color: Color) {
    Image(painterResource(resource), null, Modifier.size(size.dp), colorFilter = ColorFilter.tint(color))
}
