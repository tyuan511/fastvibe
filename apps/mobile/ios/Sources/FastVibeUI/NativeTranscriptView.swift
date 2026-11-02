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
    /// Optional reference-render controls. Nil keeps the live transcript's state-driven defaults.
    public let initiallyExpandedThinkingMessageIDs: Set<String>?
    public let initiallyExpandedToolMessageIDs: Set<String>?
    public let initiallyExpandedToolIDs: Set<String>?
    public let referenceNow: Int64?
    public let initialScrollToLatest: Bool
    public let initialScrollTargetID: String?

    @Environment(\.colorScheme) private var scheme
    @State private var scrollToLatest = 0
    @State private var composerHeight: CGFloat = 0
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
        onAttach: @escaping () -> Void,
        initiallyExpandedThinkingMessageIDs: Set<String>? = nil,
        initiallyExpandedToolMessageIDs: Set<String>? = nil,
        initiallyExpandedToolIDs: Set<String>? = nil,
        referenceNow: Int64? = nil,
        initialScrollToLatest: Bool = true,
        initialScrollTargetID: String? = nil
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
        self.initiallyExpandedThinkingMessageIDs = initiallyExpandedThinkingMessageIDs
        self.initiallyExpandedToolMessageIDs = initiallyExpandedToolMessageIDs
        self.initiallyExpandedToolIDs = initiallyExpandedToolIDs
        self.referenceNow = referenceNow
        self.initialScrollToLatest = initialScrollToLatest
        self.initialScrollTargetID = initialScrollTargetID
    }

    private var palette: MobilePalette { MobilePalette(scheme: scheme) }
    private var running: Bool { snapshot?.running == true }
    private var hasDraft: Bool { !draft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty }
    private var queueHeight: CGFloat {
        guard let queue = snapshot?.queue, !queue.items.isEmpty else { return 0 }
        return 38 + min(CGFloat(queue.items.count) * 44, 132)
    }
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
                NativeTranscriptScroll(
                    messages: messages,
                    running: running,
                    waiting: !pending.isEmpty,
                    projectName: projectName,
                    hasHistory: snapshot?.historyBeforeEntryId != nil,
                    loadingHistory: isLoadingHistory,
                    scrollToLatest: scrollToLatest,
                    topInset: isLoadingHistory ? 111 : 61,
                    bottomInset: max(48 + queueHeight, composerHeight) + 2,
                    initiallyExpandedThinkingMessageIDs: initiallyExpandedThinkingMessageIDs,
                    initiallyExpandedToolMessageIDs: initiallyExpandedToolMessageIDs,
                    initiallyExpandedToolIDs: initiallyExpandedToolIDs,
                    referenceNow: referenceNow,
                    initialScrollToLatest: initialScrollToLatest,
                    initialScrollTargetID: initialScrollTargetID,
                    onLoadHistory: loadHistory,
                    onScrollToLatest: { scrollToLatest += 1 },
                    onContinue: { onSend("继续") }
                )
                .id(snapshot?.conversationId ?? "new-conversation")
                .overlay(alignment: .top) { navigation }
                .overlay(alignment: .bottom) {
                    if pending.isEmpty {
                        composer
                            .onGeometryChange(for: CGFloat.self) { $0.size.height } action: { composerHeight = $0 }
                            .offset(y: composerFocused ? 0 : max(0, geometry.safeAreaInsets.bottom - 30))
                    }
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
                        maximumHeight: max(180, geometry.size.height + geometry.safeAreaInsets.bottom - 24),
                        onRespond: { response in onPermissionRespond(request, response) }
                    )
                    .id(request.ntField("id"))
                    .padding(8)
                    .padding(.bottom, -geometry.safeAreaInsets.bottom)
                    .transition(.move(edge: .bottom))
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
                if pending.isEmpty {
                    Menu {
                        Button("回到最新消息", systemImage: "arrow.down.to.line") { scrollToLatest += 1 }
                        if snapshot?.historyBeforeEntryId != nil {
                            Button("加载更早消息", systemImage: "clock.arrow.circlepath", action: loadHistory)
                                .disabled(isLoadingHistory)
                        }
                        if running { Button("停止回复", systemImage: "stop", action: onStop) }
                    } label: {
                        MobileGlyph(systemName: "ellipsis")
                            .frame(width: 20, height: 20)
                            .frame(width: 44, height: 44)
                            .background { NativeTranscriptControlBackground(radius: 22) }
                    }
                    .fixedSize()
                #if os(macOS)
                    .menuStyle(.borderlessButton)
                    .menuIndicator(.hidden)
                #endif
                    .accessibilityLabel("更多")
                } else {
                    Color.clear.frame(width: 44, height: 44)
                }
            }
            if isLoadingHistory {
                HStack(spacing: 8) {
                    ProgressView().controlSize(.small)
                    Text("正在加载更早的消息…").font(.system(size: 13, weight: .semibold))
                }
                .foregroundStyle(palette.secondary)
                .padding(.horizontal, 14)
                .frame(height: 36)
                .background { NativeTranscriptControlBackground(radius: 18) }
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
                HStack(alignment: .center, spacing: 2) {
                    Button(action: onAttach) {
                        MobileGlyph(systemName: "paperclip")
                            .frame(width: 20, height: 20)
                            .foregroundStyle(palette.secondary)
                            .frame(width: 40, height: 40)
                            .contentShape(Circle())
                    }
                    .buttonStyle(.plain)
                    .accessibilityLabel("添加附件")
                    TextField(running ? "继续输入，会排队发送" : "发送消息", text: $draft, axis: .vertical)
                        .font(.system(size: 16))
                        .lineLimit(1...6)
                        .textFieldStyle(.plain)
                        .focused($composerFocused)
                        .padding(.vertical, 7)
                        .padding(.horizontal, 6)
                        .frame(minHeight: 40)
                        .accessibilityLabel("消息")
                }
                .padding(4)
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
                            MobileGlyph(systemName: "arrow.up")
                                .frame(width: 22, height: 22)
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
        .padding(.bottom, 0)
        .background {
            #if canImport(UIKit)
            NativeBackdropBlur(recipe: .composer, mask: .composer)
                .padding(.top, -24)
                .ignoresSafeArea(edges: .bottom)
                .allowsHitTesting(false)
            #else
            MobileGlassBackdropSample(saturation: 1, blurRadius: 8)
                .mask(LinearGradient(stops: [
                    .init(color: .clear, location: 0),
                    .init(color: .black, location: 0.45),
                    .init(color: .black, location: 1),
                ], startPoint: .top, endPoint: .bottom))
                .padding(.top, -24)
                .ignoresSafeArea(edges: .bottom)
                .allowsHitTesting(false)
            #endif
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
    let topInset: CGFloat
    let bottomInset: CGFloat
    let initiallyExpandedThinkingMessageIDs: Set<String>?
    let initiallyExpandedToolMessageIDs: Set<String>?
    let initiallyExpandedToolIDs: Set<String>?
    let referenceNow: Int64?
    let initialScrollToLatest: Bool
    let initialScrollTargetID: String?
    let onLoadHistory: () -> Void
    let onScrollToLatest: () -> Void
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
                ZStack(alignment: .bottom) {
                    ScrollView {
                    LazyVStack(alignment: .leading, spacing: 16) {
                        if hasHistory && !loadingHistory {
                            HStack {
                                Spacer(minLength: 0)
                                Button {
                                    followsTail = false
                                    onLoadHistory()
                                } label: {
                                    Label("加载更早的消息", systemImage: "clock.arrow.circlepath")
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
                            emptyState.frame(minHeight: max(200, viewport.size.height - topInset - bottomInset - 24))
                        }
                        ForEach(messages) { message in
                            NativeTranscriptMessage(
                                message: message,
                                isRunning: message.id == activeMessageID,
                                waiting: waiting,
                                canContinue: message.id == messages.last?.id && !running && !waiting && message.stop != nil,
                                onContinue: onContinue,
                                initiallyExpandedThinking: initiallyExpandedThinkingMessageIDs.map { $0.contains(message.id) },
                                initiallyExpandedTools: initiallyExpandedToolMessageIDs.map { $0.contains(message.id) },
                                initiallyExpandedToolIDs: initiallyExpandedToolIDs,
                                referenceNow: referenceNow
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
                        Color.clear.frame(height: bottomInset + 20)
                            .id(bottomID)
                            .background {
                                GeometryReader { marker in
                                    Color.clear.preference(key: NativeTranscriptBottomKey.self, value: marker.frame(in: .named("native-transcript-scroll")).maxY)
                                }
                            }
                    }
                    .scrollTargetLayout()
                    .padding(.horizontal, 16)
                    .padding(.top, topInset + 4)
                }
                .coordinateSpace(name: "native-transcript-scroll")
                .scrollPosition(id: $visibleMessageID, anchor: .top)
                .scrollDismissesKeyboard(.interactively)
                .onPreferenceChange(NativeTranscriptBottomKey.self) { bottom in
                    // Ignore lazy-stack removal of the marker while reading older messages.
                    followsTail = bottom.isFinite && bottom <= viewport.size.height + 72
                }
                .onAppear {
                    followsTail = initialScrollToLatest
                    guard !didInitialScroll, !messages.isEmpty else { return }
                    didInitialScroll = true
                    if let target = initialScrollTargetID { proxy.scrollTo(target, anchor: .top) }
                    else if initialScrollToLatest { proxy.scrollTo(bottomID, anchor: .bottom) }
                }
                .onChange(of: messages.map(\.id)) { old, new in
                    // Stable scroll targets preserve the reading anchor when history is prepended.
                    let prepended = old.first != new.first && old.first.map(new.contains) == true
                    if !didInitialScroll && !new.isEmpty {
                        didInitialScroll = true
                        if let target = initialScrollTargetID { proxy.scrollTo(target, anchor: .top) }
                        else if initialScrollToLatest { proxy.scrollTo(bottomID, anchor: .bottom) }
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
                .opacity(!needsInitialPosition || messages.isEmpty || didInitialScroll ? 1 : 0)
                .onChange(of: viewport.size.height) { _, _ in
                    guard followsTail, !loadingHistory else { return }
                    proxy.scrollTo(bottomID, anchor: .bottom)
                }
                if didInitialScroll && !followsTail && !loadingHistory && !messages.isEmpty {
                    Button(action: onScrollToLatest) {
                        MobileGlyph(systemName: "arrow.down.to.line")
                            .frame(width: 20, height: 20)
                            .foregroundStyle(palette.text)
                            .frame(width: 44, height: 44)
                            .background { NativeTranscriptControlBackground(radius: 22) }
                    }
                    .buttonStyle(.plain)
                    .padding(.bottom, bottomInset + 12)
                    .accessibilityLabel("回到最新消息")
                    .transition(.scale.combined(with: .opacity))
                    .zIndex(1)
                }
            }
        }
    }
    }

    private var needsInitialPosition: Bool { initialScrollToLatest || initialScrollTargetID != nil }

    private var emptyState: some View {
        VStack(spacing: 10) {
            MobileGlyph(systemName: "bubble.left")
                .frame(width: 20, height: 20)
                .foregroundStyle(palette.text)
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
