import Flutter
import UIKit

@main
@objc class AppDelegate: FlutterAppDelegate, FlutterImplicitEngineDelegate {
  override func application(
    _ application: UIApplication,
    didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]?
  ) -> Bool {
    return super.application(application, didFinishLaunchingWithOptions: launchOptions)
  }

  func didInitializeImplicitFlutterEngine(_ engineBridge: FlutterImplicitEngineBridge) {
    GeneratedPluginRegistrant.register(with: engineBridge.pluginRegistry)
    let clipboard = FlutterMethodChannel(
      name: "dev.fastvibe.mobile/device",
      binaryMessenger: engineBridge.applicationRegistrar.messenger()
    )
    clipboard.setMethodCallHandler { call, result in
      if call.method == "openSettings" {
        guard let url = URL(string: UIApplication.openSettingsURLString) else { result(false); return }
        UIApplication.shared.open(url, options: [:]) { opened in result(opened) }
        return
      }
      guard call.method == "readImage" else { result(FlutterMethodNotImplemented); return }
      guard let image = UIPasteboard.general.image else { result(nil); return }
      // Bound pixel allocation before encoding a clipboard screenshot or camera image.
      let longest = max(image.size.width, image.size.height)
      let factor = min(1, 2048 / max(1, longest))
      let size = CGSize(width: image.size.width * factor, height: image.size.height * factor)
      let format = UIGraphicsImageRendererFormat()
      format.scale = 1
      let bounded = UIGraphicsImageRenderer(size: size, format: format).image { _ in
        image.draw(in: CGRect(origin: .zero, size: size))
      }
      guard let bytes = bounded.jpegData(compressionQuality: 0.85) else {
        result(FlutterError(code: "image-encoding-failed", message: nil, details: nil)); return
      }
      result(FlutterStandardTypedData(bytes: bytes))
    }
  }
}
