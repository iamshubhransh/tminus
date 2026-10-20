import AppKit
import SwiftUI
import TMinusCore

/// The window that opens from the menu bar: the current turn, then how the
/// last ten predictions held up.
struct PopoverView: View {
    @ObservedObject var store: StateStore

    var body: some View {
        let d = store.display
        VStack(alignment: .leading, spacing: 0) {
            Header(display: d)
                .padding(.bottom, 16)

            CurrentTurn(display: d, fileExists: store.fileExists, path: store.displayPath)

            Divider().padding(.vertical, 18)

            HistorySection(rows: store.history)

            Divider().padding(.top, 18).padding(.bottom, 10)

            Footer(display: d, fileExists: store.fileExists, problem: store.problem)
        }
        .padding(.horizontal, 20)
        .padding(.top, 16)
        .padding(.bottom, 12)
        .frame(width: 320)
    }
}

// MARK: - Palette & type

enum Style {
    static func tint(_ phase: Phase) -> Color {
        switch phase {
        case .running: return .blue
        case .waiting: return .yellow
        case .overrun: return .orange
        case .done: return .green
        case .idle: return Color.secondary
        }
    }

    static func mono(_ size: CGFloat, _ weight: Font.Weight = .regular) -> Font {
        .system(size: size, weight: weight, design: .monospaced)
    }

    static let label = Font.system(size: 10, weight: .medium)

    /// `build_feature` → `build feature`.
    static func intent(_ raw: String?) -> String {
        (raw ?? "—").replacingOccurrences(of: "_", with: " ")
    }

    static func agent(_ raw: String?) -> String {
        switch raw {
        case "claude-code": return "Claude Code"
        case "codex": return "Codex"
        case let other?: return other
        case nil: return ""
        }
    }
}

// MARK: - Header

private struct Header: View {
    let display: LiveDisplay

    private var phaseText: String {
        switch display.phase {
        case .running: return display.isStale ? "no updates" : "running"
        case .waiting: return "waiting on you"
        case .overrun: return "running long"
        case .done: return "done"
        case .idle: return "idle"
        }
    }

    var body: some View {
        HStack(spacing: 6) {
            Text("tminus")
                .font(Style.mono(11, .semibold))
                .foregroundStyle(.secondary)
            if display.phase != .idle, !Style.agent(display.agent).isEmpty {
                Text(Style.agent(display.agent))
                    .font(.system(size: 11))
                    .foregroundStyle(.tertiary)
            }
            Spacer(minLength: 8)
            Circle()
                .fill(display.isStale ? Color.secondary : Style.tint(display.phase))
                .frame(width: 6, height: 6)
                .opacity(display.phase == .idle || display.isStale ? 0.5 : 1)
            Text(phaseText)
                .font(.system(size: 11))
                .foregroundStyle(.secondary)
        }
    }
}

// MARK: - Current turn

private struct CurrentTurn: View {
    let display: LiveDisplay
    let fileExists: Bool
    let path: String

    var body: some View {
        switch display.phase {
        case .running: running
        case .waiting: waiting
        case .overrun: overrun
        case .done: done
        case .idle: idle
        }
    }

    // Project · intent
    private var context: some View {
        HStack(spacing: 6) {
            Text(display.project ?? "untitled")
                .font(.system(size: 13, weight: .semibold))
                .lineLimit(1)
                .truncationMode(.middle)
            Text("·").foregroundStyle(.tertiary)
            Text(Style.intent(display.intent))
                .font(.system(size: 13))
                .foregroundStyle(.secondary)
                .lineLimit(1)
            Spacer(minLength: 0)
        }
        .padding(.bottom, 14)
    }

    private func bigNumber(_ text: String, caption: Text) -> some View {
        VStack(alignment: .leading, spacing: 3) {
            Text(text)
                .font(Style.mono(40, .light))
                .lineLimit(1)
                .minimumScaleFactor(0.6)
            caption
                .font(.system(size: 12))
                .foregroundStyle(.secondary)
        }
    }

    @ViewBuilder
    private var ring: some View {
        if let todo = display.todo {
            TodoRing(todo: todo, tint: Style.tint(display.phase))
        }
    }

