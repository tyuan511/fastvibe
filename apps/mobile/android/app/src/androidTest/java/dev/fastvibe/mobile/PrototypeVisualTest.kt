package dev.fastvibe.mobile

import android.content.Context
import android.content.ContextWrapper
import android.content.SharedPreferences
import android.graphics.Bitmap
import android.util.Log
import androidx.activity.ComponentActivity
import androidx.activity.enableEdgeToEdge
import androidx.compose.runtime.Composable
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.MutableState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.key
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.SemanticsMatcher
import androidx.compose.ui.semantics.SemanticsProperties
import androidx.compose.ui.test.onLast
import androidx.compose.ui.test.hasClickAction
import androidx.compose.ui.test.hasScrollToIndexAction
import androidx.compose.ui.test.hasText
import androidx.compose.ui.test.junit4.createAndroidComposeRule
import androidx.compose.ui.test.onNodeWithContentDescription
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.onNodeWithTag
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.performScrollTo
import androidx.compose.ui.test.performScrollToIndex
import androidx.compose.ui.test.performTextReplacement
import androidx.compose.ui.test.performTouchInput
import androidx.compose.ui.test.swipeUp
import androidx.core.view.WindowInsetsCompat
import androidx.core.view.WindowInsetsControllerCompat
import androidx.test.platform.app.InstrumentationRegistry
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import java.io.File

/**
 * Real production UI, exact sample copy from design/prototype-standalone.html.
 *
 * Run only on the isolated .visual application. The coordinator supplies the emulator viewport;
 * this fixture never calls wm, changes display density, logs in, or starts the controller.
 * Optional instrumentation argument: -e prototypeState streaming (or any state in PAGES).
 * PNGs are full uiAutomation screenshots in targetContext.cacheDir, not Compose node captures.
 */
class PrototypeVisualTest {
    @get:Rule val compose = createAndroidComposeRule<ComponentActivity>()

    private val instrumentation get() = InstrumentationRegistry.getInstrumentation()
    private val screen = mutableStateOf("login")
    private val dark = mutableStateOf(false)
    private val generation = mutableStateOf(0)
    private val overlay = mutableStateOf<String?>(null)
    private lateinit var controller: MobileRuntimeController
    private lateinit var fixtureContext: PrototypeContext
    private var selectedProject: String? = null
    private var selectedModel: String? = null

    @Test
    fun capturePrototypePagesAndSheets() {
        val target = instrumentation.targetContext
        check(target.packageName.endsWith(".visual")) {
            "Prototype screenshots require applicationIdSuffix=.visual; refusing to use the real app."
        }
        val secureBefore = target.getSharedPreferences("fastvibe-secure", Context.MODE_PRIVATE).all.toMap()
        fixtureContext = PrototypeContext(target)
        compose.runOnUiThread {
            compose.activity.enableEdgeToEdge()
            controller = MobileRuntimeController(
                fixtureContext, SecureStore(fixtureContext), ConversationNotifications(fixtureContext),
                onLoginUrl = { error("The visual fixture must never start login") },
            )
        }
        try {
            compose.setContent {
                FastVibeTheme(dark.value) {
                    GlassBackdropHost {
                        CompositionLocalProvider(LocalTranscriptClock provides { PrototypeData.NOW }) {
                            key(generation.value) { FixtureContent() }
                        }
                    }
                }
            }
            val requested = InstrumentationRegistry.getArguments().getString("prototypeState")
            check(requested == null || requested in PAGES) { "Unknown prototypeState=$requested; choose $PAGES" }
            for (isDark in listOf(false, true)) {
                compose.runOnIdle {
                    dark.value = isDark
                    val bars = WindowInsetsControllerCompat(compose.activity.window, compose.activity.window.decorView)
                    bars.isAppearanceLightStatusBars = !isDark
                    bars.isAppearanceLightNavigationBars = !isDark
                }
                for (page in PAGES.filter { requested == null || it == requested }) {
                    show(page)
                    when (page) {
                        "thread" -> captureThread()
                        "streaming" -> {
                            scrollTop()
                            // The reference's thinking disclosure is open; reach it through the real UI.
                            thinkingNode().performScrollTo().performClick()
                            scrollTop()
                            capture(page)
                            compose.onNodeWithText("测试一下，确保滚动加载和快照恢复都没问题").performClick()
                            compose.onNodeWithText("立即发送").assertIsDisplayed()
                            instrumentation.sendKeyDownUpSync(android.view.KeyEvent.KEYCODE_BACK)
                            settle()
                            compose.onNodeWithText("立即发送").assertDoesNotExist()
                        }
                        "history" -> {
                            compose.onNodeWithText("执行了 1 个步骤").performScrollTo().performClick()
                            compose.onNodeWithText("apps/mobile/core/src/lib.rs", substring = true).performScrollTo().performClick()
                            scrollTop()
                            capture(page)
                            scrollBottom()
                            capture("history-diff")
                        }
                        "chats" -> {
                            capture(page)
                            compose.onNode(hasScrollToIndexAction()).performTouchInput { swipeUp() }
                            settle()
                            assertHeaderSeparated("main-header")
                            capture("chats-scrolled")
                            compose.onNodeWithContentDescription("筛选会话").assertIsDisplayed()
                            compose.onNode(hasScrollToIndexAction()).performScrollToIndex(0)
                        }
                        else -> capture(page)
                    }
                    when (page) {
                        "computers" -> captureOfflineSheet()
                        "connect" -> {
                            show("connect-failed")
                            capture("connect-failed")
                        }
                        "chats" -> captureCatalogSheets()
                        "thread" -> captureModelSheet()
                        "pending" -> capturePendingSheets()
                    }
                }
            }
        } finally {
            compose.runOnIdle { overlay.value = null; controller.close() }
            assertEquals("Visual fixtures must not write account storage", secureBefore,
                target.getSharedPreferences("fastvibe-secure", Context.MODE_PRIVATE).all.toMap())
        }
    }

