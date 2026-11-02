import SwiftUI
import ImageIO

struct MobileBrandMark: View {
    static var bitmap: CGImage? {
        guard let url = Bundle.module.url(forResource: "fastvibe-icon", withExtension: "png"),
              let source = CGImageSourceCreateWithURL(url as CFURL, nil)
        else { return nil }
        return CGImageSourceCreateImageAtIndex(source, 0, nil)
    }

    var body: some View {
        if let bitmap = Self.bitmap {
            Canvas { context, size in
                context.draw(Image(decorative: bitmap, scale: 1), in: CGRect(origin: .zero, size: size))
            }
        }
    }
}

/// The colors shared by the native mobile surfaces. Values mirror the approved
/// standalone prototype and keep the page implementations free of hard-coded
/// appearance branches.
struct MobilePalette {
    var text: Color
    var secondary: Color
    var accent: Color
    var success: Color
    var warning: Color
    var danger: Color
    var panelTint: Color
    var controlTint: Color

    init(scheme: ColorScheme) {
        let dark = scheme == .dark
        text = dark ? Color(hex: 0xF5F5F7) : Color(hex: 0x0B0B0F)
        secondary = dark
            ? Color(red: 235 / 255, green: 235 / 255, blue: 245 / 255, opacity: 0.60)
            : Color(red: 60 / 255, green: 60 / 255, blue: 67 / 255, opacity: 0.62)
        accent = dark ? Color(hex: 0x0A84FF) : Color(hex: 0x007AFF)
        success = dark ? Color(hex: 0x32D74B) : Color(hex: 0x34C759)
        warning = dark ? Color(hex: 0xFF9F0A) : Color(hex: 0xFF9500)
        danger = dark ? Color(hex: 0xFF453A) : Color(hex: 0xFF3B30)
        panelTint = dark
            ? Color(red: 44 / 255, green: 44 / 255, blue: 52 / 255, opacity: 0.44)
            : Color.white.opacity(0.56)
        controlTint = dark
            ? Color(red: 56 / 255, green: 56 / 255, blue: 64 / 255, opacity: 0.58)
            : Color.white.opacity(0.74)
    }
}

struct MobileBackdrop: View {
    @Environment(\.colorScheme) private var colorScheme

    var body: some View {
        GeometryReader { geometry in
            let bitmap = MobileBackdropRaster.image(size: geometry.size, dark: colorScheme == .dark)
            Canvas { context, size in
                if let bitmap {
                    context.draw(Image(decorative: bitmap, scale: 1), in: CGRect(origin: .zero, size: size))
                }
            }
        }
        .ignoresSafeArea()
        .allowsHitTesting(false)
    }
}

struct MobileGlassPanel<Content: View>: View {
    private let radius: CGFloat
    private let content: Content

    init(radius: CGFloat = 24, @ViewBuilder content: () -> Content) {
        self.radius = radius
        self.content = content()
    }

    var body: some View {
        content.background { MobileGlassSurface(kind: .panel, radius: radius) }
    }
}

struct MobileIconButton: View {
    let systemName: String
    let label: String
    let action: () -> Void
    @Environment(\.colorScheme) private var colorScheme

    init(systemName: String, label: String, action: @escaping () -> Void) {
        self.systemName = systemName
        self.label = label
        self.action = action
    }

    var body: some View {
        let palette = MobilePalette(scheme: colorScheme)
        Button(action: action) {
            Image(systemName: systemName)
                .font(.system(size: 18, weight: .semibold))
                .foregroundStyle(palette.text)
                .frame(width: 44, height: 44)
                .background { MobileGlassSurface(kind: .control, radius: 22) }
        }
        .buttonStyle(.plain)
        .accessibilityLabel(label)
    }
}

/// Shared accent artwork from the prototype's buttons, avatars and user bubbles.
struct MobileAccentSurface<S: InsettableShape>: View {
    let shape: S
    var userBubble = false
    @Environment(\.colorScheme) private var scheme

