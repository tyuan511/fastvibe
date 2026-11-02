import Foundation
import SwiftUI
import FastVibeCore

// These helpers read the already-projected Swift models. They do not reduce wire events.
extension MobileJSONValue {
    func ntField(_ key: String) -> MobileJSONValue? {
        guard case .object(let object) = self, let value = object[key], value != .null else { return nil }
        return value
    }

    func ntString(_ key: String) -> String? { ntField(key)?.ntStringValue }
    var ntStringValue: String? { if case .string(let value) = self { return value }; return nil }
    var ntArray: [MobileJSONValue] { if case .array(let values) = self { return values }; return [] }
    var ntNumber: Double? { if case .number(let value) = self { return value }; return nil }
    var ntBool: Bool { if case .bool(let value) = self { return value }; return false }
    var ntPretty: String {
        if let text = ntStringValue { return text }
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.prettyPrinted, .sortedKeys, .withoutEscapingSlashes]
        guard let data = try? encoder.encode(self), let text = String(data: data, encoding: .utf8) else { return "" }
        return text
    }
}

struct NativeTranscriptControlBackground: View {
    var radius: CGFloat = 24
    var body: some View {
        MobileGlassSurface(kind: .control, radius: radius)
    }
}

private struct NativeUserBubbleShape: InsettableShape {
    var insetAmount: CGFloat = 0

    func path(in rect: CGRect) -> Path {
        UnevenRoundedRectangle(topLeadingRadius: 22, bottomLeadingRadius: 22, bottomTrailingRadius: 6, topTrailingRadius: 22, style: .continuous)
            .inset(by: insetAmount).path(in: rect)
    }

    func inset(by amount: CGFloat) -> Self {
        var shape = self
        shape.insetAmount += amount
        return shape
    }
}

private enum NativeMessageBlock: Identifiable {
    case part(Int, MobileMessagePart)
    case tools(Int, [MobileToolCall], missing: [String])
    var id: Int { switch self { case .part(let index, _), .tools(let index, _, _): return index } }

    static func ordered(_ message: MobileMessage) -> [NativeMessageBlock] {
        let parts: [MobileMessagePart]
        if let ordered = message.parts, !ordered.isEmpty { parts = ordered }
        else {
            var fallback: [MobileMessagePart] = []
            if let thinking = message.thinking, !thinking.isEmpty { fallback.append(.thinking(text: thinking, startedAt: nil, endedAt: nil)) }
            if message.kind == "compact" { fallback.append(.compact(text: message.text, compact: nil)) }
            else if !message.text.isEmpty { fallback.append(.text(message.text)) }
            fallback += message.tools.map { .tool(toolId: $0.id) }
            parts = fallback
        }
        var blocks: [NativeMessageBlock] = []
        var index = 0
        while index < parts.count {
            if case .tool = parts[index] {
                let start = index
                var calls: [MobileToolCall] = []
                var missing: [String] = []
                while index < parts.count, case .tool(let id) = parts[index] {
                    if let call = message.tools.first(where: { $0.id == id }) { calls.append(call) }
                    else { missing.append(id) }
                    index += 1
                }
                blocks.append(.tools(start, calls, missing: missing))
            } else {
                blocks.append(.part(index, parts[index]))
                index += 1
            }
        }
        return blocks
    }
}

struct NativeTranscriptMessage: View {
    let message: MobileMessage
    let isRunning: Bool
    let waiting: Bool
    let canContinue: Bool
    let onContinue: () -> Void
    var initiallyExpandedThinking: Bool? = nil
    var initiallyExpandedTools: Bool? = nil
    var initiallyExpandedToolIDs: Set<String>? = nil
    var referenceNow: Int64? = nil
    @Environment(\.colorScheme) private var scheme
    private var palette: MobilePalette { MobilePalette(scheme: scheme) }

    var body: some View {
        if message.role == .user {
            // Text(verbatim:) deliberately bypasses Markdown, including bare URL detection.
            NativeUserMessage(text: message.text)
        } else {
            VStack(alignment: .leading, spacing: 10) {
                ForEach(NativeMessageBlock.ordered(message)) { block in
                    switch block {
                    case .part(_, let part): partView(part)
                    case .tools(_, let calls, let missing):
                        NativeTranscriptTools(tools: calls, missing: missing, waiting: waiting && isRunning,
                                              initiallyExpanded: initiallyExpandedTools, initiallyExpandedToolIDs: initiallyExpandedToolIDs)
                    }
                }
                if let retry = message.retry, retry != .null {
                    retryNotice(retry)
                }
                if let error = message.error, !error.isEmpty {
                    notice(icon: "exclamationmark.triangle", color: palette.danger, text: error, continuation: canContinue)
                }
                if let stop = message.stop {
                    notice(icon: "stop", color: palette.secondary,
                           text: stop == "length" ? "回复已达到输出长度上限。" : "你停止了这次回复。",
                           continuation: canContinue)
                }
                if message.deferredContent == true {
                    Label("此处为历史内容预览", systemImage: "text.alignleft")
                        .font(.system(size: 12)).foregroundStyle(palette.secondary)
                }
                if let start = message.runStartedAt ?? (message.createdAt > 0 ? message.createdAt : nil),
                   let end = message.completedAt, end >= start {
                    NativeTranscriptElapsed(start: start, end: end, prefix: "已处理")
                } else if isRunning, let start = message.runStartedAt ?? (message.createdAt > 0 ? message.createdAt : nil) {
                    NativeTranscriptElapsed(start: start, end: referenceNow, prefix: "已处理")
                }
            }
            .frame(maxWidth: .infinity, alignment: .leading)
        }
    }

