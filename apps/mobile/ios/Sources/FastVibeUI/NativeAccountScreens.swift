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
                            .mobileLineHeight(fontSize: 30, lineHeight: 44.1)
                        Text("在手机上继续电脑里的会话。随时查看进度、回答提问、发送新指令。")
                            .font(MobileTypography.system(size: 16))
                            .mobileLineHeight(fontSize: 16, lineHeight: 23.52)
                            .foregroundStyle(palette.secondary)
                            .frame(maxWidth: 290)
                            .fixedSize(horizontal: false, vertical: true)
                    }
                    .multilineTextAlignment(.center)
                    .padding(.horizontal, 32)
                    .frame(maxWidth: .infinity)
                    .frame(minHeight: max(280, geometry.size.height - 86 - 134))

                    VStack(spacing: 12) {
                        MobilePrimaryButton(title: isLoading ? "正在打开浏览器…" : "用 FastVibe 账号登录", isLoading: isLoading, action: onLogin)
                        Text("会跳转到浏览器完成登录。之后手机会自动找到这个账号下的电脑。")
                            .font(MobileTypography.system(size: 13))
                            .mobileLineHeight(fontSize: 13, lineHeight: 19.11)
                            .foregroundStyle(palette.secondary)
                            .multilineTextAlignment(.center)
                            .fixedSize(horizontal: false, vertical: true)
                    }
                    .padding(.horizontal, 20)
                    .padding(.top, 12)
                    .padding(.bottom, 20)
                }
                .padding(.top, 50)
                .padding(.bottom, 36)
            }
            .scrollIndicators(.hidden)
        }
        .ignoresSafeArea()
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
        onSelect: @escaping (MobileDevice) -> Void,
        initialOfflineDevice: MobileDevice? = nil
    ) {
        self.devices = devices
        self.accountLabel = accountLabel
        self.isLoading = isLoading
        self.onRefresh = onRefresh
        self.onSettings = onSettings
        self.onSelect = onSelect
        _offlineDevice = State(initialValue: initialOfflineDevice)
    }

    var body: some View {
        let palette = MobilePalette(scheme: colorScheme)
        ZStack(alignment: .bottom) {
            ScrollView {
                LazyVStack(alignment: .leading, spacing: 0) {
                    HStack(spacing: 8) {
                        Spacer()
                        MobileIconButton(systemName: "arrow.clockwise", label: "刷新电脑列表", action: onRefresh)
                            .disabled(isLoading)
                            .overlay { if isLoading { ProgressView().tint(palette.text) } }
                        MobileIconButton(systemName: "gearshape", label: "设置", action: onSettings)
                    }
                    .padding(.horizontal, 12)
                    .frame(height: 56)
                    Text("电脑")
                        .font(.system(size: 34, weight: .bold))
                        .tracking(-0.68)
                        .frame(height: 39.1)
                        .padding(.horizontal, 20)
                        .padding(.top, 2)
                        .padding(.bottom, 12)
                    HStack(spacing: 12) {
                        Text(accountLabel.first.map { String($0).uppercased() } ?? "F")
                            .font(.system(size: 16, weight: .bold))
                            .foregroundStyle(.white)
                            .frame(width: 40, height: 40)
                            .background { MobileAccentSurface(shape: Circle()) }
                        VStack(alignment: .leading, spacing: 0) {
                            Text(accountLabel.isEmpty ? "FastVibe 账号" : accountLabel)
                                .font(.system(size: 17, weight: .semibold))
                                .frame(height: 25)
                            Text("\(devices.filter(\.online).count) 台在线 · \(devices.filter { !$0.online }.count) 台离线")
                                .font(.system(size: 13)).foregroundStyle(palette.secondary)
                                .frame(height: 19.1)
                        }
                        Spacer()
                    }
                    .padding(.horizontal, 20)
                    .padding(.top, 4)
                    .padding(.bottom, 16)
                    if devices.isEmpty {
                        MobileGlassPanel {
                            VStack(spacing: 12) {
                                MobileGlyph(systemName: "desktopcomputer").frame(width: 30, height: 30).foregroundStyle(palette.secondary)
                                Text(isLoading ? "正在查找电脑…" : "还没有发现电脑").font(.system(size: 16, weight: .semibold))
                                Text("登录同一个 FastVibe 账号，并在电脑上打开远程访问。")
                                    .font(.system(size: 14)).foregroundStyle(palette.secondary).multilineTextAlignment(.center)
                            }
                            .frame(maxWidth: .infinity).padding(.vertical, 36).padding(.horizontal, 22)
                        }
                        .padding(.horizontal, 16)
                    } else {
                        ForEach(devices) { device in
                            Button {
                                if device.online { onSelect(device) } else { offlineDevice = device }
                            } label: {
                                MobileGlassPanel {
                                    NativeComputerRow(device: device)
                                }
                            }
                            .buttonStyle(.plain)
                            .padding(.horizontal, 16)
                            .padding(.bottom, 12)
                        }
                    }
                }
                .padding(.top, 50)
                .padding(.bottom, 52)
            }
            .scrollIndicators(.hidden)
            if let offlineDevice {
                (colorScheme == .dark ? Color.black.opacity(0.5) : Color(hex: 0x141828).opacity(0.2))
                    .contentShape(Rectangle())
                    .onTapGesture { self.offlineDevice = nil }
                NativeOfflineSheet(device: offlineDevice, accountLabel: accountLabel) { self.offlineDevice = nil }
            }
        }
        .ignoresSafeArea()
        .foregroundStyle(palette.text)
    }
}

