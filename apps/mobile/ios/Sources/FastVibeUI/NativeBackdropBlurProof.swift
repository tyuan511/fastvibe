#if DEBUG && canImport(UIKit)
import SwiftUI

/// Simulator-only optical check. Both halves share one source, and the right
/// half adds only UIVisualEffectView: no color wash, sheen or opacity overlay.
/// Keep the effect outside any ancestor SwiftUI clip/mask/compositing group.
struct NativeBackdropBlurProof: View {
    @State private var fullIntensity = false

    var body: some View {
        VStack(spacing: 16) {
            Text("Live backdrop blur proof")
                .font(.headline)
            HStack {
                Text("Original")
                Spacer()
                Text("UIKit blur only")
            }
            .font(.subheadline.bold())

            GeometryReader { geometry in
                ZStack(alignment: .trailing) {
                    source
                    NativeBackdropBlur(
                        recipe: fullIntensity
                            ? NativeBackdropBlurRecipe(lightIntensity: 1, darkIntensity: 1)
                            : .panel,
                        mask: .rounded(radius: 0)
                    )
                    .frame(width: geometry.size.width / 2)
                }
            }
            .frame(maxWidth: .infinity, maxHeight: .infinity)

            Toggle("Full effect (otherwise panel recipe: 0.48)", isOn: $fullIntensity)
                .font(.footnote)
            Text("Compare checker edges and small text across the center. A color wash changes contrast; blur softens the edges.")
                .font(.footnote)
                .fixedSize(horizontal: false, vertical: true)
        }
        .padding(20)
    }

    private var source: some View {
        GeometryReader { geometry in
            ZStack {
                Canvas { context, size in
                    let cell: CGFloat = 10
                    for row in 0..<Int(ceil(size.height / cell)) {
                        for column in 0..<Int(ceil(size.width / cell)) {
                            let square = CGRect(x: CGFloat(column) * cell, y: CGFloat(row) * cell,
                                                width: cell, height: cell)
                            context.fill(Path(square), with: .color((row + column).isMultiple(of: 2) ? .white : .black))
                        }
                    }
                }
                VStack(spacing: 18) {
                    ForEach(0..<6) { index in
                        Text("Aa0123 你停止了这次回复 ABCxyz 你停止了这次回复 0123")
                            .font(.system(size: index.isMultiple(of: 2) ? 12 : 18, weight: .bold))
                            .foregroundStyle(.black)
                            .fixedSize(horizontal: true, vertical: false)
                            .frame(width: geometry.size.width, height: 30, alignment: .leading)
                            .background(.white)
                    }
                }
            }
        }
        // Clip only the source artwork; the sibling effect never inherits this.
        .clipped()
        .accessibilityHidden(true)
    }
}
#endif