    @ViewBuilder private func partView(_ part: MobileMessagePart) -> some View {
        switch part {
        case .text(let text): NativeTranscriptMarkdown(text: text)
        case .thinking(let text, let start, let end):
            NativeTranscriptThinking(text: text, startedAt: start, endedAt: end, running: isRunning && end == nil,
                                     initiallyExpanded: initiallyExpandedThinking, referenceNow: referenceNow)
        case .model(let from, let to):
            HStack(spacing: 10) {
                Rectangle().fill(palette.secondary.opacity(0.2)).frame(height: 0.5)
                MobileGlyph(systemName: "cpu").frame(width: 14, height: 14)
                Text("模型已切换至 \(to.model)")
                    .font(.system(size: 13)).fixedSize(horizontal: false, vertical: true)
                    .accessibilityLabel(from.map { "模型从 \($0.model) 切换至 \(to.model)" } ?? "模型已切换至 \(to.model)")
                    .layoutPriority(1)
                Rectangle().fill(palette.secondary.opacity(0.2)).frame(height: 0.5)
            }
            .foregroundStyle(palette.secondary).padding(.vertical, 2)
        case .compact(let text, let info): NativeTranscriptCompaction(text: text, info: info)
        case .tool: EmptyView() // Tool runs are rendered by the adjacent-parts grouping above.
        }
    }

    private func notice(icon: String, color: Color, text: String, continuation: Bool) -> some View {
        MobileGlassPanel(radius: 22) {
            HStack(alignment: .top, spacing: 10) {
                MobileGlyph(systemName: icon).frame(width: 20, height: 20).foregroundStyle(color)
                VStack(alignment: .leading, spacing: 8) {
                    Text(verbatim: text).font(.system(size: 14)).textSelection(.enabled)
                    if continuation {
                        Button(action: onContinue) {
                            Label("继续", systemImage: "play.fill")
                                .font(.system(size: 14, weight: .semibold))
                                .padding(.horizontal, 14).frame(minHeight: 36)
                                .foregroundStyle(scheme == .dark ? .black : .white)
                                .background(palette.text, in: Capsule())
                                .frame(minHeight: 44)
                        }
                        .buttonStyle(.plain)
                    }
                }
                .frame(maxWidth: .infinity, alignment: .leading)
            }
            .padding(.horizontal, 14).padding(.vertical, 12)
        }
    }

    private func retryNotice(_ retry: MobileJSONValue) -> some View {
        HStack(alignment: .top, spacing: 8) {
            ProgressView().controlSize(.small)
            VStack(alignment: .leading, spacing: 4) {
                let attempt = retry.ntField("attempt")?.ntNumber.map { String(Int($0)) } ?? ""
                Text("正在重试\(attempt.isEmpty ? "" : " · 第 \(attempt) 次")").font(.system(size: 14, weight: .medium))
                if let error = retry.ntString("error") { Text(verbatim: error).font(.system(size: 13)) }
            }
        }
        .foregroundStyle(palette.warning)
    }
}

private struct NativeUserMessage: View {
    let text: String
    @State private var availableWidth: CGFloat = 0
    @Environment(\.colorScheme) private var scheme
    private var bubbleWidth: CGFloat {
        let measured = ceil(MobileTypography.textWidth(text, size: 16)) + 28
        return availableWidth > 0 ? min(availableWidth * 0.84, measured) : measured
    }
    var body: some View {
        HStack(spacing: 0) {
            Spacer(minLength: 0)
            Text(verbatim: text)
                .font(MobileTypography.system(size: 16))
                .mobileLineHeight(fontSize: 16, lineHeight: 23.52)
                .foregroundStyle(.white).textSelection(.enabled)
                .frame(width: max(0, bubbleWidth - 28), alignment: .leading)
                .fixedSize(horizontal: false, vertical: true)
                .padding(.vertical, 10).padding(.horizontal, 14)
                .background { MobileAccentSurface(shape: NativeUserBubbleShape(), userBubble: true) }
        }
        .frame(maxWidth: .infinity)
        .onGeometryChange(for: CGFloat.self) { $0.size.width } action: { availableWidth = $0 }
    }
}

struct NativeTranscriptElapsed: View {
    let start: Int64
    let end: Int64?
    let prefix: String
    @Environment(\.colorScheme) private var scheme
    var body: some View {
        if let end { elapsedLabel(at: end) }
        else {
            TimelineView(.periodic(from: .now, by: 1)) { context in
                elapsedLabel(at: Int64(context.date.timeIntervalSince1970 * 1000))
            }
        }
    }

    private func elapsedLabel(at instant: Int64) -> some View {
        Label("\(prefix) \(Self.duration(milliseconds: max(0, instant - start)))", systemImage: "clock")
            .font(.system(size: 13)).monospacedDigit()
            .mobileLineHeight(fontSize: 13, lineHeight: 19.11)
            .foregroundStyle(MobilePalette(scheme: scheme).secondary)
    }

