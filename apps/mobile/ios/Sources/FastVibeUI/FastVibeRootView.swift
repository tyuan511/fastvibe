import Foundation
import Security
import SwiftUI
import FastVibeCore

public struct MobileDevice: Codable, Hashable, Identifiable, Sendable {
    public let id: String
    public let name: String
    public let platform: String
    public let irohEndpointId: String?
    public let online: Bool

    private enum CodingKeys: String, CodingKey {
        case id, name, platform, irohEndpointId, online
    }

    public init(
        id: String,
        name: String,
        platform: String,
        irohEndpointId: String? = nil,
        online: Bool = false
    ) {
        self.id = id
        self.name = name
        self.platform = platform
        self.irohEndpointId = irohEndpointId
        self.online = online
    }

    public init(from decoder: Decoder) throws {
        let values = try decoder.container(keyedBy: CodingKeys.self)
        id = try values.decode(String.self, forKey: .id)
        name = try values.decodeIfPresent(String.self, forKey: .name) ?? id
        platform = try values.decodeIfPresent(String.self, forKey: .platform) ?? "unknown"
        irohEndpointId = try values.decodeIfPresent(String.self, forKey: .irohEndpointId)
        online = try values.decodeIfPresent(Bool.self, forKey: .online) ?? false
    }
}

public enum MobileSessionControllerError: LocalizedError, Equatable, Sendable {
    case message(String)
    case invalidLoginCallback
    case loginStateMismatch
    case missingDeviceEndpoint
    case missingRelayConfiguration

    public var errorDescription: String? {
        switch self {
        case .message(let message): return message
        case .invalidLoginCallback: return "登录回调无效，请重新登录。"
        case .loginStateMismatch: return "登录状态校验失败，请重新登录。"
        case .missingDeviceEndpoint: return "这台电脑还没有可用的远程连接端点。"
        case .missingRelayConfiguration: return "无法取得这台电脑的连接配置。"
        }
    }
}

private enum MobileKeychain {
    private static let service = "dev.fastvibe.mobile"

    static func set(_ value: String, for key: String) {
        let data = Data(value.utf8)
        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: key,
        ]
        SecItemDelete(query as CFDictionary)
        var item = query
        item[kSecValueData as String] = data
        item[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly
        SecItemAdd(item as CFDictionary, nil)
    }

    static func get(_ key: String) -> String? {
        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: key,
            kSecReturnData as String: true,
            kSecMatchLimit as String: kSecMatchLimitOne,
        ]
        var result: CFTypeRef?
        guard SecItemCopyMatching(query as CFDictionary, &result) == errSecSuccess,
              let data = result as? Data
        else { return nil }
        return String(data: data, encoding: .utf8)
    }
}

/// Main-actor session facade for the native SwiftUI shell.
///
/// Rust owns authentication, transport, event reduction, cursor handling, and the bounded
/// transcript projection. This object only sequences commands and exposes their state to SwiftUI.
@MainActor
public final class MobileSessionController: ObservableObject {
    @Published public private(set) var state: MobileSessionState
    @Published public private(set) var devices: [MobileDevice] = []
    @Published public private(set) var selectedDevice: MobileDevice?
    @Published public private(set) var isAuthenticated = false
    @Published public private(set) var accountLabel: String?
    @Published public private(set) var isLoading = false
    @Published public private(set) var errorMessage: String?
    @Published public private(set) var loginURL: URL?
    @Published public var conversationID: String

    public let accountOrigin: String
    public let redirectURI = "fastvibe://oauth/callback"

    private let bridge: MobileCoreBridge
    private let executor: MobileCoreCommandExecutor
    private let deviceName: String
    private let platform: String
    private let installID: String
    private var localDeviceID: String?
    private var endpointID: String?
    private var loginState: String?
    private var callbackState: String?
    private var pollTask: Task<Void, Never>?

