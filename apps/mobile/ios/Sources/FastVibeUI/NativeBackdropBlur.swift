#if canImport(UIKit)
import SwiftUI
import UIKit

/// Starting points for the public UIKit experiment, not CSS pixel radii. UIKit's
/// material includes its own tint/saturation, and fractionComplete is not a linear
/// blur-radius control. Keep these values separate from the surface's color wash
/// so simulator/device captures can tune the two independently.
struct NativeBackdropBlurRecipe: Equatable {
    let lightIntensity: CGFloat
    let darkIntensity: CGFloat

    static let panel = Self(lightIntensity: 0.48, darkIntensity: 0.48)
    static let control = Self(lightIntensity: 0.40, darkIntensity: 0.40)
    static let sheet = Self(lightIntensity: 0.65, darkIntensity: 0.65)
    static let navigation = Self(lightIntensity: 0.52, darkIntensity: 0.52)
    // Inspired by the composer's former 8-point sample, not an 8-point guarantee.
    static let composer = Self(lightIntensity: 0.22, darkIntensity: 0.22)
}

enum NativeBackdropBlurMask: Equatable {
    case rounded(radius: CGFloat)
    case navigation(radius: CGFloat)
    case composer
}

/// Put this behind the surface's tint and content, outside SwiftUI clipping,
/// masking and offscreen compositing groups. The effect view masks itself; a
/// SwiftUI mask around its ancestors can remove its access to the live backdrop.
struct NativeBackdropBlur: UIViewRepresentable {
    var recipe: NativeBackdropBlurRecipe
    var mask: NativeBackdropBlurMask
    @Environment(\.colorScheme) private var scheme
    @Environment(\.accessibilityReduceTransparency) private var reduceTransparency

    func makeUIView(context: Context) -> NativeBackdropEffectView {
        let view = NativeBackdropEffectView()
        updateUIView(view, context: context)
        return view
    }

    func updateUIView(_ view: NativeBackdropEffectView, context: Context) {
        view.configure(recipe: recipe, mask: mask, dark: scheme == .dark,
                       reduceTransparency: reduceTransparency)
    }

    static func dismantleUIView(_ view: NativeBackdropEffectView, coordinator: ()) {
        view.dismantle()
    }
}

@MainActor
final class NativeBackdropEffectView: UIVisualEffectView {
    private var recipe = NativeBackdropBlurRecipe.panel
    private var maskKind = NativeBackdropBlurMask.rounded(radius: 0)
    private var requestedReduceTransparency = false
    private var animator: UIViewPropertyAnimator?
    private var appliedStyle: UIUserInterfaceStyle?
    private var appliedIntensity: CGFloat?
    private var appliedReduceTransparency: Bool?
    private let backdropMask = NativeBackdropEffectMaskView()

    init() {
        super.init(effect: nil)
        isUserInteractionEnabled = false
        isAccessibilityElement = false
        accessibilityElementsHidden = true
        mask = backdropMask
        NotificationCenter.default.addObserver(
            self, selector: #selector(transparencyDidChange),
            name: UIAccessibility.reduceTransparencyStatusDidChangeNotification, object: nil
        )
        registerForTraitChanges([UITraitUserInterfaceStyle.self]) {
            (view: NativeBackdropEffectView, _: UITraitCollection) in
            view.applyEffectIfNeeded()
        }
    }

    required init?(coder: NSCoder) { fatalError("init(coder:) has not been implemented") }

    func configure(recipe: NativeBackdropBlurRecipe, mask: NativeBackdropBlurMask,
                   dark: Bool, reduceTransparency: Bool) {
        self.recipe = recipe
        requestedReduceTransparency = reduceTransparency
        overrideUserInterfaceStyle = dark ? .dark : .light
        if maskKind != mask {
            maskKind = mask
            setNeedsLayout()
        }
        applyEffectIfNeeded()
    }

    override func layoutSubviews() {
        super.layoutSubviews()
        // This is the UIVisualEffectView's own UIKit mask, not an ancestor's mask.
        // Disable implicit layer animations when scrolling/resizing a SwiftUI host.
        CATransaction.begin()
        CATransaction.setDisableActions(true)
        backdropMask.frame = bounds
        backdropMask.configure(maskKind)
        CATransaction.commit()
    }

    override func didMoveToWindow() {
        super.didMoveToWindow()
        if window == nil {
            resetEffect()
        } else {
            // Rebuild after reattachment: a stopped animation must never be reused.
            applyEffectIfNeeded()
        }
    }

    @objc private func transparencyDidChange() {
        applyEffectIfNeeded()
    }

    private func applyEffectIfNeeded() {
        guard window != nil else { return }
        let dark = traitCollection.userInterfaceStyle == .dark
        let style: UIUserInterfaceStyle = dark ? .dark : .light
        let intensity = min(1, max(0, dark ? recipe.darkIntensity : recipe.lightIntensity))
        let reduce = requestedReduceTransparency || UIAccessibility.isReduceTransparencyEnabled
        guard appliedStyle != style || appliedIntensity != intensity || appliedReduceTransparency != reduce else { return }

        resetEffect()
        appliedStyle = style
        appliedIntensity = intensity
        appliedReduceTransparency = reduce
        if reduce {
            backgroundColor = dark
                ? UIColor(red: 32 / 255, green: 32 / 255, blue: 38 / 255, alpha: 1)
                : UIColor(red: 248 / 255, green: 248 / 255, blue: 252 / 255, alpha: 1)
            return
        }
        backgroundColor = .clear
        // Fixed neutral styles avoid adaptive material changing the experiment's
        // recipe. They still have a system tint: the SwiftUI wash is reduced too.
        let blur = UIBlurEffect(style: dark ? .dark : .light)
        let animator = UIViewPropertyAnimator(duration: 1, curve: .linear) { [weak self] in
            self?.effect = blur
        }
        animator.pausesOnCompletion = true
        self.animator = animator
        animator.startAnimation()
        animator.pauseAnimation()
        animator.fractionComplete = intensity
    }

    private func resetEffect() {
        animator?.stopAnimation(true)
        animator = nil
        effect = nil
        backgroundColor = .clear
        appliedStyle = nil
        appliedIntensity = nil
        appliedReduceTransparency = nil
    }

    func dismantle() {
        NotificationCenter.default.removeObserver(self)
        resetEffect()
        mask = nil
    }
}

@MainActor
private final class NativeBackdropEffectMaskView: UIView {
    override class var layerClass: AnyClass { CAGradientLayer.self }

    func configure(_ kind: NativeBackdropBlurMask) {
        guard let gradient = layer as? CAGradientLayer else { return }
        gradient.startPoint = CGPoint(x: 0.5, y: 0)
        gradient.endPoint = CGPoint(x: 0.5, y: 1)
        let black = UIColor.black.cgColor
        let clear = UIColor.clear.cgColor
        let radius: CGFloat
        switch kind {
        case .rounded(let value):
            radius = value
            gradient.colors = [black, black]
            gradient.locations = [0, 1]
        case .navigation(let value):
            radius = value
            gradient.colors = [black, black, clear]
            gradient.locations = [0, 0.55, 1]
        case .composer:
            radius = 0
            gradient.colors = [clear, black, black]
            gradient.locations = [0, 0.45, 1]
        }
        gradient.cornerRadius = max(0, min(radius, min(bounds.width, bounds.height) / 2))
        gradient.cornerCurve = .continuous
        gradient.masksToBounds = true
    }
}
#endif