    static func duration(milliseconds: Int64) -> String {
        let seconds = milliseconds / 1000
        if seconds >= 3600 { return "\(seconds / 3600) 小时 \(seconds % 3600 / 60) 分" }
        if seconds >= 60 { return "\(seconds / 60) 分 \(seconds % 60) 秒" }
        return "\(seconds) 秒"
    }
}

private struct NativeTranscriptThinking: View {
    let text: String
    let startedAt: Int64?
    let endedAt: Int64?
    let running: Bool
    let referenceNow: Int64?
    @State private var expanded: Bool
    @Environment(\.colorScheme) private var scheme

    init(text: String, startedAt: Int64?, endedAt: Int64?, running: Bool, initiallyExpanded: Bool? = nil, referenceNow: Int64? = nil) {
        self.text = text; self.startedAt = startedAt; self.endedAt = endedAt; self.running = running
        self.referenceNow = referenceNow
        self._expanded = State(initialValue: initiallyExpanded ?? running)
    }

    var body: some View {
        let palette = MobilePalette(scheme: scheme)
        VStack(alignment: .leading, spacing: 4) {
            Button { expanded.toggle() } label: {
                HStack(spacing: 6) {
                    MobileGlyph(systemName: "brain").frame(width: 16, height: 16)
                    if let start = startedAt, endedAt != nil || running {
                        NativeTranscriptElapsed(start: start, end: endedAt ?? referenceNow, prefix: running ? "正在思考" : "思考了")
                            .labelStyle(.titleOnly)
                    } else { Text(running ? "正在思考…" : "思考").font(.system(size: 14)) }
                    MobileGlyph(systemName: expanded ? "chevron.down" : "chevron.right").frame(width: 16, height: 16)
                }
                .foregroundStyle(palette.secondary)
                .frame(minHeight: 36).padding(.horizontal, 2)
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .accessibilityLabel(expanded ? "收起思考" : "展开思考")
            .accessibilityValue(expanded ? "已展开" : "已收起")
            if expanded {
                HStack(alignment: .top, spacing: 0) {
                    (Text(verbatim: text) + Text(running ? " ▍" : "").foregroundColor(palette.accent))
                        .font(MobileTypography.system(size: 14))
                        .mobileLineHeight(fontSize: 14, lineHeight: 20.58)
                        .foregroundStyle(palette.secondary).textSelection(.enabled)
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .padding(.leading, 14).padding(.vertical, 2)
                }
                .overlay(alignment: .leading) { Rectangle().fill(palette.secondary.opacity(0.2)).frame(width: 2) }
            }
        }
    }
}

private struct NativeTranscriptCompaction: View {
    let text: String
    let info: MobileCompactInfo?
    @Environment(\.colorScheme) private var scheme
    private var palette: MobilePalette { MobilePalette(scheme: scheme) }
    var body: some View {
        MobileGlassPanel(radius: 22) {
            HStack(spacing: 12) {
                Image(systemName: "arrow.down.and.line.horizontal.and.arrow.up")
                    .font(.system(size: 19)).foregroundStyle(palette.secondary)
                    .frame(width: 36, height: 36)
                    .background(palette.controlTint, in: RoundedRectangle(cornerRadius: 10))
                VStack(alignment: .leading, spacing: 2) {
                    HStack(spacing: 6) {
                        if info?.status == "running" { ProgressView().controlSize(.small) }
                        Text(title).font(.system(size: 15, weight: .semibold))
                    }
                    if let before = info?.tokensBefore, let after = info?.tokensAfter {
                        Text("\(tokens(before)) → \(tokens(after)) tokens\(reason)")
                            .font(.system(size: 13)).monospacedDigit().foregroundStyle(palette.secondary)
                        GeometryReader { geometry in
                            Capsule().fill(palette.controlTint)
                                .overlay(alignment: .leading) {
                                    Capsule().fill(palette.accent.gradient)
                                        .frame(width: geometry.size.width * min(1, CGFloat(after) / max(1, CGFloat(before))))
                                }
                        }
                        .frame(height: 6).padding(.top, 4)
                    }
                    if !text.isEmpty {
                        Text(verbatim: text).font(.system(size: 13)).foregroundStyle(palette.secondary).textSelection(.enabled)
                    }
                }
                .frame(maxWidth: .infinity, alignment: .leading)
            }
            .padding(.horizontal, 14).padding(.vertical, 12)
        }
    }
    private var title: String {
        switch info?.status {
        case "running": return "正在压缩上下文"
        case "cancelled", "aborted": return "上下文压缩已取消"
        case "error", "failed": return "上下文压缩失败"
        default: return "上下文已压缩"
        }
    }
    private var reason: String {
        switch info?.reason { case "manual": return " · 手动压缩"; case "threshold", "overflow": return " · 自动压缩"; default: return "" }
    }
    private func tokens(_ count: UInt64) -> String { count >= 1000 ? String(format: "%.0fk", Double(count) / 1000) : String(count) }
}

private struct NativeTranscriptTools: View {
    let tools: [MobileToolCall]
    let missing: [String]
    let waiting: Bool
    let initiallyExpandedToolIDs: Set<String>?
    @State private var expanded: Bool
    @Environment(\.colorScheme) private var scheme
    private var palette: MobilePalette { MobilePalette(scheme: scheme) }
    private var running: Bool { tools.contains { $0.ntRunning } }
    private var failures: Int { tools.filter { $0.ntFailed }.count }

