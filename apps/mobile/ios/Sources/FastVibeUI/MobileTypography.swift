import SwiftUI
#if canImport(UIKit)
import UIKit
#else
import AppKit
#endif

/// Fixed-size system typography with public PingFang SC faces for Chinese fallback.
/// Keep SF as the primary font so SwiftUI can still apply inline Markdown traits.
enum MobileTypography {
    #if canImport(UIKit)
    private typealias PlatformFont = UIFont
    private typealias PlatformDescriptor = UIFontDescriptor
    #else
    private typealias PlatformFont = NSFont
    private typealias PlatformDescriptor = NSFontDescriptor
    #endif

    static func system(size: CGFloat, weight: Font.Weight = .regular, italic: Bool = false, design: Font.Design = .default) -> Font {
        Font(platformFont(size: size, weight: weight, italic: italic, design: design))
    }

    /// Measure each explicit line without wrapping, using the same SF + PingFang cascade.
    static func textWidth(_ text: String, size: CGFloat) -> CGFloat {
        let attributes: [NSAttributedString.Key: Any] = [.font: platformFont(size: size)]
        return text.components(separatedBy: .newlines).map { line in
            (line as NSString).boundingRect(
                with: CGSize(width: CGFloat.greatestFiniteMagnitude, height: CGFloat.greatestFiniteMagnitude),
                options: [.usesLineFragmentOrigin, .usesFontLeading], attributes: attributes, context: nil
            ).width
        }.max() ?? 0
    }

    static func lineHeight(size: CGFloat, design: Font.Design = .default) -> CGFloat {
        let font = platformFont(size: size, design: design)
        #if canImport(UIKit)
        return font.lineHeight
        #else
        return font.ascender - font.descender + font.leading
        #endif
    }

    private static func platformFont(size: CGFloat, weight: Font.Weight = .regular, italic: Bool = false, design: Font.Design = .default) -> PlatformFont {

        let platformWeight: PlatformFont.Weight
        let chineseFace: String
        switch weight {
        case .ultraLight: (platformWeight, chineseFace) = (.ultraLight, "Ultralight")
        case .thin: (platformWeight, chineseFace) = (.thin, "Thin")
        case .light: (platformWeight, chineseFace) = (.light, "Light")
        case .medium: (platformWeight, chineseFace) = (.medium, "Medium")
        case .semibold: (platformWeight, chineseFace) = (.semibold, "Semibold")
        case .bold: (platformWeight, chineseFace) = (.bold, "Semibold")
        case .heavy: (platformWeight, chineseFace) = (.heavy, "Semibold")
        case .black: (platformWeight, chineseFace) = (.black, "Semibold")
        default: (platformWeight, chineseFace) = (.regular, "Regular")
        }

        let primary = design == .monospaced
            ? PlatformFont.monospacedSystemFont(ofSize: size, weight: platformWeight)
            : PlatformFont.systemFont(ofSize: size, weight: platformWeight)
        let chinese = PlatformDescriptor(name: "PingFangSC-\(chineseFace)", size: size)
        // A named cascade avoids the narrowed system UI Chinese fallback. Leave
        // sizes unscaled, matching Font.system(size:), and let CoreText handle
        // any scripts not covered by SF or PingFang through its normal fallback.
        // Apply traits before the cascade: deriving Font.bold()/italic() afterwards
        // makes SwiftUI replace the descriptor and lose the named Chinese fallback.
        var primaryDescriptor = primary.fontDescriptor
        if italic {
            #if canImport(UIKit)
            primaryDescriptor = primaryDescriptor.withSymbolicTraits(primaryDescriptor.symbolicTraits.union(.traitItalic)) ?? primaryDescriptor
            #else
            primaryDescriptor = primaryDescriptor.withSymbolicTraits(primaryDescriptor.symbolicTraits.union(.italic))
            #endif
        }
        let descriptor = primaryDescriptor.addingAttributes([.cascadeList: [chinese]])
        #if canImport(UIKit)
        return UIFont(descriptor: descriptor, size: size)
        #else
        return NSFont(descriptor: descriptor, size: size) ?? primary
        #endif
    }
}

extension View {
    /// Add the missing outer half-leading as well as spacing between wrapped lines.
    /// Natural metrics remain the minimum, so larger fallback glyphs never clip.
    func mobileLineHeight(fontSize: CGFloat, lineHeight: CGFloat, design: Font.Design = .default) -> some View {
        let leading = max(0, lineHeight - MobileTypography.lineHeight(size: fontSize, design: design))
        return lineSpacing(leading)
            .padding(.vertical, leading / 2)
    }
}
