import Foundation
import Combine

public enum MobileJSONValue: Codable, Hashable, Sendable {
    case null
    case bool(Bool)
    case number(Double)
    case string(String)
    case array([MobileJSONValue])
    case object([String: MobileJSONValue])

    public init(from decoder: Decoder) throws {
        let container = try decoder.singleValueContainer()
        if container.decodeNil() { self = .null }
        else if let value = try? container.decode(Bool.self) { self = .bool(value) }
        else if let value = try? container.decode(Double.self) { self = .number(value) }
        else if let value = try? container.decode(String.self) { self = .string(value) }
        else if let value = try? container.decode([MobileJSONValue].self) { self = .array(value) }
        else { self = .object(try container.decode([String: MobileJSONValue].self)) }
    }

    public func encode(to encoder: Encoder) throws {
        var container = encoder.singleValueContainer()
        switch self {
        case .null: try container.encodeNil()
        case .bool(let value): try container.encode(value)
        case .number(let value): try container.encode(value)
        case .string(let value): try container.encode(value)
        case .array(let value): try container.encode(value)
        case .object(let value): try container.encode(value)
        }
    }
}

public struct MobileToolCall: Codable, Hashable, Identifiable, Sendable {
    public let id: String
    public let name: String
    public var args: MobileJSONValue?
    public var result: String?
    public var status: String
    public var details: MobileJSONValue?
    public var parentId: String?
    public var omitted: MobileJSONValue?

    enum CodingKeys: String, CodingKey {
        case id, name, args, result, status, details, parentId, omitted
    }

    public init(from decoder: Decoder) throws {
        let values = try decoder.container(keyedBy: CodingKeys.self)
        id = try values.decode(String.self, forKey: .id)
        name = try values.decodeIfPresent(String.self, forKey: .name) ?? "tool"
        args = try values.decodeIfPresent(MobileJSONValue.self, forKey: .args)
        result = try values.decodeIfPresent(String.self, forKey: .result)
        status = try values.decodeIfPresent(String.self, forKey: .status) ?? "unknown"
        details = try values.decodeIfPresent(MobileJSONValue.self, forKey: .details)
        parentId = try values.decodeIfPresent(String.self, forKey: .parentId)
        omitted = try values.decodeIfPresent(MobileJSONValue.self, forKey: .omitted)
    }
}

public enum MobileMessagePart: Codable, Hashable, Sendable {
    case text(String)
    case thinking(text: String, startedAt: Int64?, endedAt: Int64?)
    case tool(toolId: String)
    case model(from: MobileModel?, to: MobileModel)
    case compact(text: String, compact: MobileCompactInfo?)

    private enum CodingKeys: String, CodingKey { case kind, text, startedAt, endedAt, toolId, from, to, compact }

    public init(from decoder: Decoder) throws {
        let values = try decoder.container(keyedBy: CodingKeys.self)
        switch try values.decode(String.self, forKey: .kind) {
        case "text": self = .text(try values.decode(String.self, forKey: .text))
        case "thinking": self = .thinking(text: try values.decode(String.self, forKey: .text), startedAt: try values.decodeIfPresent(Int64.self, forKey: .startedAt), endedAt: try values.decodeIfPresent(Int64.self, forKey: .endedAt))
        case "tool": self = .tool(toolId: try values.decode(String.self, forKey: .toolId))
        case "model": self = .model(from: try values.decodeIfPresent(MobileModel.self, forKey: .from), to: try values.decode(MobileModel.self, forKey: .to))
        case "compact": self = .compact(text: try values.decode(String.self, forKey: .text), compact: try values.decodeIfPresent(MobileCompactInfo.self, forKey: .compact))
        default: throw DecodingError.dataCorruptedError(forKey: .kind, in: values, debugDescription: "Unknown Rust message part")
        }
    }

    public func encode(to encoder: Encoder) throws {
        var values = encoder.container(keyedBy: CodingKeys.self)
        switch self {
        case .text(let text): try values.encode("text", forKey: .kind); try values.encode(text, forKey: .text)
        case .thinking(let text, let startedAt, let endedAt):
            try values.encode("thinking", forKey: .kind); try values.encode(text, forKey: .text); try values.encodeIfPresent(startedAt, forKey: .startedAt); try values.encodeIfPresent(endedAt, forKey: .endedAt)
        case .tool(let toolId): try values.encode("tool", forKey: .kind); try values.encode(toolId, forKey: .toolId)
        case .model(let from, let to): try values.encode("model", forKey: .kind); try values.encodeIfPresent(from, forKey: .from); try values.encode(to, forKey: .to)
        case .compact(let text, let compact): try values.encode("compact", forKey: .kind); try values.encode(text, forKey: .text); try values.encodeIfPresent(compact, forKey: .compact)
        }
    }
}

