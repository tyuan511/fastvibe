package dev.fastvibe.mobile

import android.content.ActivityNotFoundException
import android.content.Context
import android.content.Intent
import android.graphics.Color
import android.graphics.Typeface
import android.net.Uri
import android.text.method.LinkMovementMethod
import android.text.util.Linkify
import android.util.TypedValue
import android.view.View
import android.widget.TextView
import androidx.compose.material3.MaterialTheme
import androidx.compose.runtime.Composable
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberUpdatedState
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.toArgb
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.viewinterop.AndroidView
import io.noties.markwon.AbstractMarkwonPlugin
import io.noties.markwon.LinkResolver
import io.noties.markwon.Markwon
import io.noties.markwon.MarkwonConfiguration
import io.noties.markwon.core.MarkwonTheme
import io.noties.markwon.ext.strikethrough.StrikethroughPlugin
import io.noties.markwon.ext.tables.TablePlugin
import io.noties.markwon.ext.tables.TableTheme
import io.noties.markwon.ext.tasklist.TaskListPlugin
import io.noties.markwon.linkify.LinkifyPlugin
import java.net.URI
import java.net.URLDecoder
import java.nio.charset.StandardCharsets
import java.util.Locale

/**
 * Native Markdown renderer for assistant replies.
 *
 * MainActivity owns where this is used. The TextView remains selectable, so the native Android
 * copy/select actions work for rendered prose and code without a WebView.
 */
@Composable
internal fun ReplyMarkdown(
    text: String,
    modifier: Modifier = Modifier,
    onFile: (String) -> Unit = {},
) {
    val context = LocalContext.current
    val colors = MaterialTheme.colorScheme
    val currentOnFile = rememberUpdatedState(onFile)
    val markwon = remember(
        context,
        colors.onSurface,
        colors.primary,
        colors.surfaceVariant,
        colors.background,
    ) {
        createMarkwon(
            context = context,
            linkColor = colors.primary.toArgb(),
            codeColor = colors.onSurface.toArgb(),
            codeBlockColor = colors.onSurface.toArgb(),
            codeBackground = colors.surfaceVariant.toArgb(),
            codeBlockBackground = (if (colors.background.red < .1f) androidx.compose.ui.graphics.Color.Black.copy(alpha = .32f) else androidx.compose.ui.graphics.Color.White.copy(alpha = .7f)).toArgb(),
            onFile = { path -> currentOnFile.value(path) },
        )
    }

    AndroidView(
        modifier = modifier,
        factory = { viewContext ->
            TextView(viewContext).apply {
                configureReplyTextView(viewContext)
            }
        },
        update = { textView ->
            textView.setTextColor(colors.onSurface.toArgb())
            textView.setLinkTextColor(colors.primary.toArgb())
            val previous = textView.getTag() as? RenderState
            if (previous?.markwon !== markwon || previous.text != text) {
                markwon.setMarkdown(textView, text)
                textView.setTag(RenderState(markwon, text))
            }
        },
    )
}

private data class RenderState(val markwon: Markwon, val text: String)

private const val RENDER_STATE_TAG = 0x46564D44

private fun TextView.configureReplyTextView(context: Context) {
    setTextSize(TypedValue.COMPLEX_UNIT_SP, 16f)
    // CSS line-height is 1.47 at 16px. Set the complete line box rather than adding
    // 4dp to Android's font-dependent default metrics.
    val lineHeight = TypedValue.applyDimension(TypedValue.COMPLEX_UNIT_SP, 23.52f, context.resources.displayMetrics)
    val leading = (lineHeight - (paint.fontMetricsInt.descent - paint.fontMetricsInt.ascent)).coerceAtLeast(0f)
    setLineSpacing(leading, 1f)
    letterSpacing = 0f
    breakStrategy = android.text.Layout.BREAK_STRATEGY_HIGH_QUALITY
    setBackgroundColor(Color.TRANSPARENT)
    val halfLeading = kotlin.math.round(leading / 2).toInt()
    setPadding(0, halfLeading, 0, halfLeading)
    includeFontPadding = false
    setTextIsSelectable(true)
    movementMethod = LinkMovementMethod.getInstance()
    linksClickable = true
    ellipsize = null
    maxLines = Int.MAX_VALUE
    setHorizontallyScrolling(false)
}

