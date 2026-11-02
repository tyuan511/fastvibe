package dev.fastvibe.mobile

import android.content.Context
import android.content.Intent
import android.graphics.BitmapFactory
import android.net.Uri
import android.os.Bundle
import android.util.Base64
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.activity.enableEdgeToEdge
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.activity.compose.BackHandler
import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.Canvas
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.combinedClickable
import androidx.compose.foundation.isSystemInDarkTheme
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ColumnScope
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.imePadding
import androidx.compose.foundation.layout.navigationBarsPadding
import androidx.compose.foundation.layout.statusBarsPadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.lazy.itemsIndexed
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.foundation.rememberScrollState
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Button
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.lightColorScheme
import androidx.compose.material3.darkColorScheme
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateListOf
import androidx.compose.runtime.mutableStateMapOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.alpha
import androidx.compose.ui.draw.clip
import androidx.compose.ui.draw.clipToBounds
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.geometry.CornerRadius
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Size
import androidx.compose.ui.layout.onSizeChanged
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.LocalView
import androidx.compose.ui.res.painterResource
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.core.view.WindowInsetsControllerCompat
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.LifecycleEventObserver
import androidx.lifecycle.compose.LocalLifecycleOwner
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import org.json.JSONArray
import org.json.JSONObject
import java.io.ByteArrayOutputStream
import java.util.Locale

private const val DEFAULT_ACCOUNT_ORIGIN = "https://app.fastvibe.dev"
private const val OPEN_CONVERSATION_ACTION = "dev.fastvibe.mobile.OPEN_CONVERSATION"

class MainActivity : ComponentActivity() {
    private val oauthCallback = mutableStateOf<OAuthCallback?>(null)
    private val notificationConversation = mutableStateOf<String?>(null)

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        enableEdgeToEdge()
        handleIntent(intent)
        setContent { FastVibeApp(oauthCallback.value, notificationConversation.value) }
    }

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        setIntent(intent)
        handleIntent(intent)
    }

    private fun handleIntent(intent: Intent?) {
        parseOAuthCallback(intent)?.let { oauthCallback.value = it }
        if (intent?.action == OPEN_CONVERSATION_ACTION) {
            notificationConversation.value = intent.getStringExtra("conversationId")
        }
    }
}

internal enum class AppPage { COMPUTERS, CONVERSATIONS, SETTINGS }

private val lightFastVibeColors = lightColorScheme(
    primary = Color(0xFF007AFF), onPrimary = Color.White, secondary = Color(0xFF4AA3FF),
    background = Color(0xFFEEF0F7), surface = Color(0xFFF8F9FD), surfaceVariant = Color(0x1F767680),
    onSurface = Color(0xFF0B0B0F), onBackground = Color(0xFF0B0B0F), onSurfaceVariant = Color(0x9E3C3C43), outlineVariant = Color(0x213C3C43), error = Color(0xFFFF3B30),
)
private val darkFastVibeColors = darkColorScheme(
    primary = Color(0xFF0A84FF), onPrimary = Color.White, secondary = Color(0xFF5EB1FF),
    background = Color(0xFF050508), surface = Color(0xFF202027), surfaceVariant = Color(0x3D767680),
    onSurface = Color(0xFFF5F5F7), onBackground = Color(0xFFF5F5F7), onSurfaceVariant = Color(0x99EBEBF5), outlineVariant = Color(0x17FFFFFF), error = Color(0xFFFF453A),
)

@Composable
internal fun FastVibeTheme(darkTheme: Boolean, content: @Composable () -> Unit) {
    val base = androidx.compose.material3.Typography()
    fun type(style: androidx.compose.ui.text.TextStyle) = style.copy(
        fontFamily = FontFamily.SansSerif,
        letterSpacing = 0.sp,
        platformStyle = androidx.compose.ui.text.PlatformTextStyle(includeFontPadding = false),
        lineHeightStyle = androidx.compose.ui.text.style.LineHeightStyle(
            androidx.compose.ui.text.style.LineHeightStyle.Alignment.Center,
            androidx.compose.ui.text.style.LineHeightStyle.Trim.None,
        ),
    )
    val typography = base.copy(
        bodyLarge = type(base.bodyLarge).copy(fontSize = 16.sp, lineHeight = 23.5.sp),
        bodyMedium = type(base.bodyMedium).copy(fontSize = 14.sp, lineHeight = 20.5.sp),
        bodySmall = type(base.bodySmall).copy(fontSize = 13.sp, lineHeight = 18.sp),
        titleLarge = type(base.titleLarge), titleMedium = type(base.titleMedium), titleSmall = type(base.titleSmall),
        labelLarge = type(base.labelLarge), labelMedium = type(base.labelMedium), labelSmall = type(base.labelSmall),
        headlineSmall = type(base.headlineSmall),
    )
    val colors = if (darkTheme) darkFastVibeColors else lightFastVibeColors
    MaterialTheme(colors, typography = typography) {
        androidx.compose.runtime.CompositionLocalProvider(
            androidx.compose.material3.LocalContentColor provides colors.onSurface,
            androidx.compose.material3.LocalTextStyle provides androidx.compose.ui.text.TextStyle(
                fontFamily = FontFamily.SansSerif,
                fontSize = 17.sp,
                lineHeight = 24.99.sp,
                letterSpacing = 0.sp,
                platformStyle = androidx.compose.ui.text.PlatformTextStyle(includeFontPadding = false),
                lineHeightStyle = androidx.compose.ui.text.style.LineHeightStyle(
                    androidx.compose.ui.text.style.LineHeightStyle.Alignment.Center,
                    androidx.compose.ui.text.style.LineHeightStyle.Trim.None,
                ),
            ),
            content = content,
        )
    }
}