    public init(
        bridge: MobileCoreBridge = MobileCoreBridge(),
        accountOrigin: String = "https://app.fastvibe.dev",
        deviceName: String = "FastVibe Mobile",
        platform: String = "ios",
        conversationID: String = ""
    ) {
        self.bridge = bridge
        self.executor = MobileCoreCommandExecutor(bridge: bridge)
        self.accountOrigin = accountOrigin.trimmingCharacters(in: CharacterSet(charactersIn: "/"))
        self.deviceName = deviceName
        self.platform = platform
        self.conversationID = conversationID
        self.installID = Self.loadInstallID()
        self.state = bridge.store.state
        if let savedIdentity = MobileKeychain.get("iroh.identity") {
            Task { [weak self] in
                _ = try? await self?.perform("setIdentity", parameters: ["secretKey": .string(savedIdentity)])
            }
        }
        if let savedOrigin = MobileKeychain.get("account.origin"),
           let savedToken = MobileKeychain.get("account.token") {
            Task { [weak self] in
                guard let self else { return }
                _ = try? await self.perform("setToken", parameters: [
                    "token": .string(savedToken),
                    "origin": .string(savedOrigin),
                ])
                self.isAuthenticated = true
                self.accountLabel = "已登录"
                try? await self.refreshDevicesInternal()
            }
        }
    }

    deinit {
        pollTask?.cancel()
    }

    public var messages: [MobileMessage] { state.messages }
    public var isConnected: Bool { state.connection == "connected" }
    public var statusText: String { state.connection.capitalized }

    public func beginLogin() async {
        await runLoading { [self] in
            let response = try await perform(
                "loginUrl",
                parameters: [
                    "origin": .string(accountOrigin),
                    "redirectUri": .string(redirectURI),
                    "deviceName": .string(deviceName),
                    "platform": .string(platform),
                ]
            )
            guard let urlString = response.result.stringValue(key: "url"),
                  let url = URL(string: urlString)
            else {
                throw MobileSessionControllerError.message("登录地址无效。")
            }
            loginState = response.result.stringValue(key: "state")
            loginURL = url
        }
    }

    /// The app root forwards `fastvibe://oauth/callback` here from `onOpenURL`.
    public func handleOAuthCallback(_ url: URL) {
        guard url.scheme?.lowercased() == "fastvibe",
              url.host?.lowercased() == "oauth",
              url.path == "/callback"
        else {
            errorMessage = MobileSessionControllerError.invalidLoginCallback.localizedDescription
            return
        }

        let query = URLComponents(url: url, resolvingAgainstBaseURL: false)?.queryItems ?? []
        let values = Dictionary(uniqueKeysWithValues: query.map { ($0.name, $0.value ?? "") })
        if let callbackError = values["error"], !callbackError.isEmpty {
            errorMessage = "登录未完成：\(callbackError)"
            loginState = nil
            return
        }
        guard let expectedState = loginState,
              values["state"] == expectedState
        else {
            errorMessage = MobileSessionControllerError.loginStateMismatch.localizedDescription
            loginState = nil
            return
        }
        guard let code = values["code"], !code.isEmpty else {
            errorMessage = MobileSessionControllerError.invalidLoginCallback.localizedDescription
            loginState = nil
            return
        }

        callbackState = values["state"]
        loginState = nil
        Task { [weak self] in
            guard let self else { return }
            await self.exchangeOAuthCode(code)
        }
    }

    public func clearLoginURL() {
        loginURL = nil
    }

    public func clearError() {
        errorMessage = nil
    }

    /// Inject an already-issued account token. The token remains in Rust memory and is never
    /// persisted or exposed to SwiftUI. This is useful when the host app owns secure storage.
    public func injectToken(_ token: String, origin: String? = nil) async {
        guard !token.isEmpty else {
            errorMessage = "登录令牌为空。"
            return
        }
        await runLoading { [self] in
            _ = try await perform(
                "setToken",
                parameters: [
                    "token": .string(token),
                    "origin": .string(origin ?? accountOrigin),
                ]
            )
            MobileKeychain.set(token, for: "account.token")
            MobileKeychain.set(origin ?? accountOrigin, for: "account.origin")
            isAuthenticated = true
            accountLabel = "已登录"
            try await refreshDevicesInternal()
        }
    }

    public func refreshDevices() async {
        guard isAuthenticated else { return }
        await runLoading { [self] in
            try await refreshDevicesInternal()
        }
    }

