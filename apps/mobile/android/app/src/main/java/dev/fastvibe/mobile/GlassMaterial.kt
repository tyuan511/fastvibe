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
import androidx.compose.ui.draw.drawWithCache
import androidx.compose.ui.graphics.asImageBitmap
import androidx.compose.ui.geometry.Size
import androidx.compose.ui.graphics.Path
import androidx.compose.ui.graphics.Outline
import androidx.compose.ui.graphics.asAndroidPath
import androidx.compose.ui.graphics.asComposeRenderEffect
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.Shape
import androidx.compose.ui.graphics.toArgb
import androidx.compose.ui.graphics.drawOutline
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.graphics.CompositingStrategy
import androidx.compose.ui.graphics.BlendMode
import androidx.compose.ui.graphics.drawscope.scale
import androidx.compose.ui.unit.dp
import dev.chrisbanes.haze.HazeState
import dev.chrisbanes.haze.HazeStyle
import dev.chrisbanes.haze.HazeTint
import dev.chrisbanes.haze.hazeEffect
import dev.chrisbanes.haze.hazeSource

private val LocalGlassBackdrop = compositionLocalOf<HazeState?> { null }
private val LocalPageBackdrop = compositionLocalOf<HazeState?> { null }

@Composable
internal fun GlassBackdropHost(content: @Composable () -> Unit) {
    val state = remember { HazeState() }
    val page = remember { HazeState() }
    CompositionLocalProvider(LocalGlassBackdrop provides state, LocalPageBackdrop provides page, content = content)
}

@Composable
internal fun Modifier.glassPageSource(): Modifier =
    LocalPageBackdrop.current?.let { hazeSource(it) } ?: this

@Composable
private fun Modifier.glassSaturation(amount: Float): Modifier {
    val effect = remember(amount) {
        if (android.os.Build.VERSION.SDK_INT >= 31) {
            val matrix = android.graphics.ColorMatrix().apply { setSaturation(amount) }
            android.graphics.RenderEffect.createColorFilterEffect(android.graphics.ColorMatrixColorFilter(matrix))
                .asComposeRenderEffect()
        } else null
    }
    return if (effect == null) this else graphicsLayer { renderEffect = effect }
}

@Composable
internal fun Modifier.glassChromeBackdrop(bottom: Boolean = false): Modifier {
    val state = LocalPageBackdrop.current ?: return this
    val background = MaterialTheme.colorScheme.background
    return graphicsLayer { compositingStrategy = CompositingStrategy.Offscreen }
        .drawWithContent {
            drawContent()
            drawRect(
                if (bottom) Brush.verticalGradient(0f to Color.Transparent, .45f to Color.Black, 1f to Color.Black)
                else Brush.verticalGradient(0f to Color.Black, .55f to Color.Black, 1f to Color.Transparent),
                blendMode = BlendMode.DstIn,
            )
        }
        .glassSaturation(if (bottom) 1f else 1.6f)
        .hazeEffect(state, style = HazeStyle(backgroundColor = Color.Transparent, tints = emptyList(), blurRadius = if (bottom) 8.dp else 24.dp, noiseFactor = 0f, fallbackTint = HazeTint(Color.Transparent)))
        .background(
            if (!bottom) Brush.verticalGradient(
                0f to background.copy(alpha = .88f), .4f to background.copy(alpha = .88f), 1f to background.copy(alpha = .30f),
            ) else Brush.verticalGradient(listOf(Color.Transparent, Color.Transparent)),
        )
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
                light(if (dark) Color(0xFF14A096).copy(alpha = .22f) else Color(0xFF6EDECE).copy(alpha = .36f), .15f, 1f, .95f, .48f)
                light(if (dark) Color(0xFFC43CAA).copy(alpha = .26f) else Color(0xFFFF96C4).copy(alpha = .34f), 1f, .38f, .80f, .42f)
                light(if (dark) Color(0xFF3856FF).copy(alpha = .36f) else Color(0xFF608CFF).copy(alpha = .42f), 0f, 0f, .95f, .48f)
            }
            content()
        }
    }
}