@Composable
private fun FastVibeApp(callback: OAuthCallback?, notificationConversationId: String?) {
    val context = LocalContext.current
    val secureStore = remember(context) { SecureStore(context) }
    val notifications = remember(context) { ConversationNotifications(context) }
    val controller = remember(context) {
        MobileRuntimeController(
            context,
            secureStore,
            notifications,
            onLoginUrl = { url ->
                openLoginBrowser(context, url)
            },
            accountOrigin = DEFAULT_ACCOUNT_ORIGIN,
        )
    }
    val updateController = remember(context) { AndroidUpdateController(context) }
    var themeKey by rememberSaveable { mutableStateOf(controller.theme()) }
    var page by rememberSaveable { mutableStateOf(AppPage.COMPUTERS) }
    var detailId by rememberSaveable { mutableStateOf<String?>(null) }
    var offlineDeviceId by rememberSaveable { mutableStateOf<String?>(null) }
    var creatingConversation by remember { mutableStateOf(false) }
    var showCreate by rememberSaveable { mutableStateOf(false) }
    var showModelPicker by rememberSaveable { mutableStateOf(false) }
    var pendingPrompt by remember { mutableStateOf<PendingUiView?>(null) }
    var showError by remember { mutableStateOf<String?>(null) }
    var connectionScreen by rememberSaveable { mutableStateOf(false) }
    val attachmentByConversation = remember { mutableMapOf<String, androidx.compose.runtime.snapshots.SnapshotStateList<ImageAttachment>>() }
    val attachmentOwner = "${controller.selectedDeviceId()}:${detailId.orEmpty()}"
    val attachment = remember(attachmentOwner) { attachmentByConversation.getOrPut(attachmentOwner) { mutableStateListOf() } }
    val attachmentScope = rememberCoroutineScope()
    val notificationPermission = rememberLauncherForActivityResult(ActivityResultContracts.RequestPermission()) {}
    LaunchedEffect(controller.accountReady) {
        if (controller.accountReady && android.os.Build.VERSION.SDK_INT >= 33) {
            notificationPermission.launch(android.Manifest.permission.POST_NOTIFICATIONS)
        }
    }
    val getImage = rememberLauncherForActivityResult(ActivityResultContracts.GetContent()) { uri ->
        if (uri != null) attachmentScope.launch {
            val image = withContext(Dispatchers.IO) { readImageAttachment(context, uri) }
            if (image != null) attachment.add(image) else showError = "图片无法读取或超过大小限制。"
        }
    }

    val darkTheme = when (themeKey) { "dark" -> true; "light" -> false; else -> isSystemInDarkTheme() }
    val view = LocalView.current
    LaunchedEffect(darkTheme) {
        WindowInsetsControllerCompat((view.context as ComponentActivity).window, view).isAppearanceLightStatusBars = !darkTheme
        WindowInsetsControllerCompat((view.context as ComponentActivity).window, view).isAppearanceLightNavigationBars = !darkTheme
    }
    val lifecycleOwner = LocalLifecycleOwner.current
    DisposableEffect(controller, lifecycleOwner) {
        val owner = lifecycleOwner
        val observer = LifecycleEventObserver { _, event ->
            when (event) {
                Lifecycle.Event.ON_START -> controller.setForeground(true)
                Lifecycle.Event.ON_STOP -> controller.setForeground(false)
                else -> Unit
            }
        }
        owner.lifecycle.addObserver(observer)
        onDispose { owner.lifecycle.removeObserver(observer) }
    }
    DisposableEffect(controller) {
        controller.start(null, null)
        onDispose {
            controller.close()
            updateController.close()
            notifications.clear()
        }
    }
    LaunchedEffect(notificationConversationId) {
        notificationConversationId?.takeIf { it.isNotBlank() }?.let {
            detailId = it
            page = AppPage.CONVERSATIONS
            controller.handleNotification(it)
        }
    }
    LaunchedEffect(callback) {
        callback?.let(controller::handleCallback)
    }
    LaunchedEffect(Unit) { updateController.check(false) }
    LaunchedEffect(controller.accountReady) { if (controller.accountReady) controller.refreshDevices() }
    LaunchedEffect(controller.state.connection, controller.accountReady) {
        if (controller.state.connection == "connecting" && detailId == null) connectionScreen = true
        if (controller.state.connection == "connected") {
            controller.refreshCatalog()
            if (connectionScreen) { connectionScreen = false; page = AppPage.CONVERSATIONS }
        }
    }
    LaunchedEffect(controller.state.snapshot?.pendingUi) {
        pendingPrompt = controller.state.snapshot?.pendingUi?.firstOrNull()
    }
    LaunchedEffect(controller.state.conversationId) {
        if (detailId != null && controller.state.conversationId == null) detailId = null
    }
    BackHandler(enabled = connectionScreen || detailId != null || page != AppPage.COMPUTERS) {
        if (connectionScreen) { connectionScreen = false; controller.cancelConnection(); page = AppPage.COMPUTERS }
        else if (detailId != null) detailId = null else page = AppPage.COMPUTERS
    }

    FastVibeTheme(darkTheme) {
        GlassBackdropHost {
            if (!controller.accountReady) {
                AccountLoginScreen(controller, callback)
            } else if (connectionScreen) {
                ConnectionProgressScreen(controller) { connectionScreen = false; controller.cancelConnection(); page = AppPage.COMPUTERS }
            } else {
                ProductShell(
                    controller = controller,
                    page = page,
                    detailId = detailId,
                    themeKey = themeKey,
                    onPageChange = { page = it; detailId = null },
                    onOpen = { id -> detailId = id; page = AppPage.CONVERSATIONS; controller.openConversation(id) },
                    onCreate = { showCreate = true },
                    onOffline = { offlineDeviceId = it.id },
                    onTheme = { themeKey = it; controller.saveTheme(it) },
                    onModel = { showModelPicker = true },
                    onAttach = { getImage.launch("image/*") },
                    attachments = attachment,
                    onRemoveAttachment = { attachment.remove(it) },
                    onDismissDetail = { detailId = null },
                    onError = { showError = it },
                    onCheckUpdates = { updateController.check(true) },
                    updateChannel = updateController.channel,
                    onUpdateChannel = updateController::selectChannel,
                    promptPresented = pendingPrompt != null,
                )
            }
    
            if (showCreate) ProjectSelectionSheet(
                projects = controller.state.workspace.projects.filter { !it.cwd.isNullOrBlank() },
                creating = creatingConversation,
                onDismiss = { if (!creatingConversation) showCreate = false },
                onSelect = { project ->
                    if (!creatingConversation) {
                        creatingConversation = true
                        controller.createConversation(project, "", onFailure = { creatingConversation = false }) { id ->
                            creatingConversation = false
                            showCreate = false
                            page = AppPage.CONVERSATIONS
                            detailId = id
                        }
                    }
                },
            )
            if (offlineDeviceId != null) {
                val device = controller.devices.firstOrNull { it.id == offlineDeviceId }
                if (device != null) OfflineComputerSheet(
                    device = device,
                    account = controller.state.accountUser,
                    onDismiss = { offlineDeviceId = null },
                )
            }
            if (showModelPicker) MobileModelPickerSheet(controller, onDismiss = { showModelPicker = false })
            if (pendingPrompt != null) MobilePendingUiSheet(controller, pendingPrompt!!, onDismiss = { pendingPrompt = null })
            val error = showError ?: controller.errorMessage.takeUnless { connectionScreen }
            if (error != null) AlertDialog(onDismissRequest = { showError = null; controller.clearError() }, title = { Text("FastVibe") }, text = { Text(error) }, confirmButton = { TextButton(onClick = { showError = null; controller.clearError() }) { Text("好") } })
            UpdateBanner(updateController)
        }
    }
}

