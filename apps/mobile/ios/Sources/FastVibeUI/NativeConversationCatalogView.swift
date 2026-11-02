import SwiftUI

internal struct NativeConversation: Identifiable, Hashable {
    let id: String
    let title: String
    let preview: String
    let projectName: String
    let projectPath: String?
    let updatedAt: Date
    let running: Bool
    let waiting: Bool
    let unread: Bool
    let archived: Bool
}

internal struct NativeProject: Identifiable, Hashable {
    let id: String
    let name: String
    let path: String
}

internal struct NativeConversationCatalogView: View {
    let deviceName: String
    let conversations: [NativeConversation]
    let projects: [NativeProject]
    let isLoading: Bool
    let onBack: () -> Void
    let onSelect: (NativeConversation) -> Void
    let onCreate: (NativeProject?) -> Void

    @Environment(\.colorScheme) private var colorScheme
    @State private var searchText = ""
    @State private var statusFilter: StatusFilter = .all
    @State private var projectFilter: ProjectFilter = .all
    @State private var presentedSheet: PresentedSheet?

    private var palette: MobilePalette {
        MobilePalette(scheme: colorScheme)
    }

    private var filteredConversations: [NativeConversation] {
        let query = searchText.trimmingCharacters(in: .whitespacesAndNewlines)
            .localizedLowercase

        return conversations
            .sorted { $0.updatedAt > $1.updatedAt }
            .filter { conversation in
                matchesStatus(conversation) &&
                    matchesProject(conversation) &&
                    (query.isEmpty || searchableText(for: conversation).localizedLowercase.contains(query))
            }
    }

    private var hasActiveFilter: Bool {
        statusFilter != .all || projectFilter != .all
    }

    var body: some View {
        ZStack {
            ScrollView {
                LazyVStack(spacing: 0) {
                    catalogHeader
                    searchField
                    catalogContent
                }
                .padding(.top, 52)
                .padding(.bottom, 112)
            }
            .scrollIndicators(.hidden)
            .overlay(alignment: .top) {
                navigationChrome
            }

            newConversationButton

            if let presentedSheet {
                sheetOverlay(presentedSheet)
            }
        }
        .animation(.easeOut(duration: 0.2), value: presentedSheet)
    }