    init(tools: [MobileToolCall], missing: [String], waiting: Bool, initiallyExpanded: Bool? = nil, initiallyExpandedToolIDs: Set<String>? = nil) {
        self.tools = tools; self.missing = missing; self.waiting = waiting
        self.initiallyExpandedToolIDs = initiallyExpandedToolIDs
        self._expanded = State(initialValue: initiallyExpanded ?? (tools.contains { $0.ntRunning || $0.ntEdit } || tools.count + missing.count == 1))
    }

    var body: some View {
        MobileGlassPanel(radius: 22) {
            VStack(spacing: 0) {
                Button { expanded.toggle() } label: {
                    HStack(spacing: 8) {
                        MobileGlyph(systemName: "checklist").frame(width: 16, height: 16)
                        Text("\(running ? "正在执行" : "执行了") \(tools.count + missing.count) 个步骤")
                            .font(.system(size: 14, weight: .semibold))
                        if failures > 0 {
                            Text("\(failures) 个失败").font(.system(size: 12, weight: .semibold))
                                .foregroundStyle(palette.danger).padding(.horizontal, 8).padding(.vertical, 3)
                                .background(palette.danger.opacity(0.12), in: Capsule())
                        }
                        Spacer(minLength: 0)
                        MobileGlyph(systemName: expanded ? "chevron.down" : "chevron.right").frame(width: 16, height: 16)
                    }
                    .foregroundStyle(palette.secondary)
                    .padding(.horizontal, 14).frame(minHeight: 44).contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .accessibilityValue(expanded ? "已展开" : "已收起")
                if expanded {
                    ForEach(tools) { tool in
                        Rectangle().fill(palette.secondary.opacity(0.15)).frame(height: 0.5)
                        NativeTranscriptTool(tool: tool, waiting: waiting && tool.ntRunning,
                                             initiallyExpanded: initiallyExpandedToolIDs.map { $0.contains(tool.id) })
                            .id(tool.id)
                    }
                    ForEach(missing, id: \.self) { id in
                        Text("工具详情尚未载入 · \(id)")
                            .font(.system(size: 13)).foregroundStyle(palette.secondary)
                            .frame(maxWidth: .infinity, alignment: .leading).padding(14)
                    }
                }
            }
        }
    }
}

private extension MobileToolCall {
    var ntRunning: Bool { ["running", "pending", "queued", "streaming"].contains(status.lowercased()) }
    var ntFailed: Bool { ["error", "failed", "failure"].contains(status.lowercased()) }
    var ntEdit: Bool { ["edit", "edit_file", "apply_patch", "applypatch"].contains(name.lowercased()) }
    var ntLabel: String {
        switch name.lowercased() {
        case "read", "read_file": return "读取"
        case "write", "write_file": return "写入"
        case "edit", "edit_file", "apply_patch", "applypatch": return "编辑"
        case "bash", "shell", "exec", "command": return "命令"
        case "grep", "rg", "search", "find", "glob": return "搜索"
        default: return name
        }
    }
    var ntIcon: String {
        switch ntLabel { case "读取": return "doc.text"; case "写入", "编辑": return "square.and.pencil"; case "搜索": return "text.magnifyingglass"; default: return "terminal" }
    }
    var ntSummary: String {
        for key in ["path", "file_path", "filePath", "command", "pattern", "query", "description"] {
            if let text = args?.ntString(key), !text.isEmpty {
                if ntEdit, ["path", "file_path", "filePath"].contains(key) {
                    return (text.replacingOccurrences(of: "\\", with: "/") as NSString).lastPathComponent
                }
                return text.replacingOccurrences(of: "\n", with: " ")
            }
        }
        return args?.ntPretty.replacingOccurrences(of: "\n", with: " ") ?? ""
    }
    var ntDiff: String? {
        guard ntEdit else { return nil }
        if let diff = details?.ntString("diff"), !diff.isEmpty { return diff }
        if let patch = args?.ntString("patch") ?? args?.ntString("input"), patch.contains("@@") || patch.contains("*** Begin Patch") { return patch }
        if let result, result.contains("@@") { return result }
        let old = args?.ntString("oldText") ?? args?.ntString("old_string") ?? args?.ntString("old_string_text")
        let new = args?.ntString("newText") ?? args?.ntString("new_string") ?? args?.ntString("new_string_text")
        guard old != nil || new != nil else { return nil }
        // A replacement preview uses the exact tool arguments, with no invented line numbers.
        let removed = old.map { $0.components(separatedBy: "\n").map { "- " + $0 } } ?? []
        let added = new.map { $0.components(separatedBy: "\n").map { "+ " + $0 } } ?? []
        return (removed + added).joined(separator: "\n")
    }
}

private struct NativeTranscriptTool: View {
    let tool: MobileToolCall
    let waiting: Bool
    @State private var expanded: Bool
    @Environment(\.colorScheme) private var scheme
    private var palette: MobilePalette { MobilePalette(scheme: scheme) }
    init(tool: MobileToolCall, waiting: Bool, initiallyExpanded: Bool? = nil) {
        self.tool = tool; self.waiting = waiting
        self._expanded = State(initialValue: initiallyExpanded ?? tool.ntEdit)
    }

