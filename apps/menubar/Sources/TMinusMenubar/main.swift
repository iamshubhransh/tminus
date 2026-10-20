import Foundation
import TMinusCore

// Headless modes run before any AppKit/SwiftUI is touched.
let arguments = CommandLine.arguments

if arguments.contains("--help") || arguments.contains("-h") {
    print("""
    TMinusMenubar — live ETA for AI coding agents, in the macOS menu bar.

    usage:
      TMinusMenubar                      launch the menubar app
      TMinusMenubar --selftest [file]    print what the app would show for a state file, then exit
                    [--now <epoch-ms>]   evaluate at a fixed instant instead of the current time
      TMinusMenubar --snapshot <file> <dir>
                                         render the label + popover for a state file to PNGs (light, dark)

    Set TMINUS_MENUBAR_DEBUG=1 to trace state-file activity to stderr.

    The app reads $TMINUS_HOME/state/current.json (default ~/.tminus/state/current.json).
    """)
    exit(0)
}

if let i = arguments.firstIndex(of: "--selftest") {
    let next = i + 1 < arguments.count ? arguments[i + 1] : nil
    let path = next.flatMap { $0.hasPrefix("--") ? nil : $0 } ?? StateFile.current().path
    let url = URL(fileURLWithPath: (path as NSString).expandingTildeInPath)

    var now = StateFile.nowMs()
    if let j = arguments.firstIndex(of: "--now") {
        guard j + 1 < arguments.count, let fixed = Double(arguments[j + 1]) else {
            FileHandle.standardError.write(Data("--now needs an epoch-milliseconds value\n".utf8))
            exit(2)
        }
        now = fixed
    }

    let result = StateFile.load(url)
    print(SelfTest.report(path: url.path, result: result, now: now))
    if case .invalid = result { exit(1) }
    exit(0)
}

if let i = arguments.firstIndex(of: "--snapshot") {
    guard i + 2 < arguments.count else {
        FileHandle.standardError.write(Data("usage: TMinusMenubar --snapshot <state.json> <out-dir>\n".utf8))
        exit(2)
    }
    let file = URL(fileURLWithPath: (arguments[i + 1] as NSString).expandingTildeInPath)
    let dir = URL(fileURLWithPath: (arguments[i + 2] as NSString).expandingTildeInPath, isDirectory: true)
    do {
        for url in try Snapshot.run(stateFile: file, outDir: dir) { print(url.path) }
        exit(0)
    } catch {
        FileHandle.standardError.write(Data("snapshot failed: \(error)\n".utf8))
        exit(1)
    }
}

TMinusApp.main()