    @Composable
    private fun FixtureContent() {
        when (screen.value) {
            "login" -> AccountLoginContent(false, null) {}
            "connect" -> ConnectionProgressContent("Yuan 的 MacBook Pro", false, onBack = {})
            "connect-failed" -> ConnectionProgressContent(
                "Yuan 的 MacBook Pro", true, "15 秒内没有响应", {}, {},
            )
            else -> ProductShell(
                controller = controller,
                page = when (screen.value) {
                    "computers" -> AppPage.COMPUTERS
                    "settings" -> AppPage.SETTINGS
                    else -> AppPage.CONVERSATIONS
                },
                detailId = PrototypeData.detailId(screen.value),
                themeKey = "auto",
                onPageChange = {},
                onOpen = {},
                onCreate = { overlay.value = "project" },
                onOffline = { overlay.value = "offline" },
                onTheme = {},
                onModel = { overlay.value = "model" },
                onAttach = {},
                attachments = emptyList(),
                onRemoveAttachment = {},
                onDismissDetail = {},
                onError = { error(it) },
                onCheckUpdates = {},
                promptPresented = overlay.value in setOf("confirm", "select", "input"),
            )
        }
        when (val sheet = overlay.value) {
            "offline" -> OfflineComputerSheet(PrototypeData.devices.last(), "tyuan511") { overlay.value = null }
            "project" -> ProjectSelectionSheet(PrototypeData.projects, false, { overlay.value = null }) {
                selectedProject = it?.id ?: "__unassigned__"
            }
            // Use the stateless production picker: its controller wrapper calls loadModels on entry.
            "model" -> MobileModelPickerContent(
                PrototypeData.models, "anthropic/claude-sonnet-4.5", "medium",
                { overlay.value = null },
                { selectedModel = it.id; overlay.value = null },
                { overlay.value = null },
            )
            "confirm", "select", "input" -> MobilePendingUiSheet(
                controller, PrototypeData.pending.getValue(sheet), { overlay.value = null },
            )
        }
    }

    private fun show(page: String) {
        compose.runOnIdle {
            inject("state", PrototypeData.state(page))
            inject("devices", PrototypeData.devices)
            inject("accountReady", true)
            screen.value = page
            overlay.value = if (page == "pending") "confirm" else null
            generation.value++
        }
        settle()
    }

    /** Mutate only the existing Compose state delegates; no SDK events, commands, or credentials. */
    @Suppress("UNCHECKED_CAST")
    private fun <T> inject(property: String, value: T) {
        val field = MobileRuntimeController::class.java.getDeclaredField("${property}\$delegate")
        field.isAccessible = true
        (field.get(controller) as MutableState<T>).value = value
    }