    private var visibleDetails: String? {
        guard let details = tool.details else { return nil }
        if case .object(var fields) = details {
            if tool.ntDiff != nil { fields.removeValue(forKey: "diff") }
            return fields.isEmpty ? nil : MobileJSONValue.object(fields).ntPretty
        }
        return details.ntPretty
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            Button { expanded.toggle() } label: {
                HStack(spacing: 10) {
                    MobileGlyph(systemName: tool.ntIcon).frame(width: 20, height: 20).foregroundStyle(palette.secondary)
                    Text(tool.ntLabel).font(.system(size: 15, weight: .semibold))
                    Text(verbatim: tool.ntSummary).font(.system(size: 13, design: .monospaced))
                        .foregroundStyle(palette.secondary).lineLimit(1)
                        .frame(maxWidth: .infinity, alignment: .leading)
                    status
                    MobileGlyph(systemName: expanded ? "chevron.down" : "chevron.right")
                        .frame(width: 16, height: 16).foregroundStyle(palette.secondary)
                }
                .padding(.horizontal, 14).padding(.vertical, 6)
                .frame(minHeight: 48).contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .accessibilityValue("\(tool.status)，\(expanded ? "已展开" : "已收起")")
            if expanded {
                VStack(alignment: .leading, spacing: 8) {
                    if tool.ntDiff == nil, let args = tool.args {
                        NativeTranscriptCode(title: "参数", text: args.ntPretty)
                    }
                    if let diff = tool.ntDiff { NativeTranscriptDiff(text: diff) }
                    if let result = tool.result, !result.isEmpty, result != tool.ntDiff {
                        NativeTranscriptCode(title: tool.ntFailed ? "错误" : "结果", text: result, error: tool.ntFailed)
                    }
                    if let details = visibleDetails {
                        NativeTranscriptCode(title: "详情", text: details)
                    }
                    if let omitted = tool.omitted { NativeTranscriptCode(title: "省略内容", text: omitted.ntPretty) }
                }
                .padding(.horizontal, 14).padding(.bottom, 14)
            }
        }
    }

    @ViewBuilder private var status: some View {
        if ["waiting", "waiting_for_input", "awaiting_confirmation"].contains(tool.status.lowercased()) {
            Text("等待操作").font(.system(size: 12, weight: .semibold)).foregroundStyle(palette.warning)
                .padding(.horizontal, 7).padding(.vertical, 3).background(palette.warning.opacity(0.14), in: Capsule())
        } else if tool.ntRunning {
            ProgressView().controlSize(.small).tint(palette.accent).frame(width: 18, height: 18)
        } else if tool.ntFailed {
            MobileGlyph(systemName: "xmark.circle").frame(width: 18, height: 18).foregroundStyle(palette.danger)
        } else if ["done", "success", "completed", "complete", "ok"].contains(tool.status.lowercased()) {
            if let diff = tool.ntDiff {
                let lines = diff.components(separatedBy: "\n")
                let plus = lines.filter { $0.hasPrefix("+") && !$0.hasPrefix("+++") }.count
                let minus = lines.filter { $0.hasPrefix("-") && !$0.hasPrefix("---") }.count
                Text("+\(plus) −\(minus)").font(.system(size: 12, weight: .semibold)).monospacedDigit()
                    .foregroundStyle(palette.success).padding(.horizontal, 7).padding(.vertical, 3)
                    .background(palette.success.opacity(0.14), in: Capsule())
            } else { MobileGlyph(systemName: "checkmark").frame(width: 18, height: 18).foregroundStyle(palette.success) }
        } else {
            Text(tool.status).font(.system(size: 11)).foregroundStyle(palette.secondary).lineLimit(1)
        }
    }
}

struct NativeTranscriptCode: View {
    var title: String? = nil
    let text: String
    var error = false
    @Environment(\.colorScheme) private var scheme
    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            if let title {
                Text(title).font(.system(size: 12, weight: .semibold))
                    .foregroundStyle(MobilePalette(scheme: scheme).secondary)
            }
            Text(verbatim: text)
                .font(.system(size: 12.5, design: .monospaced))
                .mobileLineHeight(fontSize: 12.5, lineHeight: 19.375, design: .monospaced)
                .foregroundStyle(error ? MobilePalette(scheme: scheme).danger : MobilePalette(scheme: scheme).text)
                .textSelection(.enabled).frame(maxWidth: .infinity, alignment: .leading)
                .padding(.horizontal, 12).padding(.vertical, 10)
                .background(scheme == .dark ? Color.black.opacity(0.32) : Color.white.opacity(0.7), in: RoundedRectangle(cornerRadius: 10))
        }
    }
}

struct NativeTranscriptDiff: View {
    let text: String
    @Environment(\.colorScheme) private var scheme
    var body: some View {
        let palette = MobilePalette(scheme: scheme)
        VStack(alignment: .leading, spacing: 0) {
            ForEach(Array(text.components(separatedBy: "\n").enumerated()), id: \.offset) { _, line in
                let added = line.hasPrefix("+") && !line.hasPrefix("+++")
                let removed = line.hasPrefix("-") && !line.hasPrefix("---")
                Text(verbatim: line.isEmpty ? " " : line)
                    .font(.system(size: 12.5, design: .monospaced))
                    .mobileLineHeight(fontSize: 12.5, lineHeight: 19.375, design: .monospaced)
                    .foregroundStyle(line.hasPrefix("@@") ? palette.secondary : palette.text)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .padding(.horizontal, 12).padding(.vertical, line.hasPrefix("@@") ? 4 : 0)
                    .background(added ? palette.success.opacity(0.14) : (removed ? palette.danger.opacity(0.12) : .clear))
            }
        }
        .textSelection(.enabled)
        .background(scheme == .dark ? Color.black.opacity(0.32) : Color.white.opacity(0.7))
        .clipShape(RoundedRectangle(cornerRadius: 10))
    }
}

