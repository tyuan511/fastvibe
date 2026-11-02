package dev.fastvibe.mobile

import android.util.Log
import androidx.test.platform.app.InstrumentationRegistry
import dev.fastvibe.mobile.core.RustCoreBridge
import org.json.JSONObject
import org.junit.Assume.assumeTrue
import org.junit.Test

/** Opt-in network diagnosis; reads the saved account without changing it. */
class ConnectionDiagnosticTest {
    @Test
    fun inspectSavedAccountConnection() {
        assumeTrue(InstrumentationRegistry.getArguments().getString("diagnoseConnection") == "true")
        val store = SecureStore(InstrumentationRegistry.getInstrumentation().targetContext)
        val bridge = RustCoreBridge()
        fun command(action: String, payload: JSONObject = JSONObject()): JSONObject {
            val response = bridge.command(action, payload)
            check(response.optBoolean("ok")) { "$action failed: ${response.optJSONObject("error")?.optString("message")}" }
            return response
        }
        fun report(value: String) { Log.i("FVConnectionDiagnostic", value) }
        try {
            val origin = store.get("tokenOrigin") ?: error("No saved account origin")
            val token = store.get("token") ?: error("No saved account token")
            val identity = store.get("identity") ?: error("No saved transport identity")
            command("setToken", JSONObject().put("origin", origin).put("token", token))
            command("setIdentity", JSONObject().put("secretKey", identity))
            val localEndpoint = command("identity").getJSONObject("result").getString("endpointId")
            val devices = command("devices").getJSONArray("result")
            val preferred = InstrumentationRegistry.getArguments().getString("computerName") ?: "home mac-mini"
            var target: JSONObject? = null
            var registeredIdentity = false
            for (index in 0 until devices.length()) {
                val device = devices.getJSONObject(index)
                report("device=${device.optString("name")} online=${device.optBoolean("online")} endpointPresent=${device.has("irohEndpointId")}")
                if (device.optString("irohEndpointId") == localEndpoint) registeredIdentity = true
                if (device.optString("name") == preferred) target = device
            }
            report("savedIdentityRegistered=$registeredIdentity")
            val computer = target ?: error("Requested computer is absent")
            val remote = computer.optString("irohEndpointId").takeIf { it.isNotBlank() } ?: error("Computer has no iroh endpoint")
            val relay = command("relayToken", JSONObject().put("deviceId", computer.getString("id")).put("endpointId", localEndpoint)).getJSONObject("result")
            report("relayUrl=${relay.optString("url")} expiresAt=${relay.optString("expiresAt")}")
            command("connect", JSONObject().put("remoteId", remote).put("relay", relay))
            val deadline = System.nanoTime() + java.util.concurrent.TimeUnit.SECONDS.toNanos(32)
            var previous = ""
            var ready = false
            var failureAfterReady: String? = null
            while (System.nanoTime() < deadline) {
                val response = command("poll", JSONObject().put("limit", 128))
                val connection = response.optJSONObject("state")?.opt("connection")
                val line = connection.toString()
                if (line != previous) { report("connection=$line"); previous = line }
                if (line == "ready") ready = true
                else if (ready && line in setOf("disconnected", "error")) failureAfterReady = line
                val result = response.optJSONObject("result")
                val events = result?.optJSONArray("events") ?: response.optJSONArray("events")
                if (events != null) for (index in 0 until events.length()) {
                    val event = events.optJSONObject(index) ?: continue
                    val type = event.optString("type", event.optString("kind"))
                    report("event=$type message=${event.optString("message")} reason=${event.optString("reason")} code=${event.optString("code")}")
                }
                Thread.sleep(500)
            }
            check(ready) { "App Protocol welcome was never received" }
            check(failureAfterReady == null) { "Connection failed after welcome: $failureAfterReady" }
            if (InstrumentationRegistry.getArguments().getString("inspectConversation") == "true") {
                fun rpc(action: String, payload: JSONObject = JSONObject()): JSONObject {
                    val requestId = command(action, payload).getJSONObject("result").getLong("requestId")
                    val end = System.nanoTime() + java.util.concurrent.TimeUnit.SECONDS.toNanos(30)
                    while (System.nanoTime() < end) {
                        val response = command("poll", JSONObject().put("limit", 128))
                        val events = response.getJSONObject("result").getJSONArray("events")
                        for (index in 0 until events.length()) {
                            val event = events.optJSONObject(index) ?: continue
                            if (event.optString("kind") == "rpcResult" && event.optLong("requestId") == requestId) {
                                check(event.optBoolean("ok")) { "$action failed: ${event.optJSONObject("error")?.optString("message")}" }
                                return event
                            }
                        }
                        Thread.sleep(100)
                    }
                    error("$action timed out")
                }
                val before = rpc("listConversations").getJSONObject("result")
                val desktopActive = before.optString("activeId")
                val conversations = before.getJSONArray("conversations")
                val candidate = (0 until conversations.length()).map { conversations.getJSONObject(it) }
                    .first { it.getString("id") != desktopActive && !it.optBoolean("archived") }
                val id = candidate.getString("id")
                rpc("openConversation", JSONObject().put("id", id))
                val snapshot = rpc("snapshot", JSONObject().put("conversationId", id).put("historyLimit", 12)).getJSONObject("result")
                val nativeState = command("poll").getJSONObject("state")
                val parsed = parseRuntimeState(nativeState)
                val wireCount = snapshot.getJSONArray("messages").length()
                val nativeCount = nativeState.getJSONObject("snapshot").getJSONArray("messages").length()
                val androidCount = parsed.snapshot?.messages?.size ?: 0
                val after = rpc("listConversations").getJSONObject("result")
                check(after.optString("activeId") == desktopActive) { "Mobile browsing changed the desktop active conversation" }
                val expectedCount = minOf(wireCount, 120)
                check(wireCount > 0 && nativeCount == expectedCount && androidCount == expectedCount) {
                    "Transcript counts differ: wire=$wireCount expected=$expectedCount core=$nativeCount android=$androidCount"
                }
                val wireMessages = snapshot.getJSONArray("messages")
                check(parsed.snapshot?.messages?.map { it.id } == (wireCount - expectedCount until wireCount).map {
                    wireMessages.getJSONObject(it).getString("id")
                }) { "Android transcript does not match the server's visible tail" }
                check(parsed.snapshot?.conversationId == id)
                report("independentBrowsing=true wireMessages=$wireCount coreMessages=$nativeCount androidMessages=$androidCount")
            }
        } finally {
            bridge.command("disconnect")
        }
    }
}
