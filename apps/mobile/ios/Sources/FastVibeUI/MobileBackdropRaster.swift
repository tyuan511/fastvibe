import CoreGraphics
import Foundation

/// The approved CSS background, composited in sRGB with premultiplied-alpha stops.
/// A small cached raster avoids platform gradient interpolation and system tint changes.
@MainActor
enum MobileBackdropRaster {
    private struct Key: Hashable {
        let width: Int
        let height: Int
        let dark: Bool
    }
    private static var cache: [Key: CGImage] = [:]

    static func image(size: CGSize, dark: Bool) -> CGImage? {
        let width = max(1, Int(ceil(size.width)))
        let height = max(1, Int(ceil(size.height)))
        let key = Key(width: width, height: height, dark: dark)
        if let image = cache[key] { return image }
        let base: [Double] = dark ? [5, 5, 8] : [238, 240, 247]
        let layers: [(rgb: [Double], alpha: Double, x: Double, y: Double, rx: Double, ry: Double)] = [
            (dark ? [56, 86, 255] : [96, 140, 255], dark ? 0.36 : 0.42, 0, 0, 0.95, 0.48),
            (dark ? [196, 60, 170] : [255, 150, 196], dark ? 0.26 : 0.34, 1, 0.38, 0.80, 0.42),
            (dark ? [20, 160, 150] : [110, 222, 206], dark ? 0.22 : 0.36, 0.15, 1, 0.95, 0.48),
        ]
        var pixels = [UInt8](repeating: 255, count: width * height * 4)
        for y in 0..<height {
            let py = (Double(y) + 0.5) / Double(height)
            for x in 0..<width {
                let px = (Double(x) + 0.5) / Double(width)
                var red = base[0]
                var green = base[1]
                var blue = base[2]
                // CSS background images are listed front to back.
                for layer in layers.reversed() {
                    let dx = (px - layer.x) / layer.rx
                    let dy = (py - layer.y) / layer.ry
                    let alpha = layer.alpha * max(0, 1 - sqrt(dx * dx + dy * dy) / 0.72)
                    red = layer.rgb[0] * alpha + red * (1 - alpha)
                    green = layer.rgb[1] * alpha + green * (1 - alpha)
                    blue = layer.rgb[2] * alpha + blue * (1 - alpha)
                }
                let offset = (y * width + x) * 4
                pixels[offset] = UInt8(red.rounded())
                pixels[offset + 1] = UInt8(green.rounded())
                pixels[offset + 2] = UInt8(blue.rounded())
            }
        }
        guard let provider = CGDataProvider(data: Data(pixels) as CFData),
              let space = CGColorSpace(name: CGColorSpace.sRGB),
              let image = CGImage(width: width, height: height, bitsPerComponent: 8, bitsPerPixel: 32,
                                  bytesPerRow: width * 4, space: space,
                                  bitmapInfo: CGBitmapInfo(rawValue: CGImageAlphaInfo.last.rawValue).union(.byteOrder32Big),
                                  provider: provider, decode: nil, shouldInterpolate: true, intent: .defaultIntent)
        else { return nil }
        if cache.count >= 4 { cache.removeAll(keepingCapacity: true) }
        cache[key] = image
        return image
    }
}