private struct NativeComputerRow: View {
    let device: MobileDevice
    @Environment(\.colorScheme) private var colorScheme

    var body: some View {
        let palette = MobilePalette(scheme: colorScheme)
        HStack(spacing: 14) {
            NativeAccountTile(systemName: device.online ? (device.name.localizedCaseInsensitiveContains("book") ? "laptopcomputer" : "desktopcomputer") : "desktopcomputer.slash")
                .opacity(device.online ? 1 : 0.55)
            VStack(alignment: .leading, spacing: 5) {
                Text(device.name)
                    .font(.system(size: 16, weight: .semibold))
                    .lineLimit(1)
                    .frame(height: 23.5)
                    .opacity(device.online ? 1 : 0.55)
                HStack(spacing: 6) {
                    Circle().fill(device.online ? palette.success : palette.secondary).frame(width: 8, height: 8)
                    Text(device.online ? "在线 · \(platformName)" : offlineLabel)
                    if device.online, let path = device.path, !path.isEmpty {
                        let relay = path.localizedCaseInsensitiveContains("relay") || path.contains("中转")
                        Text(relay ? "中转" : "直连")
                            .font(.system(size: 12, weight: .semibold))
                            .foregroundStyle(relay ? palette.warning : palette.success)
                            .padding(.horizontal, 8)
                            .frame(height: 22)
                            .background((relay ? palette.warning : palette.success).opacity(relay ? 0.17 : 0.15), in: Capsule())
                    }
                }
                .font(.system(size: 13)).foregroundStyle(palette.secondary)
                .frame(minHeight: 19.1)
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            MobileGlyph(systemName: "chevron.right")
                .frame(width: 20, height: 20)
                .foregroundStyle(palette.secondary)
        }
        .padding(.horizontal, 16)
        .padding(.vertical, 14)
        .frame(minHeight: 76)
        .contentShape(Rectangle())
    }

    private var offlineLabel: String {
        guard let lastOnline = device.lastOnline else { return "离线 · \(platformName)" }
        return "离线 · \(nativeLastOnline(lastOnline))在线"
    }

    private var platformName: String {
        switch device.platform.lowercased() {
        case let value where value.contains("mac"): return "macOS"
        case let value where value.contains("windows"): return "Windows"
        case let value where value.contains("linux"): return "Linux"
        default: return device.platform.isEmpty ? "电脑" : device.platform
        }
    }
}

private func nativeLastOnline(_ timestamp: Double) -> String {
    let seconds = max(0, Int(Date().timeIntervalSince1970 - timestamp / 1000))
    if seconds < 60 { return "刚刚" }
    if seconds < 3_600 { return "\(seconds / 60) 分钟前" }
    if seconds < 86_400 { return "\(seconds / 3_600) 小时前" }
    return "\(seconds / 86_400) 天前"
}

struct NativeAccountTile: View {
    let systemName: String
    var size: CGFloat = 44
    var radius: CGFloat = 14
    var iconSize: CGFloat = 20
    var quiet = false
    @Environment(\.colorScheme) private var colorScheme