/// Small native Markdown projection: paragraphs, headings, lists and fenced code/diffs.
/// Inline emphasis and links are parsed by Foundation. User messages never enter this view.
struct NativeTranscriptMarkdown: View {
    let text: String
    var fontSize: CGFloat = 16
    var textColor: Color? = nil
    var showsCodeLanguage = true
    @Environment(\.colorScheme) private var scheme
    private struct Block: Identifiable {
        let id: Int
        let text: String
        let language: String?
        let heading: Int
    }
    private var blocks: [Block] {
        var result: [Block] = []
        var paragraph: [String] = []
        var fence: String?
        var language = ""
        func flush() {
            guard !paragraph.isEmpty else { return }
            result.append(Block(id: result.count, text: paragraph.joined(separator: "\n"), language: fence == nil ? nil : language, heading: 0))
            paragraph = []
        }
        for line in text.components(separatedBy: "\n") {
            let trimmed = line.trimmingCharacters(in: .whitespaces)
            if let marker = fence {
                if trimmed.hasPrefix(marker) { flush(); fence = nil }
                else { paragraph.append(line) }
            } else if trimmed.hasPrefix("```") || trimmed.hasPrefix("~~~") {
                flush()
                fence = String(trimmed.prefix(3))
                language = String(trimmed.dropFirst(3)).trimmingCharacters(in: .whitespaces)
            } else if trimmed.isEmpty { flush() }
            else if trimmed.hasPrefix("#"), let space = trimmed.firstIndex(of: " "), trimmed[..<space].allSatisfy({ $0 == "#" }) {
                flush()
                result.append(Block(id: result.count, text: String(trimmed[trimmed.index(after: space)...]), language: nil, heading: min(6, trimmed.distance(from: trimmed.startIndex, to: space))))
            } else { paragraph.append(line) }
        }
        flush()
        return result
    }
    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            ForEach(blocks) { block in
                if let language = block.language {
                    if language.lowercased() == "diff" { NativeTranscriptDiff(text: block.text) }
                    else { NativeTranscriptCode(title: !showsCodeLanguage || language.isEmpty ? nil : language, text: block.text) }
                } else {
                    Group {
                        if block.heading > 0 {
                            Text(Self.inline(block.text, size: block.heading == 1 ? 22 : 18, heading: true))
                                .font(.system(size: block.heading == 1 ? 22 : 18, weight: .semibold))
                                .lineSpacing(3.5)
                        } else {
                            Text(Self.inline(block.text, size: fontSize))
                                .font(MobileTypography.system(size: fontSize))
                                .mobileLineHeight(fontSize: fontSize, lineHeight: fontSize * 1.47)
                        }
                    }
                    .textSelection(.enabled)
                    .fixedSize(horizontal: false, vertical: true)
                    .frame(maxWidth: .infinity, alignment: .leading)
                }
            }
        }
        .foregroundStyle(textColor ?? MobilePalette(scheme: scheme).text)
    }
    static func inline(_ text: String, size: CGFloat, heading: Bool = false) -> AttributedString {
        var attributed = (try? AttributedString(markdown: text, options: .init(interpretedSyntax: .inlineOnlyPreservingWhitespace))) ?? AttributedString(text)
        // Headings retain their existing system font and Foundation trait handling.
        guard !heading else { return attributed }
        for run in Array(attributed.runs) {
            let intent = run.inlinePresentationIntent ?? []
            attributed[run.range].font = MobileTypography.system(
                size: intent.contains(.code) ? size * 13.5 / 16 : size,
                weight: intent.contains(.stronglyEmphasized) ? .bold : .regular,
                italic: intent.contains(.emphasized),
                design: intent.contains(.code) ? .monospaced : .default
            )
            // These traits are now in the explicit font. Applying them a second
            // time would derive another descriptor and drop its Chinese cascade.
            let remaining = intent.subtracting([.stronglyEmphasized, .emphasized, .code])
            attributed[run.range].inlinePresentationIntent = remaining.isEmpty ? nil : remaining
        }
        return attributed
    }
}

struct NativeTranscriptQueue: View {
    let queue: MobileQueueState
    let onRemove: (String) -> Void
    @Environment(\.colorScheme) private var scheme
    var body: some View {
        let palette = MobilePalette(scheme: scheme)
        MobileGlassPanel(radius: 22) {
            VStack(alignment: .leading, spacing: 0) {
                Text(queue.paused ? "排队已暂停" : "排队中 · 回复结束后发送")
                    .font(.system(size: 12, weight: .semibold)).foregroundStyle(palette.secondary)
                    .padding(.top, 6)
                ScrollView {
                    VStack(spacing: 0) {
                        ForEach(Array(queue.items.enumerated()), id: \.offset) { _, item in
                            HStack(spacing: 8) {
                                Text(verbatim: item.ntString("text") ?? "图片消息")
                                    .font(.system(size: 14)).lineLimit(1)
                                    .frame(maxWidth: .infinity, alignment: .leading)
                                if let id = item.ntString("id") {
                                    Button { onRemove(id) } label: {
                                        MobileGlyph(systemName: "xmark").frame(width: 20, height: 20)
                                            .foregroundStyle(palette.secondary).frame(width: 44, height: 44)
                                            .contentShape(Rectangle())
                                    }
                                    .buttonStyle(.plain).accessibilityLabel("取消排队")
                                }
                            }
                            .frame(minHeight: 44)
                        }
                    }
                }
                .frame(height: min(CGFloat(queue.items.count) * 44, 132))
            }
            .padding(.leading, 14).padding(.trailing, 6).padding(.vertical, 4)
        }
    }
}

