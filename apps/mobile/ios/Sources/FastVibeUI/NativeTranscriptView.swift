import Foundation
import SwiftUI
import FastVibeCore

/// A transparent conversation surface. The host owns the backdrop, navigation and RPCs.
public struct NativeTranscriptView: View {
    public let messages: [MobileMessage]
    public let snapshot: MobileConversationSnapshot?
    public let conversationTitle: String
    public let projectName: String
    public let deviceName: String
    @Binding public var draft: String
    public let isSending: Bool
    public let isLoadingHistory: Bool
    public let onBack: () -> Void
    public let onSend: (String) -> Void
    public let onStop: () -> Void
    public let onLoadHistory: () -> Void
    public let onQueueRemove: (String) -> Void
    public let onPermissionRespond: (MobileJSONValue, MobileJSONValue) -> Void
    public let onAttach: () -> Void

    @Environment(\.colorScheme) private var scheme
    @State private var scrollToLatest = 0
    @FocusState private var composerFocused: Bool

    public init(
        messages: [MobileMessage],
        snapshot: MobileConversationSnapshot?,
        conversationTitle: String,
        projectName: String,
        deviceName: String,
        draft: Binding<String>,
        isSending: Bool,
        isLoadingHistory: Bool,
        onBack: @escaping () -> Void,
        onSend: @escaping (String) -> Void,
        onStop: @escaping () -> Void,
        onLoadHistory: @escaping () -> Void,
        onQueueRemove: @escaping (String) -> Void,
        onPermissionRespond: @escaping (MobileJSONValue, MobileJSONValue) -> Void,
        onAttach: @escaping () -> Void
    ) {
        self.messages = messages
        self.snapshot = snapshot
        self.conversationTitle = conversationTitle
        self.projectName = projectName
        self.deviceName = deviceName
        self._draft = draft
        self.isSending = isSending
        self.isLoadingHistory = isLoadingHistory
        self.onBack = onBack
        self.onSend = onSend
        self.onStop = onStop
        self.onLoadHistory = onLoadHistory
        self.onQueueRemove = onQueueRemove
        self.onPermissionRespond = onPermissionRespond
        self.onAttach = onAttach
    }

    private var palette: MobilePalette { MobilePalette(scheme: scheme) }
    private var running: Bool { snapshot?.running == true }
    private var hasDraft: Bool { !draft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty }
    private var pending: [MobileJSONValue] {
        (snapshot?.pendingUI ?? []).filter { request in
            guard let method = request.ntString("method"),
                  ["confirm", "select", "input", "editor", "questions"].contains(method),
                  request.ntField("id") != nil else { return false }
            if let owner = request.ntString("conversationId"), let current = snapshot?.conversationId {
                return owner == current
            }
            return true
        }
    }

    public var body: some View {
        GeometryReader { geometry in
            ZStack(alignment: .bottom) {
                VStack(spacing: 0) {
                    navigation
                        .zIndex(1)
                    NativeTranscriptScroll(
                        messages: messages,
                        running: running,
                        waiting: !pending.isEmpty,
                        projectName: projectName,
                        hasHistory: snapshot?.historyBeforeEntryId != nil,
                        loadingHistory: isLoadingHistory,
                        scrollToLatest: scrollToLatest,
                        onLoadHistory: loadHistory,
                        onContinue: { onSend("继续") }
                    )
                    .id(snapshot?.conversationId ?? "new-conversation")
                    .clipped()
                    composer
                }
                .accessibilityHidden(!pending.isEmpty)

                if let request = pending.first {
                    (scheme == .dark ? Color.black.opacity(0.5) : Color(hex: 0x141828).opacity(0.2))
                        .ignoresSafeArea()
                        .contentShape(Rectangle())
                        .onTapGesture { composerFocused = false }
                    NativePendingOperationSheet(
                        request: request,
                        count: pending.count,
                        context: conversationTitle,
                        maximumHeight: max(180, geometry.size.height - 24),
                        onRespond: { response in onPermissionRespond(request, response) }
                    )
                    .id(request.ntField("id"))
                    .padding(8)
                    .transition(.move(edge: .bottom).combined(with: .opacity))
                    .zIndex(1)
                }
            }
        }
        .font(.system(size: 17))
        .foregroundStyle(palette.text)
        .tint(palette.accent)
        .onChange(of: snapshot?.conversationId) { _, _ in composerFocused = false }
        .onChange(of: pending.first?.ntField("id")) { _, request in
            if request != nil { composerFocused = false }
        }
    }