@Composable
internal fun ProductShell(
    controller: MobileRuntimeController,
    page: AppPage,
    detailId: String?,
    themeKey: String,
    onPageChange: (AppPage) -> Unit,
    onOpen: (String) -> Unit,
    onCreate: () -> Unit,
    onOffline: (DeviceView) -> Unit,
    onTheme: (String) -> Unit,
    onModel: () -> Unit,
    onAttach: () -> Unit,
    attachments: List<ImageAttachment>,
    onRemoveAttachment: (ImageAttachment) -> Unit,
    onDismissDetail: () -> Unit,
    onError: (String) -> Unit,
    onCheckUpdates: () -> Unit,
    updateChannel: UpdateChannel = UpdateChannel.GITHUB,
    onUpdateChannel: (UpdateChannel) -> Unit = {},
    promptPresented: Boolean = false,
) {
    var conversationFilter by remember(controller.selectedDeviceId()) { mutableStateOf(ConversationCatalogFilter()) }
    var showConversationFilter by remember { mutableStateOf(false) }
    GlassBackground {
        if (showConversationFilter) ConversationFilterSheet(
            workspace = controller.state.workspace,
            filter = conversationFilter,
            onChange = { conversationFilter = it },
            onDismiss = { showConversationFilter = false },
        )
        Box(Modifier.fillMaxSize()) {
            Column(Modifier.fillMaxSize().mobileStatusBarsPadding()) {
                if (detailId != null) ThreadHeader(controller, detailId, onDismissDetail, onModel, promptPresented)
                else MainHeader(
                    page, controller,
                    onBack = { onPageChange(AppPage.COMPUTERS) },
                    onSettings = { onPageChange(AppPage.SETTINGS) },
                    onRefresh = { controller.refreshDevices() },
                    onFilter = { showConversationFilter = true },
                    filterActive = conversationFilter != ConversationCatalogFilter(),
                )
                Box(Modifier.weight(1f).fillMaxWidth().testTag("page-content").clipToBounds()
                    .mobileNavigationBarsPadding(minimum = if (detailId != null) 30.dp else 36.dp)) {
                    Box(Modifier.fillMaxSize().then(if (detailId == null) Modifier.glassPageSource() else Modifier)) {
                        if (detailId != null) ThreadScreen(controller, detailId, onAttach, attachments, onRemoveAttachment, onError, promptPresented = promptPresented)
                        else when (page) {
                            AppPage.COMPUTERS -> ComputersHomeContent(
                                controller.devices, controller.state.accountUser,
                                controller.catalogLoadingState || controller.busy && controller.devices.isEmpty(),
                                controller.selectedDeviceId(), controller.busy, controller::refreshDevices, onOffline,
                                onConnect = { device ->
                                    if (controller.state.connection == "connected" && controller.selectedDeviceId() == device.id) onPageChange(AppPage.CONVERSATIONS)
                                    else controller.connect(device)
                                },
                            )
                            AppPage.CONVERSATIONS -> ConversationCatalogScreen(controller, onOpen, onCreate, filter = conversationFilter)
                            AppPage.SETTINGS -> MobileSettingsScreen(
                                controller,
                                themeKey,
                                onTheme,
                                onCheckUpdates,
                                updateChannel,
                                onUpdateChannel,
                            )
                        }
                    }
                }
            }
            if (detailId == null && page == AppPage.CONVERSATIONS) {
                Box(Modifier.align(Alignment.BottomEnd).navigationBarsPadding().padding(end = 16.dp, bottom = 6.dp)) {
                    NewConversationFab(onCreate)
                }
            }
        }
    }
}

