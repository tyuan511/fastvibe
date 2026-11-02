package dev.fastvibe.mobile

import android.content.Context
import android.os.Handler
import android.os.Looper
import android.util.Log
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import dev.fastvibe.mobile.core.RustCoreBridge
import org.json.JSONArray
import org.json.JSONObject
import java.net.URI
import java.util.UUID
import java.util.concurrent.Executors
import java.util.concurrent.ScheduledExecutorService
import java.util.concurrent.ScheduledFuture
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicBoolean

private const val POLL_INTERVAL_MS = 250L
private const val TAG = "FastVibeRuntime"
internal const val DEFAULT_MOBILE_ACCOUNT_ORIGIN = "https://app.fastvibe.dev"

/** The JNI handle is serialized, while callbacks are always delivered on Main. */
internal class CoreRuntime(
    private val bridge: RustCoreBridge,
    private val onResponse: (String, JSONObject) -> Unit,
) {
    private val executor: ScheduledExecutorService = Executors.newSingleThreadScheduledExecutor { task ->
        Thread(task, "fastvibe-mobile-core").apply { isDaemon = true }
    }
    private val main = Handler(Looper.getMainLooper())
    private val closed = AtomicBoolean(false)
    private var poll: ScheduledFuture<*>? = null

    fun command(action: String, payload: JSONObject? = null, completion: ((JSONObject) -> Unit)? = null) {
        if (closed.get()) return
        executor.execute {
            val response = execute(action, payload)
            publish(action, response)
            completion?.let { callback -> main.post { if (!closed.get()) callback(response) } }
        }
    }

    fun sequence(work: (CommandSession) -> Unit, completion: ((Throwable?) -> Unit)? = null) {
        if (closed.get()) return
        executor.execute {
            var failure: Throwable? = null
            try {
                work(CommandSession(this))
            } catch (error: Exception) {
                failure = error
            } finally {
                completion?.let { callback -> main.post { if (!closed.get()) callback(failure) } }
            }
        }
    }

    fun background(work: () -> Unit, completion: ((Throwable?) -> Unit)? = null) {
        if (closed.get()) return
        executor.execute {
            var failure: Throwable? = null
            try { work() } catch (error: Exception) { failure = error }
            completion?.let { callback -> main.post { if (!closed.get()) callback(failure) } }
        }
    }

    @Synchronized
    fun startPolling() {
        if (closed.get() || poll != null) return
        poll = executor.scheduleWithFixedDelay({
            if (!closed.get()) publish("poll", execute("poll", JSONObject().put("limit", 128)))
        }, 0, POLL_INTERVAL_MS, TimeUnit.MILLISECONDS)
    }

    @Synchronized
    fun stopPolling() {
        poll?.cancel(false)
        poll = null
    }

    fun close() {
        if (!closed.compareAndSet(false, true)) return
        stopPolling()
        executor.execute {
            runCatching { bridge.commandJson(RustCoreBridge.commandRequestJson("disconnect")) }
        }
        executor.shutdown()
    }

    private fun execute(action: String, payload: JSONObject?): JSONObject {
        if (closed.get()) return errorResponse(action, "runtime is closed")
        return try {
            JSONObject(bridge.commandJson(RustCoreBridge.commandRequestJson(action, payload?.toString())))
        } catch (error: Exception) {
            Log.w(TAG, "Core command failed: $action (${error.javaClass.simpleName})")
            errorResponse(action, "手机运行服务暂时不可用，请重新打开应用。")
        }
    }

    private fun publish(action: String, response: JSONObject) {
        main.post { if (!closed.get()) onResponse(action, response) }
    }

    private fun errorResponse(action: String, message: String) = JSONObject()
        .put("ok", false).put("action", action).put("error", JSONObject().put("message", message))

    class CommandSession internal constructor(private val runtime: CoreRuntime) {
        fun command(action: String, payload: JSONObject? = null): JSONObject {
            if (BuildConfig.DEBUG && action in setOf("disconnect", "identity", "registerDevice", "registerEndpoint", "relayToken", "connect")) Log.i(TAG, "Connection preparation: $action started")
            return runtime.execute(action, payload).also { response ->
                if (BuildConfig.DEBUG && action in setOf("disconnect", "identity", "registerDevice", "registerEndpoint", "relayToken", "connect")) Log.i(TAG, "Connection preparation: $action completed ok=${response.optBoolean("ok")}")
            }
        }
    }
}

