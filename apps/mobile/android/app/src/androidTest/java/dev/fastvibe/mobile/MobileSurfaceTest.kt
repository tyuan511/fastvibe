package dev.fastvibe.mobile

import androidx.activity.ComponentActivity
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.lightColorScheme
import androidx.compose.runtime.mutableStateOf
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.junit4.createAndroidComposeRule
import androidx.compose.ui.test.onNodeWithContentDescription
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.performTextInput
import androidx.test.platform.app.InstrumentationRegistry
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Rule
import org.junit.Test
import java.io.File

class MobileSurfaceTest {
    @get:Rule val compose = createAndroidComposeRule<ComponentActivity>()

    @Test
    fun projectPickerSelectsProjectAndOffersUnassigned() {
        val project = ProjectView("project", "fastvibe", "/workspace/fastvibe")
        var selected: ProjectView? = null
        var dismissed = false
        compose.setContent {
            MaterialTheme(lightColorScheme(background = Color(0xFFEEF0F7))) {
                GlassBackdropHost {
                    GlassBackground {}
                    ProjectSelectionSheet(listOf(project), false, { dismissed = true }, { selected = it })
                }
            }
        }
        compose.onNodeWithText("选择这次会话的项目").assertIsDisplayed()
        compose.onNodeWithText("未归属项目").assertIsDisplayed()
        capture("project-picker")
        compose.onNodeWithText("fastvibe").performClick()
        compose.runOnIdle { assertEquals(project, selected); assertEquals(true, dismissed) }
    }

    @Test
    fun unassignedProjectReturnsNull() {
        var selected: ProjectView? = ProjectView("sentinel", "sentinel")
        compose.setContent {
            MaterialTheme {
                ProjectSelectionSheet(emptyList(), false, {}, { selected = it })
            }
        }
        compose.onNodeWithText("未归属项目").performClick()
        compose.runOnIdle { assertNull(selected) }
    }

    @Test
    fun composerSendsDraftAndRunningComposerCanStop() {
        val draft = mutableStateOf("")
        val running = mutableStateOf(false)
        var sent = ""
        var stopped = false
        compose.setContent {
            MaterialTheme(lightColorScheme(background = Color(0xFFEEF0F7))) {
                GlassBackground {
                    ConversationComposer(draft.value, true, running.value, emptyList(), { draft.value = it }, {}, {}, { stopped = true }, { text, _ -> sent = text })
                }
            }
        }
        compose.onNodeWithText("发送消息").performTextInput("核对界面")
        compose.onNodeWithContentDescription("发送").performClick()
        compose.runOnIdle { assertEquals("核对界面", sent); draft.value = ""; running.value = true }
        compose.onNodeWithContentDescription("停止").performClick()
        compose.runOnIdle { assertEquals(true, stopped) }
    }

    @Test
    fun offlineSheetShowsRecoveryStepsAndDismisses() {
        var dismissed = false
        compose.setContent {
            MaterialTheme(lightColorScheme(background = Color(0xFFEEF0F7))) {
                GlassBackdropHost {
                    GlassBackground {}
                    OfflineComputerSheet(DeviceView("offline", "家里的电脑", "darwin", null, false), "test-user", { dismissed = true })
                }
            }
        }
        compose.onNodeWithText("家里的电脑 不在线").assertIsDisplayed()
        compose.onNodeWithText("确认登录的是 test-user 这个账号").assertIsDisplayed()
        capture("offline-sheet")
        compose.onNodeWithText("知道了").performClick()
        compose.runOnIdle { assertEquals(true, dismissed) }
    }

    @Test
    fun modelPickerGroupsProvidersAndKeepsOnlyOneExpanded() {
        val models = listOf(ModelView("provider-a", "alpha", "Alpha"), ModelView("provider-a", "beta", "Beta"), ModelView("provider-b", "gamma", "Gamma"))
        var selected: ModelView? = null
        compose.setContent {
            FastVibeTheme(false) {
                GlassBackdropHost {
                    GlassBackground {}
                    MobileModelPickerContent(models, "provider-a/alpha", null, {}, { selected = it }, {})
                }
            }
        }
        compose.onNodeWithText("provider-a").assertIsDisplayed()
        compose.onNodeWithText("Alpha").assertDoesNotExist()
        compose.onNodeWithText("provider-a").performClick()
        compose.onNodeWithText("Alpha").assertIsDisplayed()
        compose.onNodeWithText("provider-b").performClick()
        compose.onNodeWithText("Alpha").assertDoesNotExist()
        compose.onNodeWithText("Gamma").assertIsDisplayed()
        compose.onNodeWithText("Gamma").performClick()
        compose.runOnIdle { assertEquals(models.last(), selected) }
        compose.mainClock.advanceTimeBy(1000)
        capture("model-provider-picker")
    }

    @Test
    fun conversationFilterCombinesStatusAndProject() {
        val filter = mutableStateOf(ConversationCatalogFilter())
        var dismissed = false
        val workspace = WorkspaceView(projects = listOf(ProjectView("one", "项目一", "/one"), ProjectView("two", "项目二", "/two")))
        compose.setContent {
            FastVibeTheme(false) {
                GlassBackdropHost {
                    GlassBackground {}
                    ConversationFilterSheet(workspace, filter.value, { filter.value = it }, { dismissed = true })
                }
            }
        }
        compose.onNodeWithText("运行中").performClick()
        compose.onNodeWithText("项目二").performClick()
        compose.runOnIdle {
            assertEquals(ConversationCatalogFilter("running", "two"), filter.value)
        }
        compose.mainClock.advanceTimeBy(1000)
        compose.waitForIdle()
        Thread.sleep(350)
        capture("conversation-filter")
        compose.onNodeWithText("完成").performClick()
        compose.runOnIdle { assertEquals(true, dismissed) }
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