private fun createMarkwon(
    context: Context,
    linkColor: Int,
    codeColor: Int,
    codeBlockColor: Int,
    codeBackground: Int,
    codeBlockBackground: Int,
    onFile: (String) -> Unit,
): Markwon {
    return Markwon.builder(context)
        .usePlugin(
            object : AbstractMarkwonPlugin() {
                override fun configureTheme(builder: MarkwonTheme.Builder) {
                    // Markwon's core plugin owns headings, lists, quotes, fenced code, and
                    // inline code. This plugin only supplies the current Compose theme values.
                    builder
                        .linkColor(linkColor)
                        .codeTypeface(Typeface.MONOSPACE)
                        .codeBlockTypeface(Typeface.MONOSPACE)
                        .codeTextColor(codeColor)
                        .codeBlockTextColor(codeBlockColor)
                        .codeBackgroundColor(codeBackground)
                        .codeBlockBackgroundColor(codeBlockBackground)
                        .codeTextSize(TypedValue.applyDimension(TypedValue.COMPLEX_UNIT_SP, 13.5f, context.resources.displayMetrics).toInt())
                        .codeBlockTextSize(TypedValue.applyDimension(TypedValue.COMPLEX_UNIT_SP, 12.5f, context.resources.displayMetrics).toInt())
                        .codeBlockMargin(dp(context, 10f).toInt())
                        .blockMargin(dp(context, 12f).toInt())
                        .headingTextSizeMultipliers(floatArrayOf(1.5f, 1.3f, 1.15f, 1.05f, 1f, 1f))
                        .headingBreakHeight(0)
                        .isLinkUnderlined(false)
                }

                override fun configureConfiguration(builder: MarkwonConfiguration.Builder) {
                    builder.linkResolver(SafeLinkResolver(onFile))
                }
            },
        )
        .usePlugin(TablePlugin.create(TableTheme.buildWithDefaults(context).build()))
        .usePlugin(StrikethroughPlugin.create())
        .usePlugin(TaskListPlugin.create(context))
        .usePlugin(LinkifyPlugin.create(Linkify.WEB_URLS))
        .build()
}

private class SafeLinkResolver(private val onFile: (String) -> Unit) : LinkResolver {
    override fun resolve(view: View, link: String) {
        when (val destination = classifyMarkdownLink(link)) {
            is MarkdownLink.File -> onFile(destination.path)
            is MarkdownLink.Browser -> openBrowser(view.context, destination.url)
            MarkdownLink.Ignored -> Unit
        }
    }
}

internal sealed interface MarkdownLink {
    data class File(val path: String) : MarkdownLink
    data class Browser(val url: String) : MarkdownLink
    data object Ignored : MarkdownLink
}

/**
 * Classifies markdown destinations before any Android action is taken.
 *
 * Only local path forms reach the download callback and only http(s) reaches the browser. Schemes
 * such as intent:, javascript:, tel:, mailto:, and arbitrary custom schemes are ignored.
 */
internal fun classifyMarkdownLink(raw: String): MarkdownLink {
    val destination = raw.trim()
    if (destination.isEmpty() || destination.startsWith("#")) return MarkdownLink.Ignored

    val lower = destination.lowercase(Locale.ROOT)
    if (lower.startsWith("http://") || lower.startsWith("https://")) {
        val uri = runCatching { URI(destination) }.getOrNull()
        return if (uri?.host.isNullOrBlank().not()) MarkdownLink.Browser(destination) else MarkdownLink.Ignored
    }

    if (lower.startsWith("fvpath:")) {
        val path = percentDecode(destination.substring("fvpath:".length))
        return path.takeIf(String::isNotBlank)?.let(MarkdownLink::File) ?: MarkdownLink.Ignored
    }

    if (lower.startsWith("file:")) {
        val uri = runCatching { URI(destination) }.getOrNull() ?: return MarkdownLink.Ignored
        val host = uri.host
        if (!host.isNullOrBlank() && !host.equals("localhost", ignoreCase = true)) {
            return MarkdownLink.Ignored
        }
        val path = uri.path ?: return MarkdownLink.Ignored
        return path.takeIf(String::isNotBlank)?.let(MarkdownLink::File) ?: MarkdownLink.Ignored
    }

    if (destination.startsWith("/") || WINDOWS_ABSOLUTE_PATH.matches(destination)) {
        return MarkdownLink.File(destination)
    }

    // A bare relative markdown destination is a workspace file. Reject anything that has a
    // scheme-looking prefix so an unknown protocol can never become a file download request.
    if (!SCHEME_PREFIX.containsMatchIn(destination) && !destination.startsWith("//")) {
        return MarkdownLink.File(destination)
    }

    return MarkdownLink.Ignored
}

private val SCHEME_PREFIX = Regex("^[A-Za-z][A-Za-z0-9+.-]*:")
private val WINDOWS_ABSOLUTE_PATH = Regex("^[A-Za-z]:[\\\\/].*")

private fun percentDecode(value: String): String =
    runCatching { URLDecoder.decode(value.replace("+", "%2B"), StandardCharsets.UTF_8.name()) }
        .getOrDefault(value)

private fun openBrowser(context: Context, url: String) {
    val intent = Intent(Intent.ACTION_VIEW, Uri.parse(url)).apply {
        addCategory(Intent.CATEGORY_BROWSABLE)
    }
    try {
        context.startActivity(intent)
    } catch (_: ActivityNotFoundException) {
        // A device without a browser has no safe fallback action.
    }
}

private fun dp(context: Context, value: Float): Float =
    value * context.resources.displayMetrics.density