    private fun captureOfflineSheet() {
        compose.onNodeWithText("家里的 Windows").performClick()
        compose.onNodeWithText("家里的 Windows 不在线").assertIsDisplayed()
        capture("offline")
        compose.onNodeWithText("知道了").performClick()
        compose.onNodeWithText("家里的 Windows").assertIsDisplayed()
    }

    private fun captureCatalogSheets() {
        // Open filtering and project selection through the production header controls.
        compose.onNodeWithContentDescription("筛选会话").performClick()
        compose.onNodeWithText("所有项目").assertIsDisplayed()
        capture("filter")
        compose.onNode(hasText("运行中") and hasClickAction() and
            SemanticsMatcher.expectValue(SemanticsProperties.StateDescription, "未选择")).performClick()
        compose.onNodeWithText("完成").performClick()
        compose.onNodeWithText("发布 0.9.2 版本").assertDoesNotExist()
        capture("filter-running")
        show("chats")
        compose.onNodeWithContentDescription("新建会话").performClick()
        compose.onNodeWithText("选择这次会话的项目").assertIsDisplayed()
        capture("project")
        compose.onAllNodes(hasText("fastvibe-services") and hasClickAction()).onLast().performClick()
        compose.runOnIdle { assertEquals("fastvibe-services", selectedProject) }
        compose.onNodeWithText("选择这次会话的项目").assertDoesNotExist()
    }

    private fun captureThread() {
        scrollTop()
        capture("thread")
        compose.onNodeWithText("执行了 3 个步骤").performScrollTo().performClick()
        compose.onNodeWithText("src/main/server/backpressure.ts", substring = true).performScrollTo().performClick()
        capture("thread-read")
        compose.onNodeWithText("执行了 3 个步骤").performScrollTo().performClick()
        scrollBottom()
        compose.onNodeWithText("执行了 2 个步骤").performScrollTo().performClick()
        compose.onNodeWithText("backpressure.ts", substring = false).performScrollTo().performClick()
        capture("thread-diff")
        scrollBottom()
        capture("thread-bottom")
        compose.onNode(hasScrollToIndexAction()).performTouchInput { swipeUp() }
        settle()
        assertHeaderSeparated("thread-header")
        capture("thread-scrolled")
        compose.onNodeWithContentDescription("更多").assertIsDisplayed()
    }

    private fun captureModelSheet() {
        compose.onNodeWithContentDescription("更多").performClick()
        capture("model")
        compose.onNodeWithText("anthropic", substring = false).performClick()
        compose.onNodeWithText("claude-sonnet-4.5", substring = false).assertIsDisplayed()
        capture("model-expanded")
        compose.onNodeWithText("claude-sonnet-4.5", substring = false).performClick()
        compose.runOnIdle { assertEquals("claude-sonnet-4.5", selectedModel) }
    }

    private fun capturePendingSheets() {
        // The default pending-page capture is the exact reference's confirmation state.
        capture("confirm")
        compose.runOnIdle { overlay.value = "select" }
        settle()
        capture("select")
        compose.onNodeWithText("测试版").performClick()
        capture("select-beta")
        compose.runOnIdle { overlay.value = "input" }
        settle()
        compose.onNodeWithContentDescription("回答").assertExists()
        capture("input")
        compose.onNodeWithContentDescription("回答").performTextReplacement("远程连接更稳定了")
        compose.runOnIdle {
            WindowInsetsControllerCompat(compose.activity.window, compose.activity.window.decorView)
                .hide(WindowInsetsCompat.Type.ime())
        }
        capture("input-edited")
        // Never press submit/allow/logout: production callbacks would issue runtime commands.
        compose.runOnIdle { overlay.value = null }
    }

    private fun assertHeaderSeparated(tag: String) {
        val header = compose.onNodeWithTag(tag).fetchSemanticsNode().boundsInRoot
        val content = compose.onNodeWithTag("page-content").fetchSemanticsNode().boundsInRoot
        assertTrue("Scrolling content must start below the header: $header / $content", content.top >= header.bottom - 1f)
    }

