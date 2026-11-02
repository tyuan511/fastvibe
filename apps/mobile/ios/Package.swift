// swift-tools-version: 6.0
import PackageDescription

let package = Package(
    name: "FastVibeMobile",
    // `.macOS` is here for `swift test`, not for shipping a Mac app: the tests build
    // FastVibeCore on the host, and without a macOS floor the toolchain falls back to
    // 10.13 — where `ObservableObject` / `@Published` do not exist and the package fails
    // to compile on a runner whose default deployment target is older than the SDK.
    platforms: [.iOS(.v18), .macOS(.v14)],
    products: [
        .library(name: "FastVibeCore", targets: ["FastVibeCore"]),
        .library(name: "FastVibeUI", targets: ["FastVibeUI"]),
    ],
    targets: [
        .target(name: "FastVibeMobileCoreFFI", publicHeadersPath: "include"),
        .target(name: "FastVibeCore", dependencies: ["FastVibeMobileCoreFFI"]),
        .target(
            name: "FastVibeUI",
            dependencies: ["FastVibeCore"],
            resources: [.process("Resources")]
        ),
        .testTarget(
            name: "FastVibeTests",
            dependencies: ["FastVibeCore", "FastVibeUI"],
            resources: [.process("Fixtures")]
        ),
    ]
)
