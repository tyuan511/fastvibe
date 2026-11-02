import SwiftUI

struct NativeLoginView: View {
    let isLoading: Bool
    let onLogin: () -> Void
    @Environment(\.colorScheme) private var colorScheme

    init(isLoading: Bool, onLogin: @escaping () -> Void) {
        self.isLoading = isLoading
        self.onLogin = onLogin
    }

    var body: some View {
        let palette = MobilePalette(scheme: colorScheme)
        GeometryReader { geometry in
            ScrollView {
                VStack(spacing: 0) {
                    VStack(spacing: 14) {
                        MobileBrandMark()
                            .frame(width: 96, height: 96)
                            .shadow(color: Color(hex: 0x285AFF).opacity(0.32), radius: 12, y: 14)
                            .accessibilityLabel("FastVibe")
                        Text("FastVibe")
                            .font(.system(size: 30, weight: .bold))
                            .tracking(-0.6)
                        Text("在手机上继续电脑里的会话。随时查看进度、回答提问、发送新指令。")
                            .font(.system(size: 16))
                            .foregroundStyle(palette.secondary)
                            .frame(maxWidth: 290)
                            .fixedSize(horizontal: false, vertical: true)
                    }
                    .multilineTextAlignment(.center)
                    .padding(.horizontal, 32)
                    .frame(maxWidth: .infinity)
                    .frame(minHeight: max(280, geometry.size.height - 132))

                    VStack(spacing: 12) {
                        MobilePrimaryButton(title: isLoading ? "正在打开浏览器…" : "用 FastVibe 账号登录", isLoading: isLoading, action: onLogin)
                        Text("会跳转到浏览器完成登录。之后手机会自动找到这个账号下的电脑。")
                            .font(.system(size: 13))
                            .foregroundStyle(palette.secondary)
                            .multilineTextAlignment(.center)
                            .fixedSize(horizontal: false, vertical: true)
                    }
                    .padding(.horizontal, 20)
                    .padding(.top, 12)
                    .padding(.bottom, 20)
                }
                .frame(maxWidth: 520)
                .frame(maxWidth: .infinity)
            }
            .scrollIndicators(.hidden)
        }
        .foregroundStyle(palette.text)
    }
}

struct NativeComputersView: View {
    let devices: [MobileDevice]
    let accountLabel: String
    let isLoading: Bool
    let onRefresh: () -> Void
    let onSettings: () -> Void
    let onSelect: (MobileDevice) -> Void

    @State private var offlineDevice: MobileDevice?
    @Environment(\.colorScheme) private var colorScheme

    init(
        devices: [MobileDevice],
        accountLabel: String,
        isLoading: Bool,
        onRefresh: @escaping () -> Void,
        onSettings: @escaping () -> Void,
        onSelect: @escaping (MobileDevice) -> Void
    ) {
        self.devices = devices
        self.accountLabel = accountLabel
        self.isLoading = isLoading
        self.onRefresh = onRefresh
        self.onSettings = onSettings
        self.onSelect = onSelect
    }

