import SwiftUI

/// Material values from prototype-standalone.html's final CSS overrides.
enum MobileGlassKind {
    case panel, control, sheet, navigation
}

private enum MobileGlassCanvasSpace: Hashable {
    case root
}

private struct MobileGlassCanvasSizeKey: EnvironmentKey {
    static let defaultValue: CGSize = .zero
}

private struct MobileGlassCanvasOriginKey: EnvironmentKey {
    static let defaultValue: CGPoint = .zero
}

private extension EnvironmentValues {
    var mobileGlassCanvasSize: CGSize {
        get { self[MobileGlassCanvasSizeKey.self] }
        set { self[MobileGlassCanvasSizeKey.self] = newValue }
    }

    var mobileGlassCanvasOrigin: CGPoint {
        get { self[MobileGlassCanvasOriginKey.self] }
        set { self[MobileGlassCanvasOriginKey.self] = newValue }
    }
}

private struct MobileGlassCanvasModifier: ViewModifier {
    func body(content: Content) -> some View {
        GeometryReader { geometry in
            let insets = geometry.safeAreaInsets
            content
                .frame(maxWidth: .infinity, maxHeight: .infinity)
                .environment(\.mobileGlassCanvasSize, CGSize(
                    width: geometry.size.width + insets.leading + insets.trailing,
                    height: geometry.size.height + insets.top + insets.bottom
                ))
                .environment(\.mobileGlassCanvasOrigin, CGPoint(x: -insets.leading, y: -insets.top))
                .coordinateSpace(name: MobileGlassCanvasSpace.root)
        }
    }
}

extension View {
    /// Share the root backdrop's full extent without consulting a global screen.
    func mobileGlassCanvas() -> some View {
        modifier(MobileGlassCanvasModifier())
    }
}

/// Repaints only the known three-color backdrop; it does not blur views or text
/// behind a surface. No system Material or additional system tint is involved.
struct MobileGlassBackdropSample: View {
    var saturation: Double
    var blurRadius: CGFloat
    @Environment(\.mobileGlassCanvasSize) private var canvasSize
    @Environment(\.mobileGlassCanvasOrigin) private var canvasOrigin

    var body: some View {
        GeometryReader { geometry in
            if canvasSize.width > 0, canvasSize.height > 0 {
                let frame = geometry.frame(in: .named(MobileGlassCanvasSpace.root))
                MobileBackdrop()
                    .frame(width: canvasSize.width, height: canvasSize.height)
                    .saturation(saturation)
                    .blur(radius: blurRadius)
                    .offset(x: canvasOrigin.x - frame.minX, y: canvasOrigin.y - frame.minY)
                    .frame(width: geometry.size.width, height: geometry.size.height, alignment: .topLeading)
            }
        }
        .clipped()
        .allowsHitTesting(false)
        .accessibilityHidden(true)
    }
}

struct MobileGlassSurface: View {
    private let kind: MobileGlassKind
    private let radius: CGFloat
    @Environment(\.colorScheme) private var scheme

    init(kind: MobileGlassKind, radius: CGFloat) {
        self.kind = kind
        self.radius = radius
    }

    private var dark: Bool { scheme == .dark }
    private var shape: RoundedRectangle {
        RoundedRectangle(cornerRadius: radius, style: .continuous)
    }
    private var saturation: Double {
        switch kind {
        case .panel, .sheet: 1.8
        case .control: 1.9
        case .navigation: 1.6
        }
    }
    private var blurRadius: CGFloat {
        switch kind {
        case .panel: 22
        case .control: 18
        case .sheet: 30
        case .navigation: 24
        }
    }
    private var tint: Color {
        switch kind {
        case .panel: dark ? Color(hex: 0x2C2C34).opacity(0.44) : .white.opacity(0.56)
        case .control: dark ? Color(hex: 0x383840).opacity(0.58) : .white.opacity(0.74)
        case .sheet: (dark ? Color(hex: 0x202026).opacity(0.8) : Color(hex: 0xF8F8FC).opacity(0.84))
        case .navigation: dark ? Color(hex: 0x050508) : Color(hex: 0xEEF0F7)
        }
    }
    private var sheenEnd: CGFloat {
        switch kind {
        case .panel: 0.46
        case .control: 0.55
        case .sheet: 0.30
        case .navigation: 1
        }
    }
    private var shadowSpread: CGFloat {
        switch kind {
        case .panel: 6
        case .control: 4
        case .sheet: 10
        case .navigation: 0
        }
    }
    private var shadowBlur: CGFloat {
        switch kind {
        case .panel: 12
        case .control: 9
        case .sheet: 25
        case .navigation: 0
        }
    }
    private var shadowY: CGFloat {
        switch kind {
        case .panel: 8
        case .control: 6
        case .sheet: 20
        case .navigation: 0
        }
    }
    private var shadowColor: Color {
        if kind == .sheet { return .black.opacity(0.3) }
        return dark ? .black.opacity(0.5) : Color(hex: 0x283464).opacity(0.12)
    }
    private var line: Color { .white.opacity(dark ? 0.16 : 0.95) }

    var body: some View {
        ZStack {
            if kind != .navigation {
                // CSS negative spread shrinks the casting outline before blurring.
                // Knock out the interior so the fallback tint never gets a dark fill.
                shape.inset(by: shadowSpread)
                    .fill(shadowColor)
                    .blur(radius: shadowBlur)
                    .offset(y: shadowY)
                    .overlay { shape.fill(.black).blendMode(.destinationOut) }
                    .compositingGroup()
            }
            surface
                .clipShape(shape)
            if kind != .navigation {
                shape.strokeBorder(.black.opacity(dark ? 0.5 : 0.06), lineWidth: 0.5)
            }
        }
        .allowsHitTesting(false)
        .accessibilityHidden(true)
    }

    @ViewBuilder
    private var surface: some View {
        if kind == .navigation {
            ZStack {
                MobileGlassBackdropSample(saturation: saturation, blurRadius: blurRadius)
                LinearGradient(stops: [
                    .init(color: tint.opacity(0.88), location: 0),
                    .init(color: tint.opacity(0.88), location: 0.4),
                    .init(color: tint.opacity(0.30), location: 1),
                ], startPoint: .top, endPoint: .bottom)
            }
            .mask(LinearGradient(stops: [
                .init(color: .black, location: 0),
                .init(color: .black, location: 0.55),
                .init(color: .clear, location: 1),
            ], startPoint: .top, endPoint: .bottom))
        } else {
            ZStack {
                MobileGlassBackdropSample(saturation: saturation, blurRadius: blurRadius)
                tint
                LinearGradient(stops: [
                    .init(color: .white.opacity(dark ? 0.07 : 0.5), location: 0),
                    .init(color: .clear, location: sheenEnd),
                    .init(color: .clear, location: 1),
                ], startPoint: .top, endPoint: .bottom)
                shape.strokeBorder(line, lineWidth: 1)
                    .mask(alignment: .top) {
                        Rectangle().frame(height: 1).frame(maxHeight: .infinity, alignment: .top)
                    }
                if kind == .control {
                    shape.strokeBorder(line, lineWidth: 0.5)
                        .mask(alignment: .bottom) {
                            Rectangle().frame(height: 0.5).frame(maxHeight: .infinity, alignment: .bottom)
                        }
                }
            }
        }
    }
}
