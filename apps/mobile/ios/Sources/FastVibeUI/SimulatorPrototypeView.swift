#if DEBUG
import Foundation
import SwiftUI
import FastVibeCore

/// Launch-only, in-memory fixtures for screenshots captured from the iOS Simulator.
/// This path never creates a MobileSessionController or opens account storage.
public struct SimulatorPrototypeLaunch {
    public static let screens = [
        "login", "computers", "connect", "chats", "thread", "new", "streaming", "history", "pending", "settings",
        "offline", "connect-failed", "filter", "filter-running", "project", "thread-read", "thread-diff", "thread-bottom",
        "history-diff", "confirm", "select", "input", "input-edited", "filter-many",
    ]
    public let screen: String
    public let theme: String

    public init?(arguments: [String] = ProcessInfo.processInfo.arguments) {
        guard let index = arguments.firstIndex(of: "--prototype-screen"),
              arguments.indices.contains(index + 1) else { return nil }
        screen = arguments[index + 1]
        if let themeIndex = arguments.firstIndex(of: "--prototype-theme"),
           arguments.indices.contains(themeIndex + 1) {
            theme = arguments[themeIndex + 1]
        } else {
            theme = "light"
        }
    }
}

@MainActor
public struct SimulatorPrototypeView: View {
    private let launch: SimulatorPrototypeLaunch
    @State private var draft = ""
    @State private var deviceName = "Yuan 的 iPhone"
    @State private var appearance = "system"

    public init(launch: SimulatorPrototypeLaunch) {
        self.launch = launch
        if launch.screen == "thread-multiline" {
            _draft = State(initialValue: "第一行草稿\n第二行草稿\n第三行草稿\n第四行草稿\n第五行草稿\n第六行草稿")
        }
    }

    public var body: some View {
        ZStack {
            MobileBackdrop()
            page
        }
        .mobileGlassCanvas()
        .preferredColorScheme(launch.theme == "dark" ? .dark : .light)
    }

    @ViewBuilder private var page: some View {
        switch launch.screen {
        #if canImport(UIKit)
        case "blur-proof":
            NativeBackdropBlurProof()
        #endif
        case "login":
            NativeLoginView(isLoading: false, onLogin: {})
        case "computers", "offline":
            NativeComputersView(
                devices: SimulatorPrototypeData.devices, accountLabel: "tyuan511", isLoading: false,
                onRefresh: {}, onSettings: {}, onSelect: { _ in },
                initialOfflineDevice: launch.screen == "offline" ? SimulatorPrototypeData.devices[2] : nil
            )
        case "connect", "connecting", "connect-failed", "failed":
            NativeConnectionView(
                device: SimulatorPrototypeData.devices[0], phase: launch.screen == "connect-failed" || launch.screen == "failed" ? "error" : "connecting",
                errorMessage: launch.screen == "connect-failed" || launch.screen == "failed" ? "15 秒内没有响应" : nil,
                onCancel: {}, onRetry: {}
            )
        case "chats", "conversations", "filter", "filter-running", "filter-many", "project":
            NativeConversationCatalogView(
                deviceName: "Yuan 的 MacBook Pro", conversations: SimulatorPrototypeData.conversations,
                projects: launch.screen == "filter-many" ? (1...40).map { NativeProject(id: "project-\($0)", name: "项目 \($0)", path: "~/code/project-\($0)") } : SimulatorPrototypeData.projects, isLoading: false,
                onBack: {}, onSelect: { _ in }, onCreate: { _ in },
                initialOverlay: launch.screen == "filter-many" ? "filter" : ["filter", "project"].contains(launch.screen) ? launch.screen : nil,
                initialStatusFilter: launch.screen == "filter-running" ? "running" : "all"
            )
        case "thread", "thread-read", "thread-diff", "thread-bottom", "thread-multiline", "new", "streaming", "history", "history-diff", "pending", "confirm", "select", "input", "input-edited":
            transcript
        case "settings":
            NativeSettingsView(
                accountLabel: "tyuan511", accountEmail: "yuan@example.com", deviceName: $deviceName,
                appearance: $appearance, endpointID: "8f3c…a91e", connectionPath: "直连", coreVersion: "0.1.0",
                onBack: {}, onSignOut: {}
            )
        default:
            Text("Unknown prototype screen: \(launch.screen)")
        }
    }