@Composable
private fun MainHeader(
    page: AppPage,
    controller: MobileRuntimeController,
    onBack: () -> Unit,
    onSettings: () -> Unit,
    onRefresh: () -> Unit,
    onFilter: () -> Unit,
    filterActive: Boolean,
) {
    val title = when (page) { AppPage.COMPUTERS -> "电脑"; AppPage.CONVERSATIONS -> "会话"; AppPage.SETTINGS -> "设置" }
    Column(Modifier.fillMaxWidth().testTag("main-header")) {
        Row(
            Modifier.fillMaxWidth().height(56.dp).padding(horizontal = 12.dp),
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.spacedBy(8.dp),
        ) {
            if (page != AppPage.COMPUTERS) IconButton(IconId.Back, "返回电脑列表", onBack)
            if (page == AppPage.CONVERSATIONS) {
                ConversationConnectionBadge(
                    controller.devices.firstOrNull { it.id == controller.selectedDeviceId() }?.name ?: "电脑",
                    controller.state.connection,
                    controller.state.path,
                    Modifier.weight(1f, fill = false),
                )
            } else Spacer(Modifier.weight(1f))
            if (page == AppPage.COMPUTERS) {
                IconButton(IconId.Refresh, "刷新", onRefresh)
                IconButton(IconId.Settings, "设置", onSettings)
            }
        }
        Row(Modifier.fillMaxWidth().padding(start = 20.dp, end = 16.dp, top = 2.dp, bottom = 12.dp), verticalAlignment = Alignment.CenterVertically) {
            Text(title, Modifier.weight(1f), fontSize = 34.sp, lineHeight = 39.sp, letterSpacing = (-.68).sp, fontWeight = FontWeight.Bold)
            if (page == AppPage.CONVERSATIONS) Box {
                GlassIconButton(R.drawable.fv_list_filter, "筛选会话", onFilter)
                if (filterActive) Box(Modifier.align(Alignment.TopEnd).padding(3.dp).size(7.dp).clip(CircleShape).background(MaterialTheme.colorScheme.primary))
            }
        }
    }
}

@Composable
private fun ThreadHeader(controller: MobileRuntimeController, id: String, onBack: () -> Unit, onModel: () -> Unit, promptPresented: Boolean = false) {
    val conversation = controller.state.workspace.conversations.firstOrNull { it.id == id }
    Row(Modifier.fillMaxWidth().testTag("thread-header").height(56.dp).padding(horizontal = 12.dp), verticalAlignment = Alignment.CenterVertically) {
        IconButton(IconId.Back, "返回", onBack)
        Column(Modifier.weight(1f).padding(horizontal = 8.dp), horizontalAlignment = Alignment.CenterHorizontally) {
            Text(conversation?.title ?: "会话", fontSize = 16.sp, lineHeight = 20.sp, fontWeight = FontWeight.SemiBold, maxLines = 1, overflow = TextOverflow.Ellipsis)
            val computer = controller.devices.firstOrNull { it.id == controller.selectedDeviceId() }?.name
            Text(listOfNotNull(conversation?.projectName, computer).joinToString(" · "), fontSize = 11.5.sp, lineHeight = 14.sp, color = MaterialTheme.colorScheme.onSurfaceVariant, maxLines = 1, overflow = TextOverflow.Ellipsis)
        }
        if (promptPresented) Spacer(Modifier.size(44.dp)) else IconButton(IconId.More, "更多", onModel)
    }
}

