#if os(macOS)
import AppKit
import ImageIO
import SwiftUI
import XCTest
import FastVibeCore
@testable import FastVibeUI

/// Opt-in reference renders for reviewing the SwiftUI implementation against the approved HTML.
/// Fixtures stay in the test target; no account, network or Rust runtime is started here.
@MainActor
final class PrototypeRenderTests: XCTestCase {
    func testBackdropMatchesApprovedBrowserReference() async throws {
        for scheme in [ColorScheme.light, .dark] {
            let mode = scheme == .dark ? "dark" : "light"
            let referenceURL = try XCTUnwrap(Bundle.module.url(forResource: "approved-backdrop-\(mode)", withExtension: "png"))
            let source = try XCTUnwrap(CGImageSourceCreateWithURL(referenceURL as CFURL, nil))
            let reference = try XCTUnwrap(CGImageSourceCreateImageAtIndex(source, 0, nil))
            let renderer = ImageRenderer(content: MobileBackdrop().frame(width: 390, height: 844).environment(\.colorScheme, scheme))
            renderer.scale = 1
            renderer.isOpaque = true
            let actual = try XCTUnwrap(renderer.cgImage)
            let expectedPixels = try pixels(reference)
            let actualPixels = try pixels(actual)
            var maximum = 0
            var total = 0
            for index in actualPixels.indices where index % 4 != 3 {
                let difference = abs(Int(actualPixels[index]) - Int(expectedPixels[index]))
                maximum = max(maximum, difference)
                total += difference
            }
            let mean = Double(total) / Double(390 * 844 * 3)
            print("Approved CSS backdrop \(mode): max RGB delta=\(maximum), mean=\(mean)")
            XCTAssertLessThanOrEqual(maximum, 2, "The native backdrop must match the approved browser render (\(mode)).")
            XCTAssertLessThanOrEqual(mean, 0.5, "Backdrop differences exceed rasterizer rounding (\(mode)).")
        }
    }

    private func pixels(_ image: CGImage) throws -> [UInt8] {
        XCTAssertEqual(image.width, 390)
        XCTAssertEqual(image.height, 844)
        var bytes = [UInt8](repeating: 0, count: 390 * 844 * 4)
        let space = try XCTUnwrap(CGColorSpace(name: CGColorSpace.sRGB))
        try bytes.withUnsafeMutableBytes { storage in
            let context = try XCTUnwrap(CGContext(data: storage.baseAddress, width: 390, height: 844,
                                                 bitsPerComponent: 8, bytesPerRow: 390 * 4, space: space,
                                                 bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue | CGBitmapInfo.byteOrder32Big.rawValue))
            context.draw(image, in: CGRect(x: 0, y: 0, width: 390, height: 844))
        }
        return bytes
    }

