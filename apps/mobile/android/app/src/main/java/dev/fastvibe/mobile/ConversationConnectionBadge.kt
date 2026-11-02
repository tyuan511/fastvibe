package dev.fastvibe.mobile

import androidx.compose.foundation.Image
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.ColorFilter
import androidx.compose.ui.res.painterResource
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp

@Composable
internal fun ConversationConnectionBadge(name: String, connection: String, path: String?, modifier: Modifier = Modifier) {
    val connected = connection == "connected"
    val dark = MaterialTheme.colorScheme.background.red < .1f
    val color = if (connected) { if (dark) Color(0xFF32D74B) else Color(0xFF34C759) } else MaterialTheme.colorScheme.onSurfaceVariant
    // The catalog pill reports connection state; route badges belong to computer rows.
    val label = if (connected) "已连接" else when (connection) {
        "connecting" -> "连接中"
        "error" -> "连接中断"
        else -> "未连接"
    }
    GlassPanel(modifier, CircleShape, high = true) {
        Row(Modifier.padding(start = 12.dp, end = 8.dp, top = 9.dp, bottom = 9.dp), verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            Image(painterResource(R.drawable.fv_monitor), null, Modifier.size(16.dp), colorFilter = ColorFilter.tint(MaterialTheme.colorScheme.onSurfaceVariant))
            Text(name, Modifier.weight(1f, fill = false), fontSize = 13.sp, lineHeight = 19.11.sp, fontWeight = FontWeight.SemiBold, maxLines = 1, overflow = TextOverflow.Ellipsis)
            Row(Modifier.clip(CircleShape).background(color.copy(alpha = .12f)).padding(horizontal = 7.dp, vertical = 3.dp), verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(4.dp)) {
                Box(Modifier.size(5.dp).clip(CircleShape).background(color))
                Text(label, fontSize = 11.sp, lineHeight = 14.sp, fontWeight = FontWeight.Medium, color = color)
            }
        }
    }
}