public struct MobileModel: Codable, Hashable, Sendable {
    public let provider: String
    public let model: String

    enum CodingKeys: String, CodingKey { case provider, model, id }

    public init(from decoder: Decoder) throws {
        let values = try decoder.container(keyedBy: CodingKeys.self)
        provider = try values.decode(String.self, forKey: .provider)
        model = try values.decodeIfPresent(String.self, forKey: .model) ?? values.decode(String.self, forKey: .id)
    }

    public func encode(to encoder: Encoder) throws {
        var values = encoder.container(keyedBy: CodingKeys.self)
        try values.encode(provider, forKey: .provider)
        try values.encode(model, forKey: .model)
    }
}

public struct MobileCompactInfo: Codable, Hashable, Sendable {
    public let status: String
    public let reason: String?
    public let tokensBefore: UInt64?
    public let tokensAfter: UInt64?
    enum CodingKeys: String, CodingKey { case status, reason, tokensBefore, tokensAfter }
}

public struct MobileMessage: Identifiable, Codable, Hashable, Sendable {
    public enum Role: String, Codable, Sendable { case user, assistant, system, tool }
    public let id: String
    public let role: Role
    public let text: String
    public let thinking: String?
    public let tools: [MobileToolCall]
    public let parts: [MobileMessagePart]?
    public let createdAt: Int64
    public let completedAt: Int64?
    public let runStartedAt: Int64?
    public let kind: String?
    public let error: String?
    public let stop: String?
    public let retry: MobileJSONValue?
    public let deferredContent: Bool?

    enum CodingKeys: String, CodingKey {
        case id, role, text, thinking, tools, parts, createdAt, completedAt, runStartedAt, kind, error, stop, retry, deferredContent
    }

    private enum LegacyCodingKeys: String, CodingKey { case process }

    public init(from decoder: Decoder) throws {
        let values = try decoder.container(keyedBy: CodingKeys.self)
        id = try values.decode(String.self, forKey: .id)
        role = try values.decodeIfPresent(Role.self, forKey: .role) ?? .assistant
        text = try values.decodeIfPresent(String.self, forKey: .text) ?? ""
        thinking = try values.decodeIfPresent(String.self, forKey: .thinking)
        tools = try values.decodeIfPresent([MobileToolCall].self, forKey: .tools) ?? []
        let decodedParts = try values.decodeIfPresent([MobileMessagePart].self, forKey: .parts)
        let legacyValues = try decoder.container(keyedBy: LegacyCodingKeys.self)
        let legacyProcess = try legacyValues.decodeIfPresent([String].self, forKey: .process) ?? []
        parts = decodedParts ?? legacyProcess.map { .text($0) }
        createdAt = try values.decodeIfPresent(Int64.self, forKey: .createdAt) ?? 0
        completedAt = try values.decodeIfPresent(Int64.self, forKey: .completedAt)
        runStartedAt = try values.decodeIfPresent(Int64.self, forKey: .runStartedAt)
        kind = try values.decodeIfPresent(String.self, forKey: .kind)
        error = try values.decodeIfPresent(String.self, forKey: .error)
        stop = try values.decodeIfPresent(String.self, forKey: .stop)
        retry = try values.decodeIfPresent(MobileJSONValue.self, forKey: .retry)
        deferredContent = try values.decodeIfPresent(Bool.self, forKey: .deferredContent)
    }

    public init(id: String, role: Role, text: String, process: [String] = []) {
        self.id = id; self.role = role; self.text = text; self.thinking = nil; self.tools = []; self.parts = process.map { .text($0) }; self.createdAt = 0; self.completedAt = nil; self.runStartedAt = nil; self.kind = nil; self.error = nil; self.stop = nil; self.retry = nil; self.deferredContent = nil
    }

    public var process: [String] {
        parts?.compactMap {
            switch $0 { case .text(let text), .thinking(let text, _, _): return text; case .tool(let id): return "tool: \(id)"; case .model(_, let to): return "model: \(to.provider)/\(to.model)"; case .compact(let text, _): return text }
        } ?? []
    }
}

public struct MobileQueueState: Codable, Hashable, Sendable {
    public let items: [MobileJSONValue]
    public let paused: Bool
}