    @ViewBuilder
    private var staleNote: some View {
        if display.isStale, let age = display.ageMs {
            Text("No update for \(TimeFormat.short(age)) — the collector may have stopped.")
                .font(.system(size: 11))
                .foregroundStyle(.orange)
                .padding(.top, 12)
                .fixedSize(horizontal: false, vertical: true)
        }
    }

    private var running: some View {
        VStack(alignment: .leading, spacing: 0) {
            context
            HStack(alignment: .center) {
                bigNumber(
                    display.countdownText ?? "–:––",
                    caption: Text("remaining · likely ") + Text(display.rangeText ?? "?").font(Style.mono(12))
                )
                Spacer(minLength: 12)
                ring
            }
            .padding(.bottom, 18)
            StatRow(items: [
                .init(label: "Elapsed", value: display.elapsedMs.map(TimeFormat.precise) ?? "—"),
                .init(label: "Predicted", value: display.p50TotalMs.map(TimeFormat.short) ?? "—"),
                .init(label: "Tool calls", value: display.toolCalls.map(String.init) ?? "—"),
            ])
            staleNote
        }
        .help("\(display.rangeText ?? "?") remaining (P10–P90)")
    }

    private var waiting: some View {
        VStack(alignment: .leading, spacing: 0) {
            context
            HStack(alignment: .top, spacing: 12) {
                Image(systemName: "pause.circle")
                    .font(.system(size: 30, weight: .light))
                    .foregroundStyle(Style.tint(.waiting))
                VStack(alignment: .leading, spacing: 3) {
                    Text("Waiting on you")
                        .font(.system(size: 17, weight: .medium))
                    Text(display.waitingReason ?? "The agent needs your input to continue.")
                        .font(.system(size: 12))
                        .foregroundStyle(.secondary)
                        .fixedSize(horizontal: false, vertical: true)
                }
                Spacer(minLength: 0)
            }
            .padding(.bottom, 18)
            StatRow(items: [
                .init(label: "Waiting", value: display.waitingForMs.map(TimeFormat.precise) ?? "—"),
                .init(label: "Active", value: display.elapsedMs.map(TimeFormat.precise) ?? "—"),
                .init(label: "Remaining", value: display.countdownText.map { "~\($0)" } ?? "—"),
            ])
            staleNote
        }
    }

    private var overrun: some View {
        VStack(alignment: .leading, spacing: 0) {
            context
            HStack(alignment: .center) {
                bigNumber(
                    display.elapsedMs.map(TimeFormat.clock) ?? "–:––",
                    caption: Text("elapsed · running long").foregroundColor(.orange)
                )
                Spacer(minLength: 12)
                ring
            }
            .padding(.bottom, 18)
            StatRow(items: [
                .init(label: "Predicted", value: display.p50TotalMs.map(TimeFormat.short) ?? "—"),
                .init(label: "P90", value: display.p90TotalMs.map(TimeFormat.short) ?? "—"),
                .init(label: "Tool calls", value: display.toolCalls.map(String.init) ?? "—"),
            ])
            staleNote
        }
    }

    private var done: some View {
        VStack(alignment: .leading, spacing: 0) {
            context
            HStack(alignment: .center, spacing: 12) {
                bigNumber(
                    display.last.map { TimeFormat.precise($0.actualMs) } ?? "—",
                    caption: Text(display.last?.p50Ms.map { "done · predicted \(TimeFormat.short($0))" } ?? "done")
                )
                Spacer(minLength: 12)
                Image(systemName: "checkmark.circle")
                    .font(.system(size: 34, weight: .light))
                    .foregroundStyle(Style.tint(.done))
            }
        }
    }