    private var navigation: some View {
        VStack(spacing: 8) {
            HStack(spacing: 10) {
                MobileIconButton(systemName: "chevron.left", label: "返回会话", action: onBack)
                VStack(spacing: 2) {
                    Text(conversationTitle.isEmpty ? "新会话" : conversationTitle)
                        .font(.system(size: 16, weight: .semibold))
                        .lineLimit(1)
                    Text([projectName.isEmpty ? "未归属项目" : projectName, deviceName]
                        .filter { !$0.isEmpty }.joined(separator: " · "))
                        .font(.system(size: 11.5))
                        .foregroundStyle(palette.secondary)
                        .lineLimit(1)
                }
                .frame(maxWidth: .infinity)
                .accessibilityElement(children: .combine)
                Menu {
                    Button("回到最新消息", systemImage: "arrow.down.to.line") { scrollToLatest += 1 }
                    if snapshot?.historyBeforeEntryId != nil {
                        Button("加载更早消息", systemImage: "clock.arrow.circlepath", action: loadHistory)
                            .disabled(isLoadingHistory)
                    }
                    if running { Button("停止回复", systemImage: "stop", action: onStop) }
                } label: {
                    Image(systemName: "ellipsis")
                        .font(.system(size: 20, weight: .medium))
                        .frame(width: 44, height: 44)
                        .background { NativeTranscriptControlBackground(radius: 22) }
                }
                .fixedSize()
                #if os(macOS)
                .menuStyle(.borderlessButton)
                .menuIndicator(.hidden)
                #endif
                .accessibilityLabel("更多")
            }
            if isLoadingHistory {
                HStack(spacing: 8) {
                    ProgressView().controlSize(.small)
                    Text("正在加载更早的消息…").font(.system(size: 13, weight: .semibold))
                }
                .foregroundStyle(palette.secondary)
                .padding(.horizontal, 14)
                .frame(height: 38)
                .background { NativeTranscriptControlBackground(radius: 19) }
                .accessibilityElement(children: .combine)
            }
        }
        .padding(.horizontal, 12)
        .padding(.top, 2)
        .padding(.bottom, isLoadingHistory ? 12 : 10)
        .background(alignment: .top) {
            MobileGlassSurface(kind: .navigation, radius: 0)
                .padding(.bottom, -22)
                .ignoresSafeArea(edges: .top)
                .allowsHitTesting(false)
        }
    }

