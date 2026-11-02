import Foundation

/// The asynchronous boundary around the Rust command handle.
///
/// The production implementation serializes access to the FFI handle in an actor. Tests can
/// inject a fake implementation and drive the same request/poll lifecycle without a native
/// XCFramework.
public protocol MobileCoreCommanding: Sendable {
    func command(
        _ action: String,
        parameters: [String: MobileJSONValue]
    ) async throws -> MobileCoreCommandResponse
}

public actor MobileCoreCommandExecutor: MobileCoreCommanding {
    private let bridge: MobileCoreBridge

    public init(bridge: MobileCoreBridge) {
        self.bridge = bridge
    }

    public func command(
        _ action: String,
        parameters: [String: MobileJSONValue] = [:]
    ) throws -> MobileCoreCommandResponse {
        try bridge.command(action, parameters: parameters)
    }
}

public struct MobileCoreCommandFailure: LocalizedError, Equatable, Sendable {
    public let code: String?
    public let message: String

    public init(code: String? = nil, message: String) {
        self.code = code
        self.message = message
    }

    public var errorDescription: String? { message }
}

public struct MobileCoreCommandTicket: Sendable {
    public let initial: MobileCoreCommandResponse
    public let requestID: UInt64?

    public init(initial: MobileCoreCommandResponse, requestID: UInt64?) {
        self.initial = initial
        self.requestID = requestID
    }
}

public struct MobileCoreProtocolEvent: Sendable, Equatable {
    public let kind: String?
    public let requestID: UInt64?
    public let value: [String: MobileJSONValue]

    public init(
        kind: String?,
        requestID: UInt64? = nil,
        value: [String: MobileJSONValue]
    ) {
        self.kind = kind
        self.requestID = requestID
        self.value = value
    }

    public func string(_ key: String) -> String? {
        guard case .string(let value) = value[key] else { return nil }
        return value
    }

    public func bool(_ key: String) -> Bool? {
        guard case .bool(let value) = value[key] else { return nil }
        return value
    }
}

public struct MobileCorePoll: Sendable {
    public let response: MobileCoreCommandResponse
    public let events: [MobileCoreProtocolEvent]
    public let overflowed: Bool

    public init(
        response: MobileCoreCommandResponse,
        events: [MobileCoreProtocolEvent],
        overflowed: Bool
    ) {
        self.response = response
        self.events = events
        self.overflowed = overflowed
    }
}

