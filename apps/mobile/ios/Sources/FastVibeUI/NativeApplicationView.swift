import SwiftUI
import FastVibeCore

private enum MobileApplicationScreen {
    case login, computers, connecting, conversations, transcript, settings
}

@MainActor
public struct FastVibeRootView: View {
    @StateObject private var session: MobileSessionController
    @Environment(\.openURL) private var openURL
    @AppStorage("fastvibe.mobile.appearance") private var appearance = "system"
    @State private var screen: MobileApplicationScreen = .login
    @State private var drafts: [String: String] = [:]
    @State private var connectingDevice: MobileDevice?
    @State private var attachmentNotice = false

    public init(session: MobileSessionController = MobileSessionController()) {
        _session = StateObject(wrappedValue: session)
    }

    public var body: some View {
        ZStack {
            MobileBackdrop()
            page
        }
        .mobileGlassCanvas()
        .tint(Color.accentColor)
        .preferredColorScheme(appearance == "dark" ? .dark : appearance == "light" ? .light : nil)
        .onAppear {
            if session.isAuthenticated, screen == .login { screen = .computers }
        }
        .onChange(of: session.isAuthenticated) { _, authenticated in
            if authenticated {
                if screen == .login { screen = .computers }
            } else {
                screen = .login
                drafts.removeAll()
            }
        }
        .onChange(of: session.state.connection) { _, connection in
            if connection == "ready", !session.isLoading, screen == .connecting {
                screen = .conversations
            }
        }
        .onChange(of: session.isLoading) { _, loading in
            if !loading, session.isConnected, screen == .connecting {
                screen = .conversations
            }
        }
        .onReceive(session.$loginURL) { url in
            guard let url else { return }
            openURL(url)
            session.clearLoginURL()
        }
        .alert("FastVibe", isPresented: Binding(
            get: { session.errorMessage != nil && screen != .connecting },
            set: { if !$0 { session.clearError() } }
        )) {
            Button("好") { session.clearError() }
        } message: {
            Text(session.errorMessage ?? "")
        }
        .alert("添加附件", isPresented: $attachmentNotice) {
            Button("好", role: .cancel) {}
        } message: {
            Text("此版本暂不支持从手机上传附件。你可以继续发送文字消息。")
        }
    }

    @ViewBuilder
    private var page: some View {
        switch screen {
        case .login:
            NativeLoginView(isLoading: session.isLoading) {
                Task { await session.beginLogin() }
            }
        case .computers:
            NativeComputersView(
                devices: session.devices,
                accountLabel: session.accountLabel ?? "FastVibe 账号",
                isLoading: session.isLoading,
                onRefresh: { Task { await session.refreshDevices() } },
                onSettings: { screen = .settings },
                onSelect: connect
            )
        case .connecting:
            if let device = connectingDevice {
                NativeConnectionView(
                    device: device,
                    phase: session.state.connection,
                    errorMessage: session.errorMessage,
                    onCancel: leaveComputer,
                    onRetry: { connect(device) }
                )
            }
        case .conversations:
            NativeConversationCatalogView(
                deviceName: session.selectedDevice?.name ?? "电脑",
                conversations: session.conversations,
                projects: session.projects,
                isLoading: session.isLoading,
                onBack: leaveComputer,
                onSelect: { conversation in
                    Task {
                        if await session.openConversation(conversation.id) { screen = .transcript }
                    }
                },
                onCreate: { project in
                    Task {
                        if await session.createConversation(projectPath: project?.path) {
                            screen = .transcript
                        }
                    }
                }
            )
        case .transcript:
            NativeTranscriptView(
                messages: session.messages,
                snapshot: session.state.snapshot,
                conversationTitle: currentConversation?.title ?? "新会话",
                projectName: currentConversation?.projectName ?? "未归属项目",
                deviceName: session.selectedDevice?.name ?? "电脑",
                draft: draft,
                isSending: session.isSending,
                isLoadingHistory: session.state.loadingHistory,
                onBack: {
                    screen = .conversations
                    Task { await session.refreshConversations() }
                },
                onSend: send,
                onStop: { Task { await session.abort() } },
                onLoadHistory: { Task { await session.loadOlderMessages() } },
                onQueueRemove: { id in Task { await session.removeQueuedMessage(id) } },
                onPermissionRespond: { request, response in
                    Task { await session.respondToPermission(request, response: response) }
                },
                onAttach: { attachmentNotice = true }
            )
        case .settings:
            NativeSettingsView(
                accountLabel: session.accountLabel ?? "FastVibe 账号",
                accountEmail: session.accountEmail,
                deviceName: Binding(
                    get: { session.localDeviceName },
                    set: { session.localDeviceName = $0 }
                ),
                appearance: $appearance,
                endpointID: session.endpointIdentifier,
                connectionPath: session.connectionPath ?? (session.isConnected ? "已连接" : "未连接"),
                coreVersion: session.coreVersion,
                onBack: { screen = .computers },
                onSignOut: { Task { await session.signOut() } }
            )
        }
    }

    private var currentConversation: NativeConversation? {
        session.conversations.first { $0.id == session.conversationID }
    }

    private var draftKey: String {
        "\(session.selectedDevice?.id ?? ""):\(session.conversationID)"
    }

    private var draft: Binding<String> {
        let key = draftKey
        return Binding(
            get: { drafts[key] ?? "" },
            set: { drafts[key] = $0 }
        )
    }

    private func connect(_ device: MobileDevice) {
        session.clearError()
        connectingDevice = device
        screen = .connecting
        Task { await session.connect(to: device) }
    }

    private func leaveComputer() {
        screen = .computers
        Task { await session.disconnect() }
    }

    private func send(_ text: String) {
        let key = draftKey
        Task {
            guard draftKey == key else { return }
            let sent = await session.sendPrompt(text)
            if sent, drafts[key] == text { drafts[key] = "" }
        }
    }
}