@Composable
private fun Modifier.glassShadow(shape: Shape, accent: Boolean = false, sheet: Boolean = false, high: Boolean = false, userBubble: Boolean = false): Modifier {
    val dark = MaterialTheme.colorScheme.background.red < .1f
    val shadowColor = if (accent) MaterialTheme.colorScheme.primary.copy(alpha = if (userBubble) .55f else .60f)
        else if (dark) Color.Black.copy(alpha = if (sheet) .30f else .50f)
        else Color(0xFF283464).copy(alpha = .12f)
    return drawWithCache {
        val blur = (if (sheet) 25.dp else if (userBubble) 8.dp else if (accent) 10.dp else if (high) 9.dp else 12.dp).toPx()
        val spread = (if (sheet) 10.dp else if (accent) 6.dp else if (high) 4.dp else 6.dp).toPx()
        val offset = (if (sheet) 20.dp else if (userBubble) 6.dp else if (accent) 8.dp else if (high) 6.dp else 8.dp).toPx()
        val padding = kotlin.math.ceil(blur * 3 + offset).toInt()
        val width = kotlin.math.ceil(size.width).toInt() + padding * 2
        val height = kotlin.math.ceil(size.height).toInt() + padding * 2
        if (size.width <= spread * 2 || size.height <= spread * 2 || width <= 0 || height <= 0) {
            onDrawBehind {}
        } else {
            val bitmap = android.graphics.Bitmap.createBitmap(width, height, android.graphics.Bitmap.Config.ARGB_8888)
            val canvas = android.graphics.Canvas(bitmap)
            val path = Path().apply {
                when (val outline = shape.createOutline(Size(size.width - spread * 2, size.height - spread * 2), layoutDirection, this@drawWithCache)) {
                    is Outline.Rectangle -> addRect(outline.rect)
                    is Outline.Rounded -> addRoundRect(outline.roundRect)
                    is Outline.Generic -> addPath(outline.path)
                }
            }
            canvas.translate(padding + spread, padding + spread + offset)
            val paint = android.graphics.Paint(android.graphics.Paint.ANTI_ALIAS_FLAG).apply {
                color = shadowColor.toArgb()
                maskFilter = android.graphics.BlurMaskFilter(blur, android.graphics.BlurMaskFilter.Blur.NORMAL)
            }
            canvas.drawPath(path.asAndroidPath(), paint)
            val image = bitmap.asImageBitmap()
            onDrawBehind { drawImage(image, topLeft = Offset(-padding.toFloat(), -padding.toFloat())) }
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
    val backdrop = if (sheet) LocalPageBackdrop.current ?: LocalGlassBackdrop.current else LocalGlassBackdrop.current
    val tint = if (sheet) { if (dark) Color(0xFF202026).copy(alpha = .8f) else Color(0xFFF8F8FC).copy(alpha = .84f) }
        else if (dark) (if (high) Color(0xFF383840) else Color(0xFF2C2C34)).copy(alpha = if (high) .58f else .44f)
        else Color.White.copy(alpha = if (high) .74f else .56f)
    val sheen = Color.White.copy(alpha = if (dark) .07f else .50f)
    val edge = if (dark) Color.Black.copy(alpha = .5f) else Color.Black.copy(alpha = .06f)
    val highlight = Color.White.copy(alpha = if (dark) .16f else .95f)
    val material = if (backdrop != null) Modifier.glassSaturation(if (high) 1.9f else 1.8f).hazeEffect(
        state = backdrop,
        style = HazeStyle(
            backgroundColor = Color.Transparent,
            tints = emptyList(),
            blurRadius = if (sheet) 30.dp else if (high) 18.dp else 22.dp,
            noiseFactor = 0f,
            fallbackTint = HazeTint(Color.Transparent),
        ),
    ) else Modifier
    Box(modifier.glassShadow(shape, sheet = sheet, high = high)) {
        Box(Modifier.matchParentSize().clip(shape)) {
            Box(Modifier.matchParentSize().then(material))
            Box(Modifier.matchParentSize().background(tint)
                .background(Brush.verticalGradient(0f to sheen, (if (sheet) .30f else if (high) .55f else .46f) to Color.Transparent))
                .drawWithContent {
                    drawContent()
                    val outline = shape.createOutline(size, layoutDirection, this)
                    drawOutline(outline, edge, style = androidx.compose.ui.graphics.drawscope.Stroke(.5.dp.toPx()))
                    drawOutline(outline, Brush.verticalGradient(listOf(highlight, Color.Transparent, if (high) highlight.copy(alpha = highlight.alpha * .5f) else Color.Transparent)), style = androidx.compose.ui.graphics.drawscope.Stroke(1.dp.toPx()))
                })
        }
        Box(Modifier.clip(shape), content = content)
    }
}

@Composable
internal fun AccentPanel(
    modifier: Modifier = Modifier,
    shape: Shape = RoundedCornerShape(999.dp),
    userBubble: Boolean = false,
    content: @Composable BoxScope.() -> Unit,
) {
    val colors = MaterialTheme.colorScheme
    Box(
        modifier.glassShadow(shape, accent = true, userBubble = userBubble)
            .clip(shape)
            .background(Brush.verticalGradient(listOf(colors.secondary, colors.primary)))
            .background(Brush.verticalGradient(0f to Color.White.copy(alpha = if (userBubble) .22f else .28f), (if (userBubble) .6f else .5f) to Color.Transparent))
            .drawWithContent {
                drawContent()
                drawOutline(
                    shape.createOutline(size, layoutDirection, this),
                    Brush.verticalGradient(listOf(Color.White.copy(alpha = if (userBubble) .35f else .45f), Color.Transparent, if (userBubble) Color.Transparent else Color.Black.copy(alpha = .08f))),
                    style = androidx.compose.ui.graphics.drawscope.Stroke(1.dp.toPx()),
                )
            },
        content = content,
    )
}