    func testRenderPrototypeScreens() async throws {
        guard let directory = ProcessInfo.processInfo.environment["FASTVIBE_IOS_PREVIEW_DIR"] else {
            throw XCTSkip("Set FASTVIBE_IOS_PREVIEW_DIR to export the native prototype reference screens.")
        }
        XCTAssertNotNil(MobileBrandMark.bitmap, "The approved brand image must be present in the UI resource bundle.")
        let output = URL(fileURLWithPath: directory, isDirectory: true)
        try FileManager.default.createDirectory(at: output, withIntermediateDirectories: true)
        let fixture = try JSONDecoder().decode(MobileConversationSnapshot.self, from: Data(Self.snapshot.utf8))
        var streamObject = try XCTUnwrap(JSONSerialization.jsonObject(with: Data(Self.snapshot.utf8)) as? [String: Any])
        streamObject["running"] = true
        streamObject["queue"] = ["paused": false, "items": [["id": "queued-reference", "text": "测试一下，确保滚动加载和快照恢复都没问题"]]]
        var streamMessages = try XCTUnwrap(streamObject["messages"] as? [[String: Any]])
        let started = Int64(Date().timeIntervalSince1970 * 1000) - 18_000
        streamMessages[1].removeValue(forKey: "completedAt")
        streamMessages[1]["createdAt"] = started
        streamMessages[1]["runStartedAt"] = started
        streamMessages[1]["parts"] = [
            ["kind": "thinking", "text": "检查桌面端的分页接口，保持滚动位置并处理快照恢复。", "startedAt": started + 12_000],
            ["kind": "tool", "toolId": "read-reference"],
            ["kind": "tool", "toolId": "edit-reference"],
        ] as [[String: Any]]
        var streamTools = try XCTUnwrap(streamMessages[1]["tools"] as? [[String: Any]])
        for index in streamTools.indices { streamTools[index]["status"] = "running" }
        streamMessages[1]["tools"] = streamTools
        streamObject["messages"] = streamMessages
        let streaming = try JSONDecoder().decode(MobileConversationSnapshot.self, from: JSONSerialization.data(withJSONObject: streamObject))
        let device = MobileDevice(id: "reference-mac", name: "Yuan 的 MacBook Pro", platform: "macos", irohEndpointId: "reference-endpoint", online: true)
        let offline = MobileDevice(id: "reference-pc", name: "家里的 Windows", platform: "windows", online: false)
        let projects = [NativeProject(id: "fastvibe", name: "fastvibe", path: "/reference/fastvibe")]
        let conversations = [
            NativeConversation(id: "running", title: "修复远程连接偶发断开", preview: "正在编辑 backpressure.ts…", projectName: "fastvibe", projectPath: "/reference/fastvibe", updatedAt: .now, running: true, waiting: false, unread: false, archived: false),
            NativeConversation(id: "waiting", title: "发布 0.9.2 版本", preview: "要推送 tag v0.9.2 吗？", projectName: "fastvibe", projectPath: "/reference/fastvibe", updatedAt: .now.addingTimeInterval(-120), running: false, waiting: true, unread: false, archived: false),
            NativeConversation(id: "finished", title: "iroh 中转额度统计", preview: "迁移 00009 已在线上执行。", projectName: "fastvibe-services", projectPath: "/reference/services", updatedAt: .now.addingTimeInterval(-720), running: false, waiting: false, unread: false, archived: false),
            NativeConversation(id: "unread", title: "设置页的远程访问改版", preview: "已完成，改动了 6 个文件，测试全部通过。", projectName: "fastvibe", projectPath: "/reference/fastvibe", updatedAt: .now.addingTimeInterval(-2280), running: false, waiting: false, unread: true, archived: false),
        ]
        for scheme in [ColorScheme.light, .dark] {
            let suffix = scheme == .dark ? "dark" : "light"
            try render("backdrop-\(suffix)", scheme: scheme, output: output, Color.clear)
            try render("login-\(suffix)", scheme: scheme, output: output,
                       NativeLoginView(isLoading: false, onLogin: {}))
            try render("computers-\(suffix)", scheme: scheme, output: output,
                       NativeComputersView(devices: [device, offline], accountLabel: "tyuan511", isLoading: false, onRefresh: {}, onSettings: {}, onSelect: { _ in }))
            try render("connecting-\(suffix)", scheme: scheme, output: output,
                       NativeConnectionView(device: device, phase: "connecting", errorMessage: nil, onCancel: {}, onRetry: {}))
            try render("failed-\(suffix)", scheme: scheme, output: output,
                       NativeConnectionView(device: device, phase: "disconnected", errorMessage: "连接超时，请确认电脑在线后重试。", onCancel: {}, onRetry: {}))
            try render("conversations-\(suffix)", scheme: scheme, output: output,
                       NativeConversationCatalogView(deviceName: device.name, conversations: conversations, projects: projects, isLoading: false, onBack: {}, onSelect: { _ in }, onCreate: { _ in }))
            try render("thread-\(suffix)", scheme: scheme, output: output, transcript(fixture))
            try render("streaming-\(suffix)", scheme: scheme, output: output, transcript(streaming))
            try render("history-\(suffix)", scheme: scheme, output: output, transcript(fixture, isLoadingHistory: true))
            try render("new-\(suffix)", scheme: scheme, output: output, transcript(.init()))
            try render("settings-\(suffix)", scheme: scheme, output: output,
                       NativeSettingsView(accountLabel: "tyuan511", accountEmail: "yuan@example.com", deviceName: .constant("Yuan 的 iPhone"), appearance: .constant("system"), endpointID: "8f3c0000000000000000a91e", connectionPath: "直连", coreVersion: "0.1.0", onBack: {}, onSignOut: {}))
            for method in ["confirm", "select", "input"] {
                let request = MobileJSONValue.object([
                    "id": .string("reference-\(method)"), "method": .string(method),
                    "title": .string(method == "confirm" ? "允许运行这个命令吗？" : method == "select" ? "选择发布方式" : "输入发布说明"),
                    "message": .string("推送后会触发正式发布，无法撤回。"),
                    "command": .string("git push origin v0.9.2"),
                    "options": .array([.string("正式发布"), .string("预发布")]),
                ])
                try render("pending-\(method)-\(suffix)", scheme: scheme, output: output,
                           ZStack(alignment: .bottom) {
                               transcript(fixture)
                               Color.black.opacity(scheme == .dark ? 0.5 : 0.2)
                               NativePendingOperationSheet(request: request, count: 1, context: "发布 0.9.2 版本", maximumHeight: 650, onRespond: { _ in }).padding(8)
                           })
            }
        }
    }