    var body: some View {
        let palette = MobilePalette(scheme: colorScheme)
        ScrollView {
            VStack(alignment: .leading, spacing: 16) {
                Text("电脑")
                    .font(.system(size: 34, weight: .bold))
                    .tracking(-0.7)
                    .padding(.horizontal, 20)
                    .padding(.top, 64)
                HStack(spacing: 12) {
                    Text(accountLabel.first.map { String($0).uppercased() } ?? "F")
                        .font(.system(size: 16, weight: .semibold))
                        .foregroundStyle(.white)
                        .frame(width: 40, height: 40)
                        .background { MobileAccentSurface(shape: Circle()) }
                    VStack(alignment: .leading, spacing: 3) {
                        Text(accountLabel.isEmpty ? "FastVibe 账号" : accountLabel)
                            .font(.system(size: 16, weight: .semibold))
                        Text("\(devices.filter(\.online).count) 台在线 · \(devices.filter { !$0.online }.count) 台离线")
                            .font(.system(size: 13)).foregroundStyle(palette.secondary)
                    }
                    Spacer()
                }
                .padding(.horizontal, 20)
                if devices.isEmpty {
                    MobileGlassPanel {
                        VStack(spacing: 12) {
                            Image(systemName: "desktopcomputer.and.arrow.down").font(.system(size: 30)).foregroundStyle(palette.secondary)
                            Text(isLoading ? "正在查找电脑…" : "还没有发现电脑").font(.system(size: 16, weight: .semibold))
                            Text("登录同一个 FastVibe 账号，并在电脑上打开远程访问。")
                                .font(.system(size: 14)).foregroundStyle(palette.secondary).multilineTextAlignment(.center)
                        }
                        .frame(maxWidth: .infinity).padding(.vertical, 36).padding(.horizontal, 22)
                    }
                    .padding(.horizontal, 16)
                } else {
                    LazyVStack(spacing: 12) {
                        ForEach(devices) { device in
                            Button {
                                if device.online { onSelect(device) } else { offlineDevice = device }
                            } label: {
                                MobileGlassPanel {
                                    NativeComputerRow(device: device).padding(.horizontal, 16).padding(.vertical, 14)
                                }
                            }
                            .buttonStyle(.plain)
                        }
                    }
                    .padding(.horizontal, 16)
                }
            }
            .padding(.bottom, 36)
        }
        .scrollIndicators(.hidden)
        .overlay(alignment: .topTrailing) {
            HStack(spacing: 8) {
                MobileIconButton(systemName: "arrow.clockwise", label: "刷新电脑列表", action: onRefresh)
                    .disabled(isLoading)
                    .overlay { if isLoading { ProgressView().tint(palette.text) } }
                MobileIconButton(systemName: "gearshape", label: "设置", action: onSettings)
            }
            .padding(.horizontal, 12).padding(.top, 8)
        }
        .foregroundStyle(palette.text)
        .sheet(item: $offlineDevice) { device in
            NativeOfflineSheet(device: device, accountLabel: accountLabel) { offlineDevice = nil }
                .presentationDetents([.medium]).presentationDragIndicator(.hidden).presentationBackground(.clear)
        }
    }
}

private struct NativeComputerRow: View {
    let device: MobileDevice
    @Environment(\.colorScheme) private var colorScheme

    var body: some View {
        let palette = MobilePalette(scheme: colorScheme)
        HStack(spacing: 12) {
            Image(systemName: deviceSymbol)
                .font(.system(size: 18, weight: .regular))
                .foregroundStyle(palette.text)
                .frame(width: 44, height: 44)
                .background(palette.controlTint, in: RoundedRectangle(cornerRadius: 14, style: .continuous))
                .opacity(device.online ? 1 : 0.58)
            VStack(alignment: .leading, spacing: 4) {
                Text(device.name)
                    .font(.system(size: 15.5, weight: .semibold))
                    .lineLimit(1)
                HStack(spacing: 5) {
                    Circle().fill(device.online ? palette.success : palette.secondary).frame(width: 6, height: 6)
                    Text(device.online ? "在线 · \(platformName)" : "离线 · \(platformName)")
                }
                .font(.system(size: 13)).foregroundStyle(palette.secondary)
            }
            .opacity(device.online ? 1 : 0.58)
            Spacer(minLength: 8)
            Image(systemName: "chevron.right")
                .font(.system(size: 13, weight: .regular))
                .foregroundStyle(palette.secondary)
        }
        .frame(minHeight: 48)
        .contentShape(Rectangle())
    }

    private var platformName: String {
        switch device.platform.lowercased() {
        case let value where value.contains("mac"): return "macOS"
        case let value where value.contains("windows"): return "Windows"
        case let value where value.contains("linux"): return "Linux"
        default: return device.platform.isEmpty ? "电脑" : device.platform
        }
    }

    private var deviceSymbol: String {
        switch device.platform.lowercased() {
        case let value where value.contains("mac"): return "laptopcomputer"
        case let value where value.contains("windows"): return "desktopcomputer"
        default: return "desktopcomputer"
        }
    }
}