    private var transcript: some View {
        let snapshot = SimulatorPrototypeData.snapshot(for: launch.screen)
        return NativeTranscriptView(
            messages: snapshot.messages, snapshot: snapshot,
            conversationTitle: SimulatorPrototypeData.title(for: launch.screen), projectName: "fastvibe",
            deviceName: launch.screen == "new" ? "" : "MacBook Pro", draft: $draft,
            isSending: false, isLoadingHistory: launch.screen.hasPrefix("history"),
            onBack: {}, onSend: { _ in }, onStop: {}, onLoadHistory: {}, onQueueRemove: { _ in },
            onPermissionRespond: { _, _ in }, onAttach: {},
            initiallyExpandedThinkingMessageIDs: launch.screen == "streaming" ? ["streaming-assistant"] : [],
            initiallyExpandedToolMessageIDs: expandedToolMessages,
            initiallyExpandedToolIDs: expandedTools,
            referenceNow: 100000,
            initialScrollToLatest: ["thread-bottom", "thread-multiline"].contains(launch.screen),
            initialScrollTargetID: scrollTarget
        )
    }

    private var expandedToolMessages: Set<String> {
        switch launch.screen {
        case "streaming": return ["streaming-assistant"]
        case "thread-read": return ["thread-assistant-1"]
        case "thread-diff", "thread-bottom", "thread-multiline": return ["thread-assistant-2"]
        case "history", "history-diff": return ["history-assistant-2"]
        case "pending", "confirm", "select", "input", "input-edited": return ["release-assistant"]
        default: return []
        }
    }

    private var expandedTools: Set<String> {
        switch launch.screen {
        case "thread-read": return ["r1"]
        case "thread-diff", "thread-bottom", "thread-multiline": return ["r4"]
        case "history", "history-diff": return ["r6"]
        default: return []
        }
    }

    private var scrollTarget: String? {
        switch launch.screen {
        case "thread-read": return "thread-assistant-1"
        case "thread-diff": return "thread-assistant-2"
        case "history-diff": return "history-assistant-2"
        default: return nil
        }
    }
}

/// Sample data transcribed from design/prototype-standalone.html. Android's PrototypeData.kt
/// uses these same IDs/text; the older macOS PrototypeRenderTests are intentionally not reused.
@MainActor
private enum SimulatorPrototypeData {
    static let devices = [
        MobileDevice(id: "mbp", name: "Yuan 的 MacBook Pro", platform: "macos", irohEndpointId: "mbp-endpoint", online: true, path: "direct"),
        MobileDevice(id: "studio", name: "工作室 Mac Studio", platform: "macos", irohEndpointId: "studio-endpoint", online: true, path: "relay"),
        MobileDevice(id: "windows", name: "家里的 Windows", platform: "windows", online: false, lastOnline: Date().addingTimeInterval(-3 * 60 * 60).timeIntervalSince1970 * 1000),
    ]
    static let projects = [
        NativeProject(id: "fastvibe", name: "fastvibe", path: "~/code/fastvibe"),
        NativeProject(id: "fastvibe-services", name: "fastvibe-services", path: "~/code/fastvibe-services"),
    ]
    static var conversations: [NativeConversation] {
        let now = Date()
        func chat(_ id: String, _ title: String, _ preview: String, _ minutes: Double,
                  project: String = "fastvibe", running: Bool = false, waiting: Bool = false, unread: Bool = false) -> NativeConversation {
            NativeConversation(id: id, title: title, preview: preview, projectName: project,
                               projectPath: project.isEmpty ? nil : "~/code/\(project)",
                               updatedAt: now.addingTimeInterval(-minutes * 60), running: running,
                               waiting: waiting, unread: unread, archived: false)
        }
        return [
            chat("backpressure", "修复远程连接偶发断开", "正在编辑 backpressure.ts…", 0, running: true),
            chat("release", "发布 0.9.2 版本", "要推送 tag v0.9.2 吗？", 2, waiting: true),
            chat("quota", "iroh 中转额度统计", "迁移 00009 已在线上执行。", 12, project: "fastvibe-services"),
            chat("remote-settings", "设置页的远程访问改版", "已完成，改动了 6 个文件，测试全部通过。", 38, unread: true),
            chat("agents", "整理 AGENTS.md", "把 SQLite 存储那一节拆成了两段。", 1440),
            chat("devices", "设备列表接口加分页", "已停止，可以继续。", 4320, project: "fastvibe-services"),
            chat("idea", "记录一个新想法", "先整理思路，稍后再关联到项目。", 5760, project: ""),
        ]
    }

