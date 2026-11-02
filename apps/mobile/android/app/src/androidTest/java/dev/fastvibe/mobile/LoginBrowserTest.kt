package dev.fastvibe.mobile

import androidx.test.platform.app.InstrumentationRegistry
import dev.fastvibe.mobile.core.RustCoreBridge
import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertTrue
import org.junit.Test
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit

class LoginBrowserTest {
    @Test
    fun loginLaunchesInstalledBrowser() {
        val instrumentation = InstrumentationRegistry.getInstrumentation()
        val context = instrumentation.targetContext
        val launched = CountDownLatch(1)
        var failure: Throwable? = null
        lateinit var controller: MobileRuntimeController
        val notifications = ConversationNotifications(context)
        instrumentation.runOnMainSync {
            controller = MobileRuntimeController(context, SecureStore(context), notifications, onLoginUrl = { url ->
                try { openLoginBrowser(context, url) } catch (error: Exception) { failure = error }
                launched.countDown()
            })
            controller.beginLogin()
        }
        try {
            assertTrue("Login did not reach browser", launched.await(15, TimeUnit.SECONDS))
            failure?.let { throw AssertionError("Browser launch failed", it) }
        } finally {
            instrumentation.runOnMainSync { controller.close(); notifications.clear() }
        }
    }

    @Test
    fun browserIntentRetainsPkceFields() {
        val instrumentation = InstrumentationRegistry.getInstrumentation()
        var launched: android.content.Intent? = null
        val context = object : android.content.ContextWrapper(instrumentation.targetContext) {
            override fun startActivity(intent: android.content.Intent) { launched = intent }
        }
        openLoginBrowser(context, "https://app.fastvibe.dev/authorize?state=test-state&code_challenge=test-challenge&code_challenge_method=S256")
        assertEquals(android.content.Intent.ACTION_VIEW, launched?.action)
        assertTrue(launched!!.hasCategory(android.content.Intent.CATEGORY_BROWSABLE))
        assertEquals("test-state", launched?.data?.getQueryParameter("state"))
        assertEquals("test-challenge", launched?.data?.getQueryParameter("code_challenge"))
        assertTrue(launched!!.flags and android.content.Intent.FLAG_ACTIVITY_NEW_TASK != 0)
    }

    @Test
    fun controllerReportsBrowserLaunchFailure() {
        val instrumentation = InstrumentationRegistry.getInstrumentation()
        val context = instrumentation.targetContext
        val attempted = CountDownLatch(1)
        lateinit var controller: MobileRuntimeController
        val notifications = ConversationNotifications(context)
        instrumentation.runOnMainSync {
            controller = MobileRuntimeController(context, SecureStore(context), notifications, onLoginUrl = {
                attempted.countDown()
                throw android.content.ActivityNotFoundException("test browser unavailable")
            })
            controller.beginLogin()
        }
        try {
            assertTrue("Login never reached browser launch", attempted.await(15, TimeUnit.SECONDS))
            instrumentation.runOnMainSync {
                assertEquals("没有找到可用的浏览器，请安装或启用浏览器后重试。", controller.errorMessage)
                assertEquals(false, controller.loginPending)
            }
        } finally {
            instrumentation.runOnMainSync { controller.close(); notifications.clear() }
        }
    }

    @Test
    fun nativeLoginBuildsPkceUrlOnRuntimeWorker() {
        val latch = CountDownLatch(1)
        var response: JSONObject? = null
        val runtime = CoreRuntime(RustCoreBridge()) { _, _ -> }
        try {
            runtime.command("loginUrl", JSONObject().put("origin", DEFAULT_MOBILE_ACCOUNT_ORIGIN)
                .put("redirectUri", OAUTH_REDIRECT_URI).put("platform", "android")) {
                response = it
                latch.countDown()
            }
            assertTrue("Native login command did not complete", latch.await(15, TimeUnit.SECONDS))
            assertTrue(response?.errorMessage(), response!!.optBoolean("ok"))
            val result = response!!.getJSONObject("result")
            val uri = android.net.Uri.parse(result.getString("url"))
            assertEquals("app.fastvibe.dev", uri.host)
            assertEquals("/authorize", uri.path)
            assertEquals("S256", uri.getQueryParameter("code_challenge_method"))
            assertNotNull(uri.getQueryParameter("state"))
        } finally {
            runtime.close()
        }
    }
}