private struct NativeOfflineSheet: View {
    let device: MobileDevice
    let accountLabel: String
    let onClose: () -> Void
    @Environment(\.colorScheme) private var colorScheme

    var body: some View {
        let palette = MobilePalette(scheme: colorScheme)
        VStack(alignment: .leading, spacing: 0) {
            Capsule()
                .fill(palette.secondary.opacity(0.35))
                .frame(width: 36, height: 4)
                .frame(maxWidth: .infinity)
                .padding(.bottom, 18)
            HStack(spacing: 12) {
                Image(systemName: "desktopcomputer")
                    .font(.system(size: 22, weight: .medium))
                    .foregroundStyle(palette.secondary)
                    .frame(width: 48, height: 48)
                    .background(palette.secondary.opacity(0.12), in: RoundedRectangle(cornerRadius: 14, style: .continuous))
                VStack(alignment: .leading, spacing: 4) {
                    Text("\(device.name) 不在线")
                        .font(.system(size: 18, weight: .bold))
                    Text("设备重新上线后会自动出现在列表里")
                        .font(.system(size: 13))
                        .foregroundStyle(palette.secondary)
                }
            }
            .padding(.bottom, 20)
            VStack(alignment: .leading, spacing: 13) {
                NativeHowToRow(number: 1, text: "唤醒这台电脑，打开 FastVibe")
                NativeHowToRow(number: 2, text: "进入 设置 → 远程访问，确认开关已打开")
                NativeHowToRow(number: 3, text: "确认登录的是 \(accountLabel.isEmpty ? "当前账号" : accountLabel)")
            }
            .padding(.bottom, 18)
            Text("电脑上线后会自动同步，无需手动刷新。")
                .font(.system(size: 13))
                .foregroundStyle(palette.secondary)
                .padding(.bottom, 18)
            MobilePrimaryButton(title: "知道了", action: onClose)
        }
        .padding(.horizontal, 22)
        .padding(.top, 10)
        .padding(.bottom, 22)
        .background { MobileGlassSurface(kind: .sheet, radius: 40) }
        .padding(.horizontal, 8)
        .padding(.bottom, 8)
    }
}

private struct NativeHowToRow: View {
    let number: Int
    let text: String
    @Environment(\.colorScheme) private var colorScheme

    var body: some View {
        let palette = MobilePalette(scheme: colorScheme)
        HStack(alignment: .top, spacing: 12) {
            Text("\(number)")
                .font(.system(size: 13, weight: .semibold, design: .rounded))
                .foregroundStyle(palette.accent)
                .frame(width: 24, height: 24)
                .background(palette.accent.opacity(0.14), in: Circle())
            Text(text)
                .font(.system(size: 15.5))
                .fixedSize(horizontal: false, vertical: true)
        }
    }
}

struct NativeConnectionView: View {
    let device: MobileDevice
    let phase: String
    let errorMessage: String?
    let onCancel: () -> Void
    let onRetry: () -> Void
    @Environment(\.colorScheme) private var colorScheme

    init(device: MobileDevice, phase: String, errorMessage: String?, onCancel: @escaping () -> Void, onRetry: @escaping () -> Void) {
        self.device = device
        self.phase = phase
        self.errorMessage = errorMessage
        self.onCancel = onCancel
        self.onRetry = onRetry
    }

