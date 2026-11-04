import XCTest
@testable import Runner

class RunnerTests: XCTestCase {
  func testMissingNativeState() throws {
    let state = try NativeStateMigration.read { _ in nil }
    XCTAssertEqual(state["present"] as? Bool, false)
    XCTAssertNil(state["token"])
  }

  func testNativeStateFieldMapping() throws {
    let values = ["account.token": "token", "account.origin": "https://example.com", "iroh.identity": "identity"]
    let state = try NativeStateMigration.read { values[$0] }
    XCTAssertEqual(state["present"] as? Bool, true)
    XCTAssertEqual(state["token"] as? String, "token")
    XCTAssertEqual(state["origin"] as? String, "https://example.com")
    XCTAssertEqual(state["identity"] as? String, "identity")
  }

  func testIdentityWithoutTokenStillMeansNativeStatePresent() throws {
    let state = try NativeStateMigration.read { $0 == "iroh.identity" ? "identity" : nil }
    XCTAssertEqual(state["present"] as? Bool, true)
    XCTAssertNil(state["token"])
  }

  func testEmptyStoredValueStillMeansPresent() throws {
    let state = try NativeStateMigration.read { $0 == "account.token" ? "" : nil }
    XCTAssertEqual(state["present"] as? Bool, true)
  }

  func testReadFailurePropagatesInsteadOfReturningSignedOut() {
    XCTAssertThrowsError(try NativeStateMigration.read { key in
      if key == "account.origin" { throw NativeStateMigration.ReadFailure.invalidValue }
      return "token"
    })
  }
}