    private fun thinkingNode() = compose.onNodeWithText("思考", substring = true)
    private fun scrollTop() { compose.onNode(hasScrollToIndexAction()).performScrollToIndex(0); settle() }
    private fun scrollBottom() {
        // The last scroll container is the transcript (the history capsule is a separate header).
        val count = controller.state.snapshot?.messages?.size ?: return
        val historyRow = controller.state.snapshot?.historyBeforeEntryId != null && !controller.state.loadingHistory
        compose.onAllNodes(hasScrollToIndexAction()).onLast().performScrollToIndex(count - 1 + if (historyRow) 1 else 0)
        settle()
    }
    private fun settle() {
        compose.mainClock.advanceTimeBy(1000)
        compose.waitForIdle()
        // Allow Android's sheet window/inset animations and Haze's render pass to finish too.
        Thread.sleep(350)
    }
    private fun capture(state: String) {
        settle()
        val name = "prototype-$state-${if (dark.value) "dark" else "light"}.png"
        val bitmap = checkNotNull(instrumentation.uiAutomation.takeScreenshot()) { "Screenshot unavailable: $name" }
        val file = File(instrumentation.targetContext.cacheDir, name)
        try {
            file.outputStream().use { assertTrue(bitmap.compress(Bitmap.CompressFormat.PNG, 100, it)) }
            assertTrue("Empty screenshot: $name", file.length() > 0)
            Log.i("PrototypeVisualTest", "${file.absolutePath} (${bitmap.width}x${bitmap.height})")
        } finally { bitmap.recycle() }
    }

    companion object {
        private val PAGES = listOf("login", "computers", "connect", "chats", "thread", "new", "streaming", "history", "pending", "settings")
    }
}

/** A process-local preference store means drafts/device selection cannot alter even .visual data. */
private class PrototypeContext(base: Context) : ContextWrapper(base) {
    private val stores = mutableMapOf<String, SharedPreferences>()
    override fun getApplicationContext(): Context = this
    override fun getSharedPreferences(name: String, mode: Int): SharedPreferences = stores.getOrPut(name) {
        MemoryPreferences(if (name == "fastvibe-ui") mapOf("lastDeviceId" to "mbp") else emptyMap())
    }
}

private class MemoryPreferences(initial: Map<String, Any>) : SharedPreferences {
    private val values = initial.toMutableMap()
    override fun getAll(): MutableMap<String, *> = values.toMutableMap()
    override fun getString(key: String?, defValue: String?): String? = values[key] as? String ?: defValue
    @Suppress("UNCHECKED_CAST")
    override fun getStringSet(key: String?, defValues: MutableSet<String>?): MutableSet<String>? =
        (values[key] as? Set<String>)?.toMutableSet() ?: defValues
    override fun getInt(key: String?, defValue: Int): Int = values[key] as? Int ?: defValue
    override fun getLong(key: String?, defValue: Long): Long = values[key] as? Long ?: defValue
    override fun getFloat(key: String?, defValue: Float): Float = values[key] as? Float ?: defValue
    override fun getBoolean(key: String?, defValue: Boolean): Boolean = values[key] as? Boolean ?: defValue
    override fun contains(key: String?): Boolean = key in values
    override fun registerOnSharedPreferenceChangeListener(listener: SharedPreferences.OnSharedPreferenceChangeListener?) = Unit
    override fun unregisterOnSharedPreferenceChangeListener(listener: SharedPreferences.OnSharedPreferenceChangeListener?) = Unit
    override fun edit(): SharedPreferences.Editor = object : SharedPreferences.Editor {
        private val changes = mutableMapOf<String, Any?>()
        private var clear = false
        override fun putString(key: String?, value: String?) = apply { if (key != null) changes[key] = value }
        override fun putStringSet(key: String?, values: MutableSet<String>?) = apply { if (key != null) changes[key] = values?.toSet() }
        override fun putInt(key: String?, value: Int) = apply { if (key != null) changes[key] = value }
        override fun putLong(key: String?, value: Long) = apply { if (key != null) changes[key] = value }
        override fun putFloat(key: String?, value: Float) = apply { if (key != null) changes[key] = value }
        override fun putBoolean(key: String?, value: Boolean) = apply { if (key != null) changes[key] = value }
        override fun remove(key: String?) = apply { if (key != null) changes[key] = null }
        override fun clear() = apply { clear = true }
        override fun commit(): Boolean {
            if (clear) values.clear()
            changes.forEach { (key, value) -> if (value == null) values.remove(key) else values[key] = value }
            return true
        }
        override fun apply() { commit() }
    }
}
