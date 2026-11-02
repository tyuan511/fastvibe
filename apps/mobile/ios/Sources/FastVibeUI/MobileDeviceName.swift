import Foundation
#if canImport(UIKit)
import UIKit
#endif

@MainActor
enum MobileDeviceName {
    static func resolve(custom: String?, system: String?, fallback: String) -> String {
        // A saved name is a user choice, even when it happens to match an old app default.
        if let custom, !custom.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty { return custom }
        if let system = system?.trimmingCharacters(in: .whitespacesAndNewlines), !system.isEmpty { return system }
        return fallback
    }

    static var systemName: String? {
        #if canImport(UIKit)
        return UIDevice.current.name
        #else
        return nil
        #endif
    }

    static var deviceKind: String {
        #if canImport(UIKit)
        return UIDevice.current.userInterfaceIdiom == .pad ? "iPad" : "iPhone"
        #else
        return "Apple device"
        #endif
    }
}

/// One registration at a time, including edits made while an earlier name is in flight.
@MainActor
final class MobileDeviceRegistration {
    var name: String
    private var registered: (name: String, id: String)?
    private var pending: (id: UUID, task: Task<String, Error>)?
    private var generation: UInt64 = 0

    init(name: String) { self.name = name }

    func reset() {
        generation &+= 1
        pending?.task.cancel()
        pending = nil
        registered = nil
    }

    func ensure(register: @escaping @MainActor (String) async throws -> String) async throws -> String {
        if let current = pending {
            _ = try await current.task.value
            // Any waiter may resume first; settle the slot before checking a newer edit.
            if pending?.id == current.id { pending = nil }
            return try await ensure(register: register)
        }
        if let registered, registered.name == name { return registered.id }
        let generation = generation
        let task = Task { @MainActor in
            while true {
                try Task.checkCancellation()
                let sentName = self.name
                let id: String
                do {
                    id = try await register(sentName)
                } catch {
                    guard generation == self.generation, !Task.isCancelled else { throw CancellationError() }
                    if sentName != self.name { continue }
                    throw error
                }
                guard generation == self.generation, !Task.isCancelled else { throw CancellationError() }
                self.registered = (sentName, id)
                if sentName == self.name { return id }
            }
        }
        let taskID = UUID()
        pending = (taskID, task)
        defer { if pending?.id == taskID { pending = nil } }
        let id = try await task.value
        if registered?.name != name {
            if pending?.id == taskID { pending = nil }
            return try await ensure(register: register)
        }
        return id
    }
}
