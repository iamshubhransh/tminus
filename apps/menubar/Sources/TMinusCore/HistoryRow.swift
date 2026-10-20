import Foundation

/// One line of "Last 10 turns: predicted vs actual".
///
/// History entries carry P50 and P90 but no P10, and the predictor's
/// distributions are log-normal-ish, so P10 is mirrored around P50 in log
/// space: `p10 = p50² / p90`. On the track that makes the P10–P90 band always
/// the middle half (0.25…0.75) with P50 at the centre; only the dot moves.
public struct HistoryRow: Equatable, Sendable, Identifiable {
    public enum Verdict: String, Equatable, Sendable {
        /// Faster than P10.
        case under
        /// Inside P10–P90.
        case within
        /// Slower than P90.
        case over
        /// No prediction to compare against.
        case unknown
    }

    public var id: Int
    public var intent: String
    public var outcome: String
    public var finishedAt: Double
    public var actualMs: Double
    public var p10Ms: Double?
    public var p50Ms: Double?
    public var p90Ms: Double?
    public var verdict: Verdict
    /// Where `actual` sits on a 0…1 log-scale track (nil without a P50).
    public var position: Double?
    /// The actual fell off the end of the track and the dot is pinned to the edge.
    public var clamped: Bool

    public var isCompleted: Bool { outcome == "completed" }

    /// Band edges on the track; P50 is at `0.5`.
    public static let bandLo = 0.25
    public static let bandHi = 0.75
    /// Assumed P50→P90 log spread when the turn has a P50 but no P90.
    static let fallbackLogSpread = log(2.5)

    public init(id: Int, _ f: LiveState.Finished) {
        self.id = id
        intent = f.intent
        outcome = f.outcome
        finishedAt = f.finishedAt
        actualMs = f.actualMs
        p50Ms = f.p50Ms
        p90Ms = f.p90Ms.flatMap { p90 in f.p50Ms.map { max(p90, $0) } ?? p90 }

        guard let p50 = f.p50Ms, p50 > 0 else {
            p10Ms = nil
            verdict = .unknown
            position = nil
            clamped = false
            return
        }
        let spread: Double
        if let p90 = p90Ms, p90 > p50 {
            spread = log(p90 / p50)
            let p10 = p50 * p50 / p90
            p10Ms = p10
            verdict = actualMs < p10 ? .under : actualMs > p90 ? .over : .within
        } else {
            spread = Self.fallbackLogSpread
            p10Ms = nil
            verdict = .unknown
        }
        let raw = 0.5 + (Self.bandHi - 0.5) * log(max(actualMs, 1) / p50) / spread
        position = min(1, max(0, raw))
        clamped = raw < 0 || raw > 1
    }

    public static func rows(from history: [LiveState.Finished], limit: Int = 10) -> [HistoryRow] {
        history.prefix(limit).enumerated().map { HistoryRow(id: $0.offset, $0.element) }
    }

    /// `7 of 10 within P10–P90` — counts rows that had a full prediction.
    public static func calibrationSummary(_ rows: [HistoryRow]) -> String? {
        let judged = rows.filter { $0.verdict != .unknown }
        guard !judged.isEmpty else { return nil }
        let hits = judged.filter { $0.verdict == .within }.count
        return "\(hits) of \(judged.count) within P10–P90"
    }

    /// Plain-text track for `--selftest`: `·····[────┼──●─]·····`.
    public func textBar(width: Int = 21) -> String {
        let w = max(9, width | 1)  // odd, so P50 has a centre cell
        let last = w - 1
        let lo = Int((Double(last) * Self.bandLo).rounded())
        let hi = Int((Double(last) * Self.bandHi).rounded())
        let mid = last / 2
        guard let position else { return String(repeating: "·", count: w) }
        let hasBand = p10Ms != nil
        var cells = (0..<w).map { i -> Character in
            if i == mid { return "┼" }
            guard hasBand else { return "·" }  // P50 only: no range to draw
            if i == lo { return "[" }
            if i == hi { return "]" }
            return (i > lo && i < hi) ? "─" : "·"
        }
        cells[Int((Double(last) * position).rounded())] = "●"
        return String(cells)
    }
}
