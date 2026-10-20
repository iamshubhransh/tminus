import AppKit
import SwiftUI
import TMinusCore

/// The status item's content. A `MenuBarExtra` label only honours plain
/// `Text`/`Image` (fonts and custom shapes are dropped), so the label is drawn
/// once per change into a template image: monospaced numerals and the todo
/// ring survive, and the system still tints it for light, dark and highlight.
struct MenuBarLabel: View {
    @ObservedObject var label: LabelModel

    var body: some View {
        Image(nsImage: label.image)
            .renderingMode(.template)
            .accessibilityLabel(Text(label.accessibilityText))
            .help(label.tooltip)
    }
}

@MainActor
final class LabelModel: ObservableObject {
    @Published private(set) var image: NSImage
    @Published private(set) var tooltip: String = ""
    @Published private(set) var accessibilityText: String = LiveDisplay.idleTitle

    private var key: LabelContent.Key?
    /// The status bar button may not exist yet at launch; keep trying until it does.
    private var tooltipApplied = false

    init() {
        image = LabelModel.render(LabelContent(display: LiveDisplay.compute(nil, now: 0)))
    }

    func update(with display: LiveDisplay) {
        let content = LabelContent(display: display)
        if content.key != key {
            key = content.key
            image = LabelModel.render(content)
            accessibilityText = display.title
        }
        if display.tooltip != tooltip {
            tooltip = display.tooltip
            tooltipApplied = false
        }
        if !tooltipApplied {
            tooltipApplied = StatusItemTooltip.apply(tooltip)
        }
    }

    private static func render(_ content: LabelContent) -> NSImage {
        let scale = NSScreen.screens.map(\.backingScaleFactor).max() ?? 2
        let renderer = ImageRenderer(content: content.foregroundStyle(.black))
        renderer.scale = scale
        guard let cg = renderer.cgImage else {
            let empty = NSImage(size: NSSize(width: 18, height: 18))
            empty.isTemplate = true
            return empty
        }
        let image = NSImage(cgImage: cg, size: NSSize(width: CGFloat(cg.width) / scale, height: CGFloat(cg.height) / scale))
        image.isTemplate = true
        return image
    }
}

/// What gets drawn into the status item.
struct LabelContent: View {
    struct Key: Equatable {
        var phase: Phase
        var text: String
        var ring: Double?
        var stale: Bool
    }

    let display: LiveDisplay

    var key: Key {
        Key(phase: display.phase, text: display.title, ring: ringFraction, stale: display.isStale)
    }

    /// Todo progress, shown while the turn is active.
    private var ringFraction: Double? {
        guard display.phase == .running || display.phase == .overrun, let todo = display.todo else { return nil }
        return (todo.fraction * 48).rounded() / 48  // quantised: no redraw for invisible changes
    }

    private let numerals = Font.system(size: 13, weight: .medium, design: .monospaced)
    private let words = Font.system(size: 13, weight: .regular)

    var body: some View {
        HStack(spacing: 4) {
            switch display.phase {
            case .idle:
                Text(LiveDisplay.idleTitle)
                    .font(.system(size: 13, weight: .semibold, design: .monospaced))
            case .running:
                lead(symbol: "hourglass")
                Text(display.countdownText ?? "")
                    .font(numerals)
            case .waiting:
                Image(systemName: "pause.circle")
                    .font(.system(size: 14, weight: .regular))
            case .overrun:
                if let ringFraction { MiniRing(fraction: ringFraction) }
                (Text("running long ").font(words)
                    + Text(display.elapsedMs.map(TimeFormat.short) ?? "").font(numerals))
            case .done:
                Image(systemName: "checkmark")
                    .font(.system(size: 12, weight: .semibold))
                Text(display.last.map { TimeFormat.precise($0.actualMs) } ?? "")
                    .font(numerals)
            }
        }
        .lineLimit(1)
        .fixedSize()
        .frame(height: 18)
        .padding(.horizontal, 1)
        // A frozen (stale) countdown is drawn quieter.
        .opacity(display.isStale ? 0.5 : 1)
    }

    @ViewBuilder
    private func lead(symbol: String) -> some View {
        if let ringFraction {
            MiniRing(fraction: ringFraction)
        } else {
            Image(systemName: symbol)
                .font(.system(size: 12, weight: .regular))
        }
    }
}

/// 13pt todo ring for the menu bar. The track is drawn at low alpha, which a
/// template image keeps, so it reads as a faint circle in both appearances.
struct MiniRing: View {
    let fraction: Double

    var body: some View {
        ZStack {
            Circle()
                .stroke(lineWidth: 2)
                .opacity(0.28)
            Circle()
                .trim(from: 0, to: max(0.02, fraction))
                .stroke(style: StrokeStyle(lineWidth: 2, lineCap: .round))
                .rotationEffect(.degrees(-90))
        }
        .frame(width: 12, height: 12)
        .padding(1)
    }
}

/// `MenuBarExtra` doesn't expose its `NSStatusItem`, and `.help` on the label
/// isn't guaranteed to reach it, so set the tooltip on the status bar button
/// directly. Only this app's windows are searched, so the button is ours.
@MainActor
enum StatusItemTooltip {
    @discardableResult
    static func apply(_ text: String) -> Bool {
        var found = false
        for window in NSApp?.windows ?? [] {
            guard let root = window.contentView, let button = find(in: root) else { continue }
            button.toolTip = text
            found = true
        }
        return found
    }

    private static func find(in view: NSView) -> NSStatusBarButton? {
        if let button = view as? NSStatusBarButton { return button }
        for sub in view.subviews {
            if let hit = find(in: sub) { return hit }
        }
        return nil
    }
}
