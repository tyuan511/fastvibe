package dev.fastvibe.mobile

import androidx.compose.foundation.background
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.defaultMinSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.BasicTextField
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.ColorFilter
import androidx.compose.ui.graphics.SolidColor
import androidx.compose.ui.res.painterResource
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp

@Composable
internal fun ConversationComposer(
    value: String,
    enabled: Boolean,
    running: Boolean,
    attachments: List<ImageAttachment>,
    onChange: (String) -> Unit,
    onAttach: () -> Unit,
    onRemove: (ImageAttachment) -> Unit,
    onStop: () -> Unit,
    onSend: (String, List<ImageAttachment>) -> Unit,
) {
    val hasContent = value.isNotBlank() || attachments.isNotEmpty()
    val canSend = enabled && hasContent
    val canQueue = running && canSend
    val canStop = running && !hasContent
    val scrollState = rememberScrollState()
    val muted = MaterialTheme.colorScheme.onSurfaceVariant

    Column(
        Modifier.fillMaxWidth().padding(horizontal = 12.dp),
        verticalArrangement = Arrangement.spacedBy(8.dp),
    ) {
        if (attachments.isNotEmpty()) {
            Row(
                Modifier.fillMaxWidth().heightIn(max = 36.dp).horizontalScroll(scrollState),
                horizontalArrangement = Arrangement.spacedBy(6.dp),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                attachments.forEach { attachment ->
                    GlassPanel(
                        Modifier.heightIn(min = 32.dp),
                        RoundedCornerShape(12.dp),
                        high = true,
                    ) {
                        Row(
                            Modifier.padding(start = 8.dp, end = 2.dp),
                            verticalAlignment = Alignment.CenterVertically,
                        ) {
                            ComposerIcon(R.drawable.fv_image, Modifier.size(15.dp), muted)
                            Text(
                                attachment.name,
                                Modifier.widthIn(max = 112.dp).padding(start = 4.dp),
                                maxLines = 1,
                                overflow = TextOverflow.Ellipsis,
                                style = MaterialTheme.typography.labelSmall,
                            )
                            Box(
                                Modifier.size(28.dp)
                                    .semantics { contentDescription = "移除 ${attachment.name}" }
                                    .glassClick { onRemove(attachment) },
                                contentAlignment = Alignment.Center,
                            ) {
                                ComposerIcon(R.drawable.fv_x, Modifier.size(14.dp), muted)
                            }
                        }
                    }
                }
            }
        }

        Row(
            Modifier.fillMaxWidth(),
            horizontalArrangement = Arrangement.spacedBy(8.dp),
            verticalAlignment = Alignment.Bottom,
        ) {
            GlassPanel(
                Modifier.weight(1f).defaultMinSize(minHeight = 48.dp),
                RoundedCornerShape(24.dp),
                high = true,
            ) {
                Row(
                    Modifier.fillMaxWidth().defaultMinSize(minHeight = 48.dp).padding(horizontal = 4.dp),
                    verticalAlignment = Alignment.CenterVertically,
                ) {
                    Box(
                        Modifier.size(40.dp)
                            .semantics { contentDescription = "添加图片" }
                            .glassClick(enabled = enabled, onClick = onAttach),
                        contentAlignment = Alignment.Center,
                    ) {
                        ComposerIcon(
                            R.drawable.fv_image,
                            Modifier.size(20.dp),
                            muted.copy(alpha = muted.alpha * if (enabled) 1f else .4f),
                        )
                    }
                    BasicTextField(
                        value = value,
                        onValueChange = onChange,
                        modifier = Modifier.weight(1f).padding(start = 8.dp, end = 6.dp, top = 7.dp, bottom = 7.dp)
                            .semantics { contentDescription = "消息" },
                        enabled = enabled,
                        cursorBrush = SolidColor(MaterialTheme.colorScheme.primary),
                        textStyle = TextStyle(
                            color = MaterialTheme.colorScheme.onSurface,
                            fontSize = 16.sp,
                            lineHeight = 22.sp,
                        ),
                        minLines = 1,
                        maxLines = 5,
                        decorationBox = { innerTextField ->
                            Box(contentAlignment = Alignment.CenterStart) {
                                if (value.isEmpty()) {
                                    Text(
                                        when {
                                            !enabled -> "连接后发送消息"
                                            running -> "继续输入，会排队发送"
                                            else -> "发送消息"
                                        },
                                        color = muted,
                                        fontSize = 16.sp,
                                        lineHeight = 22.sp,
                                    )
                                }
                                innerTextField()
                            }
                        },
                    )
                }
            }

            val action = when {
                canQueue -> "加入排队"
                canSend -> "发送"
                canStop -> "停止"
                else -> "发送"
            }
            val actionModifier = Modifier.size(48.dp)
                .semantics { contentDescription = action }
                .glassClick(enabled = canSend || canStop) {
                    when {
                        canQueue -> onSend(value, attachments.toList())
                        canSend -> onSend(value, attachments.toList())
                        canStop -> onStop()
                    }
                }

            when {
                canStop -> {
                    Box(
                        actionModifier.clip(CircleShape).background(
                            if (MaterialTheme.colorScheme.background.red < .1f) Color(0xFFF2F2F7) else Color(0xFF1C1C1E),
                        ),
                        contentAlignment = Alignment.Center,
                    ) {
                        Box(
                            Modifier.size(12.dp).background(
                                if (MaterialTheme.colorScheme.background.red < .1f) Color.Black else Color.White,
                                RoundedCornerShape(1.5.dp),
                            ),
                        )
                    }
                }
                canSend -> {
                    AccentPanel(actionModifier, CircleShape) {
                        Box(Modifier.size(48.dp), contentAlignment = Alignment.Center) {
                            ComposerIcon(R.drawable.fv_arrow_up, Modifier.size(22.dp), Color.White)
                        }
                    }
                }
                else -> {
                    GlassPanel(actionModifier, CircleShape, high = true) {
                        Box(Modifier.size(48.dp), contentAlignment = Alignment.Center) {
                            ComposerIcon(R.drawable.fv_arrow_up, Modifier.size(22.dp), muted)
                        }
                    }
                }
            }
        }
    }
}

@Composable
private fun ComposerIcon(resourceId: Int, modifier: Modifier, tint: Color) {
    androidx.compose.foundation.Image(
        painter = painterResource(resourceId),
        contentDescription = null,
        modifier = modifier,
        colorFilter = ColorFilter.tint(tint),
    )
}
