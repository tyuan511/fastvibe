import XCTest
@testable import FastVibeCore

final class CommandRuntimeTests: XCTestCase {
    func testResultArrivingBeforeWaiterIsPreserved() async throws {
        let runtime = CommandRuntimeFixture(rpcOK: true)
        let coordinator = MobileCoreCommandCoordinator(runtime: runtime)
        let ticket = try await coordinator.start("prompt")
        _ = try await coordinator.poll()
        let response = try await coordinator.awaitResult(XCTUnwrap(ticket.requestID))
        XCTAssertTrue(response.ok)
        XCTAssertEqual(response.state?.connection, "ready")
    }

    func testQueuedCommandDoesNotHideServerFailure() async throws {
        let coordinator = MobileCoreCommandCoordinator(runtime: CommandRuntimeFixture(rpcOK: false))
        let ticket = try await coordinator.start("prompt")
        XCTAssertTrue(ticket.initial.ok)
        _ = try await coordinator.poll()
        do {
            _ = try await coordinator.awaitResult(XCTUnwrap(ticket.requestID))
            XCTFail("A queued request must still report the server rejection.")
        } catch let error as MobileCoreCommandFailure {
            XCTAssertEqual(error.code, "test.rejected")
            XCTAssertEqual(error.message, "Prompt rejected by server")
        }
    }

    func testDisconnectBetweenQueueAndWaitSettlesRequest() async throws {
        let coordinator = MobileCoreCommandCoordinator(runtime: CommandRuntimeFixture(rpcOK: true))
        let ticket = try await coordinator.start("prompt")
        await coordinator.failPending(message: "Disconnected")
        do {
            _ = try await coordinator.awaitResult(XCTUnwrap(ticket.requestID))
            XCTFail("A disconnected request must not remain parked.")
        } catch let error as MobileCoreCommandFailure {
            XCTAssertEqual(error.code, "mobile.disconnected")
        }
    }

    func testUnansweredRequestTimesOut() async throws {
        let coordinator = MobileCoreCommandCoordinator(runtime: CommandRuntimeFixture(rpcOK: true), timeout: .milliseconds(10))
        let ticket = try await coordinator.start("prompt")
        do {
            _ = try await coordinator.awaitResult(XCTUnwrap(ticket.requestID))
            XCTFail("An unanswered request must time out.")
        } catch let error as MobileCoreCommandFailure {
            XCTAssertEqual(error.code, "mobile.timeout")
        }
    }

    func testMalformedRequestIdCannotTrapDuringConversion() async throws {
        let runtime = CommandRuntimeFixture(rpcOK: true, requestID: Double(UInt64.max))
        let coordinator = MobileCoreCommandCoordinator(runtime: runtime)
        let ticket = try await coordinator.start("prompt")
        XCTAssertNil(ticket.requestID)
    }
}

private actor CommandRuntimeFixture: MobileCoreCommanding {
    let rpcOK: Bool
    let requestID: Double

    init(rpcOK: Bool, requestID: Double = 42) {
        self.rpcOK = rpcOK
        self.requestID = requestID
    }

    func command(_ action: String, parameters: [String: MobileJSONValue]) async throws -> MobileCoreCommandResponse {
        if action == "poll" {
            return MobileCoreCommandResponse(ok: true, action: action, result: .object([
                "events": .array([.object([
                    "kind": .string("rpcResult"), "requestId": .number(requestID),
                    "action": .string("prompt"), "ok": .bool(rpcOK),
                    "error": rpcOK ? .null : .object([
                        "code": .string("test.rejected"), "message": .string("Prompt rejected by server"),
                    ]),
                ])]),
                "overflowed": .bool(false),
            ]), state: MobileSessionState(connection: "ready"))
        }
        return MobileCoreCommandResponse(ok: true, action: action, result: .object(["requestId": .number(requestID)]))
    }
}