    var body: some View {
        let palette = MobilePalette(scheme: colorScheme)
        let failed = isFailure
        GeometryReader { geometry in
            VStack(spacing: 0) {
                HStack {
                    MobileIconButton(systemName: "chevron.left", label: "返回电脑", action: onCancel)
                    Spacer()
                }
                .padding(.horizontal, 12).frame(height: 56)
                ScrollView {
                    VStack(spacing: 14) {
                        Image(systemName: deviceSymbol)
                            .font(.system(size: 30, weight: .regular))
                            .frame(width: 64, height: 64)
                            .background(palette.controlTint, in: RoundedRectangle(cornerRadius: 18, style: .continuous))
                        Text(failed ? "没能连上这台电脑" : device.name)
                            .font(.system(size: 22, weight: .bold)).multilineTextAlignment(.center)
                        VStack(alignment: .leading, spacing: 2) {
                            NativeConnectionStep(title: "找到电脑", state: stepState(for: 0), detail: nil)
                            NativeConnectionStep(title: "建立连接", state: stepState(for: 1), detail: connectionDetail)
                            if !failed { NativeConnectionStep(title: "同步会话", state: stepState(for: 2), detail: nil) }
                        }
                        .frame(maxWidth: 290, alignment: .leading).padding(.top, 12)
                        if failed {
                            MobileGlassPanel(radius: 22) {
                                VStack(alignment: .leading, spacing: 8) {
                                    Text("可能的原因").font(.system(size: 14, weight: .semibold))
                                    Text(errorMessage ?? "电脑进入了睡眠，或者网络切换后还没重新上线。唤醒电脑并确认 FastVibe 在运行，然后重试。")
                                        .font(.system(size: 14)).foregroundStyle(palette.secondary)
                                        .fixedSize(horizontal: false, vertical: true)
                                }
                                .frame(maxWidth: .infinity, alignment: .leading).padding(16)
                            }
                            .padding(.top, 6)
                        }
                    }
                    .padding(.horizontal, 32)
                    .frame(maxWidth: 520)
                    .frame(maxWidth: .infinity)
                    .frame(minHeight: max(320, geometry.size.height - (failed ? 204 : 140)))
                }
                .scrollIndicators(.hidden)
                VStack(spacing: 10) {
                    if failed {
                        MobilePrimaryButton(title: "重试", systemName: "arrow.counterclockwise", action: onRetry)
                        MobileSecondaryButton(title: "返回电脑列表", action: onCancel)
                    } else {
                        MobileSecondaryButton(title: "取消", action: onCancel)
                    }
                }
                .padding(.horizontal, 20).padding(.top, 12).padding(.bottom, 20)
            }
        }
        .foregroundStyle(palette.text)
    }

    private var normalizedPhase: String { phase.lowercased().trimmingCharacters(in: .whitespacesAndNewlines) }
    private var isFailure: Bool {
        if errorMessage != nil { return true }
        return normalizedPhase.contains("fail") || normalizedPhase.contains("error") || normalizedPhase.contains("failed")
    }
    private var connectionDetail: String? {
        if isFailure { return "连接未完成" }
        return normalizedPhase.contains("relay") ? "正在尝试中转连接" : "正在尝试直连，不行会自动走中转"
    }
    private func stepState(for index: Int) -> NativeConnectionStep.State {
        if isFailure {
            return index == 0 ? .done : (index == 1 ? .failed : .waiting)
        }
        switch normalizedPhase {
        case "done", "complete", "completed": return .done
        case "ready": return index < 2 ? .done : .active
        case let value where value.contains("sync"):
            return index < 2 ? .done : .active
        case let value where value.contains("connect") || value.contains("relay"):
            return index == 0 ? .done : (index == 1 ? .active : .waiting)
        default:
            return index == 0 ? .active : .waiting
        }
    }

    private var deviceSymbol: String {
        device.platform.lowercased().contains("mac") ? "laptopcomputer" : "desktopcomputer"
    }
}

private struct NativeConnectionStep: View {
    enum State { case done, active, waiting, failed }
    let title: String
    let state: State
    let detail: String?
    @Environment(\.colorScheme) private var colorScheme

