import XCTest
@testable import FastVibeCore
import FastVibeUI

final class FastVibeTests: XCTestCase {
    func testDeviceOptionalConnectionMetadataKeepsOlderCatalogsReadable() throws {
        let decoder = JSONDecoder()
        let legacy = try decoder.decode(MobileDevice.self, from: Data(#"{"id":"legacy","name":"Mac","online":true}"#.utf8))
        XCTAssertNil(legacy.path)
        XCTAssertNil(legacy.lastOnline)
        let displayOnly = try decoder.decode(MobileDevice.self, from: Data(#"{"id":"offline","lastOnline":"3 小时前"}"#.utf8))
        XCTAssertNil(displayOnly.lastOnline)
        let numeric = try decoder.decode(MobileDevice.self, from: Data(#"{"id":"mac","path":"direct","lastSeenAt":1700000000000}"#.utf8))
        XCTAssertEqual(numeric.path, "direct")
        XCTAssertEqual(numeric.lastOnline, 1700000000000)
        let restored = try decoder.decode(MobileDevice.self, from: JSONEncoder().encode(numeric))
        XCTAssertEqual(restored, numeric)
    }
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