    private var idle: some View {
        VStack(alignment: .leading, spacing: 5) {
            Text("Nothing running")
                .font(.system(size: 17, weight: .medium))
            Text(fileExists
                 ? "The countdown appears here when an agent starts a turn."
                 : "Waiting for the collector to write")
                .font(.system(size: 12))
                .foregroundStyle(.secondary)
                .fixedSize(horizontal: false, vertical: true)
            if !fileExists {
                Text(path)
                    .font(Style.mono(11))
                    .foregroundStyle(.secondary)
                    .lineLimit(1)
                    .truncationMode(.middle)
                    .textSelection(.enabled)
                    .help(path)
            }
            if let last = display.last {
                (Text("Last turn · \(Style.intent(last.intent)) · ")
                    + Text(TimeFormat.precise(last.actualMs)).font(Style.mono(11)))
                    .font(.system(size: 11))
                    .foregroundStyle(.tertiary)
                    .padding(.top, 6)
            }
        }
    }
}

/// Three small label/value pairs under the big number.
private struct StatRow: View {
    struct Item: Identifiable {
        var id: String { label }
        let label: String
        let value: String
    }

    let items: [Item]

    var body: some View {
        HStack(alignment: .top, spacing: 0) {
            ForEach(items) { item in
                VStack(alignment: .leading, spacing: 3) {
                    Text(item.label)
                        .font(Style.label)
                        .foregroundStyle(.tertiary)
                    Text(item.value)
                        .font(Style.mono(13))
                        .lineLimit(1)
                }
                .frame(maxWidth: .infinity, alignment: .leading)
                .accessibilityElement(children: .combine)
            }
        }
    }
}

/// Todo progress ring for the popover.
struct TodoRing: View {
    let todo: LiveState.Todo
    var tint: Color = .accentColor
    var size: CGFloat = 48

    var body: some View {
        ZStack {
            Circle()
                .stroke(Color.primary.opacity(0.08), lineWidth: 3.5)
            Circle()
                .trim(from: 0, to: max(0.015, todo.fraction))
                .stroke(tint, style: StrokeStyle(lineWidth: 3.5, lineCap: .round))
                .rotationEffect(.degrees(-90))
                .animation(.easeOut(duration: 0.4), value: todo.fraction)
            Text("\(todo.done)/\(todo.total)")
                .font(Style.mono(11, .medium))
                .minimumScaleFactor(0.7)
                .lineLimit(1)
                .padding(.horizontal, 6)
        }
        .frame(width: size, height: size)
        .help("\(todo.done) of \(todo.total) todos done")
        .accessibilityElement(children: .ignore)
        .accessibilityLabel("\(todo.done) of \(todo.total) todos done")
    }
}

// MARK: - History

private struct HistorySection: View {
    let rows: [HistoryRow]

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            HStack(alignment: .firstTextBaseline) {
                Text("Last 10 turns")
                    .font(.system(size: 13, weight: .semibold))
                Spacer()
                if let summary = HistoryRow.calibrationSummary(rows) {
                    Text(summary.replacingOccurrences(of: " within P10–P90", with: " in range"))
                        .font(.system(size: 11))
                        .foregroundStyle(.secondary)
                        .help(summary)
                }
            }
            .padding(.bottom, 10)

            if rows.isEmpty {
                Text("Finished turns land here, each with how close its prediction was.")
                    .font(.system(size: 12))
                    .foregroundStyle(.secondary)
                    .fixedSize(horizontal: false, vertical: true)
            } else {
                HistoryColumns {
                    Text("")
                    Text("Predicted")
                    Text("Actual")
                    Text("P10–P90").lineLimit(1).frame(maxWidth: .infinity, alignment: .center)
                }
                .font(Style.label)
                .foregroundStyle(.tertiary)
                .padding(.bottom, 6)

                VStack(alignment: .leading, spacing: 7) {
                    ForEach(rows) { HistoryLine(row: $0) }
                }
            }
        }
    }
}

/// Fixed column layout shared by the header and every row.
private struct HistoryColumns<A: View, B: View, C: View, D: View>: View {
    let content: (A, B, C, D)

    init(@ViewBuilder _ build: () -> TupleView<(A, B, C, D)>) {
        content = build().value
    }

    var body: some View {
        HStack(spacing: 10) {
            content.0.frame(width: 84, alignment: .leading)
            content.1.frame(width: 50, alignment: .trailing)
            content.2.frame(width: 48, alignment: .trailing)
            content.3.frame(maxWidth: .infinity)
        }
    }
}