@Composable
private fun ThreadScreen(
    controller: MobileRuntimeController,
    id: String,
    onAttach: () -> Unit,
    attachments: List<ImageAttachment>,
    onRemoveAttachment: (ImageAttachment) -> Unit,
    onError: (String) -> Unit,
    contentTop: androidx.compose.ui.unit.Dp = 0.dp,
    promptPresented: Boolean = false,
) {
    val context = LocalContext.current
    var draft by remember(id) { mutableStateOf(controller.draft(id)) }
    var sentDraft by remember(id) { mutableStateOf<String?>(null) }
    var sentAttachments by remember(id) { mutableStateOf<List<ImageAttachment>>(emptyList()) }
    LaunchedEffect(controller.editorText, id) {
        if (controller.editorText.isNotEmpty()) {
            draft = controller.editorText
            controller.saveDraft(id, draft)
            controller.consumeEditorText()
        }
    }
    val snapshot = controller.state.snapshot
    val messages = snapshot?.messages.orEmpty()
    val listState = androidx.compose.foundation.lazy.rememberLazyListState()
    val scrollScope = rememberCoroutineScope()
    val nearBottom = !listState.canScrollForward
    var firstLoaded by remember(id) { mutableStateOf(false) }
    LaunchedEffect(id, snapshot?.conversationId, messages.isNotEmpty()) {
        if (!firstLoaded && snapshot?.conversationId == id && messages.isNotEmpty()) {
            listState.scrollToItem(messages.lastIndex + if (snapshot.historyBeforeEntryId != null) 1 else 0)
            firstLoaded = true
        }
    }
    LaunchedEffect(id, messages.size, snapshot?.seq) {
        if (firstLoaded && messages.isNotEmpty() && nearBottom && !controller.state.loadingHistory) {
            listState.animateScrollToItem(messages.lastIndex + if (snapshot?.historyBeforeEntryId != null) 1 else 0)
        }
    }
    var composerHeight by remember { mutableStateOf(80.dp) }
    val density = androidx.compose.ui.platform.LocalDensity.current
    Box(Modifier.fillMaxSize()) {
        LazyColumn(
            state = listState,
            modifier = Modifier.fillMaxSize()
                .alpha(if (firstLoaded || messages.isEmpty()) 1f else 0f)
                .glassPageSource(),
            contentPadding = PaddingValues(start = 16.dp, top = contentTop + if (controller.state.loadingHistory) 52.dp else 4.dp, end = 16.dp, bottom = composerHeight + 46.dp),
            verticalArrangement = Arrangement.spacedBy(16.dp),
        ) {
            snapshot?.historyBeforeEntryId?.takeIf { !controller.state.loadingHistory }?.let { item { HistoryButton(snapshot, controller) } }
            if (controller.snapshotError != null) item {
                EmptyState(IconId.Chat, "会话读取失败", controller.snapshotError!!, "重试") { controller.openConversation(id) }
            }
            else if (snapshot == null || (controller.snapshotLoading && messages.isEmpty())) item {
                EmptyState(IconId.Chat, "正在读取会话", "正在从电脑读取会话内容。", null)
            }
            else if (messages.isEmpty()) item {
                Column(
                    Modifier.fillParentMaxHeight().fillMaxWidth().padding(horizontal = 16.dp).padding(bottom = 64.dp),
                    horizontalAlignment = Alignment.CenterHorizontally,
                    verticalArrangement = Arrangement.spacedBy(10.dp, Alignment.CenterVertically),
                ) {
                    Box(Modifier.padding(bottom = 8.dp)) { IconTile(IconId.Chat, true) }
                    Text("开始新会话", fontSize = 22.sp, lineHeight = 32.34.sp, fontWeight = FontWeight.Bold)
                    val conversation = controller.state.workspace.conversations.firstOrNull { it.id == id }
                    Text(conversation?.projectName ?: "未归属项目", fontSize = 15.sp, lineHeight = 22.05.sp, color = MaterialTheme.colorScheme.onSurfaceVariant)
                    Text("发送第一条消息，开始这次任务。", fontSize = 15.sp, lineHeight = 22.05.sp, color = MaterialTheme.colorScheme.onSurfaceVariant)
                }
            }
            items(messages, key = { it.id }) { message ->
                ConversationMessage(
                    message,
                    streaming = snapshot?.running == true && message.id == messages.lastOrNull { it.role == "assistant" }?.id,
                    onContinue = if (snapshot?.canResume == true && message.id == messages.lastOrNull { it.role == "assistant" }?.id) ({ controller.continueTurn() }) else null,
                ) { output -> controller.readFile(output) { uri -> shareUri(context, uri) } }
            }
            snapshot?.turnEvents?.forEachIndexed { index, event -> item(key = "event:$index") { Text(event, style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.onSurfaceVariant) } }
        }
        if (firstLoaded && messages.isNotEmpty() && !nearBottom) {
            Box(
                Modifier.align(Alignment.BottomCenter).padding(bottom = composerHeight + 12.dp),
            ) {
                GlassIconButton(R.drawable.fv_chevron_down, "滚动到底部", onClick = {
                    scrollScope.launch {
                        listState.animateScrollToItem(messages.lastIndex + if (snapshot?.historyBeforeEntryId != null) 1 else 0)
                    }
                })
            }
        }
        if (controller.state.loadingHistory && snapshot != null) {
            Box(Modifier.align(Alignment.TopCenter).padding(top = contentTop + 4.dp)) {
                HistoryButton(snapshot, controller)
            }
        }
        if (!promptPresented) {
            Box(
                Modifier.align(Alignment.BottomCenter).fillMaxWidth().height(composerHeight + 24.dp)
                    .glassChromeBackdrop(bottom = true),
            )
            Column(
                Modifier.align(Alignment.BottomCenter).fillMaxWidth().imePadding()
                    .onSizeChanged { composerHeight = with(density) { it.height.toDp() } },
                verticalArrangement = Arrangement.spacedBy(8.dp),
            ) {
                snapshot?.queue?.takeIf { it.items.isNotEmpty() }?.let { QueuePanel(it, controller) }
                val sending = controller.isSubmitting(id)
                ConversationComposer(
                    value = draft,
                    enabled = controller.state.connection == "connected" && !sending,
                    running = snapshot?.running == true,
                    attachments = attachments,
                    onChange = { draft = it; controller.saveDraft(id, it) },
                    onAttach = onAttach,
                    onRemove = onRemoveAttachment,
                    onStop = { controller.abort() },
                    onSend = { text, images ->
                        sentDraft = text
                        sentAttachments = images.toList()
                        controller.sendPrompt(text, images) {
                            if (draft == sentDraft) {
                                draft = ""
                                controller.clearDraft(id)
                            }
                            sentAttachments.forEach { image -> if (image in attachments) onRemoveAttachment(image) }
                            sentDraft = null
                            sentAttachments = emptyList()
                        }
                    },
                )
            }
        }
    }
}