    private func transcript(_ snapshot: MobileConversationSnapshot, isLoadingHistory: Bool = false) -> some View {
        NativeTranscriptView(messages: snapshot.messages, snapshot: snapshot,
                             conversationTitle: snapshot.messages.isEmpty ? "新会话" : "修复远程连接偶发断开",
                             projectName: "fastvibe", deviceName: "MacBook Pro", draft: .constant(""),
                             isSending: false, isLoadingHistory: isLoadingHistory, onBack: {}, onSend: { _ in },
                             onStop: {}, onLoadHistory: {}, onQueueRemove: { _ in },
                             onPermissionRespond: { _, _ in }, onAttach: {})
    }

    private func render<V: View>(_ name: String, scheme: ColorScheme, output: URL, _ view: V) throws {
        let surface = ZStack {
            MobileBackdrop()
            view
        }
        .mobileGlassCanvas()
        .frame(width: 390, height: 844)
        .environment(\.colorScheme, scheme)
        let application = NSApplication.shared
        application.setActivationPolicy(.prohibited)
        let hosting = NSHostingView(rootView: surface)
        let window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 390, height: 844),
                              styleMask: .borderless, backing: .buffered, defer: false)
        window.isReleasedWhenClosed = false
        window.contentView = hosting
        hosting.frame = NSRect(x: 0, y: 0, width: 390, height: 844)
        hosting.layoutSubtreeIfNeeded()
        RunLoop.current.run(until: Date().addingTimeInterval(0.05))
        hosting.displayIfNeeded()
        let bitmap = try XCTUnwrap(hosting.bitmapImageRepForCachingDisplay(in: hosting.bounds), "Could not render \(name)")
        hosting.cacheDisplay(in: hosting.bounds, to: bitmap)
        let png = try XCTUnwrap(bitmap.representation(using: .png, properties: [:]))
        try png.write(to: output.appendingPathComponent("\(name).png"), options: .atomic)
        window.close()
    }

    private static let snapshot = #"""
    {
      "conversationId":"reference-thread","messageMode":"window","historyBeforeEntryId":"older-reference",
      "running":false,"queue":{"items":[],"paused":false},"pendingUi":[],"turnEvents":[],"overflowed":false,"seq":12,
      "messages":[
        {"id":"user-1","role":"user","text":"手机上看长回复时远程连接总会断，错误码 4004。帮我查一下原因。","createdAt":1700000000000},
        {"id":"assistant-1","role":"assistant","text":"修改完成，测试全部通过。大快照不再触发断开了。","createdAt":1700000001000,"runStartedAt":1700000001000,"completedAt":1700000099000,
         "parts":[
           {"kind":"thinking","text":"检查背压实现，并验证大快照发送时压缩队列是否会被误判。","startedAt":1700000001000,"endedAt":1700000013000},
           {"kind":"text","text":"4004 是服务端判定“客户端太慢”时主动断开的。"},
           {"kind":"tool","toolId":"read-reference"},
           {"kind":"text","text":"改成软水位：超过 2 MiB 先给 15 秒宽限，期间有写入进展就续期；超过 32 MiB 才立刻断开。"},
           {"kind":"tool","toolId":"edit-reference"},
           {"kind":"text","text":"修改完成，测试全部通过。大快照不再触发断开了。"}
         ],
         "tools":[
           {"id":"read-reference","name":"read","args":{"path":"src/main/server/backpressure.ts"},"result":"读取了背压实现。","status":"completed"},
           {"id":"edit-reference","name":"edit","args":{"path":"src/main/server/backpressure.ts"},"result":"@@ -12,1 +12,3 @@\n- if (ws.bufferedAmount > SOFT_LIMIT) close(4004);\n+ if (ws.bufferedAmount > HARD_LIMIT) return close(4004);\n+ if (ws.bufferedAmount > SOFT_LIMIT) stall.start(GRACE_MS);\n+ else stall.clear();","status":"completed"}
         ]}
      ]
    }
    """#
}
#endif
