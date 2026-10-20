// swift-tools-version: 6.0
import PackageDescription

let package = Package(
    name: "TMinusMenubar",
    platforms: [.macOS(.v13)],
    products: [
        .executable(name: "TMinusMenubar", targets: ["TMinusMenubar"]),
        .library(name: "TMinusCore", targets: ["TMinusCore"]),
    ],
    targets: [
        // Pure model + formatting + display logic. No AppKit/SwiftUI, so it is testable headlessly.
        .target(name: "TMinusCore"),
        // The SwiftUI MenuBarExtra app (and the `--selftest` entry point).
        .executableTarget(
            name: "TMinusMenubar",
            dependencies: ["TMinusCore"]
        ),
        .testTarget(
            name: "TMinusCoreTests",
            dependencies: ["TMinusCore"]
        ),
    ],
    swiftLanguageModes: [.v6]
)
