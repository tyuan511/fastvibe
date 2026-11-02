import XCTest
@testable import FastVibeUI

final class MobileDeviceNameTests: XCTestCase {
    @MainActor
    func testNamePrecedencePreservesSavedCustomNames() {
        for custom in ["小唐的 iPhone", "  Work phone  ", "FastVibe Mobile"] {
            XCTAssertEqual(MobileDeviceName.resolve(custom: custom, system: "iPhone", fallback: "Apple device"), custom)
        }
        XCTAssertEqual(MobileDeviceName.resolve(custom: nil, system: "  小唐的 iPad  ", fallback: "iPad"), "小唐的 iPad")
        XCTAssertEqual(MobileDeviceName.resolve(custom: " \n ", system: "", fallback: "iPad"), "iPad")
        XCTAssertEqual(MobileDeviceName.resolve(custom: nil, system: nil, fallback: "Apple device"), "Apple device")
    }

    @MainActor
    func testCachedIDStillRegistersANewName() async throws {
        let registration = MobileDeviceRegistration(name: "iPhone")
        var names: [String] = []
        let register: @MainActor (String) async throws -> String = { name in
            names.append(name)
            return "same-install-id"
        }
        let first = try await registration.ensure(register: register)
        let cached = try await registration.ensure(register: register)
        registration.name = "Work phone"
        let renamed = try await registration.ensure(register: register)
        XCTAssertEqual([first, cached, renamed], Array(repeating: "same-install-id", count: 3))
        XCTAssertEqual(names, ["iPhone", "Work phone"])
    }

    @MainActor
    func testConcurrentEditsAreSerializedAndFinishWithLatestName() async throws {
        let registration = MobileDeviceRegistration(name: "Original")
        let server = RegistrationFixture()
        let register: @MainActor (String) async throws -> String = { try await server.register($0) }
        let first = Task { try await registration.ensure(register: register) }
        await server.waitForFirstRequest()
        registration.name = "Intermediate"
        let second = Task { try await registration.ensure(register: register) }
        registration.name = "Latest"
        server.releaseFirst()
        let firstID = try await first.value
        let secondID = try await second.value
        XCTAssertEqual(firstID, secondID)
        XCTAssertEqual(server.names, ["Original", "Latest"])
        XCTAssertEqual(server.maxInFlight, 1)
    }

    @MainActor
    func testFailureRetriesWithoutLosingCustomName() async throws {
        let registration = MobileDeviceRegistration(name: "Work phone")
        do {
            _ = try await registration.ensure { _ in throw TestFailure.offline }
            XCTFail("An unsuccessful registration must not be cached")
        } catch TestFailure.offline {}
        XCTAssertEqual(registration.name, "Work phone")
        let id = try await registration.ensure { _ in "retry-id" }
        XCTAssertEqual(id, "retry-id")
    }

    @MainActor
    func testResetDoesNotLetOldAccountResponseFillCache() async throws {
        let registration = MobileDeviceRegistration(name: "iPhone")
        let server = RegistrationFixture()
        let old = Task { try await registration.ensure { try await server.register($0) } }
        await server.waitForFirstRequest()
        registration.reset()
        let freshID = try await registration.ensure { _ in "new-account-id" }
        server.releaseFirst()
        do {
            _ = try await old.value
            XCTFail("An old account response must be discarded")
        } catch is CancellationError {}
        let cachedID = try await registration.ensure { _ in XCTFail("New account id should be cached"); return "wrong" }
        XCTAssertEqual(freshID, "new-account-id")
        XCTAssertEqual(cachedID, freshID)
    }
}

private enum TestFailure: Error { case offline }

@MainActor
private final class RegistrationFixture {
    var names: [String] = []
    var maxInFlight = 0
    private var inFlight = 0
    private var firstRequest: CheckedContinuation<Void, Never>?
    private var firstStarted: CheckedContinuation<Void, Never>?

    func register(_ name: String) async throws -> String {
        names.append(name)
        inFlight += 1
        maxInFlight = max(maxInFlight, inFlight)
        defer { inFlight -= 1 }
        if names.count == 1 {
            await withCheckedContinuation { continuation in
                firstRequest = continuation
                firstStarted?.resume()
                firstStarted = nil
            }
        }
        return "same-install-id"
    }

    func waitForFirstRequest() async {
        if firstRequest != nil { return }
        await withCheckedContinuation { firstStarted = $0 }
    }

    func releaseFirst() {
        firstRequest?.resume()
        firstRequest = nil
    }
}