    public func connect(to device: MobileDevice) async {
        guard let remoteEndpointID = device.irohEndpointId, !remoteEndpointID.isEmpty else {
            errorMessage = MobileSessionControllerError.missingDeviceEndpoint.localizedDescription
            return
        }
        guard !conversationID.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else {
            errorMessage = "请输入会话 ID 后再连接。"
            return
        }

        selectedDevice = device
        await runLoading { [self] in
            let identity = try await perform("identity")
            guard let localEndpointID = identity.result.stringValue(key: "endpointId") else {
                throw MobileSessionControllerError.message("无法创建本机连接身份。")
            }
            if let secretKey = identity.result.stringValue(key: "secretKey") {
                MobileKeychain.set(secretKey, for: "iroh.identity")
            }
            endpointID = localEndpointID

            let localID = try await ensureLocalDevice()
            _ = try await perform(
                "registerEndpoint",
                parameters: [
                    "deviceId": .string(localID),
                    "endpointId": .string(localEndpointID),
                ]
            )
            let relay = try await perform(
                "relay",
                parameters: [
                    "deviceId": .string(device.id),
                    "endpointId": .string(localEndpointID),
                ]
            )
            guard let relayURL = relay.result.stringValue(key: "url"),
                  let relayToken = relay.result.stringValue(key: "token")
            else {
                throw MobileSessionControllerError.missingRelayConfiguration
            }

            _ = try await perform(
                "connect",
                parameters: [
                    "remoteId": .string(remoteEndpointID),
                    "conversationId": .string(conversationID),
                    "relay": .object([
                        "url": .string(relayURL),
                        "token": .string(relayToken),
                    ]),
                ]
            )
            startPolling()
            try await subscribeAndRequestSnapshot()
        }
    }

    public func disconnect() async {
        stopPolling()
        do {
            _ = try await perform("disconnect")
        } catch {
            errorMessage = message(for: error)
        }
    }

    public func sendPrompt(_ text: String) async {
        let text = text.trimmingCharacters(in: .whitespacesAndNewlines)
        let conversationID = conversationID.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !text.isEmpty else { return }
        guard !conversationID.isEmpty else {
            errorMessage = "请输入会话 ID 后再发送。"
            return
        }
        do {
            _ = try await perform(
                "prompt",
                parameters: [
                    "conversationId": .string(conversationID),
                    "text": .string(text),
                ]
            )
            errorMessage = nil
        } catch {
            errorMessage = message(for: error)
        }
    }

    private func exchangeOAuthCode(_ code: String) async {
        await runLoading { [self] in
            let response = try await perform(
                "exchangeToken",
                parameters: [
                    "code": .string(code),
                    "redirectUri": .string(redirectURI),
                    "state": .string(callbackState ?? ""),
                ]
            )
            isAuthenticated = true
            accountLabel = response.result.stringValue(path: ["user", "login"]) ?? "已登录"
            if let token = response.result.stringValue(key: "accessToken") {
                MobileKeychain.set(token, for: "account.token")
                MobileKeychain.set(accountOrigin, for: "account.origin")
            }
            try await refreshDevicesInternal()
        }
    }

    private func ensureLocalDevice() async throws -> String {
        if let localDeviceID { return localDeviceID }
        let response = try await perform(
            "registerDevice",
            parameters: [
                "installId": .string(installID),
                "name": .string(deviceName),
                "platform": .string(platform),
            ]
        )
        guard let id = response.result.stringValue(key: "deviceId") else {
            throw MobileSessionControllerError.message("无法注册本机设备。")
        }
        localDeviceID = id
        return id
    }

    private func refreshDevicesInternal() async throws {
        let response = try await perform("devices")
        let value: MobileJSONValue?
        if case .object(let object) = response.result, let nested = object["devices"] {
            value = nested
        } else {
            value = response.result
        }
        guard let value else {
            devices = []
            return
        }
        let data = try JSONEncoder().encode(value)
        devices = try JSONDecoder().decode([MobileDevice].self, from: data)
    }

    private func subscribeAndRequestSnapshot() async throws {
        let scope = "conversation:\(conversationID)"
        var parameters: [String: MobileJSONValue] = [
            "scopes": .array([.string(scope)]),
        ]
        if let cursor = state.wireCursors[scope] {
            parameters["since"] = .object([
                scope: .object([
                    "epoch": .string(cursor.epoch),
                    "seq": .number(Double(cursor.seq)),
                ])
            ])
        }
        _ = try await perform("subscribe", parameters: parameters)
        _ = try await perform(
            "snapshot",
            parameters: ["conversationId": .string(conversationID)]
        )
    }

