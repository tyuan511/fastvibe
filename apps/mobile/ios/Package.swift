// swift-tools-version: 6.0
import PackageDescription

let package = Package(
    name: "FastVibeMobile",
    platforms: [.iOS(.v18)],
    products: [
        .library(name: "FastVibeCore", targets: ["FastVibeCore"]),
        .library(name: "FastVibeUI", targets: ["FastVibeUI"]),
    ],
    targets: [
        .target(name: "FastVibeMobileCoreFFI", publicHeadersPath: "include"),
        .target(name: "FastVibeCore", dependencies: ["FastVibeMobileCoreFFI"]),
        .target(name: "FastVibeUI", dependencies: ["FastVibeCore"]),
        .testTarget(name: "FastVibeTests", dependencies: ["FastVibeCore"]),
    ]
)