    var body: some View {
        let palette = MobilePalette(scheme: scheme)
        ZStack {
            shape.inset(by: 6)
                .fill(palette.accent.opacity(userBubble ? 0.55 : 0.6))
                .blur(radius: userBubble ? 8 : 10)
                .offset(y: userBubble ? 6 : 8)
                .overlay { shape.fill(.black).blendMode(.destinationOut) }
                .compositingGroup()
            LinearGradient(colors: [Color(hex: scheme == .dark ? 0x5EB1FF : 0x4AA3FF), palette.accent],
                           startPoint: .top, endPoint: .bottom)
                .overlay {
                    LinearGradient(stops: [
                        .init(color: .white.opacity(userBubble ? 0.22 : 0.28), location: 0),
                        .init(color: .white.opacity(0), location: userBubble ? 0.6 : 0.5),
                    ], startPoint: .top, endPoint: .bottom)
                }
                .overlay(alignment: .top) { Color.white.opacity(userBubble ? 0.35 : 0.45).frame(height: 1) }
                .overlay(alignment: .bottom) {
                    if !userBubble { Color.black.opacity(0.08).frame(height: 1) }
                }
                .clipShape(shape)
        }
        .allowsHitTesting(false)
    }
}

struct MobilePrimaryButton: View {
    let title: String
    let systemName: String?
    let isLoading: Bool
    let action: () -> Void
    @Environment(\.colorScheme) private var colorScheme

    init(title: String, systemName: String? = nil, isLoading: Bool = false, action: @escaping () -> Void) {
        self.title = title
        self.systemName = systemName
        self.isLoading = isLoading
        self.action = action
    }

    var body: some View {
        Button(action: action) {
            HStack(spacing: 8) {
                if isLoading {
                    ProgressView().tint(.white)
                } else if let systemName {
                    Image(systemName: systemName)
                }
                Text(title).font(.system(size: 16, weight: .semibold))
            }
            .foregroundStyle(.white)
            .frame(maxWidth: .infinity, minHeight: 52)
            .background { MobileAccentSurface(shape: Capsule()) }
        }
        .buttonStyle(.plain)
        .disabled(isLoading)
    }
}

struct MobileSecondaryButton: View {
    let title: String
    let systemName: String?
    let action: () -> Void
    @Environment(\.colorScheme) private var colorScheme

    init(title: String, systemName: String? = nil, action: @escaping () -> Void) {
        self.title = title
        self.systemName = systemName
        self.action = action
    }

    var body: some View {
        let palette = MobilePalette(scheme: colorScheme)
        Button(action: action) {
            HStack(spacing: 8) {
                if let systemName { Image(systemName: systemName) }
                Text(title).font(.system(size: 16, weight: .semibold))
            }
            .foregroundStyle(palette.text)
            .frame(maxWidth: .infinity, minHeight: 52)
            .background { MobileGlassSurface(kind: .control, radius: 26) }
        }
        .buttonStyle(.plain)
    }
}

struct MobileStatusBadge: View {
    let title: String
    let color: Color
    let systemName: String?

    init(_ title: String, color: Color, systemName: String? = nil) {
        self.title = title
        self.color = color
        self.systemName = systemName
    }

    var body: some View {
        HStack(spacing: 5) {
            if let systemName { Image(systemName: systemName).font(.system(size: 11, weight: .semibold)) }
            else { Circle().fill(color).frame(width: 5, height: 5) }
            Text(title)
        }
        .font(.system(size: 11, weight: .medium))
        .foregroundStyle(color)
        .padding(.horizontal, 8)
        .padding(.vertical, 4)
        .background(color.opacity(0.12), in: Capsule())
    }
}

extension Color {
    init(hex: UInt, opacity: Double = 1) {
        self.init(
            red: Double((hex >> 16) & 0xFF) / 255,
            green: Double((hex >> 8) & 0xFF) / 255,
            blue: Double(hex & 0xFF) / 255,
            opacity: opacity
        )
    }
}

#if DEBUG
#Preview("Design System") {
    ZStack {
        MobileBackdrop()
        MobileGlassPanel {
            VStack(spacing: 16) {
                Text("FastVibe").font(.largeTitle.bold())
                MobilePrimaryButton(title: "继续", systemName: "arrow.right") {}
            }
            .padding(20)
        }
        .padding()
    }
}
#endif