private struct NativePendingOption: Identifiable {
    let id: Int
    let value: String
    let label: String
    let detail: String?
    static func parse(_ options: MobileJSONValue?, details: MobileJSONValue?) -> [NativePendingOption] {
        (options?.ntArray ?? []).enumerated().compactMap { index, item in
            let value = item.ntStringValue ?? item.ntString("value") ?? item.ntString("id") ?? item.ntString("label") ?? item.ntString("title")
            guard let value else { return nil }
            let label = item.ntString("label") ?? item.ntString("title") ?? item.ntString("name") ?? value
            let detailRows = details?.ntArray ?? []
            let detail = item.ntString("description") ?? item.ntString("detail") ?? (detailRows.indices.contains(index) ? detailRows[index].ntString("description") ?? detailRows[index].ntString("detail") : nil)
            return NativePendingOption(id: index, value: value, label: label, detail: detail)
        }
    }
}

struct NativePendingOperationSheet: View {
    let request: MobileJSONValue
    let count: Int
    let context: String
    let maximumHeight: CGFloat
    let onRespond: (MobileJSONValue) -> Void
    @State private var input: String
    @State private var selected: String?
    @State private var answers: [Int: String] = [:]
    @Environment(\.colorScheme) private var scheme
    @AccessibilityFocusState private var titleFocused: Bool
    private var palette: MobilePalette { MobilePalette(scheme: scheme) }
    private var method: String { request.ntString("method") ?? "" }
    private var options: [NativePendingOption] { NativePendingOption.parse(request.ntField("options"), details: request.ntField("optionDetails")) }
    private var questions: [MobileJSONValue] { request.ntField("questions")?.ntArray ?? [] }
    private var messageParts: (summary: String, body: String?) {
        let message = request.ntString("message") ?? ""
        guard let fence = message.range(of: "```") ?? message.range(of: "~~~") else { return (message, nil) }
        return (String(message[..<fence.lowerBound]).trimmingCharacters(in: .whitespacesAndNewlines), String(message[fence.lowerBound...]))
    }

    init(request: MobileJSONValue, count: Int, context: String, maximumHeight: CGFloat, onRespond: @escaping (MobileJSONValue) -> Void) {
        self.request = request; self.count = count; self.context = context; self.maximumHeight = maximumHeight; self.onRespond = onRespond
        self._input = State(initialValue: request.ntString("prefill") ?? "")
        self._selected = State(initialValue: NativePendingOption.parse(request.ntField("options"), details: request.ntField("optionDetails")).first?.value)
    }

    var body: some View {
        ViewThatFits(in: .vertical) {
            content
            ScrollView { content }.frame(height: maximumHeight)
        }
        .frame(maxWidth: .infinity)
        .frame(maxHeight: maximumHeight)
        .fixedSize(horizontal: false, vertical: true)
        .clipShape(RoundedRectangle(cornerRadius: 40, style: .continuous))
        .background { MobileGlassSurface(kind: .sheet, radius: 40) }
        .accessibilityAddTraits(.isModal)
        .onAppear { titleFocused = true }
    }

    private var content: some View {
        VStack(alignment: .leading, spacing: 14) {
            Capsule().fill(palette.secondary.opacity(0.35)).frame(width: 36, height: 5)
                .frame(maxWidth: .infinity).padding(.bottom, 4).accessibilityHidden(true)
            HStack(alignment: .top, spacing: 12) {
                MobileGlyph(systemName: method == "confirm" ? "checkmark.shield" : (method == "select" ? "checklist" : "character.cursor.ibeam"))
                    .frame(width: 20, height: 20).foregroundStyle(palette.warning)
                    .frame(width: 44, height: 44)
                    .background(palette.warning.opacity(0.16), in: RoundedRectangle(cornerRadius: 14))
                VStack(alignment: .leading, spacing: 4) {
                    Text(request.ntString("title") ?? "需要你的操作")
                        .font(.system(size: 18, weight: .bold))
                        .accessibilityAddTraits(.isHeader).accessibilityFocused($titleFocused)
                    if !messageParts.summary.isEmpty {
                        NativeTranscriptMarkdown(text: messageParts.summary, fontSize: 14, textColor: palette.secondary)
                    }
                    if count > 1 {
                        Text("等待操作 · 还有 \(count - 1) 项")
                            .font(.system(size: 12)).foregroundStyle(palette.warning)
                    }
                }
                .frame(maxWidth: .infinity, alignment: .leading)
            }
            if let body = messageParts.body {
                NativeTranscriptMarkdown(text: body, fontSize: 14, showsCodeLanguage: false)
            }
            if let command = request.ntString("command"), !command.isEmpty {
                NativeTranscriptCode(text: command)
            }
            switch method {
            case "select":
                VStack(spacing: 8) {
                    ForEach(options) { option in
                        optionButton(option, selected: selected == option.value) { selected = option.value }
                    }
                }
                actions(cancel: "跳过", submit: "确定", enabled: selected != nil) {
                    if let selected { respond(["value": .string(selected)]) }
                }
            case "input", "editor":
                inputField(value: $input, placeholder: request.ntString("placeholder") ?? "请输入")
                actions(cancel: "取消", submit: "提交") { respond(["value": .string(input)]) }
            case "questions":
                questionFields
                actions(cancel: "取消", submit: "提交", enabled: questionsAnswered) {
                    respond(["answers": .array(questions.indices.map { index in answers[index].map { .string($0) } ?? .null })])
                }
            default:
                actions(cancel: "拒绝", submit: "允许") { respond(["confirmed": .bool(true)]) }
            }
        }
        .padding(.top, 10).padding(.horizontal, 22).padding(.bottom, 22)
        .frame(maxWidth: .infinity, alignment: .leading)
        .accessibilityLabel(context.isEmpty ? "等待操作" : "\(context)，等待操作")
    }