    static func title(for screen: String) -> String {
        switch screen {
        case "new": return "新会话"
        case "streaming": return "实现历史分页加载"
        case "history", "history-diff": return "讨论 native 移动端设计"
        case "pending", "confirm", "select", "input", "input-edited": return "发布 0.9.2 版本"
        default: return "修复远程连接偶发断开"
        }
    }

    static func snapshot(for screen: String) -> MobileConversationSnapshot {
        let messages: [[String: Any]]
        let id: String
        switch screen {
        case "new": id = "new"; messages = []
        case "streaming": id = "pagination"; messages = streaming
        case "history", "history-diff": id = "native"; messages = history
        case "pending", "confirm", "select", "input", "input-edited": id = "release"; messages = release
        default: id = "backpressure"; messages = thread
        }
        var object: [String: Any] = [
            "conversationId": id, "messageMode": "window", "messages": messages,
            "running": screen == "streaming", "queue": ["items": [], "paused": false],
            "pendingUi": [], "turnEvents": [], "overflowed": false, "seq": 1,
        ]
        if id == "backpressure" || id == "native" { object["historyBeforeEntryId"] = "prototype-before" }
        if screen == "streaming" {
            object["queue"] = ["paused": false, "items": [["id": "prototype-queue", "text": "测试一下，确保滚动加载和快照恢复都没问题"]]]
        }
        if id == "release" { object["pendingUi"] = [pending(for: screen)] }
        do {
            return try JSONDecoder().decode(MobileConversationSnapshot.self, from: JSONSerialization.data(withJSONObject: object))
        } catch {
            preconditionFailure("Invalid simulator prototype fixture: \(error)")
        }
    }

    private static func pending(for screen: String) -> [String: Any] {
        var request: [String: Any] = ["id": "prototype-\(screen)", "conversationId": "release"]
        switch screen {
        case "select":
            request.merge([
                "method": "select", "title": "选择发布渠道", "message": "agent 想知道这次推送到哪里。",
                "options": [
                    ["value": "stable", "label": "正式版", "description": "所有用户会收到更新"],
                    ["value": "beta", "label": "测试版", "description": "只推给 beta 渠道"],
                    ["value": "prepare", "label": "只准备，不推送", "description": "留在本地，稍后手动发布"],
                ],
            ]) { _, new in new }
        case "input", "input-edited":
            request.merge(["method": "input", "title": "补充 release note 标题", "message": "会写在更新说明的第一行。", "prefill": "远程连接更稳定了"]) { _, new in new }
        default:
            request.merge(["method": "confirm", "title": "允许运行这个命令吗？", "message": "推送后会触发正式发布，无法撤回。\n\n```bash\ngit push origin v0.9.2\n```"]) { _, new in new }
        }
        return request
    }

    private static func user(_ id: String, _ text: String) -> [String: Any] {
        ["id": id, "role": "user", "text": text]
    }
    private static func text(_ body: String) -> [String: Any] { ["kind": "text", "text": body] }
    private static func toolPart(_ id: String) -> [String: Any] { ["kind": "tool", "toolId": id] }
    private static func thinking(_ body: String, start: Int = 1000, end: Int) -> [String: Any] {
        ["kind": "thinking", "text": body, "startedAt": start, "endedAt": end]
    }
    private static func tool(_ id: String, _ name: String, _ key: String, _ argument: String, _ result: String? = nil, status: String = "completed") -> [String: Any] {
        var value: [String: Any] = ["id": id, "name": name, "args": [key: argument], "status": status]
        if let result { value["result"] = result }
        return value
    }