    private func perform(
        _ action: String,
        parameters: [String: MobileJSONValue] = [:]
    ) async throws -> MobileCoreCommandResponse {
        let response = try await executor.command(action, parameters: parameters)
        if let newState = response.state {
            apply(newState)
        }
        guard response.ok else {
            throw MobileSessionControllerError.message(
                response.error?.message ?? "Rust runtime rejected the command。"
            )
        }
        return response
    }

    private func apply(_ newState: MobileSessionState) {
        state = newState
        bridge.store.apply(snapshot: newState)
    }

    private func runLoading(_ operation: @escaping @MainActor () async throws -> Void) async {
        isLoading = true
        errorMessage = nil
        do {
            try await operation()
        } catch {
            errorMessage = message(for: error)
        }
        isLoading = false
    }

    private func startPolling() {
        guard pollTask == nil else { return }
        pollTask = Task { [weak self] in
            while !Task.isCancelled {
                guard let self else { return }
                do {
                    _ = try await self.perform("poll")
                } catch {
                    if !Task.isCancelled {
                        self.errorMessage = self.message(for: error)
                    }
                    return
                }
                try? await Task.sleep(nanoseconds: 250_000_000)
            }
        }
    }

    private func stopPolling() {
        pollTask?.cancel()
        pollTask = nil
    }

    private func message(for error: Error) -> String {
        if let localized = error as? LocalizedError, let description = localized.errorDescription {
            return description
        }
        return error.localizedDescription
    }

    private static func loadInstallID() -> String {
        let key = "fastvibe.mobile.install-id"
        if let stored = UserDefaults.standard.string(forKey: key), !stored.isEmpty {
            return stored
        }
        let value = UUID().uuidString
        UserDefaults.standard.set(value, forKey: key)
        return value
    }
}

private actor MobileCoreCommandExecutor {
    private let bridge: MobileCoreBridge

    init(bridge: MobileCoreBridge) {
        self.bridge = bridge
    }

    func command(
        _ action: String,
        parameters: [String: MobileJSONValue]
    ) throws -> MobileCoreCommandResponse {
        try bridge.command(action, parameters: parameters)
    }
}

private extension Optional where Wrapped == MobileJSONValue {
    func stringValue(key: String) -> String? {
        stringValue(path: [key])
    }

    func stringValue(path: [String]) -> String? {
        guard case .some(.object(let object)) = self else { return nil }
        var current: MobileJSONValue? = .object(object)
        for key in path {
            guard case .object(let value) = current, let next = value[key] else { return nil }
            current = next
        }
        guard case .string(let value) = current else { return nil }
        return value
    }
}

private extension MobileJSONValue {
    var prettyDescription: String {
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.prettyPrinted, .sortedKeys]
        guard let data = try? encoder.encode(self),
              let string = String(data: data, encoding: .utf8)
        else { return "" }
        return string
    }
}

@MainActor
public struct FastVibeRootView: View {
    @StateObject private var session: MobileSessionController
    @Environment(\.openURL) private var openURL

    public init(session: MobileSessionController = MobileSessionController()) {
        _session = StateObject(wrappedValue: session)
    }

    public var body: some View {
        NavigationView {
            ScrollViewReader { proxy in
                ScrollView {
                    LazyVStack(alignment: .leading, spacing: 16) {
                        AccountSection(session: session)
                        DeviceSection(session: session)
                        TranscriptSection(session: session)
                    }
                    .padding()
                }
                .onReceive(session.$state) { _ in
                    guard let id = session.messages.last?.id else { return }
                    withAnimation { proxy.scrollTo(id, anchor: .bottom) }
                }
            }
            .safeAreaInset(edge: .bottom) {
                if session.isConnected {
                    Composer(session: session)
                }
            }
            .navigationTitle("FastVibe")
            .toolbar {
                ToolbarItem {
                    if session.isConnected {
                        Button("断开") { Task { await session.disconnect() } }
                    }
                }
            }
        }
        .onReceive(session.$loginURL) { url in
            guard let url else { return }
            openURL(url)
            session.clearLoginURL()
        }
        .alert(
            "FastVibe",
            isPresented: Binding(
                get: { session.errorMessage != nil },
                set: { if !$0 { session.clearError() } }
            ),
            presenting: session.errorMessage
        ) { _ in
            Button("好") { session.clearError() }
        } message: { message in
            Text(message)
        }
    }
}