@Composable
private fun HistoryButton(snapshot: SnapshotView, controller: MobileRuntimeController) {
    Box(Modifier.fillMaxWidth(), contentAlignment = Alignment.Center) {
        GlassPanel(Modifier.heightIn(min = 36.dp).glassClick(enabled = !controller.state.loadingHistory) { controller.loadEarlier() }, RoundedCornerShape(18.dp), high = true) {
            Row(Modifier.padding(horizontal = 14.dp, vertical = 8.dp), verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                if (controller.state.loadingHistory) CircularProgressIndicator(Modifier.size(14.dp), strokeWidth = 1.5.dp)
                else Icon(IconId.ChevronUp, Modifier.size(16.dp), MaterialTheme.colorScheme.onSurfaceVariant)
                Text(if (controller.state.loadingHistory) "正在加载更早的消息…" else "加载更早的消息", fontSize = 13.sp, fontWeight = FontWeight.SemiBold, color = MaterialTheme.colorScheme.onSurfaceVariant)
            }
        }
    }
}

@OptIn(androidx.compose.foundation.ExperimentalFoundationApi::class)
@Composable
private fun QueuePanel(queue: QueueView, controller: MobileRuntimeController) {
    GlassPanel(Modifier.fillMaxWidth().padding(horizontal = 12.dp), RoundedCornerShape(22.dp)) {
        Column(Modifier.fillMaxWidth().padding(start = 14.dp, end = 6.dp, top = 4.dp, bottom = 4.dp)) {
            Text(if (queue.paused) "排队已暂停" else "排队中 · 回复结束后发送", Modifier.padding(top = 6.dp), fontSize = 12.sp, lineHeight = 17.64.sp, fontWeight = FontWeight.SemiBold, color = MaterialTheme.colorScheme.onSurfaceVariant)
            Column(Modifier.heightIn(max = 150.dp).verticalScroll(rememberScrollState())) {
                queue.items.forEachIndexed { index, item ->
                    var showActions by remember(item.id) { mutableStateOf(false) }
                    Box {
                        Row(
                            Modifier.fillMaxWidth().heightIn(min = 44.dp).combinedClickable(
                                interactionSource = remember(item.id) { androidx.compose.foundation.interaction.MutableInteractionSource() },
                                indication = null,
                                onClick = { showActions = true },
                                onLongClick = { showActions = true },
                            ),
                            verticalAlignment = Alignment.CenterVertically,
                            horizontalArrangement = Arrangement.spacedBy(8.dp),
                        ) {
                            Text(item.text.ifBlank { "图片消息" }, Modifier.weight(1f), fontSize = 14.sp, lineHeight = 20.58.sp, maxLines = 1, overflow = TextOverflow.Ellipsis)
                            Box(Modifier.size(36.dp).semantics { contentDescription = "取消排队" }.glassClick { controller.queueCancel(item.id) }, contentAlignment = Alignment.Center) { Icon(IconId.Close, Modifier.size(16.dp), MaterialTheme.colorScheme.onSurfaceVariant) }
                        }
                        androidx.compose.material3.DropdownMenu(expanded = showActions, onDismissRequest = { showActions = false }) {
                            androidx.compose.material3.DropdownMenuItem(text = { Text("立即发送") }, onClick = { showActions = false; controller.queueSendNow(item.id) })
                            if (index > 0) androidx.compose.material3.DropdownMenuItem(text = { Text("上移") }, onClick = {
                                showActions = false
                                val ids = queue.items.map { it.id }.toMutableList()
                                java.util.Collections.swap(ids, index, index - 1)
                                controller.queueReorder(ids)
                            })
                        }
                    }
                }
            }
            if (queue.paused) Text("继续发送", Modifier.glassClick { controller.queueResume() }.padding(vertical = 10.dp), fontSize = 14.sp, color = MaterialTheme.colorScheme.primary)
        }
    }
}