    private static let thread: [[String: Any]] = [
        ["id": "compact", "role": "assistant", "text": "", "parts": [[
            "kind": "compact", "text": "", "compact": ["status": "done", "reason": "threshold", "tokensBefore": 182000, "tokensAfter": 56000],
        ]]],
        user("thread-user-1", "手机上看长回复时远程连接总会断，错误码 4004。帮我查一下原因。"),
        ["id": "thread-assistant-1", "role": "assistant", "text": "", "stop": "aborted", "parts": [
            thinking("4004 是服务端主动断开的慢客户端码。大回复先进 zlib 压缩，bufferedAmount 会把还没压完的字节也算进去，所以瞬时阈值会被一次性的大帧顶爆。先确认阈值和计算方式。", end: 13000),
            text("4004 是服务端判定“客户端太慢”时主动断开的。我先看一下背压的实现。"),
            toolPart("r1"), toolPart("r2"), toolPart("r3"),
            text("找到了：`bufferedAmount` 把等待压缩的字节也算了进去，一个 3 MB 的快照后面紧跟一个小事件就会触发断开。"),
        ], "tools": [
            tool("r1", "read", "path", "src/main/server/backpressure.ts", "export const SOFT_LIMIT = 2 * 1024 * 1024;\nif (ws.bufferedAmount > SOFT_LIMIT) close(4004);"),
            tool("r2", "rg", "pattern", "trackSend src/main/rtc", "rg: src/main/rtc: 没有找到匹配项", status: "error"),
            tool("r3", "bash", "command", "pnpm test backpressure", "✔ closes a stalled client (31ms)\n✖ keeps a compressed 3 MB burst open\n  expected open, got 4004"),
        ]],
        user("thread-user-2", "继续，把瞬时阈值改成软水位加宽限期，再补一个测试。"),
        ["id": "thread-assistant-2", "role": "assistant", "text": "", "runStartedAt": 1000, "completedAt": 99000, "parts": [
            ["kind": "model", "to": ["provider": "anthropic", "model": "claude-sonnet-4.5"]],
            thinking("软水位 2 MiB，宽限 15 秒；一次成功的写回调或净排空 64 KiB 就续期。硬上限 32 MiB 立即停写。", end: 6000),
            text("改成软水位：超过 2 MiB 先给 15 秒宽限，期间有写入进展就续期；超过 32 MiB 才立刻断开。"),
            toolPart("r4"), toolPart("r5"), text("修改完成，测试全部通过。大快照不再触发断开了。"),
        ], "tools": [
            tool("r4", "edit", "path", "backpressure.ts", "@@ -12,4 +12,6 @@\n- if (ws.bufferedAmount > SOFT_LIMIT) close(4004);\n+ if (ws.bufferedAmount > HARD_LIMIT) return close(4004);\n+ if (ws.bufferedAmount > SOFT_LIMIT) stall.start(GRACE_MS);\n+ else stall.clear();"),
            tool("r5", "bash", "command", "pnpm test backpressure", "✔ closes a stalled client (29ms)\n✔ keeps a compressed 3 MB burst open (42ms)\n✔ expires after grace period without progress (15s)"),
        ]],
    ]

    private static let streaming: [[String: Any]] = [
        user("streaming-user", "把历史分页加上吧，参考桌面端的实现。"),
        ["id": "streaming-assistant", "role": "assistant", "text": "", "runStartedAt": 82000, "parts": [
            thinking("桌面端用 engine:get-messages-page，带 beforeEntryId 和 turnLimit。移动端需要先请求初始快照带 historyLimit，然后老消息滚到顶时调分页接口，把结果 prepend 到本地窗口前面。要处理 reset: true 的情况——那是分支编辑后要替换当前窗口。", end: 7000),
            toolPart("r7"), toolPart("r8"),
        ], "tools": [
            tool("r7", "read", "path", "src/shared/transcript-page.ts", "export type MessagesPageRequest = {\n  conversationId: string;\n  beforeEntryId: string;\n  turnLimit?: number;\n};"),
            tool("r8", "rg", "pattern", "get-messages-page src/main", "… 搜索中", status: "running"),
        ]],
    ]

    private static let history: [[String: Any]] = [
        user("history-user-1", "SwiftUI 和 Compose 的共同点是什么？"),
        ["id": "history-assistant-1", "role": "assistant", "text": "两者都是声明式 UI 框架，用状态驱动视图更新……"],
        user("history-user-2", "那 Rust core 要暴露什么样的状态接口？"),
        ["id": "history-assistant-2", "role": "assistant", "text": "", "parts": [
            text("建议用 JSON 状态快照加增量事件。Core 维护一个 `MobileState`，每次变化生成 JSON。"), toolPart("r6"),
        ], "tools": [
            tool("r6", "edit", "path", "apps/mobile/core/src/lib.rs", "@@ -156,0 +157,48 @@\n+ #[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]\n+ pub struct MobileState {\n+     pub connection_status: String,\n+     pub messages: Vec<ChatMessage>,\n+     pub queue: QueueState,\n+     pub pending_ui: Vec<serde_json::Value>,\n+     pub overflowed: bool,\n+ }"),
        ]],
    ]

    private static let release: [[String: Any]] = [
        user("release-user", "版本号和 release note 都准备好了就发布吧。"),
        ["id": "release-assistant", "role": "assistant", "text": "", "parts": [
            text("版本号已改成 0.9.2，中英文 release note 写好了。下一步需要推送 tag 触发 CI。"), toolPart("release-push"),
        ], "tools": [tool("release-push", "bash", "command", "git push origin v0.9.2", status: "pending")]],
    ]
}
#endif