    private var composer: some View {
        VStack(spacing: 8) {
            if let queue = snapshot?.queue, !queue.items.isEmpty {
                NativeTranscriptQueue(queue: queue, onRemove: onQueueRemove)
            }
            HStack(alignment: .bottom, spacing: 8) {
                HStack(alignment: .bottom, spacing: 2) {
                    Button(action: onAttach) {
                        Image(systemName: "plus")
                            .font(.system(size: 20, weight: .regular))
                            .foregroundStyle(palette.secondary)
                            .frame(width: 44, height: 44)
                            .contentShape(Circle())
                    }
                    .buttonStyle(.plain)
                    .accessibilityLabel("添加附件")
                    TextField(running ? "继续输入，会排队发送" : "发送消息", text: $draft, axis: .vertical)
                        .font(.system(size: 16))
                        .lineLimit(1...6)
                        .textFieldStyle(.plain)
                        .focused($composerFocused)
                        .padding(.vertical, 12)
                        .padding(.leading, 2)
                        .padding(.trailing, 12)
                        .frame(minHeight: 48)
                        .accessibilityLabel("消息")
                }
                .frame(minHeight: 48)
                .background { NativeTranscriptControlBackground(radius: 24) }
                Button(action: primaryAction) {
                    ZStack {
                        if isSending {
                            ProgressView().tint(hasDraft ? .white : palette.secondary)
                        } else if running && !hasDraft {
                            RoundedRectangle(cornerRadius: 2).fill(scheme == .dark ? .black : .white)
                                .frame(width: 14, height: 14)
                        } else {
                            Image(systemName: "arrow.up")
                                .font(.system(size: 22, weight: .semibold))
                                .foregroundStyle(hasDraft ? .white : palette.secondary)
                        }
                    }
                    .frame(width: 48, height: 48)
                    .background {
                        if running && !hasDraft {
                            Circle().fill(scheme == .dark ? Color(white: 0.95) : Color(white: 0.11))
                                .shadow(color: .black.opacity(0.16), radius: 8, y: 4)
                        } else if hasDraft {
                            MobileAccentSurface(shape: Circle())
                        } else {
                            NativeTranscriptControlBackground(radius: 24)
                        }
                    }
                    .contentShape(Circle())
                }
                .buttonStyle(.plain)
                .disabled(isSending || (!running && !hasDraft))
                .accessibilityLabel(running && !hasDraft ? "停止" : (running ? "加入排队" : "发送"))
            }
        }
        .padding(.horizontal, 12)
        .padding(.top, 8)
        .padding(.bottom, 6)
        .background {
            MobileGlassBackdropSample(saturation: 1, blurRadius: 8)
                .mask(LinearGradient(stops: [
                    .init(color: .clear, location: 0),
                    .init(color: .black, location: 0.45),
                    .init(color: .black, location: 1),
                ], startPoint: .top, endPoint: .bottom))
                .padding(.top, -24)
                .ignoresSafeArea(edges: .bottom)
                .allowsHitTesting(false)
        }
    }

    private func primaryAction() {
        guard !isSending else { return }
        if running && !hasDraft { onStop() }
        else if hasDraft {
            scrollToLatest += 1
            // The host clears this binding only after its RPC acknowledges this exact draft.
            onSend(draft)
        }
    }

    private func loadHistory() {
        guard !isLoadingHistory, snapshot?.historyBeforeEntryId != nil else { return }
        onLoadHistory()
    }
}

private struct NativeTranscriptScroll: View {
    let messages: [MobileMessage]
    let running: Bool
    let waiting: Bool
    let projectName: String
    let hasHistory: Bool
    let loadingHistory: Bool
    let scrollToLatest: Int
    let onLoadHistory: () -> Void
    let onContinue: () -> Void

    @Environment(\.colorScheme) private var scheme
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @State private var visibleMessageID: String?
    @State private var followsTail = true
    @State private var didInitialScroll = false
    private let bottomID = "native-transcript-bottom"
    private var palette: MobilePalette { MobilePalette(scheme: scheme) }
    private var activeMessageID: String? {
        running ? messages.last(where: { $0.role == .assistant })?.id : nil
    }