    private func respond(_ fields: [String: MobileJSONValue]) {
        // No optimistic dismissal: only removal from snapshot.pendingUI settles a prompt.
        onRespond(.object(fields))
    }

    private func actions(cancel: String, submit: String, enabled: Bool = true, action: @escaping () -> Void) -> some View {
        HStack(spacing: 10) {
            Button {
                respond(method == "confirm" ? ["confirmed": .bool(false)] : ["cancelled": .bool(true)])
            } label: {
                Text(cancel).font(.system(size: 16, weight: .semibold)).frame(maxWidth: .infinity).frame(minHeight: 52)
                    .background { NativeTranscriptControlBackground(radius: 26) }
            }
            .buttonStyle(.plain)
            Button(action: action) {
                Text(submit).font(.system(size: 16, weight: .semibold)).foregroundStyle(.white)
                    .frame(maxWidth: .infinity).frame(minHeight: 52)
                    .background { MobileAccentSurface(shape: Capsule()) }
                    .opacity(enabled ? 1 : 0.45)
            }
            .buttonStyle(.plain).disabled(!enabled)
        }
    }

    private func optionButton(_ option: NativePendingOption, selected: Bool, action: @escaping () -> Void) -> some View {
        Button(action: action) {
            HStack(spacing: 12) {
                Circle().strokeBorder(selected ? palette.accent : palette.secondary.opacity(0.5), lineWidth: 1.5)
                    .overlay { if selected { Circle().fill(palette.accent).padding(5) } }
                    .frame(width: 22, height: 22)
                VStack(alignment: .leading, spacing: 2) {
                    Text(verbatim: option.label).font(.system(size: 16))
                    if let detail = option.detail { Text(verbatim: detail).font(.system(size: 13)).foregroundStyle(palette.secondary) }
                }
                .frame(maxWidth: .infinity, alignment: .leading)
            }
            .padding(.horizontal, 14).padding(.vertical, 8).frame(minHeight: 56)
            .background(selected ? palette.accent.opacity(0.13) : Color(hex: 0x767680).opacity(scheme == .dark ? 0.24 : 0.12), in: RoundedRectangle(cornerRadius: 18))
            .overlay { RoundedRectangle(cornerRadius: 18).strokeBorder(selected ? palette.accent.opacity(0.55) : .clear, lineWidth: 1.5) }
            .contentShape(RoundedRectangle(cornerRadius: 18))
        }
        .buttonStyle(.plain)
        .accessibilityAddTraits(selected ? [.isSelected] : [])
    }

    private func inputField(value: Binding<String>, placeholder: String) -> some View {
        TextField(placeholder, text: value, axis: .vertical)
            .font(.system(size: 16)).textFieldStyle(.plain).lineLimit(3...8)
            .padding(.horizontal, 14).padding(.vertical, 12)
            .frame(minHeight: 96, alignment: .topLeading)
            .background(Color(hex: 0x767680).opacity(scheme == .dark ? 0.24 : 0.12), in: RoundedRectangle(cornerRadius: 18))
            .accessibilityLabel(placeholder)
    }

    private var questionFields: some View {
        VStack(alignment: .leading, spacing: 14) {
            ForEach(Array(questions.enumerated()), id: \.offset) { index, question in
                VStack(alignment: .leading, spacing: 8) {
                    Text(question.ntString("question") ?? question.ntString("prompt") ?? question.ntString("label") ?? "请输入")
                        .font(.system(size: 16, weight: .medium))
                    let rows = NativePendingOption.parse(question.ntField("options"), details: question.ntField("optionDetails"))
                    ForEach(rows) { row in
                        optionButton(row, selected: answers[index] == row.value) { answers[index] = row.value }
                    }
                    if rows.isEmpty || question.ntField("allowOther")?.ntBool == true || question.ntField("allow_other")?.ntBool == true {
                        inputField(value: Binding(get: { answers[index] ?? "" }, set: { answers[index] = $0 }), placeholder: question.ntString("placeholder") ?? "请输入")
                    }
                }
            }
        }
    }
    private var questionsAnswered: Bool {
        questions.enumerated().allSatisfy { index, question in
            question.ntField("required")?.ntBool != true || !(answers[index] ?? "").trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
        }
    }
}