/// Coordinates command acknowledgements with the rpcResult events returned by `poll`.
///
/// Rust remains the protocol reducer. This actor only pairs a local request id with its eventual
/// result, buffers a result that races registration, and settles waiters on timeout or disconnect.
public actor MobileCoreCommandCoordinator {
    private let runtime: any MobileCoreCommanding
    private let timeout: Duration
    private let maxBufferedResults: Int
    private var waiters: [UInt64: CheckedContinuation<MobileCoreCommandResponse, Error>] = [:]
    private var timeoutTasks: [UInt64: Task<Void, Never>] = [:]
    private var bufferedResults: [UInt64: MobileCoreCommandResponse] = [:]
    private var requestedIDs: Set<UInt64> = []
    private var generation: UInt64 = 0

    public init(
        runtime: any MobileCoreCommanding,
        timeout: Duration = .seconds(60),
        maxBufferedResults: Int = 64
    ) {
        self.runtime = runtime
        self.timeout = timeout
        self.maxBufferedResults = max(1, maxBufferedResults)
    }

    public func start(
        _ action: String,
        parameters: [String: MobileJSONValue] = [:]
    ) async throws -> MobileCoreCommandTicket {
        let currentGeneration = generation
        let response = try await runtime.command(action, parameters: parameters)
        guard currentGeneration == generation else { throw CancellationError() }
        guard response.ok else { throw Self.failure(for: response) }
        let requestID = Self.requestID(from: response.result)
        if let requestID { requestedIDs.insert(requestID) }
        return MobileCoreCommandTicket(initial: response, requestID: requestID)
    }

    public func awaitResult(_ requestID: UInt64) async throws -> MobileCoreCommandResponse {
        defer { requestedIDs.remove(requestID) }
        if let buffered = bufferedResults.removeValue(forKey: requestID) {
            try validate(buffered)
            return buffered
        }
        if Task.isCancelled { throw CancellationError() }

        let response = try await withTaskCancellationHandler(operation: {
            try await withCheckedThrowingContinuation { (continuation: CheckedContinuation<MobileCoreCommandResponse, Error>) in
                waiters[requestID] = continuation
                let timeout = timeout
                timeoutTasks[requestID] = Task { [weak self] in
                    do {
                        try await Task.sleep(for: timeout)
                    } catch {
                        return
                    }
                    await self?.timeout(requestID)
                }
            }
        }, onCancel: {
            Task { await self.cancel(requestID) }
        })
        try validate(response)
        return response
    }

    public func poll() async throws -> MobileCorePoll {
        let response = try await runtime.command("poll", parameters: [:])
        guard response.ok else { throw Self.failure(for: response) }

        var events: [MobileCoreProtocolEvent] = []
        var overflowed = false
        if case .object(let result) = response.result {
            if case .bool(let value) = result["overflowed"] { overflowed = value }
            if case .array(let rawEvents) = result["events"] {
                for rawEvent in rawEvents {
                    guard case .object(let value) = rawEvent else { continue }
                    let kind = Self.string(from: value["kind"]) ?? Self.string(from: value["type"])
                    let requestID = Self.requestID(from: .object(value))
                    let event = MobileCoreProtocolEvent(kind: kind, requestID: requestID, value: value)
                    events.append(event)
                    if kind == "rpcResult", let requestID {
                        let result = value["result"]
                        let error = Self.commandError(from: value["error"])
                        let rpc = MobileCoreCommandResponse(
                            ok: Self.bool(from: value["ok"]) ?? false,
                            action: Self.string(from: value["action"]) ?? "",
                            result: result,
                            state: response.state,
                            error: error
                        )
                        complete(requestID, with: rpc)
                    }
                }
            }
        }
        return MobileCorePoll(response: response, events: events, overflowed: overflowed)
    }

    public func failPending(message: String, code: String? = "mobile.disconnected") {
        generation &+= 1
        let failure = MobileCoreCommandFailure(code: code, message: message)
        let pending = waiters
        waiters.removeAll()
        timeoutTasks.values.forEach { $0.cancel() }
        timeoutTasks.removeAll()
        bufferedResults.removeAll()
        // A disconnect can overtake the caller between start() and awaitResult(). Keep its
        // failure too, so that caller does not park until timeout after the connection is gone.
        for id in requestedIDs where pending[id] == nil {
            bufferedResults[id] = MobileCoreCommandResponse(
                ok: false,
                action: "",
                error: MobileCoreCommandError(code: code, message: message)
            )
        }
        for continuation in pending.values {
            continuation.resume(throwing: failure)
        }
    }

    private func complete(_ requestID: UInt64, with response: MobileCoreCommandResponse) {
        if let continuation = waiters.removeValue(forKey: requestID) {
            timeoutTasks.removeValue(forKey: requestID)?.cancel()
            continuation.resume(returning: response)
            return
        }
        bufferedResults[requestID] = response
        while bufferedResults.count > maxBufferedResults {
            bufferedResults.removeValue(forKey: bufferedResults.keys.first!)
        }
    }

    private func timeout(_ requestID: UInt64) {
        guard let continuation = waiters.removeValue(forKey: requestID) else { return }
        timeoutTasks.removeValue(forKey: requestID)?.cancel()
        continuation.resume(throwing: MobileCoreCommandFailure(
            code: "mobile.timeout",
            message: "远程请求超时，请重试。"
        ))
    }

    private func cancel(_ requestID: UInt64) {
        guard let continuation = waiters.removeValue(forKey: requestID) else { return }
        timeoutTasks.removeValue(forKey: requestID)?.cancel()
        continuation.resume(throwing: CancellationError())
    }

    private func validate(_ response: MobileCoreCommandResponse) throws {
        guard response.ok else { throw Self.failure(for: response) }
    }

    private static func failure(for response: MobileCoreCommandResponse) -> MobileCoreCommandFailure {
        MobileCoreCommandFailure(
            code: response.error?.code,
            message: response.error?.message ?? "Rust runtime rejected the command。"
        )
    }

    private static func requestID(from value: MobileJSONValue?) -> UInt64? {
        guard case .object(let object) = value else { return nil }
        let raw = object["requestId"] ?? object["request_id"]
        guard case .number(let number) = raw,
              number > 0,
              number.rounded() == number,
              number < Double(UInt64.max)
        else { return nil }
        return UInt64(number)
    }

    private static func string(from value: MobileJSONValue?) -> String? {
        guard case .string(let value) = value else { return nil }
        return value
    }

    private static func bool(from value: MobileJSONValue?) -> Bool? {
        guard case .bool(let value) = value else { return nil }
        return value
    }

    private static func commandError(from value: MobileJSONValue?) -> MobileCoreCommandError? {
        guard case .object(let object) = value else { return nil }
        return MobileCoreCommandError(
            code: string(from: object["code"]),
            message: string(from: object["message"]) ?? string(from: object["detail"])
        )
    }
}