    var body: some View {
        let palette = MobilePalette(scheme: colorScheme)
        HStack(alignment: .center, spacing: 12) {
            Group {
                switch state {
                case .done: Image(systemName: "checkmark")
                case .active: ProgressView().tint(palette.accent)
                case .waiting: Image(systemName: "circle")
                case .failed: Image(systemName: "xmark")
                }
            }
            .font(.system(size: 13, weight: .bold))
            .foregroundStyle(state == .failed ? palette.danger : state == .done ? palette.success : state == .active ? palette.accent : palette.secondary)
            .frame(width: 28, height: 28)
            .background((state == .failed ? palette.danger : state == .done ? palette.success : palette.accent).opacity(state == .waiting ? 0.08 : 0.14), in: Circle())
            VStack(alignment: .leading, spacing: 3) {
                Text(title).font(.system(size: 15.5, weight: .semibold))
                if let detail, state == .active || state == .failed {
                    Text(detail)
                        .font(.system(size: 13))
                        .foregroundStyle(palette.secondary)
                        .fixedSize(horizontal: false, vertical: true)
                }
            }
            .opacity(state == .waiting ? 0.52 : 1)
        }
        .frame(minHeight: 48)
    }
}

struct NativeSettingsView: View {
    let accountLabel: String
    let accountEmail: String?
    @Binding var deviceName: String
    @Binding var appearance: String
    let endpointID: String?
    let connectionPath: String?
    let coreVersion: String?
    let onBack: () -> Void
    let onSignOut: () -> Void
    @Environment(\.colorScheme) private var colorScheme
    @State private var showDiagnostics = false

    init(
        accountLabel: String,
        accountEmail: String?,
        deviceName: Binding<String>,
        appearance: Binding<String>,
        endpointID: String?,
        connectionPath: String?,
        coreVersion: String?,
        onBack: @escaping () -> Void,
        onSignOut: @escaping () -> Void
    ) {
        self.accountLabel = accountLabel
        self.accountEmail = accountEmail
        _deviceName = deviceName
        _appearance = appearance
        self.endpointID = endpointID
        self.connectionPath = connectionPath
        self.coreVersion = coreVersion
        self.onBack = onBack
        self.onSignOut = onSignOut
    }