private struct AccountSection: View {
    @ObservedObject var session: MobileSessionController

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack {
                VStack(alignment: .leading, spacing: 4) {
                    Text("远程工作区").font(.title2.bold())
                    Text(session.isAuthenticated ? (session.accountLabel ?? "已登录") : "登录 FastVibe 账号以查看电脑")
                        .font(.subheadline)
                        .foregroundStyle(.secondary)
                }
                Spacer()
                if session.isLoading { ProgressView() }
            }
            if !session.isAuthenticated {
                Button {
                    Task { await session.beginLogin() }
                } label: {
                    Label("登录账号", systemImage: "person.crop.circle.badge.plus")
                        .frame(maxWidth: .infinity)
                }
                .buttonStyle(.borderedProminent)
            }
            if session.state.connection != "disconnected" {
                Label("连接状态：\(session.statusText)", systemImage: "antenna.radiowaves.left.and.right")
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }
        }
        .padding()
        .background(.thinMaterial, in: RoundedRectangle(cornerRadius: 14))
    }
}

private struct DeviceSection: View {
    @ObservedObject var session: MobileSessionController

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack {
                Text("电脑").font(.headline)
                Spacer()
                if session.isAuthenticated {
                    Button("刷新") { Task { await session.refreshDevices() } }
                        .font(.subheadline)
                }
            }
            if session.isAuthenticated {
                TextField("会话 ID", text: $session.conversationID)
                    .textFieldStyle(.roundedBorder)
                    .autocorrectionDisabled()
                if session.devices.isEmpty {
                    Text("没有可用的电脑。")
                        .foregroundStyle(.secondary)
                        .frame(maxWidth: .infinity, alignment: .leading)
                } else {
                    LazyVStack(spacing: 8) {
                        ForEach(session.devices) { device in
                            Button {
                                Task { await session.connect(to: device) }
                            } label: {
                                DeviceRow(device: device, selected: session.selectedDevice?.id == device.id)
                            }
                            .buttonStyle(.plain)
                        }
                    }
                }
            }
        }
        .padding()
        .background(.thinMaterial, in: RoundedRectangle(cornerRadius: 14))
    }
}

private struct DeviceRow: View {
    let device: MobileDevice
    let selected: Bool

    var body: some View {
        HStack(spacing: 12) {
            Image(systemName: device.platform.lowercased().contains("mac") ? "desktopcomputer" : "laptopcomputer")
                .font(.title3)
                .foregroundColor(selected ? Color.accentColor : Color.secondary)
            VStack(alignment: .leading, spacing: 3) {
                Text(device.name).font(.body.weight(.medium))
                Text(device.online ? "在线 · \(device.platform)" : device.platform)
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }
            Spacer()
            Image(systemName: selected ? "checkmark.circle.fill" : "chevron.right")
                .foregroundColor(selected ? Color.accentColor : Color.gray)
        }
        .padding(12)
        .background(selected ? Color.accentColor.opacity(0.1) : Color.secondary.opacity(0.08), in: RoundedRectangle(cornerRadius: 10))
    }
}

private struct TranscriptSection: View {
    @ObservedObject var session: MobileSessionController

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack {
                Text("会话").font(.headline)
                Spacer()
                if session.state.running { ProgressView().controlSize(.small) }
            }
            if session.messages.isEmpty {
                Text(session.isConnected ? "等待会话快照或回复。" : "连接电脑后，消息会显示在这里。")
                    .foregroundStyle(.secondary)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .padding(.vertical, 24)
            } else {
                LazyVStack(alignment: .leading, spacing: 12) {
                    ForEach(session.messages) { message in
                        MessageView(message: message)
                            .id(message.id)
                    }
                }
            }
        }
    }
}

private struct MessageView: View {
    let message: MobileMessage

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            Text(label)
                .font(.caption.bold())
                .foregroundColor(message.role == .user ? Color.accentColor : Color.secondary)
            if let parts = message.parts, !parts.isEmpty {
                ForEach(Array(parts.enumerated()), id: \.offset) { _, part in
                    MessagePartView(part: part, tools: message.tools)
                }
            } else if !message.text.isEmpty {
                Text(message.text)
                    .textSelection(.enabled)
            }
            if let error = message.error, !error.isEmpty {
                Label(error, systemImage: "exclamationmark.triangle")
                    .font(.caption)
                    .foregroundStyle(.red)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(12)
        .background(message.role == .user ? Color.accentColor.opacity(0.1) : Color.secondary.opacity(0.08), in: RoundedRectangle(cornerRadius: 12))
    }

