import Foundation

#if canImport(FastVibeMobileCoreFFI)
import FastVibeMobileCoreFFI
#endif

/// The response envelope returned by one command sent to the Rust runtime.
public struct MobileCoreCommandResponse: Codable, Sendable {
    public let ok: Bool
    public let action: String
    public let result: MobileJSONValue?
    public let state: MobileSessionState?
    public let error: MobileCoreCommandError?

    public init(
        ok: Bool,
        action: String,
        result: MobileJSONValue? = nil,
        state: MobileSessionState? = nil,
        error: MobileCoreCommandError? = nil
    ) {
        self.ok = ok
        self.action = action
        self.result = result
        self.state = state
        self.error = error
    }
}

public struct MobileCoreCommandError: Codable, Sendable {
    public let code: String?
    public let message: String?

    public init(code: String? = nil, message: String? = nil) {
        self.code = code
        self.message = message
    }
}

/// Swift owns no App Protocol reducer. It sends JSON commands to the Rust
/// runtime and observes the bounded MobileState projection returned by Rust.
public final class MobileCoreBridge: @unchecked Sendable {
    public let store: MobileCoreStore
    public private(set) var version: String?

    #if canImport(FastVibeMobileCoreFFI)
    private var runtime: UnsafeMutableRawPointer?
    #endif

    public init(store: MobileCoreStore = MobileCoreStore()) {
        self.store = store
        #if canImport(FastVibeMobileCoreFFI)
        runtime = fastvibe_mobile_core_bridge_create()
        if let pointer = fastvibe_mobile_core_bridge_version() {
            version = String(cString: pointer)
            fastvibe_mobile_core_bridge_free_string(pointer)
        }
        #endif
    }

    deinit {
        #if canImport(FastVibeMobileCoreFFI)
        if let runtime { fastvibe_mobile_core_bridge_destroy(runtime) }
        #endif
    }

    @discardableResult
    public func apply(json: Data) throws -> MobileSessionState {
        #if canImport(FastVibeMobileCoreFFI)
        if let runtime {
            let value = try JSONSerialization.jsonObject(with: json)
            let command = try JSONSerialization.data(withJSONObject: ["action": "apply", "value": value])
            let input = String(decoding: command, as: UTF8.self)
            let output: String? = input.withCString { pointer in
                guard let result = fastvibe_mobile_core_bridge_command_json(runtime, pointer) else { return nil }
                defer { fastvibe_mobile_core_bridge_free_string(result) }
                return String(cString: result)
            }
            guard let output else { throw MobileCoreBridgeError.rustUnavailable }
            let envelope = try JSONDecoder().decode(RustCommandEnvelope.self, from: Data(output.utf8))
            guard envelope.ok, let state = envelope.state else {
                throw MobileCoreBridgeError.rustRejectedInput(envelope.error?.message ?? "Rust runtime rejected the command")
            }
            store.apply(snapshot: state)
            return state
        }
        #endif

        // SwiftPM host tests remain runnable before the iOS XCFramework exists.
        let state = try JSONDecoder().decode(MobileSessionState.self, from: json)
        store.apply(snapshot: state)
        return state
    }

    @discardableResult
    public func apply(jsonString: String) throws -> MobileSessionState {
        try apply(json: Data(jsonString.utf8))
    }

    /// Send one JSON command to the independent Rust runtime handle.
    ///
    /// The command API intentionally accepts Foundation JSON values so the UI target does
    /// not need to duplicate the Rust App Protocol types. The returned state is applied by
    /// the session controller on its main actor, keeping SwiftUI observations on the UI side.
    public func command(
        _ action: String,
        parameters: [String: MobileJSONValue] = [:]
    ) throws -> MobileCoreCommandResponse {
        #if canImport(FastVibeMobileCoreFFI)
        guard let runtime else { throw MobileCoreBridgeError.rustUnavailable }
        var request = parameters
        request["action"] = .string(action)
        let command = try JSONEncoder().encode(request)
        let input = String(decoding: command, as: UTF8.self)
        let output: String? = input.withCString { pointer in
            guard let result = fastvibe_mobile_core_bridge_command_json(runtime, pointer) else { return nil }
            defer { fastvibe_mobile_core_bridge_free_string(result) }
            return String(cString: result)
        }
        guard let output else { throw MobileCoreBridgeError.rustUnavailable }
        return try JSONDecoder().decode(MobileCoreCommandResponse.self, from: Data(output.utf8))
        #else
        _ = action
        _ = parameters
        throw MobileCoreBridgeError.rustUnavailable
        #endif
    }

    public func poll() throws -> MobileCoreCommandResponse {
        try command("poll")
    }
}

private struct RustCommandEnvelope: Decodable {
    let ok: Bool
    let state: MobileSessionState?
    let error: RustCommandError?
}

private struct RustCommandError: Decodable {
    let message: String?
}

public enum MobileCoreBridgeError: Error, Equatable {
    case rustUnavailable
    case rustRejectedInput(String)
}

