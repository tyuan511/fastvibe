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

    static func remove(_ key: String) {
        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: key,
        ]
        SecItemDelete(query as CFDictionary)
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
    @Published private(set) var conversations: [NativeConversation] = []
    @Published private(set) var projects: [NativeProject] = []
    @Published public private(set) var isSending = false

    public let accountOrigin: String
    public let redirectURI = "fastvibe://oauth/callback"

    public var endpointIdentifier: String? { endpointID ?? state.endpointId }
    public var coreVersion: String? {
        guard let raw = bridge.version, !raw.isEmpty else { return nil }
        guard let data = raw.data(using: .utf8),
              let object = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              let version = object["version"] as? String,
              !version.isEmpty
        else { return raw }
        return version
    }
    public var connectionPath: String? { state.path }
    public var accountEmail: String? { accountEmailValue }
    public var localDeviceName: String {
        get { deviceName }
        set {
            deviceName = newValue
            UserDefaults.standard.set(newValue, forKey: Self.deviceNameKey)
        }
    }

    private static let deviceNameKey = "fastvibe.mobile.device-name"
    private let bridge: MobileCoreBridge
    private let coordinator: MobileCoreCommandCoordinator
    private let platform: String
    private let installID: String
    private var deviceName: String
    private var localDeviceID: String?
    private var endpointID: String?
    private var accountEmailValue: String?
    private var loginState: String?
    private var callbackState: String?
    private var pollTask: Task<Void, Never>?
    private var resyncTask: Task<Void, Never>?
    private var connectionGeneration: UInt64 = 0
    private var conversationGeneration: UInt64 = 0

    public init(
        bridge: MobileCoreBridge = MobileCoreBridge(),
        accountOrigin: String = "https://app.fastvibe.dev",
        deviceName: String = "FastVibe Mobile",
        platform: String = "ios",
        conversationID: String = "",
        commandRuntime: (any MobileCoreCommanding)? = nil
    ) {
        self.bridge = bridge
        self.accountOrigin = accountOrigin.trimmingCharacters(in: CharacterSet(charactersIn: "/"))
        self.platform = platform
        self.conversationID = conversationID
        self.installID = Self.loadInstallID()
        self.deviceName = UserDefaults.standard.string(forKey: Self.deviceNameKey) ?? deviceName
        let executor = MobileCoreCommandExecutor(bridge: bridge)
        self.coordinator = MobileCoreCommandCoordinator(runtime: commandRuntime ?? executor)
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
                do {
                    _ = try await self.perform("setToken", parameters: [
                        "token": .string(savedToken),
                        "origin": .string(savedOrigin),
                    ])
                    self.isAuthenticated = true
                    self.accountLabel = "已登录"
                    try await self.refreshDevicesInternal()
                } catch {
                    self.errorMessage = self.message(for: error)
                }
            }
        }
    }

    deinit {
        pollTask?.cancel()
        resyncTask?.cancel()
    }

    public var messages: [MobileMessage] { state.messages }
    public var isConnected: Bool { state.connection == "ready" }
    public var statusText: String { state.connection.capitalized }

    public func beginLogin() async {
        await runLoading { [self] in
            let response = try await perform(
                "loginUrl",
                parameters: [
                    "origin": .string(accountOrigin),
                    "redirectUri": .string(redirectURI),
                    "deviceName": .string(localDeviceName),
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

        var values: [String: String] = [:]
        for item in URLComponents(url: url, resolvingAgainstBaseURL: false)?.queryItems ?? [] {
            guard values[item.name] == nil else {
                errorMessage = MobileSessionControllerError.invalidLoginCallback.localizedDescription
                loginState = nil
                return
            }
            values[item.name] = item.value ?? ""
        }
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

    public func clearLoginURL() { loginURL = nil }
    public func clearError() { errorMessage = nil }

    /// Inject an already-issued account token. The token remains in Rust memory and is never
    /// persisted or exposed to SwiftUI. This is useful when the host app owns secure storage.
    public func injectToken(_ token: String, origin: String? = nil) async {
        guard !token.isEmpty else {
            errorMessage = "登录令牌为空。"
            return
        }
        await runLoading { [self] in
            let issuer = origin ?? accountOrigin
            _ = try await perform(
                "setToken",
                parameters: [
                    "token": .string(token),
                    "origin": .string(issuer),
                ]
            )
            MobileKeychain.set(token, for: "account.token")
            MobileKeychain.set(issuer, for: "account.origin")
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

        connectionGeneration &+= 1
        let generation = connectionGeneration
        selectedDevice = device
        conversationID = ""
        conversations = []
        projects = []
        stopPolling()
        resyncTask?.cancel()
        resyncTask = nil
        await coordinator.failPending(message: "连接正在重新建立，草稿已保留。")
        guard generation == connectionGeneration else { return }
        defer { if generation == connectionGeneration { isLoading = false } }
        isLoading = true
        isSending = false
        errorMessage = nil

        do {
            try await perform("disconnect")
            guard generation == connectionGeneration else { return }
            let identity = try await perform("identity")
            guard generation == connectionGeneration else { return }
            guard let localEndpointID = identity.result.stringValue(key: "endpointId") else {
                throw MobileSessionControllerError.message("无法创建本机连接身份。")
            }
            if let secretKey = identity.result.stringValue(key: "secretKey") {
                MobileKeychain.set(secretKey, for: "iroh.identity")
            }
            endpointID = localEndpointID

            let localID = try await ensureLocalDevice()
            guard generation == connectionGeneration else { return }
            _ = try await perform(
                "registerEndpoint",
                parameters: [
                    "deviceId": .string(localID),
                    "endpointId": .string(localEndpointID),
                ]
            )
            guard generation == connectionGeneration else { return }
            let relay = try await perform(
                "relay",
                parameters: [
                    "deviceId": .string(device.id),
                    "endpointId": .string(localEndpointID),
                ]
            )
            guard generation == connectionGeneration else { return }
            guard let relayURL = relay.result.stringValue(key: "url"),
                  let relayToken = relay.result.stringValue(key: "token")
            else {
                throw MobileSessionControllerError.missingRelayConfiguration
            }

            _ = try await perform(
                "connect",
                parameters: [
                    "remoteId": .string(remoteEndpointID),
                    "relay": .object([
                        "url": .string(relayURL),
                        "token": .string(relayToken),
                    ]),
                ]
            )
            guard generation == connectionGeneration else { return }
            startPolling(generation: generation)
            guard await waitUntilReady(generation: generation) else { return }
            try await initializeReadyConnection()
            guard generation == connectionGeneration else { return }
            isLoading = false
        } catch is CancellationError {
            if generation == connectionGeneration { isLoading = false }
        } catch {
            guard generation == connectionGeneration else { return }
            isLoading = false
            errorMessage = message(for: error)
            state.connection = "error"
            state.error = errorMessage
            await coordinator.failPending(message: errorMessage ?? "连接失败。")
        }
    }

    public func disconnect() async {
        connectionGeneration &+= 1
        conversationGeneration &+= 1
        isLoading = false
        isSending = false
        stopPolling()
        resyncTask?.cancel()
        resyncTask = nil
        await coordinator.failPending(message: "连接已断开，草稿已保留。")
        do {
            _ = try await perform("disconnect")
        } catch {
            errorMessage = message(for: error)
        }
    }

    public func refreshConversations() async {
        guard isConnected else { return }
        await runLoading { [self] in
            try await refreshConversationsInternal()
        }
    }

    public func openConversation(_ id: String) async -> Bool {
        let id = id.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !id.isEmpty, isConnected else { return false }
        conversationGeneration &+= 1
        let generation = conversationGeneration
        conversationID = id
        do {
            _ = try await performRemote(
                "openConversation",
                parameters: ["id": .string(id), "activate": .bool(false)]
            )
            guard generation == conversationGeneration else { return false }
            _ = try await performRemote(
                "snapshot",
                parameters: ["conversationId": .string(id), "historyLimit": .number(12)]
            )
            guard generation == conversationGeneration else { return false }
            return true
        } catch {
            guard generation == conversationGeneration else { return false }
            errorMessage = message(for: error)
            return false
        }
    }

    public func createConversation(projectPath: String?) async -> Bool {
        guard isConnected else { return false }
        var parameters: [String: MobileJSONValue] = [
            "activate": .bool(false),
            "reuseEmpty": .bool(false),
        ]
        if let projectPath, !projectPath.isEmpty {
            parameters["project"] = .string(projectPath)
        }
        do {
            let response = try await performRemote("createConversation", parameters: parameters)
            let id = response.result.stringValue(path: ["conversation", "id"])
                ?? response.result.stringValue(key: "id")
                ?? response.result.stringValue(key: "conversationId")
            guard let id else {
                throw MobileSessionControllerError.message("电脑没有返回新会话标识。")
            }
            try await refreshConversationsInternal()
            return await openConversation(id)
        } catch {
            errorMessage = message(for: error)
            return false
        }
    }

    public func sendPrompt(_ text: String) async -> Bool {
        let text = text.trimmingCharacters(in: .whitespacesAndNewlines)
        let id = conversationID.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !text.isEmpty, !id.isEmpty, isConnected, !isSending else { return false }
        isSending = true
        defer { isSending = false }
        let enqueue = state.running || !(state.snapshot?.queue.items.isEmpty ?? true)
        do {
            _ = try await performRemote(
                "prompt",
                parameters: [
                    "conversationId": .string(id),
                    "text": .string(text),
                    "enqueue": .bool(enqueue),
                    "images": .array([]),
                    "idempotencyKey": .string(UUID().uuidString),
                ]
            )
            errorMessage = nil
            return true
        } catch {
            errorMessage = message(for: error)
            return false
        }
    }

    public func abort() async {
        guard let id = nonEmptyConversationID else { return }
        do {
            _ = try await performRemote(
                "abort",
                parameters: ["conversationId": .string(id)]
            )
        } catch {
            errorMessage = message(for: error)
        }
    }

    public func loadOlderMessages() async {
        guard let id = nonEmptyConversationID,
              let before = state.snapshot?.historyBeforeEntryId,
              !before.isEmpty,
              !state.loadingHistory
        else { return }
        do {
            let response = try await performRemote(
                "getMessagesPage",
                parameters: [
                    "conversationId": .string(id),
                    "beforeEntryId": .string(before),
                    "turnLimit": .number(12),
                ]
            )
            if response.result?.objectValue?.boolValue("reset") == true, conversationID == id {
                _ = try await performRemote("snapshot", parameters: [
                    "conversationId": .string(id),
                    "historyLimit": .number(12),
                ])
            }
        } catch {
            errorMessage = message(for: error)
        }
    }

    public func removeQueuedMessage(_ id: String) async {
        guard let conversationID = nonEmptyConversationID, !id.isEmpty else { return }
        do {
            _ = try await performRemote(
                "call",
                parameters: [
                    "method": .string("engine:queue-cancel"),
                    "payload": .object([
                        "conversationId": .string(conversationID),
                        "id": .string(id),
                    ]),
                ]
            )
        } catch {
            errorMessage = message(for: error)
        }
    }

    public func respondToPermission(_ request: MobileJSONValue, response: MobileJSONValue) async {
        guard let requestObject = request.objectValue,
              let requestID = requestObject["id"]?.stringValue,
              let conversationID = nonEmptyConversationID
        else { return }
        var payload: [String: MobileJSONValue] = [
            "id": .string(requestID),
            "conversationId": .string(conversationID),
        ]
        if let responseObject = response.objectValue {
            for key in ["confirmed", "value", "cancelled", "answers"] {
                if let value = responseObject[key] { payload[key] = value }
            }
        }
        do {
            _ = try await performRemote(
                "call",
                parameters: [
                    "method": .string("engine:permission-respond"),
                    "payload": .object(payload),
                ]
            )
        } catch {
            errorMessage = message(for: error)
        }
    }

    public func signOut() async {
        connectionGeneration &+= 1
        stopPolling()
        resyncTask?.cancel()
        resyncTask = nil
        await coordinator.failPending(message: "已退出登录，草稿已保留。")
        _ = try? await perform("disconnect")
        MobileKeychain.remove("account.token")
        MobileKeychain.remove("account.origin")
        isAuthenticated = false
        accountLabel = nil
        accountEmailValue = nil
        selectedDevice = nil
        devices = []
        conversations = []
        projects = []
        conversationID = ""
        loginURL = nil
        loginState = nil
        callbackState = nil
        localDeviceID = nil
        isLoading = false
        isSending = false
        errorMessage = nil
        state = MobileSessionState()
        bridge.store.apply(snapshot: state)
    }

    private var nonEmptyConversationID: String? {
        let id = conversationID.trimmingCharacters(in: .whitespacesAndNewlines)
        return id.isEmpty ? nil : id
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
            accountEmailValue = response.result.stringValue(path: ["user", "email"])
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
                "name": .string(localDeviceName),
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

    private func initializeReadyConnection() async throws {
        _ = try await performRemote("subscribe", parameters: [
            "scopes": .array([.string("*")]),
        ])
        try await refreshConversationsInternal()
    }

    private func refreshConversationsInternal() async throws {
        let response = try await performRemote("listConversations")
        if response.result != nil {
            applyWorkspace(response.result)
        }
    }

    private func subscribeAndRequestSnapshot() async throws {
        guard let id = nonEmptyConversationID else { return }
        var parameters: [String: MobileJSONValue] = [
            "scopes": .array([.string("conversation:\(id)")]),
        ]
        if let cursor = state.wireCursors["conversation:\(id)"] {
            parameters["since"] = .object([
                "conversation:\(id)": .object([
                    "epoch": .string(cursor.epoch),
                    "seq": .number(Double(cursor.seq)),
                ])
            ])
        }
        _ = try await performRemote("subscribe", parameters: parameters)
        _ = try await performRemote("snapshot", parameters: [
            "conversationId": .string(id),
            "historyLimit": .number(12),
        ])
    }

    private func perform(
        _ action: String,
        parameters: [String: MobileJSONValue] = [:]
    ) async throws -> MobileCoreCommandResponse {
        let generation = connectionGeneration
        let ticket = try await coordinator.start(action, parameters: parameters)
        guard generation == connectionGeneration else { throw CancellationError() }
        if let newState = ticket.initial.state { apply(newState) }
        return ticket.initial
    }

    private func performRemote(
        _ action: String,
        parameters: [String: MobileJSONValue] = [:]
    ) async throws -> MobileCoreCommandResponse {
        let generation = connectionGeneration
        let ticket = try await coordinator.start(action, parameters: parameters)
        guard generation == connectionGeneration else { throw CancellationError() }
        if let newState = ticket.initial.state { apply(newState) }
        guard let requestID = ticket.requestID else { return ticket.initial }
        let response = try await coordinator.awaitResult(requestID)
        guard generation == connectionGeneration else { throw CancellationError() }
        // Poll applies Rust's projection. Never reconstruct or merge protocol content in Swift.
        return response
    }

    private func apply(_ newState: MobileSessionState) {
        state = newState
        bridge.store.apply(snapshot: newState)
        endpointID = newState.endpointId ?? endpointID
        if let error = newState.error, !error.isEmpty { errorMessage = error }
        if let workspace = newState.workspace { applyWorkspace(workspace) }
    }

    private func startPolling(generation: UInt64) {
        guard pollTask == nil else { return }
        pollTask = Task { [weak self] in
            while !Task.isCancelled {
                guard let self, self.connectionGeneration == generation else { return }
                do {
                    let poll = try await self.coordinator.poll()
                    guard self.connectionGeneration == generation else { return }
                    await self.applyPoll(poll)
                } catch {
                    guard !Task.isCancelled, self.connectionGeneration == generation else { return }
                    self.state.connection = "error"
                    self.state.error = self.message(for: error)
                    self.errorMessage = self.message(for: error)
                    await self.coordinator.failPending(message: self.errorMessage ?? "连接已断开。")
                    return
                }
                try? await Task.sleep(for: .milliseconds(250))
            }
        }
    }

    private func applyPoll(_ poll: MobileCorePoll) async {
        let oldConnection = state.connection
        if let newState = poll.response.state { apply(newState) }
        var connectionFailure: String?
        for event in poll.events {
            switch event.kind {
            case "resync":
                scheduleResync()
            case "connection_error", "remote_close":
                connectionFailure = event.string("message") ?? event.string("reason") ?? state.error ?? "与电脑的连接已断开。"
            default:
                break
            }
        }
        if (state.connection == "error" || state.connection == "disconnected"), state.connection != oldConnection {
            connectionFailure = connectionFailure ?? state.error ?? "与电脑的连接已中断。操作可能已经到达电脑，草稿已保留。"
        }
        if let failure = connectionFailure {
            errorMessage = failure
            await coordinator.failPending(message: failure)
        }
        if poll.overflowed { scheduleResync() }
    }

    private func scheduleResync() {
        guard resyncTask == nil, isConnected else { return }
        resyncTask = Task { [weak self] in
            guard let self else { return }
            defer { resyncTask = nil }
            do {
                try await subscribeAndRequestSnapshot()
                try await refreshConversationsInternal()
            } catch {
                errorMessage = message(for: error)
            }
        }
    }

    private func waitUntilReady(generation: UInt64) async -> Bool {
        let deadline = Date().addingTimeInterval(15)
        while generation == connectionGeneration, Date() < deadline {
            if state.connection == "ready" { return true }
            if state.connection == "error" || state.connection == "disconnected" {
                errorMessage = state.error ?? "无法连接这台电脑。"
                return false
            }
            try? await Task.sleep(for: .milliseconds(50))
        }
        guard generation == connectionGeneration else { return false }
        if state.connection != "ready" {
            errorMessage = "连接电脑超时，请重试。"
            return false
        }
        return true
    }

    private func stopPolling() {
        pollTask?.cancel()
        pollTask = nil
    }

    private func applyWorkspace(_ raw: MobileJSONValue?) {
        guard let root = raw?.objectValue else { return }
        let workspace = root["workspace"]?.objectValue
            ?? root["catalog"]?.objectValue
            ?? root
        let directConversations = (workspace["conversations"] ?? workspace["items"] ?? workspace["results"])?.arrayValue ?? []
        let directProjects = (workspace["projects"] ?? workspace["groups"])?.arrayValue ?? []

        var parsedProjects: [NativeProject] = []
        var nestedConversations: [MobileJSONValue] = []
        for (index, value) in directProjects.enumerated() {
            guard let object = value.objectValue else { continue }
            guard let path = object.stringValue("cwd", "path") else { continue }
            let id = object.stringValue("id", "projectId") ?? path
            let name = object.stringValue("name", "title", "label")
                ?? path.split(separator: "/").last.map(String.init)
                ?? id
            parsedProjects.append(NativeProject(id: id, name: name, path: path))
            nestedConversations += (object["conversations"] ?? object["items"])?.arrayValue ?? []
        }

        var allConversations = directConversations
        if allConversations.isEmpty { allConversations = nestedConversations }
        var parsedConversations: [NativeConversation] = []
        var projectNames: [String: String] = [:]
        var projectPaths: [String: String] = [:]
        for project in parsedProjects {
            projectNames[project.id] = project.name
            projectPaths[project.id] = project.path
            projectNames[project.path] = project.name
            projectPaths[project.path] = project.path
        }
        for (index, value) in allConversations.enumerated() {
            guard let object = value.objectValue,
                  let id = object.stringValue("id", "conversationId", "conversation_id")
            else { continue }
            let projectValue = object["project"]
            let projectObject = projectValue?.objectValue
            let projectID = object.stringValue("project", "projectId", "project_id")
                ?? projectObject?.stringValue("id", "cwd")
                ?? projectValue?.stringValue
            let projectName = object.stringValue("projectName", "project_name")
                ?? projectObject?.stringValue("name", "title")
                ?? projectID.flatMap { projectNames[$0] }
            let projectPath = projectObject?.stringValue("cwd", "path")
                ?? projectID.flatMap { projectPaths[$0] }
            if let projectID, let projectName { projectNames[projectID] = projectName }
            if let projectID, let projectPath { projectPaths[projectID] = projectPath }
            let lastMessage = object["lastMessage"]?.objectValue ?? object["last_message"]?.objectValue
            let preview = object.stringValue("preview", "subtitle", "lastText", "last_text")
                ?? lastMessage?.stringValue("text", "content")
                ?? ""
            parsedConversations.append(NativeConversation(
                id: id,
                title: object.stringValue("title", "name") ?? "未命名会话",
                preview: preview,
                projectName: projectName ?? "未归属项目",
                projectPath: projectPath,
                updatedAt: dateValue(object["updatedAt"] ?? object["updated_at"] ?? object["lastActivityAt"] ?? object["last_activity_at"] ?? object["createdAt"] ?? object["created_at"]) ?? Date.distantPast,
                running: object.boolValue("running", "isRunning") ?? false,
                waiting: object.boolValue("waiting", "pending", "needsInput", "needs_input") ?? false,
                unread: object.boolValue("unread", "hasUnread") ?? false,
                archived: object.boolValue("archived", "isArchived") ?? false
            ))
        }
        conversations = parsedConversations
        projects = parsedProjects
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

private extension Optional where Wrapped == MobileJSONValue {
    func stringValue(key: String) -> String? { stringValue(path: [key]) }

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
    var objectValue: [String: MobileJSONValue]? {
        guard case .object(let value) = self else { return nil }
        return value
    }

    var arrayValue: [MobileJSONValue]? {
        guard case .array(let value) = self else { return nil }
        return value
    }

    var stringValue: String? {
        guard case .string(let value) = self else { return nil }
        return value
    }

}

private extension Dictionary where Key == String, Value == MobileJSONValue {
    func stringValue(_ keys: String...) -> String? {
        for key in keys {
            if let value = self[key]?.stringValue, !value.isEmpty { return value }
        }
        return nil
    }

    func boolValue(_ keys: String...) -> Bool? {
        for key in keys {
            if case .bool(let value) = self[key] { return value }
            if case .string(let value) = self[key] {
                if value.lowercased() == "true" { return true }
                if value.lowercased() == "false" { return false }
            }
        }
        return nil
    }
}

private func dateValue(_ value: MobileJSONValue?) -> Date? {
    switch value {
    case .number(let milliseconds):
        return Date(timeIntervalSince1970: milliseconds / 1000)
    case .string(let string):
        if let milliseconds = Double(string) { return Date(timeIntervalSince1970: milliseconds / 1000) }
        return ISO8601DateFormatter().date(from: string)
    default:
        return nil
    }
}
