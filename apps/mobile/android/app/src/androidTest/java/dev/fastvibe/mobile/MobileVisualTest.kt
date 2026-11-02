package dev.fastvibe.mobile

import androidx.activity.ComponentActivity
import androidx.compose.foundation.Image
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.runtime.mutableStateOf
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.res.painterResource
import androidx.compose.ui.test.assertHasClickAction
import androidx.compose.ui.test.junit4.createAndroidComposeRule
import androidx.compose.ui.test.onNodeWithContentDescription
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.performTouchInput
import androidx.compose.ui.unit.dp
import androidx.test.platform.app.InstrumentationRegistry
import org.junit.Assert.assertEquals
import org.junit.Rule
import org.junit.Test
import java.io.File

class MobileVisualTest {
    @get:Rule val compose = createAndroidComposeRule<ComponentActivity>()

    @Test
    fun renderStatelessSurfacesAndVerifyPressedIcon() {
        val screen = mutableStateOf("login")
        val dark = mutableStateOf(false)
        var clicks = 0
        compose.setContent {
            FastVibeTheme(dark.value) {
                GlassBackdropHost {
                    when (screen.value) {
                        "login" -> AccountLoginContent(false, null) {}
                        "connecting" -> ConnectionProgressContent("Yuan 的 MacBook Pro", false, onBack = {})
                        "failed" -> ConnectionProgressContent("Yuan 的 MacBook Pro", true, "连接超时。请确认电脑上的 FastVibe 正在运行。", {}, {})
                        else -> GlassBackground {
                            Column(Modifier.fillMaxSize().padding(horizontal = 16.dp, vertical = 56.dp), verticalArrangement = Arrangement.spacedBy(16.dp)) {
                                Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.End) {
                                    GlassIconButton(R.drawable.fv_settings, "设置", { clicks++ })
                                }
                                ConversationMessage(MessageView("user", "user", "手机上看长回复时连接总会断，帮我查一下。")) {}
                                ConversationMessage(MessageView("reply", "assistant", "", tools = listOf(ToolView("read", "read", "done", "{\"path\":\"src/main/server/backpressure.ts\"}"), ToolView("bash", "bash", "running", "{\"command\":\"pnpm test backpressure\"}")), parts = listOf(PartView("thinking", body = "我先检查连接的背压实现。"), PartView("text", body = "4004 是服务端判定客户端太慢时主动断开的。我先看一下背压的实现。"), PartView("tool", toolId = "read"), PartView("tool", toolId = "bash")))) {}
                                ConversationComposer("", true, false, emptyList(), {}, {}, {}, {}, { _, _ -> })
                            }
                        }
                    }
                }
            }
        }
        for (theme in listOf(false, true)) {
            compose.runOnIdle { dark.value = theme }
            for (name in listOf("login", "connecting", "failed", "thread")) {
                compose.runOnIdle { screen.value = name }
                compose.mainClock.advanceTimeBy(1000)
                compose.waitForIdle()
                Thread.sleep(350)
                capture("visual-$name-${if (theme) "dark" else "light"}")
            }
        }
        compose.runOnIdle { dark.value = false; screen.value = "thread" }
        compose.onNodeWithContentDescription("设置").assertHasClickAction()
        compose.onNodeWithContentDescription("设置").performTouchInput { down(center) }
        compose.mainClock.advanceTimeBy(160)
        capture("visual-icon-pressed")
        compose.onNodeWithContentDescription("设置").performTouchInput { up() }
        compose.runOnIdle { assertEquals(1, clicks) }
    }

    @Test
    fun renderSettingsAndPromptTypesWithoutStartingAccountRuntime() {
        val context = InstrumentationRegistry.getInstrumentation().targetContext
        val controller = MobileRuntimeController(context, SecureStore(context), ConversationNotifications(context), {})
        val screen = mutableStateOf("settings")
        val dark = mutableStateOf(false)
        compose.setContent {
            FastVibeTheme(dark.value) {
                GlassBackdropHost {
                    GlassBackground {
                        if (screen.value == "settings") Box(Modifier.fillMaxSize().padding(top = 56.dp)) {
                            MobileSettingsScreen(controller, "auto", {}, {})
                        }
                        else MobilePendingUiSheet(controller, PendingUiView("visual", screen.value, "需要你确认", "请查看本次操作后选择。", options = listOf(PendingOptionView("a", "使用推荐方案", "保留当前配置"), PendingOptionView("b", "使用其他方案")), questions = listOf(PendingQuestionView("q", "选择处理方式", options = listOf(PendingOptionView("a", "继续"))))), {})
                    }
                }
            }
        }
        for (theme in listOf(false, true)) {
            compose.runOnIdle { dark.value = theme }
            for (name in listOf("settings", "confirm", "select", "input", "questions")) {
                compose.runOnIdle { screen.value = name }
                if (name != "settings") compose.onNodeWithText("需要你确认").assertExists()
                compose.mainClock.advanceTimeBy(1000)
                compose.waitForIdle()
                Thread.sleep(350)
                capture("visual-$name-${if (theme) "dark" else "light"}")
            }
        }
        compose.runOnIdle { screen.value = "settings" }
    }

    private fun capture(name: String) {
        compose.waitForIdle()
        val instrumentation = InstrumentationRegistry.getInstrumentation()
        val bitmap = instrumentation.uiAutomation.takeScreenshot()
        File(instrumentation.targetContext.cacheDir, "$name.png").outputStream().use {
            bitmap.compress(android.graphics.Bitmap.CompressFormat.PNG, 100, it)
        }
        bitmap.recycle()
    }
}