@Composable
private fun NewConversationFab(onClick: () -> Unit) {
    AccentPanel(Modifier.size(64.dp).semantics { contentDescription = "新建会话" }.glassClick(onClick = onClick), CircleShape) {
        Box(Modifier.fillMaxSize(), contentAlignment = Alignment.Center) {
            androidx.compose.foundation.Image(painterResource(R.drawable.fv_square_pen), null, Modifier.size(24.dp), colorFilter = androidx.compose.ui.graphics.ColorFilter.tint(Color.White))
        }
    }
}

@Composable private fun UpdateBanner(controller: AndroidUpdateController) { val state = controller.state; if (state.phase == "idle" || state.phase == "checking") return; Surface(
        modifier = Modifier.fillMaxWidth().padding(12.dp),
        shape = RoundedCornerShape(16.dp),
        color = MaterialTheme.colorScheme.surface.copy(alpha = .94f),
        shadowElevation = 6.dp,
    ) { Row(Modifier.padding(12.dp), verticalAlignment = Alignment.CenterVertically) { Icon(IconId.Download, Modifier.size(20.dp), MaterialTheme.colorScheme.primary); Column(Modifier.weight(1f).padding(horizontal = 8.dp)) { Text(when (state.phase) { "available" -> "发现新版本 ${state.version}"; "downloading" -> "正在下载更新"; "downloaded" -> "更新已下载"; "error" -> "更新检查失败"; else -> "更新" }, fontWeight = FontWeight.SemiBold); state.message?.let { Text(it, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant) }; state.progress?.let { LinearProgress(it) } }; when (state.phase) { "available" -> TextButton(onClick = controller::download) { Text("下载") }; "downloaded" -> TextButton(onClick = controller::install) { Text("安装") }; "downloading" -> CircularProgressIndicator(Modifier.size(20.dp), strokeWidth = 2.dp); "error" -> TextButton(onClick = { controller.check(true) }) { Text("重试") } }; IconButton(IconId.Close, "关闭", controller::dismiss) } } }
@Composable
private fun LinearProgress(value: Float) {
    val track = MaterialTheme.colorScheme.surfaceVariant
    val fill = MaterialTheme.colorScheme.primary
    Canvas(Modifier.fillMaxWidth().height(4.dp).clip(CircleShape)) {
        drawRoundRect(color = track, cornerRadius = CornerRadius(2f, 2f))
        drawRoundRect(color = fill, size = Size(size.width * value.coerceIn(0f, 1f), size.height), cornerRadius = CornerRadius(2f, 2f))
    }
}

@Composable private fun EmptyState(icon: IconId, title: String, detail: String, action: String?, onClick: () -> Unit = {}) { Column(Modifier.fillMaxWidth().padding(vertical = 42.dp), horizontalAlignment = Alignment.CenterHorizontally, verticalArrangement = Arrangement.spacedBy(10.dp)) { Icon(icon, Modifier.size(36.dp), MaterialTheme.colorScheme.onSurfaceVariant.copy(alpha = .7f)); Text(title, fontWeight = FontWeight.SemiBold); Text(detail, color = MaterialTheme.colorScheme.onSurfaceVariant, textAlign = TextAlign.Center, style = MaterialTheme.typography.bodySmall); if (action != null) TextButton(onClick = onClick) { Text(action) } } }
@Composable
private fun GlassCard(
    modifier: Modifier = Modifier,
    color: Color? = null,
    shape: RoundedCornerShape = RoundedCornerShape(24.dp),
    contentPadding: androidx.compose.ui.unit.Dp = 16.dp,
    content: @Composable ColumnScope.() -> Unit,
) {
    GlassPanel(modifier, shape) {
        Column(Modifier.fillMaxWidth().then(if (color != null) Modifier.background(color) else Modifier).padding(contentPadding), content = content)
    }
}
@Composable private fun LoadingRow(text: String) { Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(10.dp)) { CircularProgressIndicator(Modifier.size(20.dp), strokeWidth = 2.dp); Text(text, color = MaterialTheme.colorScheme.onSurfaceVariant) } }
@Composable
private fun Avatar(letter: String, size: androidx.compose.ui.unit.Dp) {
    AccentPanel(Modifier.size(size), CircleShape) {
        Box(Modifier.fillMaxSize(), contentAlignment = Alignment.Center) { Text(letter, color = Color.White, fontSize = 16.sp, fontWeight = FontWeight.SemiBold) }
    }
}
@Composable
private fun IconTile(icon: IconId, enabled: Boolean) {
    val dark = MaterialTheme.colorScheme.background.red < .1f
    Box(Modifier.size(44.dp).clip(RoundedCornerShape(14.dp))
        .background(Color.White.copy(alpha = if (dark) .08f else .72f))
        .border(.5.dp, Color.White.copy(alpha = if (dark) .16f else .95f), RoundedCornerShape(14.dp)), contentAlignment = Alignment.Center) {
        Icon(icon, Modifier.size(24.dp), MaterialTheme.colorScheme.onSurface.copy(alpha = if (enabled) 1f else .4f))
    }
}
@Composable private fun StatusDot(on: Boolean) { Box(Modifier.size(8.dp).clip(CircleShape).background(if (on) Color(0xFF34C759) else MaterialTheme.colorScheme.onSurfaceVariant.copy(alpha = .45f))) }
@Composable private fun StatusPill(label: String, warning: Boolean) { Surface(modifier = Modifier, shape = CircleShape, color = if (warning) Color(0xFFFF9500).copy(alpha = .16f) else MaterialTheme.colorScheme.primary.copy(alpha = .14f)) { Text(label, Modifier.padding(horizontal = 8.dp, vertical = 3.dp), style = MaterialTheme.typography.labelSmall, color = if (warning) Color(0xFFC76B00) else MaterialTheme.colorScheme.primary) } }
@Composable private fun RadioDot(selected: Boolean) { Box(Modifier.size(20.dp).border(1.dp, if (selected) MaterialTheme.colorScheme.primary else MaterialTheme.colorScheme.onSurfaceVariant, CircleShape), contentAlignment = Alignment.Center) { if (selected) Box(Modifier.size(10.dp).clip(CircleShape).background(MaterialTheme.colorScheme.primary)) } }
@Composable
private fun IconButton(icon: IconId, description: String, onClick: () -> Unit = {}) {
    GlassIconButton(icon.resourceId(), description, onClick)
}
@Composable
private fun Icon(icon: IconId, modifier: Modifier, tint: Color) {
    androidx.compose.foundation.Image(
        painter = painterResource(icon.resourceId()),
        contentDescription = null,
        modifier = modifier,
        colorFilter = androidx.compose.ui.graphics.ColorFilter.tint(tint),
    )
}