    var body: some View {
        let palette = MobilePalette(scheme: colorScheme)
        MobileGlyph(systemName: systemName)
            .frame(width: iconSize, height: iconSize)
            .foregroundStyle(quiet ? palette.secondary : palette.text)
            .frame(width: size, height: size)
            .background(quiet ? Color(hex: 0x767680).opacity(colorScheme == .dark ? 0.24 : 0.12) : colorScheme == .dark ? .white.opacity(0.08) : .white.opacity(0.72), in: RoundedRectangle(cornerRadius: radius))
            .overlay {
                RoundedRectangle(cornerRadius: radius).strokeBorder(.black.opacity(colorScheme == .dark ? 0.5 : 0.06), lineWidth: 0.5)
            }
            .overlay(alignment: .top) {
                RoundedRectangle(cornerRadius: radius).strokeBorder(.white.opacity(colorScheme == .dark ? 0.16 : 0.95), lineWidth: 1)
                    .mask(Rectangle().frame(height: 1).frame(maxHeight: .infinity, alignment: .top))
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
        VStack(alignment: .leading, spacing: 14) {
            Capsule()
                .fill(palette.secondary.opacity(0.35))
                .frame(width: 36, height: 5)
                .frame(maxWidth: .infinity)
                .padding(.bottom, 4)
            HStack(alignment: .top, spacing: 12) {
                NativeAccountTile(systemName: "desktopcomputer.slash", quiet: true)
                VStack(alignment: .leading, spacing: 0) {
                    Text("\(device.name) 不在线")
                        .font(.system(size: 18, weight: .bold))
                        .fixedSize(horizontal: false, vertical: true)
                    Text(device.lastOnline.map { "最后在线是 \(nativeLastOnline($0))。" } ?? "设备重新上线后会自动出现在列表里。")
                        .font(.system(size: 14))
                        .foregroundStyle(palette.secondary)
                }
            }
            VStack(alignment: .leading, spacing: 12) {
                NativeHowToRow(number: 1, text: "唤醒这台电脑，打开 FastVibe")
                NativeHowToRow(number: 2, text: "进入 设置 → 远程访问，确认开关已打开")
                NativeHowToRow(number: 3, text: "确认登录的是 \(accountLabel.isEmpty ? "当前账号" : accountLabel) 这个账号")
            }
            .padding(.vertical, 4)
            Text("上线后会自动出现在列表里，不用刷新。")
                .font(.system(size: 14))
                .foregroundStyle(palette.secondary)
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
                .font(.system(size: 13, weight: .semibold))
                .monospacedDigit()
                .foregroundStyle(palette.accent)
                .frame(width: 24, height: 24)
                .background(palette.accent.opacity(0.14), in: Circle())
                .padding(.top, 1)
            Text(text)
                .font(.system(size: 15.5))
                .lineSpacing(3)
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
        GeometryReader { geometry in
            ScrollView {
                VStack(spacing: 0) {
                    HStack {
                        MobileIconButton(systemName: "chevron.left", label: "返回电脑", action: onCancel)
                        Spacer()
                    }
                    .padding(.horizontal, 12).frame(height: 56)
                    VStack(spacing: 14) {
                        NativeAccountTile(systemName: device.platform.lowercased().contains("mac") ? "laptopcomputer" : "desktopcomputer", size: 64, radius: 18, iconSize: 30)
                        Text(isFailure ? "没能连上这台电脑" : device.name)
                            .font(.system(size: 22, weight: .bold))
                            .tracking(-0.44)
                            .frame(minHeight: 32.3)
                            .multilineTextAlignment(.center)
                        VStack(alignment: .leading, spacing: 2) {
                            NativeConnectionStep(title: "找到电脑", state: stepState(for: 0), detail: nil)
                            NativeConnectionStep(title: "建立连接", state: stepState(for: 1), detail: connectionDetail)
                            if !isFailure { NativeConnectionStep(title: "同步会话", state: stepState(for: 2), detail: nil) }
                        }
                        .frame(maxWidth: .infinity, alignment: .leading).padding(.top, 12)
                        if isFailure {
                            VStack(alignment: .leading, spacing: 6) {
                                Text("可能的原因").font(.system(size: 16, weight: .bold))
                                Text("电脑进入了睡眠，或者网络切换后还没重新上线。唤醒电脑并确认 FastVibe 在运行，然后重试。")
                                    .font(.system(size: 14))
                                    .lineSpacing(3)
                                    .fixedSize(horizontal: false, vertical: true)
                            }
                            .frame(maxWidth: .infinity, alignment: .leading)
                            .padding(.horizontal, 16).padding(.vertical, 14)
                            .background {
                                MobileGlassSurface(kind: .panel, radius: 22)
                                RoundedRectangle(cornerRadius: 22).fill(palette.danger.opacity(0.11))
                            }
                        }
                    }
                    .padding(.horizontal, 32)
                    .frame(maxWidth: .infinity)
                    .frame(minHeight: max(320, geometry.size.height - 86 - 56 - (isFailure ? 148 : 84)))
                    VStack(spacing: 12) {
                        if isFailure {
                            MobilePrimaryButton(title: "重试", systemName: "arrow.counterclockwise", action: onRetry)
                            MobileSecondaryButton(title: "返回电脑列表", action: onCancel)
                        } else {
                            MobileSecondaryButton(title: "取消", action: onCancel)
                        }
                    }
                    .padding(.horizontal, 20).padding(.top, 12).padding(.bottom, 20)
                }
                .padding(.top, 50)
                .padding(.bottom, 36)
            }
            .scrollIndicators(.hidden)
        }
        .ignoresSafeArea()
        .foregroundStyle(palette.text)
    }

    private var normalizedPhase: String { phase.lowercased().trimmingCharacters(in: .whitespacesAndNewlines) }
    private var isFailure: Bool {
        errorMessage != nil || normalizedPhase.contains("fail") || normalizedPhase.contains("error")
    }
    private var connectionDetail: String? {
        if isFailure { return errorMessage ?? "连接未完成" }
        return normalizedPhase.contains("relay") ? "正在尝试中转连接" : "正在尝试直连，不行会自动走中转"
    }
    private func stepState(for index: Int) -> NativeConnectionStep.State {
        if isFailure { return index == 0 ? .done : .failed }
        switch normalizedPhase {
        case "done", "complete", "completed": return .done
        case "ready": return index < 2 ? .done : .active
        case let value where value.contains("sync"): return index < 2 ? .done : .active
        case let value where value.contains("connect") || value.contains("relay"):
            return index == 0 ? .done : (index == 1 ? .active : .waiting)
        default: return index == 0 ? .active : .waiting
        }
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
        let color = state == .failed ? palette.danger : state == .done ? palette.success : state == .active ? palette.accent : palette.secondary
        HStack(spacing: 12) {
            Group {
                switch state {
                case .done: MobileGlyph(systemName: "checkmark").frame(width: 16, height: 16)
                case .active: MobileGlyph(systemName: "progress.indicator").frame(width: 16, height: 16)
                case .waiting: MobileGlyph(systemName: "circle").frame(width: 16, height: 16)
                case .failed: MobileGlyph(systemName: "xmark").frame(width: 16, height: 16)
                }
            }
            .foregroundStyle(color)
            .frame(width: 28, height: 28)
            .background(state == .waiting ? Color(hex: 0x767680).opacity(colorScheme == .dark ? 0.24 : 0.12) : color.opacity(state == .done ? 0.16 : 0.14), in: Circle())
            VStack(alignment: .leading, spacing: 0) {
                Text(title).font(.system(size: 16)).frame(minHeight: 23.5)
                if let detail, state == .active || state == .failed {
                    Text(detail)
                        .font(.system(size: 13))
                        .foregroundStyle(palette.secondary)
                        .frame(minHeight: 19.1)
                        .fixedSize(horizontal: false, vertical: true)
                }
            }
            .foregroundStyle(state == .waiting ? palette.secondary : palette.text)
        }
        .frame(minHeight: 48)
    }
}

struct NativeSettingsView: View {
    let accountLabel: String
    let accountEmail: String?
    @Binding var deviceName: String
    @Binding var appearance: String
    let onBack: () -> Void
    let onSignOut: () -> Void
    @Environment(\.colorScheme) private var colorScheme

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
        self.onBack = onBack
        self.onSignOut = onSignOut
    }

    var body: some View {
        let palette = MobilePalette(scheme: colorScheme)
        ScrollView {
            VStack(alignment: .leading, spacing: 0) {
                HStack {
                    MobileIconButton(systemName: "chevron.left", label: "返回电脑列表", action: onBack)
                    Spacer()
                }
                .padding(.horizontal, 12).frame(height: 56)
                Text("设置")
                    .font(.system(size: 34, weight: .bold))
                    .tracking(-0.68)
                    .frame(height: 39.1)
                    .padding(.horizontal, 20)
                    .padding(.top, 2).padding(.bottom, 12)
                MobileGlassPanel {
                    VStack(spacing: 0) {
                        HStack(spacing: 12) {
                            Text(accountLabel.first.map { String($0).uppercased() } ?? "F")
                                .font(.system(size: 16, weight: .bold))
                                .foregroundStyle(.white)
                                .frame(width: 40, height: 40)
                                .background { MobileAccentSurface(shape: Circle()) }
                            VStack(alignment: .leading, spacing: 0) {
                                Text(accountLabel.isEmpty ? "FastVibe 账号" : accountLabel)
                                    .font(.system(size: 16, weight: .semibold))
                                    .frame(minHeight: 23.5)
                                if let accountEmail, !accountEmail.isEmpty {
                                    Text(accountEmail).font(.system(size: 13)).foregroundStyle(palette.secondary)
                                        .frame(minHeight: 19.1)
                                }
                            }
                            Spacer()
                        }
                        .padding(.horizontal, 16).padding(.vertical, 8).frame(minHeight: 56)
                        HStack(spacing: 12) {
                            Text("本机名称").font(.system(size: 16))
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
                            MobileGlyph(systemName: "chevron.right").frame(width: 16, height: 16).foregroundStyle(palette.secondary)
                        }
                        .padding(.horizontal, 16).frame(height: 52)
                        .overlay(alignment: .top) {
                            Rectangle().fill(settingsBorder).frame(height: 1).padding(.leading, 16)
                        }
                    }
                }
                .padding(.horizontal, 16).padding(.bottom, 22)

                NativeSettingsSectionTitle("外观")
                MobileGlassPanel {
                    HStack(spacing: 0) {
                        ForEach([("system", "跟随系统"), ("light", "浅色"), ("dark", "深色")], id: \.0) { value, title in
                            Button { appearance = value } label: {
                                Text(title)
                                    .font(.system(size: 14, weight: .semibold))
                                    .foregroundStyle(appearance == value ? palette.text : palette.secondary)
                                    .frame(maxWidth: .infinity, minHeight: 38)
                                    .background {
                                        if appearance == value {
                                            Capsule().fill(colorScheme == .dark ? Color.white.opacity(0.2) : .white)
                                                .shadow(color: .black.opacity(0.12), radius: 4, y: 2)
                                        }
                                    }
                            }
                            .buttonStyle(.plain)
                        }
                    }
                    .padding(3)
                    .background(Color(hex: 0x767680).opacity(colorScheme == .dark ? 0.24 : 0.12), in: Capsule())
                    .padding(.horizontal, 12).padding(.vertical, 10)
                }
                .padding(.horizontal, 16).padding(.bottom, 22)

                NativeSettingsSectionTitle("关于")
                MobileGlassPanel {
                    HStack {
                        Text("版本").font(.system(size: 16))
                        Spacer()
                        Text(appVersion).font(.system(size: 15)).monospacedDigit().foregroundStyle(palette.secondary)
                    }
                    .padding(.horizontal, 16).frame(height: 52)
                }
                .padding(.horizontal, 16).padding(.bottom, 22)
                MobileGlassPanel {
                    Button(action: onSignOut) {
                        HStack(spacing: 12) {
                            MobileGlyph(systemName: "rectangle.portrait.and.arrow.right").frame(width: 20, height: 20)
                            Text("退出登录").font(.system(size: 16, weight: .semibold))
                        }
                        .foregroundStyle(palette.danger)
                        .frame(maxWidth: .infinity, minHeight: 52)
                    }
                    .buttonStyle(.plain)
                }
                .padding(.horizontal, 16).padding(.bottom, 22)
            }
            .padding(.top, 50).padding(.bottom, 36)
        }
        .scrollIndicators(.hidden)
        .ignoresSafeArea()
        .foregroundStyle(palette.text)
    }

    private var settingsBorder: Color {
        colorScheme == .dark ? .white.opacity(0.09) : Color(hex: 0x3C3C43).opacity(0.13)
    }
    private var appVersion: String {
        guard let version = Bundle.main.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String else { return "开发版本" }
        guard let build = Bundle.main.object(forInfoDictionaryKey: "CFBundleVersion") as? String, !build.isEmpty else { return version }
        return "\(version) (\(build))"
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
            .frame(minHeight: 19.1)
            .padding(.horizontal, 34)
            .padding(.bottom, 8)
    }
}
