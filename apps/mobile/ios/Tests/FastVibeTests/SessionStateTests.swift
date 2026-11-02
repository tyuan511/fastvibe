import XCTest
@testable import FastVibeCore

final class FastVibeTests: XCTestCase {
    func testBridgeAppliesSharedJsonState() throws {
        let bridge = MobileCoreBridge()
        try bridge.apply(jsonString: "{\"messages\": [{\"id\": \"1\", \"role\": \"assistant\", \"text\": \"ok\", \"process\": [\"thinking\", \"tool\"]}], \"connection\": \"ready\", \"running\": false}")
        XCTAssertEqual(bridge.store.state.messages.first?.process, ["thinking", "tool"])
    }

    func testCoreKeepsProcessDetails() {
        let store = MobileCoreStore()
        store.append(MobileMessage(id: "1", role: .assistant, text: "完成", process: ["thinking: inspect", "tool: read", "tool result: 12 files"]))
        XCTAssertEqual(store.state.messages.first?.process.count, 3)
    }
}