private fun IconId.resourceId(): Int = when (this) {
    IconId.Back -> R.drawable.fv_chevron_left
    IconId.Chevron -> R.drawable.fv_chevron_right
    IconId.ChevronDown -> R.drawable.fv_chevron_down
    IconId.ChevronUp -> R.drawable.fv_chevron_up
    IconId.Plus -> R.drawable.fv_plus
    IconId.Close -> R.drawable.fv_x
    IconId.Refresh -> R.drawable.fv_refresh_cw
    IconId.Search -> R.drawable.fv_search
    IconId.Send -> R.drawable.fv_arrow_up
    IconId.Stop -> R.drawable.fv_square
    IconId.Folder -> R.drawable.fv_folder
    IconId.File -> R.drawable.fv_file_text
    IconId.Image -> R.drawable.fv_image
    IconId.Chat -> R.drawable.fv_message_square
    IconId.Computer -> R.drawable.fv_monitor
    IconId.Laptop -> R.drawable.fv_laptop
    IconId.Settings -> R.drawable.fv_settings
    IconId.Model -> R.drawable.fv_cpu
    IconId.More -> R.drawable.fv_ellipsis
    IconId.Tool -> R.drawable.fv_terminal
    IconId.Sparkle -> R.drawable.fv_sparkles
    IconId.Download -> R.drawable.fv_download
    IconId.Check -> R.drawable.fv_check
    IconId.CloudOff -> R.drawable.fv_cloud_off
}

private enum class IconId { Back, Chevron, ChevronDown, ChevronUp, Plus, Close, Refresh, Search, Send, Stop, Folder, File, Image, Chat, Computer, Laptop, Settings, Model, More, Tool, Sparkle, Download, Check, CloudOff }

private fun parseOAuthCallback(intent: Intent?): OAuthCallback? {
    val uri = intent?.data ?: return null
    if (uri.scheme != "fastvibe" || uri.host != "oauth" || uri.path != "/callback") return null
    fun param(name: String): String? = uri.getQueryParameter(name)?.takeIf { it.isNotBlank() }
    return OAuthCallback(param("code"), param("token") ?: param("access_token"), param("state"), param("error"), param("origin"))
}
private fun readImageAttachment(context: Context, uri: Uri): ImageAttachment? = runCatching {
    val resolver = context.contentResolver
    val mime = resolver.getType(uri) ?: return null
    if (mime !in setOf("image/jpeg", "image/png", "image/webp", "image/gif")) return null
    val limit = 12 * 1024 * 1024
    val bytes = resolver.openInputStream(uri)?.use { stream ->
        val output = ByteArrayOutputStream()
        val buffer = ByteArray(8192)
        while (true) {
            val count = stream.read(buffer)
            if (count < 0) break
            if (output.size() + count > limit) return null
            output.write(buffer, 0, count)
        }
        output.toByteArray()
    } ?: return null
    val bounds = BitmapFactory.Options().apply { inJustDecodeBounds = true }
    BitmapFactory.decodeByteArray(bytes, 0, bytes.size, bounds)
    if (bounds.outWidth <= 0 || bounds.outHeight <= 0 || bounds.outWidth.toLong() * bounds.outHeight > 80_000_000) return null
    ImageAttachment(Base64.encodeToString(bytes, Base64.NO_WRAP), mime, uri.lastPathSegment ?: "image")
}.getOrNull()
private fun shareUri(context: Context, uri: Uri) {
    val send = Intent(Intent.ACTION_SEND).apply {
        type = context.contentResolver.getType(uri) ?: "application/octet-stream"
        putExtra(Intent.EXTRA_STREAM, uri)
        addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
    }
    context.startActivity(Intent.createChooser(send, "分享文件").addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
}
private fun connectionLabel(value: String) = when (value) { "connected" -> "已连接"; "connecting" -> "连接中"; "error" -> "连接失败"; else -> "未连接" }
private fun bounded(value: String, max: Int = 12000) = if (value.length <= max) value else value.take(max) + "\n…"
private fun truncate(value: String, max: Int) = if (value.length <= max) value else value.take(max) + "…"
