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
    @State private var filterChoicesHeight: CGFloat = 0

    init(
        deviceName: String,
        conversations: [NativeConversation],
        projects: [NativeProject],
        isLoading: Bool,
        onBack: @escaping () -> Void,
        onSelect: @escaping (NativeConversation) -> Void,
        onCreate: @escaping (NativeProject?) -> Void,
        initialOverlay: String? = nil,
        initialStatusFilter: String = "all"
    ) {
        self.deviceName = deviceName
        self.conversations = conversations
        self.projects = projects
        self.isLoading = isLoading
        self.onBack = onBack
        self.onSelect = onSelect
        self.onCreate = onCreate
        _presentedSheet = State(initialValue: initialOverlay == "project" ? .newConversation : initialOverlay == "filter" ? .filters : nil)
        _statusFilter = State(initialValue: StatusFilter(rawValue: initialStatusFilter) ?? .all)
    }

    private var palette: MobilePalette { MobilePalette(scheme: colorScheme) }
    private var border: Color { colorScheme == .dark ? .white.opacity(0.09) : Color(hex: 0x3C3C43).opacity(0.13) }
    private var muted: Color { Color(hex: 0x767680).opacity(colorScheme == .dark ? 0.24 : 0.12) }
    private var filteredConversations: [NativeConversation] {
        let query = searchText.trimmingCharacters(in: .whitespacesAndNewlines).localizedLowercase
        return conversations.sorted { $0.updatedAt > $1.updatedAt }.filter { conversation in
            matchesStatus(conversation) && matchesProject(conversation) &&
                (query.isEmpty || [conversation.title, conversation.preview, conversation.projectName].joined(separator: " ").localizedLowercase.contains(query))
        }
    }
    private var hasActiveFilter: Bool { statusFilter != .all || projectFilter != .all }

    var body: some View {
        GeometryReader { geometry in
            ZStack(alignment: .bottomTrailing) {
                ScrollView {
                    VStack(spacing: 0) {
                        navigationHeader
                        catalogHeader
                        searchField
                        catalogContent
                    }
                    .padding(.top, 50)
                    .padding(.bottom, 112)
                }
                .scrollIndicators(.hidden)
                newConversationButton
                if let presentedSheet {
                    sheetOverlay(presentedSheet, maximumHeight: geometry.size.height - 60)
                }
            }
        }
        .ignoresSafeArea()
        .foregroundStyle(palette.text)
        .animation(.easeOut(duration: 0.2), value: presentedSheet)
    }

    private var navigationHeader: some View {
        HStack(spacing: 8) {
            MobileIconButton(systemName: "chevron.left", label: "返回电脑列表", action: onBack)
            HStack(spacing: 8) {
                MobileGlyph(systemName: "desktopcomputer")
                    .frame(width: 16, height: 16)
                    .foregroundStyle(palette.secondary)
                Text(deviceName.isEmpty ? "这台电脑" : deviceName)
                    .font(.system(size: 13, weight: .semibold))
                    .lineLimit(1)
                    .truncationMode(.tail)
                HStack(spacing: 4) {
                    Circle().fill(palette.success).frame(width: 5, height: 5)
                    Text("已连接").font(.system(size: 11, weight: .medium))
                }
                .foregroundStyle(palette.success)
                .padding(.horizontal, 7)
                .frame(height: 20)
                .background(palette.success.opacity(0.12), in: Capsule())
                .fixedSize()
            }
            .padding(.leading, 12).padding(.trailing, 8)
            .frame(height: 38)
            .background { MobileGlassSurface(kind: .control, radius: 19) }
            .fixedSize(horizontal: false, vertical: true)
            Spacer(minLength: 0)
        }
        .padding(.horizontal, 12)
        .frame(height: 56)
    }

    private var catalogHeader: some View {
        HStack(spacing: 12) {
            Text("会话")
                .font(.system(size: 34, weight: .bold))
                .tracking(-0.68)
            Spacer(minLength: 0)
            ZStack(alignment: .topTrailing) {
                MobileIconButton(systemName: "line.3.horizontal.decrease", label: "筛选会话") { presentedSheet = .filters }
                if hasActiveFilter {
                    Circle().fill(palette.accent).frame(width: 7, height: 7)
                        .offset(x: -3, y: 3).accessibilityHidden(true)
                }
            }
        }
        .padding(.leading, 20).padding(.trailing, 16)
        .padding(.top, 2).padding(.bottom, 12)
    }

    private var searchField: some View {
        HStack(spacing: 8) {
            MobileGlyph(systemName: "magnifyingglass")
                .frame(width: 20, height: 20)
                .foregroundStyle(palette.secondary)
            TextField("搜索会话", text: $searchText)
                .font(.system(size: 16))
                .textFieldStyle(.plain)
                #if os(iOS)
                .textInputAutocapitalization(.never)
                #endif
                .autocorrectionDisabled()
                .submitLabel(.search)
            if !searchText.isEmpty {
                Button { searchText = "" } label: {
                    MobileGlyph(systemName: "xmark").frame(width: 16, height: 16).foregroundStyle(palette.secondary)
                }
                .buttonStyle(.plain).accessibilityLabel("清除搜索")
            }
        }
        .padding(.horizontal, 12)
        .frame(height: 40)
        .background { MobileGlassSurface(kind: .control, radius: 20) }
        .padding(.horizontal, 16).padding(.bottom, 10)
    }

    @ViewBuilder
    private var catalogContent: some View {
        let visible = filteredConversations
        if isLoading {
            ProgressView("正在加载会话").frame(maxWidth: .infinity).padding(40)
        } else if visible.isEmpty {
            Text(conversations.isEmpty && !hasActiveFilter && searchText.isEmpty ? "还没有会话" : "没有匹配的会话")
                .font(.system(size: 14)).foregroundStyle(palette.secondary)
                .frame(maxWidth: .infinity).padding(.horizontal, 24).padding(.vertical, 40)
        } else {
            LazyVStack(spacing: 0) {
                ForEach(visible) { conversation in
                    conversationRow(conversation, isFirst: conversation.id == visible.first?.id)
                }
            }
            .clipShape(RoundedRectangle(cornerRadius: 24))
            .background { MobileGlassSurface(kind: .panel, radius: 24) }
            .padding(.horizontal, 16)
        }
    }

    private func conversationRow(_ conversation: NativeConversation, isFirst: Bool) -> some View {
        Button { onSelect(conversation) } label: {
            HStack(alignment: .top, spacing: 12) {
                VStack(alignment: .leading, spacing: 3) {
                    Text(conversation.title.isEmpty ? "未命名会话" : conversation.title)
                        .font(.system(size: 15.5, weight: .semibold))
                        .frame(height: 22.8, alignment: .leading)
                        .lineLimit(1).truncationMode(.tail)
                    Text(conversation.preview.isEmpty ? "暂无回复" : conversation.preview)
                        .font(.system(size: 14)).foregroundStyle(palette.secondary)
                        .frame(height: 20.6, alignment: .leading)
                        .lineLimit(1).truncationMode(.tail)
                    HStack(spacing: 5) {
                        MobileGlyph(systemName: isUnassigned(conversation) ? "bubble.left" : "folder")
                            .frame(width: 13, height: 13)
                        Text(isUnassigned(conversation) ? "未归属项目" : conversation.projectName)
                            .lineLimit(1).truncationMode(.tail)
                    }
                    .font(.system(size: 12)).foregroundStyle(palette.secondary)
                    .frame(height: 17.6).padding(.top, 3)
                }
                .frame(maxWidth: .infinity, alignment: .leading)
                VStack(alignment: .trailing, spacing: 7) {
                    Text(relativeTime(conversation.updatedAt))
                        .font(.system(size: 13)).foregroundStyle(palette.secondary)
                        .frame(height: 19.1).fixedSize()
                    statusView(for: conversation)
                }
                .padding(.top, 2)
                .fixedSize(horizontal: true, vertical: false)
            }
            .padding(.horizontal, 16).padding(.vertical, 12)
            .frame(minHeight: 70)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .overlay(alignment: .top) {
            if !isFirst { Rectangle().fill(border).frame(height: 1).padding(.leading, 16) }
        }
    }

    @ViewBuilder
    private func statusView(for conversation: NativeConversation) -> some View {
        if conversation.running {
            statusBadge("运行中", systemName: "progress.indicator", color: palette.accent, opacity: 0.14)
        } else if conversation.waiting {
            statusBadge("等你操作", systemName: "hand.raised", color: palette.warning, opacity: 0.17)
        } else if conversation.archived {
            statusBadge("已归档", systemName: "archivebox", color: palette.secondary, opacity: 0.14)
        } else if conversation.unread {
            Circle().fill(palette.accent).frame(width: 8, height: 8).accessibilityLabel("未读")
        }
    }

    private func statusBadge(_ title: String, systemName: String, color: Color, opacity: Double) -> some View {
        HStack(spacing: 4) {
            MobileGlyph(systemName: systemName).frame(width: 12, height: 12)
            Text(title)
        }
        .font(.system(size: 12, weight: .semibold))
        .foregroundStyle(color)
        .padding(.horizontal, 8).frame(height: 22)
        .background(color.opacity(opacity), in: Capsule())
        .fixedSize().accessibilityElement(children: .combine)
    }

    private var newConversationButton: some View {
        Button { presentedSheet = .newConversation } label: {
            MobileGlyph(systemName: "square.and.pencil")
                .frame(width: 24, height: 24).foregroundStyle(.white)
                .frame(width: 64, height: 64)
                .background { MobileAccentSurface(shape: Circle()) }
        }
        .buttonStyle(.plain).accessibilityLabel("新对话")
        .padding(.trailing, 16).padding(.bottom, 30)
    }

    private func sheetOverlay(_ sheet: PresentedSheet, maximumHeight: CGFloat) -> some View {
        ZStack(alignment: .bottom) {
            (colorScheme == .dark ? Color.black.opacity(0.5) : Color(hex: 0x141828).opacity(0.2))
                .contentShape(Rectangle()).onTapGesture { presentedSheet = nil }
            VStack(spacing: 14) {
                Capsule().fill(palette.secondary.opacity(0.35))
                    .frame(width: 36, height: 5).padding(.bottom, 4)
                if sheet == .filters {
                    filterSheet(maximumHeight: maximumHeight)
                } else {
                    newConversationSheet(maximumHeight: maximumHeight)
                }
            }
            .padding(.horizontal, 22).padding(.top, 10).padding(.bottom, 22)
            .background { MobileGlassSurface(kind: .sheet, radius: 40) }
            .padding(.horizontal, 8).padding(.bottom, 8)
            .transition(.move(edge: .bottom))
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .zIndex(10)
    }

    private func filterSheet(maximumHeight: CGFloat) -> some View {
        let choicesLimit = max(40, maximumHeight - 190)
        return VStack(alignment: .leading, spacing: 14) {
            sheetHeader(title: "筛选会话", subtitle: nil)
            ScrollView {
                VStack(alignment: .leading, spacing: 14) {
                    filterLabel("状态")
                    NativeCatalogChipLayout {
                        ForEach(StatusFilter.allCases) { filter in
                            filterChoice(title: filter.title, isSelected: statusFilter == filter) { statusFilter = filter }
                        }
                    }
                    filterLabel("项目")
                    NativeCatalogChipLayout {
                        filterChoice(title: "所有项目", isSelected: projectFilter == .all) { projectFilter = .all }
                        ForEach(projects) { project in
                            filterChoice(title: project.name, isSelected: projectFilter == .project(project.id)) { projectFilter = .project(project.id) }
                        }
                        filterChoice(title: "未归属项目", isSelected: projectFilter == .unassigned) { projectFilter = .unassigned }
                    }
                }
                .frame(maxWidth: .infinity, alignment: .leading)
                .onGeometryChange(for: CGFloat.self) { $0.size.height } action: { filterChoicesHeight = $0 }
            }
            .frame(height: min(filterChoicesHeight > 0 ? filterChoicesHeight : choicesLimit, choicesLimit))
            .scrollBounceBehavior(.basedOnSize)
            MobilePrimaryButton(title: "完成") { presentedSheet = nil }
        }
    }

    private func filterLabel(_ title: String) -> some View {
        Text(title).font(.system(size: 13, weight: .semibold))
            .foregroundStyle(palette.secondary).frame(minHeight: 19.1)
    }

    private func newConversationSheet(maximumHeight: CGFloat) -> some View {
        VStack(spacing: 14) {
            sheetHeader(title: "新建会话", subtitle: "选择这次会话的项目")
                .padding(.top, 10).padding(.bottom, 16)
            ScrollView {
                LazyVStack(spacing: 0) {
                    ForEach(projects) { project in projectOption(project: project, isFirst: project.id == projects.first?.id) }
                    projectOption(project: nil, isFirst: projects.isEmpty)
                }
            }
            .frame(height: min(CGFloat(projects.count + 1) * 76, max(76, maximumHeight - 170)))
        }
    }

    private func sheetHeader(title: String, subtitle: String?) -> some View {
        HStack(spacing: 12) {
            VStack(alignment: .leading, spacing: subtitle == nil ? 0 : 4) {
                Text(title).font(.system(size: 18, weight: .bold)).frame(minHeight: 26.5)
                if let subtitle {
                    Text(subtitle).font(.system(size: 14)).foregroundStyle(palette.secondary).frame(minHeight: 20.6)
                }
            }
            Spacer(minLength: 0)
            MobileIconButton(systemName: "xmark", label: "关闭") { presentedSheet = nil }
        }
    }

    private func filterChoice(title: String, isSelected: Bool, action: @escaping () -> Void) -> some View {
        Button(action: action) {
            HStack(spacing: 8) {
                Text(title).font(.system(size: 14)).lineLimit(1)
                MobileGlyph(systemName: "checkmark").frame(width: 14, height: 14).opacity(isSelected ? 1 : 0)
            }
            .foregroundStyle(isSelected ? palette.accent : palette.text)
            .padding(.horizontal, 12).frame(height: 40)
            .background(isSelected ? palette.accent.opacity(0.13) : muted, in: RoundedRectangle(cornerRadius: 14))
            .contentShape(RoundedRectangle(cornerRadius: 14))
        }
        .buttonStyle(.plain).accessibilityAddTraits(isSelected ? .isSelected : [])
    }

    private func projectOption(project: NativeProject?, isFirst: Bool) -> some View {
        Button {
            presentedSheet = nil
            onCreate(project)
        } label: {
            HStack(spacing: 12) {
                NativeAccountTile(systemName: project == nil ? "bubble.left" : "folder", quiet: project == nil)
                VStack(alignment: .leading, spacing: 4) {
                    Text(project?.name ?? "未归属项目")
                        .font(.system(size: 16, weight: .semibold)).frame(height: 23.5)
                    Text(project?.path ?? "不绑定项目，直接开始会话")
                        .font(.system(size: 13)).foregroundStyle(palette.secondary)
                        .frame(height: 19.1).lineLimit(1).truncationMode(.tail)
                }
                .frame(maxWidth: .infinity, alignment: .leading)
                MobileGlyph(systemName: "chevron.right").frame(width: 18, height: 18).foregroundStyle(palette.secondary)
            }
            .frame(height: 76)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .overlay(alignment: .top) { if !isFirst { Rectangle().fill(border).frame(height: 0.5) } }
    }

    private func matchesStatus(_ conversation: NativeConversation) -> Bool {
        switch statusFilter {
        case .all: return !conversation.archived
        case .running: return conversation.running
        case .waiting: return conversation.waiting
        case .unread: return conversation.unread
        case .archived: return conversation.archived
        }
    }
    private func matchesProject(_ conversation: NativeConversation) -> Bool {
        switch projectFilter {
        case .all: return true
        case .unassigned: return isUnassigned(conversation)
        case .project(let id):
            guard let project = projects.first(where: { $0.id == id }) else { return false }
            return conversation.projectPath == project.path || conversation.projectName == project.name
        }
    }
    private func isUnassigned(_ conversation: NativeConversation) -> Bool {
        conversation.projectPath?.isEmpty != false && conversation.projectName.isEmpty
    }
    private func relativeTime(_ date: Date) -> String {
        let seconds = max(0, Int(Date().timeIntervalSince(date)))
        if seconds < 60 { return "刚刚" }
        if seconds < 3_600 { return "\(seconds / 60) 分钟" }
        let calendar = Calendar.current
        if calendar.isDateInYesterday(date) { return "昨天" }
        if seconds < 86_400 { return "\(seconds / 3_600) 小时" }
        if seconds < 7 * 86_400 { return ["周日", "周一", "周二", "周三", "周四", "周五", "周六"][calendar.component(.weekday, from: date) - 1] }
        let formatter = DateFormatter()
        formatter.locale = Locale(identifier: "zh_CN")
        formatter.dateFormat = "M月d日"
        return formatter.string(from: date)
    }
}

private enum PresentedSheet { case filters, newConversation }
private enum StatusFilter: String, CaseIterable, Identifiable {
    case all, running, waiting, unread, archived
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
private enum ProjectFilter: Hashable { case all, unassigned, project(String) }

/// Mirrors flex-wrap with an 8pt gap; choices retain a reserved 14pt check slot.
private struct NativeCatalogChipLayout: Layout {
    func sizeThatFits(proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) -> CGSize {
        arrangement(width: proposal.width ?? 330, subviews: subviews).size
    }
    func placeSubviews(in bounds: CGRect, proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) {
        let result = arrangement(width: bounds.width, subviews: subviews)
        for (index, origin) in result.origins.enumerated() {
            subviews[index].place(at: CGPoint(x: bounds.minX + origin.x, y: bounds.minY + origin.y), anchor: .topLeading, proposal: .unspecified)
        }
    }
    private func arrangement(width: CGFloat, subviews: Subviews) -> (size: CGSize, origins: [CGPoint]) {
        var origins: [CGPoint] = []
        var x: CGFloat = 0
        var y: CGFloat = 0
        var rowHeight: CGFloat = 0
        for view in subviews {
            let size = view.sizeThatFits(.unspecified)
            if x > 0 && x + size.width > width {
                x = 0
                y += rowHeight + 8
                rowHeight = 0
            }
            origins.append(CGPoint(x: x, y: y))
            x += size.width + 8
            rowHeight = max(rowHeight, size.height)
        }
        return (CGSize(width: width, height: y + rowHeight), origins)
    }
}