public struct MobileConversationSnapshot: Codable, Hashable, Sendable {
    public let conversationId: String?
    public let messages: [MobileMessage]
    public let messageMode: String?
    public let historyBeforeEntryId: String?
    public let running: Bool
    public let queue: MobileQueueState
    public let pendingUI: [MobileJSONValue]
    public let turnEvents: [MobileJSONValue]
    public let overflowed: Bool
    public let seq: UInt64

    enum CodingKeys: String, CodingKey {
        case conversationId, messages, messageMode, historyBeforeEntryId, running, queue, pendingUI = "pendingUi", turnEvents, overflowed, seq
    }

    public init(messages: [MobileMessage] = [], running: Bool = false) {
        self.conversationId = nil; self.messages = messages; self.messageMode = "window"; self.historyBeforeEntryId = nil; self.running = running; self.queue = MobileQueueState(items: [], paused: false); self.pendingUI = []; self.turnEvents = []; self.overflowed = false; self.seq = 0
    }
}

public struct MobileWireCursor: Codable, Hashable, Sendable {
    public let epoch: String
    public let seq: UInt64
}

public struct MobileSessionState: Codable, Sendable {
    public var snapshot: MobileConversationSnapshot?
    public var wireCursors: [String: MobileWireCursor]
    public var loadingHistory: Bool
    public var connection: String
    public var endpointId: String?
    public var path: String?
    public var error: String?
    public var workspace: MobileJSONValue?

    enum CodingKeys: String, CodingKey {
        case snapshot, wireCursors, loadingHistory, connection, endpointId, path, error, workspace
        case messages, running
    }

    public init(messages: [MobileMessage] = [], connection: String = "disconnected", running: Bool = false) {
        self.snapshot = MobileConversationSnapshot(messages: messages, running: running)
        self.wireCursors = [:]
        self.loadingHistory = false
        self.connection = connection
        self.endpointId = nil
        self.path = nil
        self.error = nil
        self.workspace = nil
    }

    public var messages: [MobileMessage] { snapshot?.messages ?? [] }
    public var running: Bool { snapshot?.running ?? false }

    public init(from decoder: Decoder) throws {
        let values = try decoder.container(keyedBy: CodingKeys.self)
        if values.contains(.snapshot) {
            snapshot = try values.decodeIfPresent(MobileConversationSnapshot.self, forKey: .snapshot)
            wireCursors = try values.decodeIfPresent([String: MobileWireCursor].self, forKey: .wireCursors) ?? [:]
            loadingHistory = try values.decodeIfPresent(Bool.self, forKey: .loadingHistory) ?? false
            connection = try values.decodeIfPresent(String.self, forKey: .connection) ?? "disconnected"
        } else {
            let messages = try values.decodeIfPresent([MobileMessage].self, forKey: .messages) ?? []
            snapshot = MobileConversationSnapshot(messages: messages, running: try values.decodeIfPresent(Bool.self, forKey: .running) ?? false)
            wireCursors = [:]
            loadingHistory = false
            connection = try values.decodeIfPresent(String.self, forKey: .connection) ?? "disconnected"
        }
        endpointId = try values.decodeIfPresent(String.self, forKey: .endpointId)
        path = try values.decodeIfPresent(String.self, forKey: .path)
        error = try values.decodeIfPresent(String.self, forKey: .error)
        workspace = try values.decodeIfPresent(MobileJSONValue.self, forKey: .workspace)
    }

    public func encode(to encoder: Encoder) throws {
        var values = encoder.container(keyedBy: CodingKeys.self)
        try values.encodeIfPresent(snapshot, forKey: .snapshot)
        try values.encode(wireCursors, forKey: .wireCursors)
        try values.encode(loadingHistory, forKey: .loadingHistory)
        try values.encode(connection, forKey: .connection)
        try values.encodeIfPresent(endpointId, forKey: .endpointId)
        try values.encodeIfPresent(path, forKey: .path)
        try values.encodeIfPresent(error, forKey: .error)
        try values.encodeIfPresent(workspace, forKey: .workspace)
    }
}

public final class MobileCoreStore: ObservableObject {
    @Published public private(set) var state: MobileSessionState
    public init(state: MobileSessionState = .init()) { self.state = state }
    public func apply(snapshot: MobileSessionState) { state = snapshot }
    public func append(_ message: MobileMessage) {
        let current = state.snapshot ?? MobileConversationSnapshot()
        state.snapshot = MobileConversationSnapshot(messages: current.messages + [message], running: current.running)
    }
}