    var body: some View {
        let palette = MobilePalette(scheme: colorScheme)
        ScrollView {
            VStack(alignment: .leading, spacing: 0) {
                Color.clear.frame(height: 64)
                MobileGlassPanel {
                    VStack(spacing: 0) {
                        HStack(spacing: 12) {
                            Text(accountLabel.first.map(String.init) ?? "F")
                                .font(.system(size: 19, weight: .semibold))
                                .foregroundStyle(.white)
                                .frame(width: 40, height: 40)
                                .background { MobileAccentSurface(shape: Circle()) }
                            VStack(alignment: .leading, spacing: 3) {
                                Text(accountLabel.isEmpty ? "FastVibe 账号" : accountLabel)
                                    .font(.system(size: 16, weight: .semibold))
                                if let accountEmail, !accountEmail.isEmpty {
                                    Text(accountEmail).font(.system(size: 13)).foregroundStyle(palette.secondary)
                                }
                            }
                            Spacer()
                        }
                        .padding(16)
                        Divider().overlay(palette.secondary.opacity(0.12)).padding(.leading, 16)
                        HStack(spacing: 12) {
                            Text("本机名称").font(.system(size: 15.5))
                            Spacer()
                            TextField("本机名称", text: $deviceName)
                                .multilineTextAlignment(.trailing)
                                .font(.system(size: 15))
                                .foregroundStyle(palette.secondary)
                                .textFieldStyle(.plain)
                                #if os(iOS)
                                .textInputAutocapitalization(.words)
                                #endif
                                .submitLabel(.done)
                                .frame(maxWidth: 180)
                        }
                        .padding(16)
                    }
                }
                .padding(.horizontal, 16)

                NativeSettingsSectionTitle("外观")
                HStack(spacing: 3) {
                    ForEach([("system", "跟随系统", "circle.lefthalf.filled"), ("light", "浅色", "sun.max"), ("dark", "深色", "moon")], id: \.0) { value, title, symbol in
                        Button {
                            appearance = value
                        } label: {
                            Label(title, systemImage: symbol)
                                .font(.system(size: 13.5, weight: .semibold))
                                .foregroundStyle(appearance == value ? palette.text : palette.secondary)
                                .frame(maxWidth: .infinity, minHeight: 38)
                                .background {
                                    if appearance == value {
                                        Capsule()
                                            .fill(colorScheme == .dark ? Color.white.opacity(0.2) : .white)
                                            .shadow(color: .black.opacity(0.12), radius: 4, y: 2)
                                            .overlay {
                                                Capsule().strokeBorder(.white.opacity(colorScheme == .dark ? 0.16 : 0.95), lineWidth: 0.5)
                                                    .mask(Rectangle().frame(height: 0.5).frame(maxHeight: .infinity, alignment: .top))
                                            }
                                    }
                                }
                        }
                        .buttonStyle(.plain)
                    }
                }
                .padding(6)
                .background(Color(red: 118 / 255, green: 118 / 255, blue: 128 / 255).opacity(colorScheme == .dark ? 0.24 : 0.12), in: Capsule())
                .padding(.horizontal, 16)

                NativeSettingsSectionTitle("连接")
                MobileGlassPanel {
                    VStack(spacing: 0) {
                        NativeSettingsValueRow(title: "当前路径", value: pathLabel, valueColor: connectionPath == nil ? palette.secondary : palette.success)
                        Divider().overlay(palette.secondary.opacity(0.12)).padding(.leading, 16)
                        NativeSettingsValueRow(title: "本机连接标识", value: endpointID ?? "暂无连接标识", mono: endpointID != nil)
                        Divider().overlay(palette.secondary.opacity(0.12)).padding(.leading, 16)
                        VStack(alignment: .leading, spacing: 8) {
                            NativeSettingsValueRow(title: "本月中转用量", value: "暂无数据")
                            Capsule().fill(palette.secondary.opacity(0.12)).frame(height: 6).padding(.horizontal, 16)
                            Text("直连不计入用量").font(.system(size: 12)).foregroundStyle(palette.secondary)
                                .padding(.horizontal, 16).padding(.bottom, 14)
                        }
                        Divider().overlay(palette.secondary.opacity(0.12)).padding(.leading, 16)
                        Button { showDiagnostics = true } label: {
                            HStack {
                                Text("连接诊断").font(.system(size: 15.5))
                                Spacer()
                                Image(systemName: "chevron.right").font(.system(size: 13)).foregroundStyle(palette.secondary)
                            }
                            .padding(16).contentShape(Rectangle())
                        }
                        .buttonStyle(.plain)
                    }
                }
                .padding(.horizontal, 16)

                NativeSettingsSectionTitle("关于")
                MobileGlassPanel {
                    VStack(spacing: 0) {
                        NativeSettingsValueRow(title: "版本", value: Bundle.main.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String ?? "开发版本")
                        Divider().overlay(palette.secondary.opacity(0.12)).padding(.leading, 16)
                        NativeSettingsValueRow(title: "核心", value: coreVersion.map { "mobile-core \($0)" } ?? "未知", mono: coreVersion != nil)
                    }
                }
                .padding(.horizontal, 16)
                MobileGlassPanel {
                    Button(action: onSignOut) {
                        Label("退出登录", systemImage: "rectangle.portrait.and.arrow.right")
                            .font(.system(size: 16, weight: .semibold))
                            .foregroundStyle(palette.danger)
                            .frame(maxWidth: .infinity, minHeight: 52)
                    }
                    .buttonStyle(.plain)
                }
                .padding(.horizontal, 16)
                .padding(.top, 22)
                .padding(.bottom, 28)
            }
        }
        .scrollIndicators(.hidden)
        .overlay(alignment: .top) {
            HStack {
                MobileIconButton(systemName: "chevron.left", label: "返回电脑列表", action: onBack)
                Spacer()
                Text("设置").font(.system(size: 16, weight: .semibold))
                Spacer()
                Color.clear.frame(width: 44, height: 44)
            }
            .padding(.horizontal, 12).padding(.top, 8).padding(.bottom, 10)
            .background {
                MobileGlassSurface(kind: .navigation, radius: 0)
                    .padding(.bottom, -22)
                    .ignoresSafeArea(edges: .top)
            }
        }
        .foregroundStyle(palette.text)
        .alert("连接诊断", isPresented: $showDiagnostics) {
            Button("好", role: .cancel) {}
        } message: {
            Text("当前连接：\(pathLabel)\n本机连接标识：\(endpointID ?? "暂无")")
        }
    }

