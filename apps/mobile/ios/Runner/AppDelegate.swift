import Flutter
import UIKit
import Security

/// Only reads the former native host's Keychain namespace; never updates or deletes it.
enum NativeStateMigration {
  enum ReadFailure: Error {
    case keychain(OSStatus)
    case invalidValue
  }

  static func read(valueForKey: (String) throws -> String? = readKeychain) throws -> [String: Any] {
    var state: [String: Any] = ["present": false]
    for (output, key) in [("token", "account.token"), ("origin", "account.origin"), ("identity", "iroh.identity")] {
      if let value = try valueForKey(key) {
        state["present"] = true
        state[output] = value
      }
    }
    return state
  }

  static func readKeychain(_ key: String) throws -> String? {
    let query: [String: Any] = [
      kSecClass as String: kSecClassGenericPassword,
      kSecAttrService as String: "dev.fastvibe.mobile",
      kSecAttrAccount as String: key,
      kSecReturnData as String: true,
      kSecMatchLimit as String: kSecMatchLimitOne,
    ]
    var item: CFTypeRef?
    let status = SecItemCopyMatching(query as CFDictionary, &item)
    if status == errSecItemNotFound { return nil }
    guard status == errSecSuccess else { throw ReadFailure.keychain(status) }
    guard let data = item as? Data, let value = String(data: data, encoding: .utf8) else {
      throw ReadFailure.invalidValue
    }
    return value
  }
}

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
    let migration = FlutterMethodChannel(
      name: "dev.fastvibe.mobile/migration",
      binaryMessenger: engineBridge.applicationRegistrar.messenger()
    )
    migration.setMethodCallHandler { call, result in
      guard call.method == "readNativeState" else { result(FlutterMethodNotImplemented); return }
      do {
        result(try NativeStateMigration.read())
      } catch {
        result(FlutterError(
          code: "native-state-unavailable",
          message: "Unable to read saved native credentials. Original data was retained.",
          details: nil
        ))
      }
    }
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
