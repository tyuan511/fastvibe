package dev.fastvibe.mobile

import androidx.compose.foundation.Canvas
import androidx.compose.foundation.background
import androidx.compose.foundation.isSystemInDarkTheme
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.BoxScope
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.MaterialTheme
import androidx.compose.runtime.Composable
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.compositionLocalOf
import androidx.compose.runtime.remember
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.draw.drawWithContent
import androidx.compose.ui.draw.shadow
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.Shape
import androidx.compose.ui.graphics.drawOutline
import androidx.compose.ui.graphics.drawscope.scale
import androidx.compose.ui.unit.dp
import dev.chrisbanes.haze.HazeState
import dev.chrisbanes.haze.HazeStyle
import dev.chrisbanes.haze.HazeTint
import dev.chrisbanes.haze.hazeEffect
import dev.chrisbanes.haze.hazeSource

private val LocalGlassBackdrop = compositionLocalOf<HazeState?> { null }

@Composable
internal fun GlassBackdropHost(content: @Composable () -> Unit) {
    val state = remember { HazeState() }
    CompositionLocalProvider(LocalGlassBackdrop provides state, content = content)
}

@Composable
internal fun GlassBackground(content: @Composable () -> Unit) {
    val ownState = remember { HazeState() }
    val state = LocalGlassBackdrop.current ?: ownState
    val dark = MaterialTheme.colorScheme.background.red < .1f
    val base = MaterialTheme.colorScheme.background
    CompositionLocalProvider(LocalGlassBackdrop provides state) {
        Box(Modifier.fillMaxSize().background(base)) {
            Canvas(Modifier.fillMaxSize().hazeSource(state)) {
                drawRect(base)
                fun light(color: Color, x: Float, y: Float, width: Float, height: Float) {
                    val center = Offset(size.width * x, size.height * y)
                    val radius = size.width * width
                    scale(1f, size.height * height / radius, center) {
                        drawCircle(
                            Brush.radialGradient(
                                0f to color, .72f to Color.Transparent,
                                center = center, radius = radius,
                            ), radius, center,
                        )
                    }
                }
                light(if (dark) Color(0xFF3856FF).copy(alpha = .36f) else Color(0xFF608CFF).copy(alpha = .42f), 0f, 0f, .95f, .48f)
                light(if (dark) Color(0xFFC43CAA).copy(alpha = .26f) else Color(0xFFFF96C4).copy(alpha = .34f), 1f, .38f, .80f, .42f)
                light(if (dark) Color(0xFF14A096).copy(alpha = .22f) else Color(0xFF6EDECE).copy(alpha = .36f), .15f, 1f, .95f, .48f)
            }
            content()
        }
    }
}

@Composable
internal fun GlassPanel(
    modifier: Modifier = Modifier,
    shape: Shape = RoundedCornerShape(24.dp),
    high: Boolean = false,
    sheet: Boolean = false,
    content: @Composable BoxScope.() -> Unit,
) {
    val dark = MaterialTheme.colorScheme.background.red < .1f
    val backdrop = LocalGlassBackdrop.current
    val tint = if (sheet) { if (dark) Color(0xFF202026).copy(alpha = .8f) else Color(0xFFF8F8FC).copy(alpha = .84f) }
        else if (dark) (if (high) Color(0xFF383840) else Color(0xFF2C2C34)).copy(alpha = if (high) .58f else .44f)
        else Color.White.copy(alpha = if (high) .74f else .56f)
    val sheen = Color.White.copy(alpha = if (dark) .07f else .50f)
    val edge = if (dark) Color.Black.copy(alpha = .5f) else Color.Black.copy(alpha = .06f)
    val highlight = Color.White.copy(alpha = if (dark) .16f else .95f)
    val material = if (backdrop != null) Modifier.hazeEffect(
        state = backdrop,
        style = HazeStyle(
            backgroundColor = MaterialTheme.colorScheme.background,
            tint = HazeTint(tint),
            blurRadius = if (sheet) 30.dp else if (high) 18.dp else 22.dp,
            noiseFactor = 0f,
        ),
    ) else Modifier.background(tint)
    Box(
        modifier
            .shadow(if (sheet) 16.dp else if (high) 3.dp else 6.dp, shape, clip = false,
                ambientColor = (if (dark) Color.Black else Color(0xFF283464)).copy(alpha = if (dark) .5f else .12f),
                spotColor = (if (dark) Color.Black else Color(0xFF283464)).copy(alpha = if (dark) .5f else .12f))
            .clip(shape)
            .then(material)
            .background(Brush.verticalGradient(0f to sheen, .46f to Color.Transparent))
            .drawWithContent {
                drawContent()
                val outline = shape.createOutline(size, layoutDirection, this)
                drawOutline(outline, edge, style = androidx.compose.ui.graphics.drawscope.Stroke(.5.dp.toPx()))
                drawOutline(outline, Brush.verticalGradient(listOf(highlight, Color.Transparent, if (high) highlight.copy(alpha = highlight.alpha * .5f) else Color.Transparent)), style = androidx.compose.ui.graphics.drawscope.Stroke(1.dp.toPx()))
            },
        content = content,
    )
}

@Composable
internal fun AccentPanel(
    modifier: Modifier = Modifier,
    shape: Shape = RoundedCornerShape(999.dp),
    content: @Composable BoxScope.() -> Unit,
) {
    Box(
        modifier.shadow(6.dp, shape, ambientColor = Color(0x33007AFF), spotColor = Color(0x33007AFF))
            .clip(shape)
            .background(Brush.verticalGradient(listOf(Color(0xFF4AA3FF), Color(0xFF007AFF))))
            .background(Brush.verticalGradient(0f to Color.White.copy(alpha = .28f), .5f to Color.Transparent)),
        content = content,
    )
}