private struct HistoryLine: View {
    let row: HistoryRow

    private var tooltip: String {
        var parts = [Style.intent(row.intent)]
        if let p50 = row.p50Ms {
            var predicted = "predicted \(TimeFormat.short(p50))"
            if let p10 = row.p10Ms, let p90 = row.p90Ms { predicted += " (\(TimeFormat.range(p10, p90)) P10–P90)" }
            parts.append(predicted)
        }
        parts.append("actual \(TimeFormat.precise(row.actualMs))")
        switch row.verdict {
        case .within: parts.append("within range")
        case .over: parts.append("slower than P90")
        case .under: parts.append("faster than P10")
        case .unknown: break
        }
        if !row.isCompleted { parts.append(row.outcome) }
        return parts.joined(separator: " · ")
    }

    var body: some View {
        HistoryColumns {
            Text(Style.intent(row.intent))
                .font(.system(size: 12))
                .lineLimit(1)
                .truncationMode(.tail)
            Text(row.p50Ms.map(TimeFormat.short) ?? "–")
                .font(Style.mono(12))
                .foregroundStyle(.secondary)
            Text(TimeFormat.precise(row.actualMs))
                .font(Style.mono(12))
            RangeTrack(row: row)
        }
        .opacity(row.isCompleted ? 1 : 0.45)
        .help(tooltip)
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(tooltip)
    }
}

/// Where the actual fell against the prediction. Log scale; the P10–P90 band
/// is always the middle half with P50 at the centre, so rows compare at a glance.
private struct RangeTrack: View {
    let row: HistoryRow

    private var dotColor: Color {
        switch row.verdict {
        case .within: return Color.primary.opacity(0.8)
        case .over: return .orange
        case .under: return .teal
        case .unknown: return Color.secondary
        }
    }

    var body: some View {
        GeometryReader { geo in
            let w = geo.size.width, h = geo.size.height, y = h / 2
            ZStack {
                Capsule()
                    .fill(Color.primary.opacity(0.07))
                    .frame(width: w, height: 2)
                    .position(x: w / 2, y: y)
                if row.p10Ms != nil {
                    Capsule()
                        .fill(Color.primary.opacity(0.12))
                        .frame(width: w * (HistoryRow.bandHi - HistoryRow.bandLo), height: 6)
                        .position(x: w / 2, y: y)
                }
                if row.p50Ms != nil {
                    Rectangle()
                        .fill(Color.primary.opacity(0.3))
                        .frame(width: 1, height: h)
                        .position(x: w / 2, y: y)
                }
                if let p = row.position {
                    let x = min(max(p * w, 3.5), w - 3.5)
                    Group {
                        if row.clamped {
                            // Off the scale: a hollow dot pinned to the edge.
                            Circle().strokeBorder(dotColor, lineWidth: 1.5)
                        } else {
                            Circle().fill(dotColor)
                        }
                    }
                    .frame(width: 7, height: 7)
                    .position(x: x, y: y)
                }
            }
        }
        .frame(height: 10)
    }
}

// MARK: - Footer

private struct Footer: View {
    let display: LiveDisplay
    let fileExists: Bool
    let problem: String?

    private var status: String {
        if problem != nil { return "State file unreadable — showing the last good one" }
        guard fileExists, let age = display.ageMs else { return "No state file yet" }
        if age < 2_000 { return "Updated just now" }
        if age < 60_000 { return "Updated \(Int(age / 1000))s ago" }
        return "Updated \(TimeFormat.short(age)) ago"
    }

    var body: some View {
        HStack {
            Text(status)
                .font(.system(size: 11))
                .foregroundStyle(.tertiary)
                .help(problem ?? "")
            Spacer()
            Button {
                NSApp.terminate(nil)
            } label: {
                HStack(spacing: 4) {
                    Text("Quit")
                    Text("⌘Q").foregroundStyle(.tertiary)
                }
                .font(.system(size: 11))
            }
            .buttonStyle(.plain)
            .foregroundStyle(.secondary)
            .keyboardShortcut("q", modifiers: .command)
        }
    }
}