internal class MobileRuntimeController(
    context: Context,
    private val secureStore: SecureStore,
    private val notifications: ConversationNotifications,
    private val onLoginUrl: (String) -> Unit,
    accountOrigin: String = DEFAULT_MOBILE_ACCOUNT_ORIGIN,
) {
    private val appContext = context.applicationContext
    private val preferences = appContext.getSharedPreferences("fastvibe-ui", Context.MODE_PRIVATE)
    private val core = CoreRuntime(RustCoreBridge(), ::onCoreResponse)
    private val pending = RpcResultTracker()
    private val bufferedResults = linkedMapOf<Long, RpcResult>()
    private val main = Handler(Looper.getMainLooper())
    private val globalPrompts = linkedMapOf<String, JSONObject>()
    private var foreground = true
    private var closed = false
    private var selectedDevice: DeviceView? = null
    private var expectedLoginState: String? = null
    private var authenticated = false
    private var accountGeneration = 0L
    private var started = false
    private var catalogLoading = false
    private var connectionAttempt: DeviceView? = null
    private var connectionGeneration = 0L
    private var selectionGeneration = 0L
    private var reconnectCount = 0
    private var intentionalDisconnect = false
    private var preparingConnection = false
    private var reconnectTask: Runnable? = null
    private var subscribedConversation: String? = null
    private var pendingOpenId: String? = null

    val accountServiceOrigin: String = checkedAccountOrigin(accountOrigin)

    var state by mutableStateOf(MobileRuntimeState())
        private set
    var devices by mutableStateOf<List<DeviceView>>(emptyList())
        private set
    var accountReady by mutableStateOf(false)
        private set
    var busy by mutableStateOf(false)
        private set
    var catalogLoadingState by mutableStateOf(false)
        private set
    var snapshotLoading by mutableStateOf(false)
        private set
    var snapshotError by mutableStateOf<String?>(null)
        private set
    var errorMessage by mutableStateOf<String?>(null)
        private set
    var loginPending by mutableStateOf(false)
        private set
    var editorText by mutableStateOf("")
        private set
    private var submittingConversations by mutableStateOf<Set<String>>(emptySet())

    fun isSubmitting(conversationId: String): Boolean = conversationId in submittingConversations
    fun consumeEditorText() { editorText = "" }

    fun start(callback: OAuthCallback?, notificationConversationId: String?) {
        notificationConversationId?.let(::handleNotification)
        if (started) {
            callback?.let(::handleCallback)
            return
        }
        started = true
        var token: String? = null
        var issuer: String? = null
        var identity: String? = null
        var user: String? = null
        val generation = accountGeneration
        core.background({
            secureStore.migrateFlutterAccount()
            identity = secureStore.get("identity")
            token = secureStore.get("token")
            issuer = secureStore.get("tokenOrigin")
            user = secureStore.get("accountUser")
        }) { failure ->
            if (generation != accountGeneration) return@background
            if (failure != null || secureStore.readFailure != null) {
                errorMessage = failure?.message ?: secureStore.readFailure
            }
            identity?.let { core.command("setIdentity", JSONObject().put("secretKey", it)) }
            if (token != null && issuer != null) {
                if (issuer!!.trimEnd('/') == accountServiceOrigin) {
                    state = state.copy(accountUser = user?.let { runCatching { JSONObject(it).stringOrNull("login", "name", "email") }.getOrNull() })
                    setToken(token!!, accountServiceOrigin)
                } else {
                    errorMessage = "保存的登录信息属于另一个账号服务，请重新登录。原有数据已保留。"
                }
            }
            callback?.let(::handleCallback)
        }
    }

    fun handleNotification(conversationId: String) {
        if (conversationId.isBlank()) return
        pendingOpenId = conversationId
        openPendingNotificationIfReady()
    }

    fun setForeground(value: Boolean) {
        val returning = value && !foreground
        foreground = value
        if (value && authenticated) {
            core.startPolling()
            if (returning) {
                refreshDevices()
                if (state.connection == "connected") refreshPendingUi()
                else if (!intentionalDisconnect) retryConnection()
            }
        }
        syncNotifications()
    }

    fun close() {
        closed = true
        reconnectTask?.let(main::removeCallbacks)
        pending.failAll("连接已关闭，草稿已保留。")
        core.close()
    }

    fun openPendingNotificationIfReady() {
        val id = pendingOpenId ?: return
        if (state.connection == "connected") {
            pendingOpenId = null
            openConversation(id)
        }
    }

    fun beginLogin(origin: String = accountServiceOrigin) {
        if (origin.trimEnd('/') != accountServiceOrigin) {
            errorMessage = "账号服务地址与当前应用不一致。"
            return
        }
        accountGeneration++
        val generation = accountGeneration
        loginPending = true
        core.command("loginUrl", JSONObject().put("origin", accountServiceOrigin)
            .put("redirectUri", OAUTH_REDIRECT_URI).put("deviceName", "FastVibe Android").put("platform", "android")) { response ->
            if (generation != accountGeneration) return@command
            loginPending = false
            if (!response.optBoolean("ok")) { showError(response); return@command }
            val result = response.optJSONObject("result")
            expectedLoginState = result?.stringOrNull("state")
            val url = result?.stringOrNull("url")
            if (url == null || expectedLoginState == null) errorMessage = "登录地址无效，请重试。"
            else try {
                onLoginUrl(url)
            } catch (error: android.content.ActivityNotFoundException) {
                errorMessage = "没有找到可用的浏览器，请安装或启用浏览器后重试。"
                Log.w(TAG, "Login browser unavailable")
            } catch (error: Exception) {
                errorMessage = "无法打开浏览器，请检查系统的应用启动权限后重试。"
                Log.w(TAG, "Login browser launch failed (${error.javaClass.simpleName})")
            }
        }
    }

    fun handleCallback(callback: OAuthCallback) {
        callback.error?.let { errorMessage = "登录未完成：$it"; return }
        val expected = expectedLoginState
        if (expected == null || callback.state != expected || callback.code.isNullOrBlank() || callback.token != null) {
            errorMessage = "登录状态已过期或回调无效，请重新登录。"
            return
        }
        if (callback.origin != null && callback.origin.trimEnd('/') != accountServiceOrigin) {
            errorMessage = "登录回调来自不同的账号服务。"
            return
        }
        expectedLoginState = null
        val generation = accountGeneration
        loginPending = true
        core.command("exchangeToken", JSONObject().put("code", callback.code)
            .put("redirectUri", OAUTH_REDIRECT_URI).put("state", callback.state)) { response ->
            if (generation != accountGeneration) return@command
            loginPending = false
            if (!response.optBoolean("ok")) { showError(response); return@command }
            val result = response.optJSONObject("result")
            val token = result?.stringOrNull("accessToken", "access_token")
            val issuer = result?.stringOrNull("origin")?.trimEnd('/')
            if (token == null || issuer != accountServiceOrigin) {
                errorMessage = "登录响应缺少有效凭据或账号服务不一致。"
                return@command
            }
            val user = result.optJSONObject("user")
            core.background({ secureStore.saveAccount(token, issuer, user?.toString()) }) { failure ->
                if (generation != accountGeneration) return@background
                if (failure != null) errorMessage = failure.message ?: "无法保存登录信息。"
                else {
                    state = state.copy(accountUser = user?.stringOrNull("login", "name", "email"))
                    setToken(token, issuer)
                }
            }
        }
    }

    private fun setToken(token: String, origin: String) {
        val generation = accountGeneration
        core.command("setToken", JSONObject().put("token", token).put("origin", origin)) { response ->
            if (generation != accountGeneration) return@command
            if (!response.optBoolean("ok")) { showError(response); return@command }
            authenticated = true
            accountReady = true
            intentionalDisconnect = false
            state = state.copy(accountOrigin = origin)
            core.startPolling()
            refreshDevices()
        }
    }

    fun logout(onDone: () -> Unit = {}) {
        accountGeneration++
        connectionGeneration++
        expectedLoginState = null
        authenticated = false
        loginPending = false
        preparingConnection = false
        intentionalDisconnect = true
        reconnectTask?.let(main::removeCallbacks)
        busy = true
        core.command("disconnect") {
            pending.failAll("已退出登录，草稿已保留。")
            core.background({ secureStore.clearAccount() }) { failure ->
                busy = false
                if (failure != null) errorMessage = failure.message ?: "无法退出登录。"
                else {
                    authenticated = false
                    accountReady = false
                    devices = emptyList()
                    selectedDevice = null
                    connectionAttempt = null
                    globalPrompts.clear()
                    notifications.clear()
                    state = MobileRuntimeState()
                    core.stopPolling()
                    onDone()
                }
            }
        }
    }

    fun refreshDevices() {
        if (!authenticated) return
        val generation = accountGeneration
        busy = true
        core.command("devices") { response ->
            if (generation != accountGeneration || !authenticated) return@command
            busy = false
            if (!response.optBoolean("ok")) { showError(response); return@command }
            devices = parseDevices(response.optJSONArray("result") ?: response.optJSONObject("result")?.arrayOrNull("devices"))
        }
    }

    fun cancelConnection() {
        connectionGeneration++
        selectionGeneration++
        intentionalDisconnect = true
        preparingConnection = false
        connectionAttempt = null
        reconnectTask?.let(main::removeCallbacks)
        reconnectTask = null
        busy = false
        core.command("disconnect") {
            pending.failAll("已取消连接，草稿已保留。")
            state = state.copy(connection = "disconnected", error = null)
            clearError()
            core.startPolling()
        }
    }

    fun connect(device: DeviceView) {
        if (!authenticated || busy && connectionAttempt != null) return
        val endpoint = device.endpointId
        if (endpoint.isNullOrBlank()) { errorMessage = "这台电脑当前没有可用连接端点。"; return }
        reconnectTask?.let(main::removeCallbacks)
        core.stopPolling()
        connectionGeneration++
        selectionGeneration++
        val generation = connectionGeneration
        intentionalDisconnect = false
        val changedDevice = selectedDevice?.id != device.id
        selectedDevice = device
        connectionAttempt = device
        subscribedConversation = null
        preparingConnection = true
        pending.failAll("连接正在重新建立，草稿已保留。")
        bufferedResults.clear()
        busy = true
        clearError()
        val resumeConversationId = state.conversationId.takeIf { !changedDevice }
        state = state.copy(connection = "connecting", error = null, path = null,
            workspace = if (changedDevice) WorkspaceView() else state.workspace,
            conversationId = if (changedDevice) null else state.conversationId,
            snapshot = if (changedDevice) null else state.snapshot)
        saveSelectedDevice(device.id)
        core.sequence({ session ->
            session.command("disconnect").requireResult()
            val identity = session.command("identity").requireResult()
            secureStore.put("identity", identity.getString("secretKey"))
            val localEndpoint = identity.getString("endpointId")
            val installId = preferences.getString("installId", null) ?: UUID.randomUUID().toString().also {
                check(preferences.edit().putString("installId", it).commit()) { "无法保存设备标识。" }
            }
            val registered = session.command("registerDevice", JSONObject().put("installId", installId)
                .put("name", "FastVibe Android").put("platform", "android")).requireResult()
            val localDeviceId = registered.stringOrNull("deviceId", "id")
                ?: registered.optJSONObject("device")?.stringOrNull("id")
                ?: error("账号服务未返回手机标识。")
            session.command("registerEndpoint", JSONObject().put("deviceId", localDeviceId)
                .put("endpointId", localEndpoint)).requireResult()
            val relay = session.command("relayToken", JSONObject().put("deviceId", device.id)
                .put("endpointId", localEndpoint)).requireResult()
            val payload = JSONObject().put("remoteId", endpoint).put("relay", relay)
            resumeConversationId?.let { payload.put("conversationId", it) }
            session.command("connect", payload).requireResult()
        }) { failure ->
            if (generation == connectionGeneration) {
                preparingConnection = false
                busy = false
                core.startPolling()
                if (failure != null) {
                    errorMessage = failure.message ?: "无法连接这台电脑。"
                    state = state.copy(connection = "error", error = errorMessage)
                    scheduleReconnect()
                }
            }
        }
    }

    fun retryConnection() { connectionAttempt?.let(::connect) }

    private fun scheduleReconnect() {
        if (closed || intentionalDisconnect || !authenticated || connectionAttempt == null || reconnectTask != null) return
        val delay = minOf(30_000L, 1_000L shl minOf(reconnectCount++, 5))
        reconnectTask = Runnable {
            reconnectTask = null
            if (!closed && !intentionalDisconnect) retryConnection()
        }.also { main.postDelayed(it, delay) }
    }

    fun refreshCatalog() {
        if (state.connection != "connected" || catalogLoading) return
        catalogLoading = true
        catalogLoadingState = true
        request("listConversations", onSuccess = { result ->
            catalogLoading = false
            catalogLoadingState = false
            state = state.copy(workspace = parseWorkspace(result as? JSONObject))
            openPendingNotificationIfReady()
        }, onFailure = { catalogLoading = false; catalogLoadingState = false })
    }

    fun openConversation(id: String) {
        if (id.isBlank() || state.connection != "connected") return
        selectionGeneration++
        val generation = selectionGeneration
        state = state.copy(conversationId = id, snapshot = null, models = emptyList())
        snapshotLoading = true
        snapshotError = null
        saveActiveConversation(id)
        subscribeConversation(id)
        request("openConversation", JSONObject().put("id", id), onSuccess = {
            if (generation == selectionGeneration && state.conversationId == id) requestSnapshot(id)
        }, onFailure = {
            if (generation == selectionGeneration && state.conversationId == id) {
                snapshotLoading = false
                snapshotError = "无法读取会话，请重试。"
            }
        })
    }

    private fun subscribeConversation(id: String) {
        if (subscribedConversation == id) return
        subscribedConversation?.let { previous ->
            core.command("unsubscribe", JSONObject().put("scopes", JSONArray().put("conversation:$previous")))
        }
        subscribedConversation = id
        request("subscribe", JSONObject().put("scopes", JSONArray().put("conversation:$id")))
    }

    private fun requestSnapshot(id: String) {
        if (id != state.conversationId || state.connection != "connected") return
        val generation = selectionGeneration
        snapshotLoading = true
        snapshotError = null
        request("snapshot", JSONObject().put("conversationId", id).put("historyLimit", 12), onSuccess = {
            if (generation == selectionGeneration && state.conversationId == id) {
                snapshotLoading = false
                remoteCall("engine:get-state", JSONObject().put("conversationId", id), onSuccess = { raw ->
                    if (state.conversationId == id) applySessionState(raw as? JSONObject)
                })
            }
        }, onFailure = {
            if (generation == selectionGeneration && state.conversationId == id) {
                snapshotLoading = false
                snapshotError = "无法读取会话内容，请重试。"
            }
        })
    }

    fun createConversation(project: ProjectView?, title: String, onFailure: () -> Unit = {}, onCreated: (String) -> Unit = {}) {
        val payload = JSONObject().put("activate", false).put("reuseEmpty", false)
        project?.cwd?.takeIf { it.isNotBlank() }?.let { payload.put("project", it) }
        request("createConversation", payload, onSuccess = { raw ->
            val result = raw as? JSONObject
            val id = result?.optJSONObject("conversation")?.stringOrNull("id") ?: result?.stringOrNull("id", "conversationId")
            if (id == null) { errorMessage = "电脑没有返回新会话标识。"; onFailure(); return@request }
            refreshCatalog()
            if (title.isNotBlank()) renameConversation(id, title.trim())
            onCreated(id)
            openConversation(id)
        }, onFailure = onFailure)
    }

    fun renameConversation(id: String, title: String, onDone: () -> Unit = {}) {
        if (title.isBlank()) return
        remoteCall("conversations:rename", JSONObject().put("id", id).put("title", title.trim()), onSuccess = {
            refreshCatalog()
            onDone()
        })
    }

    fun deleteConversation(id: String, onDone: () -> Unit = {}) {
        remoteCall("conversations:delete", JSONObject().put("id", id), onSuccess = {
            if (state.conversationId == id) {
                selectionGeneration++
                state = state.copy(conversationId = null, snapshot = null)
            }
            refreshCatalog()
            onDone()
        })
    }

    fun loadEarlier(onLoaded: (Int) -> Unit = {}) {
        val snapshot = state.snapshot ?: return
        val id = state.conversationId ?: return
        val cursor = snapshot.historyBeforeEntryId ?: return
        if (state.loadingHistory) return
        val generation = selectionGeneration
        state = state.copy(loadingHistory = true)
        request("getMessagesPage", JSONObject().put("conversationId", id)
            .put("beforeEntryId", cursor).put("turnLimit", 12), onSuccess = { raw ->
            if (generation != selectionGeneration || id != state.conversationId) return@request
            state = state.copy(loadingHistory = false)
            val result = raw as? JSONObject
            if (result?.optBoolean("reset") == true) requestSnapshot(id)
            else onLoaded(result?.optJSONArray("messages")?.length() ?: 0)
        }, onFailure = { if (generation == selectionGeneration) state = state.copy(loadingHistory = false) })
    }

    fun sendPrompt(text: String, attachments: List<ImageAttachment>, onAccepted: () -> Unit) {
        val id = state.conversationId ?: return
        val trimmed = text.trim()
        if ((trimmed.isBlank() && attachments.isEmpty()) || isSubmitting(id)) return
        submittingConversations = submittingConversations + id
        val enqueue = state.snapshot?.running == true || state.snapshot?.queue?.items?.isNotEmpty() == true
        val images = JSONArray().apply {
            attachments.forEach { put(JSONObject().put("type", "image").put("data", it.data).put("mimeType", it.mimeType)) }
        }
        val payload = JSONObject().put("conversationId", id).put("text", trimmed).put("enqueue", enqueue)
            .put("images", images).put("idempotencyKey", UUID.randomUUID().toString())
        request("prompt", payload, onSuccess = {
            submittingConversations = submittingConversations - id
            onAccepted()
        }, onFailure = { submittingConversations = submittingConversations - id })
    }

    fun abort(onDone: () -> Unit = {}) = conversationCall("engine:abort", onDone = onDone)
    fun continueTurn(onDone: () -> Unit = {}) = conversationCall("engine:continue", onDone = onDone)
    fun queueCancel(itemId: String, onDone: () -> Unit = {}) = conversationCall("engine:queue-cancel", JSONObject().put("id", itemId), onDone)
    fun queueSendNow(itemId: String, onDone: () -> Unit = {}) = conversationCall("engine:queue-send-now", JSONObject().put("id", itemId), onDone)
    fun queueResume(onDone: () -> Unit = {}) = conversationCall("engine:queue-resume", onDone = onDone)
    fun queueReorder(ids: List<String>, onDone: () -> Unit = {}) = conversationCall("engine:queue-reorder", JSONObject().put("ids", JSONArray(ids)), onDone)

    private fun conversationCall(method: String, payload: JSONObject = JSONObject(), onDone: () -> Unit = {}) {
        val id = state.conversationId ?: return
        payload.put("conversationId", id)
        remoteCall(method, payload, onSuccess = { raw ->
            if (state.conversationId == id) {
                if (method.startsWith("engine:queue-") && raw is JSONObject) applyQueue(raw)
                onDone()
            }
        })
    }

    fun respondPending(request: PendingUiView, response: JSONObject, onDone: () -> Unit = {}) {
        val payload = JSONObject().put("id", request.id)
        request.conversationId?.let { payload.put("conversationId", it) }
        for (key in listOf("confirmed", "value", "cancelled", "answers")) {
            if (response.has(key)) payload.put(key, response.get(key))
        }
        remoteCall("engine:permission-respond", payload, onSuccess = {
            globalPrompts.remove(request.id)
            state = state.copy(snapshot = state.snapshot?.let { it.copy(pendingUi = it.pendingUi.filterNot { row -> row.id == request.id }) })
            syncNotifications()
            onDone()
        })
    }

    fun loadModels(onDone: (List<ModelView>) -> Unit = {}) {
        val id = state.conversationId ?: return
        remoteCall("engine:get-models", JSONObject().put("conversationId", id), onSuccess = { raw ->
            if (state.conversationId == id) {
                val models = parseModels(raw)
                state = state.copy(models = models)
                onDone(models)
            }
        })
    }

    fun setModel(model: ModelView, onDone: () -> Unit = {}) = setSessionOption("engine:set-model",
        JSONObject().put("provider", model.provider).put("modelId", model.id), onDone)

    fun setThinking(level: String, onDone: () -> Unit = {}) = setSessionOption("engine:set-thinking", JSONObject().put("level", level), onDone)

    private fun setSessionOption(method: String, payload: JSONObject, onDone: () -> Unit) {
        val id = state.conversationId ?: return
        remoteCall(method, payload.put("conversationId", id), onSuccess = { raw ->
            if (state.conversationId == id) { applySessionState(raw as? JSONObject); onDone() }
        })
    }

    private fun applySessionState(raw: JSONObject?) {
        if (raw == null || (raw.stringOrNull("conversationId") ?: state.conversationId) != state.conversationId) return
        val model = raw.optJSONObject("model")
        state = state.copy(snapshot = state.snapshot?.copy(
            model = model?.let { listOfNotNull(it.stringOrNull("provider"), it.stringOrNull("id", "modelId", "name")).joinToString("/") } ?: state.snapshot?.model,
            thinkingLevel = raw.stringOrNull("thinkingLevel") ?: state.snapshot?.thinkingLevel,
            canResume = raw.booleanOrNull("canResume") ?: state.snapshot?.canResume,
        ))
    }

    private fun applyQueue(raw: JSONObject) {
        val snapshot = state.snapshot ?: return
        if (raw.stringOrNull("conversationId") != state.conversationId) return
        val queue = parseQueue(raw)
        if (queue.revision >= snapshot.queue.revision) state = state.copy(snapshot = snapshot.copy(queue = queue))
    }

    fun readFile(output: OutputView, onReady: (android.net.Uri) -> Unit) {
        val id = state.conversationId ?: return
        val generation = selectionGeneration
        var download: OutputDownload? = null
        core.background({ download = OutputDownload(java.io.File(appContext.cacheDir, "shared/outputs"), output.name) }) { failure ->
            if (failure != null) { errorMessage = "无法创建下载文件：${failure.message}"; return@background }
            download?.let { readFileChunk(id, generation, output.path, it, onReady) }
        }
    }

    private fun readFileChunk(id: String, generation: Long, path: String, download: OutputDownload, onReady: (android.net.Uri) -> Unit) {
        val offset = download.offset
        remoteCall("workspace:read-file", JSONObject().put("conversationId", id).put("path", path)
            .put("offset", offset).put("length", 512 * 1024), onSuccess = { raw ->
            var eof = false
            core.background({
                eof = download.append(raw as? JSONObject ?: error("电脑未返回文件内容。"), offset)
            }) { failure ->
                if (failure != null) {
                    core.background({ download.cancel() })
                    errorMessage = failure.message ?: "文件下载失败。"
                } else if (generation != selectionGeneration || state.conversationId != id) {
                    core.background({ download.cancel() })
                } else if (eof) {
                    core.background({ download.finish() }) { finishFailure ->
                        if (finishFailure != null) errorMessage = finishFailure.message ?: "文件下载失败。"
                        else if (generation == selectionGeneration && state.conversationId == id) {
                            onReady(androidx.core.content.FileProvider.getUriForFile(appContext, "${appContext.packageName}.files", download.target))
                        }
                    }
                } else readFileChunk(id, generation, path, download, onReady)
            }
        }, onFailure = { core.background({ download.cancel() }) })
    }

    fun draft(conversationId: String): String = preferences.getString(draftKey(conversationId), "").orEmpty()
    fun saveDraft(conversationId: String, value: String) { preferences.edit().putString(draftKey(conversationId), value).apply() }
    fun clearDraft(conversationId: String) { preferences.edit().remove(draftKey(conversationId)).apply() }
    fun theme(): String = preferences.getString("theme", "auto").orEmpty()
    fun saveTheme(value: String) { preferences.edit().putString("theme", value).apply() }
    fun selectedDeviceId(): String? = preferences.getString("lastDeviceId", null)
    fun saveSelectedDevice(id: String) { preferences.edit().putString("lastDeviceId", id).apply() }
    fun activeConversationId(): String? = preferences.getString("lastConversationId:${selectedDeviceId()}", null)
    private fun saveActiveConversation(id: String) { preferences.edit().putString("lastConversationId:${selectedDeviceId()}", id).apply() }
    private fun draftKey(id: String) = "draft:${selectedDevice?.id ?: state.deviceId ?: "device"}:$id"

    private fun remoteCall(method: String, payload: JSONObject, onSuccess: (Any?) -> Unit = {}, onFailure: (() -> Unit)? = null) {
        request("call", JSONObject().put("method", method).put("payload", payload), onSuccess, onFailure)
    }

    private fun request(action: String, payload: JSONObject? = null, onSuccess: (Any?) -> Unit = {}, onFailure: (() -> Unit)? = null) {
        val generation = connectionGeneration
        core.command(action, payload) { response ->
            if (generation != connectionGeneration) { onFailure?.invoke(); return@command }
            if (!response.optBoolean("ok", false)) { showError(response); onFailure?.invoke(); return@command }
            val result = response.opt("result").takeUnless { it == JSONObject.NULL }
            val requestId = (result as? JSONObject)?.longOrNull("requestId", "request_id")
            if (requestId == null || requestId <= 0L) { onSuccess(result); return@command }
            pending.register(requestId, { value ->
                if (generation == connectionGeneration) onSuccess(value) else onFailure?.invoke()
            }, { message -> errorMessage = message; onFailure?.invoke() })
            bufferedResults.remove(requestId)?.let { pending.complete(requestId, it) }
        }
    }

    private fun onCoreResponse(action: String, response: JSONObject) {
        if (closed || preparingConnection) return
        val oldConnection = state.connection
        response.optJSONObject("state")?.let { raw ->
            val next = parseRuntimeState(raw)
            if (BuildConfig.DEBUG && (next.connection != state.connection || next.error != state.error)) {
                Log.i(TAG, "Connection state: ${state.connection} -> ${next.connection}; error=${next.error.orEmpty()}")
            }
            val id = state.conversationId
            val compatibleSnapshot = next.snapshot?.takeIf { id != null && it.conversationId == id && next.conversationId == id }
            state = state.copy(
                connection = next.connection,
                path = next.path,
                endpointId = next.endpointId,
                deviceId = selectedDevice?.id ?: next.deviceId,
                error = next.error,
                workspace = if (raw.has("workspace")) next.workspace else state.workspace,
                snapshot = compatibleSnapshot?.let { incoming ->
                    val old = state.snapshot
                    if (old != null && old.queue.revision > incoming.queue.revision) incoming.copy(queue = old.queue) else incoming
                } ?: state.snapshot,
                pendingRequests = next.pendingRequests,
                loadingHistory = next.loadingHistory,
            )
            raw.optJSONObject("snapshot")?.let { snapshot ->
                snapshot.optJSONArray("pendingUi")?.let { prompts ->
                    val owner = snapshot.stringOrNull("conversationId")
                    if (owner != null) {
                        globalPrompts.entries.removeAll { it.value.stringOrNull("conversationId") == owner }
                        for (index in 0 until prompts.length()) {
                            val prompt = prompts.optJSONObject(index) ?: continue
                            if (prompt.stringOrNull("method") in BLOCKING_METHODS) {
                                prompt.stringOrNull("id")?.let { globalPrompts[it] = prompt }
                            }
                        }
                    }
                }
            }
        }
        if (action == "poll") handlePoll(response)
        if (action != "poll" && !response.optBoolean("ok", true)) showError(response)
        pending.expire()
        if (state.connection == "connected" && oldConnection != "connected") connected()
        if (state.connection in setOf("error", "disconnected") && oldConnection in setOf("connected", "connecting")) {
            catalogLoading = false
            catalogLoadingState = false
            pending.failAll("与电脑的连接已中断。操作可能已经到达电脑，请刷新确认；草稿已保留。")
            scheduleReconnect()
        }
        syncNotifications()
    }

    private fun connected() {
        reconnectCount = 0
        busy = false
        clearError()
        request("subscribe", JSONObject().put("scopes", JSONArray().put("*")))
        refreshCatalog()
        refreshPendingUi()
        val id = pendingOpenId ?: state.conversationId ?: activeConversationId()
        if (id != null) { pendingOpenId = null; openConversation(id) }
    }

    private fun refreshPendingUi() {
        request("pendingUi", onSuccess = { raw -> (raw as? JSONArray)?.let(::replaceGlobalPrompts); syncNotifications() })
    }

    private fun handlePoll(response: JSONObject) {
        val result = response.optJSONObject("result") ?: return
        val events = result.optJSONArray("events") ?: return
        for (index in 0 until events.length()) {
            val event = events.optJSONObject(index) ?: continue
            when (event.stringOrNull("kind", "type")) {
                "rpcResult" -> {
                    val id = event.longOrNull("requestId", "request_id") ?: continue
                    val rpcResult = RpcResult(event.optBoolean("ok"), event.opt("result").takeUnless { it == JSONObject.NULL }, event.errorMessage())
                    if (!pending.complete(id, rpcResult)) {
                        bufferedResults[id] = rpcResult
                        while (bufferedResults.size > 64) bufferedResults.remove(bufferedResults.keys.first())
                    }
                }
                "event" -> applyEvent(event)
                "resync" -> {
                    refreshCatalog()
                    state.conversationId?.let(::requestSnapshot)
                    refreshPendingUi()
                }
                "connection_error", "remote_close" -> {
                    state = state.copy(connection = "error", error = event.stringOrNull("message", "reason") ?: "与电脑的连接已断开。")
                }
            }
        }
        if (result.optBoolean("overflowed")) {
            state = state.copy(snapshot = state.snapshot?.copy(overflowed = true))
            state.conversationId?.let(::requestSnapshot)
            refreshPendingUi()
        }
    }

    private fun applyEvent(envelope: JSONObject) {
        val event = envelope.optJSONObject("payload") ?: return
        when (envelope.stringOrNull("channel")) {
            "workspace:changed" -> state = state.copy(workspace = parseWorkspace(event))
            "engine:state" -> applySessionState(event)
        }
        val cid = event.stringOrNull("conversationId")
        when (event.stringOrNull("type")) {
            "extension_ui_request" -> {
                if (event.stringOrNull("method") == "set_editor_text") {
                    if (cid == state.conversationId) editorText = event.stringOrNull("text").orEmpty()
                } else if (event.stringOrNull("method") in BLOCKING_METHODS) {
                    event.stringOrNull("id")?.let { globalPrompts[it] = event }
                }
            }
            "extension_ui_dismiss" -> event.stringOrNull("id")?.let { globalPrompts.remove(it) }
            "queue_changed" -> if (cid == state.conversationId) applyQueue(event.optJSONObject("queue") ?: event)
        }
    }

    private fun replaceGlobalPrompts(items: JSONArray) {
        globalPrompts.clear()
        for (index in 0 until items.length()) {
            val item = items.optJSONObject(index) ?: continue
            if (item.stringOrNull("method") in BLOCKING_METHODS) item.stringOrNull("id")?.let { globalPrompts[it] = item }
        }
    }

    private fun syncNotifications() {
        notifications.update(JSONArray(globalPrompts.values.toList()), state.conversationId, foreground)
    }

    private fun showError(response: JSONObject) {
        errorMessage = response.errorMessage() ?: "服务器请求失败。"
        state = state.copy(error = errorMessage)
    }

    fun clearError() { errorMessage = null; state = state.copy(error = null) }

    companion object {
        private val BLOCKING_METHODS = setOf("confirm", "select", "input", "editor", "questions")
    }
}