    var body: some View {
        GeometryReader { viewport in
            ScrollViewReader { proxy in
                ScrollView {
                    LazyVStack(alignment: .leading, spacing: 16) {
                        if hasHistory {
                            HStack {
                                Spacer(minLength: 0)
                                Button {
                                    followsTail = false
                                    onLoadHistory()
                                } label: {
                                    Label("加载更早消息", systemImage: "clock.arrow.circlepath")
                                        .font(.system(size: 13, weight: .semibold))
                                        .foregroundStyle(palette.secondary)
                                        .padding(.horizontal, 14)
                                        .frame(minHeight: 36)
                                        .background { NativeTranscriptControlBackground(radius: 18) }
                                        .frame(minHeight: 44)
                                }
                                .buttonStyle(.plain)
                                .disabled(loadingHistory)
                                Spacer(minLength: 0)
                            }
                        }
                        if messages.isEmpty && !running {
                            emptyState.frame(minHeight: max(200, viewport.size.height - 84))
                        }
                        ForEach(messages) { message in
                            NativeTranscriptMessage(
                                message: message,
                                isRunning: message.id == activeMessageID,
                                waiting: waiting,
                                canContinue: message.id == messages.last?.id && !running,
                                onContinue: onContinue
                            )
                            .id(message.id)
                        }
                        if running && (messages.isEmpty || messages.last?.role == .user) {
                            HStack(spacing: 8) {
                                ProgressView().controlSize(.small)
                                Text(waiting ? "等待你的操作" : "正在回复…")
                                    .font(.system(size: 14)).foregroundStyle(palette.secondary)
                            }
                            .frame(minHeight: 36)
                        }
                        Color.clear.frame(height: 1)
                            .id(bottomID)
                            .background {
                                GeometryReader { marker in
                                    Color.clear.preference(key: NativeTranscriptBottomKey.self, value: marker.frame(in: .named("native-transcript-scroll")).maxY)
                                }
                            }
                    }
                    .scrollTargetLayout()
                    .padding(.horizontal, 16)
                    .padding(.top, 4)
                    .padding(.bottom, 20)
                }
                .coordinateSpace(name: "native-transcript-scroll")
                .scrollPosition(id: $visibleMessageID, anchor: .top)
                .scrollDismissesKeyboard(.interactively)
                .onPreferenceChange(NativeTranscriptBottomKey.self) { bottom in
                    // Ignore lazy-stack removal of the marker while reading older messages.
                    followsTail = bottom.isFinite && bottom <= viewport.size.height + 72
                }
                .onAppear {
                    guard !didInitialScroll, !messages.isEmpty else { return }
                    didInitialScroll = true
                    proxy.scrollTo(bottomID, anchor: .bottom)
                }
                .onChange(of: messages.map(\.id)) { old, new in
                    // Stable scroll targets preserve the reading anchor when history is prepended.
                    let prepended = old.first != new.first && old.first.map(new.contains) == true
                    if !didInitialScroll && !new.isEmpty {
                        didInitialScroll = true
                        proxy.scrollTo(bottomID, anchor: .bottom)
                    } else if !prepended && followsTail && !loadingHistory {
                        proxy.scrollTo(bottomID, anchor: .bottom)
                    }
                }
                .onChange(of: loadingHistory) { _, loading in
                    if loading { followsTail = false }
                }
                .onChange(of: messages.last) { _, _ in
                    guard didInitialScroll, followsTail, !loadingHistory else { return }
                    proxy.scrollTo(bottomID, anchor: .bottom)
                }
                .onChange(of: scrollToLatest) { _, _ in
                    followsTail = true
                    if reduceMotion { proxy.scrollTo(bottomID, anchor: .bottom) }
                    else { withAnimation(.easeOut(duration: 0.2)) { proxy.scrollTo(bottomID, anchor: .bottom) } }
                }
                .onChange(of: viewport.size.height) { _, _ in
                    guard followsTail, !loadingHistory else { return }
                    proxy.scrollTo(bottomID, anchor: .bottom)
                }
            }
        }
    }

    private var emptyState: some View {
        VStack(spacing: 10) {
            Image(systemName: "bubble.left")
                .font(.system(size: 20))
                .foregroundStyle(palette.secondary)
                .frame(width: 44, height: 44)
                .background(palette.controlTint, in: RoundedRectangle(cornerRadius: 14))
                .padding(.bottom, 8)
            Text("开始新会话").font(.system(size: 22, weight: .bold)).foregroundStyle(palette.text)
            Text(projectName.isEmpty ? "未归属项目" : projectName)
            Text("发送第一条消息，开始这次任务。")
        }
        .font(.system(size: 15))
        .foregroundStyle(palette.secondary)
        .frame(maxWidth: .infinity)
        .padding(.horizontal, 16)
        .padding(.bottom, 80)
    }
}

private struct NativeTranscriptBottomKey: PreferenceKey {
    static var defaultValue: CGFloat { .infinity }
    static func reduce(value: inout CGFloat, nextValue: () -> CGFloat) { value = nextValue() }
}
