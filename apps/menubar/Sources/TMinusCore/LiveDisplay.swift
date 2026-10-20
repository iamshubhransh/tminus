import Foundation

/// What the menubar shows right now: one pure function of (state, clock).
public enum Phase: String, Equatable, Sendable {
    case idle, running, waiting, overrun, done
}

public enum Rules {
    /// A state older than this means the collector is gone; stop extrapolating.
    public static let staleAfterMs: Double = 30_000
    /// How long `✓ 4m12s` lingers after a completed turn.
    public static let doneLingerMs: Double = 10_000
    /// The countdown never claims less than this.
    public static let minRemainingMs: Double = 1_000
}

/// Everything the views need, already resolved for one instant. Numeric fields
/// are quantised to whole seconds so two snapshots taken within the same
/// displayed second compare equal (the app republishes only on change).
public struct LiveDisplay: Equatable, Sendable {
    public var phase: Phase
    /// The state is older than `Rules.staleAfterMs` and is being shown frozen.
    public var isStale: Bool = false
    /// now − updatedAt, whole seconds (nil when there is no state file).
    public var ageMs: Double?

    public var agent: String?
    public var project: String?
    public var intent: String?

    /// Active elapsed time (excludes waiting on the user).
    public var elapsedMs: Double?
    public var p10RemainingMs: Double?
    public var p50RemainingMs: Double?
    public var p90RemainingMs: Double?
    /// Prediction made at submit time.
    public var p50TotalMs: Double?
    public var p90TotalMs: Double?
    public var todo: LiveState.Todo?
    public var toolCalls: Int?
    public var waitingReason: String?
    /// How long the agent has been waiting on the user.
    public var waitingForMs: Double?
    /// The completed turn being celebrated (`.done`), or the most recent one otherwise.
    public var last: LiveState.Finished?

    /// Plain-text menubar title, e.g. `⏳ 2:14`, `⏸`, `running long 9m`, `✓ 4m12s`, `T–`.
    public var title: String
    /// Hover text, e.g. `1–5m remaining (P10–P90)`.
    public var tooltip: String

    public static let idleTitle = "T–"

    /// `1–5m` for the current P10–P90 remaining range.
    public var rangeText: String? {
        guard let lo = p10RemainingMs, let hi = p90RemainingMs else { return nil }
        return TimeFormat.range(lo, hi)
    }

    /// The countdown shown in the menubar (`2:14`), when there is one.
    public var countdownText: String? {
        p50RemainingMs.map(TimeFormat.clock)
    }

    public static func compute(_ state: LiveState?, now: Double) -> LiveDisplay {
        guard let state else {
            return LiveDisplay(phase: .idle, title: idleTitle, tooltip: "tminus · no state file yet")
        }
        let age = now - state.updatedAt
        var d = LiveDisplay(phase: .idle, title: idleTitle, tooltip: "tminus · nothing running")
        d.ageMs = wholeSeconds(max(0, age), .down)
        d.agent = state.agent
        d.project = state.project
        d.last = state.last

        if (state.status == .running || state.status == .waiting), let t = state.turn {
            let stale = age > Rules.staleAfterMs
            // Between file writes, keep counting locally — but only while the
            // collector is plausibly alive, and never while waiting on the user
            // (waiting time doesn't count as active elapsed time).
            let drift = (state.status == .running && age > 0 && !stale) ? age : 0
            let elapsed = wholeSeconds(t.elapsedMs + drift, .down)
            let remaining = { (v: Double) in wholeSeconds(max(Rules.minRemainingMs, v - drift), .up) }

            d.isStale = stale
            d.intent = t.intent
            d.elapsedMs = elapsed
            d.p10RemainingMs = remaining(t.p10RemainingMs)
            d.p50RemainingMs = remaining(t.p50RemainingMs)
            d.p90RemainingMs = remaining(t.p90RemainingMs)
            d.p50TotalMs = t.p50TotalMs > 0 ? t.p50TotalMs : nil
            d.p90TotalMs = t.p90TotalMs > 0 ? t.p90TotalMs : nil
            d.todo = (t.todo?.total ?? 0) > 0 ? t.todo : nil
            d.toolCalls = t.toolCalls

            let staleNote = stale ? " · no update for \(TimeFormat.short(age))" : ""
            let range = d.rangeText ?? "?"

            if state.status == .waiting {
                d.phase = .waiting
                d.waitingReason = t.waitingReason.flatMap { $0.isEmpty ? nil : $0 }
                d.waitingForMs = t.waitingSince.map { wholeSeconds(max(0, now - $0), .down) }
                d.title = "⏸"
                d.tooltip = "Waiting on you" + (d.waitingReason.map { " · \($0)" } ?? "") + staleNote
            } else if t.overrun || (t.p90TotalMs > 0 && t.elapsedMs + drift > t.p90TotalMs) {
                d.phase = .overrun
                d.title = "running long \(TimeFormat.short(elapsed))"
                let p90 = d.p90TotalMs.map { "past the P90 estimate of \(TimeFormat.short($0))" } ?? "past the estimate"
                d.tooltip = "Running long · \(p90)" + staleNote
            } else {
                d.phase = .running
                d.title = "⏳ \(TimeFormat.clock(d.p50RemainingMs ?? 0))"
                d.tooltip = "\(range) remaining (P10–P90)" + staleNote
            }
            return d
        }

        if let last = state.last, last.isCompleted {
            let since = now - last.finishedAt
            if since >= -2_000 && since <= Rules.doneLingerMs {
                d.phase = .done
                d.intent = last.intent
                d.title = "✓ \(TimeFormat.precise(last.actualMs))"
                d.tooltip = "Done in \(TimeFormat.precise(last.actualMs))"
                    + (last.p50Ms.map { " · predicted \(TimeFormat.short($0))" } ?? "")
                return d
            }
        }
        return d
    }

    private static func wholeSeconds(_ ms: Double, _ rule: FloatingPointRoundingRule) -> Double {
        ((ms / 1000).rounded(rule)) * 1000
    }
}