private fun JSONObject.requireResult(): JSONObject {
    check(optBoolean("ok", false)) { errorMessage() ?: "账号或连接请求失败。" }
    return optJSONObject("result") ?: JSONObject()
}

internal fun checkedAccountOrigin(raw: String): String {
    val uri = URI(raw.trim())
    val local = uri.host in setOf("localhost", "127.0.0.1", "::1", "[::1]")
    require((uri.scheme == "https" || BuildConfig.DEBUG && uri.scheme == "http" && local) &&
        !uri.host.isNullOrBlank() && uri.rawUserInfo == null && uri.rawQuery == null &&
        uri.rawFragment == null && uri.path in setOf("", "/")) { "账号服务地址无效。" }
    val normalized = raw.trim().trimEnd('/')
    require(BuildConfig.DEBUG || normalized == DEFAULT_MOBILE_ACCOUNT_ORIGIN) { "账号服务地址与当前应用不一致。" }
    return normalized
}

internal fun JSONObject.errorMessage(): String? = objectOrNull("error")?.stringOrNull("message", "detail") ?: stringOrNull("error", "message")

internal data class OAuthCallback(
    val code: String? = null,
    val token: String? = null,
    val state: String? = null,
    val error: String? = null,
    val origin: String? = null,
)

internal const val OAUTH_REDIRECT_URI = "fastvibe://oauth/callback"