    private var pathLabel: String {
        guard let connectionPath, !connectionPath.isEmpty else { return "未连接" }
        let lower = connectionPath.lowercased()
        if lower.contains("relay") || lower.contains("中转") { return "中转" }
        if lower.contains("direct") || lower.contains("直连") { return "直连" }
        return connectionPath
    }
}

private struct NativeSettingsSectionTitle: View {
    let title: String
    @Environment(\.colorScheme) private var colorScheme

    init(_ title: String) { self.title = title }

    var body: some View {
        Text(title)
            .font(.system(size: 13, weight: .semibold))
            .foregroundStyle(MobilePalette(scheme: colorScheme).secondary)
            .padding(.horizontal, 32)
            .padding(.top, 22)
            .padding(.bottom, 8)
    }
}

private struct NativeSettingsValueRow: View {
    let title: String
    let value: String
    let valueColor: Color?
    let mono: Bool
    @Environment(\.colorScheme) private var colorScheme

    init(title: String, value: String, valueColor: Color? = nil, mono: Bool = false) {
        self.title = title
        self.value = value
        self.valueColor = valueColor
        self.mono = mono
    }

    var body: some View {
        HStack(spacing: 12) {
            Text(title).font(.system(size: 15.5))
            Spacer(minLength: 12)
            Text(value)
                .font(.system(size: 14, design: mono ? .monospaced : .default))
                .foregroundStyle(valueColor ?? MobilePalette(scheme: colorScheme).secondary)
                .lineLimit(1)
                .truncationMode(.middle)
        }
        .padding(.horizontal, 16)
        .padding(.vertical, 15)
    }
}

private struct NativeTopBar<Content: View>: View {
    let title: String
    let subtitle: String?
    let trailing: Content
    @Environment(\.colorScheme) private var colorScheme

    init(title: String, subtitle: String?, @ViewBuilder trailing: () -> Content) {
        self.title = title
        self.subtitle = subtitle
        self.trailing = trailing()
    }

    var body: some View {
        let palette = MobilePalette(scheme: colorScheme)
        HStack(spacing: 10) {
            VStack(alignment: .leading, spacing: 2) {
                Text(title)
                    .font(.system(size: 20, weight: .semibold))
                if let subtitle, !subtitle.isEmpty {
                    Text(subtitle)
                        .font(.system(size: 11.5, weight: .medium))
                        .foregroundStyle(palette.secondary)
                }
            }
            Spacer(minLength: 10)
            trailing
        }
        .frame(minHeight: 56)
    }
}

#if DEBUG
#Preview("Login") {
    ZStack { MobileBackdrop(); NativeLoginView(isLoading: false, onLogin: {}) }
}

#Preview("Computers") {
    ZStack {
        MobileBackdrop()
        NativeComputersView(
            devices: [
                MobileDevice(id: "mac", name: "Yuan 的 MacBook Pro", platform: "macOS", irohEndpointId: "abc123", online: true),
                MobileDevice(id: "pc", name: "家里的 Windows", platform: "Windows", online: false),
            ],
            accountLabel: "tyuan511",
            isLoading: false,
            onRefresh: {}, onSettings: {}, onSelect: { _ in }
        )
    }
}

#Preview("Connection") {
    ZStack {
        MobileBackdrop()
        NativeConnectionView(device: MobileDevice(id: "mac", name: "Yuan 的 MacBook Pro", platform: "macOS", online: true), phase: "connecting", errorMessage: nil, onCancel: {}, onRetry: {})
    }
}

#Preview("Settings") {
    ZStack {
        MobileBackdrop()
        NativeSettingsView(accountLabel: "tyuan511", accountEmail: "yuan@example.com", deviceName: .constant("FastVibe Mobile"), appearance: .constant("system"), endpointID: "8f3c…a91e", connectionPath: "direct srflx v4", coreVersion: "mobile-core 0.1.0", onBack: {}, onSignOut: {})
    }
}
#endif