    private var label: String {
        switch message.role {
        case .user: return "你"
        case .tool: return "工具"
        case .system: return "系统"
        case .assistant: return "FastVibe"
        }
    }
}

private struct MessagePartView: View {
    let part: MobileMessagePart
    let tools: [MobileToolCall]

    var body: some View {
        switch part {
        case .text(let text):
            Text(text).textSelection(.enabled)
        case .thinking(let text, _, _):
            VStack(alignment: .leading, spacing: 4) {
                Label("思考", systemImage: "lightbulb")
                    .font(.caption.bold())
                    .foregroundStyle(.secondary)
                Text(text)
                    .font(.system(.subheadline, design: .rounded))
                    .foregroundStyle(.secondary)
                    .textSelection(.enabled)
            }
        case .tool(let toolID):
            if let tool = tools.first(where: { $0.id == toolID }) {
                ToolCallView(tool: tool)
            } else {
                Label("工具 \(toolID)", systemImage: "hammer")
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }
        case .model(let from, let to):
            HStack(spacing: 8) {
                Image(systemName: "cpu")
                Text(from.map { "\($0.provider)/\($0.model) → " } ?? "模型 → ")
                Text("\(to.provider)/\(to.model)").bold()
            }
            .font(.caption)
            .foregroundStyle(.secondary)
            .padding(.vertical, 4)
        case .compact(let text, let info):
            VStack(alignment: .leading, spacing: 4) {
                Label("上下文压缩", systemImage: "arrow.down.right.and.arrow.up.left")
                    .font(.caption.bold())
                Text(text).font(.caption).textSelection(.enabled)
                if let info {
                    Text(info.status + (info.reason.map { " · \($0)" } ?? ""))
                        .font(.caption2)
                        .foregroundStyle(.secondary)
                }
            }
            .padding(8)
            .background(Color.secondary.opacity(0.1), in: RoundedRectangle(cornerRadius: 8))
        }
    }
}

private struct ToolCallView: View {
    let tool: MobileToolCall

    var body: some View {
        VStack(alignment: .leading, spacing: 7) {
            HStack {
                Label(tool.name, systemImage: "hammer")
                    .font(.subheadline.bold())
                Spacer()
                Text(tool.status)
                    .font(.caption)
                    .foregroundStyle(tool.status == "error" ? .red : .secondary)
            }
            ToolValue(title: "参数", value: tool.args)
            if let result = tool.result, !result.isEmpty {
                Text("结果")
                    .font(.caption.bold())
                    .foregroundStyle(.secondary)
                Text(result)
                    .font(.system(.caption, design: .monospaced))
                    .textSelection(.enabled)
                    .frame(maxWidth: .infinity, alignment: .leading)
            }
            ToolValue(title: "详情", value: tool.details)
            ToolValue(title: "省略", value: tool.omitted)
        }
        .padding(10)
        .background(Color.secondary.opacity(0.08), in: RoundedRectangle(cornerRadius: 9))
    }
}

private struct ToolValue: View {
    let title: String
    let value: MobileJSONValue?

    var body: some View {
        if let value {
            VStack(alignment: .leading, spacing: 3) {
                Text(title).font(.caption.bold()).foregroundStyle(.secondary)
                Text(value.prettyDescription)
                    .font(.system(.caption2, design: .monospaced))
                    .textSelection(.enabled)
                    .frame(maxWidth: .infinity, alignment: .leading)
            }
        }
    }
}

private struct Composer: View {
    @ObservedObject var session: MobileSessionController
    @State private var draft = ""

    var body: some View {
        HStack(alignment: .bottom, spacing: 8) {
            TextField("发送消息", text: $draft)
                .textFieldStyle(.roundedBorder)
            Button {
                let text = draft
                draft = ""
                Task { await session.sendPrompt(text) }
            } label: {
                Image(systemName: "arrow.up.circle.fill")
                    .font(.title2)
            }
            .disabled(draft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || session.isLoading)
        }
        .padding(.horizontal)
        .padding(.vertical, 8)
        .background(.bar)
    }
}