    private var navigationHeader: some View {
        HStack(spacing: 8) {
            MobileIconButton(systemName: "chevron.left", label: "返回电脑列表", action: onBack)

            HStack(spacing: 8) {
                Image(systemName: "desktopcomputer")
                    .font(.system(size: 17, weight: .medium))
                    .accessibilityHidden(true)

                Text(deviceName.isEmpty ? "这台电脑" : deviceName)
                    .font(.system(size: 15, weight: .semibold))
                    .lineLimit(1)
                    .truncationMode(.tail)

                HStack(spacing: 5) {
                    Circle()
                        .fill(palette.success)
                        .frame(width: 7, height: 7)
                    Text("已连接")
                        .font(.system(size: 12, weight: .semibold))
                        .foregroundStyle(palette.success)
                }
                .fixedSize()
            }
            .foregroundStyle(palette.text)
            .padding(.horizontal, 12)
            .frame(minHeight: 40)
            .background { MobileGlassSurface(kind: .control, radius: 22) }
            .fixedSize(horizontal: false, vertical: true)

            Spacer(minLength: 0)
        }
        .padding(.horizontal, 12)
        .padding(.top, 8)
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    private var navigationChrome: some View {
        navigationHeader
            .background(alignment: .top) {
                MobileGlassSurface(kind: .navigation, radius: 0)
                    .frame(height: 80)
                    .ignoresSafeArea(edges: .top)
                    .allowsHitTesting(false)
            }
    }

    private var catalogHeader: some View {
        HStack(alignment: .center, spacing: 12) {
            Text("会话")
                .font(.system(size: 34, weight: .bold))
                .tracking(-0.7)
                .foregroundStyle(palette.text)

            Spacer(minLength: 0)

            ZStack(alignment: .topTrailing) {
                MobileIconButton(
                    systemName: "line.3.horizontal.decrease",
                    label: "筛选会话"
                ) {
                    presentedSheet = .filters
                }

                if hasActiveFilter {
                    Circle()
                        .fill(palette.accent)
                        .frame(width: 8, height: 8)
                        .overlay(Circle().stroke(palette.panelTint, lineWidth: 1.5))
                        .offset(x: -3, y: 3)
                        .accessibilityHidden(true)
                }
            }
        }
        .padding(.horizontal, 20)
        .padding(.top, 10)
        .padding(.bottom, 12)
    }

    private var searchField: some View {
        HStack(spacing: 8) {
            Image(systemName: "magnifyingglass")
                .font(.system(size: 16, weight: .medium))
                .foregroundStyle(palette.secondary)
                .accessibilityHidden(true)

            TextField("搜索会话", text: $searchText)
                .font(.system(size: 16))
                .foregroundStyle(palette.text)
                .textFieldStyle(.plain)
                #if os(iOS)
                .textInputAutocapitalization(.never)
                #endif
                .autocorrectionDisabled()
                .submitLabel(.search)

            if !searchText.isEmpty {
                Button {
                    searchText = ""
                } label: {
                    Image(systemName: "xmark.circle.fill")
                        .font(.system(size: 16))
                        .foregroundStyle(palette.secondary)
                }
                .buttonStyle(.plain)
                .accessibilityLabel("清除搜索")
            }
        }
        .padding(.horizontal, 13)
        .frame(height: 40)
        .background { MobileGlassSurface(kind: .control, radius: 20) }
        .padding(.horizontal, 16)
        .padding(.bottom, 10)
    }

    @ViewBuilder
    private var catalogContent: some View {
        if isLoading {
            emptyState(
                systemName: "arrow.triangle.2.circlepath",
                title: "正在加载会话",
                detail: "正在从 \(deviceName.isEmpty ? "电脑" : deviceName) 同步最新内容。",
                showsProgress: true
            )
        } else if filteredConversations.isEmpty {
            if conversations.isEmpty && searchText.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty && !hasActiveFilter {
                emptyState(
                    systemName: "bubble.left.and.bubble.right",
                    title: "还没有会话",
                    detail: "点击右下角的新对话，开始一次新的工作。"
                )
            } else {
                emptyState(
                    systemName: "magnifyingglass",
                    title: "没有匹配的会话",
                    detail: "试试其他关键词，或清除筛选条件。"
                )
            }
        } else {
            LazyVStack(spacing: 0) {
                ForEach(Array(filteredConversations.enumerated()), id: \.element.id) { index, conversation in
                    conversationRow(conversation, isFirst: index == 0)
                }
            }
        }
    }

    private func conversationRow(_ conversation: NativeConversation, isFirst: Bool) -> some View {
        Button {
            onSelect(conversation)
        } label: {
            HStack(alignment: .top, spacing: 12) {
                VStack(alignment: .leading, spacing: 3) {
                    Text(conversation.title.isEmpty ? "未命名会话" : conversation.title)
                        .font(.system(size: 15.5, weight: .semibold))
                        .foregroundStyle(palette.text)
                        .lineLimit(1)
                        .truncationMode(.tail)

                    Text(conversation.preview.isEmpty ? "暂无回复" : conversation.preview)
                        .font(.system(size: 13.5))
                        .foregroundStyle(palette.secondary)
                        .lineLimit(1)
                        .truncationMode(.tail)

                    HStack(spacing: 4) {
                        Image(systemName: isUnassigned(conversation) ? "bubble.left" : "folder")
                            .font(.system(size: 11, weight: .medium))
                            .accessibilityHidden(true)
                        Text(isUnassigned(conversation) ? "未归属项目" : conversation.projectName)
                            .lineLimit(1)
                            .truncationMode(.tail)
                    }
                    .font(.system(size: 12))
                    .foregroundStyle(palette.secondary)
                }
                .frame(maxWidth: .infinity, alignment: .leading)

                VStack(alignment: .trailing, spacing: 7) {
                    Text(relativeTime(conversation.updatedAt))
                        .font(.system(size: 13))
                        .foregroundStyle(palette.secondary)
                        .fixedSize()

                    statusView(for: conversation)
                }
                .padding(.top, 2)
                .fixedSize(horizontal: true, vertical: false)
            }
            .padding(.horizontal, 16)
            .padding(.vertical, 12)
            .frame(minHeight: 70)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .overlay(alignment: .top) {
            if !isFirst {
                Rectangle()
                    .fill(palette.panelTint.opacity(0.7))
                    .frame(height: 0.5)
                    .padding(.leading, 16)
            }
        }
    }

    @ViewBuilder
    private func statusView(for conversation: NativeConversation) -> some View {
        if conversation.running {
            statusBadge(title: "运行中", systemName: nil, color: palette.accent) {
                ProgressView()
                    .controlSize(.mini)
                    .tint(palette.accent)
            }
        } else if conversation.waiting {
            statusBadge(title: "等你操作", systemName: "hand.raised.fill", color: palette.warning)
        } else if conversation.archived {
            statusBadge(title: "已归档", systemName: "archivebox.fill", color: palette.secondary)
        } else if conversation.unread {
            Circle()
                .fill(palette.accent)
                .frame(width: 8, height: 8)
                .accessibilityLabel("未读")
        }
    }

    private func statusBadge<Icon: View>(
        title: String,
        systemName: String?,
        color: Color,
        @ViewBuilder icon: () -> Icon
    ) -> some View {
        HStack(spacing: 4) {
            icon()
                .frame(width: 13, height: 13)
            Text(title)
        }
        .font(.system(size: 12, weight: .semibold))
        .foregroundStyle(color)
        .padding(.horizontal, 8)
        .frame(minHeight: 22)
        .background(color.opacity(0.14), in: Capsule())
        .fixedSize()
        .accessibilityElement(children: .combine)
    }

    private func statusBadge(
        title: String,
        systemName: String,
        color: Color
    ) -> some View {
        statusBadge(title: title, systemName: Optional(systemName), color: color) {
            Image(systemName: systemName)
                .font(.system(size: 11, weight: .semibold))
        }
    }

    private var newConversationButton: some View {
        Button {
            presentedSheet = .newConversation
        } label: {
            Image(systemName: "square.and.pencil")
                .font(.system(size: 24, weight: .semibold))
                .foregroundStyle(.white)
                .frame(width: 64, height: 64)
                .background { MobileAccentSurface(shape: Circle()) }
        }
        .buttonStyle(.plain)
        .accessibilityLabel("新对话")
        .padding(.trailing, 16)
        .padding(.bottom, 30)
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .bottomTrailing)
    }

    @ViewBuilder
    private func sheetOverlay(_ sheet: PresentedSheet) -> some View {
        ZStack(alignment: .bottom) {
            (colorScheme == .dark ? Color.black.opacity(0.5) : Color(hex: 0x141828).opacity(0.2))
                .ignoresSafeArea()
                .contentShape(Rectangle())
                .onTapGesture { presentedSheet = nil }

            VStack(spacing: 0) {
                Capsule()
                    .fill(palette.secondary.opacity(0.35))
                    .frame(width: 36, height: 5)
                    .padding(.top, 8)
                    .padding(.bottom, 12)

                switch sheet {
                case .filters:
                    filterSheet
                case .newConversation:
                    newConversationSheet
                }
            }
            .padding(.horizontal, 20)
            .padding(.bottom, 8)
            .background { MobileGlassSurface(kind: .sheet, radius: 40) }
            .padding(.horizontal, 8)
            .padding(.bottom, 8)
            .transition(.move(edge: .bottom).combined(with: .opacity))
        }
        .zIndex(10)
    }

    private var filterSheet: some View {
        VStack(alignment: .leading, spacing: 0) {
            sheetHeader(title: "筛选会话", subtitle: nil)

            Text("状态")
                .font(.system(size: 13, weight: .semibold))
                .foregroundStyle(palette.secondary)
                .padding(.top, 2)
                .padding(.bottom, 8)

            VStack(spacing: 8) {
                ForEach(StatusFilter.allCases) { filter in
                    filterChoice(
                        title: filter.title,
                        subtitle: nil,
                        isSelected: statusFilter == filter
                    ) {
                        statusFilter = filter
                    }
                }
            }

            Text("项目")
                .font(.system(size: 13, weight: .semibold))
                .foregroundStyle(palette.secondary)
                .padding(.top, 18)
                .padding(.bottom, 8)

            ScrollView {
                VStack(spacing: 8) {
                    filterChoice(title: "所有项目", subtitle: nil, isSelected: projectFilter == .all) {
                        projectFilter = .all
                    }

                    ForEach(projects) { project in
                        filterChoice(
                            title: project.name,
                            subtitle: project.path,
                            isSelected: projectFilter == .project(project.id)
                        ) {
                            projectFilter = .project(project.id)
                        }
                    }

                    filterChoice(
                        title: "未归属项目",
                        subtitle: "不绑定项目的会话",
                        isSelected: projectFilter == .unassigned
                    ) {
                        projectFilter = .unassigned
                    }
                }
            }
            .frame(maxHeight: 220)

            Button("完成") {
                presentedSheet = nil
            }
            .font(.system(size: 16, weight: .semibold))
            .foregroundStyle(.white)
            .frame(maxWidth: .infinity, minHeight: 52)
            .background(palette.accent, in: Capsule())
            .padding(.top, 16)
        }
    }

    private var newConversationSheet: some View {
        VStack(alignment: .leading, spacing: 0) {
            sheetHeader(title: "新建会话", subtitle: "选择这次会话的项目")

            ScrollView {
                VStack(spacing: 0) {
                    ForEach(projects) { project in
                        projectOption(project: project)
                    }

                    projectOption(project: nil)
                }
            }
            .frame(maxHeight: 310)
        }
    }

    private func sheetHeader(title: String, subtitle: String?) -> some View {
        HStack(alignment: .top, spacing: 12) {
            VStack(alignment: .leading, spacing: 4) {
                Text(title)
                    .font(.system(size: 18, weight: .bold))
                    .foregroundStyle(palette.text)
                if let subtitle {
                    Text(subtitle)
                        .font(.system(size: 14))
                        .foregroundStyle(palette.secondary)
                }
            }

            Spacer(minLength: 0)

            MobileIconButton(systemName: "xmark", label: "关闭") {
                presentedSheet = nil
            }
        }
        .padding(.bottom, 16)
    }

    private func filterChoice(
        title: String,
        subtitle: String?,
        isSelected: Bool,
        action: @escaping () -> Void
    ) -> some View {
        Button(action: action) {
            HStack(spacing: 12) {
                VStack(alignment: .leading, spacing: 2) {
                    Text(title)
                        .font(.system(size: 16, weight: .medium))
                        .foregroundStyle(palette.text)
                    if let subtitle {
                        Text(subtitle)
                            .font(.system(size: 13))
                            .foregroundStyle(palette.secondary)
                            .lineLimit(1)
                    }
                }

                Spacer(minLength: 0)

                Image(systemName: isSelected ? "checkmark.circle.fill" : "circle")
                    .font(.system(size: 22, weight: .medium))
                    .foregroundStyle(isSelected ? palette.accent : palette.secondary)
            }
            .padding(.horizontal, 14)
            .frame(minHeight: subtitle == nil ? 48 : 58)
            .background(
                isSelected ? palette.accent.opacity(0.1) : palette.panelTint.opacity(0.42),
                in: RoundedRectangle(cornerRadius: 14, style: .continuous)
            )
            .contentShape(RoundedRectangle(cornerRadius: 14, style: .continuous))
        }
        .buttonStyle(.plain)
    }

    private func projectOption(project: NativeProject?) -> some View {
        Button {
            presentedSheet = nil
            onCreate(project)
        } label: {
            HStack(spacing: 12) {
                Image(systemName: project == nil ? "bubble.left" : "folder")
                    .font(.system(size: 18, weight: .medium))
                    .foregroundStyle(project == nil ? palette.secondary : palette.accent)
                    .frame(width: 44, height: 44)
                    .background(
                        (project == nil ? palette.secondary : palette.accent).opacity(0.14),
                        in: RoundedRectangle(cornerRadius: 14, style: .continuous)
                    )

                VStack(alignment: .leading, spacing: 4) {
                    Text(project?.name ?? "未归属项目")
                        .font(.system(size: 16, weight: .semibold))
                        .foregroundStyle(palette.text)
                    Text(project?.path ?? "不绑定项目，直接开始会话")
                        .font(.system(size: 13))
                        .foregroundStyle(palette.secondary)
                        .lineLimit(1)
                        .truncationMode(.middle)
                }
                .frame(maxWidth: .infinity, alignment: .leading)

                Image(systemName: "chevron.right")
                    .font(.system(size: 14, weight: .semibold))
                    .foregroundStyle(palette.secondary)
            }
            .padding(.vertical, 10)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .overlay(alignment: .top) {
            Rectangle()
                .fill(palette.panelTint.opacity(0.7))
                .frame(height: 0.5)
                .padding(.leading, 56)
        }
    }

    private func emptyState(
        systemName: String,
        title: String,
        detail: String,
        showsProgress: Bool = false
    ) -> some View {
        VStack(spacing: 12) {
            if showsProgress {
                ProgressView()
                    .controlSize(.regular)
                    .tint(palette.accent)
                    .frame(width: 32, height: 32)
            } else {
                Image(systemName: systemName)
                    .font(.system(size: 28, weight: .medium))
                    .foregroundStyle(palette.secondary)
                    .frame(width: 56, height: 56)
                    .background(palette.controlTint, in: Circle())
            }

            Text(title)
                .font(.system(size: 17, weight: .semibold))
                .foregroundStyle(palette.text)

            Text(detail)
                .font(.system(size: 14))
                .foregroundStyle(palette.secondary)
                .multilineTextAlignment(.center)
                .frame(maxWidth: 270)
        }
        .frame(maxWidth: .infinity)
        .padding(.horizontal, 32)
        .padding(.top, 96)
        .padding(.bottom, 40)
    }

    private func matchesStatus(_ conversation: NativeConversation) -> Bool {
        switch statusFilter {
        case .all:
            return !conversation.archived
        case .running:
            return conversation.running
        case .waiting:
            return conversation.waiting
        case .unread:
            return conversation.unread
        case .archived:
            return conversation.archived
        }
    }

    private func matchesProject(_ conversation: NativeConversation) -> Bool {
        switch projectFilter {
        case .all:
            return true
        case .unassigned:
            return isUnassigned(conversation)
        case .project(let projectID):
            guard let project = projects.first(where: { $0.id == projectID }) else { return false }
            return conversation.projectPath == project.path || conversation.projectName == project.name
        }
    }

    private func isUnassigned(_ conversation: NativeConversation) -> Bool {
        conversation.projectPath?.isEmpty != false && conversation.projectName.isEmpty
    }

    private func searchableText(for conversation: NativeConversation) -> String {
        [conversation.title, conversation.preview, conversation.projectName].joined(separator: " ")
    }

    private func relativeTime(_ date: Date) -> String {
        let now = Date()
        let seconds = max(0, Int(now.timeIntervalSince(date)))
        if seconds < 60 { return "刚刚" }
        if seconds < 60 * 60 { return "\(seconds / 60) 分钟" }
        if seconds < 24 * 60 * 60 { return "\(seconds / (60 * 60)) 小时" }

        let calendar = Calendar.current
        if calendar.isDateInYesterday(date) { return "昨天" }
        if seconds < 7 * 24 * 60 * 60 {
            let symbols = ["周日", "周一", "周二", "周三", "周四", "周五", "周六"]
            return symbols[calendar.component(.weekday, from: date) - 1]
        }

        let formatter = DateFormatter()
        formatter.locale = Locale(identifier: "zh_CN")
        formatter.dateFormat = "M月d日"
        return formatter.string(from: date)
    }
}

private enum PresentedSheet: Identifiable {
    case filters
    case newConversation

    var id: String {
        switch self {
        case .filters: return "filters"
        case .newConversation: return "new-conversation"
        }
    }
}

private enum StatusFilter: String, CaseIterable, Identifiable {
    case all
    case running
    case waiting
    case unread
    case archived

    var id: String { rawValue }

    var title: String {
        switch self {
        case .all: return "全部会话"
        case .running: return "运行中"
        case .waiting: return "等你操作"
        case .unread: return "未读"
        case .archived: return "已归档"
        }
    }
}

private enum ProjectFilter: Hashable {
    case all
    case unassigned
    case project(String)
}

#Preview("Native conversation catalog") {
    NativeConversationCatalogView(
        deviceName: "Yuan 的 MacBook Pro",
        conversations: [
            NativeConversation(
                id: "running",
                title: "修复远程连接偶发断开",
                preview: "正在编辑 backpressure.ts…",
                projectName: "fastvibe",
                projectPath: "/Users/yuantang/code/fastvibe",
                updatedAt: .now,
                running: true,
                waiting: false,
                unread: false,
                archived: false
            ),
            NativeConversation(
                id: "waiting",
                title: "发布 0.9.2 版本",
                preview: "要推送 tag v0.9.2 吗？",
                projectName: "fastvibe",
                projectPath: "/Users/yuantang/code/fastvibe",
                updatedAt: .now.addingTimeInterval(-120),
                running: false,
                waiting: true,
                unread: false,
                archived: false
            ),
            NativeConversation(
                id: "unread",
                title: "设置页的远程访问改版",
                preview: "已完成，改动了 6 个文件，测试全部通过。",
                projectName: "fastvibe-services",
                projectPath: "/Users/yuantang/code/fastvibe-services",
                updatedAt: .now.addingTimeInterval(-2_280),
                running: false,
                waiting: false,
                unread: true,
                archived: false
            ),
            NativeConversation(
                id: "unassigned",
                title: "记录一个新想法",
                preview: "先整理思路，稍后再关联到项目。",
                projectName: "",
                projectPath: nil,
                updatedAt: .now.addingTimeInterval(-172_800),
                running: false,
                waiting: false,
                unread: false,
                archived: false
            ),
        ],
        projects: [
            NativeProject(id: "fastvibe", name: "fastvibe", path: "~/code/fastvibe"),
            NativeProject(id: "services", name: "fastvibe-services", path: "~/code/fastvibe-services"),
        ],
        isLoading: false,
        onBack: {},
        onSelect: { _ in },
        onCreate: { _ in }
    )
}
