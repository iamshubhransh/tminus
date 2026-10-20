import AppKit
import SwiftUI
import TMinusCore

/// `--snapshot <state.json> <out-dir>`: render the menubar label and the popover
/// for a state file to PNGs (light and dark), without showing any UI. A design
/// review aid: the real window uses the system menu material behind the same view.
@MainActor
enum Snapshot {
    static func run(stateFile: URL, outDir: URL) throws -> [URL] {
        _ = NSApplication.shared
        let store = StateStore(fileURL: stateFile, live: false)
        try FileManager.default.createDirectory(at: outDir, withIntermediateDirectories: true)
        let base = stateFile.deletingPathExtension().lastPathComponent
        var written: [URL] = []

        for dark in [false, true] {
            let scheme: ColorScheme = dark ? .dark : .light
            let ink: Color = dark ? .white : .black
            let paper = dark ? Color(white: 0.17) : Color(white: 0.97)
            let bar = dark ? Color(white: 0.12) : Color(white: 0.90)

            let view = VStack(alignment: .trailing, spacing: 6) {
                // The status item as it sits in the menu bar.
                Image(nsImage: store.label.image)
                    .renderingMode(.template)
                    .foregroundStyle(ink)
                    .padding(.horizontal, 10)
                    .frame(height: 24)
                    .background(RoundedRectangle(cornerRadius: 5).fill(ink.opacity(0.1)))
                    .padding(.horizontal, 8)
                    .frame(width: 320, height: 30, alignment: .trailing)
                    .background(bar)
                PopoverView(store: store)
                    .background(RoundedRectangle(cornerRadius: 10).fill(paper))
            }
            .padding(12)
            .background(bar)
            .environment(\.colorScheme, scheme)

            let renderer = ImageRenderer(content: view)
            renderer.scale = 2
            let appearance = NSAppearance(named: dark ? .darkAqua : .aqua) ?? NSAppearance.currentDrawing()
            var image: CGImage?
            appearance.performAsCurrentDrawingAppearance { image = renderer.cgImage }
            guard let image, let png = NSBitmapImageRep(cgImage: image).representation(using: .png, properties: [:]) else {
                throw CocoaError(.fileWriteUnknown)
            }
            let url = outDir.appendingPathComponent("\(base)-\(dark ? "dark" : "light").png")
            try png.write(to: url)
            written.append(url)
        }
        return written
    }
}
